//! Read-mode extension of the existing walkthrough: bounded animated pixels in
//! the right column. Existing light surfaces and compact controls remain intact.
//! Errors stay local with Retry; Pause provides a stable reading view. No I/O.
use super::*;

#[derive(Default)]
pub(super) struct GraphicsSurface {
    key: String,
    retry: u64,
    width: u32,
    height: u32,
    texture: Option<egui::TextureHandle>,
    error: Option<String>,
    paused: bool,
    frames: u64,
}

impl NotebookEguiApp {
    pub fn reset_graphics(&mut self) {
        self.graphics = GraphicsSurface {
            retry: self.graphics.retry.wrapping_add(1),
            ..Default::default()
        };
    }
    pub(super) fn graphics_status(&self) -> serde_json::Value {
        if self.graphics_key().as_deref() != Some(self.graphics.key.as_str()) {
            return serde_json::Value::Null;
        }
        serde_json::json!({"frames": self.graphics.frames, "width":self.graphics.width, "height":self.graphics.height,
            "error":self.graphics.error, "paused":self.graphics.paused || self.reduced_motion})
    }
    fn graphics_key(&self) -> Option<String> {
        let target = self.microscope_target.as_ref()?;
        let doc = self.microscope_document.as_ref()?;
        let index = target.focus.as_ref().map_or(0, |f| f.step_index);
        doc.walkthrough
            .as_ref()?
            .steps
            .get(index)?
            .graphics
            .as_ref()?;
        Some(format!(
            "{}:{}:{}:{}:{}:{}",
            doc.notebook_path,
            doc.cell_id,
            doc.microscope.id,
            doc.microscope.revision,
            index,
            self.graphics.retry
        ))
    }
    pub fn graphics_request(&mut self) -> serde_json::Value {
        let Some(key) = self.graphics_key() else {
            self.graphics = GraphicsSurface::default();
            return serde_json::Value::Null;
        };
        if key != self.graphics.key || self.graphics.width == 0 {
            return serde_json::Value::Null;
        }
        let index = self
            .microscope_target
            .as_ref()
            .and_then(|t| t.focus.as_ref())
            .map_or(0, |f| f.step_index);
        let g = self
            .microscope_document
            .as_ref()
            .unwrap()
            .walkthrough
            .as_ref()
            .unwrap()
            .steps[index]
            .graphics
            .as_ref()
            .unwrap();
        serde_json::json!({"key":key, "source":g.source, "width":self.graphics.width,
            "height":self.graphics.height, "step_index":index,
            "paused": self.graphics.paused || self.reduced_motion})
    }
    pub fn graphics_frame(
        &mut self,
        ctx: &egui::Context,
        key: &str,
        width: u32,
        height: u32,
        rgba: &[u8],
    ) -> Result<(), String> {
        if self.graphics_key().as_deref() != Some(key) || key != self.graphics.key {
            return Ok(()); // A late frame must never resurrect an old step.
        }
        if width == 0
            || height == 0
            || width > 1024
            || height > 768
            || rgba.len() != width as usize * height as usize * 4
        {
            return Err("Invalid graphics frame".into());
        }
        let image =
            egui::ColorImage::from_rgba_unmultiplied([width as usize, height as usize], rgba);
        if let Some(texture) = &mut self.graphics.texture {
            texture.set(image, egui::TextureOptions::LINEAR);
        } else {
            self.graphics.texture =
                Some(ctx.load_texture("walkthrough-graphics", image, egui::TextureOptions::LINEAR));
        }
        self.graphics.error = None;
        self.graphics.frames += 1;
        ctx.request_repaint();
        Ok(())
    }
    pub fn graphics_error(&mut self, key: &str, error: &str) {
        if self.graphics_key().as_deref() == Some(key) {
            self.graphics.texture = None;
            self.graphics.error = Some(error.chars().take(512).collect());
        }
    }
    pub(super) fn graphics_ui(&mut self, ui: &mut egui::Ui, description: &str, height: f32) {
        let key = self.graphics_key().expect("graphics step");
        if self.graphics.key != key {
            self.graphics = GraphicsSurface {
                key,
                retry: self.graphics.retry,
                ..Default::default()
            };
        }
        ui.horizontal(|ui| {
            ui.label(RichText::new("Graphics").strong());
            if self.reduced_motion {
                ui.label("Paused · reduced motion");
            } else if self.graphics.error.is_none()
                && ui
                    .small_button(if self.graphics.paused {
                        "Resume"
                    } else {
                        "Pause"
                    })
                    .clicked()
            {
                self.graphics.paused = !self.graphics.paused;
            }
        });
        ui.label(description);
        let size = egui::vec2(ui.available_width().max(1.0), height.clamp(220.0, 480.0));
        let scale = ui
            .ctx()
            .pixels_per_point()
            .min(2.0)
            .min(1024.0 / size.x)
            .min(768.0 / size.y);
        self.graphics.width = (size.x * scale).round().clamp(1.0, 1024.0) as u32;
        self.graphics.height = (size.y * scale).round().clamp(1.0, 768.0) as u32;
        if let Some(error) = self.graphics.error.clone() {
            ui.colored_label(Color32::from_rgb(198, 40, 40), error);
            if ui.button("Retry graphics").clicked() {
                self.graphics.retry += 1;
            }
        } else if let Some(texture) = &self.graphics.texture {
            ui.image((texture.id(), size));
        } else {
            ui.label("Compiling graphics…");
            ui.allocate_space(size);
        }
    }

    pub(super) fn graphics_background(&mut self, ui: &mut egui::Ui, rect: egui::Rect) {
        let key = self.graphics_key().expect("graphics step");
        if self.graphics.key != key {
            self.graphics = GraphicsSurface {
                key,
                retry: self.graphics.retry,
                ..Default::default()
            };
        }
        let size = rect.size().max(egui::vec2(1.0, 1.0));
        let scale = ui
            .ctx()
            .pixels_per_point()
            .min(2.0)
            .min(1024.0 / size.x)
            .min(768.0 / size.y);
        self.graphics.width = (size.x * scale).round().clamp(1.0, 1024.0) as u32;
        self.graphics.height = (size.y * scale).round().clamp(1.0, 768.0) as u32;
        ui.painter()
            .rect_filled(rect, 0.0, Color32::from_rgb(247, 249, 250));
        if let Some(texture) = &self.graphics.texture {
            ui.painter().image(
                texture.id(),
                rect,
                egui::Rect::from_min_max(egui::Pos2::ZERO, egui::pos2(1.0, 1.0)),
                Color32::WHITE,
            );
        }
    }

    pub(super) fn graphics_controls(&mut self, ui: &mut egui::Ui, description: &str) {
        egui::Frame::new()
            .fill(Color32::from_white_alpha(235))
            .stroke(Stroke::new(1.0, Color32::from_gray(210)))
            .inner_margin(Margin::same(8))
            .show(ui, |ui| {
                ui.label(description);
                if self.reduced_motion {
                    ui.label("Paused · reduced motion");
                } else if let Some(error) = self.graphics.error.clone() {
                    ui.colored_label(Color32::from_rgb(198, 40, 40), error);
                    if ui.button("Retry graphics").clicked() {
                        self.graphics.retry += 1;
                    }
                } else if ui
                    .small_button(if self.graphics.paused {
                        "Resume"
                    } else {
                        "Pause"
                    })
                    .clicked()
                {
                    self.graphics.paused = !self.graphics.paused;
                } else if self.graphics.texture.is_none() {
                    ui.label("Compiling graphics…");
                }
            });
    }
}
