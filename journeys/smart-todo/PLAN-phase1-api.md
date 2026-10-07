# SmartTodo Phase 1: API and AI

Build the SmartTodo API, data model, repository layer, REST contracts, deterministic seed data, AI task decomposition, and the tests that prove them.

Read [`PLAN.md`](./PLAN.md) first for the journey vision, shared decisions, quality gates, and CI requirements. README prompts use the exact section names in this document as stable references. If a section is renamed, update its README references in the same change.

**Out of scope:** No user authentication (anonymous for now), no push notifications, no collaboration/sharing, no offline sync, no recurring todos, no image attachments.

---

## Stack

| Concern | Choice |
| --- | --- |
| Runtime | Node.js LTS + TypeScript |
| Functions | Azure Functions Node.js v4 programming model (`@azure/functions`) |
| Azure SQL | `mssql` + `@types/mssql` (dev) |
| AI | `openai`, with `@azure/identity` for keyless Microsoft Entra authentication |
| Tests | `vitest` |
| Seed script | `tsx` |
| Local storage emulator | `azurite` (dev dependency) |

Todo status values are **`pending` | `in_progress` | `completed`** only (never `not_started`). Region `westus`, model `gpt-5-mini` (fallback `gpt-4.1`).

**Other stacks:** Python v2, .NET isolated, and Java Azure Functions can implement the same contracts, but the tests, gates, and CI in this journey are specified for Node.js. If you switch, you also own translating the Test Strategy and Quality Gate sections.

## Project Structure

Paths are relative to `journeys/smart-todo`.

```text
src/api/
├── host.json
├── package.json
├── tsconfig.json                  # build: rootDir src, outDir dist
├── tsconfig.check.json            # type-check src and test, noEmit
├── vitest.config.ts
├── local.settings.example.json    # committed, no secrets
├── local.settings.json            # gitignored copy of the example
├── .funcignore
├── src/
│   ├── functions/                 # thin Azure Functions registrations only
│   ├── handlers/                  # request handling, receives dependencies
│   ├── data/                      # repository interfaces, memory + Azure SQL stores, factory, seed
│   ├── ai/                        # StepGenerator interface, Foundry + fake generators, parser
│   └── models/
└── test/
    ├── contract/                  # one file per endpoint
    ├── ai/                        # parser and retry tests with fixtures
    └── data/                      # shared repository contract suite
```

The API must follow the **repository pattern** (interfaces → implementations → factory) so handlers never import the database client directly. Handlers receive their dependencies (`DataStore` and `StepGenerator`) as arguments, so tests can pass in-memory and fake implementations. Files in `src/functions/` only register routes and call the handlers with dependencies from the factories.

---

## API

### Data Access Layer

Define these repository contracts as TypeScript interfaces:

```
TodoRepository:
  getAll(userId) → Todo[]
  getById(id) → Todo | null
  create(input) → Todo
  update(id, updates) → Todo
  delete(id) → void

ActionStepRepository:
  getByTodoId(todoId) → ActionStep[]
  getByTodoIds(todoIds) → ActionStep[]   // required; one query for a whole list
  create(step) → ActionStep
  update(id, updates) → ActionStep
  deleteByTodoId(todoId) → void

DataStore:
  todos: TodoRepository
  actionSteps: ActionStepRepository
  initialize() → void
```

Provide two implementations: an in-memory store and an Azure SQL store. The factory selects one from `DATA_PROVIDER`, calls `initialize()` once, and caches the result so HTTP handlers don't pay the initialization cost on every request. **Don't cache a failure:** if `initialize()` rejects, close any connection pool it opened and clear the cache, so the next request retries instead of failing forever.

