use base64::Engine as _;
use egui::text::{CCursor, CCursorRange, LayoutJob, TextFormat};
use egui::{Color32, CornerRadius, FontId, Key, Margin, RichText, Stroke, TextEdit};
use egui_code_editor::{CodeEditor, ColorTheme, Syntax};
use egui_commonmark::{CommonMarkCache, CommonMarkViewer};
use notebook_core::{NotebookState, SyncState};
use notebook_protocol::{
    Cell, CellMutation, CellOutput, CellType, CompletionReply, InspectionReply, NotebookCommand,
    NotebookCommandKind, PROTOCOL_VERSION,
};
use std::collections::{BTreeMap, HashMap, HashSet, VecDeque, hash_map::DefaultHasher};
use std::hash::{Hash, Hasher};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;
use uuid::Uuid;

const MAX_EMBEDDED_IMAGE_BYTES: usize = 8 * 1024 * 1024;

#[derive(Default)]
struct DataImageBytesLoader;

impl DataImageBytesLoader {
    const ID: &'static str = egui::generate_loader_id!(DataImageBytesLoader);
}

impl egui::load::BytesLoader for DataImageBytesLoader {
    fn id(&self) -> &str {
        Self::ID
    }

    fn load(&self, _ctx: &egui::Context, uri: &str) -> egui::load::BytesLoadResult {
        let Some((header, encoded)) = uri.split_once(',') else {
            return Err(egui::load::LoadError::NotSupported);
        };
        let mime = header
            .strip_prefix("data:")
            .and_then(|header| header.strip_suffix(";base64"))
            .filter(|mime| {
                matches!(
                    *mime,
                    "image/png" | "image/jpeg" | "image/gif" | "image/webp" | "image/svg+xml"
                )
            })
            .ok_or(egui::load::LoadError::NotSupported)?;
        if encoded.len() > MAX_EMBEDDED_IMAGE_BYTES.saturating_mul(4).div_ceil(3) {
            return Err(egui::load::LoadError::Loading(
                "embedded Markdown image exceeds the 8 MiB limit".into(),
            ));
        }
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .map_err(|_| egui::load::LoadError::Loading("invalid base64 image data".into()))?;
        if bytes.len() > MAX_EMBEDDED_IMAGE_BYTES {
            return Err(egui::load::LoadError::Loading(
                "embedded Markdown image exceeds the 8 MiB limit".into(),
            ));
        }
        Ok(egui::load::BytesPoll::Ready {
            size: None,
            bytes: egui::load::Bytes::Shared(bytes.into()),
            mime: Some(mime.to_owned()),
        })
    }

    fn forget(&self, _uri: &str) {}

    fn forget_all(&self) {}

    fn byte_size(&self) -> usize {
        0
    }
}

fn install_data_image_loader(ctx: &egui::Context) {
    if !ctx.is_loader_installed(DataImageBytesLoader::ID) {
        ctx.add_bytes_loader(Arc::new(DataImageBytesLoader));
    }
}

fn decode_rich_image(_mime: &str, data: &str) -> Result<Vec<u8>, base64::DecodeError> {
    base64::engine::general_purpose::STANDARD.decode(data)
}

fn rich_image_uri(mime: &str, data: &str) -> String {
    let mut hasher = DefaultHasher::new();
    mime.hash(&mut hasher);
    data.hash(&mut hasher);
    let extension = if mime == "image/svg+xml" {
        "svg"
    } else {
        "png"
    };
    format!(
        "bytes://notebook-output/{:016x}.{extension}",
        hasher.finish()
    )
}

fn png_dimensions(bytes: &[u8]) -> Option<(u32, u32)> {
    if bytes.len() < 24 || &bytes[..16] != b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR" {
        return None;
    }
    let width = u32::from_be_bytes(bytes[16..20].try_into().ok()?);
    let height = u32::from_be_bytes(bytes[20..24].try_into().ok()?);
    (width > 0 && height > 0 && width <= 16_384 && height <= 16_384).then_some((width, height))
}

fn cell_has_completed_execution(cell: &Cell) -> bool {
    cell.cell_type == CellType::Code && cell.execution_count.is_some()
}

pub struct NotebookEguiApp {
    pub state: NotebookState,
    outbound: VecDeque<NotebookCommand>,
    editors: Vec<(String, String)>,
    dirty_editors: HashSet<String>,
    completion_suggestions: HashMap<String, CompletionReply>,
    completion_selection: HashMap<String, usize>,
    pending_caret_positions: HashMap<String, usize>,
    pending_completions: BTreeMap<Uuid, String>,
    pending_inspections: BTreeMap<Uuid, String>,
    pending_execution_cells: BTreeMap<Uuid, String>,
    inspections: HashMap<String, String>,
    caret_byte_positions: HashMap<String, usize>,
    completion_due: HashMap<String, f64>,
    dragging_cell: Option<String>,
    rendered_markdown: HashSet<String>,
    edit_mode: bool,
    pending_editor_focus: Option<String>,
    cell_clipboard: Vec<Cell>,
    undo_stack: Vec<Vec<CellMutation>>,
    redo_stack: Vec<Vec<CellMutation>>,
    suppress_history: bool,
    collapsed_cells: HashSet<String>,
    collapsed_outputs: HashSet<String>,
    hidden_line_numbers: HashSet<String>,
    find_open: bool,
    find_query: String,
    replace_query: String,
    autosave_due: Option<f64>,
    selected_cells: HashSet<String>,
    rename_open: bool,
    rename_path: String,
    restart_confirmation: bool,
    markdown_cache: CommonMarkCache,
    math_cache: Arc<Mutex<MathRenderCache>>,
}

