use crate::error::{Error, HandshakeError, HandshakeRequiredError, HttpError, ResponseBody};
use crate::request::{ClientConfig, HttpRequest, OperationRequest, RequestOptions};
use bytes::Bytes;
use futures_util::FutureExt;
use futures_util::future::{BoxFuture, Shared};
use http::{HeaderMap, HeaderValue, Method, StatusCode};
use serde::de::DeserializeOwned;
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, PoisonError, RwLock};

// The runtime behind a generated Client. A versioned operation exposes every version the client was generated with
// (`v1`, `v2`, ...) and the version negotiated with the server (`version()`). The server can serve several versions of
// each; `handshake` reads which from the OpenAPI document it publishes. A versionless operation, one the spec gives no
// version, is a plain call: no handshake, no header, and no compatibility guarantees.

pub const OPERATION_VERSION_HEADER: &str = "Operation-Version";

/// Where the API publishes the OpenAPI document it was generated with.
pub const PUBLISHED_DOCUMENT_URL: &str = "/openapi.json";

/// The versions a generated client has of each versioned operation.
pub type Supported = &'static [(&'static str, &'static [u32])];

type PendingHandshake = Shared<BoxFuture<'static, Result<(), HandshakeError>>>;

#[derive(Default)]
struct Negotiation {
    /// Absent until a handshake succeeds.
    negotiated: Option<HashMap<String, u32>>,
    available: HashMap<String, Vec<u32>>,
    /// The entity tag of the document last negotiated against, sent back so an unchanged document costs a 304.
    etag: Option<HeaderValue>,
}

struct Shared_ {
    config: ClientConfig,
    supported: HashMap<&'static str, &'static [u32]>,
    negotiation: RwLock<Negotiation>,
    pending: Mutex<Option<PendingHandshake>>,
}

/// Transport, negotiation and result handling behind a generated Client. Cloning it is cheap, and clones share their
/// negotiation; [`ClientCore::with_options`] makes one whose calls carry extra transport controls.
#[derive(Clone)]
pub struct ClientCore {
    shared: Arc<Shared_>,
    options: Arc<RequestOptions>,
}

/// A raw response: its status and headers, and its body read whole.
struct Received {
    status: StatusCode,
    headers: http::HeaderMap,
    bytes: Bytes,
}

impl ClientCore {
    pub fn new(config: ClientConfig, supported: Supported) -> Self {
        Self {
            shared: Arc::new(Shared_ {
                config,
                supported: supported.iter().copied().collect(),
                negotiation: RwLock::default(),
                pending: Mutex::default(),
            }),
            options: Arc::default(),
        }
    }

    /// This client, sharing its negotiation, with `options` applied to each call made through the result.
    pub fn with_options(&self, options: RequestOptions) -> Self {
        Self {
            shared: Arc::clone(&self.shared),
            options: Arc::new(options),
        }
    }

    /// Reads all versions of each versioned operation the server serves from its published OpenAPI document. Call
    /// before any versioned operation, and again to refresh. A versioned call made before one has succeeded handshakes
    /// itself, joining one in flight, so callers needn't wait for it. Versionless operations don't need it.
    pub async fn handshake(&self) -> Result<(), HandshakeError> {
        // Concurrent calls, including those that hit a version mismatch, share one handshake.
        let pending = {
            let mut pending = self
                .shared
                .pending
                .lock()
                .unwrap_or_else(PoisonError::into_inner);
            match pending.as_ref() {
                Some(handshake) => handshake.clone(),
                None => {
                    let shared = Arc::clone(&self.shared);
                    let handshake = async move {
                        let result = shared.read_published_document().await;
                        *shared
                            .pending
                            .lock()
                            .unwrap_or_else(PoisonError::into_inner) = None;
                        result
                    }
                    .boxed()
                    .shared();
                    *pending = Some(handshake.clone());
                    handshake
                }
            }
        };
        pending.await
    }

    /// The version of `operation_id` negotiated with the server, or `None` if it serves none of the versions this
    /// client has.
    pub fn version_of(
        &self,
        operation_id: &'static str,
    ) -> Result<Option<u32>, HandshakeRequiredError> {
        let negotiation = self
            .shared
            .negotiation
            .read()
            .unwrap_or_else(PoisonError::into_inner);
        let negotiated = negotiation
            .negotiated
            .as_ref()
            .ok_or(HandshakeRequiredError { operation_id })?;
        Ok(negotiated.get(operation_id).copied())
    }

    fn is_available(&self, operation_id: &str, version: u32) -> bool {
        let negotiation = self
            .shared
            .negotiation
            .read()
            .unwrap_or_else(PoisonError::into_inner);
        negotiation
            .available
            .get(operation_id)
            .is_some_and(|versions| versions.contains(&version))
    }

    fn is_negotiated(&self) -> bool {
        self.shared
            .negotiation
            .read()
            .unwrap_or_else(PoisonError::into_inner)
            .negotiated
            .is_some()
    }

