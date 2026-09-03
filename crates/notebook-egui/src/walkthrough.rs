//! Read-mode extension: explanation above a code/graphics notebook-style container.
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
        serde_json::json!({"title":w.title,"step_index":focus.step_index,"step_count":w.steps.len(),"step_id":w.steps[focus.step_index].id,"annotation_id":focus.annotation_id, "graphics":self.graphics_status()})
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
        egui::ScrollArea::vertical()
            .id_salt((&scope, "step"))
            .show(ui, |ui| {
                ui.heading(&step.title);
                ui.add_space(8.0);
                rendered_markdown_response(
                    ui,
                    &format!("{scope}-explanation"),
                    &step.markdown,
                    &mut self.markdown_cache,
                    &self.math_cache,
                );
                ui.add_space(16.0);
                egui::Frame::new()
                    .fill(Color32::WHITE)
                    .stroke(Stroke::new(1.0, Color32::from_rgb(215, 220, 223)))
                    .corner_radius(3.0)
                    .inner_margin(Margin::same(10))
                    .show(ui, |ui| {
                        ui.columns(2, |columns| {
                            let left = &mut columns[0];
                            left.horizontal(|ui| {
                                if step.playground_code.is_some()
                                    && toolbar_icon_button(
                                        ui,
                                        !self.read_only,
                                        ToolbarIcon::Run,
                                        "Open playground in a fresh kernel",
                                    )
                                {
                                    self.playground_requested = Some(index);
                                }
                                ui.label(RichText::new("Code · read-only").strong());
                            });
                            egui::ScrollArea::both()
                                .id_salt((&scope, "code"))
                                .max_height((height * 0.55).clamp(220.0, 420.0))
                                .auto_shrink([false, true])
                                .show(left, |ui| {
                                    ui.spacing_mut().item_spacing.y = 0.0;
                                    ui.spacing_mut().interact_size.y = 18.0;
                                    let focused = step
                                        .annotations
                                        .iter()
                                        .find(|a| Some(&a.id) == focus.annotation_id.as_ref());
                                    let mut range: Option<egui::Rect> = None;
                                    for (i, line) in step.code.split('\n').enumerate() {
                                        let line_annotations: Vec<_> = step
                                            .annotations
                                            .iter()
                                            .filter(|a| a.start_line <= i + 1 && a.end_line > i)
                                            .collect();
                                        let fill = line_annotations
                                            .iter()
                                            .find(|a| a.start_column.is_none())
                                            .map(|a| color(a.color).gamma_multiply(0.10))
                                            .unwrap_or(Color32::TRANSPARENT);
                                        let mut character_rect = None;
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
                                                    let galley = ui.fonts(|fonts| {
                                                        fonts.layout_job(annotated_line(
                                                            line,
                                                            &line_annotations,
                                                            &self.state.snapshot.kernel.name,
                                                        ))
                                                    });
                                                    let (rect, _) = ui.allocate_exact_size(
                                                        galley.size(),
                                                        egui::Sense::hover(),
                                                    );
                                                    if let Some(a) =
                                                        focused.filter(|a| a.start_line == i + 1)
                                                        && let (Some(start), Some(end)) =
                                                            (a.start_column, a.end_column)
                                                    {
                                                        let first = galley.pos_from_cursor(
                                                            CCursor::new(start - 1),
                                                        );
                                                        let last = galley
                                                            .pos_from_cursor(CCursor::new(end));
                                                        character_rect = Some(
                                                            egui::Rect::from_min_max(
                                                                rect.min + first.min.to_vec2(),
                                                                rect.min
                                                                    + egui::vec2(
                                                                        last.min.x,
                                                                        first.max.y,
                                                                    ),
                                                            )
                                                            .expand(2.0),
                                                        );
                                                    }
                                                    ui.painter().galley(
                                                        rect.min,
                                                        galley,
                                                        ui.visuals().text_color(),
                                                    );
                                                });
                                            })
                                            .response;
                                        if focused.is_some_and(|a| {
                                            a.start_line <= i + 1 && a.end_line > i
                                        }) {
                                            let rect = character_rect.unwrap_or(response.rect);
                                            range = Some(range.map_or(rect, |r| r.union(rect)));
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
                                            ui.ctx()
                                                .request_repaint_after(Duration::from_millis(33));
                                            2.5 + ui
                                                .input(|i| (i.time * std::f64::consts::PI).sin())
                                                as f32
                                                * 0.75
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
                            if let Some(graphics) = &step.graphics {
                                self.graphics_ui(right, &graphics.description, height * 0.55);
                            } else {
                                right.label(RichText::new("Graphics").strong());
                                right.add_space(8.0);
                                egui::Frame::new()
                                    .fill(Color32::from_rgb(247, 249, 250))
                                    .stroke(Stroke::new(1.0, Color32::from_rgb(215, 220, 223)))
                                    .corner_radius(3.0)
                                    .inner_margin(Margin::same(20))
                                    .show(right, |ui| {
                                        ui.set_min_height(150.0);
                                        ui.vertical_centered(|ui| {
                                            ui.add_space(45.0);
                                            ui.label(
                                                RichText::new("Graphics placeholder")
                                                    .strong()
                                                    .color(Color32::from_rgb(83, 99, 107)),
                                            );
                                            ui.label(
                                            "Interactive visuals will appear here in a later step.",
                                        );
                                        });
                                    });
                            }
                        })
                    });
                if !step.annotations.is_empty() {
                    ui.add_space(12.0);
                    ui.label(RichText::new("Code annotations").strong());
                    for a in &step.annotations {
                        let selected = focus.annotation_id.as_ref() == Some(&a.id);
                        let location = match (a.start_column, a.end_column) {
                            (Some(start), Some(end)) => {
                                format!("Line {}, characters {}–{}", a.start_line, start, end)
                            }
                            _ => format!("Lines {}–{}", a.start_line, a.end_line),
                        };
                        if ui
                            .selectable_label(selected, format!("{location}: {}", a.text))
                            .clicked()
                        {
                            let _ = self.focus_walkthrough(WalkthroughFocus {
                                step_index: index,
                                annotation_id: Some(a.id.clone()),
                            });
                        }
                    }
                }
                ui.add_space(24.0);
            });
    }
}

