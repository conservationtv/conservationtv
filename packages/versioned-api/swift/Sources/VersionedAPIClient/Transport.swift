import Foundation
import HTTPTypes
import OpenAPIRuntime
import OpenAPIURLSession

/// How a Client authenticates: given each request as it is about to be sent, with every header and its body, return it
/// with credentials added. `Bearer` sends a token; an API's SDK may offer others, such as signing.
public protocol Authenticate: Sendable {
    func authenticate(_ request: HTTPRequest, body: Data?) async throws -> HTTPRequest
}

/// Sends a token as `Authorization: Bearer …`.
public struct Bearer: Authenticate {
    public let token: String

    public init(_ token: String) {
        self.token = token
    }

    public func authenticate(_ request: HTTPRequest, body: Data?) async throws -> HTTPRequest {
        var request = request
        request.headerFields[.authorization] = "Bearer \(token)"
        return request
    }
}

/// Authenticates with a closure, for credentials read at call time.
public struct AuthenticateWith: Authenticate {
    let body: @Sendable (HTTPRequest, Data?) async throws -> HTTPRequest

    public init(_ body: @escaping @Sendable (HTTPRequest, Data?) async throws -> HTTPRequest) {
        self.body = body
    }

    public func authenticate(_ request: HTTPRequest, body: Data?) async throws -> HTTPRequest {
        try await self.body(request, body)
    }
}

extension Authenticate where Self == Bearer {
    /// Send `token` as `Authorization: Bearer …`.
    public static func bearer(_ token: String) -> Bearer { Bearer(token) }
}

/// The options a Client accepts: the base URL and transport controls. Response and error handling are the runtime's.
public struct ClientConfiguration: Sendable {
    /// Where requests are sent: the scheme and authority (and any base path) operation paths are appended to.
    public var baseURL: URL
    /// What sends each request, the handshake included: the Swift counterpart of the TypeScript SDK's `fetch`. Any
    /// swift-openapi-runtime `ClientTransport`: `URLSessionTransport` by default, or another, such as
    /// `AsyncHTTPClientTransport`, or one over a peer-to-peer connection.
    public var transport: any ClientTransport
    /// Headers sent with every request, the handshake included.
    public var headers: HTTPFields
    public var auth: (any Authenticate)?

    public init(
        baseURL: URL,
        transport: any ClientTransport = URLSessionTransport(),
        headers: HTTPFields = [:],
        auth: (any Authenticate)? = nil
    ) {
        self.baseURL = baseURL
        self.transport = transport
        self.headers = headers
        self.auth = auth
    }
}

/// Per-call transport controls, for the calls made through a client's `withOptions`.
public struct RequestOptions: Sendable {
    /// Headers added to (and replacing the same names of) the client's own.
    public var headers: HTTPFields
    /// How long a call may take, retries and its own handshake aside, before it fails with `APIError.timeout`.
    public var timeout: Duration?

    public init(headers: HTTPFields = [:], timeout: Duration? = nil) {
        self.headers = headers
        self.timeout = timeout
    }
}
