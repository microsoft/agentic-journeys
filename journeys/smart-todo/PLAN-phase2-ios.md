# SmartTodo Phase 2: iOS App

Finish the SwiftUI client by building its **Todo Detail screen** from the mockups, test-first, against the API contract in [`PLAN-phase1-api.md`](./PLAN-phase1-api.md). The starter project in `starter/ios` already contains the rest of the app and its tests, so this phase spends its time on the screen where the AI feature lives: generating steps, checking them off, and watching the todo complete. Read [`PLAN.md`](./PLAN.md) first for the journey vision, shared decisions, and quality gates.

README prompts use the exact section names in this document as stable references. If a section is renamed, update its README references in the same change.

## Mockups

The wireframes in [`images/mockups/`](./images/mockups/) are the visual contract for layout and behavior:

| File | Screen |
| --- | --- |
| [`smart-todo-mockups.png`](./images/mockups/smart-todo-mockups.png) | All four screens side by side |
| [`todo-list.png`](./images/mockups/todo-list.png) | `TodoListView` with status badges, step progress, and swipe to delete (in the starter) |
| [`add-todo.png`](./images/mockups/add-todo.png) | `AddTodoView` sheet with the keyboard focused (in the starter) |
| [`todo-detail-empty.png`](./images/mockups/todo-detail-empty.png) | `TodoDetailView` before steps are generated (**Phase 2 builds it**) |
| [`todo-detail-steps.png`](./images/mockups/todo-detail-steps.png) | `TodoDetailView` with `ActionStepsView` and progress (**Phase 2 builds it**) |

Pink notes on the mockups are behavior annotations. When a mockup and this document disagree, this document wins.

## iOS Client

### Platform Requirements

- iOS 17.0+ deployment target
- SwiftUI with async/await
- No third-party dependencies. Use `URLSession` for networking and `JSONDecoder`/`JSONEncoder` for serialization.

### Project Layout

Paths are relative to `journeys/smart-todo`.

```text
src/ios/
├── SmartTodo.xcodeproj/
│   └── xcshareddata/xcschemes/SmartTodo.xcscheme   # shared scheme, committed
├── SmartTodo/            # app target
├── SmartTodoTests/       # unit test target (XCTest)
└── SmartTodoUITests/     # UI test target (XCUITest)
```

**Start from the starter project.** Copy `starter/ios` to `src/ios` at the start of the red phase. It has the three targets, a committed shared scheme that tests both test targets, iOS 17 as the deployment target, and the Debug settings `#if DEBUG` and `@testable import` need. It also contains the finished parts of the app, with passing tests:

| Starter file | Contains |
| --- | --- |
| `SmartTodo/ModelsAndClients.swift` | `Config`, the models, `APIClientProtocol`, `APIClient`, and `InMemoryAPIClient` |
| `SmartTodo/AppState.swift` | `AccessibilityIdentifiers`, `TodoStore` (load, add, update, generate, toggle, delete), `AddTodoViewModel`, and `AppDependencies` |
| `SmartTodo/Views.swift` | `TodoListView`, the row view, and `AddTodoView` |
| `SmartTodo/TodoDetailView.swift` | **A placeholder** that shows only the title. Phase 2 replaces it. |
| `SmartTodoTests/` | `APIClient` request and decoding tests, `InMemoryAPIClient` parity tests, `TodoStore` tests, and the shared `MockAPIClient` in `TestSupport.swift` |
| `SmartTodoUITests/SmartTodoListUITests.swift` | The seeded list and adding a todo |

Phase 2 adds `SmartTodo/TodoDetailViewModel.swift`, replaces `SmartTodo/TodoDetailView.swift` with `TodoDetailView` and `ActionStepsView`, and adds their tests as new files. Call the existing `TodoStore` and `APIClientProtocol`. Don't change the starter's other app files unless a test proves a bug in them, and never change or delete the starter's test files: the gate checks them.

