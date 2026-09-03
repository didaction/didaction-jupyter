//! Read-mode extension of the notebook: code left, explanation right, navigation above.
//! Display-only content; all durable authoring uses validated notebook commands.
use super::*;
use notebook_protocol::microscope::{
    AnnotationColor, Walkthrough, WalkthroughFocus, validate_focus,
};

impl NotebookEguiApp {
    pub fn focus_walkthrough(&mut self, focus: WalkthroughFocus) -> Result<(), String> {
        let w = self
            .microscope_document
            .as_ref()
            .and_then(|d| d.walkthrough.as_ref())
            .ok_or("Open a microscope with a walkthrough first")?;
        validate_focus(w, &focus).map_err(|e| e.to_string())?;
        let target = self
            .microscope_target
            .as_mut()
            .ok_or("No microscope open")?;
        self.walkthrough_scroll_to_focus = target.focus.as_ref() != Some(&focus);
        target.focus = Some(focus);
        Ok(())
    }
    pub fn walkthrough_context(&self) -> serde_json::Value {
        let Some(w) = self
            .microscope_document
            .as_ref()
            .and_then(|d| d.walkthrough.as_ref())
        else {
            return serde_json::Value::Null;
        };
        let focus = self
            .microscope_target
            .as_ref()
            .and_then(|t| t.focus.clone())
            .unwrap_or_default();
        serde_json::json!({"title":w.title,"step_index":focus.step_index,"step_count":w.steps.len(),"step_id":w.steps[focus.step_index].id,"annotation_id":focus.annotation_id})
    }
    pub(super) fn walkthrough_ui(&mut self, ui: &mut egui::Ui, w: &Walkthrough) {
        let mut focus = self
            .microscope_target
            .as_ref()
            .and_then(|t| t.focus.clone())
            .unwrap_or_default();
        let mut index = focus.step_index;
        ui.heading(&w.title);
        ui.add_space(8.0);
        ui.horizontal_wrapped(|ui| {
            if ui
                .add_enabled(index > 0, egui::Button::new("Previous"))
                .clicked()
            {
                index -= 1;
            }
            egui::ComboBox::from_id_salt("walkthrough-step")
                .selected_text(format!(
                    "Step {} of {}: {}",
                    index + 1,
                    w.steps.len(),
                    w.steps[index].title
                ))
                .width(280.0)
                .show_ui(ui, |ui| {
                    for (i, step) in w.steps.iter().enumerate() {
                        ui.selectable_value(&mut index, i, format!("{}. {}", i + 1, step.title));
                    }
                });
            if ui
                .add_enabled(index + 1 < w.steps.len(), egui::Button::new("Next"))
                .clicked()
            {
                index += 1;
            }
            if focus.annotation_id.is_some() && ui.button("Clear focus").clicked() {
                focus.annotation_id = None;
                let _ = self.focus_walkthrough(focus.clone());
            }
        });
        if index != focus.step_index {
            focus = WalkthroughFocus {
                step_index: index,
                annotation_id: None,
            };
            let _ = self.focus_walkthrough(focus.clone());
        }
        ui.add_space(8.0);
        ui.separator();
        let step = &w.steps[index];
        let scroll_focus = self.walkthrough_scroll_to_focus;
        self.walkthrough_scroll_to_focus = false;
        let height = ui.available_height();
        let target = self.microscope_target.as_ref().expect("mounted microscope");
        let scope = format!(
            "{}-{}-{}-{}",
            target.cell_id, target.microscope_id, target.revision, step.id
        );
        ui.columns(2, |columns| {
            let left = &mut columns[0];
            left.label(RichText::new("Code · read-only").strong());
            egui::ScrollArea::both()
                .id_salt((&scope, "code"))
                .max_height(height - 30.0)
                .auto_shrink([false, false])
                .show(left, |ui| {
                    ui.spacing_mut().item_spacing.y = 0.0;
                    ui.spacing_mut().interact_size.y = 18.0;
                    let focused = step
                        .annotations
                        .iter()
                        .find(|a| Some(&a.id) == focus.annotation_id.as_ref());
                    let mut range: Option<egui::Rect> = None;
                    for (i, line) in step.code.split('\n').enumerate() {
                        let annotation = step
                            .annotations
                            .iter()
                            .find(|a| a.start_line <= i + 1 && a.end_line > i);
                        let fill = annotation
                            .map(|a| color(a.color).gamma_multiply(0.10))
                            .unwrap_or(Color32::TRANSPARENT);
                        let response = egui::Frame::new()
                            .fill(fill)
                            .inner_margin(Margin::symmetric(8, 3))
                            .show(ui, |ui| {
                                ui.horizontal(|ui| {
                                    ui.label(
                                        RichText::new(format!("{:>4}", i + 1))
                                            .monospace()
                                            .size(14.0)
                                            .color(Color32::from_rgb(83, 99, 107)),
                                    );
                                    ui.add(
                                        egui::Label::new(
                                            RichText::new(if line.is_empty() { " " } else { line })
                                                .monospace()
                                                .size(14.0),
                                        )
                                        .wrap_mode(egui::TextWrapMode::Extend),
                                    );
                                });
                            })
                            .response;
                        if focused.is_some_and(|a| a.start_line <= i + 1 && a.end_line > i) {
                            range = Some(range.map_or(response.rect, |r| r.union(response.rect)));
                        }
                    }
                    // Leave room below the last code row for its outline and the
                    // horizontal scrollbar, including after a viewport resize.
                    ui.allocate_space(egui::vec2(1.0, 24.0));
                    if let (Some(rect), Some(a)) = (range, focused) {
                        if scroll_focus {
                            ui.scroll_to_rect_animation(
                                rect,
                                Some(egui::Align::Center),
                                egui::style::ScrollAnimation::none(),
                            );
                        }
                        let width = if self.reduced_motion {
                            2.5
                        } else {
                            ui.ctx().request_repaint_after(Duration::from_millis(33));
                            2.5 + ui.input(|i| (i.time * std::f64::consts::PI).sin()) as f32 * 0.75
                        };
                        ui.painter().rect_stroke(
                            rect,
                            2.0,
                            Stroke::new(width, color(a.color)),
                            egui::StrokeKind::Inside,
                        );
                    }
                });
            let right = &mut columns[1];
            egui::ScrollArea::vertical()
                .id_salt((&scope, "explanation"))
                .max_height(height)
                .auto_shrink([false, false])
                .show(right, |ui| {
                    ui.heading(&step.title);
                    ui.add_space(8.0);
                    rendered_markdown_response(
                        ui,
                        &scope,
                        &step.markdown,
                        &mut self.markdown_cache,
                        &self.math_cache,
                    );
                    if !step.annotations.is_empty() {
                        ui.add_space(16.0);
                        ui.label(RichText::new("Code annotations").strong());
                        for a in &step.annotations {
                            let selected = focus.annotation_id.as_ref() == Some(&a.id);
                            if ui
                                .selectable_label(
                                    selected,
                                    format!("Lines {}–{}: {}", a.start_line, a.end_line, a.text),
                                )
                                .clicked()
                            {
                                let _ = self.focus_walkthrough(WalkthroughFocus {
                                    step_index: index,
                                    annotation_id: Some(a.id.clone()),
                                });
                            }
                        }
                    }
                });
        });
    }
}
fn color(c: AnnotationColor) -> Color32 {
    match c {
        AnnotationColor::Blue => Color32::from_rgb(45, 105, 143),
        AnnotationColor::BlueLight => Color32::from_rgb(78, 137, 175),
        AnnotationColor::BlueDeep => Color32::from_rgb(30, 76, 110),
    }
}
