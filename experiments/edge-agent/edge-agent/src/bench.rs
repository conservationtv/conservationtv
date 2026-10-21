//! How fast this machine seals packets with each AEAD a QUIC session (MoQ's, iroh's) may negotiate, with the crypto
//! the agent is built on (ring): 1200-byte packets, QUIC's usual size, for a fixed time each. Logged once at start-up
//! when `CRYPTO_BENCH` is set, to put the cost of encrypting the video against the bitrate it carries.

use std::time::{Duration, Instant};

use ring::aead::{AES_128_GCM, AES_256_GCM, Aad, Algorithm, CHACHA20_POLY1305, LessSafeKey, Nonce, UnboundKey};

const PACKET: usize = 1200;
const RUN: Duration = Duration::from_millis(500);

fn seal_rate(algorithm: &'static Algorithm) -> f64 {
    let key = LessSafeKey::new(UnboundKey::new(algorithm, &vec![7u8; algorithm.key_len()]).unwrap());
    let mut packet = vec![0u8; PACKET];
    let (mut bytes, mut counter, start) = (0u64, 0u64, Instant::now());
    while start.elapsed() < RUN {
        let mut nonce = [0u8; 12];
        nonce[4..].copy_from_slice(&counter.to_be_bytes());
        let tag = key.seal_in_place_separate_tag(Nonce::assume_unique_for_key(nonce), Aad::empty(), &mut packet).unwrap();
        let _ = std::hint::black_box(tag);
        bytes += PACKET as u64;
        counter += 1;
    }
    bytes as f64 / start.elapsed().as_secs_f64()
}

/// Log each AEAD's single-core sealing rate, and the share of one core a stream would spend sealing per Mb/s.
pub fn run() {
    for (name, algorithm) in
        [("AES-128-GCM", &AES_128_GCM), ("AES-256-GCM", &AES_256_GCM), ("ChaCha20-Poly1305", &CHACHA20_POLY1305)]
    {
        let rate = seal_rate(algorithm);
        tracing::info!(
            aead = name,
            mbytes_per_sec = format!("{:.1}", rate / 1e6),
            core_percent_per_mbit = format!("{:.3}", 125_000.0 / rate * 100.0),
            "crypto bench"
        );
    }
}
