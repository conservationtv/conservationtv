use crate::manifest::{CURRENT, Field, Location, Manifest, ManifestOperation};
use crate::names::{doc, ident, module_name, pascal, snake};
use proc_macro2::TokenStream;
use quote::{format_ident, quote};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet, HashSet};
use typify::{TypeDetails, TypeSpace, TypeSpaceSettings};

pub type Result<T> = std::result::Result<T, String>;

/// One operation as a generated contract module exposes it to the Client.
#[derive(Debug)]
pub struct RenderedOperation {
    pub operation_id: String,
    pub version: Option<u32>,
    pub description: String,
    /// The module under `generated`, like `versions::account_get_v1`.
    pub module: Vec<String>,
    pub params: String,
    pub has_params: bool,
    pub response: String,
}

/// A generated module: the contract's types (by typify), and each operation's flat Params and response alias.
pub struct RenderedContract {
    pub module: String,
    pub tokens: TokenStream,
    pub operations: Vec<RenderedOperation>,
}

fn is_null(schema: &Value) -> bool {
    schema.get("type").and_then(Value::as_str) == Some("null")
}

/// Frozen contracts are exact, so their types reject what they don't describe. Versionless operations have no
/// compatibility guarantees, so their types keep accepting fields the server adds.
///
/// Zod renders unions as `anyOf`. typify renders a non-nullable `anyOf` as a struct of optional flattened branches,
/// which can't be a path parameter and loses which branch a value is; its `oneOf` is an untagged enum, which takes the
/// first branch that matches: exactly `anyOf`'s meaning for a union. `anyOf` with a null branch is left to typify,
/// which renders it as an `Option`.
fn normalize(schema: &Value, lenient: bool) -> Value {
    match schema {
        Value::Object(object) => Value::Object(
            object
                .iter()
                .filter(|(key, value)| {
                    !(lenient
                        && key.as_str() == "additionalProperties"
                        && **value == Value::Bool(false))
                })
                .map(|(key, value)| {
                    let union = key == "anyOf"
                        && !object.contains_key("oneOf")
                        && value.as_array().is_some_and(|branches| {
                            branches.len() > 1 && !branches.iter().any(is_null)
                        });
                    (
                        if union {
                            "oneOf".to_owned()
                        } else {
                            key.clone()
                        },
                        normalize(value, lenient),
                    )
                })
                .collect(),
        ),
        Value::Array(items) => {
            Value::Array(items.iter().map(|item| normalize(item, lenient)).collect())
        }
        other => other.clone(),
    }
}

/// The component schema names `schema` refers to, directly or through other components.
fn collect_refs(
    schema: &Value,
    components: &serde_json::Map<String, Value>,
    found: &mut BTreeSet<String>,
) {
    match schema {
        Value::Object(object) => {
            if let Some(Value::String(reference)) = object.get("$ref") {
                let name = reference
                    .rsplit('/')
                    .next()
                    .unwrap_or_default()
                    .replace("~1", "/")
                    .replace("~0", "~");
                if found.insert(name.clone())
                    && let Some(target) = components.get(&name)
                {
                    collect_refs(target, components, found);
                }
            }
            for value in object.values() {
                collect_refs(value, components, found);
            }
        }
        Value::Array(items) => items
            .iter()
            .for_each(|item| collect_refs(item, components, found)),
        _ => {}
    }
}

struct Located<'a> {
    item: &'a Value,
    operation: &'a Value,
}

fn locate<'a>(document: &'a Value, operation: &ManifestOperation) -> Result<Located<'a>> {
    let item = document
        .pointer(&format!(
            "/paths/{}",
            operation.path.replace('~', "~0").replace('/', "~1")
        ))
        .ok_or_else(|| format!("{}: no path {}", operation.operation_id, operation.path))?;
    let found = item.get(&operation.method).ok_or_else(|| {
        format!(
            "{}: no {} {}",
            operation.operation_id, operation.method, operation.path
        )
    })?;
    Ok(Located {
        item,
        operation: found,
    })
}

fn parameter_schema<'a>(located: &Located<'a>, field: &Field) -> Result<&'a Value> {
    let location = match field.location {
        Location::Header => "header",
        Location::Path => "path",
        Location::Query => "query",
        Location::Body => unreachable!(),
    };
    // Operation parameters override path-item ones of the same name and location.
    [located.operation, located.item]
        .iter()
        .filter_map(|owner| owner.get("parameters").and_then(Value::as_array))
        .flatten()
        .find(|parameter| {
            parameter.get("in").and_then(Value::as_str) == Some(location)
                && parameter
                    .get("name")
                    .and_then(Value::as_str)
                    .is_some_and(|name| name.eq_ignore_ascii_case(&field.key))
        })
        .and_then(|parameter| parameter.get("schema"))
        .ok_or_else(|| format!("no {location} parameter {}", field.key))
}