impl NotebookEguiApp {
    pub fn new(state: NotebookState) -> Self {
        let editors = state
            .snapshot
            .cells
            .iter()
            .map(|c| (c.id.clone(), c.source.clone()))
            .collect();
        let rendered_markdown = state
            .snapshot
            .cells
            .iter()
            .filter(|cell| cell.cell_type == CellType::Markdown)
            .map(|cell| cell.id.clone())
            .collect();
        Self {
            state,
            outbound: VecDeque::new(),
            editors,
            dirty_editors: HashSet::new(),
            completion_suggestions: HashMap::new(),
            completion_selection: HashMap::new(),
            pending_caret_positions: HashMap::new(),
            pending_completions: BTreeMap::new(),
            pending_inspections: BTreeMap::new(),
            pending_execution_cells: BTreeMap::new(),
            inspections: HashMap::new(),
            caret_byte_positions: HashMap::new(),
            completion_due: HashMap::new(),
            dragging_cell: None,
            rendered_markdown,
            edit_mode: false,
            pending_editor_focus: None,
            cell_clipboard: Vec::new(),
            undo_stack: Vec::new(),
            redo_stack: Vec::new(),
            suppress_history: false,
            collapsed_cells: HashSet::new(),
            collapsed_outputs: HashSet::new(),
            hidden_line_numbers: HashSet::new(),
            find_open: false,
            find_query: String::new(),
            replace_query: String::new(),
            autosave_due: None,
            selected_cells: HashSet::new(),
            rename_open: false,
            rename_path: String::new(),
            restart_confirmation: false,
            markdown_cache: CommonMarkCache::default(),
            math_cache: Arc::new(Mutex::new(MathRenderCache::default())),
        }
    }
    pub fn apply_completion(&mut self, command_id: Uuid, completion: CompletionReply) {
        if let Some(cell_id) = self.pending_completions.remove(&command_id) {
            self.completion_selection.insert(cell_id.clone(), 0);
            self.completion_suggestions.insert(cell_id, completion);
        }
    }
    pub fn apply_inspection(&mut self, command_id: Uuid, inspection: InspectionReply) {
        if let Some(cell_id) = self.pending_inspections.remove(&command_id) {
            if inspection.found && !inspection.text.is_empty() {
                self.inspections.insert(cell_id, inspection.text);
            } else {
                self.inspections.remove(&cell_id);
            }
        }
    }
    pub fn drain_commands(&mut self) -> Vec<NotebookCommand> {
        self.outbound.drain(..).collect()
    }
    pub fn finish_command(&mut self, command_id: Uuid) {
        self.pending_execution_cells.remove(&command_id);
    }
    pub fn replace_state(&mut self, state: NotebookState) {
        let previous_markdown: HashSet<_> = self
            .state
            .snapshot
            .cells
            .iter()
            .filter(|cell| cell.cell_type == CellType::Markdown)
            .map(|cell| cell.id.clone())
            .collect();
        let selected = self.state.snapshot.selected_cell_id.clone();
        self.state = state;
        if let Some(selected) = selected
            && self
                .state
                .snapshot
                .cells
                .iter()
                .any(|cell| cell.id == selected)
        {
            self.state.snapshot.selected_cell_id = Some(selected);
        }
        let current_markdown: HashSet<_> = self
            .state
            .snapshot
            .cells
            .iter()
            .filter(|cell| cell.cell_type == CellType::Markdown)
            .map(|cell| cell.id.clone())
            .collect();
        self.rendered_markdown
            .retain(|cell_id| current_markdown.contains(cell_id));
        self.rendered_markdown
            .extend(current_markdown.difference(&previous_markdown).cloned());
        let current_cells = self
            .state
            .snapshot
            .cells
            .iter()
            .map(|cell| cell.id.as_str())
            .collect::<HashSet<_>>();
        self.collapsed_outputs
            .retain(|cell_id| current_cells.contains(cell_id.as_str()));
        self.editors = self
            .state
            .snapshot
            .cells
            .iter()
            .map(|c| (c.id.clone(), c.source.clone()))
            .collect();
        self.dirty_editors.clear();
    }
    fn emit(&mut self, kind: NotebookCommandKind) {
        if !self.suppress_history
            && let NotebookCommandKind::ModifyCells { changes } = &kind
            && let Some(inverse) = inverse_cell_changes(&self.state.snapshot.cells, changes)
        {
            self.undo_stack.push(inverse);
            self.redo_stack.clear();
        }
        let command_id = Uuid::new_v4();
        if let NotebookCommandKind::ExecuteCell { cell_id } = &kind {
            self.pending_execution_cells
                .insert(command_id, cell_id.clone());
        }
        self.outbound.push_back(NotebookCommand {
            protocol_version: PROTOCOL_VERSION,
            command_id,
            idempotency_key: Uuid::new_v4().to_string(),
            expected_revision: Some(self.state.snapshot.revision),
            timeout_ms: 30_000,
            kind,
        });
    }
    fn request_completion(&mut self, cell: &Cell) {
        let code = self.editor_source(cell);
        let cursor_pos = self
            .caret_byte_positions
            .get(&cell.id)
            .copied()
            .unwrap_or(code.len())
            .min(code.len());
        let command_id = Uuid::new_v4();
        self.pending_completions.insert(command_id, cell.id.clone());
        self.outbound.push_back(NotebookCommand {
            protocol_version: PROTOCOL_VERSION,
            command_id,
            idempotency_key: Uuid::new_v4().to_string(),
            expected_revision: Some(self.state.snapshot.revision),
            timeout_ms: 10_000,
            kind: NotebookCommandKind::Complete { cursor_pos, code },
        });
    }
    fn request_inspection(&mut self, cell: &Cell) {
        let code = self.editor_source(cell);
        let cursor_pos = self
            .caret_byte_positions
            .get(&cell.id)
            .copied()
            .unwrap_or(code.len())
            .min(code.len());
        let command_id = Uuid::new_v4();
        self.pending_inspections.insert(command_id, cell.id.clone());
        self.outbound.push_back(NotebookCommand {
            protocol_version: PROTOCOL_VERSION,
            command_id,
            idempotency_key: Uuid::new_v4().to_string(),
            expected_revision: Some(self.state.snapshot.revision),
            timeout_ms: 10_000,
            kind: NotebookCommandKind::Inspect { code, cursor_pos },
        });
    }
    fn close_completion(&mut self, cell_id: &str) {
        self.completion_suggestions.remove(cell_id);
        self.completion_selection.remove(cell_id);
    }
    fn accept_completion(&mut self, cell_id: &str) {
        let Some(completion) = self.completion_suggestions.get(cell_id).cloned() else {
            return;
        };
        let index = self
            .completion_selection
            .get(cell_id)
            .copied()
            .unwrap_or_default()
            .min(completion.matches.len().saturating_sub(1));
        let Some(value) = completion.matches.get(index) else {
            self.close_completion(cell_id);
            return;
        };
        if let Some((_, editor)) = self.editors.iter_mut().find(|(id, _)| id == cell_id) {
            let start = completion.cursor_start.min(editor.len());
            let end = completion.cursor_end.min(editor.len()).max(start);
            if editor.is_char_boundary(start) && editor.is_char_boundary(end) {
                editor.replace_range(start..end, value);
                let caret = editor[..start + value.len()].chars().count();
                self.pending_caret_positions
                    .insert(cell_id.to_owned(), caret);
                self.dirty_editors.insert(cell_id.to_owned());
            }
        }
        self.close_completion(cell_id);
    }
    fn editor_source(&self, cell: &Cell) -> String {
        self.editors
            .iter()
            .find(|(id, _)| id == &cell.id)
            .map_or_else(|| cell.source.clone(), |(_, source)| source.clone())
    }
    fn flush_editor(&mut self, cell: &Cell) {
        if self.dirty_editors.remove(&cell.id) {
            self.emit(NotebookCommandKind::ModifyCells {
                changes: vec![CellMutation::Update {
                    cell_id: cell.id.clone(),
                    source: Some(self.editor_source(cell)),
                    metadata: None,
                    cell_type: Some(cell.cell_type.clone()),
                }],
            });
        }
    }
    fn selected_cell(&self) -> Option<(usize, Cell)> {
        let selected = self.state.snapshot.selected_cell_id.as_ref()?;
        self.state
            .snapshot
            .cells
            .iter()
            .position(|cell| &cell.id == selected)
            .map(|index| (index, self.state.snapshot.cells[index].clone()))
    }
    fn save_visible_edits(&mut self) {
        for cell in self.state.snapshot.cells.clone() {
            self.flush_editor(&cell);
        }
    }
    fn execute_selected(&mut self) {
        if let Some((_, cell)) = self.selected_cell()
            && cell.cell_type == CellType::Code
        {
            self.flush_editor(&cell);
            self.emit(NotebookCommandKind::ExecuteCell { cell_id: cell.id });
        }
    }
    fn execute_cell(&mut self, index: usize, cell: &Cell) {
        if cell.cell_type != CellType::Code {
            return;
        }
        self.select_cell(index, false);
        self.flush_editor(cell);
        self.emit(NotebookCommandKind::ExecuteCell {
            cell_id: cell.id.clone(),
        });
    }
    fn execute_selected_and_advance(&mut self, always_insert: bool) {
        let Some((index, cell)) = self.selected_cell() else {
            return;
        };
        if cell.cell_type != CellType::Code {
            return;
        }
        self.flush_editor(&cell);
        self.emit(NotebookCommandKind::ExecuteCell {
            cell_id: cell.id.clone(),
        });
        if !always_insert && let Some(next) = self.state.snapshot.cells.get(index + 1) {
            self.state.snapshot.selected_cell_id = Some(next.id.clone());
            self.edit_mode = false;
            return;
        }
        let id = self.insert_cell(index + 1, CellType::Code, String::new());
        self.state.snapshot.selected_cell_id = Some(id.clone());
        self.pending_editor_focus = always_insert.then_some(id);
        self.edit_mode = always_insert;
    }
    fn move_selected(&mut self, index: usize) {
        if let Some((current, cell)) = self.selected_cell()
            && current != index
        {
            self.flush_editor(&cell);
            self.emit(NotebookCommandKind::ModifyCells {
                changes: vec![CellMutation::Move {
                    cell_id: cell.id,
                    index,
                }],
            });
        }
    }
    fn set_selected_cell_type(&mut self, cell_type: CellType) {
        if let Some((_, cell)) = self.selected_cell()
            && cell.cell_type != cell_type
        {
            self.flush_editor(&cell);
            let source = self.editor_source(&cell);
            self.emit(NotebookCommandKind::ModifyCells {
                changes: vec![CellMutation::Update {
                    cell_id: cell.id,
                    source: Some(source),
                    metadata: None,
                    cell_type: Some(cell_type),
                }],
            });
        }
    }
    fn delete_selected(&mut self) {
        let cells = self.selected_cells_in_order();
        if !cells.is_empty() {
            for cell in &cells {
                self.flush_editor(cell);
            }
            self.emit(NotebookCommandKind::ModifyCells {
                changes: cells
                    .into_iter()
                    .map(|cell| CellMutation::Delete { cell_id: cell.id })
                    .collect(),
            });
            self.selected_cells.clear();
        }
    }
    fn duplicate_selected(&mut self) {
        if let Some((index, cell)) = self.selected_cell() {
            self.flush_editor(&cell);
            self.insert_cell(index + 1, cell.cell_type.clone(), self.editor_source(&cell));
        }
    }
    fn copy_selected(&mut self) {
        self.cell_clipboard = self.selected_cells_in_order();
    }
    fn cut_selected(&mut self) {
        self.copy_selected();
        self.delete_selected();
    }
    fn selected_cells_in_order(&self) -> Vec<Cell> {
        let active = self.state.snapshot.selected_cell_id.as_deref();
        self.state
            .snapshot
            .cells
            .iter()
            .filter(|cell| {
                if self.selected_cells.is_empty() {
                    Some(cell.id.as_str()) == active
                } else {
                    self.selected_cells.contains(&cell.id)
                }
            })
            .cloned()
            .collect()
    }
    fn select_cell(&mut self, index: usize, extend: bool) {
        let Some(cell) = self.state.snapshot.cells.get(index) else {
            return;
        };
        let id = cell.id.clone();
        if extend {
            let anchor = self
                .state
                .snapshot
                .selected_cell_id
                .as_ref()
                .and_then(|selected| {
                    self.state
                        .snapshot
                        .cells
                        .iter()
                        .position(|cell| &cell.id == selected)
                })
                .unwrap_or(index);
            self.selected_cells.clear();
            for cell in &self.state.snapshot.cells[anchor.min(index)..=anchor.max(index)] {
                self.selected_cells.insert(cell.id.clone());
            }
        } else {
            self.selected_cells.clear();
            self.selected_cells.insert(id.clone());
        }
        self.state.snapshot.selected_cell_id = Some(id);
    }
    fn paste_below_selected(&mut self) {
        if self.cell_clipboard.is_empty() {
            return;
        }
        let start = self
            .selected_cell()
            .map_or(self.state.snapshot.cells.len(), |(index, _)| index + 1);
        let changes = self
            .cell_clipboard
            .iter()
            .cloned()
            .enumerate()
            .map(|(offset, mut cell)| {
                cell.id = Uuid::new_v4().to_string();
                cell.execution_count = None;
                cell.outputs.clear();
                CellMutation::Insert {
                    index: start + offset,
                    cell,
                }
            })
            .collect();
        self.emit(NotebookCommandKind::ModifyCells { changes });
    }
    fn replay_history(&mut self, undo: bool) {
        let changes = if undo {
            self.undo_stack.pop()
        } else {
            self.redo_stack.pop()
        };
        let Some(changes) = changes else { return };
        let inverse =
            inverse_cell_changes(&self.state.snapshot.cells, &changes).unwrap_or_default();
        self.suppress_history = true;
        self.emit(NotebookCommandKind::ModifyCells { changes });
        self.suppress_history = false;
        if undo {
            self.redo_stack.push(inverse);
        } else {
            self.undo_stack.push(inverse);
        }
    }
    fn clear_selected_outputs(&mut self) {
        if let Some((_, cell)) = self.selected_cell()
            && cell.cell_type == CellType::Code
        {
            self.emit(NotebookCommandKind::ModifyCells {
                changes: vec![CellMutation::ClearOutputs { cell_id: cell.id }],
            });
        }
    }
    fn clear_all_outputs(&mut self) {
        let changes = self
            .state
            .snapshot
            .cells
            .iter()
            .filter(|cell| cell.cell_type == CellType::Code)
            .map(|cell| CellMutation::ClearOutputs {
                cell_id: cell.id.clone(),
            })
            .collect::<Vec<_>>();
        if !changes.is_empty() {
            self.emit(NotebookCommandKind::ModifyCells { changes });
        }
    }
    fn toggle_selected_output(&mut self) {
        let Some((_, cell)) = self.selected_cell() else {
            return;
        };
        if cell.cell_type != CellType::Code || cell.outputs.is_empty() {
            return;
        }
        if !self.collapsed_outputs.remove(&cell.id) {
            self.collapsed_outputs.insert(cell.id);
        }
    }
    fn find_next(&mut self) {
        if self.find_query.is_empty() {
            return;
        }
        let start = self.selected_cell().map_or(0, |(index, _)| index + 1);
        let len = self.state.snapshot.cells.len();
        for offset in 0..len {
            let index = (start + offset) % len;
            let cell = &self.state.snapshot.cells[index];
            if self.editor_source(cell).contains(&self.find_query) {
                let id = cell.id.clone();
                self.state.snapshot.selected_cell_id = Some(id.clone());
                self.collapsed_cells.remove(&id);
                if cell.cell_type == CellType::Markdown {
                    self.rendered_markdown.remove(&id);
                }
                self.pending_editor_focus = Some(id);
                self.edit_mode = true;
                break;
            }
        }
    }
    fn replace_all(&mut self) {
        if self.find_query.is_empty() {
            return;
        }
        let mut changes = Vec::new();
        for cell in self.state.snapshot.cells.clone() {
            let source = self.editor_source(&cell);
            if source.contains(&self.find_query) {
                let replacement = source.replace(&self.find_query, &self.replace_query);
                if let Some((_, editor)) = self.editors.iter_mut().find(|(id, _)| id == &cell.id) {
                    editor.clone_from(&replacement);
                }
                changes.push(CellMutation::Update {
                    cell_id: cell.id,
                    source: Some(replacement),
                    metadata: None,
                    cell_type: None,
                });
            }
        }
        if !changes.is_empty() {
            self.emit(NotebookCommandKind::ModifyCells { changes });
        }
    }
    fn toolbar(&mut self, ui: &mut egui::Ui) {
        let idle = !matches!(
            self.state.sync_state,
            SyncState::Dirty | SyncState::Executing
        );
        let selected = self.selected_cell();
        let selected_type = selected.as_ref().map(|(_, cell)| cell.cell_type.clone());
        ui.vertical(|ui| {
            ui.horizontal(|ui| {
                ui.heading(
                    RichText::new(self.state.snapshot.notebook.path.trim_end_matches(".ipynb"))
                        .size(18.0)
                        .color(Color32::from_rgb(38, 50, 56)),
                );
            });
            ui.horizontal_wrapped(|ui| {
                ui.menu_button("File", |ui| {
                    if ui
                        .add_enabled(idle, egui::Button::new("Save Notebook"))
                        .clicked()
                    {
                        self.save_visible_edits();
                        ui.close();
                    }
                    if ui.button("Rename Notebook…").clicked() {
                        self.rename_path = self.state.snapshot.notebook.path.clone();
                        self.rename_open = true;
                        ui.close();
                    }
                    if ui.button("Download Notebook").clicked() {
                        self.save_visible_edits();
                        self.emit(NotebookCommandKind::DownloadNotebook);
                        ui.close();
                    }
                    if ui
                        .add_enabled(idle, egui::Button::new("Create Checkpoint"))
                        .clicked()
                    {
                        self.save_visible_edits();
                        self.emit(NotebookCommandKind::CreateCheckpoint);
                        ui.close();
                    }
                });
                ui.menu_button("Edit", |ui| {
                    if ui.button("Find and Replace…").clicked() {
                        self.find_open = true;
                        ui.close();
                    }
                    ui.separator();
                    if ui
                        .add_enabled(
                            !self.undo_stack.is_empty(),
                            egui::Button::new("Undo Cell Operation"),
                        )
                        .clicked()
                    {
                        self.replay_history(true);
                        ui.close();
                    }
                    if ui
                        .add_enabled(
                            !self.redo_stack.is_empty(),
                            egui::Button::new("Redo Cell Operation"),
                        )
                        .clicked()
                    {
                        self.replay_history(false);
                        ui.close();
                    }
                    ui.separator();
                    if ui
                        .add_enabled(selected.is_some(), egui::Button::new("Cut Cell"))
                        .clicked()
                    {
                        self.cut_selected();
                        ui.close();
                    }
                    if ui
                        .add_enabled(selected.is_some(), egui::Button::new("Copy Cell"))
                        .clicked()
                    {
                        self.copy_selected();
                        ui.close();
                    }
                    if ui
                        .add_enabled(
                            !self.cell_clipboard.is_empty(),
                            egui::Button::new("Paste Cell Below"),
                        )
                        .clicked()
                    {
                        self.paste_below_selected();
                        ui.close();
                    }
                    ui.separator();
                    if ui
                        .add_enabled(
                            idle && selected.is_some(),
                            egui::Button::new("Duplicate Cell"),
                        )
                        .clicked()
                    {
                        self.duplicate_selected();
                        ui.close();
                    }
                    if ui
                        .add_enabled(idle && selected.is_some(), egui::Button::new("Delete Cell"))
                        .clicked()
                    {
                        self.delete_selected();
                        ui.close();
                    }
                });
                ui.menu_button("View", |ui| {
                    if let Some((_, cell)) = selected.as_ref() {
                        let collapsed = self.collapsed_cells.contains(&cell.id);
                        if ui
                            .button(if collapsed {
                                "Expand Cell"
                            } else {
                                "Collapse Cell"
                            })
                            .clicked()
                        {
                            if collapsed {
                                self.collapsed_cells.remove(&cell.id);
                            } else {
                                self.collapsed_cells.insert(cell.id.clone());
                            }
                            ui.close();
                        }
                        if cell.cell_type == CellType::Code {
                            let output_collapsed = self.collapsed_outputs.contains(&cell.id);
                            if ui
                                .add_enabled(
                                    !cell.outputs.is_empty(),
                                    egui::Button::new(if output_collapsed {
                                        "Expand Output"
                                    } else {
                                        "Collapse Output"
                                    }),
                                )
                                .clicked()
                            {
                                self.toggle_selected_output();
                                ui.close();
                            }
                            let hidden = self.hidden_line_numbers.contains(&cell.id);
                            if ui
                                .button(if hidden {
                                    "Show Line Numbers"
                                } else {
                                    "Hide Line Numbers"
                                })
                                .clicked()
                            {
                                if hidden {
                                    self.hidden_line_numbers.remove(&cell.id);
                                } else {
                                    self.hidden_line_numbers.insert(cell.id.clone());
                                }
                                ui.close();
                            }
                        }
                        ui.separator();
                    }
                    if ui
                        .add_enabled(self.edit_mode, egui::Button::new("Command Mode"))
                        .clicked()
                    {
                        self.edit_mode = false;
                        ui.close();
                    }
                });
                ui.menu_button("Insert", |ui| {
                    if ui
                        .add_enabled(idle, egui::Button::new("Insert Cell Above"))
                        .clicked()
                    {
                        let index = selected.as_ref().map_or(0, |(index, _)| *index);
                        self.insert_cell(index, CellType::Code, String::new());
                        ui.close();
                    }
                    if ui
                        .add_enabled(idle, egui::Button::new("Insert Cell Below"))
                        .clicked()
                    {
                        self.insert_cell_after_selection(CellType::Code);
                        ui.close();
                    }
                });
                ui.menu_button("Cell", |ui| {
                    ui.menu_button("Cell Type", |ui| {
                        for (label, cell_type) in [
                            ("Code", CellType::Code),
                            ("Markdown", CellType::Markdown),
                            ("Raw", CellType::Raw),
                        ] {
                            if ui
                                .selectable_label(selected_type.as_ref() == Some(&cell_type), label)
                                .clicked()
                            {
                                self.set_selected_cell_type(cell_type);
                                ui.close();
                            }
                        }
                    });
                    ui.separator();
                    if ui
                        .add_enabled(
                            selected_type.as_ref() == Some(&CellType::Code),
                            egui::Button::new("Clear Selected Output"),
                        )
                        .clicked()
                    {
                        self.clear_selected_outputs();
                        ui.close();
                    }
                    if ui.button("Clear All Outputs").clicked() {
                        self.clear_all_outputs();
                        ui.close();
                    }
                    ui.separator();
                    if ui
                        .add_enabled(
                            idle && selected.is_some(),
                            egui::Button::new("Duplicate Cell"),
                        )
                        .clicked()
                    {
                        self.duplicate_selected();
                        ui.close();
                    }
                    if ui
                        .add_enabled(idle && selected.is_some(), egui::Button::new("Delete Cell"))
                        .clicked()
                    {
                        self.delete_selected();
                        ui.close();
                    }
                });
                ui.menu_button("Run", |ui| {
                    if ui
                        .add_enabled(
                            idle && selected_type.as_ref() == Some(&CellType::Code),
                            egui::Button::new("Run Selected Cell"),
                        )
                        .clicked()
                    {
                        self.execute_selected();
                        ui.close();
                    }
                    if ui
                        .add_enabled(idle, egui::Button::new("Run All Cells"))
                        .clicked()
                    {
                        self.save_visible_edits();
                        for cell in self.state.snapshot.cells.clone() {
                            if cell.cell_type == CellType::Code {
                                self.emit(NotebookCommandKind::ExecuteCell { cell_id: cell.id });
                            }
                        }
                        ui.close();
                    }
                });
                ui.menu_button("Kernel", |ui| {
                    if ui.button("Interrupt Kernel").clicked() {
                        self.emit(NotebookCommandKind::InterruptKernel);
                        ui.close();
                    }
                    if ui
                        .add_enabled(idle, egui::Button::new("Restart Kernel"))
                        .clicked()
                    {
                        self.restart_confirmation = true;
                        ui.close();
                    }
                });
                ui.menu_button("Help", |ui| {
                    ui.label("Enter: edit · Esc: command");
                    ui.label("A/B: insert above/below");
                    ui.label("Cmd/Ctrl+Enter: run cell");
                    ui.label("Tab: complete code");
                });
            });
            ui.horizontal_wrapped(|ui| {
                if toolbar_icon_button(ui, idle, ToolbarIcon::Save, "Save notebook") {
                    self.save_visible_edits();
                }
                if toolbar_icon_button(ui, idle, ToolbarIcon::Add, "Insert cell below") {
                    self.insert_cell_after_selection(CellType::Code);
                }
                ui.separator();
                let selected_index = selected.as_ref().map(|(index, _)| *index);
                if toolbar_icon_button(
                    ui,
                    idle && selected_index.is_some_and(|index| index > 0),
                    ToolbarIcon::Up,
                    "Move selected cell up",
                ) && let Some(index) = selected_index
                {
                    self.move_selected(index - 1);
                }
                if toolbar_icon_button(
                    ui,
                    idle && selected_index
                        .is_some_and(|index| index + 1 < self.state.snapshot.cells.len()),
                    ToolbarIcon::Down,
                    "Move selected cell down",
                ) && let Some(index) = selected_index
                {
                    self.move_selected(index + 1);
                }
                ui.separator();
                if toolbar_icon_button(
                    ui,
                    idle && selected_type.as_ref() == Some(&CellType::Code),
                    ToolbarIcon::Run,
                    "Run selected cell",
                ) {
                    self.execute_selected();
                }
                if toolbar_icon_button(ui, true, ToolbarIcon::Stop, "Interrupt kernel") {
                    self.emit(NotebookCommandKind::InterruptKernel);
                }
                if toolbar_icon_button(ui, idle, ToolbarIcon::Restart, "Restart kernel") {
                    self.restart_confirmation = true;
                }
                ui.separator();
                egui::ComboBox::from_id_salt("selected-cell-type")
                    .selected_text(match selected_type.as_ref() {
                        Some(CellType::Code) => "Code",
                        Some(CellType::Markdown) => "Markdown",
                        Some(CellType::Raw) => "Raw",
                        None => "Cell type",
                    })
                    .show_ui(ui, |ui| {
                        for (label, cell_type) in [
                            ("Code", CellType::Code),
                            ("Markdown", CellType::Markdown),
                            ("Raw", CellType::Raw),
                        ] {
                            if ui
                                .selectable_label(selected_type.as_ref() == Some(&cell_type), label)
                                .clicked()
                            {
                                self.set_selected_cell_type(cell_type);
                                ui.close();
                            }
                        }
                    });
                ui.separator();
                ui.label(if self.edit_mode { "Edit" } else { "Command" });
                if self.state.sync_state == SyncState::Disconnected
                    && ui
                        .add_enabled(idle, egui::Button::new("Reconnect"))
                        .clicked()
                {
                    self.emit(NotebookCommandKind::Reconnect);
                }
            });
            if self.find_open {
                ui.separator();
                ui.horizontal_wrapped(|ui| {
                    ui.label("Find");
                    ui.add(
                        TextEdit::singleline(&mut self.find_query)
                            .desired_width(180.0)
                            .hint_text("Search notebook"),
                    );
                    ui.label("Replace");
                    ui.add(
                        TextEdit::singleline(&mut self.replace_query)
                            .desired_width(180.0)
                            .hint_text("Replacement"),
                    );
                    if ui.button("Next").clicked() {
                        self.find_next();
                    }
                    if ui.button("Replace All").clicked() {
                        self.replace_all();
                    }
                    if ui.button("Close").clicked() {
                        self.find_open = false;
                    }
                });
            }
            if self.rename_open {
                ui.separator();
                ui.horizontal_wrapped(|ui| {
                    ui.label("Notebook name");
                    ui.add(
                        TextEdit::singleline(&mut self.rename_path)
                            .desired_width(260.0)
                            .hint_text("notebook.ipynb"),
                    );
                    if ui.button("Rename").clicked() && !self.rename_path.trim().is_empty() {
                        self.emit(NotebookCommandKind::RenameNotebook {
                            path: self.rename_path.trim().to_owned(),
                        });
                        self.rename_open = false;
                    }
                    if ui.button("Cancel").clicked() {
                        self.rename_open = false;
                    }
                });
            }
            if self.restart_confirmation {
                egui::Frame::new()
                    .fill(Color32::from_rgb(255, 248, 225))
                    .inner_margin(Margin::symmetric(10, 6))
                    .show(ui, |ui| {
                        ui.horizontal_wrapped(|ui| {
                            ui.label("Restarting clears all variables in the current kernel.");
                            if ui.button("Cancel").clicked() {
                                self.restart_confirmation = false;
                            }
                            if ui
                                .add_enabled(idle, egui::Button::new("Restart kernel"))
                                .clicked()
                            {
                                self.restart_confirmation = false;
                                self.emit(NotebookCommandKind::RestartKernel);
                            }
                        });
                    });
            }
        });
    }
    fn insert_cell_after_selection(&mut self, cell_type: CellType) {
        if let Some(selected) = self
            .state
            .snapshot
            .cells
            .iter()
            .find(|cell| Some(&cell.id) == self.state.snapshot.selected_cell_id.as_ref())
            .cloned()
        {
            self.flush_editor(&selected);
        }
        let index = self
            .state
            .snapshot
            .selected_cell_id
            .as_ref()
            .and_then(|id| {
                self.state
                    .snapshot
                    .cells
                    .iter()
                    .position(|cell| &cell.id == id)
            })
            .map_or(self.state.snapshot.cells.len(), |index| index + 1);
        self.insert_cell(index, cell_type, String::new());
    }
    fn insert_cell(&mut self, index: usize, cell_type: CellType, source: String) -> String {
        let cell = Cell {
            id: Uuid::new_v4().to_string(),
            cell_type,
            source,
            metadata: serde_json::json!({}),
            execution_count: None,
            outputs: vec![],
        };
        let id = cell.id.clone();
        self.emit(NotebookCommandKind::ModifyCells {
            changes: vec![CellMutation::Insert { index, cell }],
        });
        id
    }
    fn status(&self, ui: &mut egui::Ui) {
        let (label, color) = if !self.dirty_editors.is_empty() {
            ("Autosave pending", Color32::from_rgb(239, 108, 0))
        } else {
            match self.state.sync_state {
                SyncState::Synchronized => ("Saved", Color32::from_rgb(46, 125, 50)),
                SyncState::Dirty => ("Pending", Color32::from_rgb(239, 108, 0)),
                SyncState::Executing => ("Running", Color32::from_rgb(2, 119, 189)),
                SyncState::Disconnected => ("Disconnected", Color32::from_rgb(198, 40, 40)),
                SyncState::Error => ("Action required", Color32::from_rgb(198, 40, 40)),
            }
        };
        ui.horizontal(|ui| {
            let (rect, _) = ui.allocate_exact_size(egui::vec2(10.0, 10.0), egui::Sense::hover());
            ui.painter().circle_filled(rect.center(), 4.0, color);
            ui.label(label);
            ui.separator();
            ui.label(format!(
                "Kernel: {} · {:?}",
                self.state.snapshot.kernel.display_name, self.state.snapshot.kernel.state
            ));
            ui.separator();
            ui.label(format!("Revision {}", self.state.snapshot.revision));
        });
        if let Some(error) = &self.state.last_error {
            ui.colored_label(
                Color32::from_rgb(183, 28, 28),
                format!(
                    "{} — {}",
                    error.message,
                    if error.retryable {
                        "Retry or reconnect."
                    } else {
                        "Edit the request and try again."
                    }
                ),
            );
        }
    }
    fn cell(&mut self, ui: &mut egui::Ui, index: usize, cell: Cell) {
        let selected = self.selected_cells.contains(&cell.id)
            || self.state.snapshot.selected_cell_id.as_deref() == Some(cell.id.as_str());
        let collapsed = self.collapsed_cells.contains(&cell.id);
        let output_collapsed = self.collapsed_outputs.contains(&cell.id);
        let frame = egui::Frame::new()
            .fill(if selected {
                Color32::from_rgb(250, 253, 255)
            } else {
                Color32::WHITE
            })
            .stroke(Stroke::new(
                if selected { 2.0 } else { 1.0 },
                if selected {
                    Color32::from_rgb(45, 105, 145)
                } else {
                    Color32::from_gray(210)
                },
            ))
            .corner_radius(CornerRadius::same(3))
            .inner_margin(Margin::same(10));
        let frame_response = frame.show(ui, |ui| {
            ui.set_width(ui.available_width());
            ui.horizontal_wrapped(|ui| {
                let idle = !matches!(
                    self.state.sync_state,
                    SyncState::Dirty | SyncState::Executing
                );
                let running = self
                    .pending_execution_cells
                    .values()
                    .any(|cell_id| cell_id == &cell.id);
                if cell.cell_type == CellType::Code
                    && cell_run_button(ui, idle && !running, running).clicked()
                {
                    self.execute_cell(index, &cell);
                }
                execution_status_icon(ui, cell_has_completed_execution(&cell), running);
                let drag = ui
                    .add_enabled(idle, drag_handle())
                    .on_hover_text("Drag to reorder cell");
                if drag.hovered() {
                    ui.ctx().set_cursor_icon(egui::CursorIcon::Grab);
                }
                if drag.drag_started() {
                    self.dragging_cell = Some(cell.id.clone());
                    self.state.snapshot.selected_cell_id = Some(cell.id.clone());
                }
                if drag.dragged() {
                    ui.ctx().set_cursor_icon(egui::CursorIcon::Grabbing);
                }
                let prompt = ui.add(
                    egui::Label::new(
                        RichText::new(match cell.cell_type {
                            CellType::Code => format!(
                                "In [{}]",
                                cell.execution_count.map_or(" ".into(), |v| v.to_string())
                            ),
                            CellType::Markdown => "Markdown".into(),
                            CellType::Raw => "Raw".into(),
                        })
                        .monospace()
                        .color(Color32::from_rgb(75, 85, 92)),
                    )
                    .sense(egui::Sense::click()),
                );
                if prompt.clicked() {
                    self.select_cell(index, ui.input(|input| input.modifiers.shift));
                }
                if ui
                    .small_button(if collapsed { "Expand" } else { "Collapse" })
                    .clicked()
                {
                    if collapsed {
                        self.collapsed_cells.remove(&cell.id);
                    } else {
                        self.collapsed_cells.insert(cell.id.clone());
                    }
                }
                if cell.cell_type == CellType::Code
                    && !cell.outputs.is_empty()
                    && ui
                        .small_button(if output_collapsed {
                            "Expand output"
                        } else {
                            "Collapse output"
                        })
                        .on_hover_text("Toggle this cell's output (command mode: O)")
                        .clicked()
                {
                    if output_collapsed {
                        self.collapsed_outputs.remove(&cell.id);
                    } else {
                        self.collapsed_outputs.insert(cell.id.clone());
                    }
                }
            });
            if !collapsed {
                if cell.cell_type == CellType::Markdown {
                    let rendered = self.rendered_markdown.contains(&cell.id);
                    if rendered {
                        let source = self.editor_source(&cell);
                        let rendered_response = rendered_markdown_response(
                            ui,
                            &cell.id,
                            &source,
                            &mut self.markdown_cache,
                            &self.math_cache,
                        )
                        .on_hover_text("Double-click to edit Markdown");
                        self.apply_rendered_markdown_interaction(
                            &cell.id,
                            rendered_response.clicked(),
                            rendered_response.double_clicked(),
                        );
                    } else if ui.button("Render Markdown").clicked() {
                        self.rendered_markdown.insert(cell.id.clone());
                        self.edit_mode = false;
                    }
                }
                let show_editor = cell.cell_type != CellType::Markdown
                    || !self.rendered_markdown.contains(&cell.id);
                let edited = show_editor
                    .then(|| {
                        let editor = self
                            .editors
                            .iter_mut()
                            .find(|(id, _)| id == &cell.id)
                            .map(|(_, source)| source)
                            .unwrap();
                        let response = if cell.cell_type == CellType::Code {
                            let mut output = CodeEditor::default()
                                .id_source(format!("code-editor-{}", cell.id))
                                .with_rows(editor.lines().count().clamp(2, 18))
                                .with_fontsize(14.0)
                                .with_theme(ColorTheme::GITHUB_LIGHT)
                                .with_syntax(Syntax::python())
                                .with_numlines(!self.hidden_line_numbers.contains(&cell.id))
                                .vscroll(false)
                                .show(ui, editor);
                            if let Some(range) = output.state.cursor.char_range() {
                                let char_index = range.primary.index;
                                let byte_index = editor
                                    .char_indices()
                                    .nth(char_index)
                                    .map_or(editor.len(), |(index, _)| index);
                                self.caret_byte_positions
                                    .insert(cell.id.clone(), byte_index);
                            }
                            if let Some(caret) = self.pending_caret_positions.remove(&cell.id) {
                                output
                                    .state
                                    .cursor
                                    .set_char_range(Some(CCursorRange::one(CCursor::new(caret))));
                                output.state.store(ui.ctx(), output.response.id);
                                output.response.request_focus();
                            }
                            output.response
                        } else {
                            ui.add_sized(
                                [
                                    ui.available_width(),
                                    editor.lines().count().clamp(2, 18) as f32 * 20.0 + 12.0,
                                ],
                                TextEdit::multiline(editor)
                                    .font(egui::TextStyle::Monospace)
                                    .desired_width(f32::INFINITY)
                                    .code_editor(),
                            )
                        };
                        if response.changed() {
                            self.dirty_editors.insert(cell.id.clone());
                            self.autosave_due = Some(ui.input(|input| input.time) + 1.2);
                            ui.ctx().request_repaint_after(Duration::from_millis(1_200));
                            if cell.cell_type == CellType::Code {
                                self.completion_due
                                    .insert(cell.id.clone(), ui.input(|input| input.time) + 0.3);
                                ui.ctx().request_repaint_after(Duration::from_millis(300));
                            }
                        }
                        if self.pending_editor_focus.as_deref() == Some(cell.id.as_str()) {
                            response.request_focus();
                            self.pending_editor_focus = None;
                        }
                        if response.has_focus() || response.clicked() {
                            self.state.snapshot.selected_cell_id = Some(cell.id.clone());
                            if response.clicked() {
                                self.selected_cells.clear();
                                self.selected_cells.insert(cell.id.clone());
                            }
                            self.edit_mode = true;
                        }
                        if response.has_focus() && ui.input(|input| input.key_pressed(Key::Escape))
                        {
                            response.surrender_focus();
                            self.edit_mode = false;
                        }
                        (response.lost_focus() && self.dirty_editors.remove(&cell.id))
                            .then(|| editor.clone())
                    })
                    .flatten();
                if let Some(source) = edited {
                    self.emit(NotebookCommandKind::ModifyCells {
                        changes: vec![CellMutation::Update {
                            cell_id: cell.id.clone(),
                            source: Some(source),
                            metadata: None,
                            cell_type: Some(cell.cell_type.clone()),
                        }],
                    });
                }
                if let Some(completion) = self.completion_suggestions.get(&cell.id).cloned() {
                    let selected = self
                        .completion_selection
                        .get(&cell.id)
                        .copied()
                        .unwrap_or_default();
                    let mut accepted = None;
                    egui::Frame::popup(ui.style()).show(ui, |ui| {
                        ui.set_min_width(ui.available_width().min(420.0));
                        ui.label(
                            RichText::new("Code completions")
                                .small()
                                .color(Color32::from_rgb(83, 99, 107)),
                        );
                        egui::ScrollArea::vertical()
                            .max_height(220.0)
                            .show(ui, |ui| {
                                for (index, value) in completion.matches.iter().take(12).enumerate()
                                {
                                    if completion_row(ui, value, index == selected).clicked() {
                                        accepted = Some(index);
                                    }
                                }
                            });
                        ui.label("↑/↓ select · Enter or Tab apply · Esc close");
                    });
                    if let Some(index) = accepted {
                        self.completion_selection.insert(cell.id.clone(), index);
                        self.accept_completion(&cell.id);
                    }
                }
                if let Some(inspection) = self.inspections.get(&cell.id).cloned() {
                    egui::Frame::popup(ui.style()).show(ui, |ui| {
                        ui.horizontal(|ui| {
                            ui.label(RichText::new("Object help").strong());
                            if ui.small_button("Close").clicked() {
                                self.inspections.remove(&cell.id);
                            }
                        });
                        egui::ScrollArea::vertical()
                            .max_height(240.0)
                            .show(ui, |ui| {
                                ui.add(
                                    egui::Label::new(RichText::new(inspection).monospace()).wrap(),
                                );
                            });
                    });
                }
                if output_collapsed && !cell.outputs.is_empty() {
                    let summary = output_collapse_summary(cell.outputs.len());
                    let response = egui::Frame::new()
                        .fill(Color32::from_rgb(248, 250, 251))
                        .inner_margin(Margin::symmetric(8, 6))
                        .show(ui, |ui| {
                            ui.add(
                                egui::Label::new(
                                    RichText::new(summary)
                                        .monospace()
                                        .color(Color32::from_rgb(83, 99, 107)),
                                )
                                .sense(egui::Sense::click()),
                            )
                        })
                        .inner;
                    if response
                        .on_hover_text("Click to expand this cell's output")
                        .clicked()
                    {
                        self.collapsed_outputs.remove(&cell.id);
                    }
                } else {
                    for output in &cell.outputs {
                        render_output(ui, output);
                    }
                }
            }
        });
        if let Some(dragged_id) = self.dragging_cell.clone()
            && dragged_id != cell.id
            && ui.rect_contains_pointer(frame_response.response.rect)
            && let Some(pointer) = ui.ctx().pointer_latest_pos()
        {
            let before = pointer.y < frame_response.response.rect.center().y;
            let line_y = if before {
                frame_response.response.rect.top()
            } else {
                frame_response.response.rect.bottom()
            };
            ui.painter().line_segment(
                [
                    egui::pos2(frame_response.response.rect.left(), line_y),
                    egui::pos2(frame_response.response.rect.right(), line_y),
                ],
                Stroke::new(3.0, Color32::from_rgb(45, 105, 145)),
            );
            if ui.input(|input| input.pointer.any_released()) {
                let source_index = self
                    .state
                    .snapshot
                    .cells
                    .iter()
                    .position(|candidate| candidate.id == dragged_id);
                if let Some(source_index) = source_index {
                    let target_index = move_index_for_drop(source_index, index, before);
                    if target_index != source_index {
                        if let Some(source) = self.state.snapshot.cells.get(source_index).cloned() {
                            self.flush_editor(&source);
                        }
                        self.emit(NotebookCommandKind::ModifyCells {
                            changes: vec![CellMutation::Move {
                                cell_id: dragged_id,
                                index: target_index,
                            }],
                        });
                    }
                }
                self.dragging_cell = None;
            }
        }
    }

