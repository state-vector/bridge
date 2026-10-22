import { useEffect, useState } from "react";
import { useKb } from "../store/kb";
import { kbApi, type KbArtefact, type KbVersion } from "../lib/kb";
import { rel } from "../lib/views";
import { ActionRow, Btn, Card, Chip, ConnDot, TextArea, TextInput } from "@bridge/ui-kit";

/** Discussion tab = threaded display of question tasks with responses.
 *  No separate discussion artefacts: a "thread" is a task with meta.kind
 *  === "question"; its responses are the history stream (progress notes,
 *  asks, answers, transitions). Never claimed, never swept — anyone may
 *  contribute. */

const SENT_DOT: Record<string, string> = {
  going_well: "var(--green)", converging: "var(--accent)", neutral: "#3a4356",
  diverging: "var(--startup)", struggling: "var(--red)",
};

const ACTION_LABEL: Record<string, string> = {
  create: "asked",
  progress: "",
  transition: "→",
  update: "edited",
  link: "linked",
  discuss: "contributed",
};

function versionText(v: KbVersion): string {
  const note = (v.data?.note as string | undefined) ?? v.summary;
  return (note ?? "").trim();
}

function Thread({ task, onBack }: { task: KbArtefact; onBack: () => void }) {
  const [versions, setVersions] = useState<KbVersion[] | null>(null);
  const [reply, setReply] = useState("");
  const [msg, setMsg] = useState("");
  // escalate-to-decision (BR#909): the proposal IS the request for the ruling —
  // one action files it, pre-filled from this thread's history
  const [escOpen, setEscOpen] = useState(false);
  const [escTitle, setEscTitle] = useState("");
  const [escBody, setEscBody] = useState("");
  const [escMsg, setEscMsg] = useState("");
  const [escBusy, setEscBusy] = useState(false);

  useEffect(() => {
    let dead = false;
    setVersions(null);
    kbApi.history(task.id)
      .then((r) => { if (!dead) setVersions(r.versions ?? []); })
      .catch(() => { if (!dead) setVersions([]); });
    return () => { dead = true; };
  }, [task.id]);

  const send = async () => {
    if (!reply.trim()) return;
    try {
      await kbApi.progress(task.id, reply.trim());
      setReply("");
      setMsg("sent");
      setTimeout(() => setMsg(""), 1500);
      const r = await kbApi.history(task.id);
      setVersions(r.versions ?? []);
    } catch (e) {
      setMsg(`failed: ${(e as Error).message}`);
    }
  };

  // oldest last = a natural thread; skip pure heartbeat noise with empty notes
  const stream = (versions ?? []).slice().reverse().filter((v) => v.action !== "progress" || versionText(v));

  // contributors = everyone who spoke on the thread (agents + humans), deduped
  const contributors = [...new Set((versions ?? []).filter((v) => v.action === "progress").map((v) => v.actor))];
  const awaiting = (task.meta as any)?.awaiting_decision as string | undefined;
  const settled = ["done", "superseded"].includes(task.status);
  const openEsc = () => {
    setEscTitle(`Decision: ${task.title}`.slice(0, 290));
    setEscBody(
      [
        `Escalated from question ${task.id} — "${task.title}".`,
        "",
        "The convergence from the question thread, for the ruling:",
        task.body_md ?? "",
        "",
        contributors.length ? `Contributors: ${contributors.join(", ")}` : "Contributors: none logged yet",
      ].join("\n"),
    );
    setEscOpen(true);
  };
  const fileEscalation = async () => {
    if (!escTitle.trim()) return;
    setEscBusy(true);
    setEscMsg("");
    try {
      const r = await kbApi.create({
        type: "decision",
        title: escTitle.trim(),
        body_md: escBody.trim(),
        meta: { decision_class: "question-escalation", question: task.id, contributors },
        derived_from: task.id,
      });
      setEscOpen(false);
      setEscMsg(`filed ${r.id} — acceptance closes this question, rejection reopens it`);
      setTimeout(() => setEscMsg(""), 6000);
    } catch (e) {
      setEscMsg(`failed: ${(e as Error).message}`);
    } finally {
      setEscBusy(false);
    }
  };

  return (
    <div className="disc-wrap">
      <div className="view-head">
        <Btn quiet onClick={onBack}>← All threads</Btn>
        <h2>{task.title}</h2>
      </div>
      <Card className="ask-thread">
        <div className="ask-chips">
          <Chip tone={task.status === "done" ? "done" : "needs"}>{task.status.toUpperCase()}</Chip>
          {task.board && <Chip tone="scope">{task.board.toUpperCase()}</Chip>}
          {awaiting && <Chip tone="urgent" title="a decision has been filed — accepting it closes this question, rejecting reopens it">AWAITING DECISION {awaiting}</Chip>}
          <span className="why-line">{task.owner ?? "—"} · opened {rel(task.created_ts)}</span>
        </div>
        <pre className="know-body">{task.body_md}</pre>
        {!settled && !awaiting && (
          <div className="steer-box">
            {!escOpen && <Btn onClick={() => openEsc()}>Escalate to decision ↑</Btn>}
            {escOpen && (
              <div className="forme-reject">
                <TextInput
                  autoFocus
                  value={escTitle}
                  placeholder="Decision title"
                  onChange={(e) => setEscTitle(e.target.value)}
                />
                <TextArea
                  rows={6}
                  value={escBody}
                  placeholder="The proposed ruling — pre-filled from the thread; edit freely"
                  onChange={(e) => setEscBody(e.target.value)}
                />
                <ActionRow>
                  <Btn variant="accept" disabled={escBusy || !escTitle.trim()} onClick={() => void fileEscalation()}>File decision (proposed)</Btn>
                  <Btn quiet onClick={() => setEscOpen(false)}>Cancel</Btn>
                </ActionRow>
                <p className="why-line">Filing proposes the decision and stamps this question as awaiting it — acceptance closes the question, rejection reopens it. The human rules in For Me.</p>
              </div>
            )}
          </div>
        )}
        {escMsg && <p className="ok">{escMsg}</p>}
      </Card>
      <div className="disc-list">
        {(versions === null) && <p className="empty">loading responses…</p>}
        {stream.map((v) => (
          <Card key={v.seq} className={`resp ${v.action === "progress" ? "resp-note" : ""}`}>
            <div className="ask-chips">
              {v.data?.sentiment ? <span className="sent-dot" style={{ background: SENT_DOT[String(v.data.sentiment)] ?? "#3a4356" }} /> : null}
              <span className="resp-actor">{v.actor}</span>
              <span className="why-line">{ACTION_LABEL[v.action] ?? v.action} · {rel(v.ts)}</span>
            </div>
            {versionText(v) && <p className="resp-body">{versionText(v)}</p>}
          </Card>
        ))}
        <Card>
          <TextArea
            rows={2}
            value={reply}
            placeholder="Reply — answer, evidence, concern…"
            onChange={(e) => setReply(e.target.value)}
          />
          <p><Btn disabled={!reply.trim()} onClick={() => void send()}>Reply</Btn> {msg && <span className="ok">{msg}</span>}</p>
        </Card>
      </div>
    </div>
  );
}

