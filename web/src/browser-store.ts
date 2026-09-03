import type { NotebookSnapshot } from "./types";

export function browserPath(path: string, directory = false): string {
  if (
    path.length > 512 ||
    /[\\%?#:\x00-\x1f]/.test(path) ||
    (path && path.split("/").some((part) => !part || part.startsWith("."))) ||
    (!directory && !path.endsWith(".ipynb"))
  )
    throw new Error(
      "Use a relative notebook path inside the browser workspace",
    );
  return path;
}
export interface NotebookStore {
  read(path: string): Promise<NotebookSnapshot | undefined>;
  write(path: string, snapshot: NotebookSnapshot): Promise<void>;
  rename(
    oldPath: string,
    path: string,
    snapshot: NotebookSnapshot,
  ): Promise<void>;
  list(directory: string): Promise<{
    directory: string;
    entries: { name: string; path: string; type: string }[];
  }>;
}
/** Origin-local notebooks, deliberately separate from the kernel's temporary FS. */
export class IndexedNotebookStore implements NotebookStore {
  private db: Promise<IDBDatabase>;
  constructor() {
    this.db = new Promise((resolve, reject) => {
      const request = indexedDB.open("didaction-browser-notebooks-v1", 1);
      request.onupgradeneeded = () =>
        request.result.createObjectStore("notebooks");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () =>
        reject(new Error("Browser notebook storage unavailable"));
    });
  }
  async read(path: string): Promise<NotebookSnapshot | undefined> {
    const db = await this.db;
    return new Promise((resolve, reject) => {
      const request = db
        .transaction("notebooks")
        .objectStore("notebooks")
        .get(browserPath(path));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () =>
        reject(new Error("Unable to read saved notebook"));
    });
  }
  async write(path: string, snapshot: NotebookSnapshot): Promise<void> {
    const db = await this.db;
    return new Promise((resolve, reject) => {
      const transaction = db.transaction("notebooks", "readwrite");
      transaction.objectStore("notebooks").put(snapshot, browserPath(path));
      transaction.oncomplete = () => resolve();
      transaction.onabort = transaction.onerror = () =>
        reject(
          new Error(
            "Notebook not saved: browser storage failed or is full. Download a backup.",
          ),
        );
    });
  }
  async rename(
    oldPath: string,
    path: string,
    snapshot: NotebookSnapshot,
  ): Promise<void> {
    const db = await this.db;
    return new Promise((resolve, reject) => {
      const tx = db.transaction("notebooks", "readwrite");
      const store = tx.objectStore("notebooks");
      const check = store.get(browserPath(path));
      check.onsuccess = () => {
        if (check.result) {
          tx.abort();
          return;
        }
        store.put(snapshot, path);
        store.delete(browserPath(oldPath));
      };
      tx.oncomplete = () => resolve();
      tx.onabort = tx.onerror = () =>
        reject(
          new Error("Rename failed: destination exists or storage unavailable"),
        );
    });
  }
  async list(directory: string) {
    browserPath(directory, true);
    const db = await this.db;
    const keys = await new Promise<IDBValidKey[]>((resolve, reject) => {
      const request = db
        .transaction("notebooks")
        .objectStore("notebooks")
        .getAllKeys();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () =>
        reject(new Error("Unable to list browser notebooks"));
    });
    const prefix = directory ? `${directory}/` : "";
    const entries = new Map<
      string,
      { name: string; path: string; type: string }
    >();
    for (const key of keys) {
      if (typeof key !== "string" || !key.startsWith(prefix)) continue;
      const rest = key.slice(prefix.length);
      const name = rest.split("/")[0]!;
      entries.set(name, {
        name,
        path: prefix + name,
        type: rest.includes("/") ? "directory" : "notebook",
      });
    }
    if (entries.size > 1000) throw new Error("Folder listing exceeds limit");
    return {
      directory,
      entries: [...entries.values()].sort((a, b) =>
        a.name.localeCompare(b.name),
      ),
    };
  }
}