    /// Calls `version` of a versioned operation. Refreshes after a protocol rejection, and retries only the same
    /// requested version, once.
    pub async fn versioned<T: DeserializeOwned>(
        &self,
        operation_id: &'static str,
        version: u32,
        request: Result<OperationRequest, Error>,
    ) -> Result<T, Error> {
        let request = request?;
        // Until one succeeds, every call handshakes, joining one in flight; its error becomes this call's result.
        if !self.is_negotiated() {
            self.handshake().await?;
        }
        let negotiated = self.version_of(operation_id).ok().flatten();
        if !self.is_available(operation_id, version) {
            return Err(Error::OperationVersionUnavailable {
                operation_id,
                requested: version,
                negotiated,
            });
        }
        let first = self.send(&request, Some(version)).await?;
        if !mismatched(&first) {
            return outcome(first);
        }
        self.handshake().await?;
        if !self.is_available(operation_id, version) {
            let current = self.version_of(operation_id).ok().flatten();
            return Err(Error::OperationVersionChanged {
                operation_id,
                previous: version,
                current,
            });
        }
        outcome(self.send(&request, Some(version)).await?)
    }

    /// Calls a versionless operation: the same success-body-or-Error result as versioned calls, without negotiation.
    pub async fn versionless<T: DeserializeOwned>(
        &self,
        request: Result<OperationRequest, Error>,
    ) -> Result<T, Error> {
        outcome(self.send(&request?, None).await?)
    }

    async fn send(
        &self,
        request: &OperationRequest,
        version: Option<u32>,
    ) -> Result<Received, Error> {
        let mut target = request.path.clone();
        if !request.query.is_empty() {
            target.push('?');
            target.push_str(
                &form_urlencoded::Serializer::new(String::new())
                    .extend_pairs(&request.query)
                    .finish(),
            );
        }
        // The client's headers, then this call's (replacing the same names), then the operation's own.
        let mut headers = self.shared.config.headers.clone();
        headers.extend(self.options.headers.clone());
        for (name, value) in &request.headers {
            headers.insert(name, value.clone());
        }
        if let Some(version) = version {
            headers.insert(OPERATION_VERSION_HEADER, HeaderValue::from(version));
        }
        let body = match &request.body {
            Some(body) => {
                headers.insert(
                    http::header::CONTENT_TYPE,
                    HeaderValue::from_static("application/json"),
                );
                Bytes::from(serde_json::to_vec(body).map_err(|source| Error::Encode {
                    name: "body",
                    source,
                })?)
            }
            None => Bytes::new(),
        };
        let built = self
            .shared
            .request(request.method.clone(), &target, headers, body)?;
        match self.options.timeout {
            Some(timeout) => tokio::time::timeout(timeout, self.shared.execute(built))
                .await
                .map_err(|_| Error::Timeout(timeout))?,
            None => self.shared.execute(built).await,
        }
    }
}

impl Shared_ {
    /// A request to `target` (a path and query) under the base URL.
    fn request(
        &self,
        method: Method,
        target: &str,
        headers: HeaderMap,
        body: Bytes,
    ) -> Result<HttpRequest, Error> {
        let url = format!("{}{target}", self.config.base_url.trim_end_matches('/'));
        let mut request = http::Request::builder()
            .method(method)
            .uri(url)
            .body(body)
            .map_err(|error| Error::Transport(error.into()))?;
        *request.headers_mut() = headers;
        Ok(request)
    }

    /// Authenticates and sends `request` with the transport, which reads its whole body.
    async fn execute(&self, request: HttpRequest) -> Result<Received, Error> {
        // Credentials are added once the request is complete, for the handshake too.
        let request = match &self.config.auth {
            Some(auth) => auth
                .authenticate(request)
                .await
                .map_err(Error::Authenticate)?,
            None => request,
        };
        let response = self
            .config
            .transport
            .send(request)
            .await
            .map_err(Error::Transport)?;
        let (parts, bytes) = response.into_parts();
        Ok(Received {
            status: parts.status,
            headers: parts.headers,
            bytes,
        })
    }

    /// Fetch and validate the published document, then negotiate every operation against it at once. Once negotiated,
    /// the document is asked for conditionally: a 304 says it is unchanged, so what was negotiated stands.
    async fn read_published_document(&self) -> Result<(), HandshakeError> {
        let conditional = {
            let negotiation = self
                .negotiation
                .read()
                .unwrap_or_else(PoisonError::into_inner);
            negotiation
                .negotiated
                .as_ref()
                .and(negotiation.etag.clone())
        };
        let mut headers = self.config.headers.clone();
        if let Some(etag) = &conditional {
            headers.insert(http::header::IF_NONE_MATCH, etag.clone());
        }
        let received = async {
            self.execute(self.request(
                Method::GET,
                PUBLISHED_DOCUMENT_URL,
                headers,
                Bytes::new(),
            )?)
            .await
        }
        .await
        .map_err(|error| HandshakeError::caused("Handshake failed", error))?;
        if conditional.is_some() && received.status == StatusCode::NOT_MODIFIED {
            return Ok(());
        }
        let failed = || {
            format!(
                "GET {PUBLISHED_DOCUMENT_URL} failed ({})",
                received.status.as_u16()
            )
        };
        if !received.status.is_success() {
            let body = ResponseBody::parse(&received.bytes);
            let error = HttpError::new(received.status, received.headers.clone(), body);
            return Err(HandshakeError::caused(failed(), Error::http(error)));
        }
        let document: serde_json::Value = serde_json::from_slice(&received.bytes)
            .map_err(|error| HandshakeError::caused(failed(), error))?;
        let (negotiated, available) = negotiate(&document, &self.supported)?;
        let mut negotiation = self
            .negotiation
            .write()
            .unwrap_or_else(PoisonError::into_inner);
        negotiation.negotiated = Some(negotiated);
        negotiation.available = available;
        negotiation.etag = received.headers.get(http::header::ETAG).cloned();
        Ok(())
    }
}

