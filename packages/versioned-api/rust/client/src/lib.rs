//! The runtime behind generated version-aware Rust SDKs: the Rust counterpart of
//! `@conservationtv/versioned-api/client`. A generated `Client` wraps a [`ClientCore`]; each versioned operation calls
//! [`ClientCore::versioned`] with the version the caller chose, and each versionless one [`ClientCore::versionless`].

mod core;
mod error;
mod request;
mod transport;

pub use crate::core::{ClientCore, OPERATION_VERSION_HEADER, PUBLISHED_DOCUMENT_URL, Supported};
pub use crate::error::{
    BoxError, Error, HandshakeError, HandshakeRequiredError, HttpError, ResponseBody,
};
pub use crate::request::{
    Authenticate, ClientConfig, HttpRequest, OperationRequest, RequestOptions, bearer,
};
pub use crate::transport::{ServiceTransport, Transport};
pub use bytes;
pub use http;
#[cfg(feature = "reqwest")]
pub use reqwest;
