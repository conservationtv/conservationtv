//! Publishing the camera's video to a MoQ relay as a hang broadcast: a catalog and a track per rendition, reconnecting
//! until the agent stops. What MediaMTX does for the Node agent's paths, done by the device itself. Its samples are
//! the `pathMetrics` catalogue's, about the exposure the broadcast delivers, so they chart beside MediaMTX's.

use std::sync::{
    Arc,
    atomic::{AtomicBool, AtomicU64, Ordering},
};

use anyhow::Context;
use moq_mux::import::{TrackStream, VideoFormat, VideoInit};
use serde::Serialize;
use tokio::io::AsyncReadExt;

use crate::config::{Codec, Publish, Relay, VideoSource};
use crate::reports::MetricDefinition;

pub const READY: MetricDefinition = MetricDefinition { name: "path.ready", unit: "boolean" };
pub const INGEST_BITRATE: MetricDefinition = MetricDefinition { name: "path.ingest.bitrate", unit: "bits/s" };
/// Not in the catalogue: the frames a second the encoder actually delivered, which falls behind the rendition's `fps`
/// when the camera cannot keep up.
pub const INGEST_FRAMERATE: MetricDefinition = MetricDefinition { name: "path.ingest.framerate", unit: "frames/s" };

/// What one track has carried, read by the status route and the metrics loop.
#[derive(Default)]
pub struct TrackCounters {
    pub name: String,
    pub bytes: AtomicU64,
    pub frames: AtomicU64,
}

/// What the publisher has done.
pub struct Counters {
    pub connected: AtomicBool,
    pub tracks: Vec<Arc<TrackCounters>>,
}

#[derive(Serialize)]
pub struct TrackStatus {
    pub name: String,
    pub bytes: u64,
    pub frames: u64,
}

#[derive(Serialize)]
pub struct PublishStatus {
    pub broadcast: String,
    pub connected: bool,
    pub tracks: Vec<TrackStatus>,
}

pub struct Publisher {
    pub config: Publish,
    pub counters: Counters,
    /// The broadcast published now, or last.
    broadcast: std::sync::Mutex<Option<String>>,
}

impl Publisher {
    pub fn new(config: Publish) -> Self {
        let names = match &config.source {
            VideoSource::Stdin => vec!["video".to_owned()],
            VideoSource::Vdo { renditions, .. } => renditions.iter().map(|rendition| rendition.name.clone()).collect(),
        };
        let tracks = names.into_iter().map(|name| Arc::new(TrackCounters { name, ..Default::default() })).collect();
        let broadcast = match &config.relay {
            Relay::Direct { broadcast, .. } => Some(broadcast.clone()),
            Relay::Studio { .. } => None,
        };
        Self {
            config,
            counters: Counters { connected: AtomicBool::new(false), tracks },
            broadcast: std::sync::Mutex::new(broadcast),
        }
    }

    pub fn status(&self) -> PublishStatus {
        PublishStatus {
            broadcast: self.broadcast.lock().unwrap().clone().unwrap_or_default(),
            connected: self.counters.connected.load(Ordering::Relaxed),
            tracks: self
                .counters
                .tracks
                .iter()
                .map(|track| TrackStatus {
                    name: track.name.clone(),
                    bytes: track.bytes.load(Ordering::Relaxed),
                    frames: track.frames.load(Ordering::Relaxed),
                })
                .collect(),
        }
    }

    /// The relay URL, with its token, and the broadcast to publish there: for an exposure, a new session from the
    /// studio API each time, since its token admits only new sessions until it expires.
    async fn session(&self) -> anyhow::Result<(url::Url, String)> {
        let (api_url, identity) = match &self.config.relay {
            Relay::Direct { url, broadcast } => return Ok((url.clone(), broadcast.clone())),
            Relay::Studio { api_url, identity } => (api_url, identity),
        };
        let exposure_id = self.config.exposure_id.as_deref().context("an exposure to publish")?;
        let client = studio_sdk::Client::as_device(api_url, identity.clone());
        let body = studio_sdk::types::MoqSessionsCreateBody { exposure_id: exposure_id.parse()? };
        let session = client.moq_sessions_create(&body).await.context("moqSessions.create")?.into_inner();
        tracing::info!(broadcast = %session.broadcast, expires_at = %session.expires_at, "MoQ session");
        let mut url: url::Url = session.url.parse().context("the session's relay URL")?;
        url.query_pairs_mut().append_pair("jwt", &session.token);
        Ok((url, session.broadcast))
    }

