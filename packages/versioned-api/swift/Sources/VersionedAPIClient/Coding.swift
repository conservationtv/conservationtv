import Foundation
import HTTPTypes

/// The coders requests and responses go through: dates as ISO 8601 with fractional seconds, as JavaScript writes them.
public enum JSONCoding {
    private static let fractional = Date.ISO8601FormatStyle(includingFractionalSeconds: true)
    private static let whole = Date.ISO8601FormatStyle()

    public static func encoder() -> JSONEncoder {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .custom { date, encoder in
            var container = encoder.singleValueContainer()
            try container.encode(date.formatted(fractional))
        }
        return encoder
    }

    public static func decoder() -> JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { decoder in
            let container = try decoder.singleValueContainer()
            let text = try container.decode(String.self)
            if let date = try? fractional.parse(text) { return date }
            if let date = try? whole.parse(text) { return date }
            throw DecodingError.dataCorruptedError(in: container, debugDescription: "Not an ISO 8601 date-time: \(text)")
        }
        return decoder
    }
}

/// What an operation without a response body returns.
public struct NoContent: Codable, Hashable, Sendable {
    public init() {}
    public init(from decoder: any Decoder) throws {}
    public func encode(to encoder: any Encoder) throws {}
}

func encodeJSON(_ name: String, _ value: some Encodable) throws(APIError) -> JSONValue {
    do {
        let data = try JSONCoding.encoder().encode(value)
        return try JSONDecoder().decode(JSONValue.self, from: data)
    } catch {
        throw .encode(name: name, underlying: error)
    }
}

/// A parameter as its string form: strings as they are, other scalars as JSON, the way the TypeScript SDK sends them.
func scalar(_ value: JSONValue) -> String? {
    switch value {
    case .null: nil
    case .string(let text): text
    default: value.jsonText
    }
}

// Path parameters are encoded like `encodeURIComponent`, as the TypeScript SDK sends them.
private let component = CharacterSet(
    charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.!~*'()")

/// One operation's request, as its generated Params encode it. It is rebuilt into a `URLRequest` for each send, so a
/// version-mismatch retry can send it again.
public struct OperationRequest: Sendable {
    let operationID: String
    let method: HTTPRequest.Method
    var path: String
    var query: [(String, String)] = []
    var headers: [(String, String)] = []
    var body: JSONValue?
    private var fields: [String: JSONValue]?

    /// `path` is the route template, like `/organisations/{id}`.
    public init(_ operationID: String, _ method: HTTPRequest.Method, _ path: String) {
        self.operationID = operationID
        self.method = method
        self.path = path
    }

    public func path(_ name: String, _ value: some Encodable) throws(APIError) -> Self {
        var copy = self
        let text = scalar(try encodeJSON(name, value)) ?? ""
        let encoded = text.addingPercentEncoding(withAllowedCharacters: component) ?? text
        copy.path = copy.path.replacingOccurrences(of: "{\(name)}", with: encoded)
        return copy
    }

    /// Omitted when `value` is nil (an absent optional); arrays repeat the parameter, as `explode` does.
    public func query(_ name: String, _ value: some Encodable) throws(APIError) -> Self {
        var copy = self
        switch try encodeJSON(name, value) {
        case .array(let items):
            copy.query += items.compactMap(scalar).map { (name, $0) }
        case let other:
            if let text = scalar(other) { copy.query.append((name, text)) }
        }
        return copy
    }

    public func header(_ name: String, _ value: some Encodable) throws(APIError) -> Self {
        var copy = self
        if let text = scalar(try encodeJSON(name, value)) { copy.headers.append((name, text)) }
        return copy
    }

    /// One property of an inline object body. `nil` leaves it out; `.some(nil)` of an optional type sends `null`.
    public func bodyField<T: Encodable>(_ name: String, _ value: T?) throws(APIError) -> Self {
        var copy = self
        var fields = copy.fields ?? [:]
        if let value { fields[name] = try encodeJSON(name, value) }
        copy.fields = fields
        return copy
    }

    /// The whole body, for an operation whose body isn't an inline object. `nil` sends none.
    public func body<T: Encodable>(_ name: String, _ value: T?) throws(APIError) -> Self {
        var copy = self
        if let value { copy.body = try encodeJSON(name, value) }
        return copy
    }

    /// Done adding parameters: the request as it will be sent.
    public func finish() -> Self {
        var copy = self
        if let fields = copy.fields {
            copy.body = .object(fields)
            copy.fields = nil
        }
        return copy
    }
}
