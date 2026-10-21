//! What the agent is started with, from its environment, as the Node runner's `env/config.ts` reads it.

use anyhow::{Context, bail};
use studio_sdk::DeviceIdentity;
use url::Url;

/// Where the video the agent publishes comes from.
#[derive(Clone, Debug)]
pub enum VideoSource {
    /// Annex-B H.264 on standard input, such as from `ffmpeg -f h264 -`: the camera's encoder, stood in for.
    Stdin,
    /// The camera's own encoder, through Axis's VDO API, on a channel: one VDO stream per rendition.
    #[cfg_attr(not(all(feature = "axis", target_os = "linux")), allow(dead_code))]
    Vdo { channel: u32, renditions: Vec<Rendition> },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Codec {
    H264,
    H265,
}

/// How the encoder holds a stream to its bitrate: VAPIX's `videobitratemode`, VDO's `rc.mode`.
#[derive(Clone, Copy, Debug)]
pub enum BitrateMode {
    Cbr = 0,
    Vbr = 1,
    Mbr = 2,
    Abr = 3,
}

/// One quality of the camera's video, a track of its own in the broadcast. Written as the query string of a VAPIX
/// stream URL (`axis-media/media.amp?…`), with VAPIX's names, so a stream profile's string carries over as it is:
///
///   `name=hd&videocodec=h265&resolution=1280x720&fps=25&videomaxbitrate=1500&videokeyframeinterval=50`
///
/// `videomaxbitrate` is in kbit/s, as in VAPIX. Without `videobitratemode`, a maximum bitrate is held as MBR.
#[derive(Clone, Debug)]
#[cfg_attr(not(all(feature = "axis", target_os = "linux")), allow(dead_code))]
pub struct Rendition {
    /// The track's name, and the `rendition` dimension of its metrics.
    pub name: String,
    pub codec: Codec,
    pub resolution: Option<(u32, u32)>,
    pub fps: Option<u32>,
    /// Bits a second.
    pub max_bitrate: Option<u32>,
    pub bitrate_mode: Option<BitrateMode>,
    /// Frames between keyframes; two seconds' worth by default, so a subscriber joins quickly.
    pub keyframe_interval: u32,
}

impl Rendition {
    pub fn parse(query: &str, index: usize) -> anyhow::Result<Self> {
        let mut name = None;
        let mut codec = Codec::H264;
        let (mut resolution, mut fps, mut max_bitrate, mut bitrate_mode, mut keyframe_interval) =
            (None, None, None, None, None);
        for (key, value) in url::form_urlencoded::parse(query.trim().trim_start_matches('?').as_bytes()) {
            match key.as_ref() {
                "name" => name = Some(value.into_owned()),
                "videocodec" => {
                    codec = match value.as_ref() {
                        "h264" => Codec::H264,
                        "h265" => Codec::H265,
                        other => bail!("videocodec {other} is neither h264 nor h265"),
                    }
                }
                "resolution" => {
                    let (width, height) = value.split_once('x').context("resolution is <width>x<height>")?;
                    resolution = Some((width.parse()?, height.parse()?));
                }
                "fps" => fps = Some(value.parse()?),
                "videomaxbitrate" => max_bitrate = Some(value.parse::<u32>()? * 1000),
                "videobitratemode" => {
                    bitrate_mode = Some(match value.as_ref() {
                        "cbr" => BitrateMode::Cbr,
                        "vbr" => BitrateMode::Vbr,
                        "mbr" => BitrateMode::Mbr,
                        "abr" => BitrateMode::Abr,
                        other => bail!("videobitratemode {other} is not cbr, vbr, mbr or abr"),
                    })
                }
                "videokeyframeinterval" => keyframe_interval = Some(value.parse()?),
                other => bail!("{other} is not a rendition setting"),
            }
        }
        if max_bitrate.is_some() && bitrate_mode.is_none() {
            bitrate_mode = Some(BitrateMode::Mbr);
        }
        Ok(Self {
            name: name.unwrap_or_else(|| format!("video{index}")),
            codec,
            resolution,
            fps,
            max_bitrate,
            bitrate_mode,
            keyframe_interval: keyframe_interval.unwrap_or(fps.unwrap_or(25) * 2),
        })
    }
}

/// Where the broadcast goes.
#[derive(Clone, Debug)]
pub enum Relay {
    /// A relay and broadcast given outright: the relay, with the path it authorises, and `?jwt=` for a token
    /// (`https://relay/org/stream?jwt=…`).
    Direct { url: Url, broadcast: String },
    /// Whatever the studio API's `moqSessions.create` hands the device for its exposure, asked before each connect.
    Studio { api_url: String, identity: DeviceIdentity },
}

/// A MoQ broadcast to publish, for an exposure the device delivers.
#[derive(Clone, Debug)]
pub struct Publish {
    pub relay: Relay,
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
            Some("vdo") => VideoSource::Vdo {
                channel: var("VDO_CHANNEL").map_or(Ok(1), |c| c.parse())?,
                renditions: var("RENDITIONS")
                    .unwrap_or_default()
                    .split(';')
                    .filter(|query| !query.trim().is_empty())
                    .enumerate()
                    .map(|(index, query)| Rendition::parse(query, index).with_context(|| format!("rendition {query}")))
                    .collect::<anyhow::Result<Vec<_>>>()
                    .map(|renditions| {
                        if renditions.is_empty() { vec![Rendition::parse("", 0).unwrap()] } else { renditions }
                    })?,
            },
            Some(other) => bail!("VIDEO_SOURCE {other} is neither stdin nor vdo"),
        };
        let identity = DeviceIdentity::from_secret_key(bytes);
        let studio_url = var("STUDIO_API_URL");
        let exposure_id = var("EXPOSURE_ID");
        // A relay given outright wins; otherwise an exposure to deliver is asked of the studio API.
        let relay = match (var("MOQ_URL"), &studio_url, &exposure_id) {
            (Some(url), _, _) => Some(Relay::Direct {
                url: url.parse().context("MOQ_URL")?,
                broadcast: var("MOQ_BROADCAST").context("MOQ_BROADCAST is required with MOQ_URL")?,
            }),
            (None, Some(api_url), Some(_)) => Some(Relay::Studio { api_url: api_url.clone(), identity: identity.clone() }),
            _ => None,
        };
        let publish = relay.map(|relay| Publish { relay, exposure_id, source });
        Ok(Self {
            name: var("AGENT_NAME").unwrap_or_else(|| "edge-agent".into()),
            identity,
            studio_url,
            metrics_interval_secs: var("METRICS_INTERVAL_SECS").map_or(Ok(60), |s| s.parse())?,
            iroh: var("IROH").is_some_and(|value| value != "0"),
            publish,
        })
    }
}
