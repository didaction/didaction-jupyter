use egui::{Color32, CornerRadius, Key, Margin, RichText, Stroke, TextEdit};
use notebook_core::{NotebookState, SyncState};
use notebook_protocol::{
    Cell, CellMutation, CellOutput, CellType, NotebookCommand, NotebookCommandKind,
    PROTOCOL_VERSION,
};
use std::collections::VecDeque;
use uuid::Uuid;

pub struct NotebookEguiApp {
    pub state: NotebookState,
    outbound: VecDeque<NotebookCommand>,
    editors: Vec<(String, String)>,
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
    fn toolbar(&mut self, ui: &mut egui::Ui) {
        ui.horizontal(|ui| {
            ui.heading(
                RichText::new("didaction notebook")
                    .size(18.0)
                    .color(Color32::from_rgb(38, 50, 56)),
            );
            ui.separator();
            if ui
                .button("＋ Code")
                .on_hover_text("Insert a code cell")
                .clicked()
            {
                self.insert_cell(CellType::Code);
            }
            if ui
                .button("＋ Markdown")
                .on_hover_text("Insert a Markdown cell")
                .clicked()
            {
                self.insert_cell(CellType::Markdown);
            }
            if ui.button("Run all").clicked() {
                for cell in self.state.snapshot.cells.clone() {
                    if cell.cell_type == CellType::Code {
                        self.emit(NotebookCommandKind::ExecuteCell { cell_id: cell.id });
                    }
                }
            }
            ui.separator();
            if ui.button("Interrupt").clicked() {
                self.emit(NotebookCommandKind::InterruptKernel);
            }
            if ui.button("Restart").clicked() {
                self.emit(NotebookCommandKind::RestartKernel);
            }
            if self.state.sync_state == SyncState::Disconnected && ui.button("Reconnect").clicked()
            {
                self.emit(NotebookCommandKind::Reconnect);
            }
        });
    }
    fn insert_cell(&mut self, cell_type: CellType) {
        let cell = Cell {
            id: Uuid::new_v4().to_string(),
            cell_type,
            source: String::new(),
            metadata: serde_json::json!({}),
            execution_count: None,
            outputs: vec![],
        };
        self.emit(NotebookCommandKind::ModifyCells {
            changes: vec![CellMutation::Insert {
                index: self.state.snapshot.cells.len(),
                cell,
            }],
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
            ui.colored_label(color, "●");
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
            ui.horizontal(|ui| {
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
                if cell.cell_type == CellType::Code && ui.button("▶ Run").clicked() {
                    self.emit(NotebookCommandKind::ExecuteCell {
                        cell_id: cell.id.clone(),
                    });
                }
                if index > 0 && ui.small_button("↑").on_hover_text("Move cell up").clicked() {
                    self.emit(NotebookCommandKind::ModifyCells {
                        changes: vec![CellMutation::Move {
                            cell_id: cell.id.clone(),
                            index: index - 1,
                        }],
                    });
                }
                if index + 1 < self.state.snapshot.cells.len()
                    && ui
                        .small_button("↓")
                        .on_hover_text("Move cell down")
                        .clicked()
                {
                    self.emit(NotebookCommandKind::ModifyCells {
                        changes: vec![CellMutation::Move {
                            cell_id: cell.id.clone(),
                            index: index + 1,
                        }],
                    });
                }
                if ui.small_button("Delete").clicked() {
                    self.emit(NotebookCommandKind::ModifyCells {
                        changes: vec![CellMutation::Delete {
                            cell_id: cell.id.clone(),
                        }],
                    });
                }
            });
            let edited = {
                let editor = self
                    .editors
                    .iter_mut()
                    .find(|(id, _)| id == &cell.id)
                    .map(|(_, source)| source)
                    .unwrap();
                let response = ui.add_sized(
                    [
                        ui.available_width(),
                        editor.lines().count().clamp(2, 18) as f32 * 20.0 + 12.0,
                    ],
                    TextEdit::multiline(editor)
                        .font(egui::TextStyle::Monospace)
                        .desired_width(f32::INFINITY)
                        .code_editor(),
                );
                (response.lost_focus() && response.changed()).then(|| editor.clone())
            };
            if let Some(source) = edited {
                self.emit(NotebookCommandKind::ModifyCells {
                    changes: vec![CellMutation::Update {
                        cell_id: cell.id.clone(),
                        source: Some(source),
                        metadata: None,
                    }],
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
        ctx.style_mut(|style| {
            style.spacing.item_spacing = egui::vec2(8.0, 8.0);
            style.visuals.selection.bg_fill = Color32::from_rgb(210, 232, 246);
        });
        if ctx.input(|input| input.modifiers.command && input.key_pressed(Key::Enter))
            && let Some(id) = self.state.snapshot.selected_cell_id.clone()
        {
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
