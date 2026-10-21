//! Experiment: a viewer's side of a broadcast. Subscribes to each named track for as long as it runs, so the publisher
//! keeps sending, and every interval prints a JSON line a track of what arrived:
//!
//!   watch <relay url> <broadcast> <track>...
//!   watch http://localhost:4443/anon m5074 hd sd low
//!
//! `MAX_AGE_MS` (500 by default) is how long a group's tail is waited for once a newer group has begun.
//!
//! The publisher's clock and this machine's share no epoch, so delay is relative: each frame's arrival less its
//! timestamp, less the smallest such offset the track has had. Its spread is the delay the path adds, queueing and
//! jitter, on top of whatever the fastest frame took.

use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use anyhow::Context;

/// What a track has delivered since the last report.
#[derive(Default)]
struct Window {
    frames: u64,
    bytes: u64,
    groups: u64,
    /// The longest wait between frames, in milliseconds.
    max_gap_ms: f64,
    /// Waits between frames over a second.
    stalls: u64,
    /// Groups ended early, such as one superseded by a newer group before it was read.
    dropped_groups: u64,
    /// Each frame's delay above the track's fastest, in milliseconds.
    delays: Vec<f64>,
}

#[derive(Default)]
struct TrackState {
    window: Window,
    last_arrival: Option<Instant>,
    /// The smallest arrival-less-timestamp offset seen, in microseconds.
    fastest: Option<i128>,
    total_frames: u64,
    subscriptions: u64,
}

type States = Arc<Mutex<HashMap<String, TrackState>>>;

fn wall_micros() -> i128 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_micros() as i128
}

/// Read a track until it ends, recording each frame.
async fn read_track(mut track: moq_net::track::Subscriber, name: String, states: States) -> anyhow::Result<()> {
    while let Some(mut group) = track.recv_group().await? {
        states.lock().unwrap().get_mut(&name).unwrap().window.groups += 1;
        let mut read = 0u64;
        loop {
            // A group can end early without ending the track: the relay drops one a newer group supersedes.
            let frame = match group.read_frame().await {
                Ok(Some(frame)) => frame,
                Ok(None) => break,
                Err(error) => {
                    eprintln!("{name}: group {} ended early after {read} frames: {error}", group.sequence);
                    states.lock().unwrap().get_mut(&name).unwrap().window.dropped_groups += 1;
                    break;
                }
            };
            let now = Instant::now();
            let offset = wall_micros() - frame.timestamp.as_micros() as i128;
            let mut states = states.lock().unwrap();
            let state = states.get_mut(&name).unwrap();
            if let Some(last) = state.last_arrival {
                let gap = now.duration_since(last).as_secs_f64() * 1000.0;
                state.window.max_gap_ms = state.window.max_gap_ms.max(gap);
                if gap > 1000.0 {
                    state.window.stalls += 1;
                }
            }
            state.last_arrival = Some(now);
            let fastest = *state.fastest.get_or_insert(offset);
            if offset < fastest {
                state.fastest = Some(offset);
            }
            state.window.delays.push((offset - state.fastest.unwrap()) as f64 / 1000.0);
            state.window.frames += 1;
            state.window.bytes += frame.payload.len() as u64;
            state.total_frames += 1;
            read += 1;
        }
    }
    Ok(())
}

fn percentile(sorted: &[f64], p: f64) -> f64 {
    if sorted.is_empty() {
        return 0.0;
    }
    sorted[((sorted.len() - 1) as f64 * p).round() as usize]
}

/// Every interval, a line a track, and the window starts again.
async fn report(states: States, interval: Duration) {
    let mut ticker = tokio::time::interval(interval);
    ticker.tick().await;
    loop {
        ticker.tick().await;
        let mut states = states.lock().unwrap();
        let mut names: Vec<_> = states.keys().cloned().collect();
        names.sort();
        for name in names {
            let state = states.get_mut(&name).unwrap();
            let mut window = std::mem::take(&mut state.window);
            window.delays.sort_by(f64::total_cmp);
            let seconds = interval.as_secs_f64();
            println!(
                "{}",
                serde_json::json!({
                    "at": wall_micros() / 1_000_000,
                    "track": name,
                    "kbps": (window.bytes * 8) as f64 / seconds / 1000.0,
                    "fps": window.frames as f64 / seconds,
                    "groups": window.groups,
                    "max_gap_ms": window.max_gap_ms.round(),
                    "stalls": window.stalls,
                    "dropped_groups": window.dropped_groups,
                    "delay_ms": {
                        "p50": percentile(&window.delays, 0.5).round(),
                        "p95": percentile(&window.delays, 0.95).round(),
                        "max": window.delays.last().copied().unwrap_or(0.0).round(),
                    },
                    "frames": state.total_frames,
                    "subscriptions": state.subscriptions,
                })
            );
        }
    }
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    rustls::crypto::ring::default_provider().install_default().expect("the only crypto provider");
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "warn".into()))
        .with_writer(std::io::stderr)
        .init();
    let mut args = std::env::args().skip(1);
    let url: url::Url = args.next().context("a relay URL")?.parse()?;
    let broadcast_name = args.next().context("a broadcast")?;
    let tracks: Vec<String> = args.collect();
    let max_age = Duration::from_millis(
        std::env::var("MAX_AGE_MS").ok().and_then(|ms| ms.parse().ok()).unwrap_or(500),
    );
    anyhow::ensure!(!tracks.is_empty(), "at least one track");

    let states: States = Arc::new(Mutex::new(tracks.iter().map(|name| (name.clone(), TrackState::default())).collect()));
    tokio::spawn(report(states.clone(), Duration::from_secs(10)));

    let mut connect = moq_tokio::connect::Config::default();
    connect.url = Some(url.clone());
    let client = connect.init(Default::default())?;
    let origin = moq_tokio::origin::spawn();
    let session = client.with_subscriber(origin.clone()).connect(url);

    // Subscribe each time the broadcast is announced, so a publisher that restarts is followed.
    let path: moq_net::Path<'_> = broadcast_name.as_str().into();
    let scope = moq_net::Patterns::from(moq_net::Pattern::subtree(path.as_str()).context("a broadcast name")?);
    let consumer = origin.scope("", &scope).context("not allowed to consume the broadcast")?.consume();
    let mut announced = consumer.announced();
    let mut readers = tokio::task::JoinSet::new();
    loop {
        tokio::select! {
            Some(update) = announced.next() => {
                if !update.kind.is_active() {
                    eprintln!("{} went offline", update.prefix);
                    continue;
                }
                eprintln!("{} is online: subscribing to {}", update.prefix, tracks.join(", "));
                readers.abort_all();
                let broadcast = consumer.request_broadcast(&update.prefix).await?;
                for name in &tracks {
                    // Wait this long for a group's tail once a newer group has begun, rather than abandoning it at
                    // once (moq-net's default): the last frame of a group and the next keyframe race on separate
                    // streams. It never adds delay; it only decides when a late tail is given up on.
                    let mut subscription = moq_net::track::Subscription::default();
                    subscription.max_age = max_age;
                    let track = broadcast.track(name)?.subscribe(subscription).await?;
                    states.lock().unwrap().get_mut(name).unwrap().subscriptions += 1;
                    readers.spawn(read_track(track, name.clone(), states.clone()));
                }
            }
            Some(result) = readers.join_next() => match result {
                Ok(Err(error)) => eprintln!("a track ended: {error:#}"),
                _ => eprintln!("a track ended"),
            },
            result = session.closed() => return Ok(result?),
            _ = tokio::signal::ctrl_c() => return Ok(()),
        }
    }
}
