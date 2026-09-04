import { expect, test } from "vitest";
import { runtimeConfig } from "../../vite.config";

test("runtime environments are fixed at build time, with isolated outputs and assets", () => {
  const server = runtimeConfig("server"),
    browser = runtimeConfig("browser");
  expect(server.define["import.meta.env.VITE_NOTEBOOK_RUNTIME"]).toBe(
    '"server"',
  );
  expect(browser.define["import.meta.env.VITE_NOTEBOOK_RUNTIME"]).toBe(
    '"browser"',
  );
  expect(server.build.outDir).toBe("../dist");
  expect(browser.build.outDir).toBe("../dist-browser");
  expect(server.publicDir).toBe(false);
  expect(browser.optimizeDeps.include).toContain("assemblyscript/asc");
  expect(browser.optimizeDeps.include).toContain(
    "@jupyterlite/pyodide-kernel/lib/worker",
  );
  expect(server.optimizeDeps.include).not.toContain(
    "@jupyterlite/pyodide-kernel/lib/worker",
  );
  expect(browser.publicDir).toBe("public");
  expect(browser.server.proxy).toBeUndefined();
  expect(server.server.proxy).toHaveProperty("/api");
  expect(runtimeConfig("production").define).toEqual(server.define);
});

test("browser builds accept a project Pages base path", () => {
  const previous = process.env.VITE_BASE_PATH;
  process.env.VITE_BASE_PATH = "/didaction-jupyter/";
  try {
    expect(runtimeConfig("browser").base).toBe("/didaction-jupyter/");
  } finally {
    if (previous === undefined) delete process.env.VITE_BASE_PATH;
    else process.env.VITE_BASE_PATH = previous;
  }
});
