import type { GatewayDispatch, SchedulingReason } from "@bridge/contracts";
import { useMemo, useState } from "react";
import { useKb } from "../server/kbStore";
import { kbApi } from "../server/kb";
import { TaskDetail } from "./TaskDetail";
import { kindOf, rel, exitClassOf, dispatchExitClass, blockedSummaryOf, EXIT_CLASSES, EXIT_CLASS_ORDER, unblockTwinIndex, activeUnblockTwinOf } from "../server/views";
import { Btn, Chip } from "./index-kit";
import { TagThemeBar, TagChips, useTagTheme } from "./TagFilter";

/** Backlog + Completed: the whole queue (2026-10-29 spec, Ray): NEXT (todo,
 *  claim-ranked) then every parked card filed under its EXIT CONDITION —
 *  the typed await_event class (awaiting you · PR verification · PR merge ·
 *  CI · deploy · another task · GitHub issue · a date · green main · other ·
 *  timeout churn parks). Completed = done work, newest first. Same ktable
 *  primitive as Top; only --cols differ. Top renders no parking lot. */

function rankOf(t: any, parentIdOf: Map<string, string>, inReviewIds?: Set<string>): { rank: number; why: string } {
  const roles: string[] = t.roles ?? [];
  const m = t.meta ?? {};
  // release-parked-work levers first (verify + unblock — mirrors the orient
  // pool ranking in worker do.ts, 2026-10-24): in_review work parks its
  // owner until a fresh session rules; nothing outranks clearing that.
  const parentId = parentIdOf.get(t.id);
  if (parentId && roles.includes("review") && (!inReviewIds || inReviewIds.has(parentId))) {
    return { rank: 0, why: `verify duty — parks ${parentId}'s owner` };
  }
  if (roles.includes("unblock")) return { rank: 0, why: "unblock duty — cheapest lever on parked work" };
  if (t.status === "blocked") {
    if (m.blocked?.unblock_condition) return { rank: 1, why: "blocked with an exit condition — resumable now" };
    return { rank: 5, why: "blocked without an exit condition — needs re-scope" };
  }
  if (t.type === "question") return { rank: 3, why: "question — open for contributions" };
  if (roles.includes("analysis")) return { rank: 3, why: "analysis — qualifies downstream impl" };
  return { rank: 4, why: "todo" };
}

const gatewayHoldLabels: Record<SchedulingReason, string> = {
  qualification: "Needs qualification",
  operator_gate: "Waiting for an operator decision",
  question: "Waiting for an answer",
  independent_wait: "Waiting on a separate review or prerequisite",
  writer_not_quiescent: "Previous worker has not confirmed it stopped",
  unknown_operations: "Previous operation needs reconciliation",
  retry_budget: "Retry budget exhausted; needs recovery evidence or a changed approach",
  host_affinity: "Work is retained on another host",
  recovery_route: "Verified retry permit is waiting for its selected gateway and model",
  capability: "No ready gateway matches the required model, tools, or environment",
  startup_prerequisite: "Previous startup failed; needs a changed prerequisite",
  lifecycle_gate: "Task ownership or lifecycle prevents dispatch",
};

function gatewayReason(dispatch?: GatewayDispatch): string {
  if (!dispatch) return "Gateway eligibility has not been reported";
  if (dispatch.kind === "gateway_unavailable") return dispatch.reasons?.length
    ? dispatch.reasons.map(reason => gatewayHoldLabels[reason]).join(" · ")
    : "No live gateway is ready to take work";
  if (dispatch.kind === "eligible") return "";
  const attempt = dispatch.last_attempt && {
    provider_route: "Last attempt: provider route unavailable.",
    provider_auth: "Last attempt: provider authentication failed.",
    provider_quota: "Last attempt: provider quota error.",
    completed: "Last process exited; the task still lacks a recorded completion.",
    interrupted: "Last attempt stopped; earlier failures still count.",
    timed_out: "Last attempt timed out; cause needs diagnosis.",
    unclassified: "The recorded attempt does not establish a cause.",
  }[dispatch.last_attempt];
  return [...dispatch.reasons.map(reason => gatewayHoldLabels[reason]), ...(attempt ? [attempt] : [])].join(" · ");
}

