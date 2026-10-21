//! The agent's status, served as HTTP over iroh on an endpoint whose identity is the device's key, as `app.ts` serves
//! the Node agent's: the same wire protocol (`iroh-http/1`), so the studio's dialers reach either the same way.

use std::sync::Arc;

use anyhow::Context;
use axum::{Json, Router, extract::State, routing::get};
use iroh::{Endpoint, RelayMode, SecretKey};
use iroh_http::PeerInfo;
use serde_json::{Value, json};

use crate::Agent;

async fn status(State(agent): State<Arc<Agent>>, peer: Option<axum::Extension<PeerInfo>>) -> Json<Value> {
    Json(json!({
        "name": agent.config.name,
        "publicId": agent.config.identity.public_id(),
        "peer": peer.map(|peer| peer.endpoint_id.to_string()),
        "publish": agent.publisher.as_ref().map(|publisher| publisher.status()),
        "reports": agent.reporter.as_ref().map(|reporter| json!({ "queued": reporter.queued() })),
    }))
}

pub fn router(agent: Arc<Agent>) -> Router {
    Router::new().route("/status", get(status)).with_state(agent)
}

/// Bind the device's endpoint on n0's relays, as a direct agent does, and serve the router until it closes.
///
/// TODO: a conservation.tv agent binds on its session's relay alone (`irohSessions.create`), as `iroh.ts` does.
pub async fn serve(agent: Arc<Agent>) -> anyhow::Result<()> {
    let secret = SecretKey::from_bytes(&agent.config.identity.secret_key());
    let endpoint = Endpoint::builder(iroh::endpoint::presets::N0)
        .secret_key(secret)
        .relay_mode(RelayMode::Default)
        .alpns(vec![iroh_http::wire::ALPN.to_vec()])
        .bind()
        .await
        .context("bind the iroh endpoint")?;
    tracing::info!(endpoint_id = %endpoint.id(), "serving over iroh");
    iroh_http::serve(endpoint, router(agent)).await;
    Ok(())
}
