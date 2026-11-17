export const isDesktop = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export async function desktopInvoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!isDesktop()) throw new Error("This action requires Finance Atlas Desktop.");
  const {invoke} = await import("@tauri-apps/api/core");
  return invoke<T>(command, args);
}

export async function desktopDownload(name: string, blob: Blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const chunks: string[] = [];
  for (let i = 0; i < bytes.length; i += 0x8000) chunks.push(String.fromCharCode(...bytes.subarray(i, i + 0x8000)));
  const path = await desktopInvoke<string | null>("export_file", {name, data: btoa(chunks.join(""))});
  if (path) window.dispatchEvent(new CustomEvent("atlas-export-status", {detail: {message: "Export saved and verified."}}));
}
