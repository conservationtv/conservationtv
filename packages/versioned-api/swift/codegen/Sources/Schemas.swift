// What swift-openapi-generator is given in place of the contracts' schemas. It takes OpenAPI 3.1 schemas as they are,
// with three rewrites for how Zod writes them:
//
// - `X | null` is `anyOf: [X, {type: null}]`, which the generator skips the `null` branch of and then drops the member.
//   A nullable member is made optional instead (`decodeIfPresent`, so null and absent both decode as nil), and a
//   nullable schema elsewhere becomes `type: [T, null]`. A nullable Params field or response is rendered as optional
//   by this generator itself.
//   A schema that is only null becomes an empty one, which is optional wherever it is a member.
// - `z.json()` is a union of every JSON kind that recurses through itself; the generator declares no type for it. An
//   empty schema, which it renders as `OpenAPIValueContainer`, is the same thing.
// - Any other `anyOf` is a union, which the generator renders as a struct of optional branches; its `oneOf` is an enum
//   that takes the first branch that decodes, which is `anyOf`'s meaning for a union (as in the Rust generator).
//   Where each branch fixes the same member to a different value (`driver: "axis"`), the union is given that member as
//   its `discriminator` instead, with each inline branch made a component named after its value (`CameraSettingsAxis`).
//   The generator then names each case after its value (`.axis`), and decodes the branch the value names. A union
//   nothing discriminates has each branch made a component named after what sets it apart (`.ipv4`, `.url`), and the
//   generator's cases for them renamed to match (it names them after the component, `case AddressIpv4`).
//
// Versionless operations have no compatibility guarantees, so their objects keep accepting members the server adds.

private func types(_ schema: JSON) -> [String] {
    switch schema["type"] {
    case .string(let type)?: [type]
    case .array(let items)?: items.compactMap(\.string)
    default: []
    }
}

private func isNull(_ schema: JSON) -> Bool {
    types(schema) == ["null"]
}

/// A union of every JSON kind, like Zod's `z.json()`.
private func isAnyJSON(_ branches: [JSON]) -> Bool {
    let kinds = Set(branches.flatMap(types).map { $0 == "integer" ? "number" : $0 })
    return ["string", "number", "boolean", "array", "object"].allSatisfy(kinds.contains)
}

/// `schema` admitting null too, where the generator has a way to say so.
private func allowingNull(_ schema: JSON) -> JSON {
    guard let type = schema["type"]?.string else { return schema }
    return schema.setting("type", .array([.string(type), .string("null")]))
}

/// The member every branch of a union fixes to a different string (`driver: "axis"`, `driver: "rtsp"`), and each
/// branch's value of it: what the union is discriminated by, and its cases named after.
private func tag(of branches: [JSON], components: [String: JSON]) -> (property: String, values: [String])? {
    let resolved = branches.map { branch in
        branch["$ref"]?.string.flatMap { components[referencedName($0)] } ?? branch
    }
    func constant(_ branch: JSON, _ key: String) -> String? {
        guard branch["required"]?.array?.contains(.string(key)) == true, let property = branch["properties"]?[key]
        else { return nil }
        if let value = property["const"]?.string { return value }
        if case .array(let values)? = property["enum"], values.count == 1 { return values[0].string }
        return nil
    }
    for candidate in resolved.first?["properties"]?.members?.map(\.key) ?? [] {
        let values = resolved.compactMap { constant($0, candidate) }
        if values.count == branches.count, Set(values).count == values.count { return (candidate, values) }
    }
    return nil
}

/// The string a schema fixes a value to, if it does.
private func literal(_ schema: JSON?) -> String? {
    if let value = schema?["const"]?.string { return value }
    if case .array(let values)? = schema?["enum"], values.count == 1 { return values[0].string }
    return nil
}

