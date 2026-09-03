//! Cell-owned microscope references and deterministic sidecar identities. No I/O.
use crate::{Cell, ErrorCode, NotebookCommandKind, NotebookSnapshot, ProtocolError};
use serde::{Deserialize, Serialize};
use serde_json::json;

pub const KEY: &str = "didaction_microscopes";
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MicroscopeRef {
    pub id: String,
    pub title: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MicroscopeDocument {
    pub schema_version: u16,
    pub notebook_path: String,
    pub cell_id: String,
    pub microscope: MicroscopeRef,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MicroscopeTarget {
    pub cell_id: String,
    pub microscope_id: String,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Metadata {
    schema_version: u16,
    items: Vec<MicroscopeRef>,
}
fn invalid(message: &str) -> ProtocolError {
    ProtocolError {
        code: ErrorCode::InvalidInput,
        message: message.into(),
        retryable: false,
    }
}
pub fn validate_id(id: &str) -> Result<(), ProtocolError> {
    if id.len() != 7
        || !id
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
    {
        return Err(invalid(
            "Microscope ID must be seven lowercase letters or digits",
        ));
    }
    Ok(())
}
pub fn validate_ref(item: &MicroscopeRef) -> Result<(), ProtocolError> {
    validate_id(&item.id)?;
    if item.title.trim().is_empty()
        || item.title.len() > 128
        || item.title.chars().any(char::is_control)
    {
        return Err(invalid(
            "Microscope title must be 1..128 bytes without control characters",
        ));
    }
    Ok(())
}
pub fn list(cell: &Cell) -> Result<Vec<MicroscopeRef>, ProtocolError> {
    let Some(value) = cell.metadata.get(KEY) else {
        return Ok(vec![]);
    };
    let data: Metadata = serde_json::from_value(value.clone())
        .map_err(|_| invalid("Invalid microscope metadata"))?;
    if data.schema_version != 1 || data.items.len() > 16 {
        return Err(invalid("Unsupported microscope metadata version or count"));
    }
    let mut seen = std::collections::BTreeSet::new();
    for item in &data.items {
        validate_ref(item)?;
        if !seen.insert(&item.id) {
            return Err(invalid("Duplicate microscope ID"));
        }
    }
    Ok(data.items)
}
/// Stable FNV-1a truncated to 28 bits. A locator, not a security token;
/// documents bind the full cell ID so hash collisions fail closed.
pub fn sidecar(path: &str, cell_id: &str, id: &str) -> Result<String, ProtocolError> {
    crate::validate_relative_path(path)?;
    validate_id(id)?;
    let hash = cell_id.bytes().fold(2166136261_u32, |h, b| {
        (h ^ u32::from(b)).wrapping_mul(16777619)
    }) & 0x0fff_ffff;
    let result = format!("{path}.{hash:07x}.{id}");
    crate::validate_relative_path(&result)?;
    Ok(result)
}
pub fn document(
    snapshot: &NotebookSnapshot,
    cell_id: &str,
    id: &str,
) -> Result<MicroscopeDocument, ProtocolError> {
    let cell = snapshot
        .cells
        .iter()
        .find(|c| c.id == cell_id)
        .ok_or_else(|| invalid("Microscope cell not found"))?;
    let item = list(cell)?
        .into_iter()
        .find(|m| m.id == id)
        .ok_or_else(|| invalid("Microscope not found"))?;
    Ok(MicroscopeDocument {
        schema_version: 1,
        notebook_path: snapshot.notebook.path.clone(),
        cell_id: cell_id.into(),
        microscope: item,
    })
}
pub fn prepare(
    snapshot: &mut NotebookSnapshot,
    kind: &NotebookCommandKind,
) -> Result<(), ProtocolError> {
    let (cell_id, id, title) = match kind {
        NotebookCommandKind::CreateMicroscope {
            cell_id,
            microscope_id,
            title,
        } => (cell_id, microscope_id, Some(title)),
        NotebookCommandKind::DeleteMicroscope {
            cell_id,
            microscope_id,
        } => (cell_id, microscope_id, None),
        NotebookCommandKind::ReadMicroscope {
            cell_id,
            microscope_id,
        } => {
            document(snapshot, cell_id, microscope_id)?;
            return Ok(());
        }
        _ => return Ok(()),
    };
    sidecar(&snapshot.notebook.path, cell_id, id)?;
    let cell = snapshot
        .cells
        .iter_mut()
        .find(|c| &c.id == cell_id)
        .ok_or_else(|| invalid("Microscope cell not found"))?;
    let mut items = list(cell)?;
    if let Some(title) = title {
        if items.iter().any(|m| &m.id == id) || items.len() >= 16 {
            return Err(invalid("Microscope ID exists or cell limit reached"));
        }
        items.push(MicroscopeRef {
            id: id.clone(),
            title: title.clone(),
        });
    } else {
        if !items.iter().any(|m| &m.id == id) {
            return Err(invalid("Microscope not found"));
        }
        items.retain(|m| &m.id != id);
    }
    let metadata = cell
        .metadata
        .as_object_mut()
        .ok_or_else(|| invalid("Cell metadata must be an object"))?;
    if items.is_empty() {
        metadata.remove(KEY);
    } else {
        metadata.insert(KEY.into(), json!({"schema_version":1,"items":items}));
    }
    Ok(())
}
/// Ordinary cell edits cannot forge references or orphan sidecars.
pub fn preserve_references(
    before: &NotebookSnapshot,
    after: &NotebookSnapshot,
) -> Result<(), ProtocolError> {
    for cell in &before.cells {
        let old = list(cell)?;
        let new = after
            .cells
            .iter()
            .find(|c| c.id == cell.id)
            .map(list)
            .transpose()?
            .unwrap_or_default();
        if old != new {
            return Err(invalid(
                "Delete microscopes first; microscope references require dedicated commands",
            ));
        }
    }
    for cell in &after.cells {
        if !before.cells.iter().any(|c| c.id == cell.id) && !list(cell)?.is_empty() {
            return Err(invalid("New cells cannot copy microscope references"));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn snapshot() -> NotebookSnapshot {
        serde_json::from_value(json!({"protocol_version":1,"schema_version":1,"revision":0,
          "notebook":{"path":"lessons/demo.ipynb","workspace":"local"},
          "kernel":{"name":"python3","display_name":"Python","state":"idle"},
          "selected_cell_id":"cell-a","cells":[{"id":"cell-a","cell_type":"code","source":"42","metadata":{"keep":true},"outputs":[],"execution_count":null}]
        })).unwrap()
    }
    #[test]
    fn lifecycle_preserves_metadata_and_derives_stable_identity() {
        let mut state = snapshot();
        let create = NotebookCommandKind::CreateMicroscope {
            cell_id: "cell-a".into(),
            microscope_id: "abc1234".into(),
            title: "A closer look".into(),
        };
        prepare(&mut state, &create).unwrap();
        let doc = document(&state, "cell-a", "abc1234").unwrap();
        assert_eq!(
            serde_json::from_str::<MicroscopeDocument>(&serde_json::to_string(&doc).unwrap())
                .unwrap(),
            doc
        );
        assert!(
            sidecar(&doc.notebook_path, &doc.cell_id, &doc.microscope.id)
                .unwrap()
                .starts_with("lessons/demo.ipynb.")
        );
        assert_eq!(state.cells[0].metadata["keep"], true);
        assert!(prepare(&mut state, &create).is_err());
        let mut ordinary = state.clone();
        ordinary.cells.clear();
        assert!(preserve_references(&state, &ordinary).is_err());
        prepare(
            &mut state,
            &NotebookCommandKind::DeleteMicroscope {
                cell_id: "cell-a".into(),
                microscope_id: "abc1234".into(),
            },
        )
        .unwrap();
        assert!(list(&state.cells[0]).unwrap().is_empty());
        assert_eq!(state.cells[0].metadata["keep"], true);
    }
    #[test]
    fn rejects_bad_ids_versions_titles_and_reference_forgery() {
        for id in ["../xxxx", "ABC1234", "short", "12345678"] {
            assert!(validate_id(id).is_err());
        }
        for title in ["", "\n"] {
            assert!(
                validate_ref(&MicroscopeRef {
                    id: "abc1234".into(),
                    title: title.into()
                })
                .is_err()
            );
        }
        let old = snapshot();
        let mut next = old.clone();
        next.cells[0].metadata[KEY] = json!({"schema_version":99,"items":[]});
        assert!(list(&next.cells[0]).is_err());
        next.cells[0].metadata[KEY] =
            json!({"schema_version":1,"items":[{"id":"abc1234","title":"One"}]});
        assert!(preserve_references(&old, &next).is_err());
    }
}
