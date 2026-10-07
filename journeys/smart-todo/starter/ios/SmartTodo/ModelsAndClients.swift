import Foundation

enum Config {
    #if DEBUG
    static let apiBaseURL = "http://localhost:7071"
    #else
    static let apiBaseURL = "https://<your-function-app>.azurewebsites.net"
    #endif

    static let defaultUserId = "user-1"
}

enum TodoStatus: String, Codable, CaseIterable {
    case pending
    case inProgress = "in_progress"
    case completed
}

struct ActionStep: Codable, Identifiable, Equatable {
    let id: String
    let todoId: String
    let title: String
    let description: String
    let order: Int
    var isCompleted: Bool
    let createdAt: String

    init(
        id: String,
        todoId: String,
        title: String,
        description: String,
        order: Int,
        isCompleted: Bool,
        createdAt: String = "2026-01-01T00:00:00.000Z"
    ) {
        self.id = id
        self.todoId = todoId
        self.title = title
        self.description = description
        self.order = order
        self.isCompleted = isCompleted
        self.createdAt = createdAt
    }
}

struct Todo: Codable, Identifiable, Equatable {
    let id: String
    var title: String
    var status: TodoStatus
    let userId: String
    var stepsGenerated: Bool
    let createdAt: String
    var updatedAt: String
    var steps: [ActionStep]

    init(
        id: String,
        title: String,
        status: TodoStatus = .pending,
        userId: String = Config.defaultUserId,
        stepsGenerated: Bool = false,
        createdAt: String = "2026-01-01T00:00:00.000Z",
        updatedAt: String = "2026-01-01T00:00:00.000Z",
        steps: [ActionStep] = []
    ) {
        self.id = id
        self.title = title
        self.status = status
        self.userId = userId
        self.stepsGenerated = stepsGenerated
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.steps = steps
    }
}

private struct APIErrorEnvelope: Decodable {
    let error: APIErrorDetail
}

private struct APIErrorDetail: Decodable {
    let code: String
    let message: String
}

struct APIClientError: LocalizedError {
    let message: String
    var errorDescription: String? { message }
}

protocol APIClientProtocol {
    func getTodos() async throws -> [Todo]
    func createTodo(title: String) async throws -> Todo
    func updateTodo(id: String, title: String?, status: String?) async throws -> Todo
    func deleteTodo(id: String) async throws
    func generateSteps(todoId: String) async throws -> Todo
    func updateStep(todoId: String, stepId: String, isCompleted: Bool) async throws -> ActionStep
}

final class APIClient: APIClientProtocol {
    private let transport: URLSessionTransport
    private let baseURL: URL
    private let decoder = JSONDecoder()
    private let encoder = JSONEncoder()

    init(
        session: URLSession = .shared,
        baseURL: URL = URL(string: Config.apiBaseURL)!
    ) {
        self.transport = URLSessionTransport(session: session)
        self.baseURL = baseURL
    }

    func getTodos() async throws -> [Todo] {
        var components = URLComponents(
            url: baseURL.appending(path: "api/todos"),
            resolvingAgainstBaseURL: false
        )!
        components.queryItems = [URLQueryItem(name: "userId", value: Config.defaultUserId)]
        return try await send(URLRequest(url: components.url!))
    }