export function DiscussionsView() {
  const tasks = useKb((s) => s.tasks);
  const conn = useKb((s) => s.conn);
  const initialThread = useKb((s) => s.initialThread);
  const [openId, setOpenId] = useState<string | null>(initialThread);
  const [title, setTitle] = useState("");
  const [context, setContext] = useState("");
  const [msg, setMsg] = useState("");

  const threads = tasks.filter((t) => t.meta?.kind === "question" || (t.tags ?? []).includes("question"));
  const open = openId ? threads.find((t) => t.id === openId) : null;

  // reopen detection: if the WS refresh drops the task, fall back to the id
  const [refreshTick, setRefreshTick] = useState(0);
  useEffect(() => { setRefreshTick((x) => x + 1); }, [tasks.length]);

  const ask = async () => {
    if (!title.trim()) return;
    try {
      await kbApi.create({ type: "task", title: title.trim(), body_md: context.trim(), meta: { kind: "question" } });
      setTitle(""); setContext("");
      setMsg("asked");
      setTimeout(() => setMsg(""), 1500);
    } catch (e) {
      setMsg(`failed: ${(e as Error).message}`);
    }
  };

  if (open || openId) {
    const t = open ?? (openId ? { id: openId, title: "…", status: "…", type: "task", created_ts: 0, updated_ts: 0 } as KbArtefact : null);
    if (t) {
      return <Thread task={t} onBack={() => setOpenId(null)} />;
    }
  }

  return (
    <div className="disc-wrap">
      <div className="view-head">
        <h2>Discussions</h2>
        <span className="muted-note">question tasks + responses — agents and humans in one thread</span>
        <ConnDot state={conn === "open" ? "open" : "closed"} className="conn" title={`kb realtime: ${conn}`} />
      </div>

      <Card>
        <h2>Ask a question</h2>
        <TextInput value={title} placeholder="What should the dispatch backoff strategy be?" onChange={(e) => setTitle(e.target.value)} />
        <TextArea rows={2} value={context} placeholder="Context — the problem, constraints, what you considered…" onChange={(e) => setContext(e.target.value)} />
        <p><Btn disabled={!title.trim()} onClick={() => void ask()}>Ask</Btn> {msg && <span className="ok">{msg}</span>}</p>
      </Card>

      <div className="disc-list" key={refreshTick}>
        {threads.map((t) => (
          <Card key={t.id} className="disc" onClick={() => setOpenId(t.id)}>
            <div className="ask-chips">
              <Chip tone={t.status === "done" ? "done" : "needs"}>{t.status.toUpperCase()}</Chip>
              {t.board && <Chip tone="scope">{t.board.toUpperCase()}</Chip>}
              {(t.meta as any)?.awaiting_decision && <Chip tone="urgent">AWAITING DECISION {(t.meta as any).awaiting_decision}</Chip>}
              <span className="why-line">{t.owner ?? "—"} · opened {rel(t.created_ts)} · updated {rel(t.updated_ts)}</span>
            </div>
            <h3 className="ask-question">{t.title}</h3>
            <p className="ask-reason">{(t.body_md ?? "").trim().slice(0, 140) || "—"}{(t.body_md ?? "").length > 140 ? "…" : ""}</p>
          </Card>
        ))}
        {threads.length === 0 && <p className="empty">No open question threads.</p>}
      </div>
    </div>
  );
}
