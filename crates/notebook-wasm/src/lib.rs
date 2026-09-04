use notebook_core::NotebookState;
#[cfg(target_arch = "wasm32")]
use notebook_egui::NotebookEguiApp;
use notebook_protocol::{
    CommandResult, NotebookCommand, NotebookSnapshot, validate_command, validate_snapshot,
};
#[cfg(target_arch = "wasm32")]
use notebook_protocol::{ErrorCode, NotebookCommandKind, ProtocolError};
#[cfg(target_arch = "wasm32")]
use std::sync::{Arc, Mutex};
#[cfg(target_arch = "wasm32")]
use wasm_bindgen::closure::Closure;
use wasm_bindgen::prelude::*;
#[wasm_bindgen(js_name = wasmBuildInfo)]
pub fn wasm_build_info() -> String {
    serde_json::json!({"git_sha":env!("DIDACTION_WASM_GIT_SHA"),"dirty":env!("DIDACTION_WASM_DIRTY")}).to_string()
}
#[wasm_bindgen(js_name = microscopeDocument)]
pub fn microscope_document(
    snapshot: &str,
    cell_id: &str,
    id: &str,
    stored: Option<String>,
) -> Result<String, JsError> {
    if snapshot.len() > notebook_protocol::MAX_RESPONSE_BYTES
        || stored
            .as_ref()
            .is_some_and(|s| s.len() > notebook_protocol::microscope::MAX_DOCUMENT_BYTES)
    {
        return Err(JsError::new("Microscope input exceeds limit"));
    }
    let snapshot: NotebookSnapshot = serde_json::from_str(snapshot).map_err(js_error)?;
    validate_snapshot(&snapshot).map_err(js_error)?;
    let mut document =
        notebook_protocol::microscope::document(&snapshot, cell_id, id).map_err(js_error)?;
    if let Some(stored) = stored {
        let parsed: notebook_protocol::microscope::MicroscopeDocument =
            serde_json::from_str(&stored).map_err(js_error)?;
        notebook_protocol::microscope::validate_document(&parsed, &document).map_err(js_error)?;
        document = parsed;
    }
    let path = notebook_protocol::microscope::sidecar(&snapshot.notebook.path, cell_id, id)
        .map_err(js_error)?;
    Ok(serde_json::json!({"path":path,"document":document}).to_string())
}
#[wasm_bindgen(js_name = validateWalkthroughFocus)]
pub fn validate_walkthrough_focus(document: &str, focus: &str) -> Result<(), JsError> {
    if document.len() > notebook_protocol::microscope::MAX_DOCUMENT_BYTES || focus.len() > 1024 {
        return Err(JsError::new("Walkthrough input exceeds limit"));
    }
    let doc: notebook_protocol::microscope::MicroscopeDocument =
        serde_json::from_str(document).map_err(js_error)?;
    let w = doc
        .walkthrough
        .as_ref()
        .ok_or_else(|| JsError::new("Microscope has no walkthrough"))?;
    notebook_protocol::microscope::validate_walkthrough(w).map_err(js_error)?;
    notebook_protocol::microscope::validate_focus(
        w,
        &serde_json::from_str(focus).map_err(js_error)?,
    )
    .map_err(js_error)
}
#[wasm_bindgen(js_name = microscopeGraphicsArtifacts)]
pub fn microscope_graphics_artifacts(document: &str) -> Result<String, JsError> {
    if document.len() > notebook_protocol::microscope::MAX_DOCUMENT_BYTES {
        return Err(JsError::new("Microscope exceeds limit"));
    }
    let doc = serde_json::from_str(document).map_err(js_error)?;
    serde_json::to_string(
        &notebook_protocol::microscope::graphics_artifacts(&doc).map_err(js_error)?,
    )
    .map_err(js_error)
}
#[wasm_bindgen(js_name = prepareRuntimeCommand)]
pub fn prepare_runtime_command(snapshot: &str, command: &str) -> Result<String, JsError> {
    if snapshot.len() > notebook_protocol::MAX_RESPONSE_BYTES
        || command.len() > notebook_protocol::MAX_RESPONSE_BYTES
    {
        return Err(JsError::new("Runtime input exceeds limit"));
    }
    let proposed = notebook_runtime::prepare(
        serde_json::from_str(snapshot).map_err(js_error)?,
        serde_json::from_str(command).map_err(js_error)?,
    )
    .map_err(js_error)?;
    serde_json::to_string(&proposed).map_err(js_error)
}

