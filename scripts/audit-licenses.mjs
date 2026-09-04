import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const root = new URL("../", import.meta.url);
const read = (name) => readFileSync(new URL(name, root), "utf8");
const errors = [];
const inventory = read("THIRD_PARTY_LICENSES.md");
const packageJson = JSON.parse(read("package.json"));

for (const [name, version] of Object.entries(packageJson.dependencies ?? {})) {
  if (!inventory.includes(`npm:${name}`))
    errors.push(`missing browser inventory row for ${name}@${version}`);
}

const pyproject = read("pyproject.toml");
const dependencyBlock =
  pyproject.match(/dependencies = \[([\s\S]*?)\n\]/)?.[1] ?? "";
const pythonPackages = [
  ...dependencyBlock.matchAll(/"([A-Za-z0-9_.-]+)==([^\"]+)"/g),
];
for (const [, name, version] of pythonPackages) {
  if (!inventory.includes(`PyPI:${name}`))
    errors.push(`missing Python inventory row for ${name}==${version}`);
}

let cargo;
try {
  cargo = JSON.parse(
    execFileSync("cargo", ["metadata", "--locked", "--format-version", "1"], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "inherit"],
    }),
  );
} catch {
  errors.push("cargo metadata failed");
}
for (const pkg of cargo?.packages ?? []) {
  if (pkg.source && !pkg.license && !pkg.license_file)
    errors.push(
      `Rust package ${pkg.name}@${pkg.version} has no license metadata`,
    );
}

try {
  let unidentified = [];
  for (let attempt = 0; attempt < 3; attempt++) {
    const npmLicenses = JSON.parse(
      execFileSync("pnpm", ["licenses", "list", "--prod", "--json"], {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "inherit"],
      }),
    );
    unidentified = Object.entries(npmLicenses).filter(([license]) =>
      /unknown|unlicensed|none/i.test(license),
    );
    if (!unidentified.length) break;
  }
  for (const [license, packages] of unidentified)
    errors.push(
      `production npm packages have unidentified license ${license}: ${Object.keys(packages).join(", ")}`,
    );
} catch {
  errors.push(
    "pnpm production license inventory failed; run pnpm install --frozen-lockfile",
  );
}

try {
  const pythonAudit = execFileSync(
    "uv",
    [
      "run",
      "python",
      "-c",
      [
        "import importlib.metadata as m, json",
        `names=${JSON.stringify(pythonPackages.map(([, name]) => name))}`,
        "out=[]",
        "for name in names:",
        " d=m.metadata(name)",
        " classifiers=d.get_all('Classifier') or []",
        " license_value=d.get('License-Expression') or d.get('License') or next((c for c in classifiers if c.startswith('License ::')), None)",
        " urls=d.get_all('Project-URL') or []",
        " source=d.get('Home-page') or next((u.split(',',1)[1].strip() for u in urls if ',' in u and u.split(',',1)[0].strip().lower() in {'source','repository','homepage','home'}), None)",
        " out.append({'name':name,'license':license_value,'source':source})",
        "print(json.dumps(out))",
      ].join("\n"),
    ],
    { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
  );
  for (const pkg of JSON.parse(pythonAudit)) {
    const inventoryRow = inventory
      .split("\n")
      .find((line) => line.includes(`PyPI:${pkg.name} |`));
    if ((!pkg.license || /^unknown$/i.test(pkg.license)) && !inventoryRow)
      errors.push(`Python package ${pkg.name} has no usable license metadata`);
    if (!pkg.source && !inventoryRow?.includes("https://"))
      errors.push(`Python package ${pkg.name} has no source/home URL metadata`);
  }
} catch {
  errors.push("Python license inventory failed; run uv sync --frozen");
}

if (errors.length) {
  for (const error of errors) console.error(`license audit: ${error}`);
  process.exit(1);
}
console.log(
  `license audit passed: ${cargo.packages.filter((pkg) => pkg.source).length} Rust, production npm graph, and ${pythonPackages.length} direct Python packages`,
);
