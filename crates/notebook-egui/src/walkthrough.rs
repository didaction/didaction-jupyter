//! Read-mode extension: explanation above a code/graphics notebook-style container.
//! Display-only content; all durable authoring uses validated notebook commands.
use super::*;
use notebook_protocol::microscope::{
    AnnotationColor, OverlayBounds, OverlayFont, OverlayOverflow, OverlayStyle, Walkthrough,
    WalkthroughFocus, WalkthroughOverlayKind, validate_focus,
};

impl NotebookEguiApp {
    pub(super) fn microscope_shortcuts(&mut self, ctx: &egui::Context) {
        // Playground editors own their keys, including Backspace and arrows.
        if self.microscope_target.is_none()
            || !ctx.input(|input| input.focused)
            || self.state.snapshot.notebook.workspace == "temporary"
            || ctx.wants_keyboard_input()
            || egui::Popup::is_any_open(ctx)
        {
            return;
        }
        let key = ctx.input_mut(|input| {
            [
                Key::Backspace,
                Key::ArrowLeft,
                Key::ArrowRight,
                Key::ArrowUp,
                Key::ArrowDown,
            ]
            .into_iter()
            .find(|key| input.consume_key(egui::Modifiers::NONE, *key))
        });
        if key == Some(Key::Backspace) {
            let _ = self.open_microscope(None);
            return;
        }
        let Some(w) = self
            .microscope_document
            .as_ref()
            .and_then(|d| d.walkthrough.as_ref())
        else {
            return;
        };
        let focus = self
            .microscope_target
            .as_ref()
            .and_then(|t| t.focus.clone())
            .unwrap_or_default();
        if let Some(next) = key.and_then(|key| navigation_focus(w, &focus, key)) {
            let _ = self.focus_walkthrough(next);
        }
    }
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
        ui.heading(&w.steps[index].title);
        ui.add_space(4.0);
        ui.horizontal_wrapped(|ui| {
            if toolbar_icon_button(
                ui,
                index > 0,
                ToolbarIcon::Left,
                "Previous step (Left arrow)",
            ) {
                index -= 1;
            }
            for (position, step) in w.steps.iter().enumerate() {
                if walkthrough_light(ui, position == index, position, &step.title) {
                    index = position;
                }
            }
            if toolbar_icon_button(
                ui,
                index + 1 < w.steps.len(),
                ToolbarIcon::Right,
                "Next step (Right arrow)",
            ) {
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
        if step.graphics.is_some() || !step.overlays.is_empty() {
            self.walkthrough_stage(ui, step, &scope, &focus);
            return;
        }
        egui::ScrollArea::vertical()
            .id_salt((&scope, "step"))
            .show(ui, |ui| {
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
                                ui.label(RichText::new("Code | read-only").strong());
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
                                format!("Line {}, characters {}-{}", a.start_line, start, end)
                            }
                            _ => format!("Lines {}-{}", a.start_line, a.end_line),
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

    fn walkthrough_stage(
        &mut self,
        ui: &mut egui::Ui,
        step: &notebook_protocol::microscope::WalkthroughStep,
        scope: &str,
        focus: &WalkthroughFocus,
    ) {
        let stage = ui.available_rect_before_wrap();
        ui.allocate_rect(stage, egui::Sense::hover());
        if let Some(frames) = self.microscope_capture_frames {
            if frames == 0 {
                let visible = stage.intersect(ui.clip_rect());
                self.capture_region =
                    Some((visible, ui.ctx().pixels_per_point(), visible != stage));
                ui.ctx()
                    .send_viewport_cmd(egui::ViewportCommand::Screenshot(egui::UserData::new(
                        "notebook-cell",
                    )));
                self.microscope_capture_frames = None;
            } else {
                self.microscope_capture_frames = Some(frames - 1);
                ui.ctx().request_repaint();
            }
        }
        if step.graphics.is_some() {
            self.graphics_background(ui, stage);
        } else {
            ui.painter()
                .rect_filled(stage, 0.0, Color32::from_rgb(247, 249, 250));
        }
        let defaults = [
            (
                WalkthroughOverlayKind::Markdown,
                OverlayBounds {
                    x: 20,
                    y: 20,
                    width: 620,
                    height: 150,
                },
            ),
            (
                WalkthroughOverlayKind::Code,
                OverlayBounds {
                    x: 20,
                    y: 190,
                    width: 600,
                    height: 760,
                },
            ),
            (
                WalkthroughOverlayKind::GraphicsControls,
                OverlayBounds {
                    x: 650,
                    y: 20,
                    width: 330,
                    height: 150,
                },
            ),
        ];
        let overlays = if step.overlays.is_empty() {
            defaults
                .iter()
                .enumerate()
                .map(|(position, (kind, bounds))| {
                    (
                        *kind,
                        bounds.clone(),
                        Some(step.markdown.clone()),
                        None,
                        format!("default-{position}"),
                    )
                })
                .collect::<Vec<_>>()
        } else {
            step.overlays
                .iter()
                .map(|overlay| {
                    (
                        overlay.kind,
                        overlay.bounds.clone(),
                        overlay.markdown.clone(),
                        overlay.style.clone(),
                        overlay.id.clone(),
                    )
                })
                .collect()
        };
        for (kind, bounds, markdown, style, id) in overlays {
            if matches!(kind, WalkthroughOverlayKind::GraphicsControls) && step.graphics.is_none()
                || matches!(kind, WalkthroughOverlayKind::Markdown)
                    && markdown.as_deref().unwrap_or_default().is_empty()
            {
                continue;
            }
            let rect = overlay_rect(stage, &bounds);
            ui.scope_builder(egui::UiBuilder::new().max_rect(rect), |ui| {
                ui.set_clip_rect(rect);
                match kind {
                    WalkthroughOverlayKind::Markdown => {
                        let style = style.unwrap_or(OverlayStyle {
                            opacity: 235,
                            font: OverlayFont::Proportional,
                            font_size: 16,
                            overflow: OverlayOverflow::Scroll,
                        });
                        let previous = ui.style().clone();
                        let mut next = (*previous).clone();
                        let family = match style.font {
                            OverlayFont::Proportional => egui::FontFamily::Proportional,
                            OverlayFont::Monospace => egui::FontFamily::Monospace,
                        };
                        next.text_styles.insert(
                            egui::TextStyle::Body,
                            egui::FontId::new(f32::from(style.font_size), family),
                        );
                        ui.set_style(next);
                        egui::Frame::new()
                            .fill(Color32::from_white_alpha(style.opacity))
                            .inner_margin(Margin::same(8))
                            .show(ui, |ui| {
                                let mut render = |ui: &mut egui::Ui| {
                                    rendered_markdown_response(
                                        ui,
                                        &format!("{scope}-{id}"),
                                        markdown.as_deref().unwrap_or_default(),
                                        &mut self.markdown_cache,
                                        &self.math_cache,
                                    );
                                };
                                if style.overflow == OverlayOverflow::Scroll {
                                    egui::ScrollArea::vertical()
                                        .auto_shrink([false, false])
                                        .show(ui, render);
                                } else {
                                    render(ui);
                                }
                            });
                        ui.set_style((*previous).clone());
                    }
                    WalkthroughOverlayKind::Code => {
                        let opacity = style.as_ref().map_or(240, |style| style.opacity);
                        egui::Frame::new()
                            .fill(Color32::from_white_alpha(opacity))
                            .stroke(Stroke::new(1.0, Color32::from_gray(205)))
                            .inner_margin(Margin::same(8))
                            .show(ui, |ui| {
                                ui.horizontal(|ui| {
                                    if step.playground_code.is_some()
                                        && toolbar_icon_button(
                                            ui,
                                            !self.read_only,
                                            ToolbarIcon::Run,
                                            "Open playground window",
                                        )
                                    {
                                        self.playground_requested = Some(focus.step_index);
                                    }
                                    ui.label(RichText::new("Code | read-only").strong());
                                });
                                egui::ScrollArea::both().show(ui, |ui| {
                                    for (line, source) in step.code.split('\n').enumerate() {
                                        let focused_annotation =
                                            step.annotations.iter().find(|a| {
                                                focus.annotation_id.as_ref() == Some(&a.id)
                                                    && a.start_line <= line + 1
                                                    && a.end_line > line
                                            });
                                        let annotated = step.annotations.iter().find(|a| {
                                            a.start_line <= line + 1 && a.end_line > line
                                        });
                                        let text =
                                            RichText::new(format!("{:>4}  {source}", line + 1))
                                                .monospace();
                                        let accent = focused_annotation
                                            .or(annotated)
                                            .map(|a| color(a.color));
                                        egui::Frame::new()
                                            .fill(accent.map_or(Color32::TRANSPARENT, |color| {
                                                color.gamma_multiply(
                                                    if focused_annotation.is_some() {
                                                        0.18
                                                    } else {
                                                        0.07
                                                    },
                                                )
                                            }))
                                            .stroke(focused_annotation.map_or(Stroke::NONE, |a| {
                                                Stroke::new(2.0, color(a.color))
                                            }))
                                            .inner_margin(Margin::symmetric(6, 3))
                                            .show(ui, |ui| {
                                                ui.label(text);
                                            });
                                    }
                                    if !step.annotations.is_empty() {
                                        ui.separator();
                                        ui.label(RichText::new("Code annotations").strong());
                                        for annotation in &step.annotations {
                                            let selected = focus.annotation_id.as_ref()
                                                == Some(&annotation.id);
                                            let location =
                                                if annotation.start_line == annotation.end_line {
                                                    format!("L{}", annotation.start_line)
                                                } else {
                                                    format!(
                                                        "L{}-{}",
                                                        annotation.start_line, annotation.end_line
                                                    )
                                                };
                                            let response = egui::Frame::new()
                                                .fill(if selected {
                                                    color(annotation.color).gamma_multiply(0.14)
                                                } else {
                                                    Color32::TRANSPARENT
                                                })
                                                .stroke(if selected {
                                                    Stroke::new(2.0, color(annotation.color))
                                                } else {
                                                    Stroke::new(
                                                        1.0,
                                                        Color32::from_rgb(215, 220, 223),
                                                    )
                                                })
                                                .inner_margin(Margin::symmetric(8, 6))
                                                .show(ui, |ui| {
                                                    ui.horizontal_wrapped(|ui| {
                                                        ui.label(
                                                            RichText::new(location)
                                                                .monospace()
                                                                .strong(),
                                                        );
                                                        ui.label(&annotation.text);
                                                    });
                                                })
                                                .response
                                                .interact(egui::Sense::click());
                                            if response.clicked() {
                                                let _ = self.focus_walkthrough(WalkthroughFocus {
                                                    step_index: focus.step_index,
                                                    annotation_id: Some(annotation.id.clone()),
                                                });
                                            }
                                        }
                                    }
                                });
                            });
                    }
                    WalkthroughOverlayKind::GraphicsControls => {
                        self.graphics_controls(ui, &step.graphics.as_ref().unwrap().description);
                    }
                }
            });
        }
    }
}

fn walkthrough_light(ui: &mut egui::Ui, active: bool, position: usize, title: &str) -> bool {
    let response = ui
        .add_sized([22.0, 22.0], egui::Button::new("").frame(false))
        .on_hover_text(format!("{}: {title}", position + 1));
    let center = response.rect.center();
    let color = if active || response.hovered() {
        Color32::from_rgb(45, 105, 143)
    } else {
        Color32::from_rgb(215, 220, 223)
    };
    ui.painter()
        .circle_filled(center, if active { 6.0 } else { 4.0 }, color);
    if active {
        ui.painter().circle_stroke(
            center,
            8.0,
            Stroke::new(1.0, Color32::from_rgb(45, 105, 143)),
        );
    }
    response.clicked()
}

fn overlay_rect(stage: egui::Rect, bounds: &OverlayBounds) -> egui::Rect {
    let scale = |value: u16| f32::from(value) / 1000.0;
    egui::Rect::from_min_size(
        stage.min
            + egui::vec2(
                stage.width() * scale(bounds.x),
                stage.height() * scale(bounds.y),
            ),
        egui::vec2(
            stage.width() * scale(bounds.width),
            stage.height() * scale(bounds.height),
        ),
    )
}
fn navigation_focus(
    w: &Walkthrough,
    focus: &WalkthroughFocus,
    key: Key,
) -> Option<WalkthroughFocus> {
    let step = w.steps.get(focus.step_index)?;
    match key {
        Key::ArrowLeft | Key::ArrowRight => {
            let index = if key == Key::ArrowLeft {
                focus.step_index.checked_sub(1)?
            } else {
                focus.step_index + 1
            };
            w.steps.get(index)?;
            Some(WalkthroughFocus {
                step_index: index,
                annotation_id: None,
            })
        }
        Key::ArrowUp | Key::ArrowDown if !step.annotations.is_empty() => {
            let count = step.annotations.len();
            let current = step
                .annotations
                .iter()
                .position(|a| Some(&a.id) == focus.annotation_id.as_ref());
            let index = match (key, current) {
                (Key::ArrowUp, Some(i)) => (i + count - 1) % count,
                (Key::ArrowUp, None) => count - 1,
                (_, Some(i)) => (i + 1) % count,
                _ => 0,
            };
            Some(WalkthroughFocus {
                step_index: focus.step_index,
                annotation_id: Some(step.annotations[index].id.clone()),
            })
        }
        _ => None,
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
    fn arrows_bound_steps_and_cycle_annotations() {
        let w: Walkthrough = serde_json::from_value(serde_json::json!({
            "title":"Walk", "steps":[
                {"id":"one","title":"One","code":"x","markdown":"", "annotations":[
                    {"id":"a","start_line":1,"end_line":1,"text":"A"},
                    {"id":"b","start_line":1,"end_line":1,"text":"B"}
                ]},
                {"id":"two","title":"Two","code":"x","markdown":"","annotations":[]}
            ]
        }))
        .unwrap();
        let start = WalkthroughFocus::default();
        assert!(navigation_focus(&w, &start, Key::ArrowLeft).is_none());
        let a = navigation_focus(&w, &start, Key::ArrowDown).unwrap();
        assert_eq!(a.annotation_id.as_deref(), Some("a"));
        let b = navigation_focus(&w, &a, Key::ArrowDown).unwrap();
        assert_eq!(b.annotation_id.as_deref(), Some("b"));
        assert_eq!(navigation_focus(&w, &b, Key::ArrowDown), Some(a.clone()));
        assert_eq!(navigation_focus(&w, &a, Key::ArrowUp), Some(b.clone()));
        assert_eq!(navigation_focus(&w, &start, Key::ArrowUp), Some(b));
        let next = navigation_focus(&w, &a, Key::ArrowRight).unwrap();
        assert_eq!(next.step_index, 1);
        assert!(next.annotation_id.is_none());
        assert!(navigation_focus(&w, &next, Key::ArrowDown).is_none());
        assert!(navigation_focus(&w, &next, Key::ArrowRight).is_none());
        assert_eq!(navigation_focus(&w, &next, Key::ArrowLeft), Some(start));
    }

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
