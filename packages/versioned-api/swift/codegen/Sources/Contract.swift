import Foundation
import _OpenAPIGeneratorCore

/// The current spec's versionless operations are generated from this source; frozen contracts from `<id>-vN`.
let currentSource = "current"

struct CodegenError: Error, CustomStringConvertible {
    let description: String
    init(_ description: String) { self.description = description }
}

/// One operation as a generated namespace exposes it to the Client.
struct RenderedOperation {
    let operationID: String
    let version: Int?
    let description: String
    /// The namespace its types are declared in, like `Versions.AccountGetV1`.
    let namespace: String
    let params: String
    let hasParams: Bool
    let response: String
}

struct RenderedContract {
    /// The namespace's name: the file's name under `Versions/`, or `Current`.
    let name: String
    let source: String
    let versioned: Bool
    let swift: String
    let operations: [RenderedOperation]
}

/// A source's namespace: `organisations.members.list-v1` is `OrganisationsMembersListV1`.
func namespaceName(_ source: String) -> String {
    source == currentSource ? "Current" : pascal(source)
}

/// One flat Params member, named as every SDK generator names it (`flatFields` in operation-params.ts).
private struct Field {
    let key: String
    let location: String
    let required: Bool
    let description: String?
    /// Whether this is the whole (non-object) body.
    let whole: Bool
    /// The flat name: `key`, or `<location>_<key>` where keys repeat across locations.
    let name: String

    init(_ json: JSON) throws {
        guard let key = json["key"]?.string, let location = json["location"]?.string, let name = json["name"]?.string
        else { throw CodegenError("a manifest field without key, location or name") }
        self.key = key
        self.location = location
        self.required = json["required"]?.bool ?? false
        self.description = json["description"]?.string
        self.whole = json["whole"]?.bool ?? false
        self.name = name
    }
}

/// `.generate/manifests/<source>.json`'s operations, written by the `rust-manifest` Hey API plugin.
private struct ManifestOperation {
    let operationID: String
    let version: Int?
    let method: String
    let path: String
    /// The Params name base, like `GrantExchange`, before any version suffix.
    let base: String
    let description: String
    let fields: [Field]
    let item: JSON
    let operation: JSON

    init(_ json: JSON, document: JSON) throws {
        guard let operationID = json["operationId"]?.string, let method = json["method"]?.string,
            let path = json["path"]?.string, let base = json["base"]?.string
        else { throw CodegenError("a manifest operation without operationId, method, path or base") }
        self.operationID = operationID
        self.version = json["version"]?.int
        self.method = method
        self.path = path
        self.base = base
        self.description = json["description"]?.string ?? ""
        self.fields = try (json["fields"]?.array ?? []).map(Field.init)
        guard let item = document["paths"]?[path], let operation = item[method] else {
            throw CodegenError("\(operationID): no \(method) \(path)")
        }
        self.item = item
        self.operation = operation
    }

    func parameterSchema(_ field: Field) throws -> JSON {
        // Operation parameters override path-item ones of the same name and location.
        for owner in [operation, item] {
            let found = owner["parameters"]?.array?.first {
                $0["in"]?.string == field.location && $0["name"]?.string?.lowercased() == field.key.lowercased()
            }
            if let schema = found?["schema"] { return schema }
        }
        throw CodegenError("\(operationID): no \(field.location) parameter \(field.key)")
    }

    func bodySchema() throws -> JSON {
        guard let schema = operation["requestBody"]?["content"]?["application/json"]?["schema"] else {
            throw CodegenError("\(operationID): a body field without a JSON request body")
        }
        return schema
    }

    /// The lowest 2xx response's JSON schema, or nil for one without content (such as a 204).
    func successSchema() throws -> JSON? {
        guard let responses = operation["responses"]?.members else { throw CodegenError("\(operationID): no responses") }
        guard let success = responses.filter({ $0.key.hasPrefix("2") }).min(by: { $0.key < $1.key })?.value else {
            throw CodegenError("\(operationID): no success response")
        }
        if let content = success["content"], content.members != nil, content["application/json"] == nil {
            throw CodegenError("\(operationID): only JSON responses are supported")
        }
        return success["content"]?["application/json"]?["schema"]
    }
}

