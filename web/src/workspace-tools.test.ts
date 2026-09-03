import { expect, it, vi } from "vitest";
import { WorkspaceTools, type OpenNotebook } from "./workspace-tools";
import { NotebookTools } from "./notebook-tools";

it("requires explicit notebook addresses and routes only to open notebooks", async () => {
  const contexts = new Map<string, OpenNotebook>();
  const create = async (path: string) => {
    const context = {
      tools: {
        listTools: () => [],
        callTool: vi.fn(async () => ({
          content: [],
          structuredContent: { path },
          isError: false,
        })),
      },
      ready: vi.fn(),
      activeContext: () => ({
        view: "notebook",
        notebook: { path, revision: 4 },
        selection: {
          cell_id: "selected",
          cell_index: 2,
          mode: "edit",
          draft: { source: "value", dirty: true },
          execution: null,
        },
        playground: null,
      }),
      activate: vi.fn(),
      deactivate: vi.fn(),
      dispose: vi.fn(),
    };
    contexts.set(path, context);
    return context;
  };
  const catalog = new NotebookTools(
    async (task) => task(async () => ""),
    () => ({ protocol_version: 1, revision: 0, cells: [] }),
  ).listTools();
  const workspace = new WorkspaceTools(catalog, create, async (directory) => ({
    directory,
    entries: [],
  }));
  await workspace.seed("one.ipynb", await create("one.ipynb"));
  contexts.get("one.ipynb")!.canWrite = () => false;
  const blocked = await workspace.callTool("delete_cell", {
    notebook_path: "one.ipynb",
    cell_id: "cell",
  });
  expect(blocked.structuredContent.error).toMatchObject({ code: "not_driver" });
  expect(contexts.get("one.ipynb")!.tools.callTool).not.toHaveBeenCalled();
  contexts.get("one.ipynb")!.canWrite = () => true;
  expect((await workspace.callTool("read_notebook", {})).isError).toBe(true);
  expect(
    (
      await workspace.callTool("read_notebook", {
        notebook_path: "other.ipynb",
      })
    ).isError,
  ).toBe(true);
  expect(
    (
      await workspace.callTool("open_notebook", {
        notebook_path: "../escape.ipynb",
      })
    ).isError,
  ).toBe(true);
  expect(
    (await workspace.callTool("open_notebook", { notebook_path: "two.ipynb" }))
      .isError,
  ).toBe(false);
  expect(
    workspace
      .listTools()
      .find((tool) => tool.name === "capture_microscope_step")?.inputSchema
      .required,
  ).toEqual([]);
  expect(
    (await workspace.callTool("capture_microscope_step", {})).isError,
  ).toBe(false);
  expect(contexts.get("two.ipynb")!.tools.callTool).toHaveBeenCalledWith(
    "capture_microscope_step",
    {},
  );
  await workspace.callTool("read_notebook", { notebook_path: "one.ipynb" });
  expect(contexts.get("one.ipynb")!.tools.callTool).toHaveBeenCalledWith(
    "read_notebook",
    {},
  );
  expect(contexts.get("two.ipynb")!.tools.callTool).not.toHaveBeenCalledWith(
    "read_notebook",
    {},
  );
  expect(
    (await workspace.callTool("list_open_notebooks", {})).structuredContent
      .notebooks,
  ).toHaveLength(2);
  contexts.get("two.ipynb")!.ready = () => {
    throw new Error("dirty");
  };
  expect(
    (await workspace.callTool("get_active_context", {})).structuredContent
      .context,
  ).toEqual({
    view: "notebook",
    notebook: { path: "two.ipynb", revision: 4 },
    selection: {
      cell_id: "selected",
      cell_index: 2,
      mode: "edit",
      draft: { source: "value", dirty: true },
      execution: null,
    },
    playground: null,
  });
  expect(contexts.get("two.ipynb")!.tools.callTool).not.toHaveBeenCalledWith(
    "get_active_context",
    {},
  );
  expect(
    (
      await workspace.callTool("get_active_context", {
        notebook_path: "one.ipynb",
      })
    ).isError,
  ).toBe(true);
  expect(
    (await workspace.callTool("close_notebook", { notebook_path: "two.ipynb" }))
      .isError,
  ).toBe(true);
  await workspace.callTool("close_notebook", { notebook_path: "one.ipynb" });
  expect(contexts.get("one.ipynb")!.dispose).toHaveBeenCalled();
  expect(
    (await workspace.callTool("list_notebooks", { directory: "" })).isError,
  ).toBe(false);
  expect(
    (await workspace.callTool("list_notebooks", { directory: "/etc" })).isError,
  ).toBe(true);
});
