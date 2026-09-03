import { expect, test } from "@playwright/test";
import {
  installMicroscopeTools,
  microscopeCall,
} from "../fixtures/microscope-tools";

test("complete microscopes launch disposable isolated playgrounds with separate setup code", async ({
  page,
}) => {
  await installMicroscopeTools(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Open demo workspace" }).click();
  await expect(page.locator("#connection-status")).toContainText(
    "WebMCP ready",
  );
  const cell = {
    notebook_path: "browser-demo.ipynb",
    cell_id: "browser-example",
  };
  const before = (await microscopeCall(page, "read_cell", cell))
    .structuredContent.cell;
  expect(
    (
      await microscopeCall(page, "create_microscope", {
        ...cell,
        title: "Empty",
      })
    ).isError,
  ).toBe(true);
  const walkthrough = {
    title: "Experiment",
    steps: [
      {
        id: "one",
        title: "Setup then experiment",
        code: "setup_value",
        annotations: [],
        markdown: "Explore a fresh kernel.",
        playground_code: "setup_value = 40 + 2\nprint(setup_value)",
      },
    ],
  };
  const created = await microscopeCall(page, "create_microscope", {
    ...cell,
    title: "Experiment",
    walkthrough,
  });
  expect(created, JSON.stringify(created)).toMatchObject({ isError: false });
  const scope = {
    ...cell,
    microscope_id: created.structuredContent.microscope_id,
  };
  expect(
    (await microscopeCall(page, "open_playground", { ...scope, step_index: 0 }))
      .isError,
  ).toBe(false);
  await expect(page.locator("#playground-canvas")).toBeVisible();
  const read = async () =>
    (
      await microscopeCall(page, "read_playground", {
        notebook_path: cell.notebook_path,
      })
    ).structuredContent.snapshot as {
      cells: { source: string; outputs: unknown[] }[];
    };
  expect((await read()).cells[0]!.source).toBe(
    walkthrough.steps[0]!.playground_code,
  );
  const run = await microscopeCall(page, "execute_playground", {
    notebook_path: cell.notebook_path,
  });
  expect(run, JSON.stringify(run)).toMatchObject({ isError: false });
  expect(JSON.stringify((await read()).cells[0]!.outputs)).toContain("42");
  await page.setViewportSize({ width: 1280, height: 900 });
  // egui needs a frame to resize and another to measure wrapped panels.
  await page.waitForTimeout(300);
  await page.screenshot({ path: ".runtime/playground-desktop.png" });
  await page.setViewportSize({ width: 846, height: 986 });
  await page.waitForTimeout(300);
  expect(
    await page
      .locator("#playground-canvas")
      .evaluate((canvas) => canvas.getBoundingClientRect().bottom),
  ).toBeLessThanOrEqual(986);
  await page.screenshot({ path: ".runtime/playground-user.png" });
  await page
    .getByRole("button", { name: "Back to microscope", exact: true })
    .click();
  await expect(page.locator("#playground-canvas")).toHaveCount(0);
  expect(
    (await microscopeCall(page, "get_active_context")).structuredContent
      .context,
  ).toMatchObject({ walkthrough: { step_index: 0 } });
  expect(
    (await microscopeCall(page, "open_playground", { ...scope, step_index: 0 }))
      .isError,
  ).toBe(false);
  expect(
    (
      await microscopeCall(page, "execute_playground", {
        notebook_path: cell.notebook_path,
        source: "print('setup_value' in globals())",
      })
    ).isError,
  ).toBe(false);
  expect(JSON.stringify((await read()).cells[0]!.outputs)).toContain("False");
  const running = microscopeCall(page, "execute_playground", {
    notebook_path: cell.notebook_path,
    source:
      "import asyncio\nprint('running', flush=True)\nawait asyncio.sleep(10)",
  });
  await expect
    .poll(async () => JSON.stringify((await read()).cells[0]!.outputs))
    .toContain("running");
  await page
    .getByRole("button", { name: "Back to microscope", exact: true })
    .click();
  await expect(page.locator("#playground-canvas")).toHaveCount(0);
  expect((await running).isError).toBe(true);
  await microscopeCall(page, "close_playground", {
    notebook_path: cell.notebook_path,
  });
  const after = (await microscopeCall(page, "read_cell", cell))
    .structuredContent.cell as Record<string, unknown>;
  expect(after.source).toBe((before as Record<string, unknown>).source);
  expect(after.outputs).toEqual((before as Record<string, unknown>).outputs);
  const updated = {
    ...walkthrough,
    title: "Replaced",
    steps: [{ ...walkthrough.steps[0]!, markdown: "Replacement" }],
  };
  expect(
    (
      await microscopeCall(page, "update_microscope", {
        ...scope,
        walkthrough: updated,
      })
    ).isError,
  ).toBe(false);
  const saved = (await microscopeCall(page, "read_microscope", scope))
    .structuredContent.microscope as {
    walkthrough: unknown;
    microscope: { title: string };
  };
  expect(saved.walkthrough).toEqual(updated);
  expect(saved.microscope.title).toBe("Replaced");
});
