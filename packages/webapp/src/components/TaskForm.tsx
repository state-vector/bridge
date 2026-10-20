import { useEffect, useState } from "react";
import { kbApi } from "../lib/kb";
import { useKb } from "../store/kb";

/**
 * In-board task create/edit form (TASK-016 slice, spec BR#541).
 * Editable: title, description, owner (create), tags (edit). Not editable: id,
 * timestamps, provenance/history. Create opens empty; edit pre-fills from the task.
 * Failures keep the form open and preserve the draft.
 */
export function TaskForm({ taskId, onClose }: { taskId?: string; onClose: () => void }) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [owner, setOwner] = useState("");
  const [tags, setTags] = useState("");
  const [msg, setMsg] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!taskId) return;
    void (async () => {
      try {
        const a = await kbApi.artefact(taskId);
        setTitle(a.title ?? "");
        setBody(a.body_md ?? "");
        setOwner(a.owner ?? "");
        setTags((a.tags ?? []).join(", "));
      } catch (e) { setMsg(`failed to load: ${(e as Error).message}`); }
    })();
  }, [taskId]);

  const parseTags = (s: string) => s.split(",").map((t) => t.trim()).filter(Boolean);

  const refresh = useKb((s) => s.refresh);
  const submit = async () => {
    if (!title.trim()) { setMsg("title is required"); return; }
    setLoading(true);
    try {
      if (taskId) {
        const a = await kbApi.artefact(taskId);
        // meta must round-trip: the update endpoint overwrites meta wholesale
        await kbApi.update(taskId, {
          title: title.trim(),
          body_md: body,
          meta: a.meta ?? {},
          tags: parseTags(tags),
        });
      } else {
        await kbApi.create({
          type: "task",
          title: title.trim(),
          body_md: body.trim() || undefined,
          owner: owner.trim() || undefined,
        });
      }
      onClose();
      void refresh();
    } catch (e) {
      setMsg(`failed: ${(e as Error).message}`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="task-form">
      <div className="fields-menu-head">
        <span>{taskId ? `Edit ${taskId}` : "New task"}</span>
        <button className="icon-btn" onClick={onClose}>✕</button>
      </div>
      <input value={title} placeholder="Title — what and why" onChange={(e) => setTitle(e.target.value)} />
      <textarea rows={5} value={body} placeholder="Description — context, acceptance criteria, out of scope…" onChange={(e) => setBody(e.target.value)} />
      {!taskId && <input value={owner} placeholder="Owner (optional — leave empty for the unclaimed pool)" onChange={(e) => setOwner(e.target.value)} />}
      {taskId && <input value={tags} placeholder="Tags, comma-separated" onChange={(e) => setTags(e.target.value)} />}
      <div className="ask-actions">
        <button className="opt-btn" disabled={loading || !title.trim()} onClick={() => void submit()}>
          {taskId ? "Save" : "Create"}
        </button>
        <button className="opt-btn opt-ghost" onClick={onClose}>Cancel</button>
      </div>
      {msg && <span className="muted-note">{msg}</span>}
    </div>
  );
}
