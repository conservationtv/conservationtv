//! The machine the agent runs on, about the device: the `machineMetrics` catalogue in `@conservationtv/reports`, one
//! sample each per interval, as `runtimes/machine.ts` takes them.

use std::path::Path;

use sysinfo::{Disks, System};

use crate::reports::{Metric, MetricDefinition};

const fn metric(name: &'static str, unit: &'static str) -> MetricDefinition {
    MetricDefinition { name, unit }
}

pub const CPU_COUNT: MetricDefinition = metric("machine.cpu.count", "cores");
pub const CPU_UTILISATION: MetricDefinition = metric("machine.cpu.utilisation", "percent");
pub const LOAD: MetricDefinition = metric("machine.load", "processes");
pub const MEMORY_TOTAL: MetricDefinition = metric("machine.memory.total", "bytes");
pub const MEMORY_FREE: MetricDefinition = metric("machine.memory.free", "bytes");
pub const UPTIME: MetricDefinition = metric("machine.uptime", "seconds");
pub const DISK_TOTAL: MetricDefinition = metric("machine.disk.total", "bytes");
pub const DISK_FREE: MetricDefinition = metric("machine.disk.free", "bytes");
pub const AGENT_MEMORY: MetricDefinition = metric("agent.memory.rss", "bytes");

pub struct Machine {
    system: System,
    disks: Disks,
}

impl Machine {
    pub fn new() -> Self {
        let mut system = System::new();
        // CPU usage is busy time since the previous refresh, so the first sample needs one before it.
        system.refresh_cpu_usage();
        Self { system, disks: Disks::new_with_refreshed_list() }
    }

    /// One sample of every machine metric.
    pub fn sample(&mut self, directory: &Path) -> Vec<Metric> {
        self.system.refresh_cpu_usage();
        self.system.refresh_memory();
        self.disks.refresh(true);
        let load = System::load_average();
        let mut metrics = vec![
            Metric::gauge(CPU_COUNT, self.system.cpus().len() as f64),
            Metric::gauge(CPU_UTILISATION, f64::from(self.system.global_cpu_usage())),
            Metric::gauge(LOAD, load.one).with("window", "1m"),
            Metric::gauge(LOAD, load.five).with("window", "5m"),
            Metric::gauge(LOAD, load.fifteen).with("window", "15m"),
            Metric::gauge(MEMORY_TOTAL, self.system.total_memory() as f64),
            Metric::gauge(MEMORY_FREE, self.system.available_memory() as f64),
            Metric::gauge(UPTIME, System::uptime() as f64),
        ];
        // The filesystem the working directory is on: the disk mounted deepest above it.
        let directory = directory.canonicalize().unwrap_or_else(|_| directory.to_owned());
        let disk = self.disks.iter().filter(|disk| directory.starts_with(disk.mount_point())).max_by_key(|disk| {
            disk.mount_point().components().count()
        });
        if let Some(disk) = disk {
            metrics.push(Metric::gauge(DISK_TOTAL, disk.total_space() as f64));
            metrics.push(Metric::gauge(DISK_FREE, disk.available_space() as f64));
        }
        if let Some(rss) = resident_memory() {
            metrics.push(Metric::gauge(AGENT_MEMORY, rss as f64));
        }
        metrics
    }
}

/// The agent's own resident memory, from `/proc` on Linux, which is all a camera runs.
fn resident_memory() -> Option<u64> {
    let status = std::fs::read_to_string("/proc/self/status").ok()?;
    let line = status.lines().find(|line| line.starts_with("VmRSS:"))?;
    let kib: u64 = line.split_whitespace().nth(1)?.parse().ok()?;
    Some(kib * 1024)
}
