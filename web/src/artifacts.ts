/** Workspace file management is separate from notebook execution, with one bounded adapter. */
export interface ArtifactRequest {
  path: string;
  kind: "directory" | "notebook" | "file";
  content_base64?: string;
}
export interface ArtifactTransport {
  create(request: ArtifactRequest): Promise<void>;
}
export const MAX_ARTIFACT_BYTES = 1_000_000;
export function artifactPath(directory: string, name: string): string {
  const path = directory ? `${directory}/${name}` : name;
  if (
    !name ||
    name.includes("/") ||
    path.length > 512 ||
    /[\\%?#:\x00-\x1f]/.test(path) ||
    path.split("/").some((p) => !p || p.startsWith("."))
  )
    throw new Error(
      "Choose a name without slashes, hidden prefixes, or path control characters.",
    );
  return path;
}
export async function uploadRequest(
  directory: string,
  file: File,
): Promise<ArtifactRequest> {
  if (file.size > MAX_ARTIFACT_BYTES)
    throw new Error("Files must be 1 MB or smaller.");
  const path = artifactPath(directory, file.name);
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return {
    path,
    kind: file.name.endsWith(".ipynb") ? "notebook" : "file",
    content_base64: btoa(binary),
  };
}
export class HttpArtifactTransport implements ArtifactTransport {
  constructor(private readonly headers: () => Record<string, string>) {}
  async create(request: ArtifactRequest): Promise<void> {
    const response = await fetch("/api/v1/artifacts", {
      method: "POST",
      headers: { ...this.headers(), "content-type": "application/json" },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(65000),
    });
    if (!response.ok) {
      const value = await response.json().catch(() => null);
      throw new Error(
        value?.message ??
          "Upload was not confirmed. Refresh before retrying; check the file size and gateway support.",
      );
    }
  }
}
