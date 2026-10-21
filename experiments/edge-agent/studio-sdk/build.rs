// Generates the studio API's client from spec/openapi.3.0.json, the API's contract down-levelled to OpenAPI 3.0 by
// sdkgen/downlevel.mjs, and the version of each versioned operation, which the hooks send as `Operation-Version`.
use std::{env, fs, path::Path};

use progenitor::{GenerationSettings, Generator, HooksMode};
use quote::quote;

/// progenitor's name for an operation: `reports.submit` is `reports_submit`, `irohSessions.create` is
/// `iroh_sessions_create`.
fn method_name(operation_id: &str) -> String {
    let mut name = String::new();
    for character in operation_id.chars() {
        if character == '.' {
            name.push('_');
        } else if character.is_ascii_uppercase() {
            name.push('_');
            name.push(character.to_ascii_lowercase());
        } else {
            name.push(character);
        }
    }
    name
}

fn main() {
    let spec_path = "spec/openapi.3.0.json";
    println!("cargo:rerun-if-changed={spec_path}");
    let text = fs::read_to_string(spec_path).expect("the down-levelled contract");
    let json: serde_json::Value = serde_json::from_str(&text).expect("JSON");

    let mut versions = Vec::new();
    for item in json["paths"].as_object().expect("paths").values() {
        for operation in item.as_object().expect("path item").values() {
            let (Some(id), Some(version)) = (operation["operationId"].as_str(), operation["x-operation-version"].as_u64())
            else {
                continue;
            };
            versions.push(format!("    (\"{}\", {version}),\n", method_name(id)));
        }
    }
    versions.sort();

    let spec: openapiv3::OpenAPI = serde_json::from_value(json).expect("an OpenAPI 3.0 document");
    let mut settings = GenerationSettings::default();
    settings.with_hooks(HooksMode::Expected).with_inner_type(quote! { crate::Signer });
    let tokens = Generator::new(&settings).generate_tokens(&spec).expect("a client");
    let file: syn::File = syn::parse2(tokens).expect("Rust");

    let out = env::var("OUT_DIR").unwrap();
    fs::write(Path::new(&out).join("client.rs"), prettyplease::unparse(&file)).unwrap();
    fs::write(
        Path::new(&out).join("versions.rs"),
        format!("/// Each versioned operation's version, by progenitor's name for it.\npub const OPERATION_VERSIONS: &[(&str, u32)] = &[\n{}];\n", versions.concat()),
    )
    .unwrap();
}
