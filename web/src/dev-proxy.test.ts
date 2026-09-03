import { createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { createServer, type UserConfig } from "vite";
import config from "../../vite.config";

it("preserves browser Host/Origin through the real development proxy", async () => {
  const upstream = createHttpServer((request, response) => {
    const { host, origin } = request.headers;
    response.statusCode = origin === `http://${host}` ? 200 : 403;
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ host, origin }));
  });
  await new Promise<void>((resolve) =>
    upstream.listen(0, "127.0.0.1", resolve),
  );
  const target = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
  const settings = config as UserConfig;
  const proxy = Object.fromEntries(
    Object.entries(settings.server!.proxy!).map(([path, options]) => [
      path,
      typeof options === "string" ? target : { ...options, target },
    ]),
  );
  const vite = await createServer({
    ...settings,
    configFile: false,
    root: fileURLToPath(new URL("..", import.meta.url)),
    logLevel: "silent",
    server: {
      ...settings.server,
      middlewareMode: true,
      hmr: false,
      watch: null,
      proxy,
    },
  });
  const frontend = createHttpServer(vite.middlewares);
  try {
    await new Promise<void>((resolve) =>
      frontend.listen(0, "127.0.0.1", resolve),
    );
    const origin = `http://127.0.0.1:${(frontend.address() as AddressInfo).port}`;
    for (const path of [
      "/api/v1/config",
      "/api/v1/commands/stream",
      "/readyz",
    ]) {
      const response = await fetch(origin + path, {
        method: path.endsWith("/stream") ? "POST" : "GET",
        headers: { Origin: origin },
      });
      expect(await response.json()).toEqual({
        host: new URL(origin).host,
        origin,
      });
      expect(response.status).toBe(200);
    }
    const rejected = await fetch(origin + "/api/v1/config", {
      headers: { Origin: "http://untrusted.example" },
    });
    expect(rejected.status).toBe(403);
  } finally {
    await vite.close();
    frontend.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      frontend.close((error) => (error ? reject(error) : resolve())),
    );
    upstream.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      upstream.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
