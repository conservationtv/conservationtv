//! Publishing the camera's video to a MoQ relay as a hang broadcast: a catalog and one H.264 track, reconnecting
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

use crate::config::{Publish, VideoSource};
use crate::reports::MetricDefinition;

pub const READY: MetricDefinition = MetricDefinition { name: "path.ready", unit: "boolean" };
pub const INGEST_BITRATE: MetricDefinition = MetricDefinition { name: "path.ingest.bitrate", unit: "bits/s" };

/// What the publisher has done, read by the status route and the metrics loop.
#[derive(Default)]
pub struct Counters {
    pub connected: AtomicBool,
    pub bytes: AtomicU64,
    pub frames: AtomicU64,
}

#[derive(Serialize)]
pub struct PublishStatus {
    pub broadcast: String,
    pub connected: bool,
    pub bytes: u64,
    pub frames: u64,
}

pub struct Publisher {
    pub config: Publish,
    pub counters: Arc<Counters>,
}

impl Publisher {
    pub fn status(&self) -> PublishStatus {
        PublishStatus {
            broadcast: self.config.broadcast.clone(),
            connected: self.counters.connected.load(Ordering::Relaxed),
            bytes: self.counters.bytes.load(Ordering::Relaxed),
            frames: self.counters.frames.load(Ordering::Relaxed),
        }
    }

    /// Publish until the source ends or the connection fails for good.
    pub async fn run(&self) -> anyhow::Result<()> {
        let mut connect = moq_tokio::connect::Config::default();
        connect.url = Some(self.config.url.clone());
        let client = connect.init(Default::default()).context("MoQ client")?;
        let origin = moq_tokio::origin::spawn();

        let mut broadcast = origin.create_broadcast(&self.config.broadcast).context("broadcast")?;
        let catalog = moq_mux::catalog::Producer::new(&mut broadcast, Default::default())?;
        let track = broadcast.reserve_track("video")?;
        broadcast.announce(Default::default()).context("announce")?;

        let connection = client.with_publisher(&origin).connect(self.config.url.clone());
        tracing::info!(url = %moq_tokio::RedactedUrl::new(&self.config.url), broadcast = %self.config.broadcast, "publishing");
        self.counters.connected.store(true, Ordering::Relaxed);

        let result = tokio::select! {
            result = connection.closed() => result.map_err(anyhow::Error::from),
            result = self.pump(track, catalog) => result,
        };
        self.counters.connected.store(false, Ordering::Relaxed);
        broadcast.close();
        result
    }

    async fn pump(&self, track: moq_net::track::Request, catalog: moq_mux::catalog::Producer) -> anyhow::Result<()> {
        match self.config.source {
            VideoSource::Stdin => self.from_stdin(track, catalog).await,
            #[cfg(all(feature = "axis", target_os = "linux"))]
            VideoSource::Vdo { channel } => vdo_source::run(channel, track, catalog, self.counters.clone()).await,
            #[cfg(not(all(feature = "axis", target_os = "linux")))]
            VideoSource::Vdo { .. } => anyhow::bail!("VDO needs a build for an Axis device, with the axis feature"),
        }
    }

    /// Annex-B H.264 from standard input, its frame boundaries found by the importer.
    async fn from_stdin(&self, track: moq_net::track::Request, catalog: moq_mux::catalog::Producer) -> anyhow::Result<()> {
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
            self.counters.bytes.fetch_add(read as u64, Ordering::Relaxed);
        }
    }
}

/// The camera's own encoder: each VDO buffer is one access unit, Annex-B with SPS and PPS ahead of each keyframe, so
/// it is published whole, stamped with the encoder's own capture time.
#[cfg(all(feature = "axis", target_os = "linux"))]
mod vdo_source {
    use super::*;
    use moq_mux::import::Track;

    pub async fn run(
        channel: u32,
        track: moq_net::track::Request,
        catalog: moq_mux::catalog::Producer,
        counters: Arc<Counters>,
    ) -> anyhow::Result<()> {
        let mut import = Track::video(track, catalog.reserve(), VideoInit::new(VideoFormat::Avc3, Vec::new()))?;
        // VDO blocks for each frame, so it runs on a thread of its own and hands frames over.
        let (frames, mut received) = tokio::sync::mpsc::channel::<(Vec<u8>, u64)>(8);
        let reader = tokio::task::spawn_blocking(move || -> anyhow::Result<()> {
            let stream = vdo::StreamBuilder::new()
                .channel(channel)
                .format(vdo::VdoFormat::VDO_FORMAT_H264)
                // Keyframes every two seconds at 30 fps, so a subscriber joins quickly.
                .gop_length(60)
                .build()?;
            let running = stream.start()?;
            for index in 0u64.. {
                let buffer = running.next_buffer()?;
                // The whole frame, header included: VDO may carry the parameter sets in it.
                let frame = buffer.as_slice()?[..buffer.size()].to_vec();
                if index < 8 {
                    tracing::info!(
                        index,
                        size = buffer.size(),
                        header = ?buffer.header_size(),
                        frame_type = ?buffer.frame_type(),
                        nals = ?nal_types(&frame),
                        "VDO frame"
                    );
                }
                if frames.blocking_send((frame, buffer.timestamp())).is_err() {
                    return Ok(());
                }
            }
            Ok(())
        });
        let mut first = None;
        let mut parameter_sets: Vec<u8> = Vec::new();
        while let Some((mut frame, timestamp)) = received.recv().await {
            let nals = nal_types(&frame);
            let has_sps = nals.contains(&NAL_SPS);
            if has_sps {
                parameter_sets = parameter_sets_of(&frame);
            }
            // Parameter sets on their own wait for the frame they describe.
            if !nals.iter().any(|nal| matches!(nal, 1 | 5)) {
                continue;
            }
            // A keyframe without them gets the last ones seen, so it can be configured and decoded.
            if nals.contains(&NAL_IDR) && !has_sps && !parameter_sets.is_empty() {
                frame = [parameter_sets.as_slice(), frame.as_slice()].concat();
            }
            // The broadcast's clock starts at its first frame.
            let start = *first.get_or_insert(timestamp);
            let pts = moq_net::Timestamp::from_micros(timestamp - start)?;
            counters.bytes.fetch_add(frame.len() as u64, Ordering::Relaxed);
            counters.frames.fetch_add(1, Ordering::Relaxed);
            import.decode(frame, Some(pts))?;
        }
        import.finish()?;
        reader.await?
    }

    const NAL_IDR: u8 = 5;
    const NAL_SPS: u8 = 7;
    const NAL_PPS: u8 = 8;

    /// Each Annex-B NAL unit's payload, without its start code.
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

    pub(super) fn nal_types(data: &[u8]) -> Vec<u8> {
        nal_units(data).iter().filter_map(|nal| nal.first()).map(|byte| byte & 0x1f).collect()
    }

    /// The SPS and PPS in a frame, as Annex-B.
    fn parameter_sets_of(data: &[u8]) -> Vec<u8> {
        let mut out = Vec::new();
        for nal in nal_units(data) {
            if nal.first().is_some_and(|byte| matches!(byte & 0x1f, NAL_SPS | NAL_PPS)) {
                out.extend_from_slice(&[0, 0, 0, 1]);
                out.extend_from_slice(nal);
            }
        }
        out
    }
}
