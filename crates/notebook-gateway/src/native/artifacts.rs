//! Bounded, create-only workspace writes through Jupyter Contents, never host files.
use super::{Result, error, jupyter::Jupyter, malformed};
use base64::{Engine, engine::general_purpose::STANDARD};
use notebook_protocol::{ErrorCode, KernelState};
use reqwest::Method;
use serde::Deserialize;
use serde_json::{Value, json};
use uuid::Uuid;

pub const MAX_ARTIFACT_BYTES: usize = 1_000_000;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CreateArtifact {
    pub path: String,
    pub kind: ArtifactKind,
    #[serde(default)]
    pub content_base64: Option<String>,
}
#[derive(Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum ArtifactKind {
    Directory,
    Notebook,
    File,
}

impl CreateArtifact {
    pub fn body(&self) -> Result<Value> {
        super::config::confined(&self.path, false)?;
        if self.kind == ArtifactKind::Directory {
            if self.content_base64.is_some() {
                return Err(error(
                    ErrorCode::InvalidInput,
                    "Folders cannot contain upload data",
                ));
            }
            return Ok(json!({"type":"directory"}));
        }
        let bytes = match &self.content_base64 {
            Some(data) => {
                if data.len() > MAX_ARTIFACT_BYTES.div_ceil(3) * 4 {
                    return Err(error(ErrorCode::BoundsExceeded, "Upload exceeds 1 MB"));
                }
                let bytes = STANDARD
                    .decode(data)
                    .map_err(|_| error(ErrorCode::InvalidInput, "Invalid upload encoding"))?;
                if bytes.len() > MAX_ARTIFACT_BYTES {
                    return Err(error(ErrorCode::BoundsExceeded, "Upload exceeds 1 MB"));
                }
                bytes
            }
            None => Vec::new(),
        };
        if self.kind == ArtifactKind::Notebook || self.path.ends_with(".ipynb") {
            if !self.path.ends_with(".ipynb") {
                return Err(error(
                    ErrorCode::InvalidInput,
                    "Notebook names must end in .ipynb",
                ));
            }
            let mut notebook = if self.content_base64.is_some() {
                serde_json::from_slice::<Value>(&bytes).map_err(|_| {
                    error(ErrorCode::InvalidInput, "Upload is not valid notebook JSON")
                })?
            } else {
                json!({"nbformat":4,"nbformat_minor":5,"metadata":{},"cells":[]})
            };
            if notebook["nbformat"] != 4 || !notebook["metadata"].is_object() {
                return Err(error(
                    ErrorCode::InvalidInput,
                    "Expected an nbformat 4 notebook",
                ));
            }
            for cell in notebook["cells"].as_array_mut().ok_or_else(malformed)? {
                if cell.get("id").is_none() {
                    cell["id"] = Uuid::new_v4().to_string().into();
                }
                // Uploaded notebooks are untrusted; do not preserve Jupyter trust flags.
                if let Some(metadata) = cell.get_mut("metadata").and_then(Value::as_object_mut) {
                    metadata.remove("trusted");
                }
            }
            Ok(json!({"type":"notebook","format":"json","content":notebook}))
        } else {
            Ok(json!({"type":"file","format":"base64","content":STANDARD.encode(bytes)}))
        }
    }
}

impl Jupyter {
    pub async fn create_artifact(&self, input: CreateArtifact) -> Result<Value> {
        let path = self.config.path(&input.path, true)?;
        let body = input.body()?;
        if body["type"] == "notebook" {
            self.snapshot(&path, &body["content"], 0, KernelState::Idle)?;
        }
        let route = format!("api/contents/{path}");
        match self
            .request(Method::GET, &format!("{route}?content=0"), None)
            .await?
            .0
        {
            404 => {}
            200 => {
                return Err(error(
                    ErrorCode::InvalidInput,
                    "Name already exists; choose a different name",
                ));
            }
            _ => {
                return Err(error(
                    ErrorCode::TransportError,
                    "Could not check destination; refresh before retrying",
                ));
            }
        }
        let parent = path.rsplit_once('/').map(|(p, _)| p).unwrap_or("");
        let (status, directory) = self
            .request(
                Method::GET,
                &format!("api/contents/{parent}?content=0"),
                None,
            )
            .await?;
        if status != 200 || directory["type"] != "directory" {
            return Err(error(
                ErrorCode::PathRejected,
                "Parent folder does not exist; create it first",
            ));
        }
        let (status, _) = self.request(Method::PUT, &route, Some(body)).await?;
        if status != 201 {
            return Err(error(
                ErrorCode::TransportError,
                "Creation was not confirmed; refresh the folder before retrying",
            ));
        }
        Ok(json!({"ok":true,"path":path}))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn input(path: &str, kind: ArtifactKind, data: Option<String>) -> CreateArtifact {
        CreateArtifact {
            path: path.into(),
            kind,
            content_base64: data,
        }
    }
    #[test]
    fn artifact_validation() {
        for path in ["../escape", "/absolute", "a/.hidden", "a%2fb", ""] {
            assert!(input(path, ArtifactKind::File, None).body().is_err());
        }
        assert_eq!(
            input(
                "lesson/data.csv",
                ArtifactKind::File,
                Some(STANDARD.encode(b"a,b\n1,2"))
            )
            .body()
            .unwrap()["format"],
            "base64"
        );
        assert!(
            input("lesson", ArtifactKind::Directory, Some(String::new()))
                .body()
                .is_err()
        );
        assert!(
            input(
                "bad.ipynb",
                ArtifactKind::File,
                Some(STANDARD.encode(b"not json"))
            )
            .body()
            .is_err()
        );
        assert!(
            input("big", ArtifactKind::File, Some("A".repeat(1_400_000)))
                .body()
                .is_err()
        );
        assert!(
            input("invalid", ArtifactKind::File, Some("!".into()))
                .body()
                .is_err()
        );
        assert_eq!(
            input("new.ipynb", ArtifactKind::Notebook, None)
                .body()
                .unwrap()["content"]["cells"],
            json!([])
        );
    }
}