interface BlGroup {
  key: string;
  title: string;
  note: string;
  rows: any[];
  showRank: boolean;
  showBoost: boolean;
  icon?: string;
  unblockedBy?: string;
  unblockedTone?: "urgent" | "warn" | "scope";
}

export function BacklogView({ openTask }: { openTask?: (id: string) => void } = {}) {
  const conn = useKb((s) => s.conn);
  const tasks = useKb((s) => s.tasks);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const openDetails = (id: string) => (openTask ? openTask(id) : setSelectedTaskId(id));
  const [msg, setMsg] = useState("");
  // tag themes: counts over the open pool, the filter applies to every group
  const tagTheme = useTagTheme(tasks.filter((t) => !["done", "superseded"].includes((t as any).status)));

  const groups = useMemo<BlGroup[]>(() => {
    const ts = tasks as any[];
    const parentOf = new Map<string, string>();
    for (const t of ts) if (t.part_of) parentOf.set(t.id, t.part_of);
    const inReviewIds = new Set(ts.filter((t) => t.status === "in_review").map((t) => t.id));
    const twinIdx = unblockTwinIndex(ts);
    const decorate = (t: any) => {
      const { rank, why } = rankOf(t, parentOf, inReviewIds);
      const boosted = !!(t.meta?.boosted);
      return {
        t,
        rank: boosted ? -1 : rank,
        why: boosted ? "boosted — priority 0 (human)" : why,
        boosted,
        attempts: t.meta?.attempt?.attempts ?? 0,
      };
    };
    const byUpdated = (a: any, b: any) => (b.updated_ts ?? 0) - (a.updated_ts ?? 0);

    const ready = ts.filter((t) => t.status === "todo" && t.gateway_dispatch?.kind === "eligible").map(decorate)
      .sort((a, b) => (b.boosted ? 1 : 0) - (a.boosted ? 1 : 0) || a.rank - b.rank || a.t.updated_ts - b.t.updated_ts);
    // every parked card files under its exit condition (typed await_event
    // class with prose fallback) — one group per class, ordered by
    // EXIT_CLASS_ORDER; in_review rides the same classifier ("Awaiting PR
    // verification"). The live unblock duty is a chip on the row, not a group.
    const questions = ts.filter((t) => t.status === "todo" && t.type === "question" && !t.meta?.startup_wait).sort(byUpdated);
    const parked = ts.filter((t) => t.status === "todo" && t.type !== "question" && !t.meta?.startup_wait && !t.gateway_dispatch).sort(byUpdated);
    const byExit = new Map<string, any[]>();
    for (const t of ts) {
      const dispatch = t.status === "todo" && t.type !== "question" && !t.meta?.startup_wait
        && t.gateway_dispatch?.kind !== "eligible" ? t.gateway_dispatch as GatewayDispatch | undefined : undefined;
      if (!dispatch && t.status !== "blocked" && t.status !== "in_review" && !(t.status === "todo" && t.meta?.startup_wait)) continue;
      // Standing merge-lane cards and infra anchors belong to the Trains panel /
      // infra sinks, not the task backlog (BR#6395).
      if (t.meta?.lane?.key || t.meta?.infra_anchor) continue;
      const typedWait = dispatch?.kind === "held" && dispatch.reasons.includes("independent_wait") && t.meta?.blocked?.await_event;
      const cls = typedWait ? exitClassOf({ ...t, status: "blocked" }) : dispatch ? dispatchExitClass(dispatch) : exitClassOf(t);
      const list = byExit.get(cls.key) ?? [];
      list.push({ t, dispatch, typedWait, duty: !!activeUnblockTwinOf(t, twinIdx) });
      byExit.set(cls.key, list);
    }
    // boost-first WITHIN each exit group (BR#4068 rank seam — the ▲ pins
    // priority 0 everywhere; the awaiting filter reads it hot: a boosted
    // Awaiting park is one human leg from landed), then newest first.
    for (const list of byExit.values()) list.sort((a: any, b: any) => (!!b.t.meta?.boosted ? 1 : 0) - (!!a.t.meta?.boosted ? 1 : 0) || (b.t.updated_ts ?? 0) - (a.t.updated_ts ?? 0));
    const exitGroups: BlGroup[] = [];
    for (const key of EXIT_CLASS_ORDER) {
      const rows = byExit.get(key) ?? [];
      if (rows.length === 0) continue;
      const cls = EXIT_CLASSES[key];
      exitGroups.push({
        key,
        title: cls.title,
        note: cls.note,
        icon: cls.icon,
        unblockedBy: cls.unblockedBy,
        unblockedTone: cls.unblockedTone,
        rows,
        showRank: false,
        showBoost: false,
      });
    }

    return [
      { key: "ready", title: "Ready for gateway", note: "Eligible for at least one ready gateway. A free slot is still required.", rows: ready, showRank: true, showBoost: true },
      { key: "questions", title: "Open questions", note: "Waiting for an answer or contribution.", rows: questions, showRank: false, showBoost: false },
      ...exitGroups,
      { key: "parked", title: "Parked — not dispatchable", note: "deliberately out of the pool; bring one back from its card.", rows: parked, showRank: false, showBoost: false },
    ].filter((g) => g.rows.length > 0 && g.rows.some((r: any) => tagTheme.passes(r.t ?? r)))
      .map((g) => ({ ...g, rows: g.rows.filter((r: any) => tagTheme.passes(r.t ?? r)) }));
  }, [tasks, tagTheme]);

  const parkedReason = (t: any): string => {
    if (exitClassOf(t).key === "timeout") return "churn/rework park — the watchdog drains it automatically; release early right here";
    if (t.status === "blocked") return (t.meta?.blocked?.unblock_condition ?? "blocked — open the card, resolve or re-scope").slice(0, 90);
    if (t.type === "question" || t.meta?.kind === "question") {
      // BR#3911: a live human hold says who has it and that it self-heals
      const c = t.meta?.human_claimed;
      if (c && typeof c.expires_ts === "number" && c.expires_ts > Date.now())
        return `${c.by || "a human"} has it in hand — auto-reopens when the hold expires`;
      return "question — collect answers, the author closes it with a decision";
    }
    if (t.meta?.operator_gated) return `operator gate: ${t.meta.operator_gated} — a human clears it`;
    return (t as any).claim_reason || "not dispatchable — see card";
  };

  const boost = async (id: string, on: boolean, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await kbApi.boost(id, on);
      await useKb.getState().refresh();
      setMsg(on ? `boosted ${id} + dependencies` : `boost removed from ${id}`);
      setTimeout(() => setMsg(""), 2500);
    } catch (err) {
      setMsg(`failed: ${(err as Error).message}`);
    }
  };

  // churn parks (timeout exit class): the watchdog drains them automatically
  // (BR#2893); Release is the human early-exit lever. The transition rides the
  // SAME machine gates as any pool release — a protected card (typed await,
  // train-queue state) refuses server-side and surfaces here, never routed
  // around.
  const releaseOne = async (t: any, e?: React.MouseEvent) => {
    e?.stopPropagation();
    try {
      await kbApi.transition(t.id, "todo", { note: "released early from the churn park (human, Backlog)" });
      return true;
    } catch (err) {
      setMsg(`${t.id} refused: ${String((err as Error).message ?? err).slice(0, 160)}`);
      return false;
    }
  };
  const releaseAndMsg = async (t: any, e: React.MouseEvent) => {
    const ok = await releaseOne(t, e);
    if (ok) {
      await useKb.getState().refresh();
      setMsg(`released ${t.id} to the pool`);
      setTimeout(() => setMsg(""), 2500);
    }
  };
  const releaseAll = async (rows: any[]) => {
    let ok = 0;
    const refused: string[] = [];
    for (const r of rows) {
      const t = r.t ?? r;
      if (t.status !== "blocked") {
        refused.push(`${t.id} (not blocked)`);
        continue;
      }
      if (await releaseOne(t)) ok++;
      else refused.push(t.id);
    }
    await useKb.getState().refresh();
    setMsg(`released ${ok}/${rows.length} to the pool` + (refused.length ? ` — refused: ${refused.join(", ")}` : ""));
    setTimeout(() => setMsg(""), 6000);
  };

  const total = groups.reduce((n, g) => n + g.rows.length, 0);

  return (
    <div className="backlog-wrap">
      {selectedTaskId && <TaskDetail taskId={selectedTaskId} onClose={() => setSelectedTaskId(null)} onOpen={setSelectedTaskId} />}
      <div className="view-head">
        <h2>Backlog</h2>
        <span className="muted-note">{total} items — gateway eligibility · open questions · blocked by reason</span>
        {msg && <span className="ok">{msg}</span>}
      </div>
      <TagThemeBar theme={tagTheme} />
      {groups.map((g) => (
        <div key={g.key} className="backlog-group">
          <div className="view-head backlog-group-head">
            <h2>{g.title}</h2>
            {g.unblockedBy && (
              <Chip tone={g.unblockedTone ?? "scope"} title="who or what unblocks cards in this section">
                unblocked by: {g.unblockedBy}
              </Chip>
            )}
            <span className="muted-note">{g.rows.length} · {g.note}</span>
            {g.key === "timeout" && g.rows.length > 0 && (
              <Btn
                size="sm"
                title="release every card in this section to the pool — protected cards (typed awaits, train-queue) refuse server-side and are listed"
                onClick={() => void releaseAll(g.rows)}
              >
                Release all
              </Btn>
            )}
          </div>
          <div className="backlog-list">
            {g.rows.map((r: any) => {
              const t = r.t ?? r;
              const kind = kindOf(t);
              const rank = r.rank;
              const boosted = !!r.boosted;
              const attempts = r.attempts ?? t.meta?.attempt?.attempts ?? 0;
              const bs = r.typedWait ? blockedSummaryOf({ ...t, status: "blocked" }) : (t.status === "blocked" || t.status === "in_review" || t.meta?.startup_wait) ? blockedSummaryOf(t) : null;
              return (
                <div
                  key={t.id}
                  className={`ktable-row backlog-row ${boosted ? "backlog-boosted" : ""} ${g.key === "timeout" || g.key === "parked" ? "backlog-parked" : ""}`}
                  onClick={() => openDetails(t.id)}
                >
                  <span className="backlog-rank" title={`pickup rank: ${r.why ?? parkedReason(t)}`}>
                    {boosted ? "▲" : g.showRank ? rank + 1 : g.icon ?? "▪"}
                  </span>
                  <span className="backlog-id">{t.id}</span>
                  <span className="backlog-main">
                    <span className={`kind-pill kp-${kind}`}>{kind}</span>
                    <span className="backlog-title">{t.title}</span>
                    <TagChips tags={t.tags} />
                    {r.dispatch && !r.typedWait && <span className="backlog-why">
                      <Chip tone={g.unblockedTone ?? "warn"}>{g.unblockedBy}</Chip>{" "}
                      {gatewayReason(r.dispatch)}
                    </span>}
                    {bs && (
                      <span className="backlog-why">
                        <Chip tone={bs.unblockedTone}>{bs.whatUnblocks}</Chip>{" "}
                        {bs.whyBlocked}
                      </span>
                    )}
                    {t.type === "question" && (t.meta?.human_claimed?.expires_ts ?? 0) > Date.now() && (
                      <span className="backlog-why">
                        <Chip tone="scope" title={`${t.meta.human_claimed.by || "a human"} claimed this question — it leaves the agent pool and auto-reopens when the hold expires`}>
                          in hand by {t.meta.human_claimed.by || "human"}
                        </Chip>
                      </span>
                    )}
                  </span>
                  <span className="backlog-meta">
                    {g.key === "timeout" && t.status === "blocked" && (
                      <Btn
                        size="sm"
                        className="release-btn"
                        title="release this card to the pool now — the watchdog would drain it automatically later"
                        onClick={(e) => void releaseAndMsg(t, e)}
                      >
                        Release
                      </Btn>
                    )}
                    {g.showBoost && (
                      <Btn
                        size="sm"
                        className="boost-btn"
                        on={boosted}
                        title={boosted ? "remove boost (this task + its open children)" : "boost to priority 0 (this task + its open children)"}
                        onClick={(e) => void boost(t.id, !boosted, e)}
                      >
                        {boosted ? "▼ unboost" : "▲ boost"}
                      </Btn>
                    )}
                    {attempts > 0 && <Chip tone="urgent" title={`attempted ${attempts}x`}>×{attempts}</Chip>}
                    {t.owner ? <span title={`claimed by ${t.owner}`}>{t.owner}</span> : <span className="backlog-pool">pool</span>}
                  </span>
                  <span className="backlog-age top-num" title="last updated">{rel(t.updated_ts)}</span>
                </div>
              );
            })}
          </div>
        </div>
      ))}
      {groups.length === 0 && <p className="empty">{conn === "closed" ? "Hub unreachable — check your sign-in / hub url." : "Queue empty — everything in flight or done."}</p>}
    </div>
  );
}

