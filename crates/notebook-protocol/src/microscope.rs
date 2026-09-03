//! Cell-owned microscope references and deterministic sidecar identities. No I/O.
use crate::{Cell, ErrorCode, NotebookCommandKind, NotebookSnapshot, ProtocolError};
use serde::{Deserialize, Serialize};
use serde_json::json;

pub const KEY: &str = "didaction_microscopes";
pub const MAX_DOCUMENT_BYTES: usize = 512_000;
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Walkthrough {
    pub title: String,
    pub steps: Vec<WalkthroughStep>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WalkthroughStep {
    pub id: String,
    pub title: String,
    pub code: String,
    pub markdown: String,
    /// Complete, self-contained source for a fresh temporary kernel.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub playground_code: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub graphics: Option<GraphicsDefinition>,
    #[serde(default)]
    pub annotations: Vec<Annotation>,
    /// Optional stage composition. Empty retains the canonical readable layout.
    #[serde(default)]
    pub overlays: Vec<WalkthroughOverlay>,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WalkthroughOverlayKind {
    Code,
    Markdown,
    Annotations,
    Playground,
    GraphicsControls,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OverlayBounds {
    /// Thousandths of the stage width/height.
    pub x: u16,
    pub y: u16,
    pub width: u16,
    pub height: u16,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WalkthroughOverlay {
    pub id: String,
    pub kind: WalkthroughOverlayKind,
    pub bounds: OverlayBounds,
    /// Required only for Markdown overlays; permits multiple independent blocks.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub markdown: Option<String>,
}
/// Executable source, not a scene description. Imports/capabilities are checked
/// again by the browser before instantiation; validating source never executes it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GraphicsDefinition {
    pub language: GraphicsLanguage,
    pub source: String,
    pub description: String,
    /// Optional owned source attachment, relative to the microscope sidecar.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub artifact: Option<String>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum GraphicsLanguage {
    #[serde(rename = "assemblyscript-rgba-1")]
    AssemblyScriptRgba1,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Annotation {
    pub id: String,
    pub start_line: usize,
    pub end_line: usize,
    /// Optional one-based inclusive Unicode-scalar columns within a single line.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub start_column: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub end_column: Option<usize>,
    pub text: String,
    #[serde(default)]
    pub color: AnnotationColor,
}
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AnnotationColor {
    #[default]
    Blue,
    BlueLight,
    BlueDeep,
}
#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WalkthroughFocus {
    pub step_index: usize,
    #[serde(default)]
    pub annotation_id: Option<String>,
}
pub fn validate_walkthrough(w: &Walkthrough) -> Result<(), ProtocolError> {
    fn title(s: &str) -> bool {
        !s.trim().is_empty() && s.len() <= 128 && !s.chars().any(char::is_control)
    }
    fn id(s: &str) -> bool {
        !s.is_empty()
            && s.len() <= 64
            && s.bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    }
    if !title(&w.title) || w.steps.is_empty() || w.steps.len() > 64 {
        return Err(invalid("Walkthrough needs a title and 1..64 steps"));
    }
    let mut steps = std::collections::BTreeSet::new();
    let mut artifacts = std::collections::BTreeSet::new();
    for s in &w.steps {
        let mut overlay_ids = std::collections::BTreeSet::new();
        if let Some(name) = s.graphics.as_ref().and_then(|g| g.artifact.as_ref())
            && (!valid_graphics_artifact(name) || !artifacts.insert(name))
        {
            return Err(invalid(
                "Graphics artifacts need unique safe names ending in .ts",
            ));
        }
        if !id(&s.id)
            || !steps.insert(&s.id)
            || !title(&s.title)
            || s.code.len() > 64_000
            || s.markdown.len() > 64_000
            || s.playground_code
                .as_ref()
                .is_some_and(|code| code.len() > 64_000 || code.trim().is_empty())
            || s.annotations.len() > 32
            || s.overlays.len() > 32
            || s.overlays.iter().any(|overlay| {
                !id(&overlay.id)
                    || !overlay_ids.insert(&overlay.id)
                    || overlay.bounds.width < 25
                    || overlay.bounds.height < 25
                    || u32::from(overlay.bounds.x) + u32::from(overlay.bounds.width) > 1000
                    || u32::from(overlay.bounds.y) + u32::from(overlay.bounds.height) > 1000
                    || match overlay.kind {
                        WalkthroughOverlayKind::Markdown => overlay
                            .markdown
                            .as_ref()
                            .is_none_or(|text| text.len() > 64_000),
                        _ => overlay.markdown.is_some(),
                    }
            })
            || s.graphics.as_ref().is_some_and(|g| {
                g.source.trim().is_empty()
                    || g.source.len() > 64_000
                    || g.description.trim().is_empty()
                    || g.description.len() > 1024
            })
        {
            return Err(invalid("Invalid or oversized walkthrough step"));
        }
        let mut annotations = std::collections::BTreeSet::new();
        for a in &s.annotations {
            let columns_valid = match (a.start_column, a.end_column) {
                (None, None) => true,
                (Some(start), Some(end)) => {
                    let line_len = s
                        .code
                        .split('\n')
                        .nth(a.start_line.saturating_sub(1))
                        .map(str::chars)
                        .map(Iterator::count)
                        .unwrap_or(0);
                    a.start_line == a.end_line && start > 0 && end >= start && end <= line_len
                }
                _ => false,
            };
            if !id(&a.id)
                || !annotations.insert(&a.id)
                || a.start_line == 0
                || a.end_line < a.start_line
                || a.end_line > s.code.split('\n').count()
                || a.text.trim().is_empty()
                || a.text.len() > 4096
                || !columns_valid
            {
                return Err(invalid(
                    "Invalid annotation ID, text, line range, or optional inclusive one-based character range",
                ));
            }
        }
    }
    if serde_json::to_vec(w)
        .map_err(|_| invalid("Invalid walkthrough"))?
        .len()
        > MAX_DOCUMENT_BYTES - 4096
    {
        return Err(invalid("Walkthrough exceeds aggregate size limit"));
    }
    Ok(())
}
fn valid_graphics_artifact(name: &str) -> bool {
    name.len() > 3
        && name.len() <= 80
        && name.ends_with(".ts")
        && name.as_bytes()[0].is_ascii_alphanumeric()
        && name[..name.len() - 3]
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}
/// Derived owned files only; never accept an arbitrary workspace path.
pub fn graphics_artifacts(
    doc: &MicroscopeDocument,
) -> Result<std::collections::BTreeMap<String, String>, ProtocolError> {
    let mut files = std::collections::BTreeMap::new();
    let base = sidecar(&doc.notebook_path, &doc.cell_id, &doc.microscope.id)?;
    if let Some(w) = &doc.walkthrough {
        validate_walkthrough(w)?;
        for step in &w.steps {
            if let Some(g) = &step.graphics
                && let Some(name) = &g.artifact
            {
                let path = format!("{base}.{name}");
                if path.len() > 512 {
                    return Err(invalid("Graphics artifact path exceeds limit"));
                }
                files.insert(path, g.source.clone());
            }
        }
    }
    Ok(files)
}
pub fn validate_focus(w: &Walkthrough, focus: &WalkthroughFocus) -> Result<(), ProtocolError> {
    let step = w
        .steps
        .get(focus.step_index)
        .ok_or_else(|| invalid("Walkthrough step index out of range"))?;
    if focus
        .annotation_id
        .as_ref()
        .is_some_and(|id| !step.annotations.iter().any(|a| &a.id == id))
    {
        return Err(invalid("Annotation not found in this step"));
    }
    Ok(())
}

pub fn playground_snapshot(
    doc: &MicroscopeDocument,
    index: usize,
    kernel: &str,
) -> Result<NotebookSnapshot, ProtocolError> {
    let w = doc
        .walkthrough
        .as_ref()
        .ok_or_else(|| invalid("Microscope requires a walkthrough"))?;
    validate_walkthrough(w)?;
    let code = w
        .steps
        .get(index)
        .and_then(|s| s.playground_code.as_ref())
        .ok_or_else(|| invalid("This step has no playground code"))?;
    let snapshot: NotebookSnapshot = serde_json::from_value(json!({
        "protocol_version":1,"schema_version":1,"revision":0,
        "notebook":{"path":"playground.ipynb","workspace":"temporary"},
        "kernel":{"name":kernel,"display_name":kernel,"session_id":null,"state":"idle"},
        "selected_cell_id":"playground",
        "cells":[{"id":"playground","cell_type":"code","source":code,"metadata":{},"execution_count":null,"outputs":[]}]
    })).map_err(|_| invalid("Invalid playground snapshot"))?;
    crate::validate_snapshot(&snapshot)?;
    Ok(snapshot)
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MicroscopeRef {
    pub id: String,
    pub title: String,
    #[serde(default, skip_serializing_if = "is_zero")]
    pub revision: u64,
}
fn is_zero(n: &u64) -> bool {
    *n == 0
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MicroscopeDocument {
    pub schema_version: u16,
    pub notebook_path: String,
    pub cell_id: String,
    pub microscope: MicroscopeRef,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub walkthrough: Option<Walkthrough>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MicroscopeTarget {
    pub cell_id: String,
    pub microscope_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub focus: Option<WalkthroughFocus>,
    #[serde(default, skip_serializing_if = "is_zero")]
    pub revision: u64,
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
        walkthrough: None,
    })
}
pub fn validate_document(
    doc: &MicroscopeDocument,
    expected: &MicroscopeDocument,
) -> Result<(), ProtocolError> {
    if doc.schema_version != 1
        || doc.notebook_path != expected.notebook_path
        || doc.cell_id != expected.cell_id
        || doc.microscope != expected.microscope
    {
        return Err(invalid("Microscope document identity or revision mismatch"));
    }
    if let Some(w) = &doc.walkthrough {
        validate_walkthrough(w)?;
    }
    if serde_json::to_vec(doc)
        .map_err(|_| invalid("Invalid microscope"))?
        .len()
        > MAX_DOCUMENT_BYTES
    {
        return Err(invalid("Microscope document exceeds limit"));
    }
    Ok(())
}
pub fn prepare(
    snapshot: &mut NotebookSnapshot,
    kind: &NotebookCommandKind,
) -> Result<(), ProtocolError> {
    if let NotebookCommandKind::SetMicroscopeWalkthrough {
        cell_id,
        microscope_id,
        walkthrough,
    } = kind
    {
        validate_walkthrough(walkthrough)?;
        document(snapshot, cell_id, microscope_id)?;
        let cell = snapshot
            .cells
            .iter_mut()
            .find(|c| &c.id == cell_id)
            .ok_or_else(|| invalid("Cell not found"))?;
        let mut items = list(cell)?;
        let item = items
            .iter_mut()
            .find(|m| &m.id == microscope_id)
            .ok_or_else(|| invalid("Microscope not found"))?;
        item.revision = item
            .revision
            .checked_add(1)
            .ok_or_else(|| invalid("Microscope revision limit"))?;
        item.title = walkthrough.title.clone();
        cell.metadata
            .as_object_mut()
            .ok_or_else(|| invalid("Invalid metadata"))?
            .insert(KEY.into(), json!({"schema_version":1,"items":items}));
        return Ok(());
    }
    let (cell_id, id, title) = match kind {
        NotebookCommandKind::CreateMicroscope {
            cell_id,
            microscope_id,
            title,
            walkthrough,
        } => {
            validate_walkthrough(walkthrough)?;
            (cell_id, microscope_id, Some(title))
        }
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
            revision: 0,
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
    #[test]
    fn graphics_source_is_bounded_versioned_and_round_trips() {
        let value = serde_json::json!({"title":"Graphics", "steps":[{"id":"one","title":"One","code":"", "markdown":"", "graphics": {
            "language":"assemblyscript-rgba-1", "description":"Animated example", "source":"export function render():usize { return 0; }"
        }}]});
        let w: super::Walkthrough = serde_json::from_value(value.clone()).unwrap();
        super::validate_walkthrough(&w).unwrap();
        let mut attached = w.clone();
        attached.steps[0].graphics.as_mut().unwrap().artifact = Some("orbit.ts".into());
        super::validate_walkthrough(&attached).unwrap();
        for name in [
            "../orbit.ts",
            "dir/orbit.ts",
            "/orbit.ts",
            "orbit.js",
            ".ts",
            "a.b.ts",
            "é.ts",
        ] {
            let mut bad = attached.clone();
            bad.steps[0].graphics.as_mut().unwrap().artifact = Some(name.into());
            assert!(super::validate_walkthrough(&bad).is_err(), "{name}");
        }
        let mut duplicate = attached.steps[0].clone();
        duplicate.id = "two".into();
        attached.steps.push(duplicate);
        assert!(super::validate_walkthrough(&attached).is_err());
        assert_eq!(
            serde_json::from_str::<super::Walkthrough>(&serde_json::to_string(&w).unwrap())
                .unwrap(),
            w
        );
        for source in [" ".into(), "x".repeat(64001)] {
            let mut bad = w.clone();
            bad.steps[0].graphics.as_mut().unwrap().source = source;
            assert!(super::validate_walkthrough(&bad).is_err());
        }
        let mut bad = value;
        bad["steps"][0]["graphics"]["language"] = serde_json::json!("javascript");
        assert!(serde_json::from_value::<super::Walkthrough>(bad).is_err());
    }
    use super::*;
    #[test]
    fn walkthrough_bounds_focus_and_ownership_are_validated() {
        let w: Walkthrough = serde_json::from_value(json!({"title":"Explain","steps":[{"id":"one","title":"First","code":"x = 42\nx","markdown":"**Value**","annotations":[{"id":"value","start_line":1,"end_line":2,"text":"Shared variable","color":"blue"}],"overlays":[{"id":"code","kind":"code","bounds":{"x":20,"y":20,"width":500,"height":800}},{"id":"note","kind":"markdown","bounds":{"x":550,"y":20,"width":400,"height":200},"markdown":"Placed note"}]}]})).unwrap();
        validate_walkthrough(&w).unwrap();
        let encoded = serde_json::to_string(&w).unwrap();
        assert_eq!(serde_json::from_str::<Walkthrough>(&encoded).unwrap(), w);
        let mut outside = w.clone();
        outside.steps[0].overlays[0].bounds.x = 900;
        assert!(validate_walkthrough(&outside).is_err());
        assert!(
            validate_focus(
                &w,
                &WalkthroughFocus {
                    step_index: 0,
                    annotation_id: Some("value".into())
                }
            )
            .is_ok()
        );
        assert!(
            validate_focus(
                &w,
                &WalkthroughFocus {
                    step_index: 1,
                    annotation_id: None
                }
            )
            .is_err()
        );
        assert!(
            validate_focus(
                &w,
                &WalkthroughFocus {
                    step_index: 0,
                    annotation_id: Some("missing".into())
                }
            )
            .is_err()
        );
        for mutate in 0..8 {
            let mut bad = w.clone();
            match mutate {
                0 => bad.steps[0].annotations[0].start_line = 0,
                1 => bad.steps[0].annotations[0].end_line = 3,
                2 => bad.steps.push(bad.steps[0].clone()),
                3 => {
                    let duplicate = bad.steps[0].annotations[0].clone();
                    bad.steps[0].annotations.push(duplicate);
                }
                4 => bad.steps[0].code = "a".repeat(64001),
                5 => bad.steps[0].playground_code = Some(" ".into()),
                6 => bad.steps[0].playground_code = Some("a".repeat(64001)),
                _ => bad.steps.clear(),
            }
            assert!(validate_walkthrough(&bad).is_err());
        }
        let mut state = snapshot();
        prepare(
            &mut state,
            &NotebookCommandKind::CreateMicroscope {
                cell_id: "cell-a".into(),
                microscope_id: "abc1234".into(),
                title: "Example".into(),
                walkthrough: w.clone(),
            },
        )
        .unwrap();
        let old = document(&state, "cell-a", "abc1234").unwrap();
        let mut playable = old.clone();
        let mut content = w.clone();
        content.steps[0].playground_code = Some("setup = 42\nprint(setup)".into());
        playable.walkthrough = Some(content);
        let temporary = playground_snapshot(&playable, 0, "python3").unwrap();
        assert_eq!(temporary.cells.len(), 1);
        assert_eq!(temporary.cells[0].source, "setup = 42\nprint(setup)");
        assert!(temporary.cells[0].outputs.is_empty());
        assert!(playground_snapshot(&playable, 1, "python3").is_err());
        assert!(playground_snapshot(&old, 0, "python3").is_err());
        prepare(
            &mut state,
            &NotebookCommandKind::SetMicroscopeWalkthrough {
                cell_id: "cell-a".into(),
                microscope_id: "abc1234".into(),
                walkthrough: w.clone(),
            },
        )
        .unwrap();
        let expected = document(&state, "cell-a", "abc1234").unwrap();
        assert_eq!(expected.microscope.revision, 1);
        let mut updated = expected.clone();
        updated.walkthrough = Some(w);
        validate_document(&updated, &expected).unwrap();
        assert!(validate_document(&updated, &old).is_err());
        updated.cell_id = "different".into();
        assert!(validate_document(&updated, &expected).is_err());
        assert!(
            serde_json::from_value::<Walkthrough>(
                json!({"title":"x","steps":[],"script":"alert(1)"})
            )
            .is_err()
        );
    }
    #[test]
    fn character_annotations_are_paired_single_line_unicode_ranges() {
        let mut w: Walkthrough = serde_json::from_value(json!({
            "title":"Characters", "steps":[{"id":"one","title":"One",
            "code":"α🙂x\nnext", "markdown":"Text", "annotations":[{
                "id":"span","start_line":1,"end_line":1,
                "start_column":2,"end_column":3,"text":"Two characters"
            }]}]
        }))
        .unwrap();
        validate_walkthrough(&w).unwrap();
        assert_eq!(
            serde_json::from_value::<Walkthrough>(serde_json::to_value(&w).unwrap()).unwrap(),
            w
        );
        for (start, end, end_line) in [
            (Some(0), Some(1), 1),
            (Some(2), Some(1), 1),
            (Some(1), Some(4), 1),
            (Some(1), None, 1),
            (None, Some(1), 1),
            (Some(1), Some(2), 2),
        ] {
            let a = &mut w.steps[0].annotations[0];
            a.start_column = start;
            a.end_column = end;
            a.end_line = end_line;
            assert!(validate_walkthrough(&w).is_err());
        }
        let a = &mut w.steps[0].annotations[0];
        a.start_column = None;
        a.end_column = None;
        validate_walkthrough(&w).unwrap();
        assert!(
            serde_json::to_value(&w).unwrap()["steps"][0]["annotations"][0]
                .get("start_column")
                .is_none()
        );
    }
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
            walkthrough: serde_json::from_value(json!({"title":"A closer look","steps":[{"id":"one","title":"One","code":"42","markdown":"Example"}]})).unwrap(),
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
                    title: title.into(),
                    revision: 0,
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
