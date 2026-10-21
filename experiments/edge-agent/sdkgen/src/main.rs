// Experiment: can progenitor generate a Rust client straight from the studio API's OpenAPI 3.1 contract?
fn main() -> anyhow::Result<()> {
    let path = std::env::args().nth(1).expect("spec path");
    let text = std::fs::read_to_string(&path)?;
    let spec: openapiv3::OpenAPI = match serde_json::from_str(&text) {
        Ok(spec) => spec,
        Err(error) => anyhow::bail!("openapiv3 could not parse the spec: {error}"),
    };
    let mut generator = progenitor::Generator::default();
    let tokens = generator.generate_tokens(&spec)?;
    let file: syn::File = syn::parse2(tokens)?;
    print!("{}", prettyplease::unparse(&file));
    Ok(())
}