/// Collects the generator's diagnostics: anything it couldn't generate is an error here, not a member left out.
private final class Diagnostics: DiagnosticCollector, @unchecked Sendable {
    var problems: [Diagnostic] = []

    func emit(_ diagnostic: Diagnostic) throws {
        if diagnostic.severity != .note { problems.append(diagnostic) }
    }
}

/// The `Components` namespace of a file swift-openapi-generator rendered. The rest (the empty `APIProtocol`,
/// `Servers` and `Operations`, with no paths to generate them from) is left behind.
private func generatedComponents(of generated: String, source: String) throws -> [String] {
    let lines = generated.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
    guard let start = lines.firstIndex(of: "public enum Components {"),
        let end = lines[start...].firstIndex(of: "}")
    else { throw CodegenError("\(source): swift-openapi-generator rendered no Components") }
    var first = start
    while first > 0, lines[first - 1].hasPrefix("///") { first -= 1 }
    return Array(lines[first...end])
}

/// Where a hoisted schema's Swift type goes until it is known: the type it aliases, or its declaration.
private func hoisted(_ name: String) -> String { "<hoisted:\(name)>" }

/// A hoisted schema the generator rendered as a typealias (a string, an array, another component) is spelled as what
/// it aliases, so Params members read as `String?` rather than `Components.Schemas.AccountUpdateV1Name?`.
private func resolveHoisted(_ lines: [String], types: [String]) -> [String] {
    var aliases: [String: String] = [:]
    let prefix = "        public typealias "
    for line in types where line.hasPrefix(prefix) {
        let parts = line.dropFirst(prefix.count).split(separator: " = ", maxSplits: 1)
        if parts.count == 2 { aliases[String(parts[0])] = String(parts[1]) }
    }
    return lines.map { line in
        var line = line
        while let start = line.range(of: "<hoisted:"), let end = line[start.upperBound...].firstIndex(of: ">") {
            let name = String(line[start.upperBound..<end])
            line.replaceSubrange(start.lowerBound...end, with: aliases[name] ?? "Components.Schemas.\(name)")
        }
        return line
    }
}

/// The generator names an untagged union's cases after their components exactly (`case GatewayIdUuid(...)`); these
/// are the components the rewrite made, so its names for them are used instead: in the declaration (`case uuid(`),
/// and where the generated decoding and encoding refer to them (`self = .uuid(`, `case let .uuid(`).
private func renameCases(_ generated: String, _ caseNames: [String: String]) -> String {
    var result = generated
    for (component, caseName) in caseNames {
        let escaped = NSRegularExpression.escapedPattern(for: component)
        let declaration = try! NSRegularExpression(pattern: "(?<=\\bcase )\(escaped)(?=\\(Components\\.Schemas\\.\(escaped)\\))")
        let reference = try! NSRegularExpression(pattern: "(?<=[ (])\\.\(escaped)(?=\\()")
        let template = NSRegularExpression.escapedTemplate(for: caseName)
        var range = NSRange(result.startIndex..., in: result)
        result = declaration.stringByReplacingMatches(in: result, range: range, withTemplate: template)
        range = NSRange(result.startIndex..., in: result)
        result = reference.stringByReplacingMatches(in: result, range: range, withTemplate: "." + template)
    }
    return result
}

