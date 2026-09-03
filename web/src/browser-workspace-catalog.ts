import { IndexedNotebookStore } from "./browser-store";

export interface SavedWorkspace {
  id: string;
  name: string;
}

async function catalog(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("didaction-workspace-catalog", 1);
    request.onupgradeneeded = () =>
      request.result.createObjectStore("workspaces", { keyPath: "id" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(new Error("Unable to open saved workspaces"));
  });
}
export async function rememberWorkspace(
  workspace: SavedWorkspace,
): Promise<void> {
  const db = await catalog();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("workspaces", "readwrite");
      tx.objectStore("workspaces").put(workspace);
      tx.oncomplete = () => resolve();
      tx.onerror = tx.onabort = () =>
        reject(new Error("Unable to save workspace identity"));
    });
  } finally {
    db.close();
  }
}
export async function notebookPaths(
  store: IndexedNotebookStore,
): Promise<string[]> {
  const paths: string[] = [];
  async function collect(directory: string): Promise<void> {
    for (const entry of (await store.list(directory)).entries) {
      if (entry.type === "notebook") paths.push(entry.path);
      else if (entry.type === "directory") await collect(entry.path);
    }
  }
  await collect("");
  return paths.sort();
}
export async function savedWorkspaces() {
  const db = await catalog();
  let entries: SavedWorkspace[];
  try {
    entries = await new Promise((resolve, reject) => {
      const request = db
        .transaction("workspaces")
        .objectStore("workspaces")
        .getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () =>
        reject(new Error("Unable to list saved workspaces"));
    });
  } finally {
    db.close();
  }
  // Old versions stored everything together. Preserve that database intact.
  entries = [
    { id: "legacy", name: "Existing browser workspace" },
    ...entries.filter((e) => e.id !== "legacy"),
  ];
  return Promise.all(
    entries.map(async (entry) => {
      const store = new IndexedNotebookStore(entry.id);
      try {
        return { ...entry, notebooks: await notebookPaths(store) };
      } finally {
        await store.close();
      }
    }),
  );
}
