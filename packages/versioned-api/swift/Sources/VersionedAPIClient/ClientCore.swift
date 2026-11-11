import Foundation
import HTTPTypes
import OpenAPIRuntime

// The runtime behind a generated Client. A versioned operation exposes every version the client was generated with
// (`v1`, `v2`, ...) and the version negotiated with the server (`version`). The server can serve several versions of
// each; `handshake` reads which from the OpenAPI document it publishes. A versionless operation, one the spec gives no
// version, is a plain call: no handshake, no header, and no compatibility guarantees.

extension HTTPField.Name {
    /// The header a versioned call selects its operation's version with, and a 412 names when it isn't served.
    public static let operationVersion = Self("Operation-Version")!
}

/// The operation ID transports are given for the handshake.
public let handshakeOperationID = "versioned-api.handshake"

/// A header an operation's parameters name isn't a valid header name.
public struct InvalidHeaderNameError: Error, Sendable {
    public let name: String
}

/// Where the API publishes the OpenAPI document it was generated with.
public let publishedDocumentPath = "/openapi.json"

/// The versions a generated client has of each versioned operation.
public typealias Supported = [String: [Int]]

/// A raw response: its status and headers, and its body read whole.
struct Received: Sendable {
    let status: Int
    let headers: HTTPFields
    let data: Data

    var isSuccess: Bool { (200..<300).contains(status) }

    /// A 412 that names `Operation-Version` is the server rejecting the version selected, not the request.
    var isVersionMismatch: Bool {
        status == 412 && headers[.operationVersion] != nil
    }
}

/// What a handshake negotiated, shared by a client and everything made from it with `withOptions`.
final class Negotiation: @unchecked Sendable {
    private let lock = NSLock()
    /// Absent until a handshake succeeds.
    private var negotiated: [String: Int]?
    private var available: [String: [Int]] = [:]
    /// The entity tag of the document last negotiated against, sent back so an unchanged document costs a 304.
    private var etag: String?
    private var pending: Task<Void, any Error>?

    var isNegotiated: Bool { lock.withLock { negotiated != nil } }

    /// The entity tag to ask for the document conditionally with, once negotiated.
    var conditionalTag: String? { lock.withLock { negotiated == nil ? nil : etag } }

    func version(of operationID: String) -> Int?? {
        lock.withLock { negotiated.map { $0[operationID] } }
    }

    func isAvailable(_ operationID: String, _ version: Int) -> Bool {
        lock.withLock { available[operationID]?.contains(version) ?? false }
    }

    func update(negotiated: [String: Int], available: [String: [Int]], etag: String?) {
        lock.withLock {
            self.negotiated = negotiated
            self.available = available
            self.etag = etag
        }
    }

    /// The handshake in flight, or `start`'s, so concurrent callers share one.
    func join(_ start: () -> Task<Void, any Error>) -> Task<Void, any Error> {
        lock.withLock {
            if let pending { return pending }
            let task = start()
            pending = task
            return task
        }
    }

    func finished() {
        lock.withLock { pending = nil }
    }
}

/// Transport, negotiation and result handling behind a generated Client. Copies made with `withOptions` share their
/// negotiation, and carry extra transport controls.
public final class ClientCore: Sendable {
    let configuration: ClientConfiguration
    let supported: Supported
    let negotiation: Negotiation
    let options: RequestOptions

    public convenience init(configuration: ClientConfiguration, supported: Supported) {
        self.init(configuration: configuration, supported: supported, negotiation: Negotiation(), options: .init())
    }

    init(configuration: ClientConfiguration, supported: Supported, negotiation: Negotiation, options: RequestOptions) {
        self.configuration = configuration
        self.supported = supported
        self.negotiation = negotiation
        self.options = options
    }

    /// This client, sharing its negotiation, with `options` applied to each call made through the result.
    public func withOptions(_ options: RequestOptions) -> ClientCore {
        ClientCore(configuration: configuration, supported: supported, negotiation: negotiation, options: options)
    }

    /// Reads all versions of each versioned operation the server serves from its published OpenAPI document. Call
    /// before any versioned operation, and again to refresh. A versioned call made before one has succeeded handshakes
    /// itself, joining one in flight, so callers needn't wait for it. Versionless operations don't need it.
    public func handshake() async throws(HandshakeError) {
        // Concurrent calls, including those that hit a version mismatch, share one handshake.
        let task = negotiation.join {
            Task {
                defer { negotiation.finished() }
                try await readPublishedDocument()
            }
        }
        do {
            try await task.value
        } catch let error as HandshakeError {
            throw error
        } catch {
            throw HandshakeError("Handshake failed", underlying: error)
        }
    }

