use serde::Deserialize;

/// The current spec's versionless operations are generated from this source; frozen contracts from `<id>-vN`.
pub const CURRENT: &str = "current";

/// `.generate/operations.json`: the Client's operation tree, as `readOperations` describes it.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Operations {
    /// The current spec's operationIds, in its order.
    pub order: Vec<String>,
    pub versioned: Vec<VersionedOperation>,
    pub versionless: Vec<VersionlessOperation>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionedOperation {
    pub operation_id: String,
    pub version: u32,
    pub source: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionlessOperation {
    pub operation_id: String,
}

/// `.generate/manifests/<source>.json`, written by the `rust-manifest` Hey API plugin.
#[derive(Debug, Deserialize)]
pub struct Manifest {
    pub source: String,
    pub operations: Vec<ManifestOperation>,
    pub document: serde_json::Value,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManifestOperation {
    pub operation_id: String,
    pub version: Option<u32>,
    pub method: String,
    pub path: String,
    /// The Params name base, like `GrantExchange`, before any version suffix.
    pub base: String,
    pub description: String,
    pub fields: Vec<Field>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Location {
    Header,
    Path,
    Query,
    Body,
}

/// One flat Params member, named as every SDK generator names it (`flatFields` in operation-params.ts).
#[derive(Debug, Deserialize)]
pub struct Field {
    /// The parameter or body property name on the wire.
    pub key: String,
    pub location: Location,
    pub required: bool,
    pub description: Option<String>,
    /// Whether this is the whole (non-object) body.
    #[serde(default)]
    pub whole: bool,
    /// The flat name: `key`, or `<location>_<key>` where keys repeat across locations.
    pub name: String,
}
