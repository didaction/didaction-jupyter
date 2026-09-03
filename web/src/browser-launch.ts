import type { BrowserWorkspace } from "./browser-workspace";
import { readWorkspaceZip, ZIP_LIMIT } from "./workspace-zip";

export async function chooseBrowserWorkspace(
  workspace: BrowserWorkspace,
  requested: string | null,
  requestedKernel: string | null,
): Promise<{ path: string; kernel: string }> {
  const supportedKernels = new Set(["pyodide"]);
  const directKernel = requestedKernel ?? "pyodide";
  if (!supportedKernels.has(directKernel))
    throw new Error(
      "Unsupported browser kernel. Open / and choose Python (Pyodide).",
    );
  if (requested && (await workspace.store.read(requested)))
    return { path: requested, kernel: directKernel };
  const panel = document.querySelector<HTMLElement>("#browser-launch")!;
  const layout = document.querySelector<HTMLElement>(".workspace-layout")!;
  const message = document.querySelector<HTMLElement>(
    "#browser-launch-status",
  )!;
  const demo = document.querySelector<HTMLButtonElement>("#browser-demo")!;
  const resume = document.querySelector<HTMLButtonElement>("#browser-resume")!;
  const file = document.querySelector<HTMLInputElement>("#browser-zip")!;
  const picker = document.querySelector<HTMLSelectElement>("#browser-saved")!;
  const kernel = document.querySelector<HTMLSelectElement>("#browser-kernel")!;
  // Bounded recursive listing includes notebooks in imported subfolders.
  const paths: string[] = [];
  async function collect(directory: string): Promise<void> {
    for (const entry of (await workspace.store.list(directory)).entries) {
      if (entry.type === "notebook") paths.push(entry.path);
      else if (entry.type === "directory") await collect(entry.path);
    }
  }
  await collect("");
  for (const path of paths) {
    const option = document.createElement("option");
    option.value = path;
    option.textContent = path;
    picker.append(option);
  }
  document.querySelector<HTMLElement>("#browser-continue")!.hidden =
    !paths.length;
  panel.hidden = false;
  layout.hidden = true;
  demo.focus();
  return new Promise((resolve) => {
    let busy = false;
    async function run(action: () => Promise<string>) {
      if (busy) return;
      busy = true;
      demo.disabled = resume.disabled = file.disabled = true;
      message.textContent = "Preparing browser workspace…";
      try {
        if (!supportedKernels.has(kernel.value))
          throw new Error("Select a supported browser kernel.");
        const selectedKernel = kernel.value;
        const path = await action();
        panel.hidden = true;
        layout.hidden = false;
        resolve({ path, kernel: selectedKernel });
      } catch (error) {
        message.textContent =
          error instanceof Error
            ? error.message
            : "Import failed. No files were replaced.";
      } finally {
        busy = false;
        demo.disabled = resume.disabled = file.disabled = false;
        file.value = "";
      }
    }
    demo.onclick = () => void run(() => workspace.artifacts.demo());
    resume.onclick = () => void run(async () => picker.value);
    file.onchange = () => {
      const zip = file.files?.[0];
      if (!zip) return;
      void run(async () => {
        if (zip.size > ZIP_LIMIT) throw new Error("ZIP must be at most 20 MB.");
        const entries = await readWorkspaceZip(await zip.arrayBuffer());
        if (!entries.some((e) => !e.directory && e.path.endsWith(".ipynb")))
          throw new Error(
            "ZIP needs at least one .ipynb notebook. Use the explorer to upload other files.",
          );
        return (await workspace.artifacts.import(entries))[0]!;
      });
    };
  });
}