export function CompletedView({ openTask }: { openTask?: (id: string) => void } = {}) {
  const tasks = useKb((s) => s.tasks);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const openDetails = (id: string) => (openTask ? openTask(id) : setSelectedTaskId(id));

  const rows = useMemo(
    () => (tasks as any[]).filter((t) => t.status === "done").sort((a, b) => (b.status_ts ?? b.updated_ts) - (a.status_ts ?? a.updated_ts)),
    [tasks],
  );

  return (
    <div className="backlog-wrap">
      {selectedTaskId && <TaskDetail taskId={selectedTaskId} onClose={() => setSelectedTaskId(null)} onOpen={setSelectedTaskId} />}
      <div className="view-head">
        <h2>Completed</h2>
        <span className="muted-note">{rows.length} items — newest first</span>
      </div>
      <div className="backlog-list">
        {rows.map((t) => {
          const kind = kindOf(t);
          const lifetime = t.created_ts && t.status_ts ? Math.round((t.status_ts - t.created_ts) / 60000) : null;
          return (
            <div key={t.id} className="ktable-row backlog-row backlog-done" onClick={() => openDetails(t.id)}>
              <span className="backlog-id">{t.id}</span>
              <span className="backlog-main">
                <span className={`kind-pill kp-${kind}`}>{kind}</span>
                <span className="backlog-title">{t.title}</span>
                <TagChips tags={t.tags} />
              </span>
              <span className="backlog-meta">{t.owner || t.meta?.session || "—"}</span>
              <span className="backlog-age top-num" title={lifetime ? `lifetime ${lifetime}m` : undefined}>
                done {rel(t.status_ts ?? t.updated_ts)}
                {lifetime != null && lifetime >= 60 ? ` · ${Math.floor(lifetime / 60)}h+` : lifetime != null ? ` · ${lifetime}m` : ""}
              </span>
            </div>
          );
        })}
        {rows.length === 0 && <p className="empty">Nothing completed yet.</p>}
      </div>
    </div>
  );
}
