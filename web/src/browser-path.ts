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
