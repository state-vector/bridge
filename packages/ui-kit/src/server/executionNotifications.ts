import type { ExecutionAttention } from "@bridge/contracts";
import { getKbHubConfig } from "./config";

export interface ExecutionNotice { id: string; title: string; body: string; url: string }
/** Notifications are hints, never lifecycle inputs. Dismissal has no handler. */
export function notifyExecutionAttention(data: ExecutionAttention): void {
  const key = `bridge.execution.notified:${getKbHubConfig().url}:${data.workspace}`;
  let seen: string[];
  try { const stored: unknown = JSON.parse(localStorage.getItem(key) ?? "[]"); seen = Array.isArray(stored) ? stored.filter((v): v is string => typeof v === "string") : []; } catch { seen = []; }
  for (const item of data.items) for (const blocker of item.blockers) {
    if (blocker.kind !== "local_pickup_required" && blocker.kind !== "capability_unavailable") continue;
    const id = `${item.id}:${blocker.episode_id}`;
    if (seen.includes(id)) continue;
    const notice: ExecutionNotice = { id, title: blocker.kind === "local_pickup_required" ? "Bridge — pick up locally" : "Bridge — capability unavailable", body: `${item.id}: ${blocker.text}`, url: item.url };
    window.dispatchEvent(new CustomEvent<ExecutionNotice>("bridge-execution-attention", { detail: notice }));
    if (!("__TAURI_INTERNALS__" in window) && typeof Notification !== "undefined" && Notification.permission === "granted") {
      const notification = new Notification(notice.title, { body: notice.body, tag: id });
      notification.onclick = () => { window.focus(); window.location.assign(notice.url); };
    }
    seen.push(id);
  }
  try { localStorage.setItem(key, JSON.stringify(seen.slice(-1000))); } catch { /* attention cards remain authoritative when browser storage is disabled */ }
}