The project uses Xcode's synchronized folders, so every file inside `SmartTodo/`, `SmartTodoTests/`, or `SmartTodoUITests/` (including subfolders) belongs to that target automatically. **Don't edit `project.pbxproj`** to add files, and don't convert the project to an older format. Hand-written project files were the slowest and most error-prone step in earlier runs. Name every XCTest method with a `test` prefix; XCTest silently skips methods without it.

### Config (in the starter)

`Config` is at the top of `SmartTodo/ModelsAndClients.swift`. App Transport Security already allows plain HTTP to `localhost`, so the Debug build reaches `http://localhost:7071` without an ATS exception. Don't add one, even if a reviewer suggests it.

```swift
enum Config {
    #if DEBUG
    static let apiBaseURL = "http://localhost:7071"
    #else
    static let apiBaseURL = "https://<your-function-app>.azurewebsites.net"
    #endif

    static let defaultUserId = "user-1"
}
```

The API URL must be configurable, never hardcoded in a view or service. Use `#if DEBUG` to switch between local dev and production.

**To test against the deployed Azure API:** The simplest approach is to replace the `apiBaseURL` value directly (removing the `#if DEBUG` / `#else` / `#endif` conditional) with your deployed Function App URL. Get the URL with `azd env get-value API_URL`. You can restore the conditional later.

### Models (in the starter)

Swift `Codable` + `Identifiable` models that match the API `Todo`, `ActionStep`, and `{ error: { code, message } }` shapes exactly.

### API Client (in the starter)

```swift
protocol APIClientProtocol {
    func getTodos() async throws -> [Todo]
    func createTodo(title: String) async throws -> Todo
    func updateTodo(id: String, title: String?, status: String?) async throws -> Todo
    func deleteTodo(id: String) async throws
    func generateSteps(todoId: String) async throws -> Todo
    func updateStep(todoId: String, stepId: String, isCompleted: Bool) async throws -> ActionStep
}
```

- `APIClient` implements the protocol with `URLSession` and `Config.apiBaseURL`. Inject the `URLSession` so tests can use a `URLProtocol` stub.
- All methods use `data(for:)` with `async throws`. On non-2xx responses, decode the `APIError` format and throw a descriptive `LocalizedError`.
- `DELETE /api/todos/:id` returns `204 No Content`, so the client must not try to decode JSON for that call.
- `InMemoryAPIClient` must behave exactly like the Phase 1 API: the same seed data, the fake generator's four step titles in order, and the same status rules for step toggles and regeneration (including Decision Points 2 and 3). Omit `nil` optional fields from request bodies rather than encoding them as JSON `null`, because the API treats a present `null` as a change. `InMemoryAPIClient` implements the same protocol and is used for SwiftUI previews and UI tests.
- Views receive the client through the SwiftUI environment or an initializer, never through a global singleton.

### UI Test Mode (in the starter)

When the app launches with the argument `-ui-testing`, it uses `InMemoryAPIClient` instead of `APIClient`. UI tests are then deterministic and need no running API.

### Views

#### TodoListView (in the starter)

- Status badges never wrap mid-word: use `lineLimit(1)` and `fixedSize()`, and use `ViewThatFits` to stack the badge above the step count at accessibility text sizes.

- Navigation title: "SmartTodo"
- List of todos showing: title, status badge (color-coded: gray=pending, blue=in_progress, green=completed), step progress (for example, "2/4 steps")
- Swipe to delete with confirmation
- "+" button in the navigation bar toolbar to present `AddTodoView` as a sheet
- Tap a todo row to navigate to `TodoDetailView`
- Pull to refresh with `.refreshable`
- Empty state: "No todos yet. Tap + to add one."

#### AddTodoView (in the starter)

- Text field for todo title with placeholder "What do you want to accomplish?"
- "Add" button (disabled if title is empty or whitespace-only)
- "Cancel" button to dismiss
- Keyboard auto-focused on appear with `.onAppear { isFocused = true }`

#### TodoDetailView (Phase 2 builds it)

