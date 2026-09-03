// Materialize checksum-verified, same-origin assets for each pinned Pyodide ABI.
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const profiles = [
  {
    id: "py314",
    pyodidePackage: "pyodide",
    kernelPackage: "@jupyterlite/pyodide-kernel",
    version: "314.0.5",
    runtimeGlue: "pyodide.asm.mjs",
    packages: ["micropip", "ipython", "jedi", "matplotlib"],
  },
  {
    id: "py312",
    pyodidePackage: "pyodide-py312",
    kernelPackage: "@jupyterlite/pyodide-kernel-py312",
    version: "0.27.7",
    runtimeGlue: "pyodide.asm.js",
    packages: [
      "micropip",
      "ipython",
      "jedi",
      "numpy",
      "scipy",
      "pandas",
      "matplotlib",
      "networkx",
      "sympy",
    ],
  },
];
const checksum = (bytes) => createHash("sha256").update(bytes).digest("hex");
const comm = {
  filename: "comm-0.2.3-py3-none-any.whl",
  url: "https://files.pythonhosted.org/packages/60/97/891a0971e1e4a8c5d2b20bbe0e524dc04548d2307fee33cdeba148fd4fc7/comm-0.2.3-py3-none-any.whl",
  sha256: "c615d91d75f7f04f095b30d1c1711babd43bdc6419c1be9886a85f2f4e489417",
};

for (const profile of profiles) {
  const output = resolve(root, `web/public/browser-kernel/${profile.id}`);
  const pyodide = resolve(root, `node_modules/${profile.pyodidePackage}`);
  const lite = resolve(root, `node_modules/${profile.kernelPackage}/pypi`);
  const lock = JSON.parse(
    await readFile(`${pyodide}/pyodide-lock.json`, "utf8"),
  );
  const version = JSON.parse(
    await readFile(`${pyodide}/package.json`, "utf8"),
  ).version;
  if (version !== profile.version)
    throw new Error(`Unexpected ${profile.id} version`);
  await mkdir(output, { recursive: true });
  for (const file of [
    "pyodide.mjs",
    profile.runtimeGlue,
    "pyodide.asm.wasm",
    "python_stdlib.zip",
    "pyodide-lock.json",
  ])
    await copyFile(`${pyodide}/${file}`, `${output}/${file}`);

  async function download(filename, url, sha256) {
    try {
      if (checksum(await readFile(`${output}/${filename}`)) === sha256) return;
    } catch {
      /* Download below. */
    }
    const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
    if (!response.ok) throw new Error(`Asset download failed: ${filename}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (checksum(bytes) !== sha256)
      throw new Error(`Checksum mismatch: ${filename}`);
    await writeFile(`${output}/${filename}`, bytes);
  }
  const visited = new Set();
  async function collect(rawName) {
    const name = rawName.replaceAll("_", "-").toLowerCase();
    if (visited.has(name)) return;
    visited.add(name);
    const pkg = lock.packages[name];
    if (!pkg)
      throw new Error(`Package missing from ${profile.id} lock: ${name}`);
    for (const dependency of pkg.depends) await collect(dependency);
    await download(
      pkg.file_name,
      `https://cdn.jsdelivr.net/pyodide/v${version}/full/${pkg.file_name}`,
      pkg.sha256,
    );
  }
  for (const name of profile.packages) await collect(name);

  const index = JSON.parse(await readFile(`${lite}/all.json`, "utf8"));
  for (const pkg of Object.values(index))
    for (const releases of Object.values(pkg.releases))
      for (const release of releases) {
        const bytes = await readFile(`${lite}/${release.filename}`);
        if (checksum(bytes) !== release.digests.sha256)
          throw new Error("Kernel wheel checksum mismatch");
        await writeFile(`${output}/${release.filename}`, bytes);
      }
  await download(comm.filename, comm.url, comm.sha256);
  index.comm = {
    releases: {
      "0.2.3": [
        {
          filename: comm.filename,
          url: `./${comm.filename}`,
          packagetype: "bdist_wheel",
          digests: { sha256: comm.sha256 },
        },
      ],
    },
  };
  await writeFile(`${output}/all.json`, JSON.stringify(index));
  console.log(
    `${profile.id}: Pyodide ${version}; ${visited.size} locked packages`,
  );
}
