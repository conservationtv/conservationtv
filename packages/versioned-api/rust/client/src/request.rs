use crate::error::{BoxError, Error};
use crate::transport::{ServiceTransport, Transport};
use bytes::Bytes;
use futures_util::future::BoxFuture;
use http::{HeaderMap, HeaderName, HeaderValue, Method};
use percent_encoding::{AsciiSet, NON_ALPHANUMERIC, utf8_percent_encode};
use serde::Serialize;
use std::sync::Arc;
use std::time::Duration;

/// A request as it is sent: the runtime's own representation, with its whole body.
pub type HttpRequest = http::Request<Bytes>;

/// How a Client authenticates: given each request as it is about to be sent, with every header and its body, return it
/// with credentials added. [`bearer`] sends a token; an API's SDK may offer others, such as signing.
pub trait Authenticate: Send + Sync {
    fn authenticate(&self, request: HttpRequest) -> BoxFuture<'_, Result<HttpRequest, BoxError>>;
}

impl<F> Authenticate for F
where
    F: Fn(HttpRequest) -> BoxFuture<'static, Result<HttpRequest, BoxError>> + Send + Sync,
{
    fn authenticate(&self, request: HttpRequest) -> BoxFuture<'_, Result<HttpRequest, BoxError>> {
        self(request)
    }
}

struct Bearer(HeaderValue);

impl Authenticate for Bearer {
    fn authenticate(
        &self,
        mut request: HttpRequest,
    ) -> BoxFuture<'_, Result<HttpRequest, BoxError>> {
        request
            .headers_mut()
            .insert(http::header::AUTHORIZATION, self.0.clone());
        Box::pin(std::future::ready(Ok(request)))
    }
}

/// Send `token` as `Authorization: Bearer …`.
///
/// # Panics
///
/// If `token` contains characters a header value can't.
pub fn bearer(token: impl AsRef<str>) -> impl Authenticate {
    let mut value = HeaderValue::try_from(format!("Bearer {}", token.as_ref()))
        .expect("a bearer token is a header value");
    value.set_sensitive(true);
    Bearer(value)
}

/// The options a Client accepts: the base URL and transport controls. Response and error handling are the runtime's.
#[derive(Clone)]
pub struct ClientConfig {
    /// Where requests are sent: the scheme and authority (and any base path) operation paths are appended to.
    pub base_url: String,
    /// What sends each request: `reqwest` by default, or any [`Transport`].
    pub transport: Arc<dyn Transport>,
    /// Headers sent with every request, the handshake included.
    pub headers: HeaderMap,
    pub auth: Option<Arc<dyn Authenticate>>,
}

impl ClientConfig {
    /// Send with a new `reqwest::Client`.
    #[cfg(feature = "reqwest")]
    pub fn new(base_url: impl Into<String>) -> Self {
        Self::from_transport(base_url, reqwest::Client::new())
    }

    /// Send with `transport`: a configured `reqwest::Client`, or any other [`Transport`].
    pub fn from_transport(
        base_url: impl Into<String>,
        transport: impl Transport + 'static,
    ) -> Self {
        Self {
            base_url: base_url.into(),
            transport: Arc::new(transport),
            headers: HeaderMap::new(),
            auth: None,
        }
    }

    /// Send with a `tower::Service` over `http` types, such as an `iroh_http::Client`: the TypeScript SDK's custom
    /// `fetch`.
    pub fn from_service<S>(base_url: impl Into<String>, service: S) -> Self
    where
        ServiceTransport<S>: Transport,
        S: 'static,
    {
        Self::from_transport(base_url, ServiceTransport(service))
    }

    pub fn with_headers(mut self, headers: HeaderMap) -> Self {
        self.headers = headers;
        self
    }

    pub fn with_auth(mut self, auth: impl Authenticate + 'static) -> Self {
        self.auth = Some(Arc::new(auth));
        self
    }
}

impl std::fmt::Debug for ClientConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ClientConfig")
            .field("base_url", &self.base_url)
            .field("headers", &self.headers)
            .field("auth", &self.auth.as_ref().map(|_| ".."))
            .finish_non_exhaustive()
    }
}

/// Per-call transport controls, for the calls made through [`crate::ClientCore::with_options`].
#[derive(Debug, Clone, Default)]
pub struct RequestOptions {
    /// Headers added to (and replacing the same names of) the client's own.
    pub headers: HeaderMap,
    /// How long a call may take, retries and its own handshake aside, before it fails with [`Error::Timeout`].
    pub timeout: Option<Duration>,
}