Use a `TodoDetailViewModel` (`@MainActor`, `ObservableObject`) that owns the displayed todo, calls `TodoStore` and its client, and exposes `progressLabel`, `isGenerating`, and `shouldDismiss`, so the tests can drive every behavior without the UI.


- Todo title displayed as editable `TextField`
- Status picker: `Picker` with `pending`, `in_progress`, `completed` options
- Conditional button:
  - "✨ Generate Steps" when `stepsGenerated == false`, prominent style: `HStack { Image(systemName: "sparkles"); Text("Generate Steps") }` with `.frame(maxWidth: .infinity)` and `.buttonStyle(.borderedProminent)`.
  - "🔄 Regenerate Steps" when `stepsGenerated == true`, same `HStack` pattern with `Image(systemName: "arrow.clockwise")` and `.tint(.blue)` for visibility
- `ProgressView` overlay during AI generation with "Generating steps..." label, and the button disabled while the request is in flight
- `ActionStepsView` embedded below (if steps exist)
- "Delete Todo" button at bottom (destructive style, with confirmation alert)
- **Build the screen as a `ScrollView` containing a `VStack`, not a `Form` or `List`.** `Form` and `List` create rows lazily, so a row below the visible area isn't in the accessibility tree and the UI test can't find it. With a `Form`, the flow test failed about one CI run in eight once a feature added controls above the steps; with a `ScrollView`, 16 of 16 passed. The `ScrollView` also keeps the generate button, action steps, and delete button reachable however many steps there are.

#### ActionStepsView (Phase 2 builds it)

- Progress bar at top: `ProgressView(value: completedCount, total: totalCount)` with label "N of M complete"
- Ordered list of steps sorted by `order`. It must scroll so all 7 steps are visible. Do NOT use a fixed-height container that clips at 5 items.
- Each row shows:
  - Checkbox (toggle `isCompleted` via API call)
  - Step number (1, 2, 3...)
  - Title (strikethrough + gray when completed)
  - Description

### Accessibility Identifiers

UI tests find elements by these identifiers, so they are part of the contract:

| Element | Identifier |
| --- | --- |
| Add button in the toolbar | `addTodoButton` |
| Todo row | `todoRow-<todo id>` |
| Status badge in a row | `statusBadge-<todo id>` |
| Title field in `AddTodoView` | `newTodoTitleField` |
| Add button in `AddTodoView` | `saveTodoButton` |
| Generate or Regenerate button | `generateStepsButton` |
| Status picker | `statusPicker` |
| Step checkbox | `stepToggle-<order>` |
| Progress label | `stepsProgressLabel` |
| Delete Todo button | `deleteTodoButton` |

### Decision Points

The `grill-plan` skill asks about each item. Use the default when the learner has no preference.

| # | Question | Why it matters | Default |
| --- | --- | --- | --- |
| 1 | When is an edited title saved? | Saving on every keystroke floods the API; a blank title isn't valid. | On Return. A blank or whitespace-only title isn't sent, and the field restores the saved title. |
| 2 | Does changing the status need a Save button? | Two ways to save confuse people. | No. Save immediately. If the API fails, restore the last saved status and show the error. |
| 3 | Does Regenerate Steps ask for confirmation first? | Regenerating replaces steps the person may have checked. | No. Regenerate immediately; the button's label ("Regenerate Steps") says what it does. |
| 4 | When does Delete Todo leave the screen? | Leaving before the API confirms hides a failed delete. | Only after the API succeeds. On failure, stay on the screen and show the error. |

The starter already settled three earlier questions, and Phase 2 keeps them: API errors appear as an alert with an OK button (`TodoStore.present`), a step checkbox waits for the API and is disabled while its request is in flight, and the list reloads after each toggle so the parent todo's status comes from the server.

---

## Test Strategy

The starter's tests already cover the API client, `InMemoryAPIClient` parity with the Phase 1 status rules, and `TodoStore`. Phase 2's red phase adds:

**Unit tests (`SmartTodoTests`)** for `TodoDetailViewModel`, using the starter's `MockAPIClient`:

