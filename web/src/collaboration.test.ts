import { expect, it, vi } from "vitest";

it("shares one private workspace identity across concurrent notebook joins", async () => {
  vi.resetModules();
  const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const headers = init?.headers as Record<string, string>;
    return new Response(
      JSON.stringify({
        token: "private-workspace-capability",
        client_id: "same-page",
        driver_id: "same-page",
        is_driver: true,
        notebook_path: headers["x-notebook-path"],
        clients: ["same-page"],
        snapshot: null,
        sequence: 1,
        origin: null,
      }),
    );
  });
  vi.stubGlobal("fetch", fetch);
  try {
    const { NotebookCollaboration } = await import("./collaboration");
    const a = new NotebookCollaboration("a.ipynb");
    const b = new NotebookCollaboration("b.ipynb");
    await Promise.all([a.join(), b.join()]);
    const firstHeaders = fetch.mock.calls[0]![1]!.headers as Record<
      string,
      string
    >;
    const secondHeaders = fetch.mock.calls[1]![1]!.headers as Record<
      string,
      string
    >;
    expect(firstHeaders["x-notebook-client"]).toBe("");
    expect(secondHeaders["x-notebook-client"]).toBe(
      "private-workspace-capability",
    );
    expect(a.state?.client_id).toBe(b.state?.client_id);
    expect(JSON.stringify(a.state)).not.toContain(
      "private-workspace-capability",
    );
  } finally {
    vi.unstubAllGlobals();
  }
});
