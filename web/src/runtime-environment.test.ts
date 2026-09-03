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
  expect(browser.publicDir).toBe("public");
  expect(browser.server.proxy).toBeUndefined();
  expect(server.server.proxy).toHaveProperty("/api");
  expect(runtimeConfig("production").define).toEqual(server.define);
});
