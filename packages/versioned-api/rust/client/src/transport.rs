use crate::error::BoxError;
use bytes::Bytes;
use futures_util::future::BoxFuture;
use http_body_util::{BodyExt, Full};

/// How a Client sends its requests, the handshake included: the Rust counterpart of the TypeScript SDK's `fetch`.
/// Requests and responses are `http` types with whole bodies; the runtime adds credentials before calling it and reads
/// the status, headers and body it returns.
///
/// `reqwest::Client` is one (the default, with the `reqwest` feature). Any `tower::Service` over `http` types, such as
/// an `iroh_http::Client` for HTTP over an Iroh connection, becomes one through [`ServiceTransport`].
pub trait Transport: Send + Sync {
    fn send(
        &self,
        request: http::Request<Bytes>,
    ) -> BoxFuture<'_, Result<http::Response<Bytes>, BoxError>>;
}

#[cfg(feature = "reqwest")]
impl Transport for reqwest::Client {
    fn send(
        &self,
        request: http::Request<Bytes>,
    ) -> BoxFuture<'_, Result<http::Response<Bytes>, BoxError>> {
        Box::pin(async move {
            let response = self.execute(reqwest::Request::try_from(request)?).await?;
            let mut received = http::Response::builder()
                .status(response.status())
                .version(response.version());
            if let Some(headers) = received.headers_mut() {
                *headers = response.headers().clone();
            }
            Ok(received.body(response.bytes().await?)?)
        })
    }
}

/// A `tower::Service` over `http` types as a [`Transport`]. Its response body is read whole.
///
/// ```ignore
/// let iroh = iroh_http::Client::connect(&endpoint, address).await?;
/// // Over Iroh only the path is sent; the authority just has to make a valid URL.
/// let config = ClientConfig::from_service(format!("http://{}", iroh.endpoint_id()), iroh);
/// ```
#[derive(Debug, Clone)]
pub struct ServiceTransport<S>(pub S);

impl<S, B> Transport for ServiceTransport<S>
where
    S: tower_service::Service<http::Request<Full<Bytes>>, Response = http::Response<B>>
        + Clone
        + Send
        + Sync,
    S::Future: Send,
    S::Error: Into<BoxError>,
    B: http_body::Body<Data = Bytes> + Send,
    B::Error: Into<BoxError>,
{
    fn send(
        &self,
        request: http::Request<Bytes>,
    ) -> BoxFuture<'_, Result<http::Response<Bytes>, BoxError>> {
        // A clone per call, as tower expects of a shared service: readiness belongs to the handle that is called.
        let mut service = self.0.clone();
        Box::pin(async move {
            futures_util::future::poll_fn(|cx| service.poll_ready(cx))
                .await
                .map_err(Into::into)?;
            let response = service
                .call(request.map(Full::new))
                .await
                .map_err(Into::into)?;
            let (parts, body) = response.into_parts();
            let bytes = body.collect().await.map_err(Into::into)?.to_bytes();
            Ok(http::Response::from_parts(parts, bytes))
        })
    }
}