fn annotated_line(
    line: &str,
    annotations: &[&notebook_protocol::microscope::Annotation],
    kernel: &str,
) -> egui::text::LayoutJob {
    let editor = CodeEditor::default()
        .with_fontsize(14.0)
        .with_theme(ColorTheme::GITHUB_LIGHT)
        .with_syntax(kernel_syntax(kernel));
    let syntax = egui_code_editor::Token::default().highlight(&editor, line);
    let chars: Vec<char> = if line.is_empty() {
        vec![' ']
    } else {
        line.chars().collect()
    };
    let mut job = egui::text::LayoutJob::default();
    let mut byte = 0;
    for (index, ch) in chars.iter().enumerate() {
        let highlight = annotations.iter().find(|a| {
            a.start_column.is_some_and(|start| index + 1 >= start)
                && a.end_column.is_some_and(|end| index < end)
        });
        let mut format = syntax
            .sections
            .iter()
            .find(|s| s.byte_range.contains(&byte))
            .map(|s| s.format.clone())
            .unwrap_or(egui::TextFormat {
                font_id: FontId::monospace(14.0),
                color: Color32::from_rgb(35, 43, 47),
                ..Default::default()
            });
        byte += ch.len_utf8();
        if let Some(a) = highlight {
            format.background = color(a.color).gamma_multiply(0.20);
        }
        if let Some(section) = job.sections.last_mut().filter(|s| s.format == format) {
            job.text.push(*ch);
            section.byte_range.end = job.text.len();
        } else {
            job.append(&ch.to_string(), 0.0, format);
        }
    }
    job
}
fn color(c: AnnotationColor) -> Color32 {
    match c {
        AnnotationColor::Blue => Color32::from_rgb(45, 105, 143),
        AnnotationColor::BlueLight => Color32::from_rgb(78, 137, 175),
        AnnotationColor::BlueDeep => Color32::from_rgb(30, 76, 110),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn character_highlights_cover_unicode_characters_not_bytes() {
        let annotation = serde_json::from_value(serde_json::json!({
            "id":"span", "start_line":1, "end_line":1,
            "start_column":2, "end_column":3, "text":"Inside"
        }))
        .unwrap();
        let job = annotated_line("α🙂xy", &[&annotation], "python3");
        let highlighted: String = job
            .sections
            .iter()
            .filter(|s| s.format.background != Color32::TRANSPARENT)
            .map(|s| &job.text[s.byte_range.clone()])
            .collect();
        assert_eq!(highlighted, "🙂x");
        assert_eq!(job.text, "α🙂xy");
        assert_eq!(annotated_line("", &[], "python3").text, " ");
    }
}
