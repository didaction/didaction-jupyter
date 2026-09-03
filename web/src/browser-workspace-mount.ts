import type { PyodideInterface } from "pyodide";
import { browserPath } from "./browser-path";
type WorkspaceFs = PyodideInterface["FS"] & {
  analyzePath(path: string, dontResolveLastLink?: boolean): { exists: boolean };
  isLink(mode: number): boolean;
  lstat(path: string): { mode: number };
};
export function mountWorkspace(
  fs: WorkspaceFs,
  mounted: Set<string>,
  workspace: {
    files: { path: string; directory: boolean; bytes: Uint8Array }[];
    directory: string;
  },
) {
  browserPath(workspace.directory, true);
  if (
    workspace.files.length > 1000 ||
    workspace.files.reduce((n, f) => n + f.bytes.length, 0) > 20_000_000
  )
    throw new Error("Workspace exceeds limit");
  const checkLinks = (target: string) => {
    let current = "";
    for (const part of target.split("/").filter(Boolean)) {
      current += "/" + part;
      if (
        fs.analyzePath(current, true).exists &&
        fs.isLink(fs.lstat(current).mode)
      )
        throw new Error("Workspace symlinks are unsupported");
    }
  };
  checkLinks("/workspace");
  fs.mkdirTree("/workspace");
  for (const file of workspace.files) {
    browserPath(file.path, true);
    if (!file.path || file.bytes.length > 1_000_000)
      throw new Error("Invalid workspace file");
    const target = `/workspace/${file.path}`;
    // Do not follow a link created by notebook code, even inside the worker FS.
    const parts = target.split("/").filter(Boolean);
    let current = "";
    for (const part of parts) {
      current += `/${part}`;
      if (
        fs.analyzePath(current, true).exists &&
        fs.isLink(fs.lstat(current).mode)
      )
        throw new Error("Workspace symlinks are unsupported");
    }
    if (mounted.has(file.path)) continue;
    fs.mkdirTree(
      file.directory ? target : target.slice(0, target.lastIndexOf("/")),
    );
    if (!file.directory) fs.writeFile(target, file.bytes);
    mounted.add(file.path);
  }
  const cwd = `/workspace${workspace.directory ? `/${workspace.directory}` : ""}`;
  checkLinks(cwd);
  fs.mkdirTree(cwd);
  fs.chdir(cwd);
}