#[wasm_bindgen(js_name = reduceKernelOutput)]
pub fn reduce_kernel_output(state: &str, event: &str) -> Result<String, JsError> {
    if state.len() > notebook_protocol::MAX_RESPONSE_BYTES
        || event.len() > notebook_protocol::MAX_RESPONSE_BYTES
    {
        return Err(JsError::new("Kernel output exceeds limit"));
    }
    let mut state: notebook_runtime::OutputState = serde_json::from_str(state).map_err(js_error)?;
    state
        .apply(serde_json::from_str(event).map_err(js_error)?)
        .map_err(js_error)?;
    serde_json::to_string(&state).map_err(js_error)
}
#[cfg(target_arch = "wasm32")]
use wasm_bindgen_futures::{JsFuture, spawn_local};

#[cfg(any(test, target_arch = "wasm32"))]
fn apply_progress_snapshot(
    current: &NotebookState,
    snapshot: NotebookSnapshot,
) -> Result<NotebookState, notebook_core::DomainError> {
    let mut next = current.replace_snapshot(snapshot)?;
    next.sync_state = notebook_core::SyncState::Executing;
    Ok(next)
}

#[wasm_bindgen]
pub struct NotebookApplication {
    state: NotebookState,
    disposed: bool,
}

#[wasm_bindgen]
impl NotebookApplication {
    #[wasm_bindgen(constructor)]
    pub fn new(snapshot: &str) -> Result<NotebookApplication, JsError> {
        let snapshot: NotebookSnapshot = serde_json::from_str(snapshot).map_err(js_error)?;
        Ok(Self {
            state: NotebookState::new(snapshot).map_err(js_error)?,
            disposed: false,
        })
    }
    #[wasm_bindgen(js_name = prepareCommand)]
    pub fn prepare_command(&mut self, input: &str) -> Result<String, JsError> {
        self.ensure_active()?;
        let command: NotebookCommand = serde_json::from_str(input).map_err(js_error)?;
        validate_command(&command).map_err(js_error)?;
        let prepared = self.state.prepare(command).map_err(js_error)?;
        self.state = prepared.optimistic_state;
        serde_json::to_string(&prepared.command).map_err(js_error)
    }
    #[wasm_bindgen(js_name = applyCommandResult)]
    pub fn apply_command_result(&mut self, input: &str) -> Result<String, JsError> {
        self.ensure_active()?;
        let result: CommandResult = serde_json::from_str(input).map_err(js_error)?;
        self.state = self.state.apply_result(result).map_err(js_error)?;
        self.public_snapshot()
    }
    #[wasm_bindgen(js_name = replaceSnapshot)]
    pub fn replace_snapshot(&mut self, input: &str) -> Result<String, JsError> {
        self.ensure_active()?;
        let snapshot: NotebookSnapshot = serde_json::from_str(input).map_err(js_error)?;
        validate_snapshot(&snapshot).map_err(js_error)?;
        self.state = self.state.replace_snapshot(snapshot).map_err(js_error)?;
        self.public_snapshot()
    }
    #[wasm_bindgen(js_name = publicSnapshot)]
    pub fn public_snapshot(&self) -> Result<String, JsError> {
        self.ensure_active()?;
        serde_json::to_string(&self.state).map_err(js_error)
    }
    pub fn dispose(&mut self) {
        self.disposed = true;
    }
    fn ensure_active(&self) -> Result<(), JsError> {
        if self.disposed {
            Err(JsError::new("NotebookApplication is disposed"))
        } else {
            Ok(())
        }
    }
}

#[wasm_bindgen(js_name = validateNotebookCommand)]
pub fn validate_notebook_command(input: &str) -> Result<String, JsError> {
    let command: NotebookCommand = serde_json::from_str(input).map_err(js_error)?;
    validate_command(&command).map_err(js_error)?;
    serde_json::to_string(&command).map_err(js_error)
}

