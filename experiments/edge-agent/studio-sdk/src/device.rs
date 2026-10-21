//! Acting as a device, as the studio API's device operations require (apps/studio/api/src/middleware/device.ts): an
//! RFC 9421 HTTP Message Signature by the device's Ed25519 identity, named by its public ID, over the method, the URL,
//! an RFC 9530 `Content-Digest` of the body and its content type, with `created`, `expires` and a single-use `nonce`.
//! The same signature `DeviceIdentity.sign` in `@conservationtv/studio-sdk` makes, labelled `sig1`.

use std::time::{SystemTime, UNIX_EPOCH};

use base64::{Engine, engine::general_purpose::STANDARD};
use ed25519_dalek::{Signer, SigningKey};
use reqwest::header::HeaderValue;
use sha2::{Digest, Sha256};

/// How long a signature is valid for: the API accepts signatures up to a minute old.
const LIFETIME_SECONDS: u64 = 60;

/// A device's identity: its Ed25519 key pair, as the studio API and iroh both know it.
#[derive(Clone)]
pub struct DeviceIdentity {
    key: SigningKey,
}

impl std::fmt::Debug for DeviceIdentity {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DeviceIdentity").field("public_id", &self.public_id()).finish_non_exhaustive()
    }
}

#[derive(Debug)]
pub struct SignError(&'static str);

impl std::fmt::Display for SignError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.0)
    }
}

impl std::error::Error for SignError {}

impl DeviceIdentity {
    /// The identity whose 32-byte Ed25519 seed is `secret_key`: what iroh calls the endpoint's secret key.
    pub fn from_secret_key(secret_key: [u8; 32]) -> Self {
        Self { key: SigningKey::from_bytes(&secret_key) }
    }

    pub fn secret_key(&self) -> [u8; 32] {
        self.key.to_bytes()
    }

    /// The public key in lowercase hex: the device's public ID, and its iroh endpoint ID.
    pub fn public_id(&self) -> String {
        hex::encode(self.key.verifying_key().as_bytes())
    }

    /// Add the body's digest and this device's signature over the request.
    pub fn sign(&self, request: &mut reqwest::Request) -> Result<(), SignError> {
        // progenitor's JSON bodies are buffered; a streamed body cannot be digested before it is sent.
        let body = match request.body() {
            None => &[][..],
            Some(body) => body.as_bytes().ok_or(SignError("A streamed body cannot be signed"))?,
        };
        let digest = format!("sha-256=:{}:", STANDARD.encode(Sha256::digest(body)));
        let content_type = request
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .map(|value| value.to_str().map(str::to_owned))
            .transpose()
            .map_err(|_| SignError("The content type is not text"))?;

        let created = SystemTime::now().duration_since(UNIX_EPOCH).expect("after 1970").as_secs();
        let nonce = uuid::Uuid::new_v4();
        let mut components = vec![
            ("@method", request.method().as_str().to_owned()),
            ("@target-uri", request.url().as_str().to_owned()),
            ("content-digest", digest.clone()),
        ];
        if let Some(content_type) = content_type {
            components.push(("content-type", content_type));
        }
        let names: Vec<String> = components.iter().map(|(name, _)| format!("\"{name}\"")).collect();
        let params = format!(
            "({});keyid=\"{}\";created={created};expires={};nonce=\"{nonce}\"",
            names.join(" "),
            self.public_id(),
            created + LIFETIME_SECONDS,
        );
        let mut base: Vec<String> = components.iter().map(|(name, value)| format!("\"{name}\": {value}")).collect();
        base.push(format!("\"@signature-params\": {params}"));
        let signature = self.key.sign(base.join("\n").as_bytes());

        let headers = request.headers_mut();
        let header = |value: String| HeaderValue::try_from(value).map_err(|_| SignError("Unencodable header"));
        headers.insert("content-digest", header(digest)?);
        headers.insert("signature-input", header(format!("sig1={params}"))?);
        headers.insert("signature", header(format!("sig1=:{}:", STANDARD.encode(signature.to_bytes())))?);
        Ok(())
    }
}
