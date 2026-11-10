use crate::contract::{RenderedOperation, Result};
use crate::manifest::Operations;
use crate::names::{doc, ident, module_name, pascal, snake};
use proc_macro2::TokenStream;
use quote::{format_ident, quote};
use std::collections::{BTreeMap, HashMap, HashSet};

#[derive(Default)]
struct Branch<'a> {
    /// In the current spec's order.
    children: Vec<(String, Branch<'a>)>,
    versions: Vec<&'a RenderedOperation>,
    versionless: Option<&'a RenderedOperation>,
}

impl<'a> Branch<'a> {
    fn child(&mut self, part: &str) -> &mut Branch<'a> {
        let index = match self.children.iter().position(|(name, _)| name == part) {
            Some(index) => index,
            None => {
                self.children.push((part.to_owned(), Branch::default()));
                self.children.len() - 1
            }
        };
        &mut self.children[index].1
    }

    fn leaf(&mut self, operation_id: &str) -> &mut Branch<'a> {
        operation_id
            .split('.')
            .fold(self, |node, part| node.child(part))
    }

    fn is_operation(&self) -> bool {
        !self.versions.is_empty() || self.versionless.is_some()
    }
}

fn path(module: &[String], name: &str) -> TokenStream {
    let segments = module.iter().map(|segment| ident(segment));
    let name = format_ident!("{name}");
    quote!(super::#(#segments::)*#name)
}

struct Renderer {
    items: Vec<TokenStream>,
    names: HashSet<String>,
}

impl Renderer {
    fn name(&mut self, id: &str) -> Result<proc_macro2::Ident> {
        let name = id.split('.').map(pascal).collect::<String>();
        if !self.names.insert(name.clone()) {
            return Err(format!("Client type {name} is generated twice: {id}"));
        }
        Ok(format_ident!("{name}"))
    }

    /// The call a leaf makes: the params it takes (if any), and the type it returns.
    fn call(operation: &RenderedOperation) -> (TokenStream, TokenStream, TokenStream) {
        let params = path(&operation.module, &operation.params);
        let response = path(&operation.module, &operation.response);
        if operation.has_params {
            (quote!(params: #params), quote!(params.request()), response)
        } else {
            (quote!(), quote!(#params::default().request()), response)
        }
    }

    /// A versioned operation: a handle with its negotiated version and a `vN` call per version this client has.
    fn versioned(&mut self, id: &str, versions: &[&RenderedOperation]) -> Result<TokenStream> {
        let handle = self.name(id)?;
        let latest = versions.last().expect("a versioned operation has versions");
        let docs = doc(&latest.description);
        let calls = versions.iter().map(|operation| {
            let version = operation.version.expect("versioned");
            let method = format_ident!("v{version}");
            let (parameter, request, response) = Self::call(operation);
            let docs = doc(&operation.description);
            quote!(
                #docs
                pub async fn #method(&self, #parameter) -> ::std::result::Result<#response, ::versioned_api_client::Error> {
                    self.core.versioned(Self::OPERATION_ID, #version, #request).await
                }
            )
        });
        self.items.push(quote!(
            #docs
            #[derive(Clone, Copy)]
            pub struct #handle<'a> {
                core: &'a ::versioned_api_client::ClientCore,
            }

            impl<'a> #handle<'a> {
                pub const OPERATION_ID: &'static str = #id;

                /// The version negotiated with the server, or `None` if it serves none of the versions this client
                /// has. Errors before a handshake.
                pub fn version(&self) -> ::std::result::Result<::std::option::Option<u32>, ::versioned_api_client::HandshakeRequiredError> {
                    self.core.version_of(Self::OPERATION_ID)
                }

                #(#calls)*
            }
        ));
        let method = ident(&snake(id.rsplit('.').next().unwrap_or(id)));
        Ok(quote!(
            #docs
            pub fn #method(&self) -> #handle<'a> {
                #handle { core: self.core }
            }
        ))
    }

    /// The member of `parent` reaching `branch`: an accessor for a namespace or versioned operation, or the call
    /// itself for a versionless one.
    fn member(&mut self, id: &str, branch: &Branch<'_>) -> Result<TokenStream> {
        if branch.is_operation() {
            if !branch.children.is_empty() {
                return Err(format!("operationId is also a namespace: {id}"));
            }
            if let Some(operation) = branch.versionless {
                let method = ident(&snake(id.rsplit('.').next().unwrap_or(id)));
                let (parameter, request, response) = Self::call(operation);
                let docs = doc(&operation.description);
                return Ok(quote!(
                    #docs
                    pub async fn #method(&self, #parameter) -> ::std::result::Result<#response, ::versioned_api_client::Error> {
                        self.core.versionless(#request).await
                    }
                ));
            }
            return self.versioned(id, &branch.versions);
        }
        let namespace = self.name(id)?;
        let members = branch
            .children
            .iter()
            .map(|(part, child)| self.member(&format!("{id}.{part}"), child))
            .collect::<Result<Vec<_>>>()?;
        let docs = doc(&format!("The `{id}` operations."));
        self.items.push(quote!(
            #docs
            #[derive(Clone, Copy)]
            pub struct #namespace<'a> {
                core: &'a ::versioned_api_client::ClientCore,
            }

            impl<'a> #namespace<'a> {
                #(#members)*
            }
        ));
        let method = ident(&snake(id.rsplit('.').next().unwrap_or(id)));
        Ok(quote!(
            #docs
            pub fn #method(&self) -> #namespace<'a> {
                #namespace { core: self.core }
            }
        ))
    }
}

/// The Client: the operation tree of every contract module, in the current spec's order.
pub fn render(operations: &Operations, rendered: &[RenderedOperation]) -> Result<TokenStream> {
    let by_version: HashMap<(&str, Option<u32>), &RenderedOperation> = rendered
        .iter()
        .map(|operation| {
            (
                (operation.operation_id.as_str(), operation.version),
                operation,
            )
        })
        .collect();
    let mut root = Branch::default();
    // Create the current spec's operations first, so members follow its order.
    for operation_id in &operations.order {
        root.leaf(operation_id);
    }
    let mut supported: BTreeMap<&str, Vec<u32>> = BTreeMap::new();
    let mut versioned = operations.versioned.iter().collect::<Vec<_>>();
    versioned.sort_by_key(|operation| operation.version);
    for operation in versioned {
        let found = by_version
            .get(&(operation.operation_id.as_str(), Some(operation.version)))
            .filter(|found| found.module.last() == Some(&module_name(&operation.source)))
            .ok_or_else(|| {
                format!(
                    "{} v{} was not generated from {}",
                    operation.operation_id, operation.version, operation.source
                )
            })?;
        root.leaf(&operation.operation_id).versions.push(found);
        supported
            .entry(&operation.operation_id)
            .or_default()
            .push(operation.version);
    }
    for operation in &operations.versionless {
        let found = by_version
            .get(&(operation.operation_id.as_str(), None))
            .ok_or_else(|| format!("{} was not generated", operation.operation_id))?;
        root.leaf(&operation.operation_id).versionless = Some(found);
    }

    let mut renderer = Renderer {
        items: Vec::new(),
        names: HashSet::new(),
    };
    let mut members = Vec::new();
    for (part, child) in &root.children {
        if child.is_operation() {
            return Err(format!("Expected resource.action: {part}"));
        }
        let namespace = renderer.name(part)?;
        let inner = child
            .children
            .iter()
            .map(|(name, grandchild)| renderer.member(&format!("{part}.{name}"), grandchild))
            .collect::<Result<Vec<_>>>()?;
        let docs = doc(&format!("The `{part}` operations."));
        renderer.items.push(quote!(
            #docs
            #[derive(Clone, Copy)]
            pub struct #namespace<'a> {
                core: &'a ::versioned_api_client::ClientCore,
            }

            impl<'a> #namespace<'a> {
                #(#inner)*
            }
        ));
        let method = ident(&snake(part));
        members.push(quote!(
            #docs
            pub fn #method(&self) -> #namespace<'_> {
                #namespace { core: &self.core }
            }
        ));
    }

    let supported = supported
        .iter()
        .map(|(id, versions)| quote!((#id, &[#(#versions),*])));
    let items = renderer.items;
    Ok(quote!(
        #![doc = " Generated by versioned-api-codegen: the Client's operation tree. Do not edit."]
        #![allow(clippy::all, clippy::pedantic)]

        /// The versions this client has of each versioned operation.
        pub const SUPPORTED: ::versioned_api_client::Supported = &[#(#supported),*];

        /// The SDK for servers running any release since the oldest supported snapshot. Versioned calls handshake
        /// themselves; call `handshake()` first to read `version()` or to fail early. Cloning it is cheap, and clones
        /// share their negotiation.
        #[derive(Clone)]
        pub struct Client {
            core: ::versioned_api_client::ClientCore,
        }

        impl Client {
            pub fn new(config: ::versioned_api_client::ClientConfig) -> Self {
                Self { core: ::versioned_api_client::ClientCore::new(config, SUPPORTED) }
            }

            /// This client, sharing its negotiation, with `options` applied to every call made through the result.
            pub fn with_options(&self, options: ::versioned_api_client::RequestOptions) -> Self {
                Self { core: self.core.with_options(options) }
            }

            /// Reads which versions of each versioned operation the server serves. Call again to refresh.
            pub async fn handshake(&self) -> ::std::result::Result<(), ::versioned_api_client::HandshakeError> {
                self.core.handshake().await
            }

            pub fn core(&self) -> &::versioned_api_client::ClientCore {
                &self.core
            }

            #(#members)*
        }

        #(#items)*
    ))
}