/// A 412 that names `Operation-Version` is the server rejecting the version selected, not the request.
fn mismatched(received: &Received) -> bool {
    received.status == StatusCode::PRECONDITION_FAILED
        && received.headers.contains_key(OPERATION_VERSION_HEADER)
}

/// Unsuccessful statuses become HTTP errors; a successful body is decoded as the operation's response, with no body
/// (such as a 204's) decoding as `null`, which `()` and `Option` accept.
fn outcome<T: DeserializeOwned>(received: Received) -> Result<T, Error> {
    if !received.status.is_success() {
        let body = ResponseBody::parse(&received.bytes);
        return Err(Error::http(HttpError::new(
            received.status,
            received.headers,
            body,
        )));
    }
    let bytes: &[u8] = if received.bytes.is_empty() {
        b"null"
    } else {
        &received.bytes
    };
    serde_json::from_slice(bytes).map_err(|source| Error::Decode {
        source,
        body: ResponseBody::parse(&received.bytes),
    })
}

const METHODS: [&str; 8] = [
    "get", "put", "post", "delete", "patch", "options", "head", "trace",
];

/// Validate the advertised set; a legacy document advertises only its described version.
fn served_versions(
    operation_id: &str,
    operation: &serde_json::Value,
) -> Result<Vec<u32>, HandshakeError> {
    let invalid = || HandshakeError::new(format!("Invalid served versions for {operation_id}"));
    let version = |value: &serde_json::Value| {
        value
            .as_u64()
            .filter(|&n| n > 0)
            .and_then(|n| u32::try_from(n).ok())
    };
    let described = match operation.get("x-operation-version") {
        None => None,
        Some(value) => Some(version(value).ok_or_else(invalid)?),
    };
    let served = match operation.get("x-operation-versions") {
        None => described.into_iter().collect(),
        Some(values) => {
            let values = values
                .as_array()
                .filter(|values| !values.is_empty())
                .ok_or_else(invalid)?;
            values
                .iter()
                .map(|value| version(value).ok_or_else(invalid))
                .collect::<Result<Vec<_>, _>>()?
        }
    };
    let unique = served.iter().collect::<HashSet<_>>().len() == served.len();
    if !served.is_empty()
        && (described.is_none_or(|described| !served.contains(&described)) || !unique)
    {
        return Err(invalid());
    }
    Ok(served)
}

type Negotiated = (HashMap<String, u32>, HashMap<String, Vec<u32>>);

/// Negotiate each operation independently, retaining all shared versions for explicit `vN` calls.
fn negotiate(
    document: &serde_json::Value,
    supported: &HashMap<&'static str, &'static [u32]>,
) -> Result<Negotiated, HandshakeError> {
    let not_a_document = || {
        HandshakeError::new(format!(
            "GET {PUBLISHED_DOCUMENT_URL} returned no OpenAPI paths"
        ))
    };
    let paths = document
        .get("paths")
        .and_then(serde_json::Value::as_object)
        .ok_or_else(not_a_document)?;
    let mut negotiated = HashMap::new();
    let mut available = HashMap::new();
    let mut seen = HashSet::new();
    for item in paths.values() {
        let item = item.as_object().ok_or_else(not_a_document)?;
        for operation in METHODS.iter().filter_map(|method| item.get(*method)) {
            let operation_id = operation
                .get("operationId")
                .and_then(serde_json::Value::as_str)
                .ok_or_else(|| HandshakeError::new("Published operation without an operationId"))?;
            // Each logical operation is unique; preserve all intersections and choose the highest as the default.
            if !seen.insert(operation_id.to_owned()) {
                return Err(HandshakeError::new(format!(
                    "Duplicate operationId: {operation_id}"
                )));
            }
            let ours = supported.get(operation_id).copied().unwrap_or_default();
            let mut shared: Vec<u32> = served_versions(operation_id, operation)?
                .into_iter()
                .filter(|version| ours.contains(version))
                .collect();
            shared.sort_unstable();
            if let Some(&highest) = shared.last() {
                negotiated.insert(operation_id.to_owned(), highest);
            }
            available.insert(operation_id.to_owned(), shared);
        }
    }
    Ok((negotiated, available))
}