fn body_schema<'a>(located: &Located<'a>) -> Result<&'a Value> {
    located
        .operation
        .pointer("/requestBody/content/application~1json/schema")
        .ok_or_else(|| "a body field without a JSON request body".to_owned())
}

/// The lowest 2xx response's JSON schema, or `None` for one without content (such as a 204).
fn success_schema<'a>(located: &Located<'a>, operation_id: &str) -> Result<Option<&'a Value>> {
    let responses = located
        .operation
        .get("responses")
        .and_then(Value::as_object)
        .ok_or_else(|| format!("{operation_id}: no responses"))?;
    let success = responses
        .iter()
        .filter(|(status, _)| status.starts_with('2'))
        .min_by_key(|(status, _)| status.as_str())
        .ok_or_else(|| format!("{operation_id}: no success response"))?
        .1;
    if success
        .get("content")
        .is_some_and(|content| content.get("application/json").is_none())
    {
        return Err(format!("{operation_id}: only JSON responses are supported"));
    }
    Ok(success.pointer("/content/application~1json/schema"))
}

fn schema(value: &Value, lenient: bool) -> Result<schemars::schema::Schema> {
    serde_json::from_value(normalize(value, lenient))
        .map_err(|error| format!("unreadable schema: {error}"))
}

fn http_method(method: &str) -> Result<TokenStream> {
    let name = match method {
        "get" => "GET",
        "put" => "PUT",
        "post" => "POST",
        "delete" => "DELETE",
        "patch" => "PATCH",
        "options" => "OPTIONS",
        "head" => "HEAD",
        "trace" => "TRACE",
        other => return Err(format!("unsupported method {other}")),
    };
    let name = format_ident!("{name}");
    Ok(quote!(::versioned_api_client::http::Method::#name))
}

struct RenderedField {
    member: TokenStream,
    argument: Option<TokenStream>,
    initializer: TokenStream,
    encode: TokenStream,
}

pub fn render(manifest: &Manifest) -> Result<RenderedContract> {
    let versioned = manifest.source != CURRENT;
    let lenient = !versioned;
    let document = &manifest.document;
    let empty = serde_json::Map::new();
    let components = document
        .pointer("/components/schemas")
        .and_then(Value::as_object)
        .unwrap_or(&empty);

    // Only the components these operations use, like the TypeScript SDK's `orphans: false`.
    let mut used = BTreeSet::new();
    for operation in &manifest.operations {
        let located = locate(document, operation)?;
        for owner in [located.operation, located.item] {
            if let Some(parameters) = owner.get("parameters") {
                collect_refs(parameters, components, &mut used);
            }
        }
        if let Some(body) = located.operation.get("requestBody") {
            collect_refs(body, components, &mut used);
        }
        if let Some(success) = success_schema(&located, &operation.operation_id)? {
            collect_refs(success, components, &mut used);
        }
    }

    let mut settings = TypeSpaceSettings::default();
    settings
        .with_struct_builder(false)
        .with_derive("PartialEq".to_owned());
    let mut space = TypeSpace::new(&settings);
    let definitions = used
        .iter()
        .map(|name| {
            let value = components
                .get(name)
                .ok_or_else(|| format!("{}: no component {name}", manifest.source))?;
            Ok((
                name.clone(),
                schema(value, lenient).map_err(|error| format!("{name}: {error}"))?,
            ))
        })
        .collect::<Result<Vec<_>>>()?;
    space
        .add_ref_types(definitions)
        .map_err(|error| format!("{}: {error}", manifest.source))?;

    let module = module_name(&manifest.source);
    let mut declared = BTreeMap::new();
    let mut items = Vec::new();
    let mut operations = Vec::new();
    for operation in &manifest.operations {
        let id = &operation.operation_id;
        let located = locate(document, operation)?;
        let suffix = match (versioned, operation.version) {
            (true, Some(version)) => format!("V{version}"),
            _ => String::new(),
        };
        let params = format!("{}{suffix}Params", operation.base);
        let response = format!("{}{suffix}Response", operation.base);
        for name in [&params, &response] {
            if let Some(previous) = declared.insert(name.clone(), id.clone()) {
                return Err(format!("Name collision: {name}\n  {previous}\n  {id}"));
            }
        }

        let mut members = HashSet::new();
        let mut fields = Vec::new();
        for field in &operation.fields {
            let member = snake(&field.name);
            if !members.insert(member.clone()) {
                return Err(format!("{id}: flat fields {member} collide in Rust"));
            }
            let source = match (field.location, field.whole) {
                (Location::Body, true) => body_schema(&located)?,
                (Location::Body, false) => body_schema(&located)?
                    .pointer(&format!(
                        "/properties/{}",
                        field.key.replace('~', "~0").replace('/', "~1")
                    ))
                    .ok_or_else(|| format!("{id}: no body property {}", field.key))?,
                _ => parameter_schema(&located, field).map_err(|error| format!("{id}: {error}"))?,
            };
            let hint = format!("{}{suffix}{}", operation.base, pascal(&field.name));
            let type_id = space
                .add_type_with_name(&schema(source, lenient)?, Some(hint))
                .map_err(|error| format!("{id}.{}: {error}", field.name))?;
            let ty = space
                .get_type(&type_id)
                .map_err(|error| error.to_string())?;
            let nullable = matches!(ty.details(), TypeDetails::Option(_));
            let ty = ty.ident();
            // An optional body member may also be nullable: absent (`None`) and null (`Some(None)`) mean different things.
            let optional = !field.required && (field.location == Location::Body || !nullable);
            let member_ident = ident(&member);
            let key = &field.key;
            let docs = doc(field.description.as_deref().unwrap_or_default());
            let member_ty = if optional {
                quote!(::std::option::Option<#ty>)
            } else {
                ty.clone()
            };
            let encode = match (field.location, field.whole) {
                (Location::Body, whole) => {
                    let method = if whole {
                        quote!(body)
                    } else {
                        quote!(body_field)
                    };
                    if optional {
                        quote!(.#method(#key, &self.#member_ident)?)
                    } else {
                        quote!(.#method(#key, &::std::option::Option::Some(&self.#member_ident))?)
                    }
                }
                (Location::Path, _) => quote!(.path(#key, &self.#member_ident)?),
                (Location::Query, _) => quote!(.query(#key, &self.#member_ident)?),
                (Location::Header, _) => quote!(.header(#key, &self.#member_ident)?),
            };
            fields.push(RenderedField {
                member: quote!(#docs pub #member_ident: #member_ty,),
                argument: (!optional).then(|| quote!(#member_ident: #ty)),
                initializer: if optional {
                    quote!(#member_ident: ::std::option::Option::None,)
                } else {
                    quote!(#member_ident,)
                },
                encode,
            });
        }

        let response_ty = match success_schema(&located, id)? {
            None => quote!(()),
            Some(success) => {
                let type_id = space
                    .add_type_with_name(&schema(success, lenient)?, Some(response.clone()))
                    .map_err(|error| format!("{id} response: {error}"))?;
                space
                    .get_type(&type_id)
                    .map_err(|error| error.to_string())?
                    .ident()
            }
        };
        let response_ident = format_ident!("{response}");
        if response_ty.to_string() != response {
            items.push(quote!(
                #[doc = concat!("What a successful `", #id, "` returns.")]
                pub type #response_ident = #response_ty;
            ));
        }

        let params_ident = format_ident!("{params}");
        let method = http_method(&operation.method)?;
        let path = &operation.path;
        let docs = doc(&format!(
            "The parameters of `{id}`{}.",
            operation
                .version
                .map(|v| format!(" v{v}"))
                .unwrap_or_default()
        ));
        let members = fields.iter().map(|field| &field.member);
        let arguments = fields.iter().filter_map(|field| field.argument.as_ref());
        let initializers = fields.iter().map(|field| &field.initializer);
        let encodes = fields.iter().map(|field| &field.encode);
        let derive_default = fields.iter().all(|field| field.argument.is_none());
        let default = derive_default.then(|| quote!(Default,));
        items.push(quote!(
            #docs
            #[derive(Debug, Clone, PartialEq, #default)]
            pub struct #params_ident { #(#members)* }

            impl #params_ident {
                /// With every required member; the optional ones start unset.
                #[allow(clippy::too_many_arguments)]
                pub fn new(#(#arguments),*) -> Self {
                    Self { #(#initializers)* }
                }

                #[doc(hidden)]
                pub fn request(&self) -> ::std::result::Result<::versioned_api_client::OperationRequest, ::versioned_api_client::Error> {
                    ::std::result::Result::Ok(
                        ::versioned_api_client::OperationRequest::new(#method, #path)
                            #(#encodes)*
                            .finish()
                    )
                }
            }
        ));

        operations.push(RenderedOperation {
            operation_id: id.clone(),
            version: if versioned { operation.version } else { None },
            description: operation.description.clone(),
            module: if versioned {
                vec!["versions".to_owned(), module.clone()]
            } else {
                vec![module.clone()]
            },
            params,
            has_params: !operation.fields.is_empty(),
            response,
        });
    }

    for name in declared.keys() {
        if space
            .iter_types()
            .any(|ty| ty.name() == *name && !name.ends_with("Response"))
        {
            return Err(format!(
                "{}: a schema is also named {name}",
                manifest.source
            ));
        }
    }

    let types = space.to_stream();
    let header = format!(
        " Generated by versioned-api-codegen from the `{}` {}. Do not edit.",
        manifest.source,
        if versioned {
            "operation contract"
        } else {
            "spec's versionless operations"
        }
    );
    let tokens = quote!(
        #![doc = #header]
        #![allow(clippy::all, clippy::pedantic, unused_imports, irrefutable_let_patterns)]
        #types
        #(#items)*
    );
    Ok(RenderedContract {
        module,
        tokens,
        operations,
    })
}