    fn apply_rendered_markdown_interaction(
        &mut self,
        cell_id: &str,
        clicked: bool,
        double_clicked: bool,
    ) {
        if clicked || double_clicked {
            self.state.snapshot.selected_cell_id = Some(cell_id.to_owned());
        }
        if double_clicked {
            self.begin_editing_cell(cell_id);
        }
    }

    fn begin_editing_cell(&mut self, cell_id: &str) {
        self.rendered_markdown.remove(cell_id);
        self.pending_editor_focus = Some(cell_id.to_owned());
        self.edit_mode = true;
    }
}

impl eframe::App for NotebookEguiApp {
    fn update(&mut self, ctx: &egui::Context, _frame: &mut eframe::Frame) {
        let compact_controls = ctx.screen_rect().width() < 600.0;
        ctx.style_mut(|style| {
            style.visuals = egui::Visuals::light();
            style.spacing.item_spacing = egui::vec2(8.0, 8.0);
            style.spacing.interact_size.y = if compact_controls { 44.0 } else { 30.0 };
            style.visuals.selection.bg_fill = Color32::from_rgb(210, 232, 246);
        });
        install_data_image_loader(ctx);
        egui_extras::install_image_loaders(ctx);
        let now = ctx.input(|input| input.time);
        if self.autosave_due.is_some_and(|deadline| deadline <= now) {
            self.autosave_due = None;
            self.save_visible_edits();
        }
        let due = self
            .completion_due
            .iter()
            .filter(|(_, deadline)| **deadline <= now)
            .map(|(cell_id, _)| cell_id.clone())
            .collect::<Vec<_>>();
        for cell_id in due {
            self.completion_due.remove(&cell_id);
            if self.edit_mode
                && let Some(cell) = self
                    .state
                    .snapshot
                    .cells
                    .iter()
                    .find(|cell| cell.id == cell_id)
                    .cloned()
            {
                self.request_completion(&cell);
            }
        }
        let selected_cell_id = self.state.snapshot.selected_cell_id.clone();
        let completion_open = selected_cell_id
            .as_ref()
            .is_some_and(|id| self.completion_suggestions.contains_key(id));
        if completion_open && let Some(cell_id) = selected_cell_id.as_ref() {
            let count = self
                .completion_suggestions
                .get(cell_id)
                .map_or(0, |completion| completion.matches.len().min(12));
            if count > 0 && ctx.input(|input| input.key_pressed(Key::ArrowDown)) {
                ctx.input_mut(|input| input.consume_key(egui::Modifiers::NONE, Key::ArrowDown));
                let selected = self
                    .completion_selection
                    .entry(cell_id.clone())
                    .or_default();
                *selected = (*selected + 1).min(count - 1);
            }
            if count > 0 && ctx.input(|input| input.key_pressed(Key::ArrowUp)) {
                ctx.input_mut(|input| input.consume_key(egui::Modifiers::NONE, Key::ArrowUp));
                let selected = self
                    .completion_selection
                    .entry(cell_id.clone())
                    .or_default();
                *selected = selected.saturating_sub(1);
            }
            if ctx.input(|input| input.key_pressed(Key::Enter) || input.key_pressed(Key::Tab)) {
                ctx.input_mut(|input| {
                    input.consume_key(egui::Modifiers::NONE, Key::Enter);
                    input.consume_key(egui::Modifiers::NONE, Key::Tab);
                });
                self.accept_completion(cell_id);
            } else if ctx.input(|input| input.key_pressed(Key::Escape)) {
                ctx.input_mut(|input| input.consume_key(egui::Modifiers::NONE, Key::Escape));
                self.close_completion(cell_id);
            }
        } else if self.edit_mode
            && ctx.input(|input| input.modifiers.shift && input.key_pressed(Key::Tab))
            && let Some(cell) = selected_cell_id
                .as_ref()
                .and_then(|id| self.state.snapshot.cells.iter().find(|cell| &cell.id == id))
                .filter(|cell| cell.cell_type == CellType::Code)
                .cloned()
        {
            ctx.input_mut(|input| input.consume_key(egui::Modifiers::SHIFT, Key::Tab));
            self.request_inspection(&cell);
        } else if self.edit_mode
            && ctx.input(|input| input.key_pressed(Key::Tab))
            && ctx.input(|input| !input.modifiers.shift)
            && let Some(cell) = selected_cell_id
                .as_ref()
                .and_then(|id| self.state.snapshot.cells.iter().find(|cell| &cell.id == id))
                .filter(|cell| cell.cell_type == CellType::Code)
                .cloned()
        {
            ctx.input_mut(|input| input.consume_key(egui::Modifiers::NONE, Key::Tab));
            self.request_completion(&cell);
        }
        if !completion_open && ctx.input(|input| input.key_pressed(Key::Escape)) {
            self.edit_mode = false;
        }
        if !completion_open
            && ctx.input(|input| input.modifiers.shift && input.key_pressed(Key::Enter))
        {
            ctx.input_mut(|input| input.consume_key(egui::Modifiers::SHIFT, Key::Enter));
            self.execute_selected_and_advance(false);
        } else if !completion_open
            && ctx.input(|input| input.modifiers.alt && input.key_pressed(Key::Enter))
        {
            ctx.input_mut(|input| input.consume_key(egui::Modifiers::ALT, Key::Enter));
            self.execute_selected_and_advance(true);
        }
        let command_mode = !self.edit_mode;
        if command_mode
            && ctx.input(|input| input.key_pressed(Key::Enter))
            && let Some((_, cell)) = self.selected_cell()
        {
            self.begin_editing_cell(&cell.id);
        }
        if command_mode
            && ctx.input(|input| input.key_pressed(Key::ArrowDown) || input.key_pressed(Key::J))
            && let Some((index, _)) = self.selected_cell()
            && let Some(next) = self.state.snapshot.cells.get(index + 1)
        {
            self.state.snapshot.selected_cell_id = Some(next.id.clone());
        }
        if command_mode
            && ctx.input(|input| input.key_pressed(Key::ArrowUp) || input.key_pressed(Key::K))
            && let Some((index, _)) = self.selected_cell()
            && index > 0
        {
            self.state.snapshot.selected_cell_id =
                Some(self.state.snapshot.cells[index - 1].id.clone());
        }
        if command_mode && ctx.input(|input| input.key_pressed(Key::A)) {
            let index = self
                .state
                .snapshot
                .selected_cell_id
                .as_ref()
                .and_then(|id| {
                    self.state
                        .snapshot
                        .cells
                        .iter()
                        .position(|cell| &cell.id == id)
                })
                .unwrap_or(0);
            self.insert_cell(index, CellType::Code, String::new());
        }
        if command_mode && ctx.input(|input| input.key_pressed(Key::B)) {
            self.insert_cell_after_selection(CellType::Code);
        }
        if command_mode && ctx.input(|input| input.key_pressed(Key::X)) {
            self.cut_selected();
        }
        if command_mode && ctx.input(|input| input.key_pressed(Key::C)) {
            self.copy_selected();
        }
        if command_mode && ctx.input(|input| input.key_pressed(Key::V)) {
            self.paste_below_selected();
        }
        if command_mode && ctx.input(|input| input.key_pressed(Key::Z)) {
            if ctx.input(|input| input.modifiers.shift) {
                self.replay_history(false);
            } else {
                self.replay_history(true);
            }
        }
        if command_mode && ctx.input(|input| input.key_pressed(Key::S)) {
            self.save_visible_edits();
        }
        if command_mode && ctx.input(|input| input.key_pressed(Key::M)) {
            self.set_selected_cell_type(CellType::Markdown);
        }
        if command_mode && ctx.input(|input| input.key_pressed(Key::Y)) {
            self.set_selected_cell_type(CellType::Code);
        }
        if command_mode && ctx.input(|input| input.key_pressed(Key::R)) {
            self.set_selected_cell_type(CellType::Raw);
        }
        if command_mode && ctx.input(|input| input.key_pressed(Key::O)) {
            self.toggle_selected_output();
        }
        if ctx.input(|input| input.modifiers.command && input.key_pressed(Key::Enter))
            && let Some(id) = self.state.snapshot.selected_cell_id.clone()
        {
            if let Some(cell) = self
                .state
                .snapshot
                .cells
                .iter()
                .find(|cell| cell.id == id)
                .cloned()
            {
                self.flush_editor(&cell);
            }
            self.emit(NotebookCommandKind::ExecuteCell { cell_id: id });
        }
        egui::TopBottomPanel::top("toolbar").show(ctx, |ui| self.toolbar(ui));
        egui::TopBottomPanel::bottom("status").show(ctx, |ui| self.status(ui));
        egui::CentralPanel::default()
            .frame(
                egui::Frame::new()
                    .fill(Color32::from_rgb(247, 247, 247))
                    .inner_margin(if compact_controls {
                        Margin::symmetric(8, 8)
                    } else {
                        Margin::symmetric(16, 12)
                    }),
            )
            .show(ctx, |ui| {
                egui::ScrollArea::vertical()
                    .auto_shrink([false, false])
                    .show(ui, |ui| {
                        ui.set_width(notebook_document_width(ui.available_width()));
                        if self.state.snapshot.cells.is_empty() {
                            ui.vertical_centered(|ui| {
                                ui.add_space(80.0);
                                ui.heading("A quiet page, ready for work");
                                ui.label("Add a code or Markdown cell to begin.");
                            });
                        }
                        for (index, cell) in
                            self.state.snapshot.cells.clone().into_iter().enumerate()
                        {
                            self.cell(ui, index, cell);
                            ui.add_space(10.0);
                        }
                        if ui.input(|input| input.pointer.any_released()) {
                            self.dragging_cell = None;
                        }
                    });
            });
    }
}

