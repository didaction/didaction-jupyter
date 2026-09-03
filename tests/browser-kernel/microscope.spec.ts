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
      steps: [{ id: "one", title: "One", code: "42", markdown: "Explanation" }],
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
      steps: [{ id: "one", title: "One", code: "42", markdown: "Explanation" }],
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
  const canvas = await page.locator("#notebook-canvas").boundingBox();
  await page.mouse.click(canvas!.x + 80, canvas!.y + 15);
  await expect
    .poll(async () => JSON.stringify((await active()).structuredContent))
    .toContain('"microscope":null');
  await page.screenshot({ path: ".runtime/microscope-dropdown-position.png" });
  // Actual egui dropdown and confirmation, not an agent deletion escape hatch.
  await page.mouse.click(canvas!.x + canvas!.width - 105, canvas!.y + 150);
  await page.waitForTimeout(120);
  await page.screenshot({ path: ".runtime/microscope-dropdown.png" });
  await page.mouse.click(canvas!.x + canvas!.width - 104, canvas!.y + 187);
  await page.waitForTimeout(120);
  await page.screenshot({
    path: ".runtime/microscope-delete-confirmation.png",
  });
  // Cancel leaves both pieces intact; then explicitly confirm the same deletion.
  await page.mouse.click(608, 506);
  expect(
    JSON.stringify(await microscopeCall(page, "list_microscopes", scope)),
  ).toContain(id);
  await page.mouse.click(canvas!.x + canvas!.width - 105, canvas!.y + 150);
  await page.mouse.click(canvas!.x + canvas!.width - 104, canvas!.y + 187);
  await page.waitForTimeout(120);
  await page.mouse.click(694, 506);
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
