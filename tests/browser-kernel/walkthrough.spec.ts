import { expect, test } from "@playwright/test";
import {
  installMicroscopeTools,
  microscopeCall,
} from "../fixtures/microscope-tools";
import { exampleWalkthrough } from "../fixtures/walkthrough";

test("walkthrough authoring, navigation, annotation focus and persistence use real WASM", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await installMicroscopeTools(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Open demo workspace" }).click();
  await expect(page.locator("#connection-status")).toContainText(
    "WebMCP ready",
  );
  const cell = { notebook_path: "browser-demo.ipynb", cell_id: "browser-plot" };
  const before = (await microscopeCall(page, "read_cell", cell))
    .structuredContent.cell;
  const created = await microscopeCall(page, "create_microscope", {
    ...cell,
    title: "Plot walkthrough",
    walkthrough: exampleWalkthrough,
  });
  expect(created.isError).toBe(false);
  const scope = {
    ...cell,
    microscope_id: created.structuredContent.microscope_id,
  };
  const call = (name: string, args: Record<string, unknown> = {}) =>
    microscopeCall(page, name, { ...scope, ...args });
  expect(
    (
      await call("update_microscope", {
        walkthrough: exampleWalkthrough,
      })
    ).isError,
  ).toBe(false);
  expect((await call("open_microscope")).isError).toBe(false);
  const active = async () =>
    (await microscopeCall(page, "get_active_context")).structuredContent
      .context as {
      microscope: {
        walkthrough: {
          step_index: number;
          step_count: number;
          annotation_id: string | null;
        };
      };
    };
  expect((await active()).microscope.walkthrough).toMatchObject({
    step_index: 0,
    step_count: 3,
    annotation_id: null,
  });
  expect(
    (
      await call("focus_microscope_annotation", {
        step_index: 0,
        annotation_id: "values",
      })
    ).isError,
  ).toBe(false);
  await page.waitForTimeout(150);
  await page.screenshot({ path: ".runtime/walkthrough-desktop.png" });
  // Human keyboard navigation uses the same local view state as the visual controls.
  await page.keyboard.press("ArrowRight");
  await expect
    .poll(async () => (await active()).microscope.walkthrough.step_index)
    .toBe(1);
  await page.keyboard.press("ArrowDown");
  await expect
    .poll(async () => (await active()).microscope.walkthrough.annotation_id)
    .toBe("bars");
  await page.keyboard.press("ArrowLeft");
  await expect
    .poll(async () => (await active()).microscope.walkthrough.annotation_id)
    .toBeNull();
  await page.keyboard.press("ArrowUp");
  await expect
    .poll(async () => (await active()).microscope.walkthrough.annotation_id)
    .toBe("values");
  await page.keyboard.press("Backspace");
  await expect.poll(async () => (await active()).microscope).toBeNull();
  expect((await call("open_microscope")).isError).toBe(false);
  expect(
    (
      await call("focus_microscope_annotation", {
        step_index: 2,
        annotation_id: "last",
      })
    ).isError,
  ).toBe(false);
  expect((await active()).microscope.walkthrough).toMatchObject({
    step_index: 2,
    annotation_id: "last",
  });
  await page.setViewportSize({ width: 739, height: 900 });
  await page.waitForTimeout(150);
  await page.screenshot({ path: ".runtime/walkthrough-narrow.png" });
  expect((await call("clear_microscope_focus")).isError).toBe(false);
  expect((await active()).microscope.walkthrough).toMatchObject({
    step_index: 2,
    annotation_id: null,
  });
  expect(
    (await call("focus_microscope_step", { step_index: 63 })).isError,
  ).toBe(true);
  expect((await active()).microscope.walkthrough.step_index).toBe(2);
  const invalid = structuredClone(exampleWalkthrough);
  invalid.steps[0]!.annotations[0]!.end_line = 999;
  expect(
    (await call("update_microscope", { walkthrough: invalid })).isError,
  ).toBe(true);
  const badColumns = structuredClone(exampleWalkthrough);
  Object.assign(badColumns.steps[0]!.annotations[0]!, { end_column: 999 });
  expect(
    (await call("update_microscope", { walkthrough: badColumns })).isError,
  ).toBe(true);
  expect(
    (
      (await call("read_microscope")).structuredContent.microscope as {
        walkthrough: unknown;
      }
    ).walkthrough,
  ).toMatchObject(exampleWalkthrough);
  expect(
    (await microscopeCall(page, "read_cell", cell)).structuredContent.cell,
  ).toEqual(before);
  const updated = { ...exampleWalkthrough, title: "Updated explanation" };
  expect(
    (await call("update_microscope", { walkthrough: updated })).isError,
  ).toBe(false);
  await page.reload();
  await expect(page.locator("#connection-status")).toContainText(
    "WebMCP ready",
  );
  expect(
    (
      (await call("read_microscope")).structuredContent.microscope as {
        walkthrough: unknown;
      }
    ).walkthrough,
  ).toMatchObject(updated);
  expect((await call("focus_microscope_step", { step_index: 1 })).isError).toBe(
    false,
  );
  expect((await active()).microscope.walkthrough).toMatchObject({
    step_index: 1,
    step_count: 3,
  });
});