- **Azure SQL `initialize()` applies migrations and seed data under a lock.** The schema lives in one place, `src/data/migrations.ts`: an ordered list of idempotent statements (`IF OBJECT_ID(...) IS NULL CREATE TABLE ...`, `IF COL_LENGTH(...) IS NULL ALTER TABLE ... ADD ...`). `initialize()` opens a transaction, takes an exclusive application lock with `sp_getapplock @Resource = 'smart-todo-migrations', @LockMode = 'Exclusive', @LockOwner = 'Transaction'`, runs every migration, inserts any missing seed rows by ID, and commits. Send each migration and each seed insert as its own request inside that transaction; never join them into one batch. SQL Server compiles a whole batch before it runs any of it, so a seed insert that uses a column an earlier statement in the same batch adds fails with `Invalid column name`. Several Functions instances can start at once; the lock makes them take turns, and idempotent statements make the later ones no-ops. Because the app applies its own schema, a deployment that adds a column also adds the column, with no separate migration step. A schema change is a new entry at the end of `migrations.ts`; never edit an earlier entry.
- **Validate settings at startup; connect on the first request.** Check `DATA_PROVIDER` and `AI_PROVIDER` when the Functions module loads, but don't connect to the database there. Resolve the store inside the error wrapper on each request (the factory caches it after a successful `initialize()`). A database failure then returns the `500 INTERNAL_ERROR` envelope and the next request retries. A failure while the module loads unregisters every function, so the whole API returns 404 with no error envelope.
- **Both stores enforce the same rules.** The in-memory store rejects an action step whose `todoId` doesn't exist, just as the SQL foreign key does, so tests on the memory store catch the same mistakes.
- **Create returns what it created.** `POST /api/todos` returns the todo that `create()` returned, with `steps: []`. Don't re-read the user's whole list to find it.

**List performance:** `GET /api/todos` loads the steps for every returned todo with one `getByTodoIds` call, not one `getByTodoId` call per todo (an N+1 query pattern). `getByTodoIds` is a required method on every store. Call it as a method on the repository, not as an extracted function, so class implementations keep `this`.

