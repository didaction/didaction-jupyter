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

#[cfg(target_arch = "wasm32")]
struct MountedApp {
    app: Arc<Mutex<NotebookEguiApp>>,
    dispatch: js_sys::Function,
}

#[cfg(target_arch = "wasm32")]
impl eframe::App for MountedApp {
    fn update(&mut self, ctx: &eframe::egui::Context, frame: &mut eframe::Frame) {
        let commands = {
            let mut app = self.app.lock().expect("notebook app mutex poisoned");
            app.update(ctx, frame);
            app.drain_commands()
        };
        for command in commands {
            let command_id = command.command_id;
            {
                let mut locked = self.app.lock().expect("notebook app mutex poisoned");
                locked.state.sync_state = match &command.kind {
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
                app.lock()
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
                        app.lock()
                            .expect("notebook app mutex poisoned")
                            .replace_state(next);
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
) -> Result<(), JsValue> {
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
    eframe::WebRunner::new()
        .start(
            canvas,
            eframe::WebOptions::default(),
            Box::new(move |_| {
                Ok(Box::new(MountedApp {
                    app: mounted,
                    dispatch,
                }))
            }),
        )
        .await
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
