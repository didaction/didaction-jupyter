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
      const request = indexedDB.open("didaction-browser-notebooks-v1", 2);
      request.onupgradeneeded = () => {
        for (const name of ["notebooks", "artifacts"])
          if (!request.result.objectStoreNames.contains(name))
            request.result.createObjectStore(name);
      };
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
      browserPath(path);
      const transaction = db.transaction(
        ["notebooks", "artifacts"],
        "readwrite",
      );
      const check = transaction.objectStore("artifacts").getAll();
      check.onsuccess = () => {
        if (
          check.result.some(
            (file: { path: string; directory: boolean }) =>
              file.path === path ||
              file.path.startsWith(path + "/") ||
              (!file.directory && path.startsWith(file.path + "/")),
          )
        ) {
          transaction.abort();
          return;
        }
        transaction.objectStore("notebooks").put(snapshot, path);
      };
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
      const tx = db.transaction(["notebooks", "artifacts"], "readwrite");
      const store = tx.objectStore("notebooks");
      const check = store.get(browserPath(path));
      const files = tx.objectStore("artifacts").getAll();
      files.onsuccess = () => {
        if (
          check.result ||
          files.result.some(
            (file: { path: string; directory: boolean }) =>
              file.path === path ||
              file.path.startsWith(path + "/") ||
              (!file.directory && path.startsWith(file.path + "/")),
          )
        ) {
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
    for (const item of await this.artifacts()) {
      if (!item.path.startsWith(prefix)) continue;
      const rest = item.path.slice(prefix.length);
      if (!rest) continue;
      const name = rest.split("/")[0]!;
      entries.set(name, {
        name,
        path: prefix + name,
        type: rest.includes("/") || item.directory ? "directory" : "file",
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
  async artifacts(): Promise<
    { path: string; directory: boolean; bytes: Uint8Array }[]
  > {
    const db = await this.db;
    return new Promise((resolve, reject) => {
      const request = db
        .transaction("artifacts")
        .objectStore("artifacts")
        .getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () =>
        reject(new Error("Could not read browser workspace files"));
    });
  }
  /** Atomic create-only import: every collision or storage error rolls back the batch. */
  async importEntries(
    items: {
      path: string;
      directory: boolean;
      bytes: Uint8Array;
      snapshot?: NotebookSnapshot;
    }[],
  ): Promise<void> {
    const db = await this.db;
    return new Promise((resolve, reject) => {
      const tx = db.transaction(["notebooks", "artifacts"], "readwrite");
      const notebooks = tx.objectStore("notebooks"),
        artifacts = tx.objectStore("artifacts");
      const allBooks = notebooks.getAllKeys(),
        allFiles = artifacts.getAll();
      allFiles.onsuccess = () => {
        const totalBytes =
          allFiles.result.reduce(
            (n: number, file: { bytes: Uint8Array }) => n + file.bytes.length,
            0,
          ) +
          items.reduce(
            (n, item) => n + (item.snapshot ? 0 : item.bytes.length),
            0,
          );
        if (
          new Set(items.map((item) => item.path)).size !== items.length ||
          totalBytes > 20_000_000
        ) {
          tx.abort();
          return;
        }
        const occupied = new Map<string, boolean>(
          (allBooks.result as string[]).map((p) => [p, false]),
        );
        for (const file of allFiles.result)
          occupied.set(file.path, file.directory);
        const combined = new Map(occupied);
        for (const item of items) {
          if (
            occupied.has(item.path) &&
            !(item.directory && occupied.get(item.path))
          ) {
            tx.abort();
            return;
          }
          combined.set(item.path, item.directory);
        }
        if (combined.size > 1000) {
          tx.abort();
          return;
        }
        for (const path of combined.keys()) {
          const parts = path.split("/");
          parts.pop();
          while (parts.length) {
            const parent = parts.join("/");
            if (combined.has(parent) && !combined.get(parent)) {
              tx.abort();
              return;
            }
            parts.pop();
          }
        }
        for (const item of items) {
          if (item.snapshot) notebooks.add(item.snapshot, item.path);
          else if (!occupied.has(item.path))
            artifacts.add(
              { path: item.path, directory: item.directory, bytes: item.bytes },
              item.path,
            );
        }
      };
      tx.oncomplete = () => resolve();
      tx.onabort = tx.onerror = () =>
        reject(
          new Error(
            "Import not saved: a name already exists, paths conflict, the 1,000-item/20 MB file limit was reached, or browser storage is full. Existing files were preserved.",
          ),
        );
    });
  }
}