**Known limitation:** Handlers that write more than once (generating or regenerating steps, and step updates that change the todo's status) call the repository several times without a transaction, so a failure part-way can leave partial data. That's accepted for this demo and listed in [Production Hardening](./PLAN.md#production-hardening-out-of-scope). When a reviewer raises it, file or link a `known-limitation` issue rather than fixing it.

> **Note:** The `update()` method on `TodoRepository` must also support updating `stepsGenerated` (boolean). The `generateSteps` handler sets it to `true` after inserting AI-generated steps. Include `stepsGenerated` as an optional field in the update input type alongside `title` and `status`.

**ES modules:** If `package.json` sets `"type": "module"`, set `"module": "NodeNext"` and `"moduleResolution": "NodeNext"` in both tsconfig files, and write every relative import with its `.js` extension (`import { getDataStore } from '../data/factory.js'`). Node.js doesn't resolve extensionless imports at runtime, but Vitest does, so without `NodeNext` the tests pass and the Functions host then finds no functions and returns 404 for every route. With `NodeNext`, `tsc` rejects a missing extension at build time.

**Node.js entry point note:** Set `"main": "dist/functions/*.js"` in `package.json`. Since `tsconfig.json` uses `rootDir: "src"` and `outDir: "dist"`, source files under `src/functions/` compile to `dist/functions/`. Writing `"main": "dist/src/functions/*.js"` makes Azure Functions Core Tools find zero functions. Keep `test/` out of the build config and type-check it through `tsconfig.check.json` instead. Don't add `azure-functions-core-tools` to `package.json`. `func` is a host prerequisite, and as a dependency its install script breaks the remote build that `azd deploy` runs.

**Node.js deployment note:** For `azd` remote/Oryx build, do not exclude `src/` or `tsconfig.json` in `.funcignore`; Azure needs both to compile TypeScript. Exclude `node_modules/`, `test/`, `dist/**/*.map`, and `local.settings.json`.

**Local Functions storage:** `local.settings.json` uses `AzureWebJobsStorage=UseDevelopmentStorage=true`, so Azurite must be running before `func start`. Install it as a project-local dev dependency and start it with `npm run azurite`. Its data folder, `.azurite/`, is gitignored.

**Azure SQL notes:** On update, the SQL store makes `updatedAt` strictly later than the stored value, the same rule as the memory store (for example, `CASE WHEN SYSUTCDATETIME() > updatedAt THEN SYSUTCDATETIME() ELSE DATEADD(microsecond, 1, updatedAt) END`). Use `[order]` (bracket-quoted) since `order` is a SQL reserved word. Use parameterized queries only. For managed identity auth, use `azure-active-directory-default` authentication with no passwords, and pass `options.clientId` from `AZURE_SQL_CLIENT_ID` when it's set, so the Function App uses its SQL user-assigned identity in Azure (locally, leave it unset to use your own sign-in). SSL is required by default. In Azure, set `AZURE_SQL_SERVER` to the full FQDN from `fullyQualifiedDomainName` (for example, `sql-name.database.windows.net`) and do not strip the `.database.windows.net` suffix. Use `SYSUTCDATETIME()` (or a timestamp set by the app) for `createdAt` and `updatedAt`, not `GETUTCDATE()`, whose low `datetime` precision can make `updatedAt` unchanged after a quick update. `getByTodoIds` sends at most 1,000 IDs per query and splits larger lists into batches, because SQL Server allows about 2,100 parameters per request.

### Local Providers

Two settings select implementations. The factories fail at startup with a clear message when a value is missing or unknown.

| Setting | Values | Local and CI | Azure |
| --- | --- | --- | --- |
| `DATA_PROVIDER` | `memory`, `sql` | `memory` | `sql` |
| `AI_PROVIDER` | `fake`, `foundry` | `fake` | `foundry` |

- **`memory`** keeps data in process memory and loads the [Seed Data](#seed-data) on `initialize()`. Restarting the API resets the data. No database is needed.
- **`fake`** returns deterministic steps with no network call. See [AI Task Decomposition](#ai-task-decomposition).
- **`sql`** and **`foundry`** are the production implementations. Both are keyless: they authenticate with Microsoft Entra ID (managed identity in Azure). Learners can use them locally by filling in the Azure values in `local.settings.json` and signing in with `az login` as a user who has access, but no phase requires it.

Commit this file as `src/api/local.settings.example.json` and copy it to the gitignored `local.settings.json`:

```json
{
  "IsEncrypted": false,
  "Values": {
    "AzureWebJobsStorage": "UseDevelopmentStorage=true",
    "FUNCTIONS_WORKER_RUNTIME": "node",
    "DATA_PROVIDER": "memory",
    "AI_PROVIDER": "fake",
    "AZURE_SQL_SERVER": "",
    "AZURE_SQL_DATABASE": "SmartTodo",
    "AZURE_AI_ENDPOINT": "",
    "AZURE_AI_DEPLOYMENT": "gpt-5-mini"
  }
}
```

### Data Models

#### Todo

| Field | Type | Required | Constraints |
|-------|------|----------|-------------|
| id | string | auto | UUID v4, generated on create |
| title | string | yes | 1–500 characters, trimmed |
| status | string | auto | `pending` on create. Valid values: `pending`, `in_progress`, `completed` |
| userId | string | yes | 1–100 characters after trimming, to fit the `NVARCHAR(100)` column |
| stepsGenerated | boolean | auto | `false` on create, `true` after steps are generated |
| createdAt | string | auto | ISO 8601 timestamp |
| updatedAt | string | auto | ISO 8601 timestamp, strictly later than the previous value on every change (add 1 ms when the clock hasn't advanced) |

#### ActionStep

| Field | Type | Required | Constraints |
|-------|------|----------|-------------|
| id | string | auto | UUID v4, generated on create |
| todoId | string | yes | Must reference an existing Todo |
| title | string | yes | 1–200 characters |
| description | string | yes | 1–1000 characters, actionable detail |
| order | number | yes | 1-based sequential integer |
| isCompleted | boolean | auto | `false` on create |
| createdAt | string | auto | ISO 8601 timestamp |

### Database Schema (SQL)

The first entries in `src/data/migrations.ts` create this schema, each guarded so it can run again safely:

```sql
CREATE TABLE Todos (
    id NVARCHAR(36) PRIMARY KEY,
    title NVARCHAR(500) NOT NULL,
    status NVARCHAR(20) NOT NULL DEFAULT 'pending',
    userId NVARCHAR(100) NOT NULL,
    stepsGenerated BIT NOT NULL DEFAULT 0,
    createdAt DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
    updatedAt DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
);

CREATE INDEX IX_Todos_UserId ON Todos(userId);

CREATE TABLE ActionSteps (
    id NVARCHAR(36) PRIMARY KEY,
    todoId NVARCHAR(36) NOT NULL,
    title NVARCHAR(200) NOT NULL,
    description NVARCHAR(1000) NOT NULL,
    [order] INT NOT NULL,
    isCompleted BIT NOT NULL DEFAULT 0,
    createdAt DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
    CONSTRAINT FK_ActionSteps_Todos FOREIGN KEY (todoId) REFERENCES Todos(id) ON DELETE CASCADE
);

CREATE INDEX IX_ActionSteps_TodoId ON ActionSteps(todoId);
```

### API Endpoints

#### `GET /api/todos`

Query parameters:

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| userId | string | yes | Filter todos by user |

Response (200): `Todo[]`, each including nested `steps` sorted by `order`. 400 if `userId` is missing, whitespace-only, or longer than 100 characters.

#### `POST /api/todos`

Request body:

```json
{
  "title": "Prepare conference talk",
  "userId": "user-1"
}
```

Response (201): Created `Todo` with `status: "pending"`, `stepsGenerated: false`, and empty `steps`. 400 if `title` is missing, empty after trimming, or longer than 500 characters. 400 if `userId` is missing.

#### `PATCH /api/todos/:id`

Request body (all fields optional):

```json
{
  "title": "Prepare Conference keynote",
  "status": "in_progress"
}
```

Response (200): Updated todo object (same shape as GET response, including steps).

404 if todo not found. 400 if `status` is not one of `pending`, `in_progress`, `completed`. See [Decision Points](#decision-points) for an empty body and for manual status changes.

#### `DELETE /api/todos/:id`

Response (204): No content.

404 if todo not found. Cascade-deletes associated action steps.

#### `POST /api/todos/:id/generate-steps`

No request body. Calls the configured `StepGenerator` to generate action steps from the todo's title.

**Behavior:**
1. Fetch the todo by ID. Return 404 if not found.
2. If `stepsGenerated` is already `true`, delete existing steps first (regenerate). Delete before calling the generator, in this order, so a failed regeneration leaves no steps rather than stale ones mixed with the new `stepsGenerated` state.
3. Call the `StepGenerator` with the todo title.
4. Assign sequential `order` values starting at 1 and a UUID for each step's `id`.
5. Insert all steps into the database.
6. Set `stepsGenerated = true` on the todo.
7. Return the todo with all generated steps.

Response (200): Updated `Todo` with 3–7 generated `steps`. Each step has `id`, `title`, `description`, `order`, and `isCompleted`. 404 if todo not found. 503 with `AI_SERVICE_ERROR` if the generator fails after its retry. See [Decision Points](#decision-points) for step counts and regenerating completed work.

#### `PATCH /api/todos/:id/steps/:stepId`

Request body:

```json
{
  "isCompleted": true
}
```

Response (200): Updated `ActionStep`. 404 if the todo is not found, or if the step is not found or belongs to a different todo. 400 if `isCompleted` is not a boolean.

**Auto-completion rule:** After updating a step, check all steps for the parent todo. If ALL steps are `isCompleted: true`, set the todo's status to `completed`. If a step is unchecked (`isCompleted: false`) and the todo's status is `completed`, set it back to `in_progress`. See [Decision Points](#decision-points) for a pending todo whose first step is completed. When the completed step is the todo's last incomplete step, this rule wins, and the todo becomes `completed`.

### Decision Points

The `grill-plan` skill asks about each item before implementation. Use the default when the learner has no preference. Record the answers as a `Decisions` comment on the Phase 1 issue, and write tests for the chosen behavior.

| # | Question | Why it matters | Default |
| --- | --- | --- | --- |
| 1 | What happens when the model returns fewer than 3 or more than 7 valid steps? | It decides whether a bad answer becomes an error or a trimmed result. | Fewer than 3 is invalid output, so retry once and then return 503. More than 7 keeps the first 7. |
| 2 | When steps are regenerated on a `completed` todo, what happens to its status? | New steps are all incomplete, so `completed` would be false. | Set it to `in_progress`. Keep any other status unchanged. |
| 3 | When a step is completed on a `pending` todo and other steps remain incomplete, does the todo change? | Otherwise a todo can show progress while still marked pending. | Set it to `in_progress`. If no incomplete steps remain, the auto-completion rule applies and the todo becomes `completed`. |
| 4 | Can `PATCH /api/todos/:id` set `completed` while steps are incomplete? | It decides whether status is a manual field or derived only from steps. | Allow it. Auto-status reacts only to step changes. |
| 5 | What does `PATCH /api/todos/:id` return for a body with neither `title` nor `status`? | Silent success hides client bugs. | 400 `VALIDATION_ERROR`. |
| 6 | How long can one model call take? | A hung call holds a Functions instance and the iPhone spinner. | 30 seconds. Abort the request with an `AbortSignal` at the timeout, so the model call actually stops before the retry starts. A timeout counts as a failed attempt. |

### Error Response Format

All errors return:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Title is required and must be between 1 and 500 characters."
  }
}
```

Error codes: `VALIDATION_ERROR`, `NOT_FOUND`, `AI_SERVICE_ERROR`, `INTERNAL_ERROR`.

Status code mapping:
- `VALIDATION_ERROR` → 400
- `NOT_FOUND` → 404
- `AI_SERVICE_ERROR` → 503
- `INTERNAL_ERROR` → 500

Unexpected exceptions return 500 `INTERNAL_ERROR` without stack traces or connection details in the response, but always log the full error with `context.error` first. Without that log, Application Insights shows only a 500 with no cause. Every handler, including failures thrown while reading the request body or resolving dependencies, goes through the same error wrapper, so no response escapes the envelope.

`DATA_PROVIDER` and `AI_PROVIDER` are validated when the Functions module loads, not on the first request, so a misconfigured app fails at startup where the logs show it.

### Seed Data

Define these rows once, in `src/data/seed-data.ts`, and use that module in both stores. The in-memory store loads it on `initialize()`. For Azure SQL, `src/data/seed.ts` inserts each seed row whose `id` doesn't exist yet, with the exact IDs, statuses, and `isCompleted` values below. Don't generate new IDs, don't reset completion states, and don't skip seeding because a user already has todos. The script closes its SQL connection pool when it finishes, even after an error. Run it with `npm run seed` (`"seed": "tsx src/data/seed.ts"`). `seed.ts` must run the seeding when executed directly (for example, `if (import.meta.url === pathToFileURL(process.argv[1]).href) await seedDatabase()`), not only export a function; a test runs the script entry point and asserts it seeded. In Azure, the SQL store's `initialize()` inserts the same missing rows at startup, inside the migration lock, so the deployed app has seed data on its first request.

**Todos** (all userId: "user-1"):

| id | title | status | stepsGenerated |
|----|-------|--------|----------------|
| todo-1 | Prepare conference talk | pending | false |
| todo-2 | Set up home office | in_progress | true |
| todo-3 | Plan weekend hiking trip | completed | true |

Seed action steps for `todo-2` and `todo-3` so the app can show generated and completed states immediately:

| id | todoId | title | order | isCompleted |
|----|--------|-------|-------|-------------|
| step-2-1 | todo-2 | Choose a desk and chair | 1 | true |
| step-2-2 | todo-2 | Set up monitor and peripherals | 2 | true |
| step-2-3 | todo-2 | Organize cable management | 3 | false |
| step-2-4 | todo-2 | Set up lighting | 4 | false |
| step-3-1 | todo-3 | Pick a trail | 1 | true |
| step-3-2 | todo-3 | Check weather forecast | 2 | true |
| step-3-3 | todo-3 | Pack gear and supplies | 3 | true |

Use short actionable descriptions for each seed step.

### AI Task Decomposition

**Interface:**

```
StepGenerator:
  generate(title) → { title, description }[]   // throws AiServiceError on failure
```

**Fake generator (`AI_PROVIDER=fake`):** Returns exactly four steps with the titles `Clarify the goal`, `Gather what you need`, `Do the first focused session`, and `Review and wrap up`. Each description mentions the todo title. It makes no network call and returns the same output for the same title.

**Foundry generator (`AI_PROVIDER=foundry`):** Uses the plain `openai` SDK with a normalized `/openai/v1/` base URL.

**Client setup:** Normalize `AZURE_AI_ENDPOINT` so it ends with `/openai/v1/`, and pass `AZURE_AI_DEPLOYMENT` as the model/deployment name when calling chat completions. Authenticate without a key: pass `getBearerTokenProvider(new DefaultAzureCredential(), 'https://cognitiveservices.azure.com/.default')` from `@azure/identity` as the `openai` client's `apiKey`, which accepts an async token function. In Azure, `DefaultAzureCredential` uses the Function App's system-assigned managed identity; locally, it uses your Azure CLI sign-in. Let tests inject the credential, and a `fetch` function that you pass to the `openai` client's `fetch` option. Never call `fetch` or request tokens yourself. There is no `AZURE_AI_KEY` setting. If the endpoint is empty, throw `AiServiceError` so the endpoint returns 503.

Do **not** use a dated `api-version` and do **not** use an Azure-specific client that requires one. The dated GA version (`2024-10-21`) rejects newer parameters such as `reasoning_effort`, and the versionless `/openai/v1` API has been GA since August 2025. There is deliberately no `AZURE_AI_API_VERSION` variable. Do not add one to the app or to the Function App settings.

**System prompt:**

```
You are a productivity assistant that breaks down goals into actionable steps.

Given a todo item, generate 3-7 concrete, actionable steps to accomplish it.
Each step should be specific enough that someone could start working on it immediately.

Rules:
- Each step title must be under 200 characters
- Each step description must be 1-3 sentences with specific, actionable detail
- Include quantities, time estimates, or specific tools where relevant
- Steps must be in logical order (what to do first, second, etc.)
- Be practical and realistic, not generic or motivational

Respond with ONLY a valid JSON array. No markdown, no code fences, no explanation:
[
  {
    "title": "Short action title",
    "description": "Specific actionable description with details."
  }
]
```

**User prompt:** The todo's `title` field, verbatim.

**Model config:**
- Model: `gpt-5-mini` (fallback: `gpt-4.1`; check regional availability with `az cognitiveservices model list --location <region>`)
- Temperature: leave at the model default. gpt-5 family models reject custom temperature values. Set `0.7` only if using the gpt-4.1 fallback.
- Max completion tokens: `1500`, sent as `max_completion_tokens`. gpt-5 family deployments reject the older `max_tokens` parameter, and the fake generator can't reveal that, so a unit test must assert the request uses `max_completion_tokens`.
- Timeout: pass an `AbortSignal` that fires after 30 seconds to every request. `Promise.race()` alone stops waiting but leaves the paid request running.

**Response parsing** (a pure function, so tests can call it directly):
1. Get the raw text response from the model.
2. Strip markdown code fences if present (` ```json\n...\n``` ` → `[...]`).
3. Parse as a JSON array.
4. Validate: an array of objects, each with a string `title` of 1–200 characters and a string `description` of 1–1000 characters, both after trimming. A whitespace-only or over-length value makes the whole response invalid. Return the **trimmed** values, so what's stored always fits the SQL columns.
5. Apply the step-count rule from [Decision Points](#decision-points).
6. If validation fails, retry once with a stricter follow-up: "Your previous response was not valid JSON. Return ONLY a JSON array."
7. If the retry fails, throw `AiServiceError`.

**Environment Variables:**

| Variable | Local Dev | Production |
|----------|-----------|------------|
| AI_PROVIDER | `fake` | `foundry`, set by Bicep |
| AZURE_AI_ENDPOINT | Empty, or from the Azure portal to try the real model | Set by Bicep output |
| AZURE_AI_DEPLOYMENT | `gpt-5-mini` | Set by Bicep output |

---

## Test Strategy

Every test in `npm test` runs without a database, Azure credentials, or network access, so it gives the same result on a laptop, in CI, and in a cloud agent session.

**Composition:** Each test builds a fresh, seeded in-memory `DataStore` and passes it, with a fake or scripted `StepGenerator`, to the handler under test. A scripted generator returns queued results so tests can simulate a bad answer followed by a good one. Construct requests with the `HttpRequest` class exported by `@azure/functions` v4.

**Naming:** Name each test after the behavior it proves, for example `returns 400 VALIDATION_ERROR when title exceeds 500 characters`. Reading the test names should feel like reading this plan.

**Contract tests (`test/contract/`)** cover at least:

| Endpoint | Behaviors |
| --- | --- |
| `GET /api/todos` | 400 without `userId`. Returns the seed todos with nested steps sorted by `order`. Returns `[]` for a user with no todos. Loads steps with one `getByTodoIds` call. |
| `POST /api/todos` | 201 with the documented shape. Trims the title. Accepts 500 characters. Rejects missing, whitespace-only, and 501-character titles. Rejects a missing, whitespace-only, and 101-character `userId`. Returns the created todo without re-reading the list. |
| `PATCH /api/todos/:id` | Updates `title` and `status` and changes `updatedAt`. 400 for an invalid status. Decision Points 4 and 5. 404 for an unknown id. |
| `DELETE /api/todos/:id` | 204 with an empty body. Cascade-deletes steps. 404 for an unknown id. |
| `POST /api/todos/:id/generate-steps` | 200 with ordered steps and `stepsGenerated: true`. Regenerate replaces steps. Decision Point 2. 404 for an unknown id. 503 envelope when the generator fails. |
| `PATCH /api/todos/:id/steps/:stepId` | 200 with the updated step. 400 for a non-boolean. 404 for an unknown todo, an unknown step, and a step from another todo. Auto-completion. Reopen on uncheck. Decision Point 3 with a two-step todo, and completing the only step of a pending todo (becomes `completed`). |

Every error test also asserts the `{ error: { code, message } }` envelope.

**AI tests (`test/ai/`)** cover: a plain JSON array; a fenced ` ```json ` response; prose around the JSON (invalid); a missing `description` (invalid); a whitespace-only title and a 201-character title (invalid); the step-count rule for 2 and 9 items; one invalid answer followed by a valid one (success after exactly two calls); two invalid answers (`AiServiceError`); a timeout that aborts the request's `AbortSignal` before the retry starts; endpoint normalization with and without `/openai/v1/` and a trailing slash; and keyless authentication, through an injected credential and `fetch`: the generator requests a token for `https://cognitiveservices.azure.com/.default`, calls `<endpoint>/openai/v1/chat/completions` with `Authorization: Bearer <token>`, and sends no `api-key` header. Use recorded fixture strings, not a real model.

**Repository contract suite (`test/data/`):** Write one shared suite of repository behaviors, including `getByTodoIds` and ordering, as an exported function. Run it against the in-memory store in every test run. Call the same function against Azure SQL only when `AZURE_SQL_SERVER` is set, and skip it otherwise. Don't write a smaller, separate SQL test instead. SQL runs use a unique `userId`, delete their rows, and close the SQL store's connection pool in `afterAll`, even when a test fails.

**Store parity tests:** Both stores reject an action step for an unknown `todoId`, and an immediate update always produces a later `updatedAt`. SQL `initialize()` takes the `sp_getapplock` lock inside a transaction before any DDL, runs every migration in order as a separate request (assert the stubbed `mssql` request receives one statement per call), and is safe to run twice.

**Migration tests:** A source-level test reads `src/data/migrations.ts` and asserts every statement is guarded (`IF OBJECT_ID` for tables, `IF COL_LENGTH` for columns, and `IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = ... AND object_id = OBJECT_ID(...))` for indexes, because indexes aren't in `sys.objects` and `OBJECT_ID` never finds them) and that `initialize()` requests `sp_getapplock` before running them. With `AZURE_SQL_SERVER` set, run `initialize()` twice against the same database and assert the second run changes nothing.

**Boundary tests:** The fake AI and the memory store can't reveal mistakes at the edge of the real services, so assert those edges directly. Capture the request the Foundry generator sends through the OpenAI client and assert its exact fields: `model`, `messages`, `max_completion_tokens: 1500`, and no `max_tokens` or `temperature` for gpt-5 models. Record the parameters the SQL store binds, through a stub of the `mssql` connection pool and request, and assert each value's SQL type and JavaScript type match its column (for example, a `DATE` column receives a JavaScript `Date` or `null`, not a string). The SQL store must use the same code path in tests and production: stub `mssql` itself, and never add a separate driver interface or query branch that only tests exercise, because such a branch can pass every test and crash on the real pool.

**Seed tests:** Assert the exact seed IDs, statuses, and step completion states from both stores' seed paths, and assert that seeding twice doesn't duplicate rows. The same tests passing on both stores is the payoff of the repository pattern.

**Red phase:** Add only stubs that throw `Not implemented`, so the suite compiles and fails on assertions. Commit the tests and stubs, and tag the commit `phase1-red`. When review findings add tests later, the human deletes the tag, and the agent commits the tests as a new red commit and tags it `phase1-red` again.

---

## Quality Gate

`package.json` scripts:

| Script | Command |
| --- | --- |
| `build` | `tsc` |
| `check` | `tsc -p tsconfig.check.json`, then `vitest run`, then `tsc` and a load check: with `DATA_PROVIDER=memory` and `AI_PROVIDER=fake` set (the modules validate them when they load), import every compiled `dist/functions/*.js` file with Node.js and fail if any import throws |
| `test` | `vitest run` |
| `start` | `func start` |
| `azurite` | `azurite --silent --location .azurite` |
| `seed` | `tsx src/data/seed.ts` |

The Phase 1 gate passes when all three commands exit `0`:

1. `npm run check` in `src/api`.
2. `git diff --exit-code phase1-red -- src/api/test` from `journeys/smart-todo`.
3. The checked-in verifier against the local API running with `DATA_PROVIDER=memory` and `AI_PROVIDER=fake`: `node ../../.github/scripts/verify-smart-todo.mjs --base-url http://localhost:7071`.

The `api` CI job in [Continuous Integration](./PLAN.md#continuous-integration) runs commands 1 and 3 on every pull request.

---

## Phase 1 Acceptance Criteria

- Repository interfaces isolate all database access. Handlers receive a `DataStore` and a `StepGenerator` and never import `mssql` or `openai`.
- `DATA_PROVIDER` and `AI_PROVIDER` select the memory or SQL store and the fake or Foundry generator, and unknown values fail at startup.
- Seed data returns the three deterministic todos for `user-1`, including action steps for `todo-2` and `todo-3`.
- Todo create, update, delete, cascade delete, and error envelopes match the API contracts.
- `POST /api/todos/:id/generate-steps` returns 3–7 ordered steps, or 503 with `AI_SERVICE_ERROR` after a failed retry.
- Completing all action steps marks the parent todo `completed`, and unchecking a step moves a completed todo back to `in_progress`.
- The Decision Points answers are recorded on the issue and covered by tests.
- The [Quality Gate](#quality-gate) passes, and the `api` check is green on the pull request.
