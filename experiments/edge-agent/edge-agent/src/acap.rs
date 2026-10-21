//! On a camera the agent is configured through its ACAP parameters (`manifest.json`), which an administrator sets in
//! the camera's web interface or with `param.cgi`, not through its environment. Each is read into the environment
//! variable `Config::from_env` reads, so both hosts share one configuration path.

use anyhow::Context;
use axparameter::parameter::Parameter;

/// The app's name, which its parameters are grouped under: `root.Conservationtv_edge_agent.<name>` in VAPIX.
const APP_NAME: &str = "conservationtv_edge_agent";

/// Each parameter, and the variable it becomes.
const PARAMETERS: &[(&str, &str)] = &[
    ("DeviceSecretKey", "AGENT_SECRET_KEY"),
    ("StudioApiUrl", "STUDIO_API_URL"),
    ("MetricsIntervalSecs", "METRICS_INTERVAL_SECS"),
    ("Iroh", "IROH"),
    ("MoqUrl", "MOQ_URL"),
    ("MoqBroadcast", "MOQ_BROADCAST"),
    ("ExposureId", "EXPOSURE_ID"),
    ("VideoSource", "VIDEO_SOURCE"),
    ("VdoChannel", "VDO_CHANNEL"),
];

/// Read every parameter into the environment. Only sound while the process has one thread.
pub fn parameters_into_env() -> anyhow::Result<()> {
    let parameters = Parameter::new(APP_NAME).context("the app's parameters")?;
    for (name, variable) in PARAMETERS {
        let value: String = parameters.get(name).with_context(|| format!("the {name} parameter"))?;
        // SAFETY: called before the runtime starts, while the process has only this thread.
        unsafe { std::env::set_var(variable, value) };
    }
    Ok(())
}
