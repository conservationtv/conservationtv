import Foundation
import HTTPTypes

/// A response body as the transport read it: JSON, text, or nothing.
public enum ResponseBody: Hashable, Sendable {
    case json(JSONValue)
    case text(String)
    case empty

    init(_ data: Data) {
        if data.isEmpty {
            self = .empty
        } else if let value = try? JSONDecoder().decode(JSONValue.self, from: data) {
            self = .json(value)
        } else {
            self = .text(String(decoding: data, as: UTF8.self))
        }
    }
}

/// An HTTP failure, with the server's status, headers and parsed body available for inspection.
public struct HTTPError: Error, Sendable, CustomStringConvertible {
    public let status: Int
    /// The server's stable error category, such as `invalid_request`, when it sent one.
    public let code: String?
    public let message: String
    public let headers: HTTPFields
    public let body: ResponseBody

    init(status: Int, headers: HTTPFields, body: ResponseBody) {
        // APIs in this family render failures as `{ error, error_description }`, where `error` is a stable category
        // code. Prefer the server's description, then its code, then a plain-text body, then the bare status.
        var code: String?
        var description: String?
        var text: String?
        switch body {
        case .json(.object(let members)):
            if case .string(let error)? = members["error"] {
                code = error
                if case .string(let value)? = members["error_description"] { description = value }
            }
        case .json(.string(let value)) where !value.isEmpty, .text(let value) where !value.isEmpty:
            text = value
        default:
            break
        }
        self.status = status
        self.code = code
        self.message = description ?? code ?? text ?? "HTTP \(status)"
        self.headers = headers
        self.body = body
    }

    public var description: String { message }
}

/// Fetching the server's published OpenAPI document failed, or it isn't one. Shared by every call joining a handshake.
public struct HandshakeError: Error, Sendable, CustomStringConvertible {
    public let message: String
    public let underlying: (any Error & Sendable)?

    init(_ message: String, underlying: (any Error & Sendable)? = nil) {
        self.message = message
        self.underlying = underlying
    }

    public var description: String {
        underlying.map { "\(message): \($0)" } ?? message
    }
}

/// An operation's `version` is read before a handshake succeeds; a call handshakes itself instead.
public struct HandshakeRequiredError: Error, Sendable, CustomStringConvertible {
    public let operationID: String
    public var description: String { "Call handshake() before using \(operationID)" }
}

/// Every way a generated operation call fails.
public enum APIError: Error, Sendable, CustomStringConvertible {
    /// 400: the server rejected the request.
    case validation(HTTPError)
    /// 401: no credentials, or ones the server doesn't accept.
    case notAuthorized(HTTPError)
    /// 403: the credentials don't allow this.
    case forbidden(HTTPError)
    /// 404: the resource doesn't exist, or isn't visible to the caller.
    case notFound(HTTPError)
    /// Any other unsuccessful status.
    case http(HTTPError)
    case handshake(HandshakeError)
    /// The client called a version of an operation that the server doesn't serve.
    case operationVersionUnavailable(operationID: String, requested: Int, negotiated: Int?)
    /// The server changed an operation's version between the handshake and a call, for example during a deploy. The
    /// call wasn't retried, because its arguments were built for the old version; check the operation's `version`.
    case operationVersionChanged(operationID: String, previous: Int, current: Int?)
    /// The transport couldn't send the request, or read its response.
    case transport(any Error & Sendable)
    /// The call took longer than its `RequestOptions.timeout`.
    case timeout(Duration)
    /// The credential provider failed.
    case authenticate(any Error & Sendable)
    /// A parameter couldn't be encoded into the request.
    case encode(name: String, underlying: any Error & Sendable)
    /// A successful response's body didn't match the operation's contract.
    case decode(underlying: any Error & Sendable, body: ResponseBody)

    /// Classify by HTTP status, independently of the server's error-body format.
    static func classify(_ error: HTTPError) -> APIError {
        switch error.status {
        case 400: .validation(error)
        case 401: .notAuthorized(error)
        case 403: .forbidden(error)
        case 404: .notFound(error)
        default: .http(error)
        }
    }

    /// The HTTP failure behind this error, if it is one.
    public var httpError: HTTPError? {
        switch self {
        case .validation(let error), .notAuthorized(let error), .forbidden(let error), .notFound(let error),
            .http(let error):
            error
        default:
            nil
        }
    }

    public var description: String {
        switch self {
        case .validation(let error), .notAuthorized(let error), .forbidden(let error), .notFound(let error),
            .http(let error):
            error.message
        case .handshake(let error): error.description
        case .operationVersionUnavailable(let operationID, let requested, let negotiated):
            if let negotiated {
                "The server does not serve \(operationID) at version \(requested); highest shared version is \(negotiated)"
            } else {
                "The server serves no version of \(operationID) that this client supports"
            }
        case .operationVersionChanged(let operationID, let previous, let current):
            "\(operationID) changed from version \(previous) to \(current.map(String.init) ?? "unsupported") on the server"
        case .transport(let error): "Request failed: \(error)"
        case .timeout(let duration): "Request timed out after \(duration)"
        case .authenticate(let error): "Authentication failed: \(error)"
        case .encode(let name, let error): "Invalid request parameter \(name): \(error)"
        case .decode(let error, _): "Unexpected response body: \(error)"
        }
    }
}
