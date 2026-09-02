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
        notebook_path: path,
        cell_id: "selected",
        cell_index: 2,
        mode: "edit",
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
  await workspace.callTool("read_notebook", { notebook_path: "one.ipynb" });
  expect(contexts.get("one.ipynb")!.tools.callTool).toHaveBeenCalledWith(
    "read_notebook",
    {},
  );
  expect(contexts.get("two.ipynb")!.tools.callTool).not.toHaveBeenCalled();
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
    notebook_path: "two.ipynb",
    cell_id: "selected",
    cell_index: 2,
    mode: "edit",
  });
  expect(contexts.get("two.ipynb")!.tools.callTool).not.toHaveBeenCalled();
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