- Each Decision Point above, including the failure paths (a failed title or status update restores the saved value and shows the error; a failed delete stays on the screen).
- Generating steps sets `isGenerating` while the request is in flight and clears it afterward, even on failure.
- Generated steps are shown sorted by `order`, and `progressLabel` reads "N of M complete".
- Toggling a step updates the displayed todo from the reloaded list, so an auto-completed parent shows `completed`.

The fake generator always returns four steps, so check that seven steps stay reachable during exploratory testing rather than with a unit test.

**UI test (`SmartTodoUITests`)** launches the app with `-ui-testing` and walks the main flow:

1. The list shows the three seed todos.
2. Add "Plan a weekend camping trip" and see it in the list with a `pending` badge.
3. Open it, tap `generateStepsButton`, and see four steps and "0 of 4 complete".
4. Check every step and see "4 of 4 complete". Wait for each checkbox's request to finish before tapping the next one.
5. Go back and see a `completed` badge on the new todo (`statusBadge-todo-4`; a seed todo is already `completed`, so don't match any badge).

**Wait at least 10 seconds.** Give every `waitForExistence` and `XCTWaiter` in a UI test a timeout of at least 10 seconds. GitHub's macOS runners are much slower than a Mac, and a 2- or 3-second wait made the UI test fail about one run in eight in CI while passing every time locally. A wait that succeeds returns immediately, so the longer timeout costs nothing when the app is fast.

**Red phase:** Add only the stub types the tests need to compile, such as a `TodoDetailViewModel` whose methods do nothing. Commit the tests and tag the commit `phase2-red`. When review findings add tests later, the human deletes the tag, and the agent commits the tests as a new red commit and tags it `phase2-red` again.

## Quality Gate

`scripts/test-ios.mjs` is checked in with the journey. It skips on anything other than macOS, picks an available iPhone simulator on the newest iOS runtime, runs `xcodebuild test` on the shared scheme, and prints every compiler `error:` line, every XCTest assertion failure, and every failed test name when the run fails, so a reviewer or the cloud agent can see why without a Mac. Don't change it.

With `--check-starter`, it first proves that every test file from `starter/ios` is still in `src/ios`, unchanged, so the red phase can't weaken the starter's tests.

The Phase 2 gate passes when these exit `0` on a Mac:

1. `node scripts/test-ios.mjs --check-starter`
2. `git diff --exit-code phase2-red -- src/ios/SmartTodoTests src/ios/SmartTodoUITests` (green didn't change the new tests)
3. `git diff --exit-code main -- scripts/test-ios.mjs starter/ios` (nobody changed the runner or the starter)

The `ios` CI job runs the script without `--check-starter` on a macOS runner, because later features may legitimately change a starter test.

## Exploratory QA with Computer Use (Optional)

The UI test proves the scripted flow. Exploratory testing finds what the script didn't think of. With Computer Use enabled (`/computer`), an agent can open the Simulator app, take screenshots, and tap through the app like a person. Useful targets are long titles, seven generated steps, rapid repeated taps, rotation, Dark Mode, and Dynamic Type.

Computer Use is not a gate. Its results vary between runs, and it needs Screen Recording and Accessibility permissions on the Mac. Turn anything real it finds into a new XCUITest so the finding becomes deterministic.

---

## Phase 2 Acceptance Criteria

- `src/ios` started from `starter/ios`, its `project.pbxproj` is unchanged, and the committed shared scheme still tests both test targets.
- The starter's files other than `TodoDetailView.swift` are unchanged, unless a new test proved a bug in them.
- `TodoDetailView` and `ActionStepsView` match the detail mockups and use the accessibility identifiers in this plan.
- The generate, regenerate, check-off, progress, and completion flows work against the local API.
- `TodoDetailView` is a `ScrollView` with a `VStack`, and the generate and regenerate buttons use the `HStack` icon pattern and show a loading state during AI generation.
- The Decision Points answers are recorded on the issue and covered by tests.
- The [Quality Gate](#quality-gate) passes on a Mac, and the `ios` check is green on the pull request.