fn render_output(ui: &mut egui::Ui, output: &CellOutput) {
    if let CellOutput::Rich { mime, data } = output
        && matches!(mime.as_str(), "image/png" | "image/svg+xml")
    {
        egui::Frame::new()
            .fill(Color32::from_rgb(248, 250, 251))
            .inner_margin(Margin::same(8))
            .show(ui, |ui| match decode_rich_image(mime, data) {
                Ok(bytes) => {
                    let dimensions = (mime == "image/png")
                        .then(|| png_dimensions(&bytes))
                        .flatten();
                    let mut image = egui::Image::from_bytes(rich_image_uri(mime, data), bytes)
                        .alt_text("Notebook graph output");
                    if let Some((width, height)) = dimensions {
                        let width = width as f32;
                        let height = height as f32;
                        let scale = (ui.available_width() / width).min(1.0);
                        image = image.fit_to_exact_size(egui::vec2(width * scale, height * scale));
                    }
                    ui.add(image.max_width(ui.available_width()));
                }
                Err(_) => {
                    ui.colored_label(
                        Color32::from_rgb(198, 40, 40),
                        "Image output could not be decoded. Re-run the cell to regenerate it.",
                    );
                }
            });
        return;
    }
    if let CellOutput::Rich { mime, data } = output
        && mime == "text/html"
    {
        let text = sanitized_html_text(data);
        egui::Frame::new()
            .fill(Color32::from_rgb(248, 250, 251))
            .inner_margin(Margin::same(8))
            .show(ui, |ui| {
                ui.add(egui::Label::new(RichText::new(text).monospace()).wrap());
            });
        return;
    }
    let text = match output {
        CellOutput::Text { text } | CellOutput::Stream { text, .. } => text.clone(),
        CellOutput::Error {
            name,
            message,
            traceback,
        } => format!("{name}: {message}\n{}", traceback.join("\n")),
        CellOutput::Rich { mime, data } => format!("[{mime}]\n{data}"),
    };
    egui::Frame::new()
        .fill(Color32::from_rgb(248, 250, 251))
        .inner_margin(Margin::same(8))
        .show(ui, |ui| {
            ui.add(egui::Label::new(ansi_layout_job(&text, Color32::from_rgb(38, 50, 56))).wrap());
        });
}

