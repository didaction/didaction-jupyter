# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Delegated within a constrained architecture: Rust/egui compiled to WebAssembly,
TypeScript for browser APIs and transport, and Python/FastAPI for the local
gateway and direct Jupyter services.

## Users

Notebook users—especially researchers, students, and learners—working locally on
interactive code and explanatory documents.

## Product Purpose

Provide a standalone, local-first notebook environment in which people and
browser-hosted model tools safely share one validated command path to a real
Jupyter kernel. Success means familiar notebook work remains usable without
WebMCP, while automation observes and modifies the same live notebook state.

## Positioning

The browser UI and WebMCP tools are peers at the edge of one typed, bounded,
revision-aware command pipeline rather than separate notebook implementations.

## Operating Context

Desktop-oriented local development with Jupyter notebooks, installed
kernelspecs, an IPython acceptance kernel, an egui canvas, a same-origin gateway,
and a loopback-only gateway/Jupyter service stack.

## Capabilities and Constraints

- Familiar ordered Markdown and code-cell editing and execution.
- Kernel status, interrupt, restart, reconnect, and refresh behavior.
- Typed protocol validation in Rust/WASM; browser APIs and transport in
  TypeScript; credentials and Jupyter session state in the local gateway.
- Exact Jupyter Server, kernel-client, ipykernel, and nbformat pins.
- Bounded inputs, outputs, timeouts, metadata, and aggregate responses.
- Local-development-only code execution; no package installation, arbitrary
  Jupyter forwarding, unrestricted filesystems, or remote multi-user claims.

## Brand Commitments

Desktop IDE ergonomics should mirror the original Jupyter Notebook: a
document-led vertical cell canvas, compact toolbar/status information, explicit
selected-cell affordances, and restrained utilitarian chrome. Preserve
familiarity while improving accessible focus, actionable failures, and responsive
behavior.

## Evidence on Hand

The acceptance scenario and technical/security requirements in the originating
build brief are the source of truth. No testimonials, commercial claims, or
external brand assets are available and none should be fabricated.

## Product Principles

- One validated command path for people and model tools.
- Local-first operation with explicit trust boundaries.
- Deterministic state transitions before transport concerns.
- Familiar notebook interaction over JupyterLab-scale feature breadth.
- Fail closed on incompatible schemas, unbounded data, or unsupported actions.

## Accessibility & Inclusion

Keyboard navigation, visible focus, readable status and error states, semantic
DOM support around the canvas where practical, and a usable WebMCP-unavailable
fallback are product requirements.
