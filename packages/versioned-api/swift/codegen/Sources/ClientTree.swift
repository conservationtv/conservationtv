/// `.generate/operations.json`: the Client's operation tree, as `readOperations` describes it.
struct Operations {
    /// The current spec's operationIds, in its order.
    let order: [String]
    let versioned: [(operationID: String, version: Int, source: String)]
    let versionless: [String]

    init(_ json: JSON) throws {
        order = (json["order"]?.array ?? []).compactMap(\.string)
        versioned = try (json["versioned"]?.array ?? []).map {
            guard let id = $0["operationId"]?.string, let version = $0["version"]?.int, let source = $0["source"]?.string
            else { throw CodegenError("operations.json: a versioned operation without operationId, version or source") }
            return (id, version, source)
        }
        versionless = (json["versionless"]?.array ?? []).compactMap { $0["operationId"]?.string }
    }
}

private final class Branch {
    /// In the current spec's order.
    var children: [(name: String, branch: Branch)] = []
    var versions: [RenderedOperation] = []
    var versionless: RenderedOperation?

    var isOperation: Bool { !versions.isEmpty || versionless != nil }

    func child(_ name: String) -> Branch {
        if let found = children.first(where: { $0.name == name }) { return found.branch }
        let branch = Branch()
        children.append((name, branch))
        return branch
    }

    func leaf(_ operationID: String) -> Branch {
        operationID.split(separator: ".").reduce(self) { node, part in node.child(String(part)) }
    }
}

private struct Renderer {
    var items: [[String]] = []
    var names = Set<String>()

    mutating func name(_ id: String) throws -> String {
        let name = id.split(separator: ".").map { pascal(String($0)) }.joined()
        guard names.insert(name).inserted else { throw CodegenError("Client type \(name) is generated twice: \(id)") }
        return name
    }

    /// The call a leaf makes: the parameter it takes (if any), how it builds its request, and what it returns.
    static func call(_ operation: RenderedOperation) -> (parameter: String, request: String, response: String) {
        let params = "\(operation.namespace).\(operation.params)"
        return (
            operation.hasParams ? "_ params: \(params)" : "",
            operation.hasParams ? "params.request()" : "\(params)().request()",
            "\(operation.namespace).\(operation.response)"
        )
    }

    /// A versioned operation: a handle with its negotiated version and a `vN` call per version this client has.
    mutating func versioned(_ id: String, _ versions: [RenderedOperation], qualifier: String) throws -> [String] {
        let handle = try name(id)
        let latest = versions.last!
        var item = doc(latest.description) + [
            "public struct \(handle): Sendable {",
            "    public static let operationID = \(literal(id))",
            "    let core: ClientCore",
            "",
            "    /// The versions this client has of the operation. A `switch` over them is exhaustive, so a version added by",
            "    /// regenerating the SDK is a compile error where it isn't handled yet.",
            "    public enum Version: Int, Sendable, CaseIterable {",
        ] + versions.map { "        case v\($0.version!) = \($0.version!)" } + [
            "    }",
            "",
            "    /// The version negotiated with the server, or nil if it serves none of the versions this client has. Throws",
            "    /// before a handshake.",
            "    public var version: Version? {",
            "        get throws(HandshakeRequiredError) { try core.version(of: Self.operationID).flatMap(Version.init(rawValue:)) }",
            "    }",
        ]
        for operation in versions {
            let (parameter, request, response) = Self.call(operation)
            let version = operation.version!
            item += [""] + indent(doc(operation.description)) + [
                "    public func v\(version)(\(parameter)) async throws(APIError) -> \(response) {",
                "        try await core.versioned(Self.operationID, version: \(version), \(request))",
                "    }",
            ]
        }
        items.append(item + ["}"])
        let property = identifier(camel(String(id.split(separator: ".").last!)))
        return doc(latest.description) + ["public var \(property): \(qualifier)\(handle) { \(qualifier)\(handle)(core: core) }"]
    }

