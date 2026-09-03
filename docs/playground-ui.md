# Playground UI

## Overview

The playground is an Operate surface reached from the microscope's Read surface:
experiment in one disposable code cell, then return to the walkthrough. It extends
the existing notebook editor rather than introducing a second editor or a new
visual identity. [DESIGN.md](../DESIGN.md) remains the visual authority;
[microscope.md](microscope.md#temporary-playgrounds) owns the technical contract,
runtime isolation, cleanup, and tool API.

## Layout

The temporary view fills the notebook area, not the entire application. A compact
top row places **Back to microscope** at the left beside the fresh-kernel or
read-only message. The existing notebook canvas is hidden while this view is
mounted and restored on exit.

The editor canvas sits in its own remaining-height viewport below the return row.
Keep that viewport as the canvas's direct sizing parent so the return row is not
counted again in its height. Within egui, the bottom status panel initially uses
its previous measured height; wrapping can increase the required height. When
the measured status row overflows its clip, `status()` requests a discard and
settling pass so the panel is positioned using the updated height. Both layers
matter for keeping the footer visible.
The single cell and its output retain the incumbent vertical document layout,
light palette, code typography, selection treatment, and restrained chrome.

## Components and states

- A microscope step exposes the play control only when it supplies separate
  `playground_code`. Its tooltip is “Open playground in a fresh kernel.” The
  read-only displayed excerpt remains unchanged; executable setup must include
  its own imports and initialization because parent-kernel variables are absent.
- The temporary toolbar contains “Playground,” the existing Run and Interrupt
  controls, and “Temporary · edits and outputs are discarded on exit.” Completion,
  code editing, and output rendering reuse the notebook implementation. Save,
  rename, cell insertion, and other document-structure actions are not offered.
- The return row says “Fresh kernel · discarded on exit” for the driver, or
  “Following driver · read-only” for an observer. Server followers can inspect
  code and outputs but cannot edit or execute. Their return action leaves
  following; it does not close the driver's playground. Browser mode is local
  and does not offer browser-to-browser following.
- Synchronized temporary state reads “Ready,” not “Saved”; uncommitted editing
  reads “Edit pending.” Existing running, disconnected, and action-required states
  remain visible without implying that temporary work is persisted.
- Driver exit stops the temporary kernel and discards edits, outputs, and
  variables, returning to the microscope. During server cleanup the return row
  reports “Stopping temporary kernel…”. A failed close leaves a visible error
  and permits retry rather than silently claiming cleanup succeeded.

## Implementation references

The direction contract and browser shell live in `web/src/playground.ts`;
`web/src/styles.css` owns the remaining-height playground viewport.
`crates/notebook-egui/src/lib.rs` owns the temporary toolbar and status wording;
`crates/notebook-egui/src/walkthrough.rs` owns the step launch control. Keep future
changes scoped to this surface unless the shared notebook system itself changes.

Review captures live under `.impeccable/review/playground-*`.
