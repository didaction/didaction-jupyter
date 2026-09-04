interface ImportMeta {
  readonly env: {
    readonly BASE_URL: string;
    readonly VITE_NOTEBOOK_RUNTIME: "server" | "browser";
  };
}
