//! A generated version-aware SDK for the conservation.tv studio API: the Rust counterpart of
//! `@conservationtv/studio-sdk`, generated from the same contracts with the same names (see `../ts`).
//!
//! A versioned operation is a handle with a call per version this SDK has (`v1`, `v2`, ...) and the version the server
//! negotiated (`version()`); a versionless one is a plain call.
//!
//! ```no_run
//! # async fn example() -> Result<(), conservationtv_studio_sdk::Error> {
//! use conservationtv_studio_sdk::{Client, ClientConfig, bearer};
//!
//! let client = Client::new(ClientConfig::new("https://studio.example").with_auth(bearer("token")));
//! client.handshake().await?;
//! let account = client.account().get().v1().await?;
//! # Ok(()) }
//! ```
//!
//! Requests go through a [`Transport`]: `reqwest` by default, or any `tower::Service` over `http` types through
//! [`ClientConfig::from_service`], the counterpart of the TypeScript SDK's custom `fetch`. An `iroh_http::Client`
//! sends them over an Iroh connection:
//!
//! ```ignore
//! let iroh = iroh_http::Client::connect(&endpoint, address).await?;
//! let client = Client::new(ClientConfig::from_service(format!("http://{}", iroh.endpoint_id()), iroh));
//! ```

// Formatted by the generator (prettyplease), not rustfmt.
#[rustfmt::skip]
mod generated;

pub use generated::client::{self, Client, SUPPORTED};
pub use generated::{current, versions};
pub use versioned_api_client::{
    Authenticate, BoxError, ClientConfig, Error, HandshakeError, HandshakeRequiredError, HttpError,
    HttpRequest, RequestOptions, ResponseBody, ServiceTransport, Transport, bearer,
};
