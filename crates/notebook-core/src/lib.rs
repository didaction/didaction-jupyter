use notebook_protocol::{
    Cell, CellMutation, CommandResult, ErrorCode, NotebookCommand, NotebookCommandKind,
    NotebookSnapshot, ProtocolError, validate_command, validate_snapshot,
};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use thiserror::Error;
use uuid::Uuid;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SyncState {
    Synchronized,
    Dirty,
    Executing,
    Disconnected,
    Error,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PendingCommand {
    pub command_id: Uuid,
    pub idempotency_key: String,
    pub expected_revision: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct NotebookState {
    pub snapshot: NotebookSnapshot,
    pub sync_state: SyncState,
    pub pending: BTreeMap<Uuid, PendingCommand>,
    pub applied_results: BTreeSet<Uuid>,
    pub last_error: Option<ProtocolError>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct PreparedCommand {
    pub command: NotebookCommand,
    pub optimistic_state: NotebookState,
}

#[derive(Debug, Clone, PartialEq, Error)]
pub enum DomainError {
    #[error(transparent)]
    Protocol(#[from] ProtocolError),
    #[error("stale revision: expected {expected}, current {current}")]
    StaleRevision { expected: u64, current: u64 },
    #[error("result does not match a pending command")]
    UnknownResult,
    #[error("result revision is stale")]
    StaleResult,
}

impl NotebookState {
    pub fn new(snapshot: NotebookSnapshot) -> Result<Self, DomainError> {
        validate_snapshot(&snapshot)?;
        Ok(Self {
            snapshot,
            sync_state: SyncState::Synchronized,
            pending: BTreeMap::new(),
            applied_results: BTreeSet::new(),
            last_error: None,
        })
    }

    pub fn prepare(&self, command: NotebookCommand) -> Result<PreparedCommand, DomainError> {
        validate_command(&command)?;
        if let Some(expected) = command.expected_revision
            && expected != self.snapshot.revision
        {
            return Err(DomainError::StaleRevision {
                expected,
                current: self.snapshot.revision,
            });
        }
        let mut next = self.clone();
        let status = match &command.kind {
            NotebookCommandKind::ModifyCells { changes } => {
                apply_optimistic_changes(&mut next.snapshot.cells, changes)?;
                SyncState::Dirty
            }
            NotebookCommandKind::ExecuteCell { .. } | NotebookCommandKind::ExecuteCode { .. } => {
                SyncState::Executing
            }
            NotebookCommandKind::Reconnect => SyncState::Disconnected,
            _ => next.sync_state.clone(),
        };
        next.sync_state = status;
        next.last_error = None;
        next.pending.insert(
            command.command_id,
            PendingCommand {
                command_id: command.command_id,
                idempotency_key: command.idempotency_key.clone(),
                expected_revision: command.expected_revision,
            },
        );
        Ok(PreparedCommand {
            command,
            optimistic_state: next,
        })
    }

    pub fn apply_result(&self, result: CommandResult) -> Result<NotebookState, DomainError> {
        if self.applied_results.contains(&result.command_id) {
            return Ok(self.clone());
        }
        let pending = self
            .pending
            .get(&result.command_id)
            .ok_or(DomainError::UnknownResult)?;
        if pending.idempotency_key != result.idempotency_key {
            return Err(DomainError::UnknownResult);
        }
        if result
            .base_revision
            .is_some_and(|rev| rev < self.snapshot.revision)
        {
            return Err(DomainError::StaleResult);
        }
        let mut next = self.clone();
        next.pending.remove(&result.command_id);
        next.applied_results.insert(result.command_id);
        if let Some(error) = result.error {
            next.sync_state = if error.code == ErrorCode::Disconnected {
                SyncState::Disconnected
            } else {
                SyncState::Error
            };
            next.last_error = Some(error);
            return Ok(next);
        }
        let snapshot = result.snapshot.ok_or_else(|| ProtocolError {
            code: ErrorCode::MalformedResponse,
            message: "successful result omitted snapshot".into(),
            retryable: true,
        })?;
        validate_snapshot(&snapshot)?;
        if snapshot.revision < self.snapshot.revision {
            return Err(DomainError::StaleResult);
        }
        next.snapshot = snapshot;
        next.sync_state = if next.pending.is_empty() {
            SyncState::Synchronized
        } else {
            SyncState::Dirty
        };
        next.last_error = None;
        Ok(next)
    }

    pub fn replace_snapshot(
        &self,
        snapshot: NotebookSnapshot,
    ) -> Result<NotebookState, DomainError> {
        validate_snapshot(&snapshot)?;
        if snapshot.revision < self.snapshot.revision {
            return Err(DomainError::StaleResult);
        }
        let mut next = self.clone();
        next.snapshot = snapshot;
        next.pending.clear();
        next.sync_state = SyncState::Synchronized;
        next.last_error = None;
        Ok(next)
    }
}

fn apply_optimistic_changes(
    cells: &mut Vec<Cell>,
    changes: &[CellMutation],
) -> Result<(), DomainError> {
    for change in changes {
        match change {
            CellMutation::Insert { index, cell } => {
                cells.insert((*index).min(cells.len()), cell.clone())
            }
            CellMutation::Update {
                cell_id,
                source,
                metadata,
                cell_type,
            } => {
                let cell = cells
                    .iter_mut()
                    .find(|c| &c.id == cell_id)
                    .ok_or_else(invalid_cell)?;
                if let Some(source) = source {
                    cell.source.clone_from(source);
                }
                if let Some(metadata) = metadata {
                    cell.metadata.clone_from(metadata);
                }
                if let Some(cell_type) = cell_type {
                    cell.cell_type = cell_type.clone();
                }
            }
            CellMutation::Delete { cell_id } => {
                let index = cells
                    .iter()
                    .position(|c| &c.id == cell_id)
                    .ok_or_else(invalid_cell)?;
                cells.remove(index);
            }
            CellMutation::Move { cell_id, index } => {
                let current = cells
                    .iter()
                    .position(|c| &c.id == cell_id)
                    .ok_or_else(invalid_cell)?;
                let cell = cells.remove(current);
                cells.insert((*index).min(cells.len()), cell);
            }
        }
    }
    Ok(())
}

fn invalid_cell() -> DomainError {
    ProtocolError {
        code: ErrorCode::InvalidInput,
        message: "cell id does not exist".into(),
        retryable: false,
    }
    .into()
}

#[cfg(test)]
mod tests {
    use super::*;
    use notebook_protocol::{
        CellType, KernelIdentity, KernelState, NotebookIdentity, PROTOCOL_VERSION,
    };
    use serde_json::json;
    fn snapshot(revision: u64) -> NotebookSnapshot {
        NotebookSnapshot {
            protocol_version: PROTOCOL_VERSION,
            schema_version: 1,
            notebook: NotebookIdentity {
                path: "demo.ipynb".into(),
                workspace: "local".into(),
            },
            kernel: KernelIdentity {
                name: "python3".into(),
                display_name: "Python 3".into(),
                session_id: None,
                state: KernelState::Idle,
            },
            revision,
            cells: vec![Cell {
                id: "a".into(),
                cell_type: CellType::Code,
                source: "1+1".into(),
                metadata: json!({}),
                execution_count: None,
                outputs: vec![],
            }],
            selected_cell_id: Some("a".into()),
        }
    }
    fn modify(expected: u64) -> NotebookCommand {
        NotebookCommand {
            protocol_version: 1,
            command_id: Uuid::from_u128(1),
            idempotency_key: "one".into(),
            expected_revision: Some(expected),
            timeout_ms: 1000,
            kind: NotebookCommandKind::ModifyCells {
                changes: vec![CellMutation::Update {
                    cell_id: "a".into(),
                    source: Some("2+2".into()),
                    metadata: None,
                    cell_type: None,
                }],
            },
        }
    }
    #[test]
    fn prepare_is_deterministic() {
        let state = NotebookState::new(snapshot(1)).unwrap();
        assert_eq!(
            state.prepare(modify(1)).unwrap(),
            state.prepare(modify(1)).unwrap()
        );
    }
    #[test]
    fn stale_revision_preserves_state() {
        let state = NotebookState::new(snapshot(2)).unwrap();
        assert!(matches!(
            state.prepare(modify(1)),
            Err(DomainError::StaleRevision { .. })
        ));
        assert_eq!(state.snapshot.revision, 2);
    }
    #[test]
    fn duplicate_result_is_idempotent() {
        let state = NotebookState::new(snapshot(1))
            .unwrap()
            .prepare(modify(1))
            .unwrap()
            .optimistic_state;
        let result = CommandResult {
            protocol_version: 1,
            command_id: Uuid::from_u128(1),
            idempotency_key: "one".into(),
            base_revision: Some(1),
            committed_revision: Some(2),
            snapshot: Some(snapshot(2)),
            error: None,
        };
        let applied = state.apply_result(result.clone()).unwrap();
        assert_eq!(applied.apply_result(result).unwrap(), applied);
    }
    #[test]
    fn malformed_success_preserves_prior() {
        let state = NotebookState::new(snapshot(1))
            .unwrap()
            .prepare(modify(1))
            .unwrap()
            .optimistic_state;
        let before = state.clone();
        let result = CommandResult {
            protocol_version: 1,
            command_id: Uuid::from_u128(1),
            idempotency_key: "one".into(),
            base_revision: Some(1),
            committed_revision: Some(2),
            snapshot: None,
            error: None,
        };
        assert!(state.apply_result(result).is_err());
        assert_eq!(state, before);
    }
}