fn sanitized_html_text(html: &str) -> String {
    let normalized = html
        .replace("</td>", "\t")
        .replace("</th>", "\t")
        .replace("</tr>", "\n")
        .replace("<br>", "\n")
        .replace("<br/>", "\n")
        .replace("<br />", "\n");
    let mut text = String::with_capacity(normalized.len().min(262_144));
    let mut inside_tag = false;
    for character in normalized.chars() {
        match character {
            '<' => inside_tag = true,
            '>' => inside_tag = false,
            _ if !inside_tag
                && (character == '\n' || character == '\t' || !character.is_control()) =>
            {
                text.push(character);
            }
            _ => {}
        }
        if text.len() >= 262_144 {
            break;
        }
    }
    text.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&amp;", "&")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
}

fn ansi_layout_job(text: &str, base_color: Color32) -> LayoutJob {
    let mut job = LayoutJob::default();
    let mut color = base_color;
    let mut buffer = String::new();
    let mut characters = text.chars().peekable();

    while let Some(character) = characters.next() {
        if character == '\u{1b}' {
            append_output_run(&mut job, &mut buffer, color);
            match characters.next() {
                Some('[') => {
                    let mut parameters = String::new();
                    for sequence_character in characters.by_ref() {
                        if ('@'..='~').contains(&sequence_character) {
                            if sequence_character == 'm' {
                                color = ansi_foreground(&parameters, color, base_color);
                            }
                            break;
                        }
                        if parameters.len() < 64 {
                            parameters.push(sequence_character);
                        }
                    }
                }
                Some(']') => {
                    while let Some(sequence_character) = characters.next() {
                        if sequence_character == '\u{7}' {
                            break;
                        }
                        if sequence_character == '\u{1b}' && characters.next_if_eq(&'\\').is_some()
                        {
                            break;
                        }
                    }
                }
                Some(_) | None => {}
            }
        } else if character == '\n' || character == '\t' || !character.is_control() {
            buffer.push(character);
        }
    }
    append_output_run(&mut job, &mut buffer, color);
    job
}

