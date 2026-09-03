import { expect, test } from "@playwright/test";

test("optional xeus assets may be absent without breaking Pyodide startup", async ({
  page,
}) => {
  await page.route("**/xeus/didaction-xeus/xpython/kernel.json", (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/html",
      body: "<!doctype html><html></html>",
    }),
  );
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "Open demo workspace" }),
  ).toBeVisible();
  await expect(
    page.locator('#browser-kernel option[value="pyodide"]'),
  ).toHaveCount(1);
  await expect(
    page.locator('#browser-kernel option[value="xeus-python"]'),
  ).toHaveCount(0);
});
import { zipFixture } from "../fixtures/workspace-zip";

test("upgrades existing v1 browser notebooks without losing saved work", async ({
  page,
}) => {
  await page.route("**/migration-fixture", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>Storage fixture</title>",
    }),
  );
  await page.goto("/migration-fixture");
  await page.evaluate(async () => {
    const { initialBrowserSnapshot } = await import(
      String("/src/browser-transport.ts")
    );
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open("didaction-browser-notebooks-v1", 1);
      request.onupgradeneeded = () =>
        request.result.createObjectStore("notebooks");
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result,
          tx = db.transaction("notebooks", "readwrite");
        tx.objectStore("notebooks").put(
          initialBrowserSnapshot("old.ipynb"),
          "old.ipynb",
        );
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
      };
    });
  });
  await page.goto("/");
  await expect(page.locator("#browser-saved")).toContainText(
    "Existing browser workspace",
  );
  await expect(page.locator("#browser-workspace-contents")).toContainText(
    "old.ipynb",
  );
  await page.locator("#browser-resume").click();
  await expect(page.locator("#connection-status")).toContainText(
    "Browser kernel",
  );
});