#[wasm_bindgen(js_name = playgroundSnapshot)]
pub fn playground_snapshot(document: &str, index: usize, kernel: &str) -> Result<String, JsError> {
    let doc = serde_json::from_str(document).map_err(js_error)?;
    let snapshot = notebook_protocol::microscope::playground_snapshot(&doc, index, kernel)
        .map_err(js_error)?;
    serde_json::to_string(&snapshot).map_err(js_error)
}

#[cfg(target_arch = "wasm32")]
struct MountedApp {
    app: Arc<Mutex<NotebookEguiApp>>,
    dispatch: js_sys::Function,
    toggle_workspace: Option<js_sys::Function>,
}

#[cfg(target_arch = "wasm32")]
impl eframe::App for MountedApp {
    fn update(&mut self, ctx: &eframe::egui::Context, frame: &mut eframe::Frame) {
        let (commands, toggle_requested) = {
            let mut app = self.app.lock().expect("notebook app mutex poisoned");
            app.update(ctx, frame);
            let toggle_requested = std::mem::take(&mut app.workspace_toggle_requested);
            (app.drain_commands(), toggle_requested)
        };
        if toggle_requested && let Some(callback) = &self.toggle_workspace {
            let _ = callback.call0(&JsValue::NULL);
        }
        for command in commands {
            let command_id = command.command_id;
            {
                let mut locked = self.app.lock().expect("notebook app mutex poisoned");
                locked.state.sync_state = match &command.kind {
                    // These replies have no snapshot to clear a dirty flag.
                    // Read-only editor assistance must not block run/tool actions.
                    NotebookCommandKind::Complete { .. }
                    | NotebookCommandKind::Inspect { .. }
                    | NotebookCommandKind::ReadMicroscope { .. } => locked.state.sync_state.clone(),
                    NotebookCommandKind::ExecuteCell { .. }
                    | NotebookCommandKind::ExecuteCode { .. } => {
                        notebook_core::SyncState::Executing
                    }
                    _ => notebook_core::SyncState::Dirty,
                };
                locked.state.last_error = None;
            }
            let app = Arc::clone(&self.app);
            let dispatch = self.dispatch.clone();
            let repaint = ctx.clone();
            spawn_local(async move {
                let Ok(serialized) = serde_json::to_string(&command) else {
                    app.lock()
                        .expect("notebook app mutex poisoned")
                        .finish_command(command_id);
                    set_visible_error(
                        &app,
                        ErrorCode::InvalidInput,
                        "Command could not be serialized",
                        false,
                        &repaint,
                    );
                    return;
                };
                let progress_app = Arc::clone(&app);
                let progress_repaint = repaint.clone();
                let progress = Closure::<dyn FnMut(JsValue)>::new(move |value: JsValue| {
                    let Some(serialized) = value.as_string() else {
                        return;
                    };
                    let Ok(result) = serde_json::from_str::<CommandResult>(&serialized) else {
                        return;
                    };
                    let Some(snapshot) = result.snapshot else {
                        return;
                    };
                    let current = progress_app
                        .lock()
                        .expect("notebook app mutex poisoned")
                        .state
                        .clone();
                    if let Ok(next) = apply_progress_snapshot(&current, snapshot) {
                        progress_app
                            .lock()
                            .expect("notebook app mutex poisoned")
                            .replace_state(next);
                        progress_repaint.request_repaint();
                    }
                });
                let Ok(promise) = dispatch.call2(
                    &JsValue::NULL,
                    &JsValue::from_str(&serialized),
                    progress.as_ref(),
                ) else {
                    app.lock()
                        .expect("notebook app mutex poisoned")
                        .finish_command(command_id);
                    set_visible_error(
                        &app,
                        ErrorCode::Disconnected,
                        "Notebook command could not be dispatched",
                        true,
                        &repaint,
                    );
                    return;
                };
                let Ok(result) = JsFuture::from(js_sys::Promise::from(promise)).await else {
                    app.lock()
                        .expect("notebook app mutex poisoned")
                        .finish_command(command_id);
                    set_visible_error(
                        &app,
                        ErrorCode::Disconnected,
                        "Notebook service disconnected; reconnect and retry",
                        true,
                        &repaint,
                    );
                    return;
                };
                let Some(result) = result.as_string() else {
                    app.lock()
                        .expect("notebook app mutex poisoned")
                        .finish_command(command_id);
                    set_visible_error(
                        &app,
                        ErrorCode::MalformedResponse,
                        "Notebook service returned an unreadable result",
                        true,
                        &repaint,
                    );
                    return;
                };
                let Ok(result) = serde_json::from_str::<CommandResult>(&result) else {
                    app.lock()
                        .expect("notebook app mutex poisoned")
                        .finish_command(command_id);
                    set_visible_error(
                        &app,
                        ErrorCode::MalformedResponse,
                        "Notebook service returned malformed data",
                        true,
                        &repaint,
                    );
                    return;
                };
                let completed_cell = app
                    .lock()
                    .expect("notebook app mutex poisoned")
                    .finish_command(result.command_id);
                if let Some(completion) = result.completion.clone() {
                    app.lock()
                        .expect("notebook app mutex poisoned")
                        .apply_completion(result.command_id, completion);
                    repaint.request_repaint();
                    return;
                }
                if let Some(inspection) = result.inspection.clone() {
                    app.lock()
                        .expect("notebook app mutex poisoned")
                        .apply_inspection(result.command_id, inspection);
                    repaint.request_repaint();
                    return;
                }
                if let Some(error) = result.error {
                    set_visible_error(&app, error.code, &error.message, error.retryable, &repaint);
                } else if let Some(snapshot) = result.snapshot {
                    let current = app
                        .lock()
                        .expect("notebook app mutex poisoned")
                        .state
                        .clone();
                    if let Ok(next) = current.replace_snapshot(snapshot) {
                        {
                            let mut locked = app.lock().expect("notebook app mutex poisoned");
                            locked.replace_state(next);
                            if let Some(cell_id) = completed_cell.as_deref() {
                                locked.reveal_output(cell_id);
                            }
                        }
                        if let Some(doc) = result.microscope {
                            app.lock().expect("app mutex").accept_microscope(doc);
                        }
                        repaint.request_repaint();
                    }
                } else {
                    set_visible_error(
                        &app,
                        ErrorCode::MalformedResponse,
                        "Successful notebook result omitted state",
                        true,
                        &repaint,
                    );
                }
            });
        }
    }
}

