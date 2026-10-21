//! What the agent is started with, from its environment, as the Node runner's `env/config.ts` reads it.

use anyhow::{Context, bail};
use studio_sdk::DeviceIdentity;
use url::Url;

/// Where the video the agent publishes comes from.
#[derive(Clone, Debug)]
pub enum VideoSource {
    /// Annex-B H.264 on standard input, such as from `ffmpeg -f h264 -`: the camera's encoder, stood in for.
    Stdin,
    /// The camera's own encoder, through Axis's VDO API, on a channel.
    #[cfg_attr(not(all(feature = "axis", target_os = "linux")), allow(dead_code))]
    Vdo { channel: u32 },
}

/// A MoQ broadcast to publish: what the studio API would hand the device for an exposure it delivers.
#[derive(Clone, Debug)]
pub struct Publish {
    /// The relay, with the path it authorises, and `?jwt=` for a token: `https://relay/org/stream?jwt=…`.
    pub url: Url,
    pub broadcast: String,
    /// The exposure the broadcast delivers: its metrics are about `exposure:<id>`.
    pub exposure_id: Option<String>,
    pub source: VideoSource,
}

#[derive(Clone, Debug)]
pub struct Config {
    pub name: String,
    pub identity: DeviceIdentity,
    /// The studio API, for reports and an iroh session; without one the agent is direct.
    pub studio_url: Option<String>,
    pub metrics_interval_secs: u64,
    /// Serve the status over iroh.
    pub iroh: bool,
    pub publish: Option<Publish>,
}

fn var(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|value| !value.is_empty())
}

impl Config {
    pub fn from_env() -> anyhow::Result<Self> {
        let key = var("AGENT_SECRET_KEY").context("AGENT_SECRET_KEY is required: 32 bytes as hex")?;
        let bytes: [u8; 32] = hex::decode(key.trim())
            .context("AGENT_SECRET_KEY is not hex")?
            .try_into()
            .map_err(|_| anyhow::anyhow!("AGENT_SECRET_KEY is not 32 bytes"))?;
        let source = match var("VIDEO_SOURCE").as_deref() {
            None | Some("stdin") => VideoSource::Stdin,
            Some("vdo") => VideoSource::Vdo { channel: var("VDO_CHANNEL").map_or(Ok(0), |c| c.parse())? },
            Some(other) => bail!("VIDEO_SOURCE {other} is neither stdin nor vdo"),
        };
        let publish = match var("MOQ_URL") {
            None => None,
            Some(url) => Some(Publish {
                url: url.parse().context("MOQ_URL")?,
                broadcast: var("MOQ_BROADCAST").context("MOQ_BROADCAST is required with MOQ_URL")?,
                exposure_id: var("EXPOSURE_ID"),
                source,
            }),
        };
        Ok(Self {
            name: var("AGENT_NAME").unwrap_or_else(|| "edge-agent".into()),
            identity: DeviceIdentity::from_secret_key(bytes),
            studio_url: var("STUDIO_API_URL"),
            metrics_interval_secs: var("METRICS_INTERVAL_SECS").map_or(Ok(60), |s| s.parse())?,
            iroh: var("IROH").is_some_and(|value| value != "0"),
            publish,
        })
    }
}
