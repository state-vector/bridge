import { StartupWaitSchema, startupWaitReason } from "@bridge/contracts";

export function StartupWaitNotice({ wait }: { wait: unknown }) {
  const parsed = StartupWaitSchema.safeParse(wait);
  if (!parsed.success) return null;
  return <div className="detail-block" role="status">
    <strong>{parsed.data.attention_at !== null ? "Critical startup wait" : "Executor startup wait"}</strong>
    <p>{startupWaitReason(parsed.data)}</p>
    <span>Previous executor: {parsed.data.host}. {parsed.data.retained_work ? "Retained work stays on this host." : "Another compatible healthy executor may pick up this task."}</span>
  </div>;
}
