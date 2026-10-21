//! Metric reports to the studio API (`reports.submit`), signed as the device, as `runtimes/reports.ts` in the Node
//! agent does: about the device, `device:<id>`, unless queued about another subject, such as an exposure. The device
//! asks who it is (`whoami.get`) before its first submission. A failed submission is kept for the next, the oldest
//! dropped beyond one batch.

use std::collections::HashMap;

use anyhow::Context;
use chrono::{DateTime, Utc};
use studio_sdk::{Client, DeviceIdentity, types};
use tokio::sync::Mutex;

/// The most reports one submission carries, as the studio API accepts.
const MAX_BATCH_REPORTS: usize = 1000;

/// A metric from the catalogue in `@conservationtv/reports`: the name and unit its series are stored under.
#[derive(Clone, Copy, Debug)]
pub struct MetricDefinition {
    pub name: &'static str,
    pub unit: &'static str,
}

/// One sample, or a summary of an interval's samples.
#[derive(Clone, Debug)]
pub enum Value {
    Gauge(f64),
    Summary { min: f64, max: f64, avg: f64, last: f64, count: u32 },
}

#[derive(Clone, Debug)]
pub struct Metric {
    pub definition: MetricDefinition,
    pub value: Value,
    pub dimensions: HashMap<String, String>,
}

impl Metric {
    pub fn gauge(definition: MetricDefinition, value: f64) -> Self {
        Self { definition, value: Value::Gauge(value), dimensions: HashMap::new() }
    }

    /// The samples taken over an interval, summarised as one point: `None` when there are none.
    pub fn summary(definition: MetricDefinition, samples: &[f64]) -> Option<Self> {
        let last = *samples.last()?;
        let min = samples.iter().copied().fold(f64::INFINITY, f64::min);
        let max = samples.iter().copied().fold(f64::NEG_INFINITY, f64::max);
        // A mean can land a rounding error outside its samples, which the summary's rule refuses.
        let avg = (samples.iter().sum::<f64>() / samples.len() as f64).clamp(min, max);
        let count = samples.len() as u32;
        Some(Self { definition, value: Value::Summary { min, max, avg, last, count }, dimensions: HashMap::new() })
    }

    pub fn with(mut self, dimension: &str, value: impl Into<String>) -> Self {
        self.dimensions.insert(dimension.into(), value.into());
        self
    }
}

struct Pending {
    observed_at: DateTime<Utc>,
    subject_id: Option<String>,
    metric: Metric,
}

/// The device's studio API client, and the subject it reports about itself as, once asked.
struct Studio {
    client: Client,
    subject_id: String,
}

pub struct Reporter {
    base_url: String,
    identity: DeviceIdentity,
    studio: Mutex<Option<Studio>>,
    pending: std::sync::Mutex<Vec<Pending>>,
}

impl Reporter {
    pub fn new(base_url: String, identity: DeviceIdentity) -> Self {
        Self { base_url, identity, studio: Mutex::new(None), pending: std::sync::Mutex::new(Vec::new()) }
    }

    pub fn queued(&self) -> usize {
        self.pending.lock().unwrap().len()
    }

    /// Queue `metrics`, all observed at once, about `subject_id`, or the device without one.
    pub fn queue(&self, observed_at: DateTime<Utc>, metrics: Vec<Metric>, subject_id: Option<String>) {
        let mut pending = self.pending.lock().unwrap();
        pending.extend(metrics.into_iter().map(|metric| Pending { observed_at, subject_id: subject_id.clone(), metric }));
        let excess = pending.len().saturating_sub(MAX_BATCH_REPORTS);
        pending.drain(..excess);
    }

    /// Submit every pending metric, keeping them if that fails. The number the studio API accepted.
    pub async fn submit(&self) -> anyhow::Result<f64> {
        let mut studio = self.studio.lock().await;
        if studio.is_none() {
            *studio = Some(self.connect().await?);
        }
        let studio = studio.as_ref().unwrap();
        let sent: Vec<Pending> = std::mem::take(&mut *self.pending.lock().unwrap());
        if sent.is_empty() {
            return Ok(0.0);
        }
        let reports = sent.iter().map(|pending| report(pending, &studio.subject_id)).collect::<anyhow::Result<_>>()?;
        let result = studio.client.reports_submit(&types::ReportsSubmitBody { reports }).await;
        match result {
            Ok(response) => Ok(response.into_inner().accepted),
            Err(error) => {
                // Put them back ahead of what was queued meanwhile.
                let mut pending = self.pending.lock().unwrap();
                let later = std::mem::take(&mut *pending);
                *pending = sent.into_iter().chain(later).collect();
                let excess = pending.len().saturating_sub(MAX_BATCH_REPORTS);
                pending.drain(..excess);
                Err(anyhow::anyhow!("reports.submit failed: {error}"))
            }
        }
    }

    async fn connect(&self) -> anyhow::Result<Studio> {
        let client = Client::as_device(&self.base_url, self.identity.clone());
        let device = client.whoami_get().await.map_err(|error| anyhow::anyhow!("whoami.get failed: {error}"))?;
        Ok(Studio { client, subject_id: format!("device:{}", device.into_inner().id) })
    }
}

/// A pending metric as the generated client takes it. The generated newtypes check the contract's limits.
fn report(pending: &Pending, device: &str) -> anyhow::Result<types::ReportsSubmitBodyReportsItem> {
    use types::ReportsSubmitMetricPayload as Payload;
    let Metric { definition, value, dimensions } = &pending.metric;
    let unit = Some(definition.unit.try_into().context("unit")?);
    let payload = match value {
        Value::Gauge(value) => Payload::Variant0 {
            dimensions: dimensions
                .iter()
                .map(|(key, value)| Ok((key.clone(), value.as_str().try_into()?)))
                .collect::<Result<_, types::error::ConversionError>>()?,
            name: definition.name.try_into().context("name")?,
            unit: unit.map(|unit: types::ReportsSubmitMetricPayloadVariant0Unit| unit),
            value: *value,
        },
        Value::Summary { min, max, avg, last, count } => Payload::Variant1 {
            dimensions: dimensions
                .iter()
                .map(|(key, value)| Ok((key.clone(), value.as_str().try_into()?)))
                .collect::<Result<_, types::error::ConversionError>>()?,
            name: definition.name.try_into().context("name")?,
            summary: types::ReportsSubmitMetricPayloadVariant1Summary {
                min: *min,
                max: *max,
                avg: *avg,
                last: *last,
                count: std::num::NonZeroU64::new(u64::from(*count)).context("count")?,
            },
            unit: Some(definition.unit.try_into().context("unit")?),
        },
    };
    let subject = pending.subject_id.as_deref().unwrap_or(device);
    Ok(types::ReportsSubmitBodyReportsItem::Metric(types::ReportsSubmitMetric {
        kind: types::ReportsSubmitMetricKind::Metric,
        observed_at: pending.observed_at,
        payload,
        subject_id: subject.try_into().context("subject")?,
    }))
}
