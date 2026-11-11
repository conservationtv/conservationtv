import Foundation

/// A JSON value that keeps its objects' member order, which Foundation's parsers don't: the generated types' members
/// follow the contracts' order, and the same manifests always generate the same Swift.
indirect enum JSON: Equatable {
    case null
    case bool(Bool)
    /// Kept as written, so it is written back the same.
    case number(String)
    case string(String)
    case array([JSON])
    case object([Member])

    struct Member: Equatable {
        var key: String
        var value: JSON
    }

    subscript(key: String) -> JSON? {
        guard case .object(let members) = self else { return nil }
        return members.first { $0.key == key }?.value
    }

    var string: String? {
        if case .string(let value) = self { return value }
        return nil
    }

    var array: [JSON]? {
        if case .array(let value) = self { return value }
        return nil
    }

    var members: [Member]? {
        if case .object(let value) = self { return value }
        return nil
    }

    var int: Int? {
        if case .number(let value) = self { return Int(value) }
        return nil
    }

    var bool: Bool? {
        if case .bool(let value) = self { return value }
        return nil
    }

    /// This object with `key` set to `value` (replacing it in place, or appended), or removed when `value` is nil.
    func setting(_ key: String, _ value: JSON?) -> JSON {
        guard case .object(var members) = self else { return self }
        if let index = members.firstIndex(where: { $0.key == key }) {
            if let value { members[index].value = value } else { members.remove(at: index) }
        } else if let value {
            members.append(Member(key: key, value: value))
        }
        return .object(members)
    }

    /// Compact JSON text.
    var text: String {
        var output = ""
        write(to: &output)
        return output
    }

    private func write(to output: inout String) {
        switch self {
        case .null: output += "null"
        case .bool(let value): output += value ? "true" : "false"
        case .number(let value): output += value
        case .string(let value): JSON.quote(value, to: &output)
        case .array(let items):
            output += "["
            for (index, item) in items.enumerated() {
                if index > 0 { output += "," }
                item.write(to: &output)
            }
            output += "]"
        case .object(let members):
            output += "{"
            for (index, member) in members.enumerated() {
                if index > 0 { output += "," }
                JSON.quote(member.key, to: &output)
                output += ":"
                member.value.write(to: &output)
            }
            output += "}"
        }
    }

    private static func quote(_ text: String, to output: inout String) {
        output += "\""
        for scalar in text.unicodeScalars {
            switch scalar {
            case "\"": output += "\\\""
            case "\\": output += "\\\\"
            case "\n": output += "\\n"
            case "\r": output += "\\r"
            case "\t": output += "\\t"
            case _ where scalar.value < 0x20: output += String(format: "\\u%04x", scalar.value)
            default: output.unicodeScalars.append(scalar)
            }
        }
        output += "\""
    }
}

extension JSON {
    struct ParseError: Error, CustomStringConvertible {
        let offset: Int
        let reason: String
        var description: String { "invalid JSON at byte \(offset): \(reason)" }
    }

    init(parsing data: Data) throws {
        var parser = Parser(bytes: [UInt8](data))
        self = try parser.value()
        parser.skipWhitespace()
        guard parser.index == parser.bytes.count else { throw parser.error("trailing content") }
    }

    private struct Parser {
        let bytes: [UInt8]
        var index = 0

        func error(_ reason: String) -> ParseError { ParseError(offset: index, reason: reason) }

        mutating func skipWhitespace() {
            while index < bytes.count, [0x20, 0x0A, 0x0D, 0x09].contains(bytes[index]) { index += 1 }
        }

        mutating func expect(_ literal: String) throws {
            for byte in literal.utf8 {
                guard index < bytes.count, bytes[index] == byte else { throw error("expected \(literal)") }
                index += 1
            }
        }