/// What sets each branch of an untagged union apart, to name its case after: a value only it fixes (`"conservationtv"`,
/// or `protocol: "moq"`), a member only it requires (`url`), its format (`ipv4`), the component it is, or its type.
/// A single branch with none of those is the `other`; more are `variant1`, `variant2`, ...
private func branchNames(_ branches: [JSON], components: [String: JSON]) -> [String] {
    let resolved = branches.map { branch in
        branch["$ref"]?.string.flatMap { components[referencedName($0)] } ?? branch
    }
    func properties(_ schema: JSON) -> [JSON.Member] { schema["properties"]?.members ?? [] }
    let names: [String?] = resolved.enumerated().map { index, schema in
        let others = resolved.enumerated().filter { $0.offset != index }.map(\.element)
        if let value = literal(schema) { return value }
        for property in properties(schema) {
            guard let value = literal(property.value) else { continue }
            if others.allSatisfy({ literal($0["properties"]?[property.key]) != value }) { return value }
        }
        let required = (schema["required"]?.array ?? []).compactMap(\.string)
        if let own = required.first(where: { key in others.allSatisfy { $0["properties"]?[key] == nil } }) {
            return own
        }
        if let format = schema["format"]?.string { return format }
        if let reference = branches[index]["$ref"]?.string { return referencedName(reference) }
        if let type = schema["type"]?.string, type != "object" { return type }
        return nil
    }
    let unnamed = names.filter { $0 == nil }.count
    return names.enumerated().map { index, name in name ?? (unnamed == 1 ? "other" : "variant\(index + 1)") }
}

/// `names`, with repeats suffixed `2`, `3`, ... in order.
private func uniqueNames(_ names: [String]) -> [String] {
    var seen = Set<String>()
    return names.map { name in
        var unique = name
        var n = 2
        while !seen.insert(unique).inserted {
            unique = "\(name)\(n)"
            n += 1
        }
        return unique
    }
}

/// Rewrites one generation's schemas, collecting the components it adds: the branches of tagged unions, which the
/// generator only discriminates when each branch is a component of its own.
struct Normalizer {
    let components: [String: JSON]
    let lenient: Bool
    /// Every component name, the generation's own included, so added ones take names nothing else has.
    var taken: Set<String>
    /// The components added, in the order they were made.
    var added: [JSON.Member] = []
    /// The case each added branch of an untagged union is renamed to: the generator names those cases after the
    /// component exactly (`case GatewayIdUuid`), so they are renamed in what it renders (`case uuid`).
    var caseNames: [String: String] = [:]

    init(components: [String: JSON], lenient: Bool, taken: Set<String>) {
        self.components = components
        self.lenient = lenient
        self.taken = taken.union(components.keys)
    }

    private mutating func unique(_ hint: String) -> String {
        var name = hint
        var n = 2
        while taken.contains(name) {
            name = "\(hint)\(n)"
            n += 1
        }
        taken.insert(name)
        return name
    }

    /// A union whose branches each fix one member to a different value: discriminated by that member, with each inline
    /// branch made a component named after its value, so the generator's enum has a case per value (`.axis`).
    private mutating func discriminated(_ branches: [JSON], hint: String) -> JSON? {
        guard let (property, values) = tag(of: branches, components: components) else { return nil }
        var references: [JSON] = []
        var mapping: [JSON.Member] = []
        for (branch, value) in zip(branches, values) {
            let reference: String
            if let existing = branch["$ref"]?.string {
                reference = existing
            } else {
                let name = unique(hint + pascal(value))
                // Taken before the branch is rewritten, so unions inside it can't take its name.
                let schema = normalize(branch, hint: name).schema
                added.append(.init(key: name, value: schema))
                reference = "#/components/schemas/\(name)"
            }
            references.append(.object([.init(key: "$ref", value: .string(reference))]))
            mapping.append(.init(key: value, value: .string(reference)))
        }
        return .object([
            .init(key: "oneOf", value: .array(references)),
            .init(
                key: "discriminator",
                value: .object([
                    .init(key: "propertyName", value: .string(property)),
                    .init(key: "mapping", value: .object(mapping)),
                ])),
        ])
    }

    /// A union nothing discriminates: each branch made a component named after what sets it apart from the others, so
    /// its case can be too (`.ipv4`, `.ipv6`; `.conservationtv`, `.uuid`; `.url`, `.path`).
    private mutating func untagged(_ branches: [JSON], hint: String) -> JSON {
        let names = uniqueNames(branchNames(branches, components: components))
        var references: [JSON] = []
        for (branch, caseName) in zip(branches, names) {
            let name = unique(hint + pascal(caseName))
            let schema = normalize(branch, hint: name).schema
            added.append(.init(key: name, value: schema))
            caseNames[name] = identifier(camel(caseName))
            references.append(.object([.init(key: "$ref", value: .string("#/components/schemas/\(name)"))]))
        }
        return .object([.init(key: "oneOf", value: .array(references))])
    }