    /// Publish until a source ends or the connection fails for good.
    pub async fn run(&self) -> anyhow::Result<()> {
        let (url, broadcast_name) = self.session().await?;
        *self.broadcast.lock().unwrap() = Some(broadcast_name.clone());
        let mut connect = moq_tokio::connect::Config::default();
        connect.url = Some(url.clone());
        let client = connect.init(Default::default()).context("MoQ client")?;
        let origin = moq_tokio::origin::spawn();

        let mut broadcast = origin.create_broadcast(&broadcast_name).context("broadcast")?;
        let catalog = moq_mux::catalog::Producer::new(&mut broadcast, Default::default())?;
        let mut tracks = Vec::new();
        for counters in &self.counters.tracks {
            tracks.push((broadcast.reserve_track(counters.name.as_str())?, counters.clone()));
        }
        broadcast.announce(Default::default()).context("announce")?;

        let connection = client.with_publisher(&origin).connect(url.clone());
        tracing::info!(url = %moq_tokio::RedactedUrl::new(&url), broadcast = %broadcast_name, "publishing");
        self.counters.connected.store(true, Ordering::Relaxed);

        let result = tokio::select! {
            result = connection.closed() => result.map_err(anyhow::Error::from),
            result = self.pump(tracks, catalog) => result,
        };
        self.counters.connected.store(false, Ordering::Relaxed);
        broadcast.close();
        result
    }

    async fn pump(
        &self,
        tracks: Vec<(moq_net::track::Request, Arc<TrackCounters>)>,
        catalog: moq_mux::catalog::Producer,
    ) -> anyhow::Result<()> {
        match &self.config.source {
            VideoSource::Stdin => {
                let (track, counters) = tracks.into_iter().next().expect("one track");
                from_stdin(track, catalog, counters).await
            }
            #[cfg(all(feature = "axis", target_os = "linux"))]
            VideoSource::Vdo { channel, renditions } => {
                // Every rendition at once: the first to fail ends the broadcast, which `run`'s caller starts again.
                let mut pumps = tokio::task::JoinSet::new();
                for ((track, counters), rendition) in tracks.into_iter().zip(renditions.clone()) {
                    pumps.spawn(vdo_source::run(*channel, rendition, track, catalog.clone(), counters));
                }
                while let Some(result) = pumps.join_next().await {
                    result??;
                }
                Ok(())
            }
            #[cfg(not(all(feature = "axis", target_os = "linux")))]
            VideoSource::Vdo { .. } => anyhow::bail!("VDO needs a build for an Axis device, with the axis feature"),
        }
    }
}

/// Annex-B H.264 from standard input, its frame boundaries found by the importer.
async fn from_stdin(
    track: moq_net::track::Request,
    catalog: moq_mux::catalog::Producer,
    counters: Arc<TrackCounters>,
) -> anyhow::Result<()> {
    let mut import = TrackStream::video(track, catalog.reserve(), VideoInit::new(VideoFormat::Avc3, Vec::new()))?;
    let mut stdin = tokio::io::stdin();
    let mut buffer = vec![0u8; 64 * 1024];
    loop {
        let read = stdin.read(&mut buffer).await?;
        if read == 0 {
            import.finish()?;
            return Ok(());
        }
        import.decode(&buffer[..read])?;
        counters.bytes.fetch_add(read as u64, Ordering::Relaxed);
    }
}

/// The NAL unit types that matter here, for a codec.
#[cfg_attr(not(all(feature = "axis", target_os = "linux")), allow(dead_code))]
struct NalKinds {
    codec: Codec,
}

#[cfg_attr(not(all(feature = "axis", target_os = "linux")), allow(dead_code))]
impl NalKinds {
    fn kind(&self, nal: &[u8]) -> Option<u8> {
        let byte = *nal.first()?;
        Some(match self.codec {
            Codec::H264 => byte & 0x1f,
            Codec::H265 => (byte >> 1) & 0x3f,
        })
    }

    fn is_parameter_set(&self, kind: u8) -> bool {
        match self.codec {
            Codec::H264 => matches!(kind, 7 | 8),
            Codec::H265 => matches!(kind, 32..=34),
        }
    }

    /// The SPS, which configures the decoder.
    fn is_sps(&self, kind: u8) -> bool {
        kind == if self.codec == Codec::H264 { 7 } else { 33 }
    }

    fn is_picture(&self, kind: u8) -> bool {
        match self.codec {
            Codec::H264 => matches!(kind, 1..=5),
            Codec::H265 => kind <= 31,
        }
    }

    fn is_keyframe(&self, kind: u8) -> bool {
        match self.codec {
            Codec::H264 => kind == 5,
            Codec::H265 => matches!(kind, 16..=23),
        }
    }
}

/// Each Annex-B NAL unit's payload, without its start code.
#[cfg_attr(not(all(feature = "axis", target_os = "linux")), allow(dead_code))]
fn nal_units(data: &[u8]) -> Vec<&[u8]> {
    let mut starts = Vec::new();
    let mut i = 0;
    while i + 3 <= data.len() {
        if data[i] == 0 && data[i + 1] == 0 && data[i + 2] == 1 {
            starts.push(i + 3);
            i += 3;
        } else {
            i += 1;
        }
    }
    starts
        .iter()
        .enumerate()
        .map(|(n, &start)| {
            let mut end = starts.get(n + 1).map_or(data.len(), |next| next - 3);
            // A four-byte start code's leading zero belongs to it, not to the unit before.
            while end > start && data[end - 1] == 0 {
                end -= 1;
            }
            &data[start..end]
        })
        .collect()
}

