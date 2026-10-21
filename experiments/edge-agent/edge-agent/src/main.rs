//! Experiment: the agent runtime as one Rust binary a camera can run itself. It reports the device's metrics to the
//! studio API, signed as the device, publishes the camera's video to a MoQ relay, and serves its status over iroh.
//!
//!   edge-agent run      everything the environment configures, until stopped
//!   edge-agent report   one sample of the machine metrics, submitted once

#[cfg(all(feature = "axis", target_os = "linux"))]
mod acap;
mod bench;
mod config;
mod machine;
mod publish;
mod reports;
mod serve;

use std::{path::PathBuf, sync::Arc, sync::atomic::Ordering, time::Duration};

use chrono::Utc;
use config::Config;
use publish::Publisher;
use reports::{Metric, Reporter};

pub struct Agent {
    pub config: Config,
    pub reporter: Option<Reporter>,
    pub publisher: Option<Publisher>,
}

fn main() -> anyhow::Result<()> {
    // Before the runtime starts any thread: setting the environment is only sound while there is one.
    #[cfg(all(feature = "axis", target_os = "linux"))]
    acap::parameters_into_env()?;
    tokio::runtime::Builder::new_multi_thread().enable_all().build()?.block_on(start())
}

async fn start() -> anyhow::Result<()> {
    rustls::crypto::ring::default_provider().install_default().expect("the only crypto provider");
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()))
        .with_writer(std::io::stderr)
        // On a camera stderr goes to the system log, which shows escape codes as they are.
        .with_ansi(std::io::IsTerminal::is_terminal(&std::io::stderr()))
        .init();

    let config = Config::from_env()?;
    let reporter = config.studio_url.clone().map(|url| Reporter::new(url, config.identity.clone()));
    let publisher = config.publish.clone().map(Publisher::new);
    let agent = Arc::new(Agent { config, reporter, publisher });
    tracing::info!(name = %agent.config.name, public_id = %agent.config.identity.public_id(), "starting");
    if std::env::var("CRYPTO_BENCH").is_ok_and(|value| !value.is_empty() && value != "0") {
        bench::run();
    }

    match std::env::args().nth(1).as_deref() {
        Some("report") => report_once(&agent).await,
        Some("run") | None => run(agent).await,
        Some(other) => anyhow::bail!("unknown command {other}"),
    }
}

fn directory() -> PathBuf {
    std::env::current_dir().unwrap_or_else(|_| "/".into())
}

async fn report_once(agent: &Agent) -> anyhow::Result<()> {
    let reporter = agent.reporter.as_ref().ok_or_else(|| anyhow::anyhow!("STUDIO_API_URL is required"))?;
    let mut machine = machine::Machine::new();
    tokio::time::sleep(Duration::from_millis(250)).await;
    reporter.queue(Utc::now(), machine.sample(&directory()), None);
    let accepted = reporter.submit().await?;
    tracing::info!(accepted, "submitted");
    Ok(())
}

async fn run(agent: Arc<Agent>) -> anyhow::Result<()> {
    let mut tasks = tokio::task::JoinSet::new();
    if agent.reporter.is_some() {
        tasks.spawn(metrics_loop(agent.clone()));
    }
    if agent.publisher.is_some() {
        let agent = agent.clone();
        // A failed publisher starts again after a pause, rather than ending the agent: on a camera the app manager
        // would only restart it at once, over and over.
        tasks.spawn(async move {
            loop {
                match agent.publisher.as_ref().unwrap().run().await {
                    Ok(()) => tracing::info!("the video source ended"),
                    Err(error) => tracing::error!(error = format!("{error:#}"), "publishing failed"),
                }
                tokio::time::sleep(Duration::from_secs(10)).await;
            }
        });
    }
    if agent.config.iroh {
        tasks.spawn(serve::serve(agent.clone()));
    }
    // The camera's app manager stops an app with SIGTERM; a terminal with SIGINT.
    let mut terminate = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
    tokio::select! {
        _ = tokio::signal::ctrl_c() => tracing::info!("stopping"),
        _ = terminate.recv() => tracing::info!("stopping"),
        Some(result) = tasks.join_next() => {
            result??;
            tracing::info!("a task finished");
        }
    }
    Ok(())
}

/// Sample the machine and the publisher every few seconds, and submit each interval's samples, summarised.
async fn metrics_loop(agent: Arc<Agent>) -> anyhow::Result<()> {
    const SAMPLE_SECS: u64 = 10;
    let reporter = agent.reporter.as_ref().unwrap();
    let mut machine = machine::Machine::new();
    let mut ticker = tokio::time::interval(Duration::from_secs(SAMPLE_SECS));
    let per_interval = (agent.config.metrics_interval_secs / SAMPLE_SECS).max(1);
    // Each track's samples this interval, and its running totals at the last sample.
    let tracks = agent.publisher.as_ref().map_or(0, |publisher| publisher.counters.tracks.len());
    let mut samples = vec![TrackSamples::default(); tracks];
    let mut last = vec![(0u64, 0u64); tracks];
    for tick in 1u64.. {
        ticker.tick().await;
        if let Some(publisher) = &agent.publisher {
            let connected = publisher.counters.connected.load(Ordering::Relaxed);
            for (index, track) in publisher.counters.tracks.iter().enumerate() {
                let (bytes, frames) = (track.bytes.load(Ordering::Relaxed), track.frames.load(Ordering::Relaxed));
                let (last_bytes, last_frames) = last[index];
                let moved = bytes > last_bytes;
                let sample = &mut samples[index];
                // Ready while connected and carrying video.
                sample.ready.push(if connected && moved { 1.0 } else { 0.0 });
                sample.bitrate.push((bytes.saturating_sub(last_bytes) * 8) as f64 / SAMPLE_SECS as f64);
                sample.framerate.push(frames.saturating_sub(last_frames) as f64 / SAMPLE_SECS as f64);
                last[index] = (bytes, frames);
            }
        }
        if tick % per_interval != 0 {
            continue;
        }
        let now = Utc::now();
        reporter.queue(now, machine.sample(&directory()), None);
        if let Some(publisher) = &agent.publisher {
            let subject = publisher.config.exposure_id.as_ref().map(|id| format!("exposure:{id}"));
            let several = publisher.counters.tracks.len() > 1;
            for (track, sample) in publisher.counters.tracks.iter().zip(&mut samples) {
                let metrics = [
                    Metric::summary(publish::READY, &sample.ready),
                    Metric::summary(publish::INGEST_BITRATE, &sample.bitrate),
                    Metric::summary(publish::INGEST_FRAMERATE, &sample.framerate),
                ];
                // The rendition is a dimension when the exposure has several, as for MediaMTX's paths.
                let metrics = metrics
                    .into_iter()
                    .flatten()
                    .map(|metric| if several { metric.with("rendition", track.name.clone()) } else { metric })
                    .collect();
                reporter.queue(now, metrics, subject.clone());
                *sample = TrackSamples::default();
            }
        }
        match reporter.submit().await {
            Ok(accepted) => tracing::info!(accepted, "reports submitted"),
            Err(error) => tracing::warn!(%error, queued = reporter.queued(), "reports kept for the next submission"),
        }
    }
    Ok(())
}

/// A track's samples over an interval.
#[derive(Clone, Default)]
struct TrackSamples {
    ready: Vec<f64>,
    bitrate: Vec<f64>,
    framerate: Vec<f64>,
}