fn append_output_run(job: &mut LayoutJob, buffer: &mut String, color: Color32) {
    if buffer.is_empty() {
        return;
    }
    job.append(
        buffer,
        0.0,
        TextFormat {
            font_id: FontId::monospace(14.0),
            color,
            ..Default::default()
        },
    );
    buffer.clear();
}

fn ansi_foreground(parameters: &str, current: Color32, base: Color32) -> Color32 {
    let mut color = current;
    let parameters = if parameters.is_empty() {
        vec![0]
    } else {
        parameters
            .split(';')
            .filter_map(|parameter| parameter.parse::<u8>().ok())
            .collect()
    };
    for parameter in parameters {
        color = match parameter {
            0 | 39 => base,
            30 => Color32::from_rgb(38, 50, 56),
            31 => Color32::from_rgb(198, 40, 40),
            32 => Color32::from_rgb(46, 125, 50),
            33 => Color32::from_rgb(154, 103, 0),
            34 => Color32::from_rgb(21, 101, 192),
            35 => Color32::from_rgb(123, 31, 162),
            36 => Color32::from_rgb(0, 121, 107),
            37 => Color32::from_rgb(83, 99, 107),
            90 => Color32::from_rgb(97, 112, 119),
            91 => Color32::from_rgb(211, 47, 47),
            92 => Color32::from_rgb(56, 142, 60),
            93 => Color32::from_rgb(175, 112, 0),
            94 => Color32::from_rgb(25, 118, 210),
            95 => Color32::from_rgb(142, 36, 170),
            96 => Color32::from_rgb(0, 137, 123),
            97 => Color32::from_rgb(38, 50, 56),
            _ => color,
        };
    }
    color
}

fn rendered_markdown_response(
    ui: &mut egui::Ui,
    cell_id: &str,
    source: &str,
    cache: &mut CommonMarkCache,
    math_cache: &Arc<Mutex<MathRenderCache>>,
) -> egui::Response {
    let math_cache = Arc::clone(math_cache);
    let render_math = move |ui: &mut egui::Ui, math: &str, inline: bool| {
        math_cache
            .lock()
            .expect("markdown math cache mutex poisoned")
            .show(ui, math, inline);
    };
    let rendered = ui.scope(|ui| {
        CommonMarkViewer::new()
            .explicit_image_uri_scheme(true)
            .max_image_width(Some(ui.available_width().max(1.0) as usize))
            .render_math_fn(Some(&render_math))
            .show(ui, cache, source);
    });
    ui.interact(
        rendered.response.rect,
        ui.make_persistent_id(("rendered-markdown", cell_id)),
        egui::Sense::click(),
    )
}

#[derive(Default)]
struct MathRenderCache {
    textures: HashMap<u64, Result<(egui::TextureHandle, egui::Vec2), String>>,
}

impl MathRenderCache {
    fn show(&mut self, ui: &mut egui::Ui, latex: &str, inline: bool) {
        let mut hasher = DefaultHasher::new();
        latex.hash(&mut hasher);
        inline.hash(&mut hasher);
        let key = hasher.finish();
        self.textures.entry(key).or_insert_with(|| {
            render_math_formula(latex, inline).map(|image| {
                let size = egui::vec2(
                    image.width() as f32 / MATH_PIXELS_PER_POINT,
                    image.height() as f32 / MATH_PIXELS_PER_POINT,
                );
                let texture = ui.ctx().load_texture(
                    format!("markdown-math-{key:016x}"),
                    image,
                    egui::TextureOptions::LINEAR,
                );
                (texture, size)
            })
        });
        match self.textures.get(&key) {
            Some(Ok((texture, size))) if inline => {
                ui.add(egui::Image::new((texture.id(), *size)));
            }
            Some(Ok((texture, size))) => {
                ui.vertical_centered(|ui| {
                    ui.add(egui::Image::new((texture.id(), *size)));
                });
            }
            Some(Err(message)) => {
                ui.colored_label(
                    Color32::from_rgb(198, 40, 40),
                    format!("Math could not be rendered: {message}"),
                );
            }
            None => {}
        }
    }
}

const MATH_PIXELS_PER_POINT: f32 = 2.0;
const MATH_RASTER_PADDING_POINTS: f32 = 4.0;