    func createTodo(title: String) async throws -> Todo {
        var request = URLRequest(url: baseURL.appending(path: "api/todos"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try encoder.encode(
            CreateTodoRequest(title: title.trimmingCharacters(in: .whitespacesAndNewlines),
                              userId: Config.defaultUserId)
        )
        return try await send(request)
    }

    func updateTodo(id: String, title: String?, status: String?) async throws -> Todo {
        var request = URLRequest(url: baseURL.appending(path: "api/todos/\(id)"))
        request.httpMethod = "PATCH"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try encoder.encode(UpdateTodoRequest(title: title, status: status))
        return try await send(request)
    }

    func deleteTodo(id: String) async throws {
        var request = URLRequest(url: baseURL.appending(path: "api/todos/\(id)"))
        request.httpMethod = "DELETE"
        let (data, response) = try await perform(request)
        try validate(response: response, data: data)
    }

    func generateSteps(todoId: String) async throws -> Todo {
        var request = URLRequest(
            url: baseURL.appending(path: "api/todos/\(todoId)/generate-steps")
        )
        request.httpMethod = "POST"
        return try await send(request)
    }

    func updateStep(todoId: String, stepId: String, isCompleted: Bool) async throws -> ActionStep {
        var request = URLRequest(
            url: baseURL.appending(path: "api/todos/\(todoId)/steps/\(stepId)")
        )
        request.httpMethod = "PATCH"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try encoder.encode(UpdateStepRequest(isCompleted: isCompleted))
        return try await send(request)
    }

    private func send<Response: Decodable>(_ request: URLRequest) async throws -> Response {
        let (data, response) = try await perform(request)
        try validate(response: response, data: data)
        return try decoder.decode(Response.self, from: data)
    }

    private func perform(_ request: URLRequest) async throws -> (Data, URLResponse) {
        try await transport.data(for: request)
    }

    private func validate(response: URLResponse, data: Data) throws {
        guard let response = response as? HTTPURLResponse else {
            throw APIClientError(message: "The server returned an invalid response.")
        }
        guard (200..<300).contains(response.statusCode) else {
            if let envelope = try? decoder.decode(APIErrorEnvelope.self, from: data) {
                throw APIClientError(message: envelope.error.message)
            }
            throw APIClientError(message: "Request failed with status \(response.statusCode).")
        }
    }
}

private final class URLSessionTransport: @unchecked Sendable {
    private let session: URLSession
    private let protocolClasses: [AnyClass]

    init(session: URLSession) {
        self.session = session
        // Tests add URLProtocol stubs to the configuration. Foundation's own protocol classes,
        // such as the HTTP one, must go through URLSession: driven directly, HTTPS never finishes.
        let system = Set((URLSessionConfiguration.default.protocolClasses ?? []).map(ObjectIdentifier.init))
        self.protocolClasses = (session.configuration.protocolClasses ?? []).filter {
            !system.contains(ObjectIdentifier($0))
        }
    }

    func data(for request: URLRequest) async throws -> (Data, URLResponse) {
        if let protocolClass = protocolClasses
            .compactMap({ $0 as? URLProtocol.Type })
            .first(where: { $0.canInit(with: request) }) {
            return try await URLProtocolLoader.load(
                request: protocolClass.canonicalRequest(for: request),
                using: protocolClass
            )
        }

        return try await withCheckedThrowingContinuation { continuation in
            session.dataTask(with: request) { data, response, error in
                if let error {
                    continuation.resume(throwing: error)
                } else if let data, let response {
                    continuation.resume(returning: (data, response))
                } else {
                    continuation.resume(
                        throwing: APIClientError(message: "The server returned an invalid response.")
                    )
                }
            }.resume()
        }
    }
}

private final class URLProtocolLoader: NSObject, URLProtocolClient, @unchecked Sendable {
    private var data = Data()
    private var response: URLResponse?
    private let continuation: CheckedContinuation<(Data, URLResponse), Error>
    private var urlProtocol: URLProtocol?

    private init(continuation: CheckedContinuation<(Data, URLResponse), Error>) {
        self.continuation = continuation
    }

    static func load(
        request: URLRequest,
        using protocolClass: URLProtocol.Type
    ) async throws -> (Data, URLResponse) {
        try await withCheckedThrowingContinuation { continuation in
            let loader = URLProtocolLoader(continuation: continuation)
            let instance = protocolClass.init(
                request: request,
                cachedResponse: nil,
                client: loader
            )
            loader.urlProtocol = instance
            instance.startLoading()
        }
    }

    func urlProtocol(
        _ protocol: URLProtocol,
        wasRedirectedTo request: URLRequest,
        redirectResponse: URLResponse
    ) {
        urlProtocol?.stopLoading()
        continuation.resume(throwing: URLError(.httpTooManyRedirects))
    }

    func urlProtocol(_ protocol: URLProtocol, cachedResponseIsValid cachedResponse: CachedURLResponse) {}

    func urlProtocol(
        _ protocol: URLProtocol,
        didReceive response: URLResponse,
        cacheStoragePolicy policy: URLCache.StoragePolicy
    ) {
        self.response = response
    }

    func urlProtocol(_ protocol: URLProtocol, didLoad data: Data) {
        self.data.append(data)
    }

    func urlProtocolDidFinishLoading(_ protocol: URLProtocol) {
        guard let response else {
            continuation.resume(
                throwing: APIClientError(message: "The server returned an invalid response.")
            )
            return
        }
        continuation.resume(returning: (data, response))
    }

    func urlProtocol(_ protocol: URLProtocol, didFailWithError error: Error) {
        continuation.resume(throwing: error)
    }

    func urlProtocol(
        _ protocol: URLProtocol,
        didReceive challenge: URLAuthenticationChallenge
    ) {
        challenge.sender?.performDefaultHandling?(for: challenge)
    }

    func urlProtocol(
        _ protocol: URLProtocol,
        didCancel challenge: URLAuthenticationChallenge
    ) {}
}

private struct CreateTodoRequest: Encodable {
    let title: String
    let userId: String
}

private struct UpdateTodoRequest: Encodable {
    let title: String?
    let status: String?
}

private struct UpdateStepRequest: Encodable {
    let isCompleted: Bool
}

final class InMemoryAPIClient: APIClientProtocol {
    private var todos: [Todo]
    private var nextID = 4
    private let createdAt = "2026-01-01T00:00:00.000Z"

    init(todos: [Todo]? = nil) {
        self.todos = todos ?? Self.seedTodos
    }

    func getTodos() async throws -> [Todo] {
        todos
    }

    func createTodo(title: String) async throws -> Todo {
        let todo = Todo(id: "todo-\(nextID)", title: title)
        nextID += 1
        todos.append(todo)
        return todo
    }

    func updateTodo(id: String, title: String?, status: String?) async throws -> Todo {
        guard let index = todos.firstIndex(where: { $0.id == id }) else {
            throw APIClientError(message: "Todo not found")
        }
        if let title {
            todos[index].title = title
        }
        if let status, let status = TodoStatus(rawValue: status) {
            todos[index].status = status
        }
        todos[index].updatedAt = createdAt
        return todos[index]
    }

    func deleteTodo(id: String) async throws {
        guard let index = todos.firstIndex(where: { $0.id == id }) else {
            throw APIClientError(message: "Todo not found")
        }
        todos.remove(at: index)
    }

    func generateSteps(todoId: String) async throws -> Todo {
        guard let index = todos.firstIndex(where: { $0.id == todoId }) else {
            throw APIClientError(message: "Todo not found")
        }
        let title = todos[index].title
        let definitions = [
            ("Clarify the goal", "Define the desired result for \"\(title)\"."),
            ("Gather what you need", "Collect the information and tools needed for \"\(title)\"."),
            ("Do the first focused session", "Schedule and complete a focused work session for \"\(title)\"."),
            ("Review and wrap up", "Review the result of \"\(title)\" and finish any remaining details."),
        ]
        todos[index].steps = definitions.enumerated().map { offset, definition in
            ActionStep(
                id: "\(todoId)-generated-\(offset + 1)",
                todoId: todoId,
                title: definition.0,
                description: definition.1,
                order: offset + 1,
                isCompleted: false,
                createdAt: createdAt
            )
        }
        todos[index].stepsGenerated = true
        if todos[index].status == .completed {
            todos[index].status = .inProgress
        }
        return todos[index]
    }

    func updateStep(todoId: String, stepId: String, isCompleted: Bool) async throws -> ActionStep {
        guard let todoIndex = todos.firstIndex(where: { $0.id == todoId }),
              let stepIndex = todos[todoIndex].steps.firstIndex(where: { $0.id == stepId }) else {
            throw APIClientError(message: "Action step not found")
        }
        todos[todoIndex].steps[stepIndex].isCompleted = isCompleted
        let steps = todos[todoIndex].steps
        if !steps.isEmpty && steps.allSatisfy(\.isCompleted) {
            todos[todoIndex].status = .completed
        } else if !isCompleted && todos[todoIndex].status == .completed {
            todos[todoIndex].status = .inProgress
        } else if isCompleted && todos[todoIndex].status == .pending {
            todos[todoIndex].status = .inProgress
        }
        return todos[todoIndex].steps[stepIndex]
    }

    private static let seedTodos: [Todo] = {
        let homeOfficeSteps = [
            ActionStep(id: "step-2-1", todoId: "todo-2", title: "Choose a desk and chair", description: "Compare ergonomic options and select a desk and chair.", order: 1, isCompleted: true),
            ActionStep(id: "step-2-2", todoId: "todo-2", title: "Set up monitor and peripherals", description: "Connect the monitor, keyboard, mouse, and other peripherals.", order: 2, isCompleted: true),
            ActionStep(id: "step-2-3", todoId: "todo-2", title: "Organize cable management", description: "Route and secure power and data cables.", order: 3, isCompleted: false),
            ActionStep(id: "step-2-4", todoId: "todo-2", title: "Set up lighting", description: "Position task lighting to reduce glare.", order: 4, isCompleted: false),
        ]
        let hikingSteps = [
            ActionStep(id: "step-3-1", todoId: "todo-3", title: "Pick a trail", description: "Choose a trail suitable for the group.", order: 1, isCompleted: true),
            ActionStep(id: "step-3-2", todoId: "todo-3", title: "Check weather forecast", description: "Review the forecast and trail conditions.", order: 2, isCompleted: true),
            ActionStep(id: "step-3-3", todoId: "todo-3", title: "Pack gear and supplies", description: "Pack water, food, navigation, and safety gear.", order: 3, isCompleted: true),
        ]
        return [
            Todo(id: "todo-1", title: "Prepare conference talk"),
            Todo(id: "todo-2", title: "Set up home office", status: .inProgress, stepsGenerated: true, steps: homeOfficeSteps),
            Todo(id: "todo-3", title: "Plan weekend hiking trip", status: .completed, stepsGenerated: true, steps: hikingSteps),
        ]
    }()
}