#[cfg(target_arch = "wasm32")]
fn set_visible_error(
    app: &Arc<Mutex<NotebookEguiApp>>,
    code: ErrorCode,
    message: &str,
    retryable: bool,
    repaint: &eframe::egui::Context,
) {
    let mut locked = app.lock().expect("notebook app mutex poisoned");
    locked.state.sync_state = if code == ErrorCode::Disconnected {
        notebook_core::SyncState::Disconnected
    } else {
        notebook_core::SyncState::Error
    };
    locked.state.last_error = Some(ProtocolError {
        code,
        message: message.to_owned(),
        retryable,
    });
    repaint.request_repaint();
}

#[wasm_bindgen(js_name = mountNotebook)]
#[cfg(target_arch = "wasm32")]
pub async fn mount_notebook(
    element_id: String,
    snapshot: String,
    dispatch: js_sys::Function,
    toggle_workspace: Option<js_sys::Function>,
) -> Result<MountedNotebook, JsValue> {
    let snapshot: NotebookSnapshot =
        serde_json::from_str(&snapshot).map_err(|error| JsValue::from_str(&error.to_string()))?;
    let state =
        NotebookState::new(snapshot).map_err(|error| JsValue::from_str(&error.to_string()))?;
    let app = Arc::new(Mutex::new(NotebookEguiApp::new(state)));
    let mounted = Arc::clone(&app);
    use wasm_bindgen::JsCast;
    let canvas = web_sys::window()
        .and_then(|window| window.document())
        .and_then(|document| document.get_element_by_id(&element_id))
        .ok_or_else(|| JsValue::from_str("notebook canvas element not found"))?
        .dyn_into::<web_sys::HtmlCanvasElement>()?;
    let runner = eframe::WebRunner::new();
    let repaint = Arc::new(Mutex::new(None));
    let created_repaint = Arc::clone(&repaint);
    runner
        .start(
            canvas,
            eframe::WebOptions::default(),
            Box::new(move |creation| {
                *created_repaint.lock().expect("repaint mutex") = Some(creation.egui_ctx.clone());
                Ok(Box::new(MountedApp {
                    app: mounted,
                    dispatch,
                    toggle_workspace,
                }))
            }),
        )
        .await?;
    Ok(MountedNotebook {
        app,
        runner,
        repaint,
    })
}

