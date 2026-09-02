/** Accessible workspace navigation; notebook editing remains in egui/WASM. */
export function installExplorer(
  current: string,
  assertSaved: () => void,
  open?: (path: string) => Promise<void>,
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
    window.dispatchEvent(new Event("resize"));
  };
  async function load(path: string) {
    const request = ++generation;
    status.textContent = "Loading folder…";
    list.replaceChildren();
    try {
      const response = await fetch(
        `/api/v1/notebooks?directory=${encodeURIComponent(path)}`,
      );
      if (!response.ok)
        throw new Error("Folder unavailable. Use Up or Refresh to retry.");
      const data = (await response.json()) as {
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
        ? `${data.entries.length} folders and notebooks`
        : "No notebooks in this folder.";
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
  void load(directory);
}