/// A generated file: the contract's types, by swift-openapi-generator, and each operation's flat Params and response.
func renderContract(_ manifest: JSON) throws -> RenderedContract {
    guard let source = manifest["source"]?.string, let document = manifest["document"] else {
        throw CodegenError("a manifest without source or document")
    }
    let versioned = source != currentSource
    let lenient = !versioned
    let componentList = document["components"]?["schemas"]?.members ?? []
    let components = Dictionary(componentList.map { ($0.key, $0.value) }, uniquingKeysWith: { first, _ in first })
    let operations = try (manifest["operations"]?.array ?? []).map { try ManifestOperation($0, document: document) }
    let name = namespaceName(source)
    let qualified = versioned ? "Versions.\(name)" : name

    // Only the components these operations use, like the TypeScript SDK's `orphans: false`.
    var used = Set<String>()
    for operation in operations {
        for owner in [operation.operation, operation.item] { collectRefs(owner["parameters"], components, &used) }
        collectRefs(operation.operation["requestBody"], components, &used)
        collectRefs(try operation.successSchema(), components, &used)
    }

    // Each Params field and response is also a schema of its own, under the name its Swift type takes in
    // `Components.Schemas`, so the generator renders it with everything else. Those names are taken before anything
    // is rewritten, so the components the rewrite adds can't take them.
    var schemaNames = Set(components.keys)
    for operation in operations {
        let suffix = versioned ? operation.version.map { "V\($0)" } ?? "" : ""
        var names = operation.fields.map { ("\(operation.base)\(suffix)\(pascal($0.name))", "\(operation.operationID).\($0.name)") }
        if try operation.successSchema() != nil { names.append(("\(operation.base)\(suffix)Response", operation.operationID)) }
        for (name, what) in names {
            guard schemaNames.insert(name).inserted else {
                throw CodegenError("\(what): the schema name \(name) is generated twice")
            }
        }
    }
    var normalizer = Normalizer(components: components, lenient: lenient, taken: schemaNames)
    var schemas = componentList.filter { used.contains($0.key) }.map {
        JSON.Member(key: $0.key, value: normalizer.normalize($0.value, hint: pascal($0.key)).schema)
    }
    var overrides: [String: String] = [:]
    func hoist(_ name: String, _ schema: JSON) -> Bool {
        let (normalized, nullable) = normalizer.normalize(schema, hint: name)
        schemas.append(.init(key: name, value: normalized))
        overrides[name] = name
        return nullable
    }

    // Params and Response names are the shared ones, declared in the namespace.
    var claimed = Set<String>()
    func claim(_ name: String, _ what: String) throws {
        guard claimed.insert(name).inserted else { throw CodegenError("\(what): the name \(name) is generated twice") }
    }

    var items: [[String]] = []
    var rendered: [RenderedOperation] = []
    for operation in operations {
        let id = operation.operationID
        let suffix = versioned ? operation.version.map { "V\($0)" } ?? "" : ""
        let params = "\(operation.base)\(suffix)Params"
        let response = "\(operation.base)\(suffix)Response"
        try claim(params, id)
        try claim(response, id)

        var members = Set<String>()
        var fields: [(field: Field, member: String, type: String, optional: Bool)] = []
        for field in operation.fields {
            let member = identifier(camel(field.name))
            guard members.insert(member).inserted else { throw CodegenError("\(id): flat fields \(member) collide in Swift") }
            let schema: JSON
            switch (field.location, field.whole) {
            case ("body", true): schema = try operation.bodySchema()
            case ("body", false):
                guard let property = try operation.bodySchema()["properties"]?[field.key] else {
                    throw CodegenError("\(id): no body property \(field.key)")
                }
                schema = property
            default: schema = try operation.parameterSchema(field)
            }
            let typeName = "\(operation.base)\(suffix)\(pascal(field.name))"
            let nullable = hoist(typeName, schema)
            let type = hoisted(typeName) + (nullable ? "?" : "")
            // An optional body member may also be nullable: absent (nil) and null (`.some(nil)`) mean different things.
            let optional = !field.required && (field.location == "body" || !nullable)
            fields.append((field, member, optional ? "\(type)?" : type, optional))
        }

        if let success = try operation.successSchema() {
            let nullable = hoist(response, success)
            items.append([
                "/// What a successful `\(id)` returns.",
                "public typealias \(response) = \(hoisted(response))\(nullable ? "?" : "")",
            ])
        } else {
            items.append(["/// What a successful `\(id)` returns: no body.", "public typealias \(response) = NoContent"])
        }

        let encodes = fields.map { field, member, _, optional in
            let key = literal(field.key)
            if field.location == "body" {
                return ".\(field.whole ? "body" : "bodyField")(\(key), \(optional ? member : "Optional(\(member))"))"
            }
            return ".\(field.location)(\(key), \(member))"
        }
        var item = ["/// The parameters of `\(id)`\(operation.version.map { " v\($0)" } ?? "").", "public struct \(params): Hashable, Sendable {"]
        for (field, member, type, _) in fields {
            item += indent(doc(field.description))
            item.append("    public var \(member): \(type)")
        }
        if !fields.isEmpty { item.append("") }
        let arguments = fields.map { "\($0.member): \($0.type)\($0.optional ? " = nil" : "")" }
        item.append("    public init(\(arguments.joined(separator: ", "))) {")
        item += fields.map { "        self.\($0.member) = \($0.member)" }
        item += [
            "    }",
            "",
            "    func request() throws(APIError) -> OperationRequest {",
            "        \(fields.isEmpty ? "" : "try ")OperationRequest(\(literal(id)), .\(operation.method), \(literal(operation.path)))",
        ]
        item += encodes.map { "            \($0)" }
        item += ["            .finish()", "    }", "}"]
        items.append(item)

        rendered.append(
            RenderedOperation(
                operationID: id, version: versioned ? operation.version : nil, description: operation.description,
                namespace: qualified, params: params, hasParams: !fields.isEmpty, response: response))
    }

    // The union branches the rewrite made components of, under the names it gave them.
    schemas += normalizer.added
    for added in normalizer.added { overrides[added.key] = added.key }

    let synthetic = JSON.object([
        .init(key: "openapi", value: .string("3.1.0")),
        .init(key: "info", value: .object([.init(key: "title", value: .string(source)), .init(key: "version", value: .string("1"))])),
        .init(key: "paths", value: .object([])),
        .init(key: "components", value: .object([.init(key: "schemas", value: .object(schemas))])),
    ])
    let diagnostics = Diagnostics()
    let output = try runGenerator(
        input: InMemoryInputFile(absolutePath: URL(fileURLWithPath: "/\(source).json"), contents: Data(synthetic.text.utf8)),
        config: Config(mode: .types, access: .public, namingStrategy: .idiomatic, nameOverrides: overrides),
        diagnostics: diagnostics)
    if !diagnostics.problems.isEmpty {
        throw CodegenError("\(source):\n" + diagnostics.problems.map { "  \($0)" }.joined(separator: "\n"))
    }
    let generated = renameCases(String(decoding: output.contents, as: UTF8.self), normalizer.caseNames)
    let types = try generatedComponents(of: generated, source: source)

    let header =
        versioned
        ? "// Generated by versioned-api-codegen from the `\(source)` operation contract, with swift-openapi-generator. Do not edit."
        : "// Generated by versioned-api-codegen from the current spec's versionless operations, with swift-openapi-generator. Do not edit."
    let namespace =
        versioned
        ? ["extension Versions {", "    /// The `\(source)` operation contract.", "    public enum \(name) {}", "}"]
        : ["/// The current spec's versionless operations: no compatibility guarantees.", "public enum \(name) {}"]
    let body = types + resolveHoisted(items.flatMap { [""] + $0 }, types: types)
    let lines =
        [header, "", "@_spi(Generated) import OpenAPIRuntime", "import Foundation", "import VersionedAPIClient", ""]
        + namespace + ["", "extension \(qualified) {"] + indent(body) + ["}", ""]
    return RenderedContract(
        name: name, source: source, versioned: versioned, swift: lines.joined(separator: "\n"), operations: rendered)
}