/// Narrow host reconciliation handle, never an arbitrary transport escape hatch.
#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
pub struct MountedNotebook {
    app: Arc<Mutex<NotebookEguiApp>>,
    runner: eframe::WebRunner,
    repaint: Arc<Mutex<Option<eframe::egui::Context>>>,
}

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
impl MountedNotebook {
    #[wasm_bindgen(js_name = resetGraphics)]
    pub fn reset_graphics(&self) {
        self.app.lock().expect("app mutex").reset_graphics();
        if let Some(ctx) = self.repaint.lock().expect("repaint mutex").as_ref() {
            ctx.request_repaint();
        }
    }
    #[wasm_bindgen(js_name = graphicsRequest)]
    pub fn graphics_request(&self) -> String {
        self.app
            .lock()
            .expect("app mutex")
            .graphics_request()
            .to_string()
    }
    #[wasm_bindgen(js_name = graphicsFrame)]
    pub fn graphics_frame(
        &self,
        key: &str,
        width: u32,
        height: u32,
        rgba: &[u8],
    ) -> Result<(), JsError> {
        if key.len() > 2048 || rgba.len() > 1024 * 768 * 4 {
            return Err(JsError::new("Graphics frame exceeds bounds"));
        }
        if let Some(ctx) = self.repaint.lock().expect("repaint mutex").as_ref() {
            self.app
                .lock()
                .expect("app mutex")
                .graphics_frame(ctx, key, width, height, rgba)
                .map_err(|e| JsError::new(&e))?;
        }
        Ok(())
    }
    #[wasm_bindgen(js_name = graphicsError)]
    pub fn graphics_error(&self, key: &str, error: &str) {
        self.app
            .lock()
            .expect("app mutex")
            .graphics_error(key, error);
        if let Some(ctx) = self.repaint.lock().expect("repaint mutex").as_ref() {
            ctx.request_repaint();
        }
    }
    #[wasm_bindgen(js_name = followMicroscope)]
    pub fn follow_microscope(&self, target: &str) -> Result<(), JsError> {
        if target.len() > 1024 {
            return Err(JsError::new("Microscope target exceeds limit"));
        }
        let target: Option<notebook_protocol::microscope::MicroscopeTarget> =
            serde_json::from_str(target).map_err(js_error)?;
        self.app
            .lock()
            .expect("app mutex")
            .open_microscope(target)
            .map_err(|e| JsError::new(&e))?;
        if let Some(ctx) = self.repaint.lock().expect("repaint mutex").as_ref() {
            ctx.request_repaint();
        }
        Ok(())
    }
    #[wasm_bindgen(js_name = showMicroscope)]
    pub fn show_microscope(&self, document: &str) -> Result<(), JsError> {
        if document.len() > notebook_protocol::microscope::MAX_DOCUMENT_BYTES {
            return Err(JsError::new("Microscope document exceeds limit"));
        }
        let doc = serde_json::from_str(document).map_err(js_error)?;
        self.app
            .lock()
            .expect("app mutex")
            .show_microscope(doc)
            .map_err(|e| JsError::new(&e))?;
        if let Some(ctx) = self.repaint.lock().expect("repaint mutex").as_ref() {
            ctx.request_repaint();
        }
        Ok(())
    }
    #[wasm_bindgen(js_name = focusWalkthrough)]
    pub fn focus_walkthrough(&self, focus: &str) -> Result<(), JsError> {
        if focus.len() > 1024 {
            return Err(JsError::new("Walkthrough focus exceeds limit"));
        }
        self.app
            .lock()
            .expect("app mutex")
            .focus_walkthrough(serde_json::from_str(focus).map_err(js_error)?)
            .map_err(|e| JsError::new(&e))?;
        if let Some(ctx) = self.repaint.lock().expect("repaint mutex").as_ref() {
            ctx.request_repaint();
        }
        Ok(())
    }
    #[wasm_bindgen(js_name = activeContext)]
    pub fn active_context(&self) -> String {
        self.app
            .lock()
            .expect("app mutex")
            .active_context()
            .to_string()
    }
    #[wasm_bindgen(js_name = cellView)]
    pub fn cell_view(&self, id: &str, action: &str, value: &str) -> Result<(), JsError> {
        self.app
            .lock()
            .expect("app mutex")
            .cell_view(id, action, value)
            .map_err(|error| JsError::new(&error))?;
        if let Some(ctx) = self.repaint.lock().expect("repaint mutex").as_ref() {
            ctx.request_repaint();
        }
        Ok(())
    }
    #[wasm_bindgen(js_name = takeCellCapture)]
    pub fn take_cell_capture(&self) -> Option<String> {
        self.app.lock().expect("app mutex").captured_cell.take()
    }
    #[wasm_bindgen(js_name = captureMicroscopeStep)]
    pub fn capture_microscope_step(&self) -> Result<(), JsError> {
        self.app
            .lock()
            .expect("app mutex")
            .capture_microscope_step()
            .map_err(|error| JsError::new(&error))?;
        if let Some(ctx) = self.repaint.lock().expect("repaint mutex").as_ref() {
            ctx.request_repaint();
        }
        Ok(())
    }
    #[wasm_bindgen(js_name = setWorkspaceVisible)]
    pub fn set_workspace_visible(&self, visible: bool) {
        self.app.lock().expect("app mutex").workspace_visible = visible;
        if let Some(ctx) = self.repaint.lock().expect("repaint mutex").as_ref() {
            ctx.request_repaint();
        }
    }
    #[wasm_bindgen(js_name = setExternalBusy)]
    pub fn set_external_busy(&self, busy: bool) {
        self.app.lock().expect("app mutex").external_command_active = busy;
        if let Some(ctx) = self.repaint.lock().expect("repaint mutex").as_ref() {
            ctx.request_repaint();
        }
    }
    #[wasm_bindgen(js_name = setReducedMotion)]
    pub fn set_reduced_motion(&self, reduced: bool) {
        self.app.lock().expect("app mutex").reduced_motion = reduced;
    }
    #[wasm_bindgen(js_name = setReadOnly)]
    pub fn set_read_only(&self, read_only: bool) {
        self.app.lock().expect("app mutex").read_only = read_only;
        if let Some(ctx) = self.repaint.lock().expect("repaint mutex").as_ref() {
            ctx.request_repaint();
        }
    }
    #[wasm_bindgen(js_name = setCheckpointsSupported)]
    pub fn set_checkpoints_supported(&self, supported: bool) {
        self.app.lock().expect("app mutex").checkpoints_supported = supported;
    }
    #[wasm_bindgen(js_name = setHostStatus)]
    pub fn set_host_status(&self, following: bool, status: String) -> Result<(), JsError> {
        if status.len() > 128 {
            return Err(JsError::new("Host status exceeds limit"));
        }
        let mut app = self.app.lock().expect("app mutex");
        if app.following_driver != following || app.host_status != status {
            app.following_driver = following;
            app.host_status = status;
            if let Some(ctx) = self.repaint.lock().expect("repaint mutex").as_ref() {
                ctx.request_repaint();
            }
        }
        Ok(())
    }
    #[wasm_bindgen(js_name = takePlaygroundRequest)]
    pub fn take_playground_request(&self) -> Option<usize> {
        self.app
            .lock()
            .expect("app mutex")
            .playground_requested
            .take()
    }
    #[wasm_bindgen(js_name = notebookSnapshot)]
    pub fn notebook_snapshot(&self) -> Result<String, JsError> {
        serde_json::to_string(&self.app.lock().expect("app mutex").state.snapshot).map_err(js_error)
    }
    #[wasm_bindgen(js_name = takeFollowToggle)]
    pub fn take_follow_toggle(&self) -> bool {
        std::mem::take(&mut self.app.lock().expect("app mutex").follow_toggle_requested)
    }
    #[wasm_bindgen(js_name = takeDiagnosticsToggle)]
    pub fn take_diagnostics_toggle(&self) -> bool {
        std::mem::take(
            &mut self
                .app
                .lock()
                .expect("app mutex")
                .diagnostics_toggle_requested,
        )
    }
    #[wasm_bindgen(js_name = scrollFraction)]
    pub fn scroll_fraction(&self) -> f32 {
        self.app.lock().expect("app mutex").scroll_fraction
    }
    #[wasm_bindgen(js_name = revealCellOutput)]
    pub fn reveal_cell_output(&self, cell_id: String) -> Result<(), JsError> {
        if cell_id.is_empty() || cell_id.len() > 128 {
            return Err(JsError::new("Invalid cell ID"));
        }
        self.app.lock().expect("app mutex").reveal_output(&cell_id);
        if let Some(ctx) = self.repaint.lock().expect("repaint mutex").as_ref() {
            ctx.request_repaint();
        }
        Ok(())
    }
    #[wasm_bindgen(js_name = setFollowScroll)]
    pub fn set_follow_scroll(&self, fraction: Option<f32>) -> Result<(), JsError> {
        if fraction.is_some_and(|value| !value.is_finite() || !(0.0..=1.0).contains(&value)) {
            return Err(JsError::new("Scroll fraction must be between zero and one"));
        }
        self.app.lock().expect("app mutex").follow_scroll = fraction;
        if let Some(ctx) = self.repaint.lock().expect("repaint mutex").as_ref() {
            ctx.request_repaint();
        }
        Ok(())
    }
    #[wasm_bindgen(js_name = setFollowSelection)]
    pub fn set_follow_selection(&self, cell_id: Option<String>) -> Result<(), JsError> {
        if cell_id
            .as_ref()
            .is_some_and(|id| id.is_empty() || id.len() > 128)
        {
            return Err(JsError::new("Invalid followed cell ID"));
        }
        self.app
            .lock()
            .expect("app mutex")
            .follow_selection(cell_id.as_deref());
        if let Some(ctx) = self.repaint.lock().expect("repaint mutex").as_ref() {
            ctx.request_repaint();
        }
        Ok(())
    }
    #[wasm_bindgen(js_name = assertExternalReady)]
    pub fn assert_external_ready(&self) -> Result<(), JsError> {
        if self
            .app
            .lock()
            .expect("app mutex")
            .external_commands_ready()
        {
            Ok(())
        } else {
            Err(JsError::new(
                "Save pending notebook edits before invoking tools",
            ))
        }
    }
    #[wasm_bindgen(js_name = applyExternalResult)]
    pub fn apply_external_result(&self, serialized: &str, progress: bool) -> Result<(), JsError> {
        let result: CommandResult = serde_json::from_str(serialized).map_err(js_error)?;
        let mut app = self.app.lock().expect("app mutex");
        if let Some(snapshot) = result.snapshot {
            let next = if progress {
                apply_progress_snapshot(&app.state, snapshot)
            } else {
                app.state.replace_snapshot(snapshot)
            }
            .map_err(js_error)?;
            app.replace_state(next);
        }
        if let Some(doc) = result.microscope {
            app.accept_microscope(doc);
        }
        if let Some(error) = result.error {
            app.state.last_error = Some(error);
            app.state.sync_state = notebook_core::SyncState::Error;
        }
        if let Some(ctx) = self.repaint.lock().expect("repaint mutex").as_ref() {
            ctx.request_repaint();
        }
        Ok(())
    }
    pub fn dispose(&self) {
        self.runner.destroy();
    }
}

