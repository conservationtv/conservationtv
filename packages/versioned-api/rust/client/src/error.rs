use http::{HeaderMap, StatusCode};
use serde::Deserialize;
use std::sync::Arc;

/// Any error a credential provider ([`crate::Authenticate`]) or other caller-supplied code fails with.
pub type BoxError = Box<dyn std::error::Error + Send + Sync + 'static>;

/// A response body as the transport read it: JSON, text, or nothing.
#[derive(Debug, Clone, PartialEq)]
pub enum ResponseBody {
    Json(serde_json::Value),
    Text(String),
    Empty,
}

impl ResponseBody {
    pub(crate) fn parse(bytes: &[u8]) -> Self {
        if bytes.is_empty() {
            return Self::Empty;
        }
        match serde_json::from_slice(bytes) {
            Ok(value) => Self::Json(value),
            Err(_) => Self::Text(String::from_utf8_lossy(bytes).into_owned()),
        }
    }
}

// APIs in this family render failures as `{ error, error_description }`, where `error` is a stable category code.
#[derive(Deserialize)]
struct ErrorBody {
    error: String,
    error_description: Option<String>,
}

/// An HTTP failure, with the server's status, headers and parsed body available for inspection.
#[derive(Debug, Clone)]
pub struct HttpError {
    pub status: StatusCode,
    /// The server's stable error category, such as `invalid_request`, when it sent one.
    pub code: Option<String>,
    pub message: String,
    pub headers: HeaderMap,
    pub body: ResponseBody,
}

impl HttpError {
    pub(crate) fn new(status: StatusCode, headers: HeaderMap, body: ResponseBody) -> Self {
        // Prefer the server's description, then its code, then a plain-text body, then the bare status.
        let described = match &body {
            ResponseBody::Json(value) => ErrorBody::deserialize(value).ok(),
            _ => None,
        };
        let text = match &body {
            ResponseBody::Json(serde_json::Value::String(text)) | ResponseBody::Text(text)
                if !text.is_empty() =>
            {
                Some(text.clone())
            }
            _ => None,
        };
        let code = described.as_ref().map(|body| body.error.clone());
        let message = described
            .and_then(|body| body.error_description.or(Some(body.error)))
            .or(text)
            .unwrap_or_else(|| format!("HTTP {}", status.as_u16()));
        Self {
            status,
            code,
            message,
            headers,
            body,
        }
    }
}

impl std::fmt::Display for HttpError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

/// Fetching the server's published OpenAPI document failed, or it isn't one. Cloned to every call sharing a handshake.
#[derive(Debug, Clone, thiserror::Error)]
#[error("{message}")]
pub struct HandshakeError {
    pub message: String,
    #[source]
    pub source: Option<Arc<dyn std::error::Error + Send + Sync + 'static>>,
}

impl HandshakeError {
    pub(crate) fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            source: None,
        }
    }

    pub(crate) fn caused(message: impl Into<String>, source: impl Into<BoxError>) -> Self {
        Self {
            message: message.into(),
            source: Some(Arc::from(source.into())),
        }
    }
}

/// An operation's `version()` is read before a handshake succeeds; a call handshakes itself instead.
#[derive(Debug, Clone, thiserror::Error)]
#[error("Call handshake() before using {operation_id}")]
pub struct HandshakeRequiredError {
    pub operation_id: &'static str,
}

/// Every way a generated operation call fails.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    /// 400: the server rejected the request.
    #[error("{0}")]
    Validation(Box<HttpError>),
    /// 401: no credentials, or ones the server doesn't accept.
    #[error("{0}")]
    NotAuthorized(Box<HttpError>),
    /// 403: the credentials don't allow this.
    #[error("{0}")]
    Forbidden(Box<HttpError>),
    /// 404: the resource doesn't exist, or isn't visible to the caller.
    #[error("{0}")]
    NotFound(Box<HttpError>),
    /// Any other unsuccessful status.
    #[error("{0}")]
    Http(Box<HttpError>),
    #[error(transparent)]
    Handshake(#[from] HandshakeError),
    /// The client called a version of an operation that the server doesn't serve.
    #[error("{}", unavailable_message(.operation_id, *.requested, *.negotiated))]
    OperationVersionUnavailable {
        operation_id: &'static str,
        requested: u32,
        negotiated: Option<u32>,
    },
    /// The server changed an operation's version between the handshake and a call, for example during a deploy. The
    /// call wasn't retried, because its arguments were built for the old version; check the operation's `version()`.
    #[error("{operation_id} changed from version {previous} to {} on the server", display_version(*.current))]
    OperationVersionChanged {
        operation_id: &'static str,
        previous: u32,
        current: Option<u32>,
    },
    /// The transport couldn't send the request, or read its response.
    #[error("Request failed: {0}")]
    Transport(#[source] BoxError),
    /// The call took longer than its [`crate::RequestOptions::timeout`].
    #[error("Request timed out after {0:?}")]
    Timeout(std::time::Duration),
    /// The credential provider failed.
    #[error("Authentication failed: {0}")]
    Authenticate(#[source] BoxError),
    /// A parameter couldn't be encoded into the request.
    #[error("Invalid request parameter {name}: {source}")]
    Encode {
        name: &'static str,
        source: serde_json::Error,
    },
    /// A successful response's body didn't match the operation's contract.
    #[error("Unexpected response body: {source}")]
    Decode {
        source: serde_json::Error,
        body: ResponseBody,
    },
}

impl Error {
    /// Classify by HTTP status, independently of the server's error-body format.
    pub(crate) fn http(error: HttpError) -> Self {
        let error = Box::new(error);
        match error.status.as_u16() {
            400 => Self::Validation(error),
            401 => Self::NotAuthorized(error),
            403 => Self::Forbidden(error),
            404 => Self::NotFound(error),
            _ => Self::Http(error),
        }
    }

    /// The HTTP failure behind this error, if it is one.
    pub fn as_http(&self) -> Option<&HttpError> {
        match self {
            Self::Validation(error)
            | Self::NotAuthorized(error)
            | Self::Forbidden(error)
            | Self::NotFound(error)
            | Self::Http(error) => Some(error),
            _ => None,
        }
    }
}

fn display_version(version: Option<u32>) -> String {
    version.map_or_else(|| "unsupported".to_owned(), |version| version.to_string())
}

fn unavailable_message(operation_id: &str, requested: u32, negotiated: Option<u32>) -> String {
    match negotiated {
        None => format!("The server serves no version of {operation_id} that this client supports"),
        Some(negotiated) => format!(
            "The server does not serve {operation_id} at version {requested}; highest shared version is {negotiated}"
        ),
    }
}
