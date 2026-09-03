/** Accessible workspace navigation; notebook editing remains in egui/WASM. */
import {
  artifactPath,
  uploadRequest,
  type ArtifactTransport,
} from "./artifacts";
export function installExplorer(
  current: string,
  assertSaved: () => void,
  open?: (path: string) => Promise<void>,
  listDirectory?: (path: string) => Promise<{
    directory: string;
    entries: { name: string; path: string; type: string }[];
  }>,
  artifacts?: ArtifactTransport,
  canWrite: () => boolean = () => false,
): void {
  const panel = document.querySelector<HTMLElement>("#file-explorer")!;
  const list = document.querySelector<HTMLUListElement>("#notebook-files")!;
  const status = document.querySelector<HTMLElement>("#explorer-status")!;
  const crumb = document.querySelector<HTMLElement>("#folder-path")!;
  const up = document.querySelector<HTMLButtonElement>("#folder-up")!;
  const toggle = document.querySelector<HTMLButtonElement>("#explorer-toggle")!;
  let directory = current.split("/").slice(0, -1).join("/");
  let generation = 0;
  toggle.onclick = () => {
    panel.hidden = !panel.hidden;
    toggle.setAttribute("aria-expanded", String(!panel.hidden));
    toggle.title = panel.hidden
      ? "Show workspace explorer"
      : "Hide workspace explorer";
    window.dispatchEvent(new Event("resize"));
    window.dispatchEvent(new Event("workspace-visibility"));
  };
  async function load(path: string) {
    const request = ++generation;
    status.textContent = "Loading folder…";
    list.replaceChildren();
    try {
      const response = listDirectory
        ? undefined
        : await fetch(
            `/api/v1/notebooks?directory=${encodeURIComponent(path)}`,
          );
      if (response && !response.ok)
        throw new Error("Folder unavailable. Use Up or Refresh to retry.");
      const data = (
        listDirectory ? await listDirectory(path) : await response!.json()
      ) as {
        directory: string;
        entries: { name: string; path: string; type: string }[];
      };
      if (request !== generation) return;
      directory = data.directory;
      crumb.textContent = directory ? `Workspace / ${directory}` : "Workspace";
      crumb.title = crumb.textContent;
      up.disabled = !directory;
      for (const entry of data.entries) {
        const item = document.createElement("li");
        const button = document.createElement("button");
        button.type = "button";
        const icon = document.createElementNS(
          "http://www.w3.org/2000/svg",
          "svg",
        );
        icon.setAttribute("viewBox", "0 0 24 24");
        icon.setAttribute("aria-hidden", "true");
        const shape = document.createElementNS(icon.namespaceURI, "path");
        shape.setAttribute(
          "d",
          entry.type === "directory"
            ? "M3 6h7l2 2h9v12H3Z"
            : "M5 3h10l4 4v14H5Z M9 11h6 M9 15h6",
        );
        icon.append(shape);
        const label = document.createElement("span");
        label.textContent = entry.name;
        button.append(icon, label);
        button.title = entry.path;
        if (
          entry.path ===
          (new URL(location.href).searchParams.get("notebook") ?? current)
        )
          button.setAttribute("aria-current", "page");
        button.onclick = async () => {
          if (entry.type === "directory") {
            void load(entry.path);
            return;
          }
          if (entry.type === "file") {
            status.textContent = `${entry.name} is a workspace artifact, not a notebook. It is available to the kernel.`;
            return;
          }
          try {
            assertSaved();
            if (open) {
              await open(entry.path);
              return;
            }
            const url = new URL(location.href);
            url.searchParams.set("notebook", entry.path);
            location.assign(url.href);
          } catch {
            status.textContent =
              "Save your edits and wait for execution to finish before opening another notebook.";
          }
        };
        item.append(button);
        list.append(item);
      }
      status.textContent = data.entries.length
        ? `${data.entries.length} workspace items`
        : "This folder is empty. Create a notebook or upload a file.";
    } catch (error) {
      if (request === generation)
        status.textContent =
          error instanceof Error
            ? error.message
            : "Unable to load folder. Refresh to retry.";
    }
  }
  up.onclick = () => void load(directory.split("/").slice(0, -1).join("/"));
  document.querySelector<HTMLButtonElement>("#folder-refresh")!.onclick = () =>
    void load(directory);
  const form = document.querySelector<HTMLFormElement>("#artifact-create")!;
  const name = document.querySelector<HTMLInputElement>("#artifact-name")!;
  const kind = document.querySelector<HTMLSelectElement>("#artifact-kind")!;
  const upload = document.querySelector<HTMLInputElement>("#artifact-upload")!;
  const controls =
    document.querySelector<HTMLFieldSetElement>("#artifact-controls")!;
  let busy = false;
  const updateAccess = () => {
    controls.disabled = busy || !artifacts || !canWrite();
    controls.title = !artifacts
      ? "Workspace uploads require the native server runtime"
      : !canWrite()
        ? "Only the workspace driver can create or upload files"
        : "Create or upload in the displayed folder (1 MB per file)";
  };
  const observer = new MutationObserver(updateAccess);
  observer.observe(document.querySelector("#driver-status")!, {
    attributes: true,
    childList: true,
  });
  window.addEventListener("pagehide", () => observer.disconnect(), {
    once: true,
  });
  async function write(action: () => Promise<void>) {
    if (busy) return;
    try {
      if (!artifacts || !canWrite())
        throw new Error(
          "Only the workspace driver can write files in server mode.",
        );
      busy = true;
      updateAccess();
      status.textContent = "Saving workspace item…";
      await action();
      await load(directory);
    } catch (error) {
      status.textContent =
        error instanceof Error
          ? error.message
          : "Save was not confirmed. Refresh before retrying.";
    } finally {
      busy = false;
      updateAccess();
    }
  }
  form.onsubmit = (event) => {
    event.preventDefault();
    const destination = directory;
    void write(async () => {
      const type = kind.value as "notebook" | "directory" | "file";
      const filename =
        type === "notebook" && !name.value.endsWith(".ipynb")
          ? `${name.value}.ipynb`
          : name.value;
      if (!name.value.trim()) throw new Error("Enter a name first.");
      await artifacts!.create({
        path: artifactPath(destination, filename),
        kind: type,
      });
      name.value = "";
    });
  };
  upload.onchange = () => {
    const files = Array.from(upload.files ?? []);
    const destination = directory;
    void write(async () => {
      for (const file of files)
        await artifacts!.create(await uploadRequest(destination, file));
    }).finally(() => {
      upload.value = "";
    });
  };
  updateAccess();
  void load(directory);
}
