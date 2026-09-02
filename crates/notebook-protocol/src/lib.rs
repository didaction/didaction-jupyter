use serde::{Deserialize, Serialize};
use serde_json::Value;
use thiserror::Error;
use uuid::Uuid;

pub const PROTOCOL_VERSION: u16 = 1;
pub const MAX_PATH: usize = 512;
pub const MAX_SOURCE: usize = 256 * 1024;
pub const MAX_CELLS: usize = 2_000;
pub const MAX_OUTPUTS: usize = 128;
pub const MAX_OUTPUT_BYTES: usize = 512 * 1024;
pub const MAX_RESPONSE_BYTES: usize = 4 * 1024 * 1024;
pub const MAX_METADATA_DEPTH: usize = 8;
pub const MAX_TIMEOUT_MS: u32 = 120_000;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NotebookIdentity {
    pub path: String,
    pub workspace: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum KernelState {
    Unknown,
    Starting,
    Idle,
    Busy,
    Restarting,
    Disconnected,
    Error,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct KernelIdentity {
    pub name: String,
    pub display_name: String,
    pub session_id: Option<String>,
    pub state: KernelState,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CellType {
    Code,
    Markdown,
    Raw,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum CellOutput {
    Text {
        text: String,
    },
    Stream {
        name: String,
        text: String,
    },
    Error {
        name: String,
        message: String,
        traceback: Vec<String>,
    },
    Rich {
        mime: String,
        data: String,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Cell {
    pub id: String,
    pub cell_type: CellType,
    pub source: String,
    #[serde(default)]
    pub metadata: Value,
    pub execution_count: Option<u64>,
    #[serde(default)]
    pub outputs: Vec<CellOutput>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NotebookSnapshot {
    pub protocol_version: u16,
    pub schema_version: u16,
    pub notebook: NotebookIdentity,
    pub kernel: KernelIdentity,
    pub revision: u64,
    pub cells: Vec<Cell>,
    pub selected_cell_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum QueryKind {
    Summary,
    Cells,
    Full,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "operation", rename_all = "snake_case")]
pub enum CellMutation {
    Insert {
        index: usize,
        cell: Cell,
    },
    Update {
        cell_id: String,
        source: Option<String>,
        metadata: Option<Value>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        cell_type: Option<CellType>,
    },
    Delete {
        cell_id: String,
    },
    Move {
        cell_id: String,
        index: usize,
    },
    ClearOutputs {
        cell_id: String,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
#[serde(deny_unknown_fields)]
pub enum NotebookCommandKind {
    Setup {
        path: String,
        kernel: Option<String>,
        create: bool,
    },
    Query {
        query: QueryKind,
    },
    ModifyCells {
        changes: Vec<CellMutation>,
    },
    ExecuteCell {
        cell_id: String,
    },
    ExecuteCode {
        code: String,
    },
    InterruptKernel,
    RestartKernel,
    CreateCheckpoint,
    RenameNotebook {
        path: String,
    },
    DownloadNotebook,
    Complete {
        code: String,
        cursor_pos: usize,
    },
    Inspect {
        code: String,
        cursor_pos: usize,
    },
    Reconnect,
    Close,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct NotebookCommand {
    pub protocol_version: u16,
    pub command_id: Uuid,
    pub idempotency_key: String,
    pub expected_revision: Option<u64>,
    pub timeout_ms: u32,
    #[serde(flatten)]
    pub kind: NotebookCommandKind,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    NotDriver,
    UnsupportedVersion,
    InvalidInput,
    BoundsExceeded,
    StaleRevision,
    DuplicateCommand,
    UnsupportedOperation,
    Timeout,
    Disconnected,
    TransportError,
    MalformedResponse,
    PathRejected,
    ExecutionRejected,
    Internal,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Error)]
#[error("{code:?}: {message}")]
#[serde(deny_unknown_fields)]
pub struct ProtocolError {
    pub code: ErrorCode,
    pub message: String,
    pub retryable: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CommandResult {
    pub protocol_version: u16,
    pub command_id: Uuid,
    pub idempotency_key: String,
    pub base_revision: Option<u64>,
    pub committed_revision: Option<u64>,
    pub snapshot: Option<NotebookSnapshot>,
    #[serde(default)]
    pub completion: Option<CompletionReply>,
    #[serde(default)]
    pub inspection: Option<InspectionReply>,
    pub error: Option<ProtocolError>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CompletionReply {
    pub matches: Vec<String>,
    pub cursor_start: usize,
    pub cursor_end: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct InspectionReply {
    pub found: bool,
    pub text: String,
}

pub fn validate_command(command: &NotebookCommand) -> Result<(), ProtocolError> {
    validate_version(command.protocol_version)?;
    if command.idempotency_key.is_empty() || command.idempotency_key.len() > 128 {
        return Err(bounds("idempotency key must be 1..=128 bytes"));
    }
    if command.timeout_ms == 0 || command.timeout_ms > MAX_TIMEOUT_MS {
        return Err(bounds("timeout is outside the allowed range"));
    }
    match &command.kind {
        NotebookCommandKind::Setup { path, kernel, .. } => {
            validate_relative_path(path)?;
            if kernel.as_ref().is_some_and(|v| v.len() > 128) {
                return Err(bounds("kernel name too long"));
            }
        }
        NotebookCommandKind::RenameNotebook { path } => validate_relative_path(path)?,
        NotebookCommandKind::ModifyCells { changes } => {
            if changes.is_empty() || changes.len() > 256 {
                return Err(bounds("invalid mutation count"));
            }
            for change in changes {
                validate_mutation(change)?;
            }
        }
        NotebookCommandKind::ExecuteCode { code } => validate_source(code)?,
        NotebookCommandKind::Complete { code, cursor_pos } => {
            validate_source(code)?;
            if *cursor_pos > code.len() {
                return Err(bounds("completion cursor is outside source"));
            }
        }
        NotebookCommandKind::Inspect { code, cursor_pos } => {
            validate_source(code)?;
            if *cursor_pos > code.len() {
                return Err(bounds("inspection cursor is outside source"));
            }
        }
        NotebookCommandKind::ExecuteCell { cell_id }
            if cell_id.is_empty() || cell_id.len() > 128 =>
        {
            return Err(bounds("invalid cell id"));
        }
        _ => {}
    }
    Ok(())
}

pub fn validate_snapshot(snapshot: &NotebookSnapshot) -> Result<(), ProtocolError> {
    validate_version(snapshot.protocol_version)?;
    validate_relative_path(&snapshot.notebook.path)?;
    if snapshot.cells.len() > MAX_CELLS {
        return Err(bounds("too many cells"));
    }
    for cell in &snapshot.cells {
        validate_cell(cell)?;
    }
    let bytes = serde_json::to_vec(snapshot)
        .map_err(|_| invalid("snapshot is not serializable"))?
        .len();
    if bytes > MAX_RESPONSE_BYTES {
        return Err(bounds("aggregate response too large"));
    }
    Ok(())
}

pub fn validate_version(version: u16) -> Result<(), ProtocolError> {
    if version != PROTOCOL_VERSION {
        return Err(ProtocolError {
            code: ErrorCode::UnsupportedVersion,
            message: format!("protocol version {version} is unsupported"),
            retryable: false,
        });
    }
    Ok(())
}

pub fn validate_relative_path(path: &str) -> Result<(), ProtocolError> {
    if path.is_empty()
        || path.len() > MAX_PATH
        || path.starts_with('/')
        || path.starts_with('\\')
        || path.split(['/', '\\']).any(|p| p == ".." || p.is_empty())
    {
        return Err(ProtocolError {
            code: ErrorCode::PathRejected,
            message: "path must be a normalized workspace-relative path".into(),
            retryable: false,
        });
    }
    Ok(())
}

fn validate_mutation(change: &CellMutation) -> Result<(), ProtocolError> {
    match change {
        CellMutation::Insert { cell, .. } => validate_cell(cell),
        CellMutation::Update {
            cell_id,
            source,
            metadata,
            cell_type: _,
        } => {
            if cell_id.is_empty() || cell_id.len() > 128 {
                return Err(bounds("invalid cell id"));
            }
            if let Some(source) = source {
                validate_source(source)?;
            }
            if let Some(metadata) = metadata {
                validate_metadata(metadata, 0)?;
            }
            Ok(())
        }
        CellMutation::Delete { cell_id }
        | CellMutation::Move { cell_id, .. }
        | CellMutation::ClearOutputs { cell_id } => {
            if cell_id.is_empty() || cell_id.len() > 128 {
                Err(bounds("invalid cell id"))
            } else {
                Ok(())
            }
        }
    }
}

fn validate_cell(cell: &Cell) -> Result<(), ProtocolError> {
    if cell.id.is_empty() || cell.id.len() > 128 {
        return Err(bounds("invalid cell id"));
    }
    validate_source(&cell.source)?;
    validate_metadata(&cell.metadata, 0)?;
    if cell.outputs.len() > MAX_OUTPUTS {
        return Err(bounds("too many outputs"));
    }
    let output_bytes = serde_json::to_vec(&cell.outputs)
        .map_err(|_| invalid("outputs are not serializable"))?
        .len();
    if output_bytes > MAX_OUTPUT_BYTES {
        return Err(bounds("cell outputs too large"));
    }
    Ok(())
}

fn validate_source(source: &str) -> Result<(), ProtocolError> {
    if source.len() > MAX_SOURCE {
        Err(bounds("source too large"))
    } else {
        Ok(())
    }
}

fn validate_metadata(value: &Value, depth: usize) -> Result<(), ProtocolError> {
    if depth > MAX_METADATA_DEPTH {
        return Err(bounds("metadata nesting too deep"));
    }
    match value {
        Value::Array(values) => {
            for value in values {
                validate_metadata(value, depth + 1)?;
            }
        }
        Value::Object(values) => {
            for (key, value) in values {
                if key.len() > 256 {
                    return Err(bounds("metadata key too long"));
                }
                validate_metadata(value, depth + 1)?;
            }
        }
        Value::String(value) if value.len() > 64 * 1024 => {
            return Err(bounds("metadata string too large"));
        }
        _ => {}
    }
    Ok(())
}

fn bounds(message: &str) -> ProtocolError {
    ProtocolError {
        code: ErrorCode::BoundsExceeded,
        message: message.into(),
        retryable: false,
    }
}
fn invalid(message: &str) -> ProtocolError {
    ProtocolError {
        code: ErrorCode::InvalidInput,
        message: message.into(),
        retryable: false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn command(kind: NotebookCommandKind) -> NotebookCommand {
        NotebookCommand {
            protocol_version: 1,
            command_id: Uuid::nil(),
            idempotency_key: "test-key".into(),
            expected_revision: Some(0),
            timeout_ms: 1_000,
            kind,
        }
    }
    #[test]
    fn command_round_trip() {
        let c = command(NotebookCommandKind::Query {
            query: QueryKind::Full,
        });
        let json = serde_json::to_string(&c).unwrap();
        assert_eq!(serde_json::from_str::<NotebookCommand>(&json).unwrap(), c);
    }
    #[test]
    fn rejects_unsupported_version() {
        let mut c = command(NotebookCommandKind::Reconnect);
        c.protocol_version = 2;
        assert_eq!(
            validate_command(&c).unwrap_err().code,
            ErrorCode::UnsupportedVersion
        );
    }
    #[test]
    fn rejects_large_source() {
        let c = command(NotebookCommandKind::ExecuteCode {
            code: "x".repeat(MAX_SOURCE + 1),
        });
        assert_eq!(
            validate_command(&c).unwrap_err().code,
            ErrorCode::BoundsExceeded
        );
    }
    #[test]
    fn rejects_traversal() {
        assert_eq!(
            validate_relative_path("../secret.ipynb").unwrap_err().code,
            ErrorCode::PathRejected
        );
    }
}
