# SmartTodo Phase 3: Azure Deployment

Review the cost and architecture, write a deterministic infrastructure gate, generate infrastructure that passes it, deploy the API to Azure Functions Flex Consumption, and turn what worked into a reusable skill and script. Read [`PLAN.md`](./PLAN.md) first and treat the application behavior in [`PLAN-phase1-api.md`](./PLAN-phase1-api.md) and [`PLAN-phase2-ios.md`](./PLAN-phase2-ios.md) as fixed contracts.

README prompts use the exact section names in this document as stable references. If a section is renamed, update its README references in the same change.

## Cost and Architecture Review

Before any Bicep exists, the agent reviews this plan read-only and returns:

1. **Monthly cost estimate:** A table with one row per resource in [Azure Resources](#azure-resources) and two columns: development use (one learner, a few hundred requests a month) and 10,000 monthly active users who each generate steps five times. State the SKU, the pricing assumptions, and the region, and link the Azure pricing page for each resource. Mark any number that is a guess.
2. **Improvements:** Up to five changes across security, reliability, cost, and operations. For each, give the benefit, the monthly cost impact, the effort, and a recommendation of `adopt now` or `later`.
3. **Risks:** Anything in this plan likely to fail in the learner's region or subscription.

The review returns its results in the chat only. It must not change files, post comments, or edit issues. The learner decides which improvements to adopt. An adopted improvement is added to this plan before the infrastructure is generated, because this plan is the contract that the generation, the gate, and the review all bind to. After the learner decides, a separate step posts the estimate and the decisions as one comment on the Phase 3 issue.

## Azure Deployment

Deploy the API to Azure Functions **Flex Consumption** plan — a serverless, scale-to-zero hosting plan with per-function scaling, virtual network support, and configurable instance memory sizes. See [Flex Consumption plan docs](https://learn.microsoft.com/en-us/azure/azure-functions/flex-consumption-plan) for details.

### Azure Resources

Prefer AVM modules for consistency. If an AVM module blocks deployment because of parameter drift, unsupported passthrough, or schema mismatch, switch that single resource to a raw `Microsoft.*` Bicep resource and document why.

Required resources: Function App on Flex Consumption, App Service Plan (`FC1`), Azure SQL Server + Database, Microsoft Foundry/Azure OpenAI with `gpt-5-mini`, Storage Account, Log Analytics, and Application Insights.

| Resource | Module / Approach |
|----------|-------------------|
| Function App | `br/public:avm/res/web/site` (`kind: functionapp,linux`) |
| App Service Plan | `br/public:avm/res/web/serverfarm` (Flex Consumption SKU: `FC1`) |
| Azure SQL Server | `br/public:avm/res/sql/server`; database as a child resource (Basic, `zoneRedundant: false`, `maxSizeBytes` 2 GB) |
| Microsoft Foundry | `br/public:avm/ptn/ai-ml/ai-foundry` (gpt-5-mini deployment) |
| Monitoring | `br/public:avm/ptn/azd/monitoring` |
| Storage Account | `br/public:avm/res/storage/storage-account` |

### azure.yaml

The `language` field should match the learner's chosen stack:

```yaml
name: smart-todo
metadata:
  template: smart-todo@0.0.1
services:
  api:
    project: ./src/api
    host: function
    language: ts   # Use: ts, python, csharp, java
infra:
  provider: bicep
  path: ./infra
hooks:
  postprovision:
    run: ./infra/hooks/postprovision.js
```

Single service only, with no `web` service. The iOS app runs on the device, not in Azure.

### Flex Consumption Configuration

- **`functionAppConfig` (required):** `runtime` with `name: node` and a supported Node.js LTS `version`; `scaleAndConcurrency.instanceMemoryMB: 2048` and `scaleAndConcurrency.maximumInstanceCount: 100` (Flex Consumption requires a maximum); and `deployment.storage` of type `blobContainer` pointing at the `deploymentpackage` container URL, with `authentication.type: SystemAssignedIdentity`.
- **Runtime storage through managed identity:** Set `AzureWebJobsStorage__accountName` to the storage account name instead of a connection string. The Function App identity's `Storage Blob Data Owner` role covers it.
- **Scaling:** Flex Consumption scales per function, except that all HTTP-triggered functions in one app scale together as the HTTP group. All SmartTodo endpoints are HTTP triggers, so they scale as one group.
- **Always ready instances:** Optional. Set 1 for the `http` group to eliminate cold starts during demos.

### Bicep Requirements

- Prefer AVM modules, but allow raw `Microsoft.*` resources when AVM blocks deployment
- **Two identities on the Function App.** Keep the system-assigned identity for storage (runtime and deployment package). Add a **user-assigned managed identity** (`Microsoft.ManagedIdentity/userAssignedIdentities`, named `id-sql-<resourceToken>`) that the Function App uses only for Azure SQL. Its client ID is known at deployment time, which lets the post-provision hook create the database user without looking anything up in Microsoft Entra ID, so the same hook works whether the SQL admin is a person or a service principal. Output its name and client ID as `SQL_IDENTITY_NAME` and `SQL_IDENTITY_CLIENT_ID`.
- **Keyless AI access.** The API calls Foundry with a Microsoft Entra token from the Function App's system-assigned identity, through the plain `openai` SDK. Set the Foundry account's `disableLocalAuth` to `true`, add no `AZURE_AI_KEY` setting, and never call `listKeys()`.
- Role assignment: `Storage Blob Data Owner` (`b7e6dc6d-f1e8-4753-8033-0f276bb0955b`) for Function App identity → Storage Account (required for Flex Consumption deployment)
- Role assignment: `Storage Blob Data Contributor` (`ba92f5b4-2d11-453d-a403-e96b0029c9fe`) for the deploying user → Storage Account (required for `azd deploy` to upload the zip package)
- Role assignment: `Cognitive Services OpenAI User` (`5e0bd9bd-7b93-4f28-af87-19fc36ad61bd`) for the Function App's system-assigned identity → Foundry account (required for keyless AI)
- Azure SQL: set the deploying user as Microsoft Entra admin, add a firewall rule named `AllowAzureServices` with `0.0.0.0` start/end addresses, then create a database user for the SQL user-assigned identity in post-provision. Map `AZURE_PRINCIPAL_TYPE` to the admin's `principalType` explicitly: `User` stays `User`, and `ServicePrincipal` becomes `Application` (Azure SQL doesn't accept `ServicePrincipal` there). Do not generate names containing Azure reserved words such as `WINDOWS`.
- Azure SQL Database: set `maxSizeBytes: 2147483648` (2 GB) when using Basic tier (default 32 GB exceeds the limit)
- **Azure SQL Database: set `zoneRedundant: false`** — Basic tier does not support zone redundancy. AVM module may default to true, causing "ProvisioningDisabled: Provisioning of zone redundant database/pool is not supported."
- Microsoft Foundry: use `br/public:avm/ptn/ai-ml/ai-foundry` with `baseName` (max 12 chars), `aiModelDeployments` array for gpt-5-mini with SKU `GlobalStandard` (gpt-5-mini isn't offered as `Standard`), `aiFoundryConfiguration.disableLocalAuth: true`, and system-assigned managed identity
- If AVM parameter drift requires raw `Microsoft.CognitiveServices` resources, create the account first and deploy the model from a separate nested Bicep module that receives the created account name. Do not issue the account and model child operations concurrently; Azure can reject the child with `RequestConflict` while the parent is non-terminal.
- **AI model version is region-specific.** Take it as a `modelVersion` parameter bound to `${AZURE_AI_MODEL_VERSION}` in `main.parameters.json`, never a hard-coded value, because the region is a parameter too. [Environment Preparation](#environment-preparation) looks it up. For example, `westus` offers `2025-08-07` (not `2025-02-27`).
- Outputs in SCREAMING_SNAKE_CASE: `API_URL`, `SQL_SERVER_NAME`, `SQL_DATABASE_NAME`, `FUNCTION_APP_NAME`, `AZURE_AI_ENDPOINT`, `AZURE_AI_DEPLOYMENT`, `RESOURCE_GROUP_NAME`. `API_URL` is the site origin, `https://<defaultHostName>`, with **no** `/api` suffix; the verifier and the iOS client add `/api/...` themselves.
- The `AZURE_SQL_SERVER` app setting comes from the server's `properties.fullyQualifiedDomainName`. Don't concatenate `environment().suffixes.sqlServerHostname`, which already starts with a dot and produces `name..database.windows.net`. The `SQL_SERVER_NAME` output may be the short name or the FQDN; the hook normalizes it to both.
- Module parameters derived from `uniqueString()` must declare explicit `@minLength(13)`/`@maxLength(13)` constraints, and the deploying principal ID parameter must declare `@minLength(36)`/`@maxLength(36)`, so the build emits no BCP334 warnings
- **Every generated name fits its resource type's length limit** at the longest environment name the scaffold accepts. For example, an App Service plan name is at most 40 characters, so truncate the environment part rather than the `resourceToken`.
- **Never change the name of a deployed resource in a fix.** Azure treats a new name as a new resource: the next `azd up` creates a second one and leaves the old one behind. Keep the existing formula for names that already fit, and check `azd provision --preview` for an unexpected `Create` before you redeploy.
- `azd-service-name: 'api'` tag on the Function App
- Function App settings: `DATA_PROVIDER=sql`, `AI_PROVIDER=foundry`, `AZURE_AI_ENDPOINT`, `AZURE_AI_DEPLOYMENT`, `AZURE_SQL_SERVER`, `AZURE_SQL_DATABASE`, and `AZURE_SQL_CLIENT_ID` (the SQL identity's client ID). `AZURE_SQL_SERVER` must be the SQL FQDN, not just the short server name.
- **Do NOT include `FUNCTIONS_WORKER_RUNTIME` in app settings** — Flex Consumption sets this via `functionAppConfig.runtime`, and having it in app settings causes a deployment error
- **Set `siteConfig.alwaysOn` to `false`** — the AVM module defaults to `true`, which is invalid for Flex Consumption
- **Set Storage Account `allowSharedKeyAccess` to `false`.** The Function App and `azd deploy` use managed identity and Microsoft Entra authorization, so account keys aren't needed and would bypass them.
- **Set Storage Account `networkAcls.defaultAction` to `Allow`** — the AVM module defaults to `Deny`, which blocks `azd deploy` zip uploads
- **Flex Consumption `deploymentpackage` container** — `azd deploy` uploads the zip to a blob container named `deploymentpackage`. Declare that container in Bicep (the [Infrastructure Gate](#infrastructure-gate) checks for it). If `azd deploy` still fails with "The specified container does not exist", create it with `az storage container create --name deploymentpackage --account-name <name> --auth-mode login` and retry.

### Environment Preparation

Before provisioning, prepare the selected `azd` environment without creating any Azure resources and without running `azd up`:

1. Register the `Microsoft.Web`, `Microsoft.Sql`, `Microsoft.CognitiveServices`, and `Microsoft.OperationalInsights` providers. Skip any that already report `Registered`.
2. Resolve the subscription ID and the signed-in principal. For an interactive account, use type `User`, its sign-in name as the login, and its **object ID** as `AZURE_PRINCIPAL_ID`. For a service principal, use type `ServicePrincipal`, its display name as the login, and its **application (client) ID** as `AZURE_PRINCIPAL_ID`, because Azure SQL identifies a service principal admin by its application ID.
3. Set `AZURE_SUBSCRIPTION_ID`, `AZURE_PRINCIPAL_LOGIN`, `AZURE_PRINCIPAL_ID`, and `AZURE_PRINCIPAL_TYPE` with `azd env set`, and set `AZURE_LOCATION` to `westus` unless the learner chose another region.
4. Look up the `gpt-5-mini` version offered in that region with `az cognitiveservices model list --location <region>` and set it as `AZURE_AI_MODEL_VERSION`.
5. Read each value and pass it as a literal argument. Don't use shell command substitution, so the steps work in PowerShell, Command Prompt, bash, and zsh.
6. If a value is unavailable, stop and report it rather than guessing or setting a placeholder.

To do it by hand, run these and pass each returned value to `azd env set`:

```text
az provider register --namespace Microsoft.Web
az provider register --namespace Microsoft.Sql
az provider register --namespace Microsoft.CognitiveServices
az provider register --namespace Microsoft.OperationalInsights
az account show --query id --output tsv
az account show --query user.name --output tsv
az ad signed-in-user show --query id --output tsv
az cognitiveservices model list --location westus --query "[?model.name=='gpt-5-mini'].model.version" --output tsv
azd env set AZURE_SUBSCRIPTION_ID <subscription-id>
azd env set AZURE_PRINCIPAL_LOGIN <account-login>
azd env set AZURE_PRINCIPAL_ID <principal-object-id>
azd env set AZURE_PRINCIPAL_TYPE User
azd env set AZURE_LOCATION westus
azd env set AZURE_AI_MODEL_VERSION <model-version>
```

For a service principal, set `AZURE_PRINCIPAL_TYPE` to `ServicePrincipal`, `AZURE_PRINCIPAL_ID` to its application (client) ID, and `AZURE_PRINCIPAL_LOGIN` to its display name.

### Post-Provision: Managed Identity SQL Access

Azure SQL requires a post-provision step to add the Function App's managed identity as a database user. Generate `infra/hooks/postprovision.js` and reference it directly as `hooks.postprovision` in `azure.yaml` without `shell: sh`. This repository requires Node.js LTS or later, `azd` 1.28.0+, Azure CLI, and the current Go-based `sqlcmd`; Windows, Mac, and Linux installation options are in [`../../docs/tool-installation.md`](../../docs/tool-installation.md).

Before provisioning, resolve and set the complete Entra administrator contract: `AZURE_PRINCIPAL_ID`, `AZURE_PRINCIPAL_LOGIN`, and `AZURE_PRINCIPAL_TYPE`. Interactive accounts use type `User`; non-interactive automation uses `ServicePrincipal`. Stop before Azure changes and report all missing values together.

The JavaScript hook must use argument arrays, not interpolated shell commands. On Mac and Linux, invoke executables directly. On Windows, use the static PowerShell JSON-payload launcher from the `container-apps-deployment` skill for Azure CLI shims rather than passing `.cmd` files directly to `execFileSync()` or `spawnSync()`. It must:

1. Fail before making Azure changes if `az`, `azd`, `node`, or `sqlcmd` is unavailable. Detect them with `az version`, `azd version`, `node --version`, and `sqlcmd --version` (`azd --version` fails). Run these checks through the same launcher as every other command, so a Windows `az.cmd` shim is found.
2. Read `SQL_SERVER_NAME`, `SQL_DATABASE_NAME`, `FUNCTION_APP_NAME`, and `RESOURCE_GROUP_NAME` through `azd env get-value`.
3. Normalize the SQL server to both its short name and `<name>.database.windows.net` FQDN in JavaScript.
4. Read the server's current Azure SQL connection policy with `az sql server conn-policy show --resource-group <rg> --server <short-name>` (these commands take `--server`, not `--name`). If it is `Redirect`, temporarily change it to `Proxy` so developer-host traffic stays on port 1433 instead of redirecting to ports 11000–11999.
5. Obtain the developer's public IP with Node.js HTTPS/fetch, create a uniquely named temporary SQL firewall rule, and register cleanup in a `finally` block.
6. Read `SQL_IDENTITY_NAME` and `SQL_IDENTITY_CLIENT_ID` through `azd env get-value`, then invoke `sqlcmd` with `--authentication-method ActiveDirectoryAzCli` to create the database user from the client ID and grant `db_datareader`, `db_datawriter`, and `db_ddladmin`. Use the SID form, which needs no directory lookup, and never `FROM EXTERNAL PROVIDER`:

   ```sql
   IF NOT EXISTS (SELECT 1 FROM sys.database_principals WHERE name = N'<identity-name>')
   BEGIN
       DECLARE @sid varchar(34) = CONVERT(varchar(34), CAST(CAST(N'<client-id>' AS uniqueidentifier) AS varbinary(16)), 1);
       EXEC (N'CREATE USER [<identity-name>] WITH SID = ' + @sid + N', TYPE = E;');
   END
   ALTER ROLE db_datareader ADD MEMBER [<identity-name>];
   ALTER ROLE db_datawriter ADD MEMBER [<identity-name>];
   ALTER ROLE db_ddladmin ADD MEMBER [<identity-name>];
   ```

   Validate that the client ID is a GUID and escape the identity name before building the statement. `db_ddladmin` lets the API apply its own migrations at startup. **Never fall back to SQL authentication or a password** if this step fails; stop and report the error.

   `ALTER ROLE ... ADD MEMBER` does nothing when the user is already a member, so these statements are safe to rerun as written.

7. In `finally`, delete the temporary firewall rule and restore the original SQL connection policy even if a step fails. Give each cleanup step its own `try`, so a failed rule deletion still restores the policy.
8. Print `Post-provision SQL setup complete.` only after every required step succeeds.

The hook doesn't create tables or seed data. The API does that at startup, under a lock (see the Data Access Layer section of [`PLAN-phase1-api.md`](./PLAN-phase1-api.md#data-access-layer)), so every deployment path, including the Phase 4 release pipeline, ships schema changes with the code.

**`--dry-run`:** With this flag, the hook prints `DRY RUN`, reports each of `node`, `az`, `azd`, and `sqlcmd` as `FOUND` or `MISSING` by running it through the same launcher as a real run, prints the steps it would take, and exits `0`. It returns before reading the `azd` environment or calling Azure. The infrastructure gate runs it with no tools on `PATH`; the `windows` CI job runs it with `az` and `azd` installed and fails if either is reported `MISSING`, which proves the Windows launcher path.

The hook must be idempotent and must never print secrets, connection strings, or firewall rule contents. Do not use shell traps, command substitution, `curl`, `grep`, or OS-specific path syntax in the generated hook.

Hook details that are easy to get wrong:

- Write it as **CommonJS** (`require()` and `__dirname`), not `import`/`export`. The workspace has no `package.json` that declares ES modules, so Node reparses ES module syntax with a warning.
- `az sql server firewall-rule delete` has **no `--yes` flag**. Passing it fails the cleanup and leaves the temporary firewall rule open.
- Pass `--output none` to Azure CLI commands that create or delete firewall rules or change the connection policy, so their JSON (which includes your public IP) never reaches the `azd` log.
- When a step fails, include the step name and the sanitized CLI error in the final message, not just "setup failed".
- Set the cleanup flag **before** the command that creates the temporary firewall rule returns, and don't call `.trim()` or other string methods on command output that may be `null`. With `--output none`, Node's `execFileSync` returns `null` for ignored stdout, and a `.trim()` on it throws right after the rule exists, skipping cleanup.
- Before creating its temporary rule, delete any leftover firewall rules whose names start with the hook's temporary prefix (for example, `SmartTodoSetup-`). A run that's killed before `finally` runs leaves its rule open.
- Tests must never execute the hook or any other command that changes Azure. Test the hook's pure functions, or read its source.
- `azd up` skips provisioning, and so skips this hook, when the infrastructure hasn't changed. After you fix the hook, run `node infra/hooks/postprovision.js` directly rather than expecting a rerun of `azd up` to execute it.

### Mobile Distribution

The iOS app is NOT deployed via azd. To test it against Azure, set `Config.apiBaseURL` to the deployed URL (`azd env get-value API_URL`) and run it from Xcode on the Simulator. For physical devices, use the deployed URL with a development signing profile.

### Known Deployment Gotchas

1. **SQL/AI region limits:** If SQL provisioning or `gpt-5-mini` deployment fails, try `westus3`, `centralus`, or `southcentralus`; verify model version with `az cognitiveservices model list`.
2. **Post-provision SQL access:** The deploying user must be Microsoft Entra admin, and local SQL setup needs a temporary firewall rule for the developer IP. The portable hook must clean it up in `finally`.
3. **Azure SQL Redirect policy:** Clients outside Azure may be redirected from port 1433 to ports 11000–11999. If those ports are blocked, temporarily switch the server to `Proxy` during post-provision and restore its original policy afterward.
4. **Azure SQL DNS failures:** If logs show `getaddrinfo ENOTFOUND <sql-name>`, `AZURE_SQL_SERVER` is only the short name. Use `<sql-name>.database.windows.net`.
5. **Oryx TypeScript build fails:** Check `.funcignore`; do not exclude `src/` or `tsconfig.json`.
6. **Storage deploy failures:** For 403 or missing container errors, ensure Storage `networkAcls.defaultAction` is `Allow`, the deploying user has `Storage Blob Data Contributor`, and the `deploymentpackage` container exists.
7. **AI returns 503 right after the first deployment:** A new role assignment can take up to 10 minutes to apply. Wait, then rerun the verifier. If it still fails, check that the Function App's system-assigned identity has `Cognitive Services OpenAI User` on the Foundry account.
8. **Simulator preflight busy:** If Xcode reports `Application failed preflight checks` or `SBMainWorkspace Busy`, terminate/uninstall the app from that simulator, reboot the simulator, then clean build and run again.

---

## Infrastructure Gate

Generate `scripts/check-infra.mjs` **before** the infrastructure exists. It turns the prose in [Azure Deployment](#azure-deployment) into checks with a deterministic exit code. Running it before `infra/` exists must fail. That is the red phase for infrastructure.

**Portability:** Resolve every path relative to the project directory (the parent of the script's `scripts/` folder), not the current working directory, so CI can run it from the repository root. Use only the Node.js standard library, so the scaffold script can copy the gate into another project. Invoke CLIs with argument arrays and `shell: false`. On Windows, use the PowerShell JSON-payload launcher pattern from `.github/scripts/_utils.mjs`, copied into the script rather than imported. That launcher rejects `"`, `&`, `|`, `<`, `>`, `^`, `%`, `!`, and parentheses in arguments to `.cmd` programs such as `az`, so don't pass JMESPath expressions with functions (`starts_with(...)`) or quoted jsonpath; request JSON and filter it in JavaScript instead. Use the launcher only for CLI shims such as `az` and `azd`; run Node.js itself with `process.execPath`, because the hook dry-run check below restricts `PATH` to the Node.js directory, where `powershell.exe` isn't found.

**Checks.** Print one `PASS` or `FAIL` line per check with a short reason, then exit `1` if any check failed:

1. **Files:** `azure.yaml`, `infra/main.bicep`, `infra/main.parameters.json`, and `infra/hooks/postprovision.js` exist.
2. **azure.yaml:** Exactly one service, named `api`, with `project: ./src/api`, `host: function`, and `language: ts`. `hooks.postprovision.run` is `./infra/hooks/postprovision.js`, and there is no `shell: sh`.
3. **Hook:** `node --check infra/hooks/postprovision.js` passes. The hook contains no `curl`, `grep`, or `shell: true`, no top-level `import` or `export` statements, and no `--yes` argument in a `firewall-rule` command. It contains `TYPE = E` and no `FROM EXTERNAL PROVIDER`, no SQL authentication (`administratorLoginPassword`, `-U`, or `--password`), no `CREATE TABLE`, no `INSERT INTO`, and no reference to a schema SQL file, and `infra/hooks/postprovision-schema.sql` doesn't exist, because the API owns the schema. Running `node infra/hooks/postprovision.js --dry-run` with `PATH` set to only the Node.js directory exits `0` and prints `DRY RUN`, which proves dry-run needs neither Azure tools nor the `azd` environment.
4. **Build:** `az bicep build --file infra/main.bicep --stdout` exits `0`, prints valid JSON, and reports no warnings. Ignore the Bicep CLI's "a new Bicep release is available" notice, which is not a template warning.
5. **Lint:** `az bicep lint --file infra/main.bicep` exits `0` and reports no warnings or errors.
6. **Contract rules** on the compiled JSON. Walk the whole tree, including nested module templates. Evaluate literal values and `{ "value": ... }` parameter assignments. Ignore parameter declarations (objects with a `type` key). For ARM expressions (strings that start with `[`), search for the required literal inside the expression: child resource names compile to `format()` expressions such as `[format('{0}/{1}', ..., 'AllowAzureServices')]`, and tags built with `union()` compile to expressions too.
   - **Only deployable resource properties count.** `metadata`, outputs, variables, and comments never satisfy a rule. An agent that can't pass a rule must change the real resource or report the gap. It must not add a literal elsewhere to satisfy the check.
   - The top-level outputs include `API_URL`, `SQL_SERVER_NAME`, `SQL_DATABASE_NAME`, `FUNCTION_APP_NAME`, `AZURE_AI_ENDPOINT`, `AZURE_AI_DEPLOYMENT`, and `RESOURCE_GROUP_NAME`, and no output expression ends with `/api'`.
   - App setting names include `DATA_PROVIDER`, `AI_PROVIDER`, `AZURE_AI_ENDPOINT`, `AZURE_AI_DEPLOYMENT`, `AZURE_SQL_SERVER`, `AZURE_SQL_DATABASE`, and `AZURE_SQL_CLIENT_ID`.
   - **Keyless AI:** No app setting is named `AZURE_AI_KEY`, no app setting value calls `listKeys()`, at least one `disableLocalAuth` is literally `true`, and every literal `disableLocalAuth` is `true`.
   - A `Microsoft.ManagedIdentity/userAssignedIdentities` resource exists, the Function App's identity type includes both `SystemAssigned` and `UserAssigned`, and the outputs include `SQL_IDENTITY_NAME` and `SQL_IDENTITY_CLIENT_ID`. No app setting is named `FUNCTIONS_WORKER_RUNTIME`.
   - Every literal `zoneRedundant` and `alwaysOn` is `false`, and every literal storage `defaultAction` is `Allow`.
   - The `FC1` SKU, a `deploymentpackage` blob container, the `azd-service-name: api` tag, and a `gpt-5-mini` or `gpt-4.1` model deployment appear.
   - A `functionAppConfig` object appears with `runtime`, `scaleAndConcurrency`, and `deployment.storage`. Where they are literals, `runtime.name` is `node`, `instanceMemoryMB` is `2048`, and the deployment storage authentication type is `SystemAssignedIdentity`. An app setting named `AzureWebJobsStorage__accountName` appears, and no app setting named `AzureWebJobsStorage` holds a connection string.
   - A SQL firewall rule named `AllowAzureServices` uses `0.0.0.0` for both addresses, and no firewall rule name contains `windows` in any letter case.
   - All three role definition IDs from [Bicep Requirements](#bicep-requirements) appear.
   - Every literal storage `allowSharedKeyAccess` is `false`.
   - **Storage account names are 3 to 24 lowercase letters and digits, with no hyphens.** Check every `Microsoft.Storage/storageAccounts` name: evaluate it when it's a literal, and when it's an expression, check each literal piece it concatenates (for example, the `'stsmart-'` in `format('stsmart-{0}', ...)` or `concat(...)`) for a hyphen or uppercase letter. A name such as `stsmart-<token>` fails only at `azd provision --preview` with `AccountNameInvalid`.
   - When raw `Microsoft.CognitiveServices/accounts/deployments` resources appear, they're in a nested deployment separate from the template that creates the account.
7. **Preview** (skipped with `--offline`): Confirm that `AZURE_SUBSCRIPTION_ID`, `AZURE_PRINCIPAL_ID`, `AZURE_PRINCIPAL_LOGIN`, and `AZURE_PRINCIPAL_TYPE` are set in the selected `azd` environment, then run `azd provision --preview --no-prompt` and require exit `0`. This asks Azure for a what-if result without creating resources.

The script never prints secrets or app setting values. When a CLI check fails, print the last 20 lines of its output (with secrets removed) under the `FAIL` line, so the reason is visible without rerunning it. The `infra` CI job runs it with `--offline` because CI has no Azure credentials.

**Gate:** `node scripts/check-infra.mjs --offline` must pass before a pull request merges, and `node scripts/check-infra.mjs` must pass before `azd up`.

## Reusable Infrastructure Skill

After a successful deployment, capture what worked as a skill at `.github/skills/flex-functions-sql-foundry/SKILL.md` in the workspace root (not under `journeys/smart-todo`), so the next project doesn't rediscover it:

- YAML frontmatter with `name` and a `description` that includes `USE FOR:` and `DO NOT USE FOR:` lists.
- When to use it: an Azure Functions Flex Consumption API with Azure SQL through managed identity and Microsoft Foundry.
- The inputs it needs: app name, runtime language, region, and model.
- The resource contract and the Known Deployment Gotchas, including any new gotchas from this run's pull request "Problems and fixes" notes and `known-limitation` issues.
- The gate: run `scripts/check-infra.mjs` and don't deploy until it passes.
- The fast path: run `scripts/scaffold-infra.mjs` first, and generate only what the scaffold doesn't cover.

Keep it under 200 lines. It must not contain subscription IDs, principal IDs, resource names from this run, or secrets.

## Deterministic Scaffold

Generate `scripts/scaffold-infra.mjs`, which reproduces the validated infrastructure with no AI and no network:

- Usage: `node scripts/scaffold-infra.mjs --target <directory> --name <app-name>`.
- Use only the Node.js standard library. Validate that `--name` matches `^[a-z][a-z0-9-]{2,30}$`.
- Refuse to run when the target exists and isn't empty, or when the target is inside the source project (otherwise the copy includes itself).
- Copy `infra/`, `azure.yaml`, and `scripts/check-infra.mjs` into the target with the same relative layout. Don't copy `.azure/`, compiled JSON, `node_modules/`, or any `.env` file.
- Replace the `name:` value and the `metadata.template` prefix in the copied `azure.yaml` with the new app name.
- Print the copied files and the next steps: add the API under `src/api`, run `node scripts/check-infra.mjs --offline`, then set the `azd` environment values and deploy.

**Proof:** Scaffold into a new directory under the operating system's temporary directory, run `node scripts/check-infra.mjs --offline` inside it, confirm it passes, and delete the temporary directory.

---

## Deployment Acceptance Criteria

Deployment is complete only when every required check passes:

- The cost and architecture decisions are recorded on the Phase 3 issue.
- `node scripts/check-infra.mjs` passes before `azd up`.
- Post-provision prints `Post-provision SQL setup complete.`
- The checked-in verifier passes against the deployed API and prints its `PASS` line.
- The iOS app can call the deployed HTTPS `API_URL`.
- The reusable skill exists, and the scaffold proof passes.
- The `infra` check is green on the pull request.

The journey README owns the commands that run these checks. After completing the journey, run `azd down --force --purge`.
