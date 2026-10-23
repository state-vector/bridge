import { WebviewWindow } from "@tauri-apps/api/webviewWindow";

/** Open a task or decision in its own OS window. Label must be unique per
 *  open (reopen-same-task after close gets a fresh label). URL rides the
 *  query string — main.tsx routes ?task= / ?decision= to the window shell. */
export function openDetailWindow(kind: "task" | "decision", id: string) {
  const label = `${kind}-${id.replace(/[^a-zA-Z0-9-]/g, "_")}-${Date.now() % 100000}`;
  new WebviewWindow(label, {
    url: `${location.pathname}?${kind}=${encodeURIComponent(id)}`,
    title: id,
    width: 800,
    height: 880,
    minWidth: 560,
    minHeight: 480,
  });
}