        mutating func value() throws -> JSON {
            skipWhitespace()
            guard index < bytes.count else { throw error("unexpected end") }
            switch bytes[index] {
            case UInt8(ascii: "{"):
                index += 1
                var members: [Member] = []
                skipWhitespace()
                if index < bytes.count, bytes[index] == UInt8(ascii: "}") {
                    index += 1
                    return .object(members)
                }
                while true {
                    skipWhitespace()
                    let key = try string()
                    skipWhitespace()
                    try expect(":")
                    members.append(Member(key: key, value: try value()))
                    skipWhitespace()
                    guard index < bytes.count else { throw error("unterminated object") }
                    index += 1
                    if bytes[index - 1] == UInt8(ascii: "}") { return .object(members) }
                    guard bytes[index - 1] == UInt8(ascii: ",") else { throw error("expected , or }") }
                }
            case UInt8(ascii: "["):
                index += 1
                var items: [JSON] = []
                skipWhitespace()
                if index < bytes.count, bytes[index] == UInt8(ascii: "]") {
                    index += 1
                    return .array(items)
                }
                while true {
                    items.append(try value())
                    skipWhitespace()
                    guard index < bytes.count else { throw error("unterminated array") }
                    index += 1
                    if bytes[index - 1] == UInt8(ascii: "]") { return .array(items) }
                    guard bytes[index - 1] == UInt8(ascii: ",") else { throw error("expected , or ]") }
                }
            case UInt8(ascii: "\""):
                return .string(try string())
            case UInt8(ascii: "t"):
                try expect("true")
                return .bool(true)
            case UInt8(ascii: "f"):
                try expect("false")
                return .bool(false)
            case UInt8(ascii: "n"):
                try expect("null")
                return .null
            default:
                let start = index
                while index < bytes.count, "+-0123456789.eE".utf8.contains(bytes[index]) { index += 1 }
                guard index > start else { throw error("unexpected character") }
                return .number(String(decoding: bytes[start..<index], as: UTF8.self))
            }
        }

        mutating func hex4() throws -> UInt32 {
            guard index + 4 <= bytes.count,
                let value = UInt32(String(decoding: bytes[index..<index + 4], as: UTF8.self), radix: 16)
            else { throw error("invalid \\u escape") }
            index += 4
            return value
        }

        mutating func string() throws -> String {
            try expect("\"")
            var scalars = String.UnicodeScalarView()
            var run: [UInt8] = []
            func flush() {
                scalars.append(contentsOf: String(decoding: run, as: UTF8.self).unicodeScalars)
                run.removeAll()
            }
            while true {
                guard index < bytes.count else { throw error("unterminated string") }
                let byte = bytes[index]
                index += 1
                switch byte {
                case UInt8(ascii: "\""):
                    flush()
                    return String(scalars)
                case UInt8(ascii: "\\"):
                    flush()
                    guard index < bytes.count else { throw error("unterminated escape") }
                    let escape = bytes[index]
                    index += 1
                    switch escape {
                    case UInt8(ascii: "\""): scalars.append("\"")
                    case UInt8(ascii: "\\"): scalars.append("\\")
                    case UInt8(ascii: "/"): scalars.append("/")
                    case UInt8(ascii: "b"): scalars.append("\u{08}")
                    case UInt8(ascii: "f"): scalars.append("\u{0C}")
                    case UInt8(ascii: "n"): scalars.append("\n")
                    case UInt8(ascii: "r"): scalars.append("\r")
                    case UInt8(ascii: "t"): scalars.append("\t")
                    case UInt8(ascii: "u"):
                        var code = try hex4()
                        if (0xD800..<0xDC00).contains(code) {
                            try expect("\\u")
                            let low = try hex4()
                            code = 0x10000 + ((code - 0xD800) << 10) + (low - 0xDC00)
                        }
                        guard let scalar = Unicode.Scalar(code) else { throw error("invalid code point") }
                        scalars.append(scalar)
                    default:
                        throw error("invalid escape")
                    }
                default:
                    run.append(byte)
                }
            }
        }
    }
}