    /// The schema to generate from in place of `schema`, and whether `schema` also admits null. `hint` names what it
    /// adds: the component or schema it is, then `Property`, `Item` or `Value` for each level inside.
    mutating func normalize(_ schema: JSON, hint: String) -> (schema: JSON, nullable: Bool) {
        guard var members = schema.members else { return (schema, false) }
        var nullable = false

        // Only ever null (such as a member a union branch fixes to null): any value, and optional.
        if isNull(schema) {
            return (.object(members.filter { $0.key == "description" }), true)
        }

        // `type: [T, null]` and `enum: [..., null]` are nullable too.
        if case .array(let listed)? = schema["type"], listed.contains(.string("null")) {
            nullable = true
            let rest = listed.filter { $0 != .string("null") }
            let type: JSON = rest.count == 1 ? rest[0] : .array(rest)
            members = JSON.object(members).setting("type", rest.isEmpty ? nil : type).members!
        }
        if case .array(let values)? = schema["enum"], values.contains(.null) {
            nullable = true
            members = JSON.object(members).setting("enum", .array(values.filter { $0 != .null })).members!
        }

        for key in ["anyOf", "oneOf"] {
            guard case .array(let branches)? = JSON.object(members)[key] else { continue }
            let rest = branches.filter { !isNull($0) }
            nullable = nullable || rest.count < branches.count
            let siblings = JSON.object(members.filter { $0.key != key })
            if rest.isEmpty || isAnyJSON(rest) {
                let description = siblings["description"]
                return (description.map { JSON.object([.init(key: "description", value: $0)]) } ?? .object([]), false)
            }
            if rest.count == 1 {
                // The union was only there for the null: what's left is the schema, with the union's description.
                var (inner, innerNullable) = normalize(rest[0], hint: hint)
                if let description = siblings["description"], inner["description"] == nil, inner["$ref"] == nil {
                    inner = inner.setting("description", description)
                }
                return (inner, nullable || innerNullable)
            }
            if let union = discriminated(rest, hint: hint) {
                var result = union
                if let description = siblings["description"] { result = result.setting("description", description) }
                return (result, nullable)
            }
            var result = untagged(rest, hint: hint)
            if let description = siblings["description"] { result = result.setting("description", description) }
            return (result, nullable)
        }

        var result = JSON.object(members)
        if lenient, result["additionalProperties"] == .bool(false) {
            result = result.setting("additionalProperties", nil)
        }
        if let properties = result["properties"]?.members {
            var required = result["required"]?.array ?? []
            var rewritten: [JSON.Member] = []
            for property in properties {
                let (schema, propertyNullable) = normalize(property.value, hint: hint + pascal(property.key))
                if propertyNullable { required.removeAll { $0 == .string(property.key) } }
                rewritten.append(.init(key: property.key, value: schema))
            }
            result = result.setting("properties", .object(rewritten))
            if result["required"] != nil { result = result.setting("required", .array(required)) }
        }
        for (key, suffix) in [("items", "Item"), ("additionalProperties", "Value")] {
            guard let child = result[key], child.members != nil else { continue }
            let (schema, childNullable) = normalize(child, hint: hint + suffix)
            result = result.setting(key, childNullable ? allowingNull(schema) : schema)
        }
        for key in ["allOf", "prefixItems"] {
            guard case .array(let children)? = result[key] else { continue }
            var normalized: [JSON] = []
            for (index, child) in children.enumerated() {
                normalized.append(normalize(child, hint: "\(hint)\(index + 1)").schema)
            }
            result = result.setting(key, .array(normalized))
        }
        return (result, nullable)
    }
}

/// The component name `reference` points at.
func referencedName(_ reference: String) -> String {
    String(reference.split(separator: "/").last ?? "")
        .replacingOccurrences(of: "~1", with: "/")
        .replacingOccurrences(of: "~0", with: "~")
}

/// The component names `schema` refers to, directly or through other components.
func collectRefs(_ schema: JSON?, _ components: [String: JSON], _ found: inout Set<String>) {
    switch schema {
    case .array(let items)?:
        for item in items { collectRefs(item, components, &found) }
    case .object(let members)?:
        if let reference = schema?["$ref"]?.string {
            let name = referencedName(reference)
            if found.insert(name).inserted { collectRefs(components[name], components, &found) }
        }
        for member in members { collectRefs(member.value, components, &found) }
    default:
        break
    }
}