test("ZIP startup persists notebooks and files, mounts real Python workspace, rejects partial imports", async ({
  page,
}) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Open a browser workspace" }),
  ).toBeVisible();
  await expect(page.getByLabel("Kernel", { exact: true })).toHaveValue(
    "pyodide",
  );
  await expect(
    page.locator('#browser-kernel option[value="pyodide"]'),
  ).toHaveCount(1);
  for (const width of [1280, 739]) {
    await page.setViewportSize({ width, height: 900 });
    await page.screenshot({ path: `.runtime/browser-launch-${width}.png` });
  }
  const notebook = JSON.stringify({
    nbformat: 4,
    nbformat_minor: 5,
    metadata: {},
    cells: [
      {
        id: "read-data",
        cell_type: "code",
        metadata: {},
        source: "from pathlib import Path\nprint(Path('data.csv').read_text())",
        execution_count: null,
        outputs: [],
      },
    ],
  });
  const buffer = zipFixture(
    [
      { name: ".DS_Store", text: "finder metadata" },
      { name: "__MACOSX/._demo.ipynb", text: "appledouble metadata" },
      { name: "lesson/.gitignore", text: "*.pyc" },
      { name: "lesson/demo.ipynb", text: notebook },
      { name: "lesson/practice.ipynb", text: notebook },
      { name: "lesson/data.csv", text: "value\n42" },
    ],
    true,
  );
  await page
    .locator("#browser-zip")
    .setInputFiles({ name: "lesson.zip", mimeType: "application/zip", buffer });
  await expect(page.locator("#connection-status")).toContainText(
    "Browser kernel",
  );
  await expect(page).toHaveURL(/notebook=lesson%2Fdemo.ipynb/);
  await expect(page).toHaveURL(/kernel=pyodide/);
  expect(
    await page.evaluate(async () => {
      const { IndexedNotebookStore } = await import(
        String("/src/browser-store.ts")
      );
      return (await new IndexedNotebookStore().artifacts()).map(
        (entry: { path: string }) => entry.path,
      );
    }),
  ).toEqual(["lesson/data.csv"]);
  const execute = () =>
    page.evaluate(async () => {
      const { IndexedNotebookStore } = await import(
        String("/src/browser-store.ts")
      );
      const { BrowserArtifactTransport } = await import(
        String("/src/browser-artifacts.ts")
      );
      const { WorkerKernel } = await import(String("/src/browser-kernel.ts"));
      const store = new IndexedNotebookStore(),
        artifacts = new BrowserArtifactTransport(store);
      const saved = await store.read("lesson/demo.ipynb");
      const kernel = new WorkerKernel(async () => ({
        files: await store.artifacts(),
        directory: "lesson",
      }));
      const events: unknown[] = [];
      await kernel.request(
        "execute",
        saved.cells[0].source,
        0,
        30000,
        (e: unknown) => events.push(e),
      );
      await artifacts.create({ kind: "directory", path: "lesson/extra" });
      await artifacts.create({
        kind: "file",
        path: "lesson/extra/new.txt",
        content_base64: btoa("fresh"),
      });
      await kernel.request(
        "execute",
        "print(Path('extra/new.txt').read_text())",
        0,
        30000,
        (e: unknown) => events.push(e),
      );
      let rejected = false;
      try {
        await artifacts.import([
          {
            path: "must-not-exist.txt",
            directory: false,
            bytes: new Uint8Array(),
          },
          {
            path: "lesson/data.csv",
            directory: false,
            bytes: new Uint8Array(),
          },
        ]);
      } catch {
        rejected = true;
      }
      let parentRejected = false;
      try {
        await artifacts.create({
          kind: "file",
          path: "lesson",
          content_base64: btoa("bad"),
        });
      } catch {
        parentRejected = true;
      }
      kernel.close();
      return { events, rejected, parentRejected, root: await store.list("") };
    });
  const result = await execute();
  expect(JSON.stringify(result.events)).toContain("42");
  expect(JSON.stringify(result.events)).toContain("fresh");
  expect(result.rejected).toBe(true);
  expect(result.parentRejected).toBe(true);
  expect(JSON.stringify(result.root)).not.toContain("must-not-exist");
  await page.reload();
  await expect(page.locator("#connection-status")).toContainText(
    "Browser kernel",
  );
  const reopened = await page.evaluate(async () => {
    const { BrowserWorkspace } = await import(
      String("/src/browser-workspace.ts")
    );
    const workspace = new BrowserWorkspace();
    const transport = workspace.transport("lesson/demo.ipynb");
    const command = (type: string, fields: Record<string, unknown>) => ({
      protocol_version: 1,
      command_id: crypto.randomUUID(),
      idempotency_key: crypto.randomUUID(),
      timeout_ms: 30000,
      type,
      ...fields,
    });
    await transport.setup(
      command("setup", {
        path: "lesson/demo.ipynb",
        kernel: "pyodide",
        create: false,
      }),
    );
    const result = await transport.execute(
      command("execute_cell", { cell_id: "read-data", expected_revision: 0 }),
    );
    await transport.close();
    return result;
  });
  expect(JSON.stringify(reopened)).toContain("42");
  expect(reopened.error).toBeFalsy();
  expect(
    await page.evaluate(async () => {
      const { IndexedNotebookStore } = await import(
        String("/src/browser-store.ts")
      );
      const store = new IndexedNotebookStore();
      return (await store.artifacts()).map((f: { path: string }) => f.path);
    }),
  ).toContain("lesson/extra/new.txt");
  await page.goto("/");
  await expect(page.locator("#browser-resume")).toBeVisible();
  await expect(page.locator("#browser-saved")).toContainText(
    "lesson (2 notebooks)",
  );
  await expect(page.locator("#browser-workspace-contents")).toContainText(
    "lesson/demo.ipynb",
  );
  await expect(page.locator("#browser-workspace-contents li")).toHaveText([
    "lesson/demo.ipynb",
    "lesson/practice.ipynb",
  ]);
  await page
    .locator("#browser-zip")
    .setInputFiles({ name: "lesson.zip", mimeType: "application/zip", buffer });
  await expect(page.locator("#connection-status")).toContainText(
    "Browser kernel",
  );
  // A repeated archive is a separate workspace, not a merge or overwrite.
  expect(
    await page.evaluate(async () => {
      const { IndexedNotebookStore } = await import(
        String("/src/browser-store.ts")
      );
      return (await new IndexedNotebookStore().artifacts()).map(
        (entry: { path: string }) => entry.path,
      );
    }),
  ).not.toContain("lesson/extra/new.txt");
  await page.goto("/");
  await expect(page.locator("#browser-saved option")).toHaveCount(2);
  await expect(page.locator("#browser-saved")).toContainText("lesson (2)");
  for (const width of [1280, 739]) {
    await page.setViewportSize({ width, height: 900 });
    await page.screenshot({ path: `.runtime/saved-workspaces-${width}.png` });
  }
  await page.locator("#browser-resume").click();
  await expect(page.locator("#connection-status")).toContainText(
    "Browser kernel",
  );
});
