//! Bounded region renderers composited as layers into one microscope stage.
use super::*;
use std::collections::BTreeMap;

#[derive(Default)]
struct RegionSurface {
    width: u32,
    height: u32,
    texture: Option<egui::TextureHandle>,
    error: Option<String>,
    frames: u64,
}

#[derive(Default)]
pub(super) struct GraphicsSurface {
    step_key: String,
    retry: u64,
    paused: bool,
    regions: BTreeMap<String, RegionSurface>,
}

impl NotebookEguiApp {
    pub fn reset_graphics(&mut self) {
        self.graphics = GraphicsSurface {
            retry: self.graphics.retry.wrapping_add(1),
            ..Default::default()
        };
    }

    fn graphics_step_key(&self) -> Option<String> {
        let target = self.microscope_target.as_ref()?;
        let doc = self.microscope_document.as_ref()?;
        let index = target.focus.as_ref().map_or(0, |focus| focus.step_index);
        let step = doc.walkthrough.as_ref()?.steps.get(index)?;
        (!step.graphics_regions.is_empty()).then(|| {
            format!(
                "{}:{}:{}:{}:{}:{}",
                doc.notebook_path,
                doc.cell_id,
                doc.microscope.id,
                doc.microscope.revision,
                index,
                self.graphics.retry
            )
        })
    }

    fn sync_graphics_step(&mut self) -> Option<String> {
        let key = self.graphics_step_key()?;
        if self.graphics.step_key != key {
            let retry = self.graphics.retry;
            self.graphics = GraphicsSurface {
                step_key: key.clone(),
                retry,
                ..Default::default()
            };
        }
        Some(key)
    }

    pub(super) fn graphics_status(&self) -> serde_json::Value {
        let Some(key) = self.graphics_step_key() else {
            return serde_json::Value::Null;
        };
        if key != self.graphics.step_key {
            return serde_json::Value::Null;
        }
        let index = self
            .microscope_target
            .as_ref()
            .and_then(|target| target.focus.as_ref())
            .map_or(0, |focus| focus.step_index);
        let step = &self
            .microscope_document
            .as_ref()
            .expect("microscope")
            .walkthrough
            .as_ref()
            .expect("walkthrough")
            .steps[index];
        serde_json::Value::Array(
            step.graphics_regions
                .iter()
                .filter_map(|region| {
                    let surface = self.graphics.regions.get(&region.id)?;
                    Some(serde_json::json!({
                        "region_id": region.id, "frames": surface.frames, "width": surface.width,
                        "height": surface.height, "error": surface.error,
                        "paused": self.graphics.paused || self.reduced_motion,
                    }))
                })
                .collect(),
        )
    }

    pub fn graphics_request(&mut self) -> serde_json::Value {
        let Some(step_key) = self.sync_graphics_step() else {
            self.graphics = GraphicsSurface::default();
            return serde_json::Value::Array(Vec::new());
        };
        let index = self
            .microscope_target
            .as_ref()
            .and_then(|target| target.focus.as_ref())
            .map_or(0, |focus| focus.step_index);
        let step = &self
            .microscope_document
            .as_ref()
            .expect("microscope")
            .walkthrough
            .as_ref()
            .expect("walkthrough")
            .steps[index];
        serde_json::Value::Array(
            step.graphics_regions
                .iter()
                .filter_map(|region| {
                    let surface = self.graphics.regions.get(&region.id)?;
                    (surface.width > 0 && surface.height > 0).then(|| serde_json::json!({
                "key": format!("{step_key}:{}", region.id), "region_id": region.id,
                "source": region.source, "width": surface.width, "height": surface.height,
                "step_index": index, "paused": self.graphics.paused || self.reduced_motion,
            }))
                })
                .collect(),
        )
    }

    pub fn graphics_frame(
        &mut self,
        ctx: &egui::Context,
        key: &str,
        width: u32,
        height: u32,
        rgba: &[u8],
    ) -> Result<(), String> {
        let Some(step_key) = self.graphics_step_key() else {
            return Ok(());
        };
        let Some(region_id) = key.strip_prefix(&format!("{step_key}:")) else {
            return Ok(());
        };
        if width == 0
            || height == 0
            || width > 1024
            || height > 768
            || rgba.len() != width as usize * height as usize * 4
        {
            return Err("Invalid graphics frame".into());
        }
        let Some(surface) = self.graphics.regions.get_mut(region_id) else {
            return Ok(());
        };
        let image =
            egui::ColorImage::from_rgba_unmultiplied([width as usize, height as usize], rgba);
        if let Some(texture) = &mut surface.texture {
            texture.set(image, egui::TextureOptions::LINEAR);
        } else {
            surface.texture = Some(ctx.load_texture(
                format!("walkthrough-graphics-{region_id}"),
                image,
                egui::TextureOptions::LINEAR,
            ));
        }
        surface.error = None;
        surface.frames += 1;
        ctx.request_repaint();
        Ok(())
    }

    pub fn graphics_error(&mut self, key: &str, error: &str) {
        let Some(step_key) = self.graphics_step_key() else {
            return;
        };
        if let Some(region_id) = key.strip_prefix(&format!("{step_key}:"))
            && let Some(surface) = self.graphics.regions.get_mut(region_id)
        {
            surface.texture = None;
            surface.error = Some(error.chars().take(512).collect());
        }
    }

    pub(super) fn graphics_region(&mut self, ui: &mut egui::Ui, region_id: &str, rect: egui::Rect) {
        if self.sync_graphics_step().is_none() {
            return;
        }
        let surface = self
            .graphics
            .regions
            .entry(region_id.to_owned())
            .or_default();
        let size = rect.size().max(egui::vec2(1.0, 1.0));
        let scale = ui
            .ctx()
            .pixels_per_point()
            .min(2.0)
            .min(1024.0 / size.x)
            .min(768.0 / size.y);
        surface.width = (size.x * scale).round().clamp(1.0, 1024.0) as u32;
        surface.height = (size.y * scale).round().clamp(1.0, 768.0) as u32;
        if let Some(texture) = &surface.texture {
            ui.painter().image(
                texture.id(),
                rect,
                egui::Rect::from_min_max(egui::Pos2::ZERO, egui::pos2(1.0, 1.0)),
                Color32::WHITE,
            );
        }
    }

    pub(super) fn graphics_error_for(&self, region_id: &str) -> Option<&str> {
        self.graphics.regions.get(region_id)?.error.as_deref()
    }
    pub(super) fn graphics_paused(&self) -> bool {
        self.graphics.paused || self.reduced_motion
    }
    pub(super) fn toggle_graphics_pause(&mut self) {
        self.graphics.paused = !self.graphics.paused;
    }
    pub(super) fn retry_graphics(&mut self) {
        self.graphics.retry = self.graphics.retry.wrapping_add(1);
    }
}
