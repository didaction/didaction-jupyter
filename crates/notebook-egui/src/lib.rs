use egui::text::{CCursor, CCursorRange};
use egui::{Color32, CornerRadius, Key, Margin, RichText, Stroke, TextEdit};
use egui_code_editor::{CodeEditor, ColorTheme, Syntax};
use notebook_core::{NotebookState, SyncState};
use notebook_protocol::{
    Cell, CellMutation, CellOutput, CellType, CompletionReply, NotebookCommand,
    NotebookCommandKind, PROTOCOL_VERSION,
};
use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use uuid::Uuid;

pub struct NotebookEguiApp {
    pub state: NotebookState,
    outbound: VecDeque<NotebookCommand>,
    editors: Vec<(String, String)>,
    dirty_editors: HashSet<String>,
    completion_suggestions: HashMap<String, CompletionReply>,
    completion_selection: HashMap<String, usize>,
    pending_caret_positions: HashMap<String, usize>,
    pending_completions: BTreeMap<Uuid, String>,
    dragging_cell: Option<String>,
    rendered_markdown: HashSet<String>,
    edit_mode: bool,
    pending_editor_focus: Option<String>,
}

impl NotebookEguiApp {
    pub fn new(state: NotebookState) -> Self {
        let editors = state
            .snapshot
            .cells
            .iter()
            .map(|c| (c.id.clone(), c.source.clone()))
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
            dragging_cell: None,
            rendered_markdown: HashSet::new(),
            edit_mode: false,
            pending_editor_focus: None,
        }
    }
    pub fn apply_completion(&mut self, command_id: Uuid, completion: CompletionReply) {
        if let Some(cell_id) = self.pending_completions.remove(&command_id) {
            self.completion_selection.insert(cell_id.clone(), 0);
            self.completion_suggestions.insert(cell_id, completion);
        }
    }
    pub fn drain_commands(&mut self) -> Vec<NotebookCommand> {
        self.outbound.drain(..).collect()
    }
    pub fn replace_state(&mut self, state: NotebookState) {
        self.state = state;
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
        self.outbound.push_back(NotebookCommand {
            protocol_version: PROTOCOL_VERSION,
            command_id: Uuid::new_v4(),
            idempotency_key: Uuid::new_v4().to_string(),
            expected_revision: Some(self.state.snapshot.revision),
            timeout_ms: 30_000,
            kind,
        });
    }
    fn request_completion(&mut self, cell: &Cell) {
        let code = self.editor_source(cell);
        let command_id = Uuid::new_v4();
        self.pending_completions.insert(command_id, cell.id.clone());
        self.outbound.push_back(NotebookCommand {
            protocol_version: PROTOCOL_VERSION,
            command_id,
            idempotency_key: Uuid::new_v4().to_string(),
            expected_revision: Some(self.state.snapshot.revision),
            timeout_ms: 10_000,
            kind: NotebookCommandKind::Complete {
                cursor_pos: code.len(),
                code,
            },
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
        if let Some((_, cell)) = self.selected_cell() {
            self.flush_editor(&cell);
            self.emit(NotebookCommandKind::ModifyCells {
                changes: vec![CellMutation::Delete { cell_id: cell.id }],
            });
        }
    }
    fn duplicate_selected(&mut self) {
        if let Some((index, cell)) = self.selected_cell() {
            self.flush_editor(&cell);
            self.insert_cell(index + 1, cell.cell_type.clone(), self.editor_source(&cell));
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
                });
                ui.menu_button("Edit", |ui| {
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
                        self.emit(NotebookCommandKind::RestartKernel);
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
                    self.emit(NotebookCommandKind::RestartKernel);
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
    fn insert_cell(&mut self, index: usize, cell_type: CellType, source: String) {
        let cell = Cell {
            id: Uuid::new_v4().to_string(),
            cell_type,
            source,
            metadata: serde_json::json!({}),
            execution_count: None,
            outputs: vec![],
        };
        self.emit(NotebookCommandKind::ModifyCells {
            changes: vec![CellMutation::Insert { index, cell }],
        });
    }
    fn status(&self, ui: &mut egui::Ui) {
        let (label, color) = match self.state.sync_state {
            SyncState::Synchronized => ("Saved", Color32::from_rgb(46, 125, 50)),
            SyncState::Dirty => ("Pending", Color32::from_rgb(239, 108, 0)),
            SyncState::Executing => ("Running", Color32::from_rgb(2, 119, 189)),
            SyncState::Disconnected => ("Disconnected", Color32::from_rgb(198, 40, 40)),
            SyncState::Error => ("Action required", Color32::from_rgb(198, 40, 40)),
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
        let selected = self.state.snapshot.selected_cell_id.as_deref() == Some(&cell.id);
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
                ui.label(
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
                );
            });
            if cell.cell_type == CellType::Markdown {
                let rendered = self.rendered_markdown.contains(&cell.id);
                if ui
                    .button(if rendered {
                        "Edit Markdown"
                    } else {
                        "Render Markdown"
                    })
                    .clicked()
                {
                    if rendered {
                        self.rendered_markdown.remove(&cell.id);
                    } else {
                        self.rendered_markdown.insert(cell.id.clone());
                    }
                }
                if rendered {
                    render_markdown(ui, &self.editor_source(&cell));
                }
            }
            let show_editor =
                cell.cell_type != CellType::Markdown || !self.rendered_markdown.contains(&cell.id);
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
                            .with_numlines(true)
                            .vscroll(false)
                            .show(ui, editor);
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
                    }
                    if self.pending_editor_focus.as_deref() == Some(&cell.id) {
                        response.request_focus();
                        self.pending_editor_focus = None;
                    }
                    if response.has_focus() || response.clicked() {
                        self.state.snapshot.selected_cell_id = Some(cell.id.clone());
                        self.edit_mode = true;
                    }
                    if response.has_focus() && ui.input(|input| input.key_pressed(Key::Escape)) {
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
                            for (index, value) in completion.matches.iter().take(12).enumerate() {
                                let button = egui::Button::new(RichText::new(value).monospace())
                                    .selected(index == selected)
                                    .min_size(egui::vec2(ui.available_width(), 28.0));
                                if ui.add(button).clicked() {
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
            for output in &cell.outputs {
                render_output(ui, output);
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
        egui_extras::install_image_loaders(ctx);
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
            && ctx.input(|input| input.key_pressed(Key::Tab))
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
        let command_mode = !self.edit_mode;
        if command_mode
            && ctx.input(|input| input.key_pressed(Key::Enter))
            && let Some((_, cell)) = self.selected_cell()
        {
            self.pending_editor_focus = Some(cell.id);
            self.edit_mode = true;
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
            .show(ui, |ui| {
                ui.add(
                    egui::Image::from_uri(if mime == "image/png" {
                        format!("data:image/png;base64,{data}")
                    } else {
                        format!("data:image/svg+xml;base64,{data}")
                    })
                    .max_width(ui.available_width())
                    .alt_text("Notebook graph output"),
                );
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
            ui.add(egui::Label::new(RichText::new(text).monospace()).wrap());
        });
}

fn render_markdown(ui: &mut egui::Ui, source: &str) {
    for line in source.lines() {
        if let Some(text) = line.strip_prefix("# ") {
            ui.heading(text);
        } else if let Some(text) = line.strip_prefix("## ") {
            ui.label(RichText::new(text).size(18.0).strong());
        } else if line.starts_with("- ") {
            ui.label(format!("• {}", line.trim_start_matches("- ")));
        } else {
            ui.label(line);
        }
    }
}

fn move_index_for_drop(source_index: usize, hovered_index: usize, before: bool) -> usize {
    let boundary = if before {
        hovered_index
    } else {
        hovered_index + 1
    };
    boundary.saturating_sub(usize::from(source_index < boundary))
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
}