/// The camera's own encoder: each VDO buffer is one access unit, Annex-B with the parameter sets in the keyframe's
/// header, so it is published whole, header included, stamped with the encoder's own capture time.
#[cfg(all(feature = "axis", target_os = "linux"))]
mod vdo_source {
    use super::*;
    use crate::config::Rendition;
    use moq_mux::import::Track;

    pub async fn run(
        channel: u32,
        rendition: Rendition,
        track: moq_net::track::Request,
        catalog: moq_mux::catalog::Producer,
        counters: Arc<TrackCounters>,
    ) -> anyhow::Result<()> {
        let kinds = NalKinds { codec: rendition.codec };
        let format = match rendition.codec {
            Codec::H264 => VideoFormat::Avc3,
            Codec::H265 => VideoFormat::Hev1,
        };
        let mut import = Track::video(track, catalog.reserve(), VideoInit::new(format, Vec::new()))?;
        // VDO blocks for each frame, so each stream runs on a thread of its own and hands frames over.
        let (frames, mut received) = tokio::sync::mpsc::channel::<(Vec<u8>, u64)>(8);
        let name = rendition.name.clone();
        let reader = tokio::task::spawn_blocking(move || -> anyhow::Result<()> {
            let mut builder = vdo::StreamBuilder::new()
                .channel(channel)
                .format(match rendition.codec {
                    Codec::H264 => vdo::VdoFormat::VDO_FORMAT_H264,
                    Codec::H265 => vdo::VdoFormat::VDO_FORMAT_H265,
                })
                .gop_length(rendition.keyframe_interval);
            if let Some((width, height)) = rendition.resolution {
                builder = builder.resolution(vdo::Resolution::Exact { width, height });
            }
            if let Some(fps) = rendition.fps {
                builder = builder.framerate(fps);
            }
            if let Some(bitrate) = rendition.max_bitrate {
                builder = builder.setting_u32("bitrate", bitrate);
            }
            if let Some(mode) = rendition.bitrate_mode {
                builder = builder.setting_u32("rc.mode", mode as u32);
            }
            let stream = builder.build()?;
            if let Ok(info) = stream.info() {
                tracing::info!(
                    rendition = %rendition.name,
                    width = info.get_u32(c"width", 0),
                    height = info.get_u32(c"height", 0),
                    framerate = info.get_u32(c"framerate", 0),
                    "VDO stream"
                );
            }
            let running = stream.start()?;
            loop {
                let buffer = running.next_buffer()?;
                // The whole frame, header included: VDO carries the parameter sets in it.
                let frame = buffer.as_slice()?[..buffer.size()].to_vec();
                if frames.blocking_send((frame, buffer.timestamp())).is_err() {
                    return Ok(());
                }
            }
        });
        let mut first = None;
        let mut parameter_sets: Vec<u8> = Vec::new();
        while let Some((mut frame, timestamp)) = received.recv().await {
            let nals: Vec<(u8, &[u8])> =
                nal_units(&frame).into_iter().filter_map(|nal| Some((kinds.kind(nal)?, nal))).collect();
            let has_sps = nals.iter().any(|(kind, _)| kinds.is_sps(*kind));
            if has_sps {
                parameter_sets.clear();
                for (_, nal) in nals.iter().filter(|(kind, _)| kinds.is_parameter_set(*kind)) {
                    parameter_sets.extend_from_slice(&[0, 0, 0, 1]);
                    parameter_sets.extend_from_slice(nal);
                }
            }
            // Parameter sets on their own wait for the frame they describe.
            if !nals.iter().any(|(kind, _)| kinds.is_picture(*kind)) {
                continue;
            }
            // A keyframe without them gets the last ones seen, so it can be configured and decoded.
            let keyframe = nals.iter().any(|(kind, _)| kinds.is_keyframe(*kind));
            drop(nals);
            if keyframe && !has_sps && !parameter_sets.is_empty() {
                frame = [parameter_sets.as_slice(), frame.as_slice()].concat();
            }
            // The broadcast's clock starts at the track's first frame.
            let start = *first.get_or_insert(timestamp);
            let pts = moq_net::Timestamp::from_micros(timestamp - start)?;
            counters.bytes.fetch_add(frame.len() as u64, Ordering::Relaxed);
            counters.frames.fetch_add(1, Ordering::Relaxed);
            import.decode(frame, Some(pts)).with_context(|| format!("rendition {name}"))?;
        }
        import.finish()?;
        reader.await?
    }
}