    /// The version of `operationID` negotiated with the server, or `nil` if it serves none of the versions this client
    /// has.
    public func version(of operationID: String) throws(HandshakeRequiredError) -> Int? {
        guard let version = negotiation.version(of: operationID) else {
            throw HandshakeRequiredError(operationID: operationID)
        }
        return version
    }

    /// Calls `version` of a versioned operation. Refreshes after a protocol rejection, and retries only the same
    /// requested version, once.
    public func versioned<Response: Decodable>(
        _ operationID: String, version: Int, _ request: OperationRequest
    ) async throws(APIError) -> Response {
        // Until one succeeds, every call handshakes, joining one in flight; its error becomes this call's result.
        if !negotiation.isNegotiated {
            do { try await handshake() } catch { throw .handshake(error) }
        }
        guard negotiation.isAvailable(operationID, version) else {
            throw .operationVersionUnavailable(
                operationID: operationID, requested: version, negotiated: negotiation.version(of: operationID) ?? nil)
        }
        let first = try await send(request, version: version)
        guard first.isVersionMismatch else { return try outcome(first) }
        do { try await handshake() } catch { throw .handshake(error) }
        guard negotiation.isAvailable(operationID, version) else {
            throw .operationVersionChanged(
                operationID: operationID, previous: version, current: negotiation.version(of: operationID) ?? nil)
        }
        return try outcome(try await send(request, version: version))
    }

    /// Calls a versionless operation: the same success-body-or-error result as versioned calls, without negotiation.
    public func versionless<Response: Decodable>(_ request: OperationRequest) async throws(APIError) -> Response {
        try outcome(try await send(request, version: nil))
    }

    private func send(_ request: OperationRequest, version: Int?) async throws(APIError) -> Received {
        var target = request.path
        if !request.query.isEmpty {
            target += "?" + request.query.map { "\(formEncoded($0.0))=\(formEncoded($0.1))" }.joined(separator: "&")
        }
        // The client's headers, then this call's (replacing the same names), then the operation's own.
        var headers = configuration.headers
        for field in options.headers { headers[field.name] = field.value }
        for (name, value) in request.headers {
            guard let field = HTTPField.Name(name) else {
                throw .encode(name: name, underlying: InvalidHeaderNameError(name: name))
            }
            headers[field] = value
        }
        if let version { headers[.operationVersion] = String(version) }
        var body: Data?
        if let json = request.body {
            headers[.contentType] = "application/json"
            do { body = try JSONCoding.encoder().encode(json) } catch { throw .encode(name: "body", underlying: error) }
        }
        let built = HTTPRequest(method: request.method, scheme: nil, authority: nil, path: target, headerFields: headers)
        let encoded = body
        let operationID = request.operationID
        guard let timeout = options.timeout else { return try await execute(built, body: encoded, operationID: operationID) }
        return try await withTimeout(timeout) { () async throws(APIError) -> Received in
            try await self.execute(built, body: encoded, operationID: operationID)
        }
    }

    /// Authenticates and sends `request` with the transport, then reads its whole response body.
    private func execute(_ request: HTTPRequest, body: Data?, operationID: String) async throws(APIError) -> Received {
        // Credentials are added once the request is complete, for the handshake too.
        var request = request
        if let auth = configuration.auth {
            do { request = try await auth.authenticate(request, body: body) } catch { throw .authenticate(error) }
        }
        do {
            let (response, responseBody) = try await configuration.transport.send(
                request, body: body.map { HTTPBody($0) }, baseURL: configuration.baseURL, operationID: operationID)
            var data = Data()
            if let responseBody { data = try await Data(collecting: responseBody, upTo: .max) }
            return Received(status: response.status.code, headers: response.headerFields, data: data)
        } catch {
            throw .transport(error)
        }
    }

    /// Fetch and validate the published document, then negotiate every operation against it at once. Once negotiated,
    /// the document is asked for conditionally: a 304 says it is unchanged, so what was negotiated stands.
    private func readPublishedDocument() async throws(HandshakeError) {
        let conditional = negotiation.conditionalTag
        var headers = configuration.headers
        if let conditional { headers[.ifNoneMatch] = conditional }
        let request = HTTPRequest(method: .get, scheme: nil, authority: nil, path: publishedDocumentPath, headerFields: headers)
        let received: Received
        do {
            received = try await execute(request, body: nil, operationID: handshakeOperationID)
        } catch {
            throw HandshakeError("Handshake failed", underlying: error)
        }
        if conditional != nil && received.status == 304 { return }
        let failed = "GET \(publishedDocumentPath) failed (\(received.status))"
        guard received.isSuccess else {
            let error = HTTPError(status: received.status, headers: received.headers, body: ResponseBody(received.data))
            throw HandshakeError(failed, underlying: APIError.classify(error))
        }
        let document: JSONValue
        do {
            document = try JSONDecoder().decode(JSONValue.self, from: received.data)
        } catch {
            throw HandshakeError(failed, underlying: error)
        }
        let (negotiated, available) = try negotiate(document, supported)
        negotiation.update(negotiated: negotiated, available: available, etag: received.headers[.eTag])
    }
}

