import Foundation

/// Any JSON value: what a schema without a narrower type decodes as, and how response bodies are kept for inspection.
public enum JSONValue: Codable, Hashable, Sendable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])

    public init(from decoder: any Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let value = try? container.decode(Bool.self) {
            self = .bool(value)
        } else if let value = try? container.decode(Double.self) {
            self = .number(value)
        } else if let value = try? container.decode(String.self) {
            self = .string(value)
        } else if let value = try? container.decode([JSONValue].self) {
            self = .array(value)
        } else {
            self = .object(try container.decode([String: JSONValue].self))
        }
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .null: try container.encodeNil()
        case .bool(let value): try container.encode(value)
        case .number(let value): try container.encode(value)
        case .string(let value): try container.encode(value)
        case .array(let value): try container.encode(value)
        case .object(let value): try container.encode(value)
        }
    }

    /// The value's JSON text: integers without a fraction, as JavaScript writes them.
    public var jsonText: String {
        switch self {
        case .null: "null"
        case .bool(let value): value ? "true" : "false"
        case .number(let value):
            if value.rounded() == value, abs(value) < 9_007_199_254_740_992 {
                String(Int64(value))
            } else {
                "\(value)"
            }
        case .string(let value):
            String(decoding: (try? JSONEncoder().encode(value)) ?? Data(), as: UTF8.self)
        case .array(let items): "[\(items.map(\.jsonText).joined(separator: ","))]"
        case .object(let members):
            "{\(members.sorted { $0.key < $1.key }.map { "\(JSONValue.string($0.key).jsonText):\($0.value.jsonText)" }.joined(separator: ","))}"
        }
    }
}
