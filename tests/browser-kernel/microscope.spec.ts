import { expect, test } from "@playwright/test";
import {
  installMicroscopeTools,
  microscopeCall,
} from "../fixtures/microscope-tools";
test("microscope metadata, sidecar, agent navigation and human delete persist in browser mode", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await installMicroscopeTools(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Open demo workspace" }).click();
  await expect(page.locator("#connection-status")).toContainText(
    "WebMCP ready",
  );
  const scope = {
    notebook_path: "browser-demo.ipynb",
    cell_id: "browser-intro",
  };
  const first = await microscopeCall(page, "create_microscope", {
    ...scope,
    title: "Closer look",
    walkthrough: {
      title: "Closer look",
      steps: [
        {
          id: "one",
          title: "One",
          code: "42",
          description: "Explanation",
        },
      ],
    },
  });
  expect(first, JSON.stringify(first)).toMatchObject({ isError: false });
  const id = String(first.structuredContent.microscope_id);
  expect(id).toMatch(/^[a-z0-9]{7}$/);
  const second = await microscopeCall(page, "create_microscope", {
    ...scope,
    title: "Second view",
    walkthrough: {
      title: "Second view",
      steps: [
        { id: "one", title: "One", code: "42", description: "Explanation" },
      ],
    },
  });
  expect(second.isError).toBe(false);
  const secondId = String(second.structuredContent.microscope_id);
  expect(
    (
      await microscopeCall(page, "open_microscope", {
        ...scope,
        microscope_id: id,
      })
    ).isError,
  ).toBe(false);
  expect(
    (
      await microscopeCall(page, "open_microscope", {
        ...scope,
        microscope_id: secondId,
      })
    ).isError,
  ).toBe(false);
  const active = () => microscopeCall(page, "get_active_context");
  await expect
    .poll(async () => JSON.stringify((await active()).structuredContent))
    .toContain(secondId);
  for (const width of [1280, 739]) {
    await page.setViewportSize({ width, height: 900 });
    await page.waitForTimeout(120);
    await page.screenshot({ path: `.runtime/microscope-shell-${width}.png` });
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.waitForTimeout(300);
  expect(
    (
      await microscopeCall(page, "close_microscope", {
        notebook_path: scope.notebook_path,
      })
    ).isError,
  ).toBe(false);
  await expect
    .poll(async () => JSON.stringify((await active()).structuredContent))
    .toContain('"microscope":null');
  // Reproduce a pre-walkthrough-schema sidecar. Deletion is authorized by the
  // current notebook reference and must not require old content to deserialize.
  await page.evaluate(async (microscopeId) => {
    const dbName =
      new URL(location.href).searchParams.get("workspace") ?? "legacy";
    const request = indexedDB.open(
      dbName === "legacy"
        ? "didaction-browser-notebooks-v1"
        : `didaction-workspace-${dbName}`,
      2,
    );
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const tx = db.transaction("artifacts", "readwrite");
    const store = tx.objectStore("artifacts");
    const all = store.getAll();
    await new Promise<void>((resolve, reject) => {
      all.onsuccess = () => {
        const file = all.result.find((entry) =>
          entry.path.endsWith(microscopeId),
        );
        const legacy = JSON.parse(new TextDecoder().decode(file.bytes));
        legacy.walkthrough.steps[0].markdown =
          legacy.walkthrough.steps[0].description;
        delete legacy.walkthrough.steps[0].description;
        store.put(
          { ...file, bytes: new TextEncoder().encode(JSON.stringify(legacy)) },
          file.path,
        );
      };
      tx.oncomplete = () => resolve();
      tx.onabort = tx.onerror = () => reject(tx.error);
    });
    db.close();
  }, id);
  const canvas = (await page.locator("#notebook-canvas").boundingBox())!;
  const microscopeButton = {
    x: canvas.x + Math.min(canvas.width - 172, 1108),
    y: canvas.y + 112,
  };
  await page.mouse.click(microscopeButton.x, microscopeButton.y);
  await page.waitForTimeout(120);
  await page.screenshot({ path: ".runtime/microscope-dropdown.png" });
  await page.mouse.click(microscopeButton.x + 79, microscopeButton.y + 38);
  await page.waitForTimeout(120);
  await page.screenshot({
    path: ".runtime/microscope-delete-confirmation.png",
  });
  await page.mouse.click(canvas.x + canvas.width / 2 - 70, canvas.y + 459);
  await expect
    .poll(async () =>
      JSON.stringify(await microscopeCall(page, "list_microscopes", scope)),
    )
    .not.toContain(id);
  const files = await page.evaluate(async () => {
    const { IndexedNotebookStore } = await import(
      String("/src/browser-store.ts")
    );
    return (await new IndexedNotebookStore().artifacts()).map(
      (f: { path: string; bytes: Uint8Array }) => ({
        path: f.path,
        text: new TextDecoder().decode(f.bytes),
      }),
    );
  });
  expect(
    files.filter((f: { path: string }) => f.path.endsWith(id)),
  ).toHaveLength(0);
  expect(
    files.filter((f: { path: string }) => f.path.endsWith(secondId)),
  ).toHaveLength(1);
  await page.reload();
  await expect(page.locator("#connection-status")).toContainText(
    "WebMCP ready",
  );
  expect(
    JSON.stringify(await microscopeCall(page, "list_microscopes", scope)),
  ).not.toContain(id);
  expect(
    JSON.stringify(await microscopeCall(page, "list_microscopes", scope)),
  ).toContain(secondId);
  expect(
    (
      await microscopeCall(page, "open_microscope", {
        ...scope,
        microscope_id: id,
      })
    ).isError,
  ).toBe(true);
  expect(
    (
      await microscopeCall(page, "open_microscope", {
        ...scope,
        microscope_id: secondId,
      })
    ).isError,
  ).toBe(false);
});