    /// The member of a namespace reaching `node`: a property for a namespace or versioned operation, or the call itself
    /// for a versionless one. `qualifier` is how the namespace refers to the `Operations` types.
    mutating func member(_ id: String, _ node: Branch, qualifier: String = "") throws -> [String] {
        let method = identifier(camel(String(id.split(separator: ".").last!)))
        if node.isOperation {
            guard node.children.isEmpty else { throw CodegenError("operationId is also a namespace: \(id)") }
            if let operation = node.versionless {
                let (parameter, request, response) = Self.call(operation)
                return doc(operation.description) + [
                    "public func \(method)(\(parameter)) async throws(APIError) -> \(response) {",
                    "    try await core.versionless(\(request))",
                    "}",
                ]
            }
            return try versioned(id, node.versions, qualifier: qualifier)
        }
        let namespace = try name(id)
        var item = ["/// The `\(id)` operations.", "public struct \(namespace): Sendable {", "    let core: ClientCore"]
        for (part, child) in node.children {
            item += [""] + indent(try member("\(id).\(part)", child))
        }
        items.append(item + ["}"])
        return [
            "/// The `\(id)` operations.",
            "public var \(method): \(qualifier)\(namespace) { \(qualifier)\(namespace)(core: core) }",
        ]
    }
}

/// The Client: the operation tree of every generated namespace, in the current spec's order.
func renderClient(_ operations: Operations, _ rendered: [RenderedOperation]) throws -> String {
    var byVersion: [String: RenderedOperation] = [:]
    for operation in rendered { byVersion["\(operation.operationID)@\(operation.version.map(String.init) ?? "")"] = operation }
    let root = Branch()
    // Create the current spec's operations first, so members follow its order.
    for id in operations.order { _ = root.leaf(id) }
    var supported: [String: [Int]] = [:]
    for (id, version, source) in operations.versioned.sorted(by: { $0.version < $1.version }) {
        guard let found = byVersion["\(id)@\(version)"], found.namespace == "Versions.\(namespaceName(source))" else {
            throw CodegenError("\(id) v\(version) was not generated from \(source)")
        }
        root.leaf(id).versions.append(found)
        supported[id, default: []].append(version)
    }
    for id in operations.versionless {
        guard let found = byVersion["\(id)@"] else { throw CodegenError("\(id) was not generated") }
        root.leaf(id).versionless = found
    }

    var renderer = Renderer()
    var members: [String] = []
    for (part, child) in root.children {
        guard !child.isOperation else { throw CodegenError("Expected resource.action: \(part)") }
        members += [""] + indent(try renderer.member(part, child, qualifier: "Operations."))
    }

    var lines = [
        "// Generated by versioned-api-codegen: the Client's operation tree. Do not edit.",
        "",
        "import Foundation",
        "import VersionedAPIClient",
        "",
        "/// The SDK for servers running any release since the oldest supported snapshot. Versioned calls handshake",
        "/// themselves; call `handshake()` first to read an operation's `version` or to fail early. Copies made with",
        "/// `withOptions` share their negotiation.",
        "public struct Client: Sendable {",
        "    /// The versions this client has of each versioned operation.",
        "    public static let supported: Supported = [",
    ]
    lines += supported.keys.sorted().map { "        \(literal($0)): [\(supported[$0]!.map(String.init).joined(separator: ", "))]," }
    lines += [
        "    ]",
        "",
        "    public let core: ClientCore",
        "",
        "    public init(_ configuration: ClientConfiguration) {",
        "        core = ClientCore(configuration: configuration, supported: Self.supported)",
        "    }",
        "",
        "    init(core: ClientCore) {",
        "        self.core = core",
        "    }",
        "",
        "    /// This client, sharing its negotiation, with `options` applied to every call made through the result.",
        "    public func withOptions(_ options: RequestOptions) -> Client {",
        "        Client(core: core.withOptions(options))",
        "    }",
        "",
        "    /// Reads which versions of each versioned operation the server serves. Call again to refresh.",
        "    public func handshake() async throws(HandshakeError) {",
        "        try await core.handshake()",
        "    }",
    ]
    lines += members
    lines += [
        "}",
        "",
        "/// The Client's namespaces and operation handles, reached from its properties.",
        "public enum Operations {}",
        "",
        "extension Operations {",
    ]
    lines += indent(renderer.items.enumerated().flatMap { index, item in (index > 0 ? [""] : []) + item })
    lines += ["}", ""]
    return lines.joined(separator: "\n")
}
