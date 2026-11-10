use heck::{ToPascalCase, ToSnakeCase};
use proc_macro2::{Ident, Span, TokenStream};
use quote::quote;

/// `listMine` is `list_mine`; flat names that are already snake case, like `path_id`, stay as they are.
pub fn snake(name: &str) -> String {
    name.to_snake_case()
}

pub fn pascal(name: &str) -> String {
    name.to_pascal_case()
}

/// An identifier, raw where the name is a keyword (`r#type`); `self`, `super` and `crate` can't be, so are suffixed.
pub fn ident(name: &str) -> Ident {
    match name {
        "self" | "super" | "crate" | "Self" => Ident::new(&format!("{name}_"), Span::call_site()),
        _ if syn::parse_str::<Ident>(name).is_ok() => Ident::new(name, Span::call_site()),
        _ => Ident::new_raw(name, Span::call_site()),
    }
}

/// A source's module: `organisations.members.list-v1` is `organisations_members_list_v1`.
pub fn module_name(source: &str) -> String {
    source
        .split(['.', '-'])
        .map(snake)
        .collect::<Vec<_>>()
        .join("_")
}

/// Doc attributes for `text`, a line each, so rustdoc renders its Markdown as written.
pub fn doc(text: &str) -> TokenStream {
    let lines = text.lines().map(|line| format!(" {line}"));
    quote!(#(#[doc = #lines])*)
}
