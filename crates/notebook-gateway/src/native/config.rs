use super::{Result, error};
use notebook_protocol::ErrorCode;
use std::{env, path::PathBuf, time::Duration};
use url::Url;

pub struct Config {
    pub url: Url,
    pub token: String,
    pub kernel: String,
    pub notebook: String,
    pub workspace: PathBuf,
    pub static_dir: Option<PathBuf>,
    pub listen: String,
    pub request_limit: usize,
    pub response_limit: usize,
    pub timeout: Duration,
}
fn value(key: &str, default: &str) -> String {
    env::var(format!("DIDACTION_{key}")).unwrap_or_else(|_| default.into())
}
fn invalid() -> notebook_protocol::ProtocolError {
    error(ErrorCode::InvalidInput, "Invalid gateway configuration")
}
impl Config {
    pub fn load() -> Result<Self> {
        let mut url =
            Url::parse(&value("JUPYTER_URL", "http://127.0.0.1:8888")).map_err(|_| invalid())?;
        if !matches!(url.scheme(), "http" | "https")
            || url.host_str().is_none()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return Err(invalid());
        }
        url.set_path(&format!("{}/", url.path().trim_end_matches('/')));
        let token = match env::var("DIDACTION_JUPYTER_TOKEN_FILE") {
            Ok(path) => std::fs::read_to_string(path)
                .map_err(|_| invalid())?
                .trim()
                .into(),
            Err(_) => value("JUPYTER_TOKEN", ""),
        };
        if token.len() > 4096 || token.contains(['\r', '\n']) {
            return Err(invalid());
        }
        let request_limit = value("REQUEST_LIMIT", "300000")
            .parse()
            .map_err(|_| invalid())?;
        let response_limit = value("RESPONSE_LIMIT", "4000000")
            .parse()
            .map_err(|_| invalid())?;
        let seconds: f64 = value("TIMEOUT_SECONDS", "30")
            .parse()
            .map_err(|_| invalid())?;
        if !(1..=4_000_000).contains(&request_limit)
            || !(1..=8_000_000).contains(&response_limit)
            || !(0.1..=120.0).contains(&seconds)
        {
            return Err(invalid());
        }
        let config = Self {
            url,
            token,
            kernel: value("KERNEL_NAME", "python3"),
            notebook: value("NOTEBOOK_PATH", "notebook-parity-demo.ipynb"),
            workspace: value("WORKSPACE", ".runtime/notebooks").into(),
            static_dir: env::var("DIDACTION_STATIC_DIR").ok().map(Into::into),
            listen: value("GATEWAY_BIND", "127.0.0.1:8080"),
            request_limit,
            response_limit,
            timeout: Duration::from_secs_f64(seconds),
        };
        config.path(&config.notebook, false)?;
        if config.kernel.is_empty() || config.kernel.len() > 128 {
            return Err(invalid());
        }
        Ok(config)
    }
    pub fn path(&self, raw: &str, directory: bool) -> Result<String> {
        confined(raw, directory)?;
        // Local deployments also reject existing escaping symlinks. In sidecar
        // deployments the configured Jupyter Contents manager enforces this.
        if let Ok(root) = self.workspace.canonicalize() {
            let mut candidate = root.join(raw);
            while !candidate.exists() {
                if !candidate.pop() {
                    break;
                }
            }
            if let Ok(resolved) = candidate.canonicalize()
                && !resolved.starts_with(&root)
            {
                return Err(error(
                    ErrorCode::PathRejected,
                    "Path is outside the workspace",
                ));
            }
        }
        Ok(if directory || raw.ends_with(".ipynb") {
            raw.into()
        } else {
            format!("{raw}.ipynb")
        })
    }
}
pub fn confined(raw: &str, directory: bool) -> Result<()> {
    if directory && raw.is_empty() {
        return Ok(());
    }
    if raw.is_empty()
        || raw.len() > 512
        || raw.chars().any(|c| c.is_control() || "\\%?#:".contains(c))
        || raw
            .split('/')
            .any(|part| part.is_empty() || part.starts_with('.'))
    {
        return Err(error(
            ErrorCode::PathRejected,
            "Choose a path inside the configured workspace",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn confinement() {
        for path in [
            "/x", "../x", "a/../b", "a//b", "a\\b", "a%2fb", ".secret", "a?b", "a\nb", "a:b",
        ] {
            assert!(confined(path, false).is_err(), "{path}");
        }
        assert!(confined("lesson/λ.ipynb", false).is_ok());
        assert!(confined("", true).is_ok());
    }
}
