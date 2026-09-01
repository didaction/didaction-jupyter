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
    pending_completions: BTreeMap<Uuid, String>,
    rendered_markdown: HashSet<String>,
    edit_mode: bool,
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
            pending_completions: BTreeMap::new(),
            rendered_markdown: HashSet::new(),
            edit_mode: false,
        }
    }
    pub fn apply_completion(&mut self, command_id: Uuid, completion: CompletionReply) {
        if let Some(cell_id) = self.pending_completions.remove(&command_id) {
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
    fn toolbar(&mut self, ui: &mut egui::Ui) {
        ui.horizontal_wrapped(|ui| {
            ui.heading(
                RichText::new("didaction notebook")
                    .size(18.0)
                    .color(Color32::from_rgb(38, 50, 56)),
            );
            ui.separator();
            let idle = !matches!(
                self.state.sync_state,
                SyncState::Dirty | SyncState::Executing
            );
            if ui
                .add_enabled(idle, egui::Button::new("Add code"))
                .on_hover_text("Insert a code cell")
                .clicked()
            {
                self.insert_cell_after_selection(CellType::Code);
            }
            if ui
                .add_enabled(idle, egui::Button::new("Add Markdown"))
                .on_hover_text("Insert a Markdown cell")
                .clicked()
            {
                self.insert_cell_after_selection(CellType::Markdown);
            }
            if ui.add_enabled(idle, egui::Button::new("Run all")).clicked() {
                for cell in self.state.snapshot.cells.clone() {
                    self.flush_editor(&cell);
                    if cell.cell_type == CellType::Code {
                        self.emit(NotebookCommandKind::ExecuteCell { cell_id: cell.id });
                    }
                }
            }
            ui.separator();
            let can_interrupt = idle || self.state.sync_state == SyncState::Executing;
            if ui
                .add_enabled(can_interrupt, egui::Button::new("Interrupt"))
                .clicked()
            {
                self.emit(NotebookCommandKind::InterruptKernel);
            }
            if ui.add_enabled(idle, egui::Button::new("Restart")).clicked() {
                self.emit(NotebookCommandKind::RestartKernel);
            }
            ui.separator();
            ui.label(if self.edit_mode {
                "Edit mode"
            } else {
                "Command mode"
            });
            if self.state.sync_state == SyncState::Disconnected
                && ui
                    .add_enabled(idle, egui::Button::new("Reconnect"))
                    .clicked()
            {
                self.emit(NotebookCommandKind::Reconnect);
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
        frame.show(ui, |ui| {
            ui.horizontal_wrapped(|ui| {
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
                let idle = !matches!(
                    self.state.sync_state,
                    SyncState::Dirty | SyncState::Executing
                );
                if cell.cell_type == CellType::Code
                    && ui.add_enabled(idle, egui::Button::new("Run")).clicked()
                {
                    self.flush_editor(&cell);
                    self.emit(NotebookCommandKind::ExecuteCell {
                        cell_id: cell.id.clone(),
                    });
                }
                ui.separator();
                if ui
                    .add_enabled(idle, egui::Button::new("Add above"))
                    .clicked()
                {
                    self.flush_editor(&cell);
                    self.insert_cell(index, CellType::Code, String::new());
                }
                if ui
                    .add_enabled(idle, egui::Button::new("Add below"))
                    .clicked()
                {
                    self.flush_editor(&cell);
                    self.insert_cell(index + 1, CellType::Code, String::new());
                }
                if ui
                    .add_enabled(idle, egui::Button::new("Duplicate"))
                    .clicked()
                {
                    self.flush_editor(&cell);
                    self.insert_cell(index + 1, cell.cell_type.clone(), self.editor_source(&cell));
                }
                ui.separator();
                if cell.cell_type != CellType::Code
                    && ui.add_enabled(idle, egui::Button::new("Code")).clicked()
                {
                    self.flush_editor(&cell);
                    self.emit(NotebookCommandKind::ModifyCells {
                        changes: vec![CellMutation::Update {
                            cell_id: cell.id.clone(),
                            source: Some(self.editor_source(&cell)),
                            metadata: None,
                            cell_type: Some(CellType::Code),
                        }],
                    });
                }
                if cell.cell_type != CellType::Markdown
                    && ui
                        .add_enabled(idle, egui::Button::new("Markdown"))
                        .clicked()
                {
                    self.flush_editor(&cell);
                    self.emit(NotebookCommandKind::ModifyCells {
                        changes: vec![CellMutation::Update {
                            cell_id: cell.id.clone(),
                            source: Some(self.editor_source(&cell)),
                            metadata: None,
                            cell_type: Some(CellType::Markdown),
                        }],
                    });
                }
                if cell.cell_type != CellType::Raw
                    && ui.add_enabled(idle, egui::Button::new("Raw")).clicked()
                {
                    self.flush_editor(&cell);
                    self.emit(NotebookCommandKind::ModifyCells {
                        changes: vec![CellMutation::Update {
                            cell_id: cell.id.clone(),
                            source: Some(self.editor_source(&cell)),
                            metadata: None,
                            cell_type: Some(CellType::Raw),
                        }],
                    });
                }
                ui.separator();
                if index > 0 && ui.add_enabled(idle, egui::Button::new("Move up")).clicked() {
                    self.flush_editor(&cell);
                    self.emit(NotebookCommandKind::ModifyCells {
                        changes: vec![CellMutation::Move {
                            cell_id: cell.id.clone(),
                            index: index - 1,
                        }],
                    });
                }
                if index + 1 < self.state.snapshot.cells.len()
                    && ui
                        .add_enabled(idle, egui::Button::new("Move down"))
                        .clicked()
                {
                    self.flush_editor(&cell);
                    self.emit(NotebookCommandKind::ModifyCells {
                        changes: vec![CellMutation::Move {
                            cell_id: cell.id.clone(),
                            index: index + 1,
                        }],
                    });
                }
                ui.separator();
                if ui.add_enabled(idle, egui::Button::new("Delete")).clicked() {
                    self.flush_editor(&cell);
                    self.emit(NotebookCommandKind::ModifyCells {
                        changes: vec![CellMutation::Delete {
                            cell_id: cell.id.clone(),
                        }],
                    });
                }
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
                        CodeEditor::default()
                            .id_source(format!("code-editor-{}", cell.id))
                            .with_rows(editor.lines().count().clamp(2, 18))
                            .with_fontsize(14.0)
                            .with_theme(ColorTheme::GITHUB_LIGHT)
                            .with_syntax(Syntax::python())
                            .with_numlines(true)
                            .vscroll(false)
                            .show(ui, editor)
                            .response
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
                ui.horizontal_wrapped(|ui| {
                    ui.label("Completions:");
                    for value in completion.matches.iter().take(12) {
                        if ui.button(value).clicked() {
                            if let Some((_, editor)) =
                                self.editors.iter_mut().find(|(id, _)| id == &cell.id)
                            {
                                let start = completion.cursor_start.min(editor.len());
                                let end = completion.cursor_end.min(editor.len()).max(start);
                                if editor.is_char_boundary(start) && editor.is_char_boundary(end) {
                                    editor.replace_range(start..end, value);
                                    self.dirty_editors.insert(cell.id.clone());
                                }
                            }
                            self.completion_suggestions.remove(&cell.id);
                        }
                    }
                });
            }
            for output in &cell.outputs {
                render_output(ui, output);
            }
        });
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
        if self.edit_mode
            && ctx.input(|input| input.key_pressed(Key::Tab))
            && let Some(cell) = self
                .state
                .snapshot
                .selected_cell_id
                .as_ref()
                .and_then(|id| self.state.snapshot.cells.iter().find(|cell| &cell.id == id))
                .filter(|cell| cell.cell_type == CellType::Code)
                .cloned()
        {
            ctx.input_mut(|input| input.consume_key(egui::Modifiers::NONE, Key::Tab));
            self.request_completion(&cell);
        }
        if ctx.input(|input| input.key_pressed(Key::Escape)) {
            self.edit_mode = false;
        }
        let command_mode = !self.edit_mode;
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
                    .inner_margin(Margin::symmetric(16, 12)),
            )
            .show(ctx, |ui| {
                egui::ScrollArea::vertical()
                    .auto_shrink([false, false])
                    .show(ui, |ui| {
                        ui.set_max_width(1120.0);
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
