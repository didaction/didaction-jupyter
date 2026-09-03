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
        description: "Explore a fresh kernel.",
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
  const window = page.locator(".playground-shell");
  const bar = page.locator(".playground-bar");
  await expect(window).toHaveCSS("resize", "both");
  const initialWindow = (await window.boundingBox())!;
  const titleBar = (await bar.boundingBox())!;
  await page.mouse.move(titleBar.x + 80, titleBar.y + titleBar.height / 2);
  await page.mouse.down();
  await page.mouse.move(titleBar.x + 130, titleBar.y + 50);
  await page.mouse.up();
  const movedWindow = (await window.boundingBox())!;
  expect(movedWindow.x).toBeGreaterThan(initialWindow.x + 35);
  expect(movedWindow.y).toBeGreaterThan(initialWindow.y + 15);
  const resizeHandle = (await page
    .getByRole("button", { name: "Resize playground window" })
    .boundingBox())!;
  await page.mouse.move(
    resizeHandle.x + resizeHandle.width / 2,
    resizeHandle.y + resizeHandle.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    resizeHandle.x + resizeHandle.width / 2 - 50,
    resizeHandle.y + resizeHandle.height / 2 - 50,
  );
  await page.mouse.up();
  const resizedWindow = (await window.boundingBox())!;
  expect(resizedWindow.width).toBeLessThan(movedWindow.width - 30);
  expect(resizedWindow.height).toBeLessThan(movedWindow.height - 30);
  expect(
    (await microscopeCall(page, "get_active_context")).structuredContent
      .context,
  ).toMatchObject({
    view: "playground",
    notebook: { path: cell.notebook_path },
    selection: null,
    playground: {
      owner: {
        notebook_path: cell.notebook_path,
        cell_id: cell.cell_id,
        microscope_id: scope.microscope_id,
      },
      step: { index: 0, id: "one", title: "Setup then experiment" },
      draft: {
        source: walkthrough.steps[0]!.playground_code,
        dirty: false,
      },
      execution: { status: "idle", source: null },
      outputs: [],
    },
  });
  await page.locator("#playground-canvas").evaluate((canvas) => canvas.focus());
  for (const key of [
    "ArrowLeft",
    "ArrowRight",
    "ArrowUp",
    "ArrowDown",
    "Backspace",
  ]) {
    await page.keyboard.press(key);
  }
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
    .getByRole("button", {
      name: "Close playground and stop temporary session",
    })
    .click();
  await expect(page.locator("#playground-canvas")).toHaveCount(0);
  expect(
    (await microscopeCall(page, "get_active_context")).structuredContent
      .context,
  ).toMatchObject({
    view: "microscope",
    microscope: { walkthrough: { step_index: 0 } },
    playground: null,
  });
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
  const live = (await microscopeCall(page, "get_active_context"))
    .structuredContent.context as {
    view: string;
    playground: {
      execution: { status: string; source: string };
      outputs: unknown[];
    };
  };
  expect(live.view).toBe("playground");
  expect(live.playground.execution).toMatchObject({
    status: "running",
    source:
      "import asyncio\nprint('running', flush=True)\nawait asyncio.sleep(10)",
  });
  expect(JSON.stringify(live.playground.outputs)).toContain("running");
  await page
    .getByRole("button", {
      name: "Close playground and stop temporary session",
    })
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
    steps: [{ ...walkthrough.steps[0]!, description: "Replacement" }],
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
  expect(saved.walkthrough).toMatchObject(updated);
  expect(saved.microscope.title).toBe("Replaced");
});