/// Unsuccessful statuses become HTTP errors; a successful body is decoded as the operation's response, with no body
/// (such as a 204's) decoding as `null`, which `NoContent` and optionals accept.
private func outcome<Response: Decodable>(_ received: Received) throws(APIError) -> Response {
    guard received.isSuccess else {
        throw .classify(HTTPError(status: received.status, headers: received.headers, body: ResponseBody(received.data)))
    }
    do {
        return try JSONCoding.decoder().decode(Response.self, from: received.data.isEmpty ? Data("null".utf8) : received.data)
    } catch {
        throw .decode(underlying: error, body: ResponseBody(received.data))
    }
}

/// Runs `operation`, failing with `APIError.timeout` if it takes longer than `timeout`.
private func withTimeout<T: Sendable>(
    _ timeout: Duration, _ operation: @escaping @Sendable () async throws(APIError) -> T
) async throws(APIError) -> T {
    let result = await withTaskGroup(of: Result<T, APIError>?.self) { group in
        group.addTask {
            do throws(APIError) { return .success(try await operation()) } catch { return .failure(error) }
        }
        group.addTask {
            do { try await Task.sleep(for: timeout) } catch { return nil }
            return .failure(.timeout(timeout))
        }
        for await result in group {
            if let result {
                group.cancelAll()
                return result
            }
        }
        return .failure(.timeout(timeout))
    }
    return try result.get()
}

private let unreserved = CharacterSet(
    charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.~")

/// A query name or value, with everything but unreserved characters percent-encoded.
private func formEncoded(_ text: String) -> String {
    text.addingPercentEncoding(withAllowedCharacters: unreserved) ?? text
}

private let methods = ["get", "put", "post", "delete", "patch", "options", "head", "trace"]

/// Validate the advertised set; a legacy document advertises only its described version.
private func servedVersions(_ operationID: String, _ operation: [String: JSONValue]) throws(HandshakeError) -> [Int] {
    let invalid = HandshakeError("Invalid served versions for \(operationID)")
    func version(_ value: JSONValue) throws(HandshakeError) -> Int {
        guard case .number(let number) = value, number.rounded() == number, number > 0, number <= Double(UInt32.max)
        else { throw invalid }
        return Int(number)
    }
    let described = try operation["x-operation-version"].map { (value) throws(HandshakeError) in try version(value) }
    var served: [Int]
    switch operation["x-operation-versions"] {
    case nil:
        served = described.map { [$0] } ?? []
    case .array(let values)? where !values.isEmpty:
        served = []
        for value in values { served.append(try version(value)) }
    default:
        throw invalid
    }
    if !served.isEmpty && (described.map { !served.contains($0) } ?? true || Set(served).count != served.count) {
        throw invalid
    }
    return served
}

/// Negotiate each operation independently, retaining all shared versions for explicit `vN` calls.
private func negotiate(
    _ document: JSONValue, _ supported: Supported
) throws(HandshakeError) -> (negotiated: [String: Int], available: [String: [Int]]) {
    let notADocument = HandshakeError("GET \(publishedDocumentPath) returned no OpenAPI paths")
    guard case .object(let root) = document, case .object(let paths)? = root["paths"] else { throw notADocument }
    var negotiated: [String: Int] = [:]
    var available: [String: [Int]] = [:]
    var seen = Set<String>()
    for item in paths.values {
        guard case .object(let item) = item else { throw notADocument }
        for method in methods {
            guard case .object(let operation)? = item[method] else { continue }
            guard case .string(let operationID)? = operation["operationId"] else {
                throw HandshakeError("Published operation without an operationId")
            }
            // Each logical operation is unique; preserve all intersections and choose the highest as the default.
            guard seen.insert(operationID).inserted else {
                throw HandshakeError("Duplicate operationId: \(operationID)")
            }
            let ours = supported[operationID] ?? []
            let shared = try servedVersions(operationID, operation).filter(ours.contains).sorted()
            if let highest = shared.last { negotiated[operationID] = highest }
            available[operationID] = shared
        }
    }
    return (negotiated, available)
}
