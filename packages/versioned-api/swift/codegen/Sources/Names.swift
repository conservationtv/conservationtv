// Swift spellings of the names the manifests carry. The names themselves (Params bases, flat fields) are the shared
// ones from operation-params.ts; these only change their case and escape them.

private let keywords: Set<String> = [
    "associatedtype", "class", "deinit", "enum", "extension", "fileprivate", "func", "import", "init", "inout",
    "internal", "let", "open", "operator", "private", "precedencegroup", "protocol", "public", "rethrows", "static",
    "struct", "subscript", "typealias", "var", "break", "case", "catch", "continue", "default", "defer", "do", "else",
    "fallthrough", "for", "guard", "if", "in", "repeat", "return", "throw", "switch", "where", "while", "Any", "as",
    "await", "false", "is", "nil", "super", "throws", "true", "try",
]

/// Names that can't be identifiers even in backticks, or would shadow members every type has.
private let suffixed: Set<String> = ["self", "Self", "Type", "Protocol"]

/// `listMine` is `list`, `Mine`; `path_id` is `path`, `id`; `HTTPServer` is `HTTP`, `Server`.
private func words(_ name: String) -> [String] {
    var words: [String] = []
    var current = ""
    let characters = Array(name)
    for (index, character) in characters.enumerated() {
        guard character.isLetter || character.isNumber, character.isASCII else {
            if !current.isEmpty { words.append(current) }
            current = ""
            continue
        }
        if let last = current.last, character.isUppercase {
            let next = index + 1 < characters.count ? characters[index + 1] : nil
            let boundary = last.isLowercase || last.isNumber || (last.isUppercase && next?.isLowercase == true)
            if boundary {
                words.append(current)
                current = ""
            }
        }
        current.append(character)
    }
    if !current.isEmpty { words.append(current) }
    return words
}

private func capitalized(_ word: String) -> String {
    word.prefix(1).uppercased() + word.dropFirst()
}

/// `organisations.members.list-v1` is `OrganisationsMembersListV1`.
func pascal(_ name: String) -> String {
    let joined = words(name).map(capitalized).joined()
    if joined.isEmpty { return "Value" }
    return joined.first!.isNumber ? "_\(joined)" : joined
}

/// `listMine` stays `listMine`; `path_id` is `pathId`.
func camel(_ name: String) -> String {
    let parts = words(name)
    guard let first = parts.first else { return "value" }
    let joined = first.prefix(1).lowercased() + first.dropFirst() + parts.dropFirst().map(capitalized).joined()
    return joined.first!.isNumber ? "_\(joined)" : joined
}

/// An identifier as it is written in Swift: keywords in backticks, and the few that can't be, suffixed.
func identifier(_ name: String) -> String {
    if suffixed.contains(name) { return "\(name)_" }
    return keywords.contains(name) ? "`\(name)`" : name
}

/// A Swift string literal.
func literal(_ text: String) -> String {
    var output = "\""
    for scalar in text.unicodeScalars {
        switch scalar {
        case "\"": output += "\\\""
        case "\\": output += "\\\\"
        case "\n": output += "\\n"
        case "\r": output += "\\r"
        case "\t": output += "\\t"
        case _ where scalar.value < 0x20: output += "\\u{\(String(scalar.value, radix: 16))}"
        default: output.unicodeScalars.append(scalar)
        }
    }
    return output + "\""
}

/// Documentation comment lines for `text`, so Xcode renders its Markdown as written.
func doc(_ text: String?) -> [String] {
    guard let text, !text.isEmpty else { return [] }
    return text.split(separator: "\n", omittingEmptySubsequences: false).map { $0.isEmpty ? "///" : "/// \($0)" }
}

func indent(_ lines: [String], by prefix: String = "    ") -> [String] {
    lines.map { $0.isEmpty ? $0 : prefix + $0 }
}