fn js_error(error: impl std::fmt::Display) -> JsError {
    JsError::new(&error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snapshot(revision: u64, output: &str) -> NotebookSnapshot {
        serde_json::from_value(serde_json::json!({
            "protocol_version": 1,
            "schema_version": 1,
            "notebook": {"path": "stream.ipynb", "workspace": "local"},
            "kernel": {"name": "python3", "display_name": "Python 3", "state": "busy"},
            "revision": revision,
            "cells": [{
                "id": "cell",
                "cell_type": "code",
                "source": "print('stream')",
                "metadata": {},
                "execution_count": null,
                "outputs": [{"kind": "stream", "name": "stdout", "text": output}]
            }],
            "selected_cell_id": "cell"
        }))
        .unwrap()
    }

    #[test]
    fn progress_snapshot_reconciles_output_without_marking_execution_finished() {
        let state = NotebookState::new(snapshot(1, "obsolete\n")).unwrap();

        let next = apply_progress_snapshot(&state, snapshot(2, "latest\n")).unwrap();

        assert_eq!(next.sync_state, notebook_core::SyncState::Executing);
        assert_eq!(
            next.snapshot.cells[0].outputs,
            vec![notebook_protocol::CellOutput::Stream {
                name: "stdout".into(),
                text: "latest\n".into()
            }]
        );
    }
}