// Path parameters are encoded like `encodeURIComponent`, as the TypeScript SDK sends them.
const COMPONENT: &AsciiSet = &NON_ALPHANUMERIC
    .remove(b'-')
    .remove(b'_')
    .remove(b'.')
    .remove(b'!')
    .remove(b'~')
    .remove(b'*')
    .remove(b'\'')
    .remove(b'(')
    .remove(b')');

/// One operation's request, as its generated Params encode it. It is rebuilt into an HTTP request for each send, so a
/// version-mismatch retry can send it again.
#[derive(Debug, Clone)]
pub struct OperationRequest {
    pub(crate) method: Method,
    pub(crate) path: String,
    pub(crate) query: Vec<(String, String)>,
    pub(crate) headers: Vec<(HeaderName, HeaderValue)>,
    pub(crate) body: Option<serde_json::Value>,
    fields: Option<serde_json::Map<String, serde_json::Value>>,
}

/// A parameter as its string form: strings as they are, other scalars as JSON, the way the TypeScript SDK sends them.
fn scalar(name: &'static str, value: &impl Serialize) -> Result<Option<String>, Error> {
    let value = serde_json::to_value(value).map_err(|source| Error::Encode { name, source })?;
    Ok(match value {
        serde_json::Value::Null => None,
        serde_json::Value::String(text) => Some(text),
        other => Some(other.to_string()),
    })
}

impl OperationRequest {
    /// `path` is the route template, like `/organisations/{id}`.
    pub fn new(method: Method, path: &str) -> Self {
        Self {
            method,
            path: path.to_owned(),
            query: Vec::new(),
            headers: Vec::new(),
            body: None,
            fields: None,
        }
    }

    pub fn path(mut self, name: &'static str, value: &impl Serialize) -> Result<Self, Error> {
        let text = scalar(name, value)?.unwrap_or_default();
        let encoded = utf8_percent_encode(&text, COMPONENT).to_string();
        self.path = self.path.replace(&format!("{{{name}}}"), &encoded);
        Ok(self)
    }

    /// Omitted when `value` serializes as null (an absent optional); arrays repeat the parameter, as `explode` does.
    pub fn query(mut self, name: &'static str, value: &impl Serialize) -> Result<Self, Error> {
        let json = serde_json::to_value(value).map_err(|source| Error::Encode { name, source })?;
        match json {
            serde_json::Value::Array(items) => {
                for item in items {
                    if let Some(text) = scalar(name, &item)? {
                        self.query.push((name.to_owned(), text));
                    }
                }
            }
            other => {
                if let Some(text) = scalar(name, &other)? {
                    self.query.push((name.to_owned(), text));
                }
            }
        }
        Ok(self)
    }

    pub fn header(mut self, name: &'static str, value: &impl Serialize) -> Result<Self, Error> {
        if let Some(text) = scalar(name, value)? {
            let invalid = |error: &dyn std::fmt::Display| Error::Encode {
                name,
                source: <serde_json::Error as serde::ser::Error>::custom(error.to_string()),
            };
            let header =
                HeaderName::from_bytes(name.as_bytes()).map_err(|error| invalid(&error))?;
            let value = HeaderValue::try_from(text).map_err(|error| invalid(&error))?;
            self.headers.push((header, value));
        }
        Ok(self)
    }

    /// One property of an inline object body. `Option::None` leaves it out; `Some(None)` sends `null`.
    pub fn body_field<T: Serialize>(
        mut self,
        name: &'static str,
        value: &Option<T>,
    ) -> Result<Self, Error> {
        let fields = self.fields.get_or_insert_default();
        if let Some(value) = value {
            let json =
                serde_json::to_value(value).map_err(|source| Error::Encode { name, source })?;
            fields.insert(name.to_owned(), json);
        }
        Ok(self)
    }

    /// The whole body, for an operation whose body isn't an inline object. `None` sends none.
    pub fn body<T: Serialize>(
        mut self,
        name: &'static str,
        value: &Option<T>,
    ) -> Result<Self, Error> {
        if let Some(value) = value {
            self.body =
                Some(serde_json::to_value(value).map_err(|source| Error::Encode { name, source })?);
        }
        Ok(self)
    }

    /// Done adding parameters: the request as it will be sent.
    pub fn finish(mut self) -> Self {
        if let Some(fields) = self.fields.take() {
            self.body = Some(serde_json::Value::Object(fields));
        }
        self
    }
}
