//! Transport-independent authoritative preparation and Jupyter output reduction.
//! Hosts own authentication, clocks, storage, execution and delivery. No I/O here.
use base64::{Engine, engine::general_purpose::STANDARD};
use notebook_core::{DomainError, NotebookState};
use notebook_protocol::{
    CellOutput, ErrorCode, MAX_OUTPUT_BYTES, MAX_OUTPUTS, NotebookCommand, NotebookSnapshot,
    ProtocolError, validate_snapshot,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
pub mod collaboration;

/// Produces a validated proposal, not a storage commit or execution acknowledgement.
pub fn prepare(
    snapshot: NotebookSnapshot,
    command: NotebookCommand,
) -> Result<NotebookSnapshot, DomainError> {
    let mut proposed = NotebookState::new(snapshot)?
        .prepare(command)?
        .optimistic_state
        .snapshot;
    if proposed
        .selected_cell_id
        .as_ref()
        .is_some_and(|id| !proposed.cells.iter().any(|cell| &cell.id == id))
    {
        proposed.selected_cell_id = None;
    }
    validate_snapshot(&proposed)?;
    Ok(proposed)
}

/// Browser JupyterLite bundles and native Jupyter `msg_type/content` map here.
#[derive(Debug, Deserialize)]
pub struct KernelEvent {
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(default)]
    pub bundle: Value,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct OutputState {
    outputs: Vec<CellOutput>,
    display_ids: Vec<Option<String>>,
    clear_next: bool,
}

fn malformed() -> ProtocolError {
    ProtocolError {
        code: ErrorCode::MalformedResponse,
        message: "Malformed kernel output".into(),
        retryable: false,
    }
}
fn bounded() -> ProtocolError {
    ProtocolError {
        code: ErrorCode::BoundsExceeded,
        message: "Kernel output exceeds limit".into(),
        retryable: false,
    }
}
fn text(value: &Value) -> Result<String, ProtocolError> {
    let value = value.as_str().ok_or_else(malformed)?;
    if value.len() > MAX_OUTPUT_BYTES {
        return Err(bounded());
    }
    Ok(value.into())
}
fn display(bundle: &Value) -> Result<CellOutput, ProtocolError> {
    let data = bundle
        .get("data")
        .and_then(Value::as_object)
        .ok_or_else(malformed)?;
    for mime in ["image/png", "image/svg+xml", "text/html"] {
        if let Some(value) = data.get(mime) {
            let value = text(value)?;
            return Ok(CellOutput::Rich {
                mime: mime.into(),
                data: if mime == "image/svg+xml" {
                    STANDARD.encode(value)
                } else {
                    value
                },
            });
        }
    }
    Ok(CellOutput::Text {
        text: match data.get("text/plain") {
            Some(value) => text(value)?,
            None => "[Unsupported display format]".into(),
        },
    })
}

impl OutputState {
    /// Native Jupyter channel adapter; HTTP/WebSocket framing stays with the host.
    pub fn apply_jupyter_message(&mut self, message: &Value) -> Result<(), ProtocolError> {
        let kind = message
            .get("msg_type")
            .or_else(|| {
                message
                    .get("header")
                    .and_then(|header| header.get("msg_type"))
            })
            .and_then(Value::as_str)
            .ok_or_else(malformed)?;
        self.apply(KernelEvent {
            kind: kind.into(),
            bundle: message.get("content").cloned().unwrap_or(Value::Null),
        })
    }

    pub fn outputs(&self) -> &[CellOutput] {
        &self.outputs
    }

    /// Ordered, atomic transition. Errors preserve outputs and deferred-clear state.
    pub fn apply(&mut self, event: KernelEvent) -> Result<(), ProtocolError> {
        if self.outputs.len() != self.display_ids.len() {
            return Err(malformed());
        }
        let mut next = self.clone();
        next.reduce(event)?;
        if next.outputs.len() > MAX_OUTPUTS
            || serde_json::to_vec(&next.outputs)
                .map_err(|_| malformed())?
                .len()
                > MAX_OUTPUT_BYTES
        {
            return Err(bounded());
        }
        *self = next;
        Ok(())
    }

    fn reduce(&mut self, event: KernelEvent) -> Result<(), ProtocolError> {
        let bundle = event.bundle;
        if event.kind == "clear_output" {
            self.clear_next = bundle
                .get("wait")
                .and_then(Value::as_bool)
                .ok_or_else(malformed)?;
            if !self.clear_next {
                self.outputs.clear();
                self.display_ids.clear();
            }
            return Ok(());
        }
        if !matches!(
            event.kind.as_str(),
            "stream"
                | "display_data"
                | "update_display_data"
                | "execute_result"
                | "execute_error"
                | "error"
        ) {
            return Ok(());
        }
        if self.clear_next {
            self.outputs.clear();
            self.display_ids.clear();
        }
        let id = bundle
            .get("transient")
            .and_then(|value| value.get("display_id"))
            .map(text)
            .transpose()?;
        if id.as_ref().is_some_and(|id| id.len() > 128) {
            return Err(bounded());
        }
        let output = match event.kind.as_str() {
            "stream" => {
                let name = text(&bundle["name"])?;
                if name != "stdout" && name != "stderr" {
                    return Err(malformed());
                }
                let mut value = text(&bundle["text"])?;
                if let Some(CellOutput::Stream {
                    name: previous_name,
                    text: previous,
                }) = self.outputs.last()
                    && *previous_name == name
                {
                    if previous.len() + value.len() > MAX_OUTPUT_BYTES {
                        return Err(bounded());
                    }
                    value = format!("{previous}{value}");
                    self.outputs.pop();
                    self.display_ids.pop();
                }
                CellOutput::Stream { name, text: value }
            }
            "execute_error" | "error" => {
                let traceback = bundle["traceback"].as_array().ok_or_else(malformed)?;
                if traceback.len() > 64 {
                    return Err(bounded());
                }
                CellOutput::Error {
                    name: text(&bundle["ename"])?,
                    message: text(&bundle["evalue"])?,
                    traceback: traceback.iter().map(text).collect::<Result<_, _>>()?,
                }
            }
            _ => display(&bundle)?,
        };
        if event.kind == "update_display_data" {
            if id.is_some() {
                for (index, previous) in self.display_ids.iter().enumerate() {
                    if previous == &id {
                        self.outputs[index] = output.clone();
                    }
                }
            }
        } else {
            self.outputs.push(output);
            self.display_ids.push(id);
        }
        self.clear_next = false;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn preparation_is_deterministic_revision_checked_and_not_a_commit() {
        let snapshot: NotebookSnapshot = serde_json::from_value(json!({
            "protocol_version":1,"schema_version":1,"revision":7,
            "notebook":{"path":"test.ipynb","workspace":"local"},
            "kernel":{"name":"python3","display_name":"Python","state":"idle"},
            "cells":[{"id":"c","cell_type":"code","source":"42","metadata":{},"execution_count":null,"outputs":[]}],
            "selected_cell_id":"c"
        })).unwrap();
        let command: NotebookCommand = serde_json::from_value(json!({
            "protocol_version":1,"command_id":"00000000-0000-0000-0000-000000000001",
            "idempotency_key":"delete-c","expected_revision":7,"timeout_ms":1000,
            "type":"modify_cells","changes":[{"operation":"delete","cell_id":"c"}]
        }))
        .unwrap();
        let proposed = prepare(snapshot.clone(), command.clone()).unwrap();
        assert_eq!(
            proposed,
            prepare(snapshot.clone(), command.clone()).unwrap()
        );
        assert_eq!(proposed.revision, 7);
        assert!(proposed.cells.is_empty());
        assert!(proposed.selected_cell_id.is_none());
        let mut stale = command.clone();
        stale.expected_revision = Some(6);
        assert!(matches!(
            prepare(snapshot.clone(), stale),
            Err(DomainError::StaleRevision { .. })
        ));
        let mut unsupported = command;
        unsupported.protocol_version = 2;
        assert!(prepare(snapshot.clone(), unsupported).is_err());
        assert_eq!(snapshot.cells.len(), 1);
    }
    #[test]
    fn native_channel_and_browser_bundle_have_identical_reduction() {
        let mut native = OutputState::default();
        let mut browser = OutputState::default();
        for (kind, bundle) in [
            ("stream", json!({"name":"stdout","text":"old"})),
            ("clear_output", json!({"wait":true})),
            (
                "display_data",
                json!({"data":{"text/plain":"phase1"},"transient":{"display_id":"x"}}),
            ),
            (
                "update_display_data",
                json!({"data":{"text/plain":"phase2"},"transient":{"display_id":"x"}}),
            ),
        ] {
            native
                .apply_jupyter_message(&json!({"header":{"msg_type":kind},"content":bundle}))
                .unwrap();
            browser.apply(event(kind, bundle)).unwrap();
            assert_eq!(native, browser);
        }
    }
    fn event(kind: &str, bundle: Value) -> KernelEvent {
        KernelEvent {
            kind: kind.into(),
            bundle,
        }
    }
    #[test]
    fn streams_and_deferred_clear_are_atomic() {
        let mut state = OutputState::default();
        state
            .apply(event("stream", json!({"name":"stdout","text":"one"})))
            .unwrap();
        state
            .apply(event("stream", json!({"name":"stdout","text":"two"})))
            .unwrap();
        assert_eq!(
            state.outputs(),
            &[CellOutput::Stream {
                name: "stdout".into(),
                text: "onetwo".into()
            }]
        );
        state
            .apply(event("clear_output", json!({"wait":true})))
            .unwrap();
        let before = state.clone();
        assert!(
            state
                .apply(event("stream", json!({"name":"invalid","text":"bad"})))
                .is_err()
        );
        assert_eq!(state, before);
        state
            .apply(event("stream", json!({"name":"stdout","text":"new"})))
            .unwrap();
        assert_eq!(state.outputs().len(), 1);
        assert!(
            !serde_json::to_string(state.outputs())
                .unwrap()
                .contains("onetwo")
        );
        state
            .apply(event("clear_output", json!({"wait":false})))
            .unwrap();
        assert!(state.outputs().is_empty());
    }
    #[test]
    fn display_updates_replace_all_matching_ids_and_encode_svg() {
        let mut state = OutputState::default();
        for _ in 0..2 {
            state
                .apply(event(
                    "display_data",
                    json!({"data":{"text/plain":"old"},"transient":{"display_id":"x"}}),
                ))
                .unwrap();
        }
        state
            .apply(event(
                "update_display_data",
                json!({"data":{"image/svg+xml":"<svg>λ</svg>"},"transient":{"display_id":"x"}}),
            ))
            .unwrap();
        assert_eq!(
            state.outputs(),
            vec![
                CellOutput::Rich {
                    mime: "image/svg+xml".into(),
                    data: STANDARD.encode("<svg>λ</svg>")
                };
                2
            ]
        );
    }
    #[test]
    fn errors_unknown_events_and_bounds() {
        let mut state = OutputState::default();
        state.apply(event("comm_open", json!({}))).unwrap();
        assert!(state.outputs().is_empty());
        state
            .apply(event(
                "error",
                json!({"ename":"SyntaxError","evalue":"invalid","traceback":["line"]}),
            ))
            .unwrap();
        let before = state.clone();
        assert!(
            state
                .apply(event(
                    "stream",
                    json!({"name":"stdout","text":"a".repeat(MAX_OUTPUT_BYTES)})
                ))
                .is_err()
        );
        assert_eq!(state, before);
    }
}