const MATH_PREAMBLE: &str = r#"
#let mitexmathbf(it) = math.bold(math.upright(it))
#let mitexsqrt(..args) = {
  if args.pos().len() == 1 { $sqrt(#args.pos().at(0))$ }
  else if args.pos().len() == 2 { $root(#args.pos().at(0), #args.pos().at(1))$ }
}
#let mitexdisplay(it) = math.display(it)
#let mitexinline(it) = math.inline(it)
#let mitexscript(it) = math.script(it)
#let mitexsscript(it) = math.sscript(it)
#let mitexbold(it) = math.bold(math.upright(it))
#let mitexupright(it) = math.upright(it)
#let mitexitalic(it) = math.italic(it)
#let mitexsans(it) = math.sans(it)
#let mitexnot(it) = math.cancel(angle: 20deg, it)
#let mitexlabel(it) = none
#let mitexcaption(it) = none
#let pmatrix = math.mat.with(delim: "(")
#let bmatrix = math.mat.with(delim: "[")
#let Bmatrix = math.mat.with(delim: "{")
#let vmatrix = math.mat.with(delim: "|")
#let Vmatrix = math.mat.with(delim: "||")
#let aligned(..args) = args.pos().first()
#let gathered(..args) = args.pos().first()
#let mitexunderbrace(it) = math.underbrace(it)
#let mitexoverbrace(it) = math.overbrace(it)
#let stackrel(top, base) = math.attach(base, t: top)
#let overset(top, base) = math.attach(base, t: top)
#let textmath(it) = text(it)
#let textbf(it) = text(weight: "bold", it)
#let textit(it) = text(style: "italic", it)
#let textrm(it) = text(it)
#let tfrac(num, denom) = math.inline(math.frac(num, denom))
#let dfrac(num, denom) = math.display(math.frac(num, denom))
#let boxed(it) = box(stroke: 0.6pt, inset: (x: 4pt, y: 3pt), $it$)
#let negthinspace = h(-0.16667em)
#let xrightarrow(label) = $attach(arrow.r.long, t: #label)$
#let xleftarrow(label) = $attach(arrow.l.long, t: #label)$
#let ket(it) = $bar.v #it angle.r$
#let bra(it) = $angle.l #it bar.v$
#let braket(left, right) = $angle.l #left bar.v #right angle.r$
"#;

static MATH_FONTS: LazyLock<Vec<typst::text::Font>> = LazyLock::new(|| {
    let mut searcher = typst_kit::fonts::Fonts::searcher();
    searcher
        .include_system_fonts(false)
        .include_embedded_fonts(true);
    searcher
        .search()
        .fonts
        .iter()
        .filter_map(|slot| slot.get())
        .collect()
});

fn render_math_formula(latex: &str, inline: bool) -> Result<egui::ColorImage, String> {
    let typst_math = mitex::convert_math(latex, None).map_err(|error| error.to_string())?;
    let equation = if inline {
        format!("${typst_math}$")
    } else {
        format!("$ {typst_math} $")
    };
    let source = format!(
        "{MATH_PREAMBLE}\n#set page(width: auto, height: auto, margin: 0pt, fill: none)\n#set text(size: 16pt, fill: black)\n{equation}"
    );
    let engine = typst_as_lib::TypstEngine::builder()
        .main_file(source)
        .fonts(MATH_FONTS.iter().cloned())
        .build();
    let compiled = engine.compile::<typst::layout::PagedDocument>();
    let document = compiled
        .output
        .map_err(|diagnostics| format!("{diagnostics}"))?;
    let page = document
        .pages
        .first()
        .ok_or_else(|| "typesetter returned no page".to_owned())?;
    let pixmap = typst_render::render(page, MATH_PIXELS_PER_POINT);
    let rendered_width = pixmap.width() as usize;
    let rendered_height = pixmap.height() as usize;
    if rendered_width == 0 || rendered_height == 0 {
        return Err("typesetter returned an empty image".into());
    }
    let rendered_pixels: Vec<_> = pixmap
        .data()
        .chunks_exact(4)
        .map(|rgba| Color32::from_rgba_premultiplied(rgba[0], rgba[1], rgba[2], rgba[3]))
        .collect();
    let padding = (MATH_RASTER_PADDING_POINTS * MATH_PIXELS_PER_POINT).ceil() as usize;
    let width = rendered_width + padding * 2;
    let height = rendered_height + padding * 2;
    let mut pixels = vec![Color32::TRANSPARENT; width * height];
    for row in 0..rendered_height {
        let source_start = row * rendered_width;
        let target_start = (row + padding) * width + padding;
        pixels[target_start..target_start + rendered_width]
            .copy_from_slice(&rendered_pixels[source_start..source_start + rendered_width]);
    }
    Ok(egui::ColorImage {
        size: [width, height],
        pixels,
        source_size: egui::vec2(width as f32, height as f32),
    })
}

fn completion_row(ui: &mut egui::Ui, value: &str, selected: bool) -> egui::Response {
    let button = egui::Button::new(RichText::new(value).monospace())
        .selected(selected)
        .min_size(egui::vec2(ui.available_width(), 28.0));
    let response = ui.add(button);
    if selected {
        response.scroll_to_me(None);
    }
    response
}

fn move_index_for_drop(source_index: usize, hovered_index: usize, before: bool) -> usize {
    let boundary = if before {
        hovered_index
    } else {
        hovered_index + 1
    };
    boundary.saturating_sub(usize::from(source_index < boundary))
}

fn inverse_cell_changes(cells: &[Cell], changes: &[CellMutation]) -> Option<Vec<CellMutation>> {
    let mut working = cells.to_vec();
    let mut inverse = Vec::with_capacity(changes.len());
    for change in changes {
        match change {
            CellMutation::Insert { index, cell } => {
                working.insert((*index).min(working.len()), cell.clone());
                inverse.push(CellMutation::Delete {
                    cell_id: cell.id.clone(),
                });
            }
            CellMutation::Update {
                cell_id,
                source,
                metadata,
                cell_type,
            } => {
                let cell = working.iter_mut().find(|cell| &cell.id == cell_id)?;
                inverse.push(CellMutation::Update {
                    cell_id: cell_id.clone(),
                    source: source.as_ref().map(|_| cell.source.clone()),
                    metadata: metadata.as_ref().map(|_| cell.metadata.clone()),
                    cell_type: cell_type.as_ref().map(|_| cell.cell_type.clone()),
                });
                if let Some(source) = source {
                    cell.source.clone_from(source);
                }
                if let Some(metadata) = metadata {
                    cell.metadata.clone_from(metadata);
                }
                if let Some(cell_type) = cell_type {
                    cell.cell_type.clone_from(cell_type);
                }
            }
            CellMutation::Delete { cell_id } => {
                let index = working.iter().position(|cell| &cell.id == cell_id)?;
                let cell = working.remove(index);
                inverse.push(CellMutation::Insert { index, cell });
            }
            CellMutation::Move { cell_id, index } => {
                let previous = working.iter().position(|cell| &cell.id == cell_id)?;
                let cell = working.remove(previous);
                working.insert((*index).min(working.len()), cell);
                inverse.push(CellMutation::Move {
                    cell_id: cell_id.clone(),
                    index: previous,
                });
            }
            CellMutation::ClearOutputs { .. } => return None,
        }
    }
    inverse.reverse();
    Some(inverse)
}

fn notebook_document_width(available_width: f32) -> f32 {
    available_width.clamp(0.0, 1120.0)
}

#[derive(Clone, Copy)]
enum ToolbarIcon {
    Save,
    Add,
    Up,
    Down,
    Run,
    Stop,
    Restart,
}

fn toolbar_icon_button(ui: &mut egui::Ui, enabled: bool, icon: ToolbarIcon, tooltip: &str) -> bool {
    let response = ui
        .add_enabled(
            enabled,
            egui::Button::new("").min_size(egui::vec2(30.0, 28.0)),
        )
        .on_hover_text(tooltip);
    let rect = response.rect.shrink(7.0);
    let color = if enabled {
        ui.visuals().widgets.inactive.fg_stroke.color
    } else {
        ui.visuals().weak_text_color()
    };
    let stroke = Stroke::new(1.6, color);
    let painter = ui.painter();
    match icon {
        ToolbarIcon::Save => {
            painter.rect_stroke(rect, 1.0, stroke, egui::StrokeKind::Inside);
            painter.line_segment(
                [
                    egui::pos2(rect.left() + 3.0, rect.top()),
                    egui::pos2(rect.left() + 3.0, rect.center().y - 1.0),
                ],
                stroke,
            );
            painter.rect_stroke(
                egui::Rect::from_min_max(
                    egui::pos2(rect.left() + 3.0, rect.center().y + 1.0),
                    egui::pos2(rect.right() - 3.0, rect.bottom()),
                ),
                0.0,
                stroke,
                egui::StrokeKind::Inside,
            );
        }
        ToolbarIcon::Add => {
            painter.line_segment(
                [
                    egui::pos2(rect.center().x, rect.top()),
                    egui::pos2(rect.center().x, rect.bottom()),
                ],
                stroke,
            );
            painter.line_segment(
                [
                    egui::pos2(rect.left(), rect.center().y),
                    egui::pos2(rect.right(), rect.center().y),
                ],
                stroke,
            );
        }
        ToolbarIcon::Up | ToolbarIcon::Down => {
            let direction = if matches!(icon, ToolbarIcon::Up) {
                -1.0
            } else {
                1.0
            };
            let tip = egui::pos2(rect.center().x, rect.center().y + direction * 6.0);
            let base_y = rect.center().y - direction * 2.0;
            painter.line_segment([tip, egui::pos2(rect.left(), base_y)], stroke);
            painter.line_segment([tip, egui::pos2(rect.right(), base_y)], stroke);
            painter.line_segment(
                [
                    egui::pos2(rect.center().x, base_y),
                    egui::pos2(rect.center().x, rect.center().y - direction * 6.0),
                ],
                stroke,
            );
        }
        ToolbarIcon::Run => {
            painter.add(egui::Shape::convex_polygon(
                vec![
                    rect.left_top(),
                    egui::pos2(rect.right(), rect.center().y),
                    rect.left_bottom(),
                ],
                color,
                Stroke::NONE,
            ));
        }
        ToolbarIcon::Stop => {
            painter.rect_filled(rect.shrink(2.0), 0.0, color);
        }
        ToolbarIcon::Restart => {
            painter.circle_stroke(rect.center(), rect.width() * 0.38, stroke);
            painter.add(egui::Shape::convex_polygon(
                vec![
                    egui::pos2(rect.left(), rect.top() + 1.0),
                    egui::pos2(rect.left() + 7.0, rect.top()),
                    egui::pos2(rect.left() + 3.0, rect.top() + 7.0),
                ],
                color,
                Stroke::NONE,
            ));
        }
    }
    response.clicked()
}

fn drag_handle() -> egui::Button<'static> {
    egui::Button::new(RichText::new("Drag").small())
        .sense(egui::Sense::drag())
        .min_size(egui::vec2(52.0, 28.0))
}

fn cell_run_button(ui: &mut egui::Ui, enabled: bool, running: bool) -> egui::Response {
    let (rect, response) = ui.allocate_exact_size(
        egui::vec2(28.0, 28.0),
        if enabled {
            egui::Sense::click()
        } else {
            egui::Sense::hover()
        },
    );
    let visuals = ui.style().interact(&response);
    ui.painter()
        .rect_filled(rect, CornerRadius::same(2), visuals.weak_bg_fill);
    ui.painter().rect_stroke(
        rect,
        CornerRadius::same(2),
        visuals.bg_stroke,
        egui::StrokeKind::Inside,
    );
    let center = rect.center();
    if running {
        ui.ctx().request_repaint_after(Duration::from_millis(80));
        let start = ui.input(|input| input.time as f32) * 4.0;
        let radius = 6.0;
        let points = (0..=12)
            .map(|step| {
                let angle = start + std::f32::consts::TAU * step as f32 / 18.0;
                center + egui::vec2(angle.cos(), angle.sin()) * radius
            })
            .collect::<Vec<_>>();
        ui.painter().add(egui::Shape::line(
            points,
            Stroke::new(2.0, Color32::from_rgb(2, 119, 189)),
        ));
        response.on_hover_text("This cell is running")
    } else {
        let color = if enabled {
            Color32::from_rgb(38, 50, 56)
        } else {
            Color32::from_gray(150)
        };
        ui.painter().add(egui::Shape::convex_polygon(
            vec![
                center + egui::vec2(-4.0, -6.0),
                center + egui::vec2(6.0, 0.0),
                center + egui::vec2(-4.0, 6.0),
            ],
            color,
            Stroke::NONE,
        ));
        response.on_hover_text(if enabled {
            "Run this cell"
        } else {
            "Wait for the current notebook operation to finish"
        })
    }
}

fn execution_status_icon(ui: &mut egui::Ui, completed: bool, running: bool) {
    let (rect, response) = ui.allocate_exact_size(egui::vec2(14.0, 28.0), egui::Sense::hover());
    if running {
        ui.painter()
            .circle_filled(rect.center(), 3.5, Color32::from_rgb(2, 119, 189));
        response.on_hover_text("Cell execution in progress");
    } else if completed {
        let center = rect.center();
        let stroke = Stroke::new(1.8, Color32::from_rgb(46, 125, 50));
        ui.painter().line_segment(
            [
                egui::pos2(center.x - 4.0, center.y),
                egui::pos2(center.x - 1.0, center.y + 3.0),
            ],
            stroke,
        );
        ui.painter().line_segment(
            [
                egui::pos2(center.x - 1.0, center.y + 3.0),
                egui::pos2(center.x + 5.0, center.y - 4.0),
            ],
            stroke,
        );
        response.on_hover_text("Cell execution completed");
    }
}

fn output_collapse_summary(count: usize) -> String {
    match count {
        1 => "… 1 output hidden — click to expand".into(),
        count => format!("… {count} outputs hidden — click to expand"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use notebook_protocol::{KernelIdentity, KernelState, NotebookIdentity, NotebookSnapshot};

    fn app() -> NotebookEguiApp {
        let snapshot = NotebookSnapshot {
            protocol_version: PROTOCOL_VERSION,
            schema_version: 1,
            notebook: NotebookIdentity {
                path: "completion.ipynb".into(),
                workspace: "local".into(),
            },
            kernel: KernelIdentity {
                name: "python3".into(),
                display_name: "Python 3".into(),
                session_id: None,
                state: KernelState::Idle,
            },
            revision: 1,
            cells: vec![Cell {
                id: "code".into(),
                cell_type: CellType::Code,
                source: "value.bi".into(),
                metadata: serde_json::json!({}),
                execution_count: None,
                outputs: vec![],
            }],
            selected_cell_id: Some("code".into()),
        };
        NotebookEguiApp::new(NotebookState::new(snapshot).unwrap())
    }

    #[test]
    fn selected_completion_replaces_kernel_cursor_range() {
        let mut app = app();
        let cell = app.state.snapshot.cells[0].clone();
        app.request_completion(&cell);
        let command_id = app.drain_commands()[0].command_id;
        app.apply_completion(
            command_id,
            CompletionReply {
                matches: vec!["bit_count".into(), "bit_length".into()],
                cursor_start: 6,
                cursor_end: 8,
            },
        );
        app.completion_selection.insert("code".into(), 1);

        app.accept_completion("code");

        assert_eq!(app.editors[0].1, "value.bit_length");
        assert!(app.dirty_editors.contains("code"));
        assert!(!app.completion_suggestions.contains_key("code"));
        assert_eq!(app.pending_caret_positions.get("code"), Some(&16));
    }

    #[test]
    fn drop_index_accounts_for_removing_the_dragged_cell() {
        assert_eq!(move_index_for_drop(0, 2, true), 1);
        assert_eq!(move_index_for_drop(0, 2, false), 2);
        assert_eq!(move_index_for_drop(3, 1, true), 1);
        assert_eq!(move_index_for_drop(3, 1, false), 2);
    }

    #[test]
    fn drag_handle_is_a_non_selectable_button() {
        fn assert_button(_: egui::Button<'static>) {}

        assert_button(drag_handle());
    }

    #[test]
    fn notebook_document_width_tracks_narrow_frames() {
        assert_eq!(notebook_document_width(720.0), 720.0);
        assert_eq!(notebook_document_width(1440.0), 1120.0);
        assert_eq!(notebook_document_width(-1.0), 0.0);
    }

    #[test]
    fn markdown_is_rendered_by_default() {
        let mut snapshot = app().state.snapshot;
        snapshot.cells[0].cell_type = CellType::Markdown;

        let app = NotebookEguiApp::new(NotebookState::new(snapshot).unwrap());

        assert!(app.rendered_markdown.contains("code"));
    }

    #[test]
    fn output_collapse_is_local_and_preserves_outputs() {
        let mut app = app();
        app.state.snapshot.cells[0].outputs = vec![CellOutput::Text { text: "42".into() }];

        app.toggle_selected_output();
        assert!(app.collapsed_outputs.contains("code"));
        assert_eq!(app.state.snapshot.cells[0].outputs.len(), 1);

        app.toggle_selected_output();
        assert!(!app.collapsed_outputs.contains("code"));
        assert_eq!(app.state.snapshot.cells[0].outputs.len(), 1);
    }

    #[test]
    fn output_collapse_summary_handles_singular_and_plural() {
        assert_eq!(
            output_collapse_summary(1),
            "… 1 output hidden — click to expand"
        );
        assert_eq!(
            output_collapse_summary(3),
            "… 3 outputs hidden — click to expand"
        );
    }

    #[test]
    fn refresh_preserves_editing_and_renders_new_markdown() {
        let mut snapshot = app().state.snapshot;
        snapshot.cells[0].cell_type = CellType::Markdown;
        let mut app = NotebookEguiApp::new(NotebookState::new(snapshot.clone()).unwrap());
        app.rendered_markdown.remove("code");

        snapshot.revision += 1;
        snapshot.cells.push(Cell {
            id: "new-markdown".into(),
            cell_type: CellType::Markdown,
            source: "## New".into(),
            metadata: serde_json::json!({}),
            execution_count: None,
            outputs: vec![],
        });
        app.replace_state(NotebookState::new(snapshot).unwrap());

        assert!(!app.rendered_markdown.contains("code"));
        assert!(app.rendered_markdown.contains("new-markdown"));
    }

    #[test]
    fn rendered_markdown_senses_double_clicks() {
        let context = egui::Context::default();
        let mut senses_click = false;
        let _ = context.run(egui::RawInput::default(), |context| {
            egui::CentralPanel::default().show(context, |ui| {
                let mut cache = CommonMarkCache::default();
                let math_cache = Arc::new(Mutex::new(MathRenderCache::default()));
                senses_click =
                    rendered_markdown_response(ui, "markdown", "# Hello", &mut cache, &math_cache)
                        .sense
                        .senses_click();
            });
        });

        assert!(senses_click);
    }

    #[test]
    fn markdown_math_is_typeset_into_an_image() {
        for formula in [
            r"\frac{1}{2}x^2",
            r"U_f\ket{x} = (-1)^{s \cdot x}\ket{x}",
            r"\ket{\psi}=\sum_x a_x \ket{x}",
        ] {
            let image = render_math_formula(formula, false).unwrap();

            assert!(image.width() > 1);
            assert!(image.height() > 1);
            assert!(image.pixels.iter().any(|pixel| pixel.a() > 0));
        }
    }

    #[test]
    fn markdown_math_preserves_padding_around_matrix_glyphs() {
        let image = render_math_formula(
            r"H = \frac{1}{\sqrt{2}} \begin{pmatrix} 1 & 1 \\ 1 & -1 \end{pmatrix}",
            true,
        )
        .unwrap();
        let width = image.width();
        let height = image.height();
        let top = (0..width).any(|x| image.pixels[x].a() > 0);
        let bottom = (0..width).any(|x| image.pixels[(height - 1) * width + x].a() > 0);
        let left = (0..height).any(|y| image.pixels[y * width].a() > 0);
        let right = (0..height).any(|y| image.pixels[y * width + width - 1].a() > 0);

        assert!(
            !(top || bottom || left || right),
            "math glyphs touch bitmap boundary: top={top}, bottom={bottom}, left={left}, right={right}"
        );
    }

    #[test]
    fn markdown_base64_image_uri_loads_without_network() {
        let context = egui::Context::default();
        install_data_image_loader(&context);
        egui_extras::install_image_loaders(&context);
        let uri = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

        assert!(matches!(
            context.try_load_bytes(uri),
            Ok(egui::load::BytesPoll::Ready { .. })
        ));
    }

    #[test]
    fn clicking_rendered_markdown_selects_without_editing() {
        let mut app = app();
        app.state.snapshot.selected_cell_id = None;

        app.apply_rendered_markdown_interaction("code", true, false);

        assert_eq!(app.state.snapshot.selected_cell_id.as_deref(), Some("code"));
        assert!(!app.edit_mode);
        assert!(app.pending_editor_focus.is_none());
    }

    #[test]
    fn double_clicking_rendered_markdown_selects_and_edits() {
        let mut app = app();
        app.rendered_markdown.insert("code".into());

        app.apply_rendered_markdown_interaction("code", true, true);

        assert_eq!(app.state.snapshot.selected_cell_id.as_deref(), Some("code"));
        assert!(app.edit_mode);
        assert_eq!(app.pending_editor_focus.as_deref(), Some("code"));
        assert!(!app.rendered_markdown.contains("code"));
    }

    #[test]
    fn enter_on_selected_rendered_markdown_reveals_the_editor() {
        let mut app = app();
        app.state.snapshot.cells[0].cell_type = CellType::Markdown;
        app.rendered_markdown.insert("code".into());

        app.begin_editing_cell("code");

        assert!(app.edit_mode);
        assert_eq!(app.pending_editor_focus.as_deref(), Some("code"));
        assert!(!app.rendered_markdown.contains("code"));
    }

    #[test]
    fn selected_completion_scrolls_into_view() {
        let context = egui::Context::default();
        let mut scroll_id = egui::Id::NULL;
        for _ in 0..2 {
            let _ = context.run(egui::RawInput::default(), |context| {
                egui::CentralPanel::default().show(context, |ui| {
                    scroll_id = ui.make_persistent_id(egui::Id::new("completion-scroll-test"));
                    egui::ScrollArea::vertical()
                        .id_salt("completion-scroll-test")
                        .max_height(60.0)
                        .show(ui, |ui| {
                            for index in 0..12 {
                                completion_row(ui, &format!("item-{index}"), index == 11);
                            }
                        });
                });
            });
        }

        let state = egui::scroll_area::State::load(&context, scroll_id).unwrap();
        assert!(state.offset.y > 0.0);
    }

    #[test]
    fn ansi_kernel_output_is_styled_without_control_glyphs() {
        let base = Color32::from_rgb(38, 50, 56);
        let job = ansi_layout_job("\u{1b}[31mSyntaxError\u{1b}[0m", base);

        assert_eq!(job.text, "SyntaxError");
        assert!(job.text.chars().all(|character| !character.is_control()));
        assert!(job.sections.iter().any(|section| {
            section.format.color == Color32::from_rgb(198, 40, 40)
                && &job.text[section.byte_range.clone()] == "SyntaxError"
        }));
    }

    #[test]
    fn rich_png_output_is_decoded_for_the_egui_bytes_loader() {
        let bytes = decode_rich_image("image/png", "iVBORw0KGgo=").unwrap();

        assert_eq!(&bytes[..8], b"\x89PNG\r\n\x1a\n");
    }

    #[test]
    fn png_dimensions_reserve_plot_space_before_texture_loading() {
        let mut png = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR".to_vec();
        png.extend_from_slice(&715_u32.to_be_bytes());
        png.extend_from_slice(&397_u32.to_be_bytes());

        assert_eq!(png_dimensions(&png), Some((715, 397)));
    }

    #[test]
    fn executed_code_cell_has_completion_status() {
        let mut cell = app().state.snapshot.cells[0].clone();
        assert!(!cell_has_completed_execution(&cell));

        cell.execution_count = Some(1);

        assert!(cell_has_completed_execution(&cell));
    }

    #[test]
    fn single_cell_execution_tracks_progress_until_result_arrives() {
        let mut app = app();
        let cell = app.state.snapshot.cells[0].clone();

        app.execute_cell(0, &cell);
        let command = app.drain_commands().pop().unwrap();

        assert_eq!(
            app.pending_execution_cells.get(&command.command_id),
            Some(&"code".to_owned())
        );
        assert!(matches!(
            command.kind,
            NotebookCommandKind::ExecuteCell { cell_id } if cell_id == "code"
        ));

        app.finish_command(command.command_id);
        assert!(app.pending_execution_cells.is_empty());
    }

    #[test]
    fn structural_inverse_restores_deleted_cell() {
        let cells = app().state.snapshot.cells;
        let inverse = inverse_cell_changes(
            &cells,
            &[CellMutation::Delete {
                cell_id: "code".into(),
            }],
        )
        .unwrap();

        assert!(matches!(
            &inverse[0],
            CellMutation::Insert { index: 0, cell } if cell.id == "code"
        ));
    }

    #[test]
    fn html_output_is_reduced_to_safe_table_text() {
        let text = sanitized_html_text(
            "<table><tr><th>Name</th><th>Value</th></tr><tr><td>x</td><td>42</td></tr></table><script>alert(1)</script>",
        );

        assert!(!text.contains('<'));
        assert!(text.contains("Name\tValue"));
        assert!(text.contains("x\t42"));
    }
}
