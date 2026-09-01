# Jupyter frontend parity reference

This note defines the interaction reference for mandatory frontend parity. The
target is the recognizable Jupyter Notebook editor—not merely an equivalent set
of operations.

## Primary-source findings

- Notebook 7 is built from JupyterLab frontend components, so Notebook 7 and
  the JupyterLab notebook package are the maintained implementation references.
  ([Jupyter Notebook repository](https://github.com/jupyter/notebook#notebook-v7))
- The classic Notebook editor establishes the durable visual vocabulary: title,
  menu bar, then a stable toolbar with save, insert, move, run, stop, restart,
  and cell-type controls above the document. Code cells use an `In [ ]:` prompt.
  ([official Jupyter Notebook documentation PDF](https://jupyter-notebook.readthedocs.io/_/downloads/en/6.4.12/pdf/))
- Notebook interaction is modal. `Enter` enters edit mode, `Esc` enters command
  mode, and command-mode shortcuts act on the selected cell. The documented
  high-frequency order is navigation, save, cell type, insertion, editing, then
  kernel operations.
  ([official Notebook Basics](https://jupyter-notebook.readthedocs.io/en/stable/examples/Notebook/Notebook%20Basics.html#keyboard-navigation))
- Jupyter's notebook widget owns active-cell selection, command/edit mode,
  focus, scrolling, and ordered cell behavior.
  ([JupyterLab notebook widget source](https://github.com/jupyterlab/jupyterlab/blob/main/packages/notebook/src/widget.ts))

## Acceptance interpretation

A mandatory primitive is visually at parity only when a returning Jupyter user
can find it in the expected region, recognize its icon or label, and obtain the
expected selected-cell behavior. An internal capability hidden behind a novel
per-cell text toolbar is functionally supported but not visually at parity.

The egui surface therefore uses this hierarchy:

1. notebook name and product identity;
2. `File`, `Edit`, `View`, `Insert`, `Cell`, `Run`, `Kernel`, and `Help` menus;
3. icon toolbar ordered as save, insert, move, run, stop, restart, cell type;
4. one selected-cell document with familiar execution prompts and mode cues;
5. kernel/save status at the edge of the application.

Only working actions are shown. Missing cut/copy/paste and undo/redo remain
explicit parity gaps rather than inert controls that merely resemble Jupyter.
