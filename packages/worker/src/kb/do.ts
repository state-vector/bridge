/**
 * KnowledgeHub Durable Object — the coordination layer's storage + rules.
 *
 * One DO per project ("global" for now). SQLite: artefacts, typed relations,
 * audit events, FTS5 over title+body. Every mutation writes an audit event and
 * bumps updated_ts. Lifecycle transitions and relation rules are enforced HERE,
 * not in clients.
 *
 * Transport: the worker forwards JSON op requests via fetch("https://kb/<op>").
 * Ops: create | get | list | search | update | transition | link | stats
 */
import {
  scaffoldBody,
  EMBED_MODEL,
  TRIGRAM_DIM,
  cosine,
  trigramVec,
  embedText,
  hybridMerge,
  composeBootstrap,
  scoreAgent,
  AgentSignals,
  detectResultTrail,
  describeResultTrail,
  ResultTrail,
  TRANSPORTS,
  ARTEFACT_TYPES,
  ArtefactType,
  DEFAULT_BOARD,
  DEFAULT_CRON_PLAYBOOK,
  DEFAULT_ROLE_PLAYBOOKS,
  DEFAULT_WS_SLUG,
  doWs,
  INITIAL_STATUS,
  verifyVerdictStatement,
  LIMITS,
  SETTINGS_KEYS,
  ASK_ANSWERED,
  ASK_OPEN,
  checkLimits,
  ftsQuery,
  formatId,
  generateAuthToken,
  hashAuthToken,
  idSeq,
  isArtefactType,
  isRelation,
  isSentiment,
  isQuestionTask,
  KIND_TYPE,
  KIND_ROLE,
  KIND_TAG,
  parseRolesInput,
  splitSystemTags,
  isWsSlug,
  isValidAskTarget,
  tagsSayGateway,
  parseTags,
  resolveRolePlaybook,
  selfProvisionLabel,
  sanitizeTags,
  validateRelation,
  // serialized merge train (BR#3516)
  MERGE_TRAIN_QUEUED_REASON,
  MERGE_TRAIN_REASON_PREFIX,
  TRAIN_LEASE_TTL_MS,
  TRAIN_CI_TYPICAL_MINUTES,
  TRAIN_CI_BOUND_MULTIPLIER,
  TRAIN_HEAD_STAMP_RE,
  laneKey,
  laneCardTitle,
  laneCardBody,
  laneOfMeta,
  type LaneSpec,
  leaseDecide,
  mergeTrainQueue,
  verdictCoversHead,
  carryAppend,
  classifyRequiredRuns,
  decideTrainGate,
  trainBounceBrief,
  trainStopAskTitle,
  trainLandedCloseNote,
  type TrainLease,
  type LeaseAction,
  type MainCheckRun,
  type RequiredRunsVerdict,
} from "./core.ts";
import { aggregateThroughput, parseThroughputParams } from "./throughput.ts";
import { parseProvenanceSha } from "./provenance.ts";
import {
  decide,
  invariants as checkInvariants,
  detectBreaches,
  classOf,
  replayStatus,
  BREACH_WINDOW_MS,
  UNBLOCK_FLOOD_MS,
  RuleCtx,
} from "./machine.ts";
import {
  parseProxyCondition,
  parseCloseLegs,
  parseClosureReceipt,
  doneWhenSection,
  legLabel,
  RECEIPT_CONTRACT,
  validateAwaitEvent,
  awaitEventFromAtoms,
  awaitEventToAtom,
  describeAwaitEvent,
  type CloseLeg,
  type ProxyAtom,
} from "./closure.ts";

/** The standing ask sink for the merge train's stop-the-line alarms
 *  (BR#3516 §6) — asks bind to it, so askCreate's identical-open-ask guard
 *  can dedupe per red episode (one ask per class, never one per PR). Same
 *  sink the destination-green sweep used (BR#3124, infrastructure). Override
 *  with the `train_alarm_sink_id` setting if the sink card is re-issued. */
const TRAIN_ALARM_SINK_ID = "BR#3124";

import {
  ROOT_BLOCKER_TAG,
  planRootBlockers,
  rootBlockerBody,
  rootBlockerTitle,
} from "./rollup.ts";

export class KnowledgeHub {
  constructor(private state: DurableObjectState, private env: any) {}

  /** ensureSchema runs once per isolate, not per request — its migration
   *  queries are full-table scans, and the free-tier DO row-read quota
   *  dies under per-request schema checks (2026-10-18 outage). */

  // ---------- realtime (hibernating websockets) ----------

  async handleWs(request: Request) {
    const pair = new WebSocketPair();
    this.state.acceptWebSocket(pair[1]);
    const since = Number(new URL(request.url).searchParams.get("since") ?? 0);
    const recent = await this.eventsSince(since, 100);
    pair[1].send(JSON.stringify({ type: "kb.events", events: recent.events }));
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async webSocketMessage(_ws: WebSocket, message: string) {
    try {
      const m = JSON.parse(message);
      if (m?.type === "ping") _ws.send(JSON.stringify({ type: "pong" }));
    } catch { /* ignore */ }
  }

  webSocketClose() {}

  private broadcastEvent(ev: unknown) {
    const frame = JSON.stringify({ type: "kb.event", event: ev });
    for (const ws of this.state.getWebSockets()) {
      try { ws.send(frame); } catch { /* hibernated client gone */ }
    }
  }

  // Watchdog: silence on in_progress means the agent is gone — unless the
  // silence was DECLARED (grace window, subprocess block). Block it as
  // abandoned; the same agent re-claims it by logging progress again.
  /** Alarm entry point — fail-soft AND self-healing. Two failure modes here:
   *  (1) a throwing alarm() loses its schedule (the runtime consumes it);
   *  (2) a POISONED schedule: next_alarm_ts stuck in the past — the runtime
   *  keeps "firing" it, but if the handler throws before re-arming (old class
   *  version, quota error, whatever), the alarm never moves forward and the
   *  sweep never runs (the Oct-19 dead-watchdog incident: next_alarm_ts stuck
   *  15h in the past, last_tick zero, 12-24h stale rows). So: re-arm FIRST to
   *  now+60s unconditionally (this jumps past any poisoned timestamp), then
   *  run the sweep inside a catch-all that logs. The alarm can never go
   *  silent, and can never stay stuck in the past. */
  async alarm() {
    await this.state.storage.setAlarm(Date.now() + 60_000);
    try {
      await this.alarmSweep();
    } catch (e) {
      try {
        this.audit("system:watchdog", "alarm_error", "watchdog", { error: String((e as Error).message ?? e).slice(0, 300) });
      } catch { /* even auditing failed — next tick retries */ }
    }
  }

  private async alarmSweep() {
    await this.ensureSchema();
    const now0 = Date.now();
    // (0) expire stale open asks. An open ask pauses the watchdog (rule 6) —
    // but an ask to an agent that never answers would pause its task FOREVER
    // (the 19h+ in_progress rows were this). TTL: 24h. Expiry clears the ask
    // and any awaiting_ask marker, so the sweep below judges the task on its
    // own silence.
    const askTtlMs = 24 * 60 * 60_000;
    for (const a of this.state.storage.sql.exec(
      `SELECT id, artefact_id, to_target, created_ts FROM asks WHERE status = 'open' AND created_ts < ?`,
      now0 - askTtlMs,
    ).toArray() as any[]) {
      this.state.storage.sql.exec(
        `UPDATE asks SET status = 'expired', answered_by = 'system:watchdog', answered_ts = ? WHERE id = ?`,
        now0, a.id,
      );
      if (a.artefact_id) {
        const t = this.one(`SELECT meta FROM artefacts WHERE id = ?`, a.artefact_id);
        if (t) {
          const m = JSON.parse(t.meta ?? "{}");
          if (m.awaiting_ask?.ask_id === a.id) {
            delete m.awaiting_ask;
            this.state.storage.sql.exec(`UPDATE artefacts SET meta = ? WHERE id = ?`, JSON.stringify(m), a.artefact_id);
          }
        }
      }
      this.audit("system:watchdog", "ask_expired", String(a.id), {
        to: a.to_target ?? "", artefact: a.artefact_id ?? "",
        age_h: Math.round((now0 - Number(a.created_ts ?? 0)) / 3_600_000),
      });
    }
    const s = this.one(`SELECT value FROM settings WHERE key = 'stale_minutes'`);
    const staleMin = s ? Math.max(1, Math.min(120, parseInt(s.value, 10) || 10)) : 10;
    const staleMs = staleMin * 60_000;
    const now = Date.now();
    const rows = this.state.storage.sql.exec(
      `SELECT id, status, owner, meta, status_ts, updated_ts FROM artefacts
       WHERE type = 'task' AND status = 'in_progress'`,
    ).toArray();
    for (const r of rows as any[]) {
      try {
      const meta = JSON.parse(r.meta ?? "{}");
      if (meta.awaiting_ask) {
        // aging escalation: a task parked on a human answer must show its
        // age, or the wait is invisible and unbounded. Annotate hourly;
        // the release stays human-owned (an answered ask un-blocks it).
        try {
          let ask: { to_target?: string; created_ts: number } | undefined;
          const derived = this.one(
            `SELECT c.id AS id, c.created_ts AS created_ts, c.meta AS cmeta FROM relations r
             JOIN artefacts c ON c.id = r.src_id
              WHERE r.relation = 'child_of' AND r.dst_id = ? AND c.status IN ('todo','in_progress','blocked')
                AND c.type = 'question' ORDER BY c.created_ts DESC LIMIT 1`, r.id,
          );
          if (derived) {
            const nm = JSON.parse(derived.cmeta ?? "{}");
            ask = { to_target: nm.ask?.to, created_ts: derived.created_ts };
          } else if (/^BR#\d+$/.test(String(meta.awaiting_ask.ask_id))) {
            const node = this.one(`SELECT meta, created_ts, status FROM artefacts WHERE id = ? AND status IN ('todo','in_progress','blocked')`, meta.awaiting_ask.ask_id);
            if (node) {
              const nm = JSON.parse(node.meta ?? "{}");
              ask = { to_target: nm.ask?.to, created_ts: node.created_ts };
            }
          } else {
            const row = this.one(`SELECT to_target, created_ts FROM asks WHERE id = ? AND status = 'open'`, meta.awaiting_ask.ask_id);
            if (row) ask = { to_target: row.to_target, created_ts: row.created_ts };
          }
          if (ask) {
            const hours = Math.floor((now - ask.created_ts) / 3_600_000);
            if (meta.awaiting_ask.annotated_h !== hours) {
              meta.awaiting_ask.annotated_h = hours;
              const base = String(meta.blocked?.reason ?? "").replace(/^⏳ blocked \d+h — .*? · /, "");
              meta.blocked = { ...(meta.blocked ?? {}), reason: `⏳ blocked ${hours}h — awaiting ${ask.to_target ?? "human"} on ask ${meta.awaiting_ask.ask_id} · ${base}` };
              this.state.storage.sql.exec(`UPDATE artefacts SET meta = ? WHERE id = ?`, JSON.stringify(meta), r.id);
            }
          }
        } catch { /* annotation is best-effort */ }
        continue;
      }
      // (A) declared grace: the agent stated a silence window — honor it until it lapses
      if (typeof meta.grace_until === "number" && meta.grace_until > now) continue;
      // (A2) declared subprocess window: the task is still in_progress, just
      // quiet while a subprocess runs — watchdog paused until the budget lapses
      if (meta.subprocess && typeof meta.subprocess.deadline_ts === "number") {
        if (meta.subprocess.deadline_ts > now) continue;
        // lapsed: the declaration is a lie — fall through to abandoned below
      }
      const lastTs = Math.max(
        meta.last_progress?.ts ?? 0, r.status_ts ?? 0, r.updated_ts ?? 0,
        meta.session_alive_ts ?? 0, // runner vouches the session is alive (stdout/ACP movement) — quiet work is not dead work
      );
      if (now - lastTs <= staleMs) continue;
      const openAsk = this.one(
        `SELECT id FROM asks WHERE status = 'open' AND artefact_id = ?`, r.id,
      );
      if (openAsk) continue;
      const will = meta.last_progress?.will ? `; was about to: ${String(meta.last_progress.will).slice(0, 120)}` : "";
      const lapsedSub = meta.subprocess ? ` (declared subprocess window of ${meta.subprocess.budget_minutes ?? "?"}m lapsed)` : "";
      // BR#3352: classify the release from the session trail. A silent task
      // whose trail proves landed side effects (GitHub PR/issue/commit
      // receipts, or the runner's own completed_result_lost marker) is NOT an
      // abandonment — the run happened and the report was lost between worker
      // and hub. Recording the outcome class lets the score side exempt it
      // and flags the delivery channel instead of punishing the agent.
      let trail: ResultTrail | null = null;
      try {
        const notes = (this.state.storage.sql.exec(
          `SELECT summary FROM ledger WHERE artefact_id = ? AND kind = 'mutation' AND action = 'progress' ORDER BY seq DESC LIMIT 20`,
          r.id,
        ).toArray() as any[]).map((x) => String(x.summary ?? ""));
        const sess = meta.session
          ? this.one(`SELECT worktree FROM sessions WHERE name = ? AND worktree IS NOT NULL ORDER BY last_seen_ts DESC LIMIT 1`, String(meta.session))
          : null;
        trail = detectResultTrail({
          last_progress_note: meta.last_progress?.note,
          recent_notes: notes,
          worktree: sess?.worktree ?? null,
          session: meta.session ?? null,
        });
      } catch { /* trail read is best-effort — classify as a plain stall on failure */ }
      // STALLED, not blocked: silence means "we haven't heard from the agent"
      // — blocked is reserved for the agent's own explicit "I cannot continue
      // until X". Release straight to todo: the claim drops, the attempted tag
      // records the try, and the next orient reassigns it. No blocked
      // intermediate, no unblock-child spawn for silence.
      await this.transition({
        id: r.id, to: "todo",
        note: trail
          ? `stalled — no update for >${staleMin}m; completed_result_lost — ${describeResultTrail(trail)}; result never reached the hub — released to the pool by watchdog (delivery channel flagged, not agent abandonment)${will}`
          : `stalled — no update for >${staleMin}m${lapsedSub}; released to the pool by watchdog${will}`,
        ...(trail ? { result_class: "completed_result_lost" } : {}),
      }, "system:watchdog");
      } catch (e) {
        // one bad task must not kill the sweep — log and keep going
        this.audit("system:watchdog", "sweep_error", r.id, { error: String((e as Error).message ?? e) });
      }
    }
    // (A3) stale in_review: an impl owner parks in in_review awaiting a verify
    // verdict. If no verifier ever picks the verification round up, the park is
    // permanent — the watchdog used to sweep only in_progress, so in_review
    // rows accumulated indefinitely. Past the review-stale threshold with no
    // verify child actively running, bounce: in_review → in_progress (findings
    // note) → todo (released to the pool). The bounce supersedes the stale
    // verify round automatically.
    const rs = this.one(`SELECT value FROM settings WHERE key = 'review_stale_minutes'`);
    const reviewStaleMin = rs ? Math.max(30, Math.min(2880, parseInt(rs.value, 10) || 360)) : 360;
    const reviewRows = this.state.storage.sql.exec(
      `SELECT id, owner, meta, status_ts, updated_ts FROM artefacts
       WHERE type = 'task' AND status = 'in_review'`,
    ).toArray();
    for (const r of reviewRows as any[]) {
      try {
        const meta = JSON.parse(r.meta ?? "{}");
        if (meta.awaiting_ask) continue;
        const age = now - Math.max(r.status_ts ?? 0, r.updated_ts ?? 0);
        if (age <= reviewStaleMin * 60_000) continue;
        const openAsk = this.one(`SELECT id FROM asks WHERE status = 'open' AND artefact_id = ?`, r.id);
        if (openAsk) continue;
         const activeVerify = this.one(
           `SELECT c.id AS id FROM relations r JOIN artefacts c ON c.id = r.src_id
            WHERE r.relation = 'child_of' AND r.dst_id = ? AND c.status = 'in_progress'
              AND c.roles LIKE '%"review"%' LIMIT 1`, r.id,
         );
        if (activeVerify) continue; // a verifier is on it — give them time
        const hours = Math.round(age / 3_600_000);
        const findings = `watchdog: review stalled ${hours}h — no verifier picked up the verification round. No adverse findings; resolve whatever the last gate/review named and hand off again, or let the work re-enter the pool.`;
        await this.transition({ id: r.id, to: "in_progress", note: findings }, "system:watchdog");
        await this.transition({ id: r.id, to: "todo", note: "released to the pool after a stalled review round (watchdog)" }, "system:watchdog");
      } catch (e) {
        // one bad task must not kill the sweep — log and keep going
        this.audit("system:watchdog", "sweep_error", r.id, { error: String((e as Error).message ?? e) });
      }
    }
    // (B) subprocess blocks (legacy shape: blocked + meta.blocked.class) are gone —
    // subprocess silence now lives on in_progress tasks (A2 above). Nothing to sweep here.
    // (B) subprocess blocks: watchdog paused while the declared budget runs;
    // past the budget the declaration is a lie — convert to abandoned.
    // (Legacy shape only — new subprocess silence lives on in_progress tasks.)
    const subRows = this.state.storage.sql.exec(
      `SELECT id, owner, meta FROM artefacts WHERE type = 'task' AND status = 'blocked'`,
    ).toArray();
    for (const r of subRows as any[]) {
      try {
      const meta = JSON.parse(r.meta ?? "{}");
      const b = meta.blocked;
      if (b?.class !== "subprocess" || typeof b.deadline_ts !== "number") continue;
      if (b.deadline_ts > now) continue;
      const wasDoing = meta.last_progress?.will ? `; was about to: ${String(meta.last_progress.will).slice(0, 120)}` : "";
      // legacy lapsed window: stalled, not blocked — straight to todo
      delete meta.blocked;
      delete meta.subprocess;
      const tags: string[] = parseTags(r.meta ? JSON.parse(r.meta).tags ?? "[]" : "[]");
      if (!tags.includes("attempted")) tags.push("attempted");
      const attempts = ((meta.attempt?.attempts as number) ?? 0) + 1;
      meta.attempt = { by: r.owner || "unknown", at: now, attempts };
      this.state.storage.sql.exec(
        `UPDATE artefacts SET status = 'todo', owner = '', tags = ?, meta = ?, status_ts = ?, updated_ts = ? WHERE id = ?`,
        JSON.stringify(tags), JSON.stringify(meta), now, now, r.id,
      );
      this.audit("system:watchdog", "transition", r.id, { from: "blocked", to: "todo", note: `stalled — declared subprocess window (${b.budget_minutes ?? "?"}m) lapsed${wasDoing}` });
      this.version(r.id, "system:watchdog", "transition", `stalled — declared subprocess window lapsed, released to the pool`, { from: "blocked", to: "todo" });
      } catch (e) {
        this.audit("system:watchdog", "sweep_error", r.id, { error: String((e as Error).message ?? e) });
      }
    }
    // (C) verification nudge: an unclaimed verify task parks its parent's owner —
    // never reaped (you can't be "abandoned" from work you never picked up). Past
    // the threshold, nudge once per hour: audit line (Log + ws broadcast) for the
    // role:review agents and the waiting owner. The score signal does the rest.
    const nudgeRows = this.state.storage.sql.exec(
      `SELECT r.src_id AS verify_task, r.dst_id AS parent_id, c.updated_ts AS age_ts, p.owner AS parent_owner
       FROM relations r
       JOIN artefacts c ON c.id = r.src_id
       JOIN artefacts p ON p.id = r.dst_id
        WHERE r.relation = 'child_of'
          AND c.type = 'task' AND c.status = 'todo' AND c.owner = ''
          AND c.roles LIKE '%"review"%'
          AND p.type = 'task' AND p.status = 'in_review'`,
    ).toArray() as any[];
    for (const v of nudgeRows) {
      const age = now - (v.age_ts ?? now);
      if (age <= 60 * 60_000) continue;
      const lastNudge = this.one(
        `SELECT ts FROM events WHERE artefact_id = ? AND op = 'nudge' ORDER BY ts DESC LIMIT 1`, v.verify_task,
      );
      if (lastNudge && now - Number(lastNudge.ts) <= 60 * 60_000) continue;
      const mins = Math.round(age / 60_000);
      this.audit("system:pool", "nudge", v.verify_task, {
        note: `verify task unclaimed ${mins}m — this blocks ${v.parent_id}'s owner (${v.parent_owner || "unknown"}). Pick it up: check receipts, close or bounce the parent.`,
        parent: v.parent_id, parent_owner: v.parent_owner ?? "", age_min: mins,
      });
    }
    // (B/C/D/G — the hub's GitHub sweeps — DELETED with the hub's credentials
    // (BR#3516 §1/§8): the merge-queue sweep is re-homed as the opportunistic
    // edge executor (scripts/merge-train.mjs, worker-local creds, doctor-
    // defended); stop-the-line reads move into the executor's awaiting-CI
    // poll; provenance is stamped ledger-native by train events; the closure
    // audit was GitHub-reading. The hub keeps its credential-free monitoring
    // job below: lane lease staleness.)

    // (E) blocker rollup: blocked cards sharing one machine-detectable root
    // cause (one unmerged PR; red main — BR#551) collapse into ONE boosted
    // ROOT BLOCKER task, and the queued cards point at it. The human sees a
    // single approval surface instead of N identical parked cards (BR#2645).
    let rollup: { created: string[]; stamped: number } | undefined;
    try {
      rollup = await this.rootBlockerRollup(now);
    } catch (e) {
      // the rollup must never take the watchdog down — log and keep going
      this.audit("system:watchdog", "sweep_error", "root_blocker_rollup", { error: String((e as Error).message ?? e).slice(0, 300) });
    }

    // (F) unblock-proxy watch (BR#3361a): blocked cards with machine-checkable
    // unblock conditions re-evaluated periodically; the unblock duty
    // auto-spawns when the proxy flips TRUE. Isolated like its siblings.
    try {
      await this.unblockProxySweep(now);
    } catch (e) {
      this.audit("hub:proxy-watch", "sweep_error", "unblock_proxy_sweep", { error: String((e as Error).message ?? e).slice(0, 300) });
    }

    // (G) train-watch (BR#3516): the hub's credential-free half of the merge
    // train — lane lease staleness. A lease past its expiry with no live
    // heartbeat means the executor died/went to sleep: the lane card shows
    // `blocked: awaiting an available gateway` (honest — merges happen when
    // machines are on) and the lapsed lease is cleared so the next gateway
    // reconciles from live GitHub and acquires. The executor-side gates make
    // the reconcile safe; the hub never talks to GitHub to check this.
    try {
      await this.trainWatchSweep(now);
    } catch (e) {
      this.audit("system:merge-train", "sweep_error", "train_watch", { error: String((e as Error).message ?? e).slice(0, 300) });
    }

    // observability: the board can answer "is the watchdog alive?" via
    // /api/kb/stats — last tick, next alarm ts (poison detection: a
    // next_alarm_ts stuck in the past means the schedule is jammed), stale
    // in-flight count, open asks.
    const nextAlarm = await this.state.storage.getAlarm();
    this.state.storage.sql.exec(
      `INSERT OR REPLACE INTO settings (key, value) VALUES ('watchdog.last_tick', ?)`,
      String(now),
    );
    this.state.storage.sql.exec(
      `INSERT OR REPLACE INTO settings (key, value) VALUES ('watchdog.next_alarm', ?)`,
      String(nextAlarm ?? 0),
    );
    const staleNow = this.one(
      `SELECT COUNT(*) AS n FROM artefacts WHERE type = 'task' AND status = 'in_progress'
       AND COALESCE(json_extract(meta, '$.last_progress.ts'), 0) < ?`,
      now - staleMs,
    )?.n ?? 0;
    const staleReviewNow = this.one(
      `SELECT COUNT(*) AS n FROM artefacts WHERE type = 'task' AND status = 'in_review' AND status_ts < ?`,
      now - reviewStaleMin * 60_000,
    )?.n ?? 0;
    const openAsks = this.one(`SELECT COUNT(*) AS n FROM asks WHERE status = 'open'`)?.n ?? 0;
    this.state.storage.sql.exec(
      `INSERT OR REPLACE INTO settings (key, value) VALUES ('watchdog.sweep', ?)`,
      JSON.stringify({ ts: now, stale_in_progress: staleNow, stale_in_review: staleReviewNow, review_stale_minutes: reviewStaleMin, open_asks: openAsks, root_blocker_rollup: rollup ?? null }),
    );
  }

  private settingValue(key: string, fallback: string): string {
    const row = this.one(`SELECT value FROM settings WHERE key = ?`, key);
    if (!row) return fallback;
    const raw = String(row.value);
    // settingsSet stores JSON-encoded values ("\"BR#123\""); the sweep's own
    // pacing writes store raw — tolerate both shapes.
    try {
      const v = JSON.parse(raw);
      if (typeof v === "string" || typeof v === "number") return String(v);
    } catch { /* raw */ }
    return raw;
  }


  /** sha → PR → task → verify-verdict → agent session (BR#3287). Matches by
   *  merge sha or head sha (7+ hex prefix). Returns null when nothing is
   *  known — an honest "no bridge provenance" (404) rather than a guess. */
  private async provenanceLookup(sp: URLSearchParams) {
    return this.provenanceBySha(parseProvenanceSha(sp));
  }

  private async provenanceBySha(sha: string) {
    const row = this.one(
      `SELECT * FROM provenance WHERE merge_sha = ? OR merge_sha LIKE ? OR head_sha = ? OR head_sha LIKE ? LIMIT 1`,
      sha, `${sha}%`, sha, `${sha}%`,
    ) as any;
    if (!row) return null;
    const task = row.task_id ? this.one(`SELECT id, title, status, owner FROM artefacts WHERE id = ?`, row.task_id) as any : null;
    return {
      sha,
      repo: row.repo, pr: row.pr,
      merge_sha: row.merge_sha, head_sha: row.head_sha,
      task: task ? { id: task.id, title: task.title, status: task.status, owner: task.owner } : null,
      verdict_id: row.verdict_id, session: row.session, signer: row.signer,
      merged_at: row.merged_at, stamped_at: row.stamped_at,
    };
  }

  /** The guilty-chain outcome for an alarm note (BR#3307, residue of
   *  BR#3287 spec item 4): explicitly typed — `rec` carries the resolved
   *  PR → task → verify verdict → agent session → signer chain when the
   *  provenance index has stamped the merge, and `error` is set ONLY when
   *  the lookup itself failed. Never throws — attribution must not break
   *  the filing (the same downgrade philosophy as the bisect walk) — but a
   *  failure is never converted into success: the caller distinguishes it
   *  (the note renders the error, not the honest-absence line) and the
   *  audit trail receipts it (hub:stop-the-line/guilty_chain_error — SP
   *  review round 1, PR #198: silence was the one thing it must not be). */

  // ---------- unblock-proxy watch (BR#3361a) ----------
  // The BR#3129 class: a parked card's machine-checkable unblock_condition
  // flipped TRUE (its PR merged) and NOBODY noticed for ~20h — unblock duties
  // only re-ran when a human-dispatched sweep happened to look. This sweep
  // re-evaluates machine-checkable proxies periodically and auto-spawns the
  // unblock duty on the flip.
  //
  // Conservatism: the sweep is a TRIGGER, not an authority. It flips a card
  // only when parseProxyCondition extracted atoms for the WHOLE condition and
  // every atom evaluated TRUE against live state; anything it cannot fully
  // read is stamped unparseable/unresolvable and never auto-flips. The
  // spawned duty re-verifies first-hand (its contract says so).
  //
  // Settings: `unblock_proxy_sweep_minutes` (default 15, 0 = off),
  // `unblock_proxy_default_repo` (bare-number fallback for live checks).
  //
  // DEGRADED (BR#3516 §8): the hub holds no VCS credentials, ever — the
  // GitHub-reading proxyGhGet and the unauthenticated fetches are gone. Only
  // board-state atoms (br_done) still evaluate; GitHub-state atoms stamp
  // unresolvable (never auto-flip — conservatism law) and the spawned unblock
  // duty verifies them first-hand, where the creds live.
  /** Live verdict for one proxy atom. `receipt` is the evidence line that
   *  rides the spawned duty's body (and the per-card stamp). */
  private async evalProxyAtom(
    atom: ProxyAtom,
    io: { defaultRepo: string },
  ): Promise<{ ok: boolean; receipt: string }> {
    const unresolvable = { ok: false, receipt: "unresolvable (no repo in the condition text)" };
    switch (atom.kind) {
      case "br_done": {
        const row = this.one(`SELECT status FROM artefacts WHERE id = ?`, atom.brId);
        if (!row) return { ok: false, receipt: `${atom.brId} not found on this board` };
        const done = row.status === "done" || row.status === "superseded";
        return { ok: done, receipt: `${atom.brId} status=${row.status}` };
      }
      case "pr_merged": {
        if (!atom.repo) return unresolvable;
        return { ok: false, receipt: `unresolvable from the hub — GitHub state ${atom.repo}#${atom.number} needs credentials the hub does not hold (BR#3516); verify first-hand (gh pr view) or wait for a train event` };
      }
      case "br_pr_merged": {
        if (!atom.repo) return unresolvable;
        return { ok: false, receipt: `unresolvable from the hub — GitHub state for ${atom.brId} needs credentials the hub does not hold (BR#3516); verify first-hand or wait for a train event` };
      }
      case "issue_closed": {
        if (!atom.repo) return unresolvable;
        return { ok: false, receipt: `unresolvable from the hub — issue ${atom.repo}#${atom.number} state needs credentials the hub does not hold (BR#3516); verify first-hand` };
      }
      case "run_success": {
        if (!atom.repo) return unresolvable;
        return { ok: false, receipt: `unresolvable from the hub — run ${atom.runId} outcome needs credentials the hub does not hold (BR#3516); verify first-hand` };
      }
      case "pr_checks_green": {
        if (!atom.repo) return unresolvable;
        return { ok: false, receipt: `unresolvable from the hub — PR ${atom.repo}#${atom.number} checks need credentials the hub does not hold (BR#3516); verify first-hand or wait for the train's CI verdict` };
      }
    }
  }

  /** Stamp meta.proxy_check on a blocked card; audit ONLY when the verdict
   *  changed (a stable false must not churn the Log every cycle). */
  private stampProxyCheck(
    id: string,
    meta: any,
    now: number,
    verdict: string,
    detail: string | null,
    prev: { verdict?: string } | undefined,
    extra?: Record<string, unknown>,
  ): void {
    meta.proxy_check = { at: now, verdict, ...(detail ? { detail } : {}), ...(extra ?? {}) };
    this.state.storage.sql.exec(`UPDATE artefacts SET meta = ? WHERE id = ?`, JSON.stringify(meta), id);
    if (!prev || prev.verdict !== verdict) {
      this.audit("hub:proxy-watch", "proxy_check", id, { verdict, detail: detail?.slice(0, 300) });
    }
  }

  private async unblockProxySweep(now: number): Promise<void> {
    const periodMin = Math.max(0, Math.min(120, parseInt(this.settingValue("unblock_proxy_sweep_minutes", "15"), 10) || 15));
    if (periodMin === 0) return; // explicitly disabled
    const last = Number(this.settingValue("unblock_proxy_last_ts", "0")) || 0;
    if (now - last < periodMin * 60_000) return;
    const setLast = (ts: number) =>
      this.state.storage.sql.exec(`INSERT OR REPLACE INTO settings (key, value) VALUES ('unblock_proxy_last_ts', ?)`, String(ts));
    setLast(now); // pace BEFORE the fetch: a hung GitHub call must not tight-loop the tick
    const defaultRepo = this.settingValue("unblock_proxy_default_repo", "state-vector/superpositional");
    const rows = this.state.storage.sql.exec(
      `SELECT id, title, meta FROM artefacts WHERE type = 'task' AND status = 'blocked'`,
    ).toArray() as any[];
    for (const r of rows) {
      try {
        const meta = JSON.parse(r.meta ?? "{}");
        const bmeta = meta.blocked ?? {};
        // BR#3578: the typed await (validated at the door) is trusted and
        // evaluated FIRST; the free text is annotation + legacy fallback.
        const aw = validateAwaitEvent(bmeta.await_event) ?? null;
        const cond = String(bmeta.unblock_condition ?? "").trim() || (aw ? describeAwaitEvent(aw) : "");
        if (!cond) continue;
        const prev = meta.proxy_check;
        if (prev?.at && now - Number(prev.at) < periodMin * 60_000) continue; // per-card pacing

        // typed legs: ask/time are first-class — an answered ask or an
        // elapsed timer flips exactly like a machine atom (spawn the duty;
        // the duty re-verifies first-hand).
        if (aw && (aw.event === "ask" || aw.event === "time")) {
          const fired = aw.event === "time"
            ? now >= aw.until_ts
            : (() => {
                const a = this.one(`SELECT status FROM artefacts WHERE id = ?`, aw.ask_id);
                return !a || a.status === "done" || a.status === "superseded";
              })();
          if (!fired) {
            this.stampProxyCheck(r.id, meta, now, "waiting",
              aw.event === "time" ? `timer until ${new Date(aw.until_ts).toISOString()}` : `awaiting ask ${aw.ask_id}`, prev);
            continue;
          }
          const receipt = aw.event === "time"
            ? `timer elapsed (until_ts ${aw.until_ts}, checked ${new Date(now).toISOString()})`
            : `ask ${aw.ask_id} answered/closed`;
          await this.spawnProxyDuty(r, meta, now, prev, cond, [`${describeAwaitEvent(aw)} → ${receipt}`]);
          continue;
        }

        // machine atoms: typed await wins (trusted); legacy text parses and
        // SELF-MIGRATES to the typed shape (one clean atom → await_event).
        let atoms: ProxyAtom[];
        let unparseable: boolean;
        if (aw) {
          atoms = [awaitEventToAtom(aw)!];
          unparseable = false;
        } else {
          const parsed = parseProxyCondition(cond);
          atoms = parsed.atoms;
          unparseable = parsed.unparseable;
          const derived = awaitEventFromAtoms(atoms);
          if (derived) {
            meta.blocked = { ...(meta.blocked ?? {}), await_event: derived };
            this.state.storage.sql.exec(`UPDATE artefacts SET meta = ? WHERE id = ?`, JSON.stringify(meta), r.id);
          }
        }
        if (!atoms.length) {
          // BR#3578 migration: a legacy blocked card awaiting NOTHING (no
          // typed event, no atoms, no bound ask) becomes an ACTIVE ask to the
          // human — once per card, never once per sweep. Cards whose
          // root_blocker is still open skip: the root owns the human leg.
          const rooted = meta.root_blocker
            ? this.one(`SELECT status FROM artefacts WHERE id = ?`, String(meta.root_blocker))
            : null;
          if (!meta.awaiting_ask?.ask_id && !bmeta.await_migration_ask
              && (!rooted || !["todo", "in_progress", "blocked"].includes(rooted.status))) {
            const ask = await this.askCreate({
              to: "ray",
              question: `Blocked card ${r.id} awaits nothing the machine can read — re-scope it, or release it back to the pool?`,
              reason: "the exit condition is prose the hub cannot parse (BR#3578 migration): parked cards awaiting nothing are impossible now — this one needs a human ruling",
              options: ["RE-SCOPE — I'll rewrite the exit condition", "RELEASE — back to the pool anyway", "SUPERSEDE — drop it"],
              details: `"${r.title}" is parked ${unparseable ? "on machine-looking text that parsed to no atom" : "text-only"}: "${cond.slice(0, 240)}". Under BR#3578 every blocked card awaits a typed event, an open ask, or a timer — give this one one, or release it.`,
              artefact_id: r.id,
            }, "hub:proxy-watch").catch(() => null);
            if (ask) {
              meta.blocked = { ...(meta.blocked ?? {}), await_migration_ask: ask.id };
              this.state.storage.sql.exec(`UPDATE artefacts SET meta = ? WHERE id = ?`, JSON.stringify(meta), r.id);
            }
          }
          this.stampProxyCheck(r.id, meta, now, unparseable ? "unparseable" : "no_atoms",
            unparseable ? "condition mentions machine state but no atom parsed — never auto-flips (migrated to an ask)" : "no machine atoms — migrated to an ask", prev);
          continue;
        }
        const results: { atom: ProxyAtom; ok: boolean; receipt: string }[] = [];
        for (const atom of atoms) results.push({ atom, ...(await this.evalProxyAtom(atom, { defaultRepo })) });
        const unresolvable = results.some((x) => !x.ok && x.receipt.startsWith("unresolvable"));
        if (unparseable || unresolvable) {
          // cannot FULLY read the condition — never auto-flip (conservatism law)
          this.stampProxyCheck(r.id, meta, now, unparseable ? "unparseable" : "unresolvable",
            "condition partially machine-checkable — the sweep never flips a card it cannot fully read", prev,
            { atoms: results.map((x) => ({ raw: x.atom.raw, ok: x.ok, receipt: x.receipt })) });
          continue;
        }
        if (!results.some((x) => x.ok)) {
          this.stampProxyCheck(r.id, meta, now, "false", null, prev,
            { atoms: results.map((x) => ({ raw: x.atom.raw, ok: x.ok, receipt: x.receipt })) });
          continue;
        }
        // the flip: spawn the unblock duty (the machine's caps still apply)
        await this.spawnProxyDuty(r, meta, now, prev, cond, results.map((x) => `"${x.atom.raw}" → ${x.receipt}`));
      } catch (e) {
        this.audit("hub:proxy-watch", "sweep_error", r.id, { error: String((e as Error).message ?? e).slice(0, 300) });
      }
    }
  }

  /** BR#3361a / BR#3578: the flip — the exit condition held TRUE; spawn the
   *  unblock duty with the receipts embedded. Shared by atom flips and
   *  ask/time timer fires. Machine caps still apply: ≤1 open unblock child,
   *  flood guard on identical exit conditions. */
  private async spawnProxyDuty(
    r: any, meta: any, now: number, prev: any, cond: string, receiptLines: string[],
  ): Promise<void> {
    const openChild = this.one(
      `SELECT c.id AS id FROM relations r JOIN artefacts c ON c.id = r.src_id
       WHERE r.relation = 'child_of' AND r.dst_id = ? AND c.status IN ('todo','in_progress','blocked')
         AND c.roles LIKE '%"unblock"%' ORDER BY c.updated_ts DESC LIMIT 1`, r.id,
    );
    const lastSpawn = meta.last_unblock_spawn;
    // same flood law as the machine's own spawn (machine.ts): only the
    // SAME exit condition within the window floods — a block-time round
    // with this exact condition is already on the case; a later flip
    // past the window spawns a fresh round (the BR#3129 story: the flip
    // came ~20h after the park-time round)
    const flooded =
      lastSpawn && typeof lastSpawn.at === "number" && now - lastSpawn.at < UNBLOCK_FLOOD_MS &&
      String(lastSpawn.exit ?? "") === cond;
    if (openChild || flooded) {
      this.stampProxyCheck(r.id, meta, now, "true", null, prev,
        { spawned: openChild?.id ?? null, spawn_skipped: openChild ? `existing unblock child ${openChild.id}` : "flood guard" });
      if (prev?.verdict !== "true") {
        this.audit("hub:proxy-watch", "proxy_flip_deferred", r.id, { spawned: openChild?.id ?? null, reason: openChild ? "existing unblock child" : "flood guard" });
      }
      return;
    }
    const ts = Date.now();
    const rootTitle = String(r.title ?? r.id).replace(/^(?:Unblock:\s*)+/, "");
    const atomLines = receiptLines.map((l) => `- ${l}`).join("\n");
    const created = await this.create(
      {
        type: "task",
        title: `Unblock: ${rootTitle.slice(0, 190)}`,
        session: "", // session-less spawn: the closer stamps it when they claim
        body_md: `Unblock duty for ${r.id} — "${rootTitle}" (auto-spawned by the hub proxy-watch, BR#3361).\n\nBlocked why: ${String(meta.blocked?.reason ?? "").trim() || "see parent"}.\nExit condition: ${cond}\n\nMACHINE PROXY — the hub evaluated the exit condition TRUE at ${new Date(ts).toISOString()} (receipts):\n${atomLines}\n\nThe predicate the card parked on has flipped. Do the terminal work the card promised: execute the exit condition (live re-verify first — this sweep is a trigger, not an authority), transition ${r.id} → in_progress with the resolution note, then close yourself done citing these receipts.\n\nContract: if the live state does NOT hold (the sweep mis-read), record findings via log_progress and close yourself done with the findings — do NOT respawn an unblock task, do not leave yourself open.`,
        roles: ["unblock"],
      },
      "hub:proxy-watch",
    );
    this.state.storage.sql.exec(
      `INSERT OR IGNORE INTO relations (src_id, relation, dst_id, created_ts) VALUES (?, 'child_of', ?, ?)`,
      created.id, r.id, ts,
    );
    meta.last_unblock_spawn = { at: ts, exit: cond.slice(0, 500) };
    this.stampProxyCheck(r.id, meta, now, "true", null, prev, { spawned: created.id });
    this.audit("hub:proxy-watch", "proxy_flip", r.id, { spawned: created.id, receipts: receiptLines });
    this.version(r.id, "hub:proxy-watch", "note", `machine proxy flipped TRUE — unblock duty ${created.id} auto-spawned (BR#3361)`, { spawned: created.id });
  }


  async eventsSince(since: number, limit: number) {
    // since=0 → the most recent window (newest first, returned oldest-first);
    // since>0 → incremental forward from the cursor.
    const rows = since > 0
      ? this.state.storage.sql.exec(
          `SELECT seq, ts, actor, op, artefact_id, detail FROM events WHERE seq > ? ORDER BY seq ASC LIMIT ?`,
          since, limit,
        ).toArray()
      : this.state.storage.sql.exec(
          `SELECT seq, ts, actor, op, artefact_id, detail FROM events WHERE seq > 0 ORDER BY seq DESC LIMIT ?`,
          limit,
        ).toArray().reverse();
    const events = rows.map((e: any) => ({ ...e, detail: JSON.parse(e.detail ?? "{}") }));
    return { events, last_seq: events.length ? events[events.length - 1].seq : since };
  }

  async board() {
    const tasks = this.state.storage.sql.exec(
      `SELECT id, type, title, status, owner, tags, roles, meta, body_md, status_ts, created_ts, updated_ts, project FROM artefacts
       WHERE type IN ('task','question') ORDER BY updated_ts DESC LIMIT 200`,
    ).toArray().map((t: any) => ({ ...t, meta: JSON.parse(t.meta ?? "{}"), tags: parseTags(t.tags), roles: parseTags(t.roles) }));
    // flat structure, relations only: child tasks carry part_of, parents get a rollup
    const links = this.state.storage.sql.exec(
      `SELECT src_id, dst_id FROM relations WHERE relation = 'child_of'`,
    ).toArray();
    const byId = new Map(tasks.map((t) => [t.id, t]));
    const parentOf = new Map(links.map((l: any) => [l.src_id, l.dst_id]));
    for (const t of tasks) {
      const parent = parentOf.get(t.id);
      if (parent) t.part_of = parent;
      t.children_open = 0;
      t.children_done = 0;
    }
    for (const l of links as any[]) {
      const parent = byId.get(l.dst_id);
      const child = byId.get(l.src_id);
      if (!parent || !child) continue;
      if (child.status === "done" || child.status === "superseded") parent.children_done++;
      else parent.children_open++;
    }
    // readiness projection (bulk): declared state + evidence maps + stacked bars
    const { analysisEv, reviewEv } = this.qualificationEvidence();
    for (const t of tasks) {
      const q = t.meta.qualification ?? {};
      const declared = q.state ?? (t.meta.qualified === true ? "qualified" : undefined);
      const bars: string[] = q.bars ?? [];
      const parent = t.part_of ? byId.get(t.part_of) : null;
      const pq = parent ? (parent.meta.qualification ?? {}) : {};
      const analysisOk = declared === "qualified"
        || analysisEv.has(t.id)
        || (parent && (pq.state === "qualified" || parent.meta.qualified === true || analysisEv.has(parent.id))) === true;
      const unmet = this.enforceableBars(bars).filter((b) => !(/review/.test(b) ? reviewEv : analysisEv).has(t.id));
      t.qualification = { state: declared ?? (analysisOk ? "qualified" : "open"), how: q.how, by: q.by, bars, unmet_bars: unmet, ready: analysisOk && unmet.length === 0 };
      // claimability projection — same semantics as orient's pool: question
      // tasks and operator gates are never dispatchable; role-tagged tasks
      // dispatch via their gateway; the rest needs qualification evidence.
      const tagsArr: string[] = t.tags ?? [];
      const roleTagged = (t.roles ?? []).some((x: string) => ["analysis", "review", "impl", "unblock"].includes(x));
      const isQ = t.type === "question";
      const gated = t.meta.operator_gated;
      const roleWorkReady = roleTagged && t.qualification.ready !== false ? true : roleTagged;
      t.is_claimable = t.status === "todo" && !isQ && !gated && (roleWorkReady || t.qualification.ready !== false);
      if (!t.is_claimable && t.status === "todo") {
        t.claim_reason = isQ
          ? "question — answered, not claimed (contribute via log_progress)"
          : gated
            ? `operator gated: ${gated} — a human clears the gate`
            : roleTagged ? "" : "needs qualification — a done analysis child, an accepted decision, or the publisher's declaration";
      }
    }
    const sessions = this.state.storage.sql.exec(
      `SELECT s.token_id, s.name, s.worktree, s.first_seen_ts, s.last_seen_ts, t.label
       FROM sessions s LEFT JOIN auth_tokens t ON t.id = s.token_id ORDER BY s.last_seen_ts DESC LIMIT 100`,
    ).toArray();
    // open question children: the DERIVED source for awaiting_ask (phase 4 —
    // the marker was a second source of truth that could drift)
    const openAskChildren = this.state.storage.sql.exec(
      `SELECT r.dst_id AS parent, c.id AS id, c.created_ts AS created_ts, c.meta AS cmeta
       FROM relations r JOIN artefacts c ON c.id = r.src_id
       WHERE r.relation = 'child_of' AND c.status IN ('todo','in_progress','blocked')
         AND c.type = 'question'
       ORDER BY c.created_ts DESC`,
    ).toArray();
    const askChildOf = new Map<string, any>();
    for (const c of openAskChildren as any[]) {
      if (!askChildOf.has(c.parent)) askChildOf.set(c.parent, c);
    }
    const progress = this.state.storage.sql.exec(
      `SELECT seq, ts, actor, artefact_id, detail FROM events
       WHERE op = 'progress' ORDER BY seq DESC LIMIT 120`,
    ).toArray().map((e: any) => ({ ...e, detail: JSON.parse(e.detail ?? "{}") }));
    const series = this.state.storage.sql.exec(
      `SELECT artefact_id, ts, actor, data FROM artefact_versions
       WHERE action = 'progress' ORDER BY seq DESC LIMIT 400`,
    ).toArray().map((v: any) => {
      const d = JSON.parse(v.data ?? "{}");
      return { artefact_id: v.artefact_id, ts: v.ts, actor: v.actor, ...d };
    });
    return { tasks, sessions, progress, series, agents: this.agentScores() };
  }

  /** Blocker rollup (BR#2645): cluster the blocked cards by machine root key
   *  (rollup.ts) and execute the plan — create ONE boosted ROOT BLOCKER task
   *  per qualifying cluster (≥3 members, no open root for the key), stamp the
   *  queued cards (meta.root_blocker + child_of → board tree + boost cascade).
   *  Idempotent: the plan only stamps cards whose pointer changed, so a re-run
   *  creates no duplicates. Roots close only by agent/human with receipts;
   *  done roots are never reused — a later cluster opens a fresh root. */
  private async rootBlockerRollup(now: number): Promise<{ created: string[]; stamped: number }> {
    const blockedRows = this.state.storage.sql.exec(
      `SELECT id, title, meta FROM artefacts WHERE type = 'task' AND status = 'blocked'`,
    ).toArray() as any[];
    const cards = blockedRows.map((r) => {
      const meta = JSON.parse(r.meta ?? "{}");
      return { id: r.id, title: r.title, blocked: meta.blocked ?? null, root_blocker: meta.root_blocker ?? null };
    });
    const rootRows = this.state.storage.sql.exec(
      `SELECT id, status, meta FROM artefacts WHERE type = 'task' AND tags LIKE ?`,
      `%"${ROOT_BLOCKER_TAG}"%`,
    ).toArray() as any[];
    const roots = rootRows.map((r) => ({ id: r.id, status: r.status, root_key: JSON.parse(r.meta ?? "{}").root_key ?? null }));
    const plan = planRootBlockers(cards, roots);
    const created: string[] = [];
    if (plan.creates.length || plan.stamps.length) {
      const keyToRoot = new Map<string, string>();
      for (const c of plan.creates) {
        try {
          const members = cards.filter((x) => c.members.includes(x.id));
          const res: any = await this.create(
            {
              type: "task",
              title: rootBlockerTitle(c.key, c.members.length),
              body_md: rootBlockerBody(c.key, members),
              tags: [ROOT_BLOCKER_TAG],
              // the sweep HAS analysed the cluster — the root is ready for pickup
              qualified: true,
              meta: { root_key: c.key },
            },
            "system:watchdog",
          );
          if (res?.id) { keyToRoot.set(c.key, res.id); created.push(res.id); }
          this.audit("system:watchdog", "root_blocker_created", res?.id ?? null, { key: c.key, members: c.members });
        } catch (e) {
          this.audit("system:watchdog", "sweep_error", `root_blocker:${c.key}`, { error: String((e as Error).message ?? e).slice(0, 300) });
        }
      }
      let stamped = 0;
      for (const s of plan.stamps) {
        try {
          const rootId = s.root ?? keyToRoot.get(s.root_key);
          if (!rootId) continue;
          const row = this.one(`SELECT meta FROM artefacts WHERE id = ?`, s.id);
          if (!row) continue;
          const meta = JSON.parse(row.meta ?? "{}");
          if (meta.root_blocker === rootId) continue; // stamp only when changed
          meta.root_blocker = rootId;
          this.state.storage.sql.exec(
            `UPDATE artefacts SET meta = ?, updated_ts = ? WHERE id = ?`,
            JSON.stringify(meta), now, s.id,
          );
          // child_of → board tree + boost cascade. Best-effort: the nesting
          // cap and relation limits can reject; the stamp alone still counts.
          const linked = this.one(
            `SELECT 1 AS x FROM relations WHERE src_id = ? AND relation = 'child_of' AND dst_id = ?`,
            s.id, rootId,
          );
          if (!linked) {
            try {
              await this.link({ src: s.id, relation: "child_of", dst: rootId }, "system:watchdog");
            } catch (e) {
              this.audit("system:watchdog", "rollup_link_rejected", s.id, { root: rootId, error: String((e as Error).message ?? e).slice(0, 200) });
            }
          }
          stamped++;
        } catch (e) {
          this.audit("system:watchdog", "sweep_error", s.id, { error: String((e as Error).message ?? e).slice(0, 300) });
        }
      }
      // boost the NEW roots — cascades to every linked open card (priority 0)
      for (const rootId of keyToRoot.values()) {
        try {
          await this.boost({ id: rootId, boost: true }, "system:watchdog");
        } catch (e) {
          this.audit("system:watchdog", "sweep_error", `boost:${rootId}`, { error: String((e as Error).message ?? e).slice(0, 300) });
        }
      }
      if (created.length || stamped) {
        this.audit("system:watchdog", "root_blocker_rollup", null, { created, stamped });
      }
      return { created, stamped };
    }
    return { created: [], stamped: 0 };
  }

  /** Behaviour signals per agent over the trailing 7-day window, scored via scoreAgent().
   *  Cached per-isolate (30s TTL) — it fans out to several table scans per call and
   *  runs on every board/orient/log_progress; uncached it eats the DO row-read quota. */
  private scoreCache: { at: number; rows: Array<{ label: string } & AgentSignals & ReturnType<typeof scoreAgent>> } | null = null;
  private agentScores(): Array<{ label: string } & AgentSignals & ReturnType<typeof scoreAgent>> {
    const now = Date.now();
    if (this.scoreCache && now - this.scoreCache.at < 30_000) return this.scoreCache.rows;
    const rows = this.computeAgentScores();
    this.scoreCache = { at: now, rows };
    return rows;
  }

  private computeAgentScores(): Array<{ label: string } & AgentSignals & ReturnType<typeof scoreAgent>> {
    // Scoring windows (BR#3226): positive behavioural signals accrue over a
    // 7-day window; watchdog penalties (abandonment, reassignment) are
    // point-in-time incidents that decay after 48h so a past incident does
    // not poison current behaviour scores (e.g. the 2026-10-22 outage era).
    const weekTs = Date.now() - 7 * 24 * 60 * 60_000;
    const recentTs = Date.now() - 48 * 60 * 60_000;
    const tokens = this.state.storage.sql.exec(
      `SELECT label, tags FROM auth_tokens WHERE revoked_ts IS NULL`,
    ).toArray() as any[];
    const signals = new Map<string, AgentSignals>();
    const sig = (label: string): AgentSignals => {
      let s = signals.get(label);
      if (!s) {
        s = { progress_count: 0, gauge_count: 0, thin_notes: 0, abandoned: 0, result_lost: 0, reassigned: 0, asks_received: 0, asks_answered_on_time: 0, artefacts_created: 0, verify_duty_backlog: 0 };
        signals.set(label, s);
      }
      return s;
    };
    for (const t of tokens) sig(t.label); // agents with no activity still get a row
    for (const p of this.state.storage.sql.exec(
      `SELECT actor, data FROM artefact_versions WHERE action = 'progress' AND ts >= ?`,
      weekTs,
    ).toArray() as any[]) {
      const s = sig(p.actor);
      const d = JSON.parse(p.data ?? "{}");
      s.progress_count++;
      if (d.completion_pct != null || d.confidence_pct != null || d.risk_pct != null) s.gauge_count++;
      if (String(d.note ?? "").trim().length < 10) s.thin_notes++;
    }
    // BR#3352: a watchdog release whose transition detail carries
    // result_class "completed_result_lost" is a delivery-channel incident
    // (the run happened, the report was lost) — it must not count as
    // abandonment. Every other watchdog transition still does.
    for (const r of this.state.storage.sql.exec(
      `SELECT a.owner AS owner, e.detail AS detail FROM events e JOIN artefacts a ON a.id = e.artefact_id
       WHERE e.op = 'transition' AND e.actor = 'system:watchdog' AND e.ts >= ?`,
      recentTs,
    ).toArray() as any[]) {
      const s = sig(r.owner || "unknown");
      let d: any = {};
      try { d = JSON.parse(r.detail ?? "{}"); } catch { d = {}; }
      if (d?.result_class === "completed_result_lost") s.result_lost++;
      else s.abandoned++;
    }
    for (const r of this.state.storage.sql.exec(
      `SELECT detail FROM events WHERE op = 'reassign' AND ts >= ?`, recentTs,
    ).toArray() as any[]) {
      const d = JSON.parse(r.detail ?? "{}");
      sig(d.prev_owner || "unknown").reassigned++;
    }
    for (const r of this.state.storage.sql.exec(
      `SELECT owner, COUNT(*) AS n FROM artefacts
       WHERE created_ts >= ? AND LENGTH(body_md) >= 200 AND owner != '' GROUP BY owner`,
      weekTs,
    ).toArray() as any[]) sig(r.owner).artefacts_created += r.n;
    for (const t of tokens) {
      const s = sig(t.label);
      const tags: string[] = parseTags(t.tags);
      const targets = ["any", t.label, ...tags.map((x: string) => `tag:${x}`)];
      const marks = targets.map(() => "?").join(",");
      s.asks_received = this.one(
        `SELECT COUNT(*) AS n FROM asks WHERE status IN ('open','answered') AND from_label != ?
         AND created_ts >= ? AND to_target IN (${marks})`, t.label, weekTs, ...targets,
      )?.n ?? 0;
      s.asks_answered_on_time = this.one(
        `SELECT COUNT(*) AS n FROM asks WHERE status = 'answered' AND answered_by = ? AND answered_ts IS NOT NULL
         AND answered_ts - created_ts <= ${30 * 60_000} AND created_ts >= ?`, t.label, weekTs,
      )?.n ?? 0;
      // verification duty backlog: role:review agents carry the pool's stalled
      // verify rounds — each one is an implementer parked in in_review.
      if (tags.includes("role:review")) {
        s.verify_duty_backlog = this.one(
          `SELECT COUNT(*) AS n FROM relations r JOIN artefacts c ON c.id = r.src_id JOIN artefacts p ON p.id = r.dst_id
           WHERE r.relation = 'child_of' AND c.type = 'task' AND c.status = 'todo' AND c.owner = ''
           AND c.roles LIKE '%"review"%' AND p.status = 'in_review'`,
        )?.n ?? 0;
      }
    }
    return [...signals.entries()]
      .filter(([label]) => !/^(system:|web$)/.test(label))
      .map(([label, s]) => ({ label, ...s, ...scoreAgent(s) }))
      .sort((a, b) => b.score - a.score);
  }

  private async getWithRelations(id: string) {
    const a = await this.get(id);
    const rel = await this.relations(id);
    return { ...a, relations: rel.relations };
  }

  async ensureSchema() {
    // NO early-return flag: this DO's isolate is long-lived, and a flag set
    // on first boot meant every migration added later NEVER ran on the warm
    // singleton — today's schema additions silently broke against production
    // while working on fresh local DBs. Everything here is idempotent by
    // construction (IF NOT EXISTS + guarded ALTERs); the per-fetch cost is a
    // few cheap statements.
    this.state.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS artefacts (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        body_md TEXT NOT NULL DEFAULT '',
        meta TEXT NOT NULL DEFAULT '{}',
        owner TEXT NOT NULL DEFAULT '',
        created_ts INTEGER NOT NULL,
        updated_ts INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS relations (
        src_id TEXT NOT NULL,
        relation TEXT NOT NULL,
        dst_id TEXT NOT NULL,
        created_ts INTEGER NOT NULL,
        PRIMARY KEY (src_id, relation, dst_id)
      );
      -- events: now a VIEW over ledger (migration below)
      CREATE VIRTUAL TABLE IF NOT EXISTS artefacts_fts USING fts5(
        title, body_md, content='artefacts', content_rowid='rowid'
      );
      CREATE TRIGGER IF NOT EXISTS artefacts_ai AFTER INSERT ON artefacts BEGIN
        INSERT INTO artefacts_fts(rowid, title, body_md) VALUES (new.rowid, new.title, new.body_md);
      END;
      CREATE TRIGGER IF NOT EXISTS artefacts_ad AFTER DELETE ON artefacts BEGIN
        INSERT INTO artefacts_fts(artefacts_fts, rowid, title, body_md)
          VALUES ('delete', old.rowid, old.title, old.body_md);
      END;
      CREATE TRIGGER IF NOT EXISTS artefacts_au AFTER UPDATE ON artefacts BEGIN
        INSERT INTO artefacts_fts(artefacts_fts, rowid, title, body_md)
          VALUES ('delete', old.rowid, old.title, old.body_md);
        INSERT INTO artefacts_fts(rowid, title, body_md) VALUES (new.rowid, new.title, new.body_md);
      END;
      CREATE TABLE IF NOT EXISTS auth_tokens (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL UNIQUE,
        hash TEXT NOT NULL UNIQUE,
        tags TEXT NOT NULL DEFAULT '[]',
        principal TEXT,
        transport TEXT NOT NULL DEFAULT 'mcp',
        created_ts INTEGER NOT NULL,
        last_seen_ts INTEGER,
        revoked_ts INTEGER
      );
      -- gateway → dispatched-agent attribution (BR#2455): stamped whenever a
      -- gateway-tagged token claims/progresses as an agent. Feeds Connect's
      -- "gateways with their agents" grouping; audit stays the full trail.
      CREATE TABLE IF NOT EXISTS gateway_agents (
        gateway TEXT NOT NULL,
        agent TEXT NOT NULL,
        last_seen_ts INTEGER NOT NULL,
        PRIMARY KEY (gateway, agent)
      );
      CREATE TABLE IF NOT EXISTS sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        token_id TEXT NOT NULL,
        name TEXT NOT NULL,
        first_seen_ts INTEGER NOT NULL,
        last_seen_ts INTEGER NOT NULL,
        UNIQUE (token_id, name)
      );
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS workspaces (
        slug TEXT PRIMARY KEY,
        owner TEXT NOT NULL,
        personal INTEGER NOT NULL DEFAULT 0,
        created_ts INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS workspace_members (
        ws TEXT NOT NULL,
        login TEXT NOT NULL,
        UNIQUE (ws, login)
      );
      CREATE TABLE IF NOT EXISTS ws_tokens (
        hash TEXT PRIMARY KEY,
        ws TEXT NOT NULL,
        created_ts INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS pairings (
        code TEXT PRIMARY KEY,
        device TEXT NOT NULL,
        type TEXT,
        principal TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        ws TEXT,
        label TEXT,
        tags TEXT,
        secret TEXT,
        created_ts INTEGER NOT NULL,
        approved_ts INTEGER,
        last_poll_ts INTEGER
      );
      CREATE TABLE IF NOT EXISTS embeddings (
        artefact_id TEXT PRIMARY KEY,
        vec BLOB NOT NULL,
        dim INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS provenance (
        -- PR provenance (BR#3287): sha → PR → task → verify-verdict → agent
        -- session. Board-side storage of record (decision BR#3291); this
        -- table is the DO-local index the lookup endpoint reads.
        repo TEXT NOT NULL,
        pr INTEGER NOT NULL,
        merge_sha TEXT NOT NULL,
        head_sha TEXT NOT NULL,
        task_id TEXT,
        verdict_id TEXT,
        session TEXT,
        signer TEXT NOT NULL,
        merged_at INTEGER NOT NULL,
        stamped_at INTEGER NOT NULL,
        PRIMARY KEY (repo, pr)
      );
      CREATE TABLE IF NOT EXISTS train_events (
        -- merge train ledger (BR#3516/BR#3517): every lane op is
        -- executor-fed and hub-decided, so the ledger is the only durable
        -- record of what the train did and why. seq orders the train's
        -- causal chain per lane; provenance links merge_sha back to the
        -- sha→PR→task→verdict→session chain above.
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        kind TEXT NOT NULL, -- merged | bounced | stopped | landed | queued
        repo TEXT NOT NULL,
        base TEXT NOT NULL,
        gateway TEXT,
        pr INTEGER,
        task_id TEXT,
        merge_sha TEXT,
        head_sha TEXT,
        detail TEXT -- JSON: reason, carry record, verdict citations
      );
      CREATE INDEX IF NOT EXISTS idx_train_events_lane ON train_events (repo, base, seq);
      -- artefact_versions: now a VIEW over ledger (migration below)
      CREATE TABLE IF NOT EXISTS asks (
        id TEXT PRIMARY KEY,
        from_label TEXT NOT NULL,
        to_target TEXT NOT NULL,
        question TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'open',
        answer TEXT,
        answered_by TEXT,
        created_ts INTEGER NOT NULL,
        answered_ts INTEGER
      );
    `);

    // additive columns for DBs created before these existed
    for (const ddl of [
      `ALTER TABLE decisions ADD COLUMN options TEXT`,
      `ALTER TABLE decisions ADD COLUMN urgency TEXT`,
      `ALTER TABLE decisions ADD COLUMN deadline_ts INTEGER`,
      `ALTER TABLE decisions ADD COLUMN asker TEXT`,
      `ALTER TABLE auth_tokens ADD COLUMN transport TEXT`,
      `ALTER TABLE artefacts ADD COLUMN status_ts INTEGER`,
      `ALTER TABLE artefacts ADD COLUMN tags TEXT`,
      `ALTER TABLE artefacts ADD COLUMN roles TEXT`,
      `ALTER TABLE embeddings ADD COLUMN dim INTEGER DEFAULT 0`,
      `ALTER TABLE asks ADD COLUMN artefact_id TEXT`,
      `ALTER TABLE artefacts ADD COLUMN project TEXT NOT NULL DEFAULT ''`,
      `ALTER TABLE artefacts ADD COLUMN created_by TEXT NOT NULL DEFAULT ''`,
      `ALTER TABLE pairings ADD COLUMN type TEXT`,
      `ALTER TABLE pairings ADD COLUMN principal TEXT`,
      `ALTER TABLE auth_tokens ADD COLUMN principal TEXT`,
      `ALTER TABLE sessions ADD COLUMN kind TEXT`,
      `ALTER TABLE sessions ADD COLUMN worktree TEXT`, // BR#3204: where the session's tree lives — board collision visibility
    ]) {
      try { this.state.storage.sql.exec(ddl); } catch { /* column exists */ }
    }

    // ---------- ledger v1: one append-only record (events + versions merged) ----------
    this.state.storage.sql.exec(`CREATE TABLE IF NOT EXISTS ledger (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      actor TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'signal',
      action TEXT NOT NULL,
      artefact_id TEXT,
      summary TEXT NOT NULL DEFAULT '',
      data TEXT NOT NULL DEFAULT '{}'
    )`);
    try {
      const migrated = this.one(`SELECT value FROM settings WHERE key = 'ledger_v1'`);
      if (!migrated) {
        const hasEvents = this.one(`SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'events'`);
        if (hasEvents) {
          this.state.storage.sql.exec(`ALTER TABLE events RENAME TO events_legacy`);
          this.state.storage.sql.exec(`INSERT INTO ledger (ts, actor, kind, action, artefact_id, summary, data)
            SELECT ts, actor, 'signal', op, artefact_id, '', detail FROM events_legacy`);
        }
        const hasVersions = this.one(`SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'artefact_versions'`);
        if (hasVersions) {
          this.state.storage.sql.exec(`ALTER TABLE artefact_versions RENAME TO versions_legacy`);
          this.state.storage.sql.exec(`INSERT INTO ledger (ts, actor, kind, action, artefact_id, summary, data)
            SELECT ts, actor, 'mutation', action, artefact_id, summary, data FROM versions_legacy`);
        }
        this.state.storage.sql.exec(`CREATE VIEW IF NOT EXISTS events AS
          SELECT seq, ts, actor, action AS op, artefact_id, data AS detail FROM ledger WHERE kind = 'signal'`);
        this.state.storage.sql.exec(`CREATE VIEW IF NOT EXISTS artefact_versions AS
          SELECT seq, ts, actor, action, artefact_id, summary, data FROM ledger WHERE kind = 'mutation'`);
        this.state.storage.sql.exec(`INSERT OR REPLACE INTO settings (key, value) VALUES ('ledger_v1', ?)`, String(Date.now()));
        this.audit("system:migration", "ledger_v1", null, { backfilled: !!(hasEvents || hasVersions) });
      } else {
        this.state.storage.sql.exec(`CREATE VIEW IF NOT EXISTS events AS
          SELECT seq, ts, actor, action AS op, artefact_id, data AS detail FROM ledger WHERE kind = 'signal'`);
        this.state.storage.sql.exec(`CREATE VIEW IF NOT EXISTS artefact_versions AS
          SELECT seq, ts, actor, action, artefact_id, summary, data FROM ledger WHERE kind = 'mutation'`);
      }
    } catch (e) {
      console.log("ledger migration:", String(e).slice(0, 200));
    }

    // sessions.kind backfill: gateway identity via the local token registry
    try {
      this.state.storage.sql.exec(
        `UPDATE sessions SET kind = 'gateway' WHERE kind IS NULL AND token_id IN
          (SELECT id FROM auth_tokens WHERE tags LIKE '%gateway%')`,
      );
    } catch { /* fresh db */ }

    // ---------- asks v2: open legacy asks become question nodes ----------
    try {
      if (!this.one(`SELECT value FROM settings WHERE key = 'asks_v2'`)) {
        const legacy = this.state.storage.sql.exec(
          `SELECT id, from_label, to_target, question, created_ts, artefact_id FROM asks WHERE status = 'open'`,
        ).toArray() as any[];
        let n = 0;
        for (const a of legacy) {
          const created = await this.create(
            {
              type: "question",
              title: String(a.question ?? "").slice(0, 200),
              body_md: String(a.question ?? ""),
              owner: "",
              meta: { ask: { to: a.to_target ?? "any", from: a.from_label ?? "agent", urgency: "normal", options: [], artefact_id: a.artefact_id || undefined, legacy_id: a.id } },
            },
            "system:migration",
          );
          if (a.artefact_id) {
            const subj = this.one(`SELECT id, meta FROM artefacts WHERE id = ?`, a.artefact_id);
            if (subj) {
              this.state.storage.sql.exec(
                `INSERT OR IGNORE INTO relations (src_id, relation, dst_id, created_ts) VALUES (?, 'child_of', ?, ?)`,
                created.id, a.artefact_id, Date.now(),
              );
              const sm = JSON.parse(subj.meta ?? "{}");
              if (sm.awaiting_ask?.ask_id === a.id) sm.awaiting_ask = { ...sm.awaiting_ask, ask_id: created.id };
              this.state.storage.sql.exec(`UPDATE artefacts SET meta = ? WHERE id = ?`, JSON.stringify(sm), a.artefact_id);
            }
          }
          this.state.storage.sql.exec(
            `UPDATE artefacts SET created_ts = ? WHERE id = ?`, Number(a.created_ts ?? Date.now()), created.id,
          );
          this.state.storage.sql.exec(`UPDATE asks SET status = 'migrated' WHERE id = ?`, a.id);
          this.audit("system:migration", "ask_migrated", a.artefact_id || null, { legacy: a.id, node: created.id });
          n++;
        }
        this.state.storage.sql.exec(`INSERT OR REPLACE INTO settings (key, value) VALUES ('asks_v2', ?)`, String(Date.now()));
        if (n) this.audit("system:migration", "asks_v2", null, { migrated: n });
      }
    } catch (e) {
      console.log("asks_v2 migration:", String(e).slice(0, 200));
    }


    // ---------- asks options backfill: no ask ships button-less ----------
    try {
      if (!this.one(`SELECT value FROM settings WHERE key = 'asks_options_v1'`)) {
        const nodes = this.state.storage.sql.exec(
          `SELECT id, title, body_md, meta FROM artefacts
           WHERE status NOT IN ('done','superseded') AND (type = 'question' OR (type = 'task' AND tags LIKE '%question%'))`,
        ).toArray() as any[];
        let n = 0;
        for (const node of nodes) {
          const m = JSON.parse(node.meta ?? "{}");
          // legacy-migrated asks: their content is prose — do NOT fabricate
          // options for them (the human answers free-text or reframes)
          if (m.ask?.legacy_id) continue;
          if (!m.ask || (Array.isArray(m.ask.options) && m.ask.options.length >= 2)) continue;
          const text = `${node.title ?? ""} ${node.body_md ?? ""}`;
          let opts: string[] = [];
          // enumerated questions carry their own answers: "(a) … (b) …"
          const parts = text.split(/\([A-Da-d1-4]\)\s+/).map((x: string) => x.trim());
          if (parts.length >= 3) {
            opts = parts.slice(1, 5).map((x: string) => {
              const cut = x.split(/\s+(?:vs\.?|or|—|--)\s+/i)[0];
              return cut.replace(/\s*\n\s*/g, " ").slice(0, 140).trim();
            }).filter((x: string) => x.length >= 2);
          }
          if (opts.length < 2) {
            opts = /GO\/NO-GO|GO or NO-GO|merge GO/i.test(text)
              ? ["GO — proceed as stated", "NO-GO — hold, reason in comment"]
              : ["Approved — proceed as stated", "Hold — reason in comment"];
          }
          m.ask = { ...(m.ask ?? {}), options: opts.slice(0, 4) };
          this.state.storage.sql.exec(`UPDATE artefacts SET meta = ? WHERE id = ?`, JSON.stringify(m), node.id);
          this.version(node.id, "system:migration", "update", `ask options backfilled (${m.ask.options.length})`, { options: m.ask.options });
          n++;
        }
        this.state.storage.sql.exec(`INSERT OR REPLACE INTO settings (key, value) VALUES ('asks_options_v1', ?)`, String(Date.now()));
        if (n) this.audit("system:migration", "ask_options_backfilled", null, { nodes: n });
      }
    } catch (e) {
      console.log("asks options backfill:", String(e).slice(0, 200));
    }


    // ---------- tags v1: canonical encoding (defence in depth, SOLID) ----------
    // The tags column historically holds JSON arrays, bare strings and comma
    // lists — parseTags() reads them all, but every SQL tag filter guessed one
    // encoding and silently missed the others. Re-encode EVERYTHING through
    // parseTags (artefacts + auth_tokens); canonical rows write canonical
    // JSON. Reads stay parseTags(); tag SQL filters are now correct forever.
    try {
      if (!this.one(`SELECT value FROM settings WHERE key = 'tags_v1'`)) {
        let fixed = 0;
        for (const r of this.state.storage.sql.exec(`SELECT id, tags FROM artefacts`).toArray() as any[]) {
          const canonical = JSON.stringify(parseTags(r.tags));
          if (canonical !== String(r.tags ?? "")) {
            this.state.storage.sql.exec(`UPDATE artefacts SET tags = ? WHERE id = ?`, canonical, r.id);
            fixed++;
          }
        }
        for (const r of this.state.storage.sql.exec(`SELECT id, tags FROM auth_tokens`).toArray() as any[]) {
          const canonical = JSON.stringify(parseTags(r.tags));
          if (canonical !== String(r.tags ?? "")) {
            this.state.storage.sql.exec(`UPDATE auth_tokens SET tags = ? WHERE id = ?`, canonical, r.id);
            fixed++;
          }
        }
        for (const r of this.state.storage.sql.exec(`SELECT token_id, name, kind FROM sessions WHERE kind IS NULL OR kind = ''`).toArray() as any[]) {
          const tok = this.one(`SELECT tags FROM auth_tokens WHERE id = ?`, r.token_id);
          if (tok && parseTags(tok.tags).includes("gateway")) {
            this.state.storage.sql.exec(`UPDATE sessions SET kind = 'gateway' WHERE token_id = ? AND name = ?`, r.token_id, r.name);
            fixed++;
          }
        }
        this.state.storage.sql.exec(`INSERT OR REPLACE INTO settings (key, value) VALUES ('tags_v1', ?)`, String(Date.now()));
        this.audit("system:migration", "tags_v1", null, { canonicalized: fixed });
      }
    } catch (e) {
      console.log("tags_v1 migration:", String(e).slice(0, 200));
    }

    // ---------- roles_v1: system semantics leave the tag namespace (BR#2983) ----------
    // Tags become 100% inert user labels. Three system meanings move out:
    //   role:* tags      → the roles column (bare names: ["review"])
    //   "question" tag   → type = 'question' (asks v2 nodes)
    //   "attempted" tag  → meta.attempt only (backfilled where missing)
    // The per-row transform is splitSystemTags() in core.ts — unit-tested
    // against every legacy encoding. Idempotent (settings key).
    try {
      if (!this.one(`SELECT value FROM settings WHERE key = 'roles_v1'`)) {
        let roleRows = 0, questionRows = 0, attemptRows = 0;
        for (const r of this.state.storage.sql.exec(`SELECT id, type, tags, meta, updated_ts FROM artefacts`).toArray() as any[]) {
          const tags: string[] = parseTags(r.tags);
          if (!tags.length) continue;
          const meta = JSON.parse(r.meta ?? "{}");
          const out = splitSystemTags(String(r.type ?? ""), tags, meta, Number(r.updated_ts ?? Date.now()));
          if (!out.changed) continue;
          this.state.storage.sql.exec(
            `UPDATE artefacts SET type = ?, tags = ?, roles = ?, meta = ? WHERE id = ?`,
            out.type, out.tags.length ? JSON.stringify(out.tags) : null,
            out.roles.length ? JSON.stringify(out.roles) : null,
            JSON.stringify(out.meta), r.id,
          );
          if (out.roles.length) roleRows++;
          if (out.type !== r.type) questionRows++;
          if (tags.includes("attempted")) attemptRows++;
        }
        this.state.storage.sql.exec(`INSERT OR REPLACE INTO settings (key, value) VALUES ('roles_v1', ?)`, String(Date.now()));
        this.audit("system:migration", "roles_v1", null, { role_rows: roleRows, question_rows: questionRows, attempt_rows: attemptRows });
      }
    } catch (e) {
      console.log("roles_v1 migration:", String(e).slice(0, 200));
    }

    // work enters as UNCLAIMED todo — release currently-todo tasks from their creators
    const projectName = this.settingsMap().project_name || "superpositional";
    this.state.storage.sql.exec(
      `UPDATE artefacts SET project = ? WHERE project = '' AND type = 'task'`, projectName,
    );
    this.state.storage.sql.exec(`UPDATE artefacts SET owner = '' WHERE type = 'task' AND status = 'todo' AND owner != ''`);
  }

  async fetch(request: Request): Promise<Response> {
    await this.ensureSchema();
    // alarm health: null = not scheduled; a timestamp far in the PAST = a stale
    // alarm the runtime dropped without invoking (observed live: getAlarm stuck
    // 42h in the past, so this arm-guard never re-armed and the watchdog went
    // silent for a day). Either way, arm a fresh tick.
    const alarmAt = await this.state.storage.getAlarm();
    if (alarmAt === null || alarmAt < Date.now()) {
      await this.state.storage.setAlarm(Date.now() + 15_000);
    }
    const url = new URL(request.url);

    // realtime: hibernating WS fanout of audit events
    if (url.pathname === "/ws") return this.handleWs(request);

    // machine-plane self-rename: the bearer token renames its own label.
    // The runner sends its hostname at pair/start and the pair page pre-fills
    // the label from it — but if the approver overrode the label with a
    // gateway name, the agent can fix its own identity without re-pairing.
    // Same write-law as mint (BR#2455): charset, uniqueness, and the gw-*
    // class boundary — a token can never rename across the class line.
    if (url.pathname === "/token.self_revoke") {
      const body: any = await request.json();
      let identity;
      try {
        identity = await this.identify(String(body.bearer ?? ""));
      } catch {
        // unknown or already-revoked: the requested end-state already holds
        return this.json({ ok: true, revoked: null });
      }
      this.state.storage.sql.exec(`UPDATE auth_tokens SET revoked_ts = ? WHERE id = ?`, Date.now(), identity.token_id);
      this.audit(identity.label, "self_revoke", identity.token_id, {});
      return this.json({ ok: true, revoked: identity.label });
    }
    if (url.pathname === "/token.rename") {
      const body: any = await request.json();
      const identity = await this.identify(String(body.bearer ?? ""));
      const newLabel = String(body.label ?? "").trim();
      if (!/^[a-zA-Z0-9._\/-]{2,40}$/.test(newLabel)) throw new Error("label must be 2-40 chars [a-zA-Z0-9._-]");
      const old = this.one(`SELECT label, tags FROM auth_tokens WHERE id = ?`, identity.token_id);
      if (!old) throw new Error("auth token not found");
      if (newLabel !== old.label) {
        if (this.one(`SELECT id FROM auth_tokens WHERE label = ?`, newLabel)) throw new Error(`label '${newLabel}' already exists`);
      }
      this.state.storage.sql.exec(
        `UPDATE auth_tokens SET label = ? WHERE id = ?`,
        newLabel, identity.token_id,
      );
      // tasks owned by the old label are NOT reassigned — the agent can
      // release-and-re-claim them, which is the normal flow. But audit it.
      this.audit(identity.label, "rename", null, { from: old.label, to: newLabel });
      return this.json({ ok: true, from: old.label, to: newLabel });
    }

    // human-plane GET mirror — the same error contract as the POST arm: a
    // rejected read returns 400 with the message, never a naked 500 (the GET
    // arm predates the try/catch; metrics.throughput's param validation was
    // the first GET that could throw on user input and exposed the gap)
    if (request.method === "GET") {
      try {
        switch (url.pathname) {
          case "/artefacts": return this.json(await this.list({ type: url.searchParams.get("type") ?? undefined, status: url.searchParams.get("status") ?? undefined, tag: url.searchParams.get("tag") ?? undefined, limit: url.searchParams.get("limit") ?? undefined }));
          case "/artefact": return this.json(await this.getWithRelations(String(url.searchParams.get("id"))));
          case "/search": return this.json(await this.search({ q: url.searchParams.get("q") ?? "", type: url.searchParams.get("type") ?? undefined, limit: url.searchParams.get("limit") ?? undefined }));
          case "/events": return this.json(await this.eventsSince(Number(url.searchParams.get("since") ?? 0), Math.min(Number(url.searchParams.get("limit") ?? 100), 500)));
          case "/board": return this.json(await this.board());
          case "/stats": return this.json(await this.stats());
          case "/metrics.throughput": return this.json(await this.metricsThroughput(url.searchParams));
          case "/provenance": { const b = await this.provenanceLookup(url.searchParams); return b ? this.json(b) : this.json({ error: "no bridge provenance for this sha" }, 404); }
          case "/history": return this.json(await this.getHistory(String(url.searchParams.get("id")), Math.min(Number(url.searchParams.get("limit") ?? 100), 200)));
          case "/ask": { const a = await this.askGet(String(url.searchParams.get("id"))); return a ? this.json(a) : this.json({ error: "no such ask" }, 404); }
          case "/train": return this.json(await this.trainStatus({ repo: url.searchParams.get("repo") ?? "" }));
        }
      } catch (e) {
        return this.json({ error: String((e as Error).message ?? e) }, 400);
      }
    }

    const op = url.pathname.slice(1);
    let body: any = {};
    if (request.method === "POST") body = await request.json();
    const isAdmin = request.headers.get("x-kb-admin") === "1";
    const actor = String(body.actor ?? "mcp");

    try {
      switch (op) {
        case "create": return this.json(await this.create(body, actor));
        case "boost": return this.json(await this.boost(body, actor));
        case "get": return this.json(await this.get(String(body.id)));
        case "list": return this.json(await this.list(body));
        case "search": return this.json(await this.search(body));
        case "provenance": { const rec = await this.provenanceBySha(parseProvenanceSha(new URLSearchParams({ sha: String((body as any)?.sha ?? "") }))); return rec ? this.json(rec) : this.json({ error: "no bridge provenance for this sha", sha: String((body as any)?.sha ?? "") }, 404); }
        case "related": return this.json(await this.related(String(body.id), Number(body.limit ?? 10)));
        case "update": return this.json(await this.update(body, actor));
        case "transition": return this.json(await this.transition(body, actor));
        case "link": return this.json(await this.link(body, actor));
        case "relations": return this.json(await this.relations(String(body.id)));
        case "stats": return this.json(await this.stats());
        case "get_history": return this.json(await this.getHistory(String(body.id ?? ""), Number(body.limit ?? 100)));
        // ---- merge train (BR#3516/BR#3517): executor-fed facts, hub decides ----
        case "train.lease": return this.json(await this.trainLease(body, actor));
        case "train.event": return this.json(await this.trainEvent(body, actor));
        case "train.ci": return this.json(await this.trainCi(body, actor));
        case "train.status": return this.json(await this.trainStatus(body));
        case "train.history": return this.json(await this.trainHistory(body));
        case "train.lane": return this.json(await this.laneEnsure(String(body.repo ?? ""), String(body.base ?? "main"), actor, body.spec));
        // ---- machine-plane identity + sessions + asks ----
        case "auth.identify": return this.json(await this.identify(String(body.bearer ?? "")));
        case "agent.provision": return this.json(await this.agentProvision(body, actor));
        case "self.provision": return this.json(await this.selfProvision(body, actor));
        case "agents.list": return this.json(await this.listAgents());
        case "session.touch": return this.json(await this.sessionTouch(body));
        case "ask.create": return this.json(await this.askCreate(body, actor));
        case "ask.inbox": return this.json(await this.askInbox(body));
        case "ask.answer": return this.json(await this.askAnswer(body, actor));
        case "ask.get": return this.json(await this.askGet(String(body.id ?? "")));
        case "purge_smoke": return this.json(await this.purgeSmoke(body));
        case "ask.reframe": return this.json(await this.askReframe(body, actor));
        case "orient": return this.json(await this.orient(body));
        case "progress.log": return this.json(await this.progressLog(body, actor));
        case "session.alive": {
          const row = this.one(`SELECT id, meta FROM artefacts WHERE id = ? AND type = 'task' AND status = 'in_progress'`, String(body.id ?? ""));
          if (!row) return this.json({ ok: false, error: "task not in progress" });
          const meta = JSON.parse(row.meta ?? "{}");
          meta.session_alive_ts = Date.now();
          this.state.storage.sql.exec(`UPDATE artefacts SET meta = ? WHERE id = ?`, JSON.stringify(meta), row.id);
          return this.json({ ok: true });
        }
        case "settings.public": return this.json({ settings: this.publicSettings() });
        case "bootstrap": {
          const m = this.settingsMap();
          return this.json({
            project_name: m.project_name || "Superpositional",
            instructions: composeBootstrap(m.project_name || "Superpositional", m.board ?? DEFAULT_BOARD),
          });
        }
        // ---- workspace registry (global DO; human plane, owner-checked) ----
        case "ws.seed": return this.json(await this.wsSeed(body.logins ?? []));
        case "ws.list": return this.json(await this.wsList(String(body.login)));
        case "ws.create": return this.json(await this.wsCreate(body, String(body.login)));
        case "ws.join": return this.json(await this.wsJoin(body, String(body.login)));
        case "ws.members": return this.json(await this.wsMembers(body, String(body.login)));
        case "ws.token_register": return this.json(await this.wsTokenRegister(body));
        case "ws.token_lookup": return this.json(await this.wsTokenLookup(body));
        case "ws.pair.start": return this.json(await this.wsPairStart(body));
        case "ws.pair.get": return this.json(await this.wsPairGet(body));
        case "ws.pair.approve": return this.json(await this.wsPairApprove(body));
        case "ws.pair.poll": return this.json(await this.wsPairPoll(body));
        // ---- admin (human plane only; worker sets x-kb-admin after session auth) ----
        case "admin.mint":
        case "admin.list_tokens":
        case "admin.revoke":
        case "admin.token_tags":
        case "admin.settings_get":
        case "admin.settings_set":
        case "admin.unblock_proxy_sweep":
          if (!isAdmin) return this.json({ error: "admin only" }, 403);
          if (op === "admin.mint") return this.json(await this.tokenMint(body));
          if (op === "admin.list_tokens") return this.json(await this.tokenList());
          if (op === "admin.revoke") return this.json(await this.tokenRevoke(body));
          if (op === "admin.token_tags") return this.json(await this.tokenTags(body));
          if (op === "admin.settings_get") return this.json(await this.settingsGet());
          if (op === "admin.unblock_proxy_sweep") {
            // drill/liveness path for the unblock-proxy watch (BR#3361a):
            // per-card pacing + caps still apply; pass now=<future epoch ms>
            // to bypass the cadence window and run immediately.
            await this.unblockProxySweep(Number(body.now ?? Date.now()));
            const last = this.one(`SELECT value FROM settings WHERE key = 'unblock_proxy_last_ts'`);
            return this.json({ ok: true, last_sweep_ts: Number(last?.value ?? 0) });
          }
          // admin.stop_line_sweep / admin.merge_queue_sweep /
          // admin.provenance_sweep / admin.closure_audit_sweep DELETED with
          // the sweeps themselves (BR#3516 §8): the hub holds no VCS
          // credentials; the executor runs the train, the hub watches leases.
          return this.json(await this.settingsSet(body));
        default: return this.json({ error: `unknown op ${op}` }, 404);
      }
    } catch (e) {
      return this.json({ error: String((e as Error).message ?? e) }, 400);
    }
  }

  // ---------- ops ----------

  private async create(body: any, actor: string) {
    let type = body.type as ArtefactType;
    if (!isArtefactType(type)) throw new Error(`unknown artefact type '${type}' (valid: ${ARTEFACT_TYPES.join(", ")})`);
    const title = String(body.title ?? "");
    let bodyMd = String(body.body_md ?? "");
    const limitErr = checkLimits(title, bodyMd, body.meta);
    if (limitErr) throw new Error(limitErr);

    const seq = (await this.nextSeq(type));
    const id = formatId(seq);
    const ts = Date.now();
    const status = INITIAL_STATUS[type];
    const tags = sanitizeTags(body.tags);
    // roles: the machine's dispatch/gating lanes — structural, NEVER tags
    // (tags are inert user labels; a tag can't change system behaviour)
    const rolesIn = parseRolesInput(body.roles);
    if (rolesIn.ok === false) throw new Error(rolesIn.error);
    const roles = rolesIn.roles;
    const session = await this.resolveSession(body, String(body.token_id ?? ""));
    // project: explicit override or the deployment's project; tasks enter UNCLAIMED (owner = pool)
    const project = String(body.project ?? "").trim() || this.settingsMap().project_name || "superpositional";
    // owner = claimant, on tasks only (phase 4). Other types record their human
    // actor in meta (proposed_by / ask.from) — one field, one meaning.
    let owner = type === "task" ? String(body.owner ?? "").trim() : "";
    if (type !== "task") {
      const pm = (body.meta ?? {}) as any;
      if (type === "decision" && !pm.proposed_by) pm.proposed_by = actor;
    }
    // qualifications stack: a publisher may declare self-analyzed readiness AND request
    // further confirmation bars (await: ["review"]) before the task goes ready
    const createMeta: any = { ...(body.meta ?? {}) };
    // an ask node REQUIRES options (the human answers by clicking) — enforced
    // here, not just in ask.create, so every door is covered
    if (createMeta.ask && (type === "task" || type === "question")) {
      const opts = Array.isArray(createMeta.ask.options) ? createMeta.ask.options.filter(Boolean) : [];
      if (opts.length < 2) throw new Error("asks require 2-8 answer options — give the human one-click answers (meta.ask.options)");
      if (!String(body.title ?? "").trimEnd().endsWith("?")) throw new Error("phrase the ask as an answerable question ending in '?' — e.g. 'Do you want to merge PR #84 into main?'");
    }
    // classification is structural (phase 3): legacy meta.kind maps to
    // type ("question"), roles (analysis/review) or a plain tag (research) —
    // stored meta never carries kind again
    if (createMeta.kind !== undefined) {
      const k = String(createMeta.kind);
      const kindType = (KIND_TYPE as Record<string, string | undefined>)[k];
      if (kindType && type === "task") type = kindType as ArtefactType;
      const kindRole = (KIND_ROLE as Record<string, string | undefined>)[k];
      if (kindRole && !roles.includes(kindRole as any)) roles.push(kindRole as any);
      const kindTag = (KIND_TAG as Record<string, string | undefined>)[k];
      if (kindTag && !tags.includes(kindTag)) tags.push(kindTag);
      delete createMeta.kind;
    }

    if (type === "task" && (body.qualified === true || (Array.isArray(body.await) && body.await.length))) {
      createMeta.qualification = {
        state: body.qualified === true ? "qualified" : "open",
        how: body.qualified === true ? "self-analyzed" : "open",
        by: actor, ts,
        bars: Array.isArray(body.await) ? body.await.map(String) : [],
      };
    }
    // VERIFY-VERDICT DEDUP (For Me flood fix): verify sessions propose a decision
    // per round — identical findings ("unchanged since round N") presented as
    // fresh decisions buried the human inbox (45 bounce-cards in 4h). Rule:
    // a verdict identical to the last PROPOSED verdict for the same target is
    // applied directly, never proposed. Same verdict + round>=3 → the task
    // BLOCKS for human intervention (the loop is stalled, that's a blocker
    // not a decision). Changed verdict or changed receipts still propose.
    if (type === "decision" && createMeta.decision_class === "verify-verdict") {
      const target = String(createMeta.task ?? createMeta.verify_target ?? "").trim();
      const verdict = String(createMeta.verdict ?? "").toLowerCase();
      if (target && verdict) {
        const prev = this.one(
          `SELECT id, meta FROM artefacts WHERE type = 'decision' AND status = 'proposed'
           AND json_extract(meta, '$.decision_class') = 'verify-verdict'
           AND (json_extract(meta, '$.task') = ? OR json_extract(meta, '$.verify_target') = ?)
           ORDER BY created_ts DESC LIMIT 1`,
          target, target,
        );
        // receipts fingerprint: any meta keys other than bookkeeping — identical
        // when the verifier found the same world state
        const fp = (m: any) => JSON.stringify(Object.entries(m ?? {})
          .filter(([k]) => !["decision_class", "task", "verify_target", "verdict", "session", "round"].includes(k))
          .sort(([a], [b]) => a.localeCompare(b)));
        const same = prev && String((JSON.parse(prev.meta ?? "{}") as any).verdict ?? "").toLowerCase() === verdict
          && fp(createMeta) === fp(JSON.parse(prev.meta ?? "{}"));
        if (same) {
          const trow = this.one(`SELECT id, status, meta FROM artefacts WHERE id = ?`, target);
          if (trow) {
            const tm = JSON.parse(trow.meta ?? "{}");
            const round = Number(createMeta.round ?? tm.verify_round ?? 0) + 1;
            tm.verify_round = round;
            const prevGauges = tm.last_progress ?? {};
            tm.last_progress = {
              note: `verify round ${round}: verdict ${verdict} UNCHANGED — auto-applied, no new decision card`, sentiment: "neutral", actor, ts: Date.now(),
              completion_pct: prevGauges.completion_pct, confidence_pct: prevGauges.confidence_pct,
              risk_pct: prevGauges.risk_pct, context_pct: prevGauges.context_pct,
            };
            const alreadyRight = verdict === "bounce" ? trow.status === "in_progress" : trow.status === "done";
            if (!alreadyRight) {
              // 3 identical rounds = the loop is stalled; park it for a human.
              // BR#3578: the human leg is an ACTIVE ask (For Me, one click),
              // not prose buried on the card.
              if (round >= 3) {
                const stallAsk = await this.askCreate({
                  to: "ray",
                  question: `Verify loop stalled on ${trow.id} (${round} identical ${verdict} rounds) — cancel the loop or keep it parked?`,
                  reason: "the verifier keeps proposing the identical verdict; auto-apply made no progress — the loop needs a human ruling",
                  options: ["CANCEL — transition the loop to todo for re-scoping", "KEEP PARKED — I'll clear the blocker myself", "SUPERSEDE — drop the stalled round"],
                  details: `Verify loop stalled: ${round} rounds with identical verdict (${verdict}), each auto-applied with no progress. Read the verify history on ${trow.id} before answering.`,
                  artefact_id: trow.id,
                }, "system:verifier").catch(() => null);
                if (stallAsk?.task_status !== "blocked") {
                  await this.transition({
                    id: trow.id, to: "blocked",
                    note: `verify loop stalled — ${round} rounds with identical verdict (${verdict}); auto-applied each time, no progress. Needs human intervention.`,
                    unblock_condition: "human: read the verify history on this card; either clear the blocker the verifier keeps naming, or cancel the loop (transition todo and address the task differently)",
                    ...(stallAsk ? { await_event: { event: "ask", ask_id: stallAsk.id } } : {}),
                  }, "system:verifier");
                }
              } else {
                await this.transition({
                  id: trow.id, to: verdict === "bounce" ? "in_progress" : "done",
                  note: `verify round ${round}: identical verdict (${verdict}) — auto-applied (For Me flood fix; no decision card)`,
                }, "system:verifier");
              }
            } else {
              this.state.storage.sql.exec(`UPDATE artefacts SET meta = ?, updated_ts = ? WHERE id = ?`, JSON.stringify(tm), Date.now(), trow.id);
            }
            this.audit("system:verifier", "verdict_deduped", id, { target, verdict, round });
            return { id, deduped: true, target, round, note: "identical verdict auto-applied — no decision card created" };
          }
        }
      }
    }
    // verify-verdict cards land in the human inbox (For you) — prepend the
    // plain-English ask (what accepting does, why a human must do it) so the
    // card is self-describing everywhere it renders: popover, notification
    // snippet, MCP reads. After the dedup gate above: only real cards.
    if (type === "decision" && createMeta.decision_class === "verify-verdict") {
      bodyMd = `${verifyVerdictStatement(createMeta)}\n\n${bodyMd.trim()}`.trim();
    }
    this.state.storage.sql.exec(
      `INSERT INTO artefacts (id, type, title, status, body_md, meta, owner, created_ts, updated_ts, tags, roles, status_ts, project, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, type, title, status, bodyMd, JSON.stringify({ ...createMeta, session }), owner, ts, ts,
      tags ? JSON.stringify(tags) : null, roles.length ? JSON.stringify(roles) : null, ts, project, actor,
    );
    if (!bodyMd.trim() && (type === "task" || type === "goal")) {
      bodyMd = scaffoldBody(title, owner || actor);
    }
    this.audit(actor, "create", id, { type, title });
    this.version(id, actor, "create", title, { type, title, body_md: bodyMd, tags: tags ?? [], roles });
    // ONE ACTIONABLE VERDICT PER TARGET (BR#3457): a fresh verify-verdict for
    // a target sweeps still-proposed older rounds of the same verify effort —
    // otherwise accepting the latest resurfaces an older round as the new
    // "latest" and the For Me card regrows (the dedup gate above only covered
    // identical repeats; this covers changed verdicts / changed receipts).
    if (type === "decision" && createMeta.decision_class === "verify-verdict") {
      const target = String(createMeta.task ?? createMeta.verify_target ?? "").trim();
      if (target) await this.supersedeStaleVerdicts(target, id, `superseded by ${id} — newer verdict for same target`);
    }
    await this.embedArtefact(id, title, bodyMd);
    // GitHub auto-enrichment was DELETED with the hub's GH_TOKEN paths
    // (BR#3516 §1: the hub holds no VCS credentials — enrichment is an
    // executor/agent concern, worker-local creds defended by doctor).
    if (type === "progress") await this.progressHeartbeat(body.meta, title, actor);
    return { id, type, status };
  }

  /** BR#3457 — ONE ACTIONABLE VERDICT PER TARGET, EVER. A verify-verdict
   *  taking over a target supersedes every OTHER still-proposed verify-verdict
   *  for that target: older rounds of the same verify effort, and create-race
   *  stragglers. BR#1782's dedup covered identical repeats at create; this
   *  covers "a newer verdict exists" — without it, accepting the latest
   *  resurfaces an older round as the new "latest" and the For Me card
   *  regrows as if the human's click did nothing. All sweep transitions act
   *  as "system:verdictsweep" so the act-time prong (doTransition) never
   *  cascades onto the takeover verdict itself. */
  private async supersedeStaleVerdicts(target: string, exceptId: string, reason: string): Promise<void> {
    const stale = this.state.storage.sql.exec(
      `SELECT id FROM artefacts WHERE type = 'decision' AND status = 'proposed'
       AND json_extract(meta, '$.decision_class') = 'verify-verdict'
       AND (json_extract(meta, '$.task') = ? OR json_extract(meta, '$.verify_target') = ?)
       AND id != ?`,
      target, target, exceptId,
    ).toArray() as any[];
    for (const s of stale) {
      try {
        await this.transition({ id: s.id, to: "superseded", note: reason, replacement_id: exceptId }, "system:verdictsweep");
        this.audit("system:verdictsweep", "verdict_superseded", s.id, { target, by: exceptId });
      } catch (e) {
        // one refused sweep never blocks the takeover — the gate's refusal is
        // observability (the card simply stays until the next prong fires)
        this.audit("system:verdictsweep", "verdict_sweep_failed", s.id, { target, by: exceptId, error: String((e as Error).message ?? e).slice(0, 300) });
      }
    }
  }

  /** A progress artefact (meta.task → task id) doubles as a heartbeat on that task:
   *  auto-starts todo tasks, re-claims watchdog-abandoned ones, and bumps last_progress.
   *  Agents post updates as progress logs instead of calling log_progress on the task —
   *  without this, the task card never moves. */
  private async progressHeartbeat(metaObj: any, title: string, actor: string) {
    const raw = String(metaObj?.task ?? "").trim();
    if (!raw) return;
    const candidates = [raw, raw.replace(/^#/, "BR#"), `BR#${raw.replace(/^#/, "")}`];
    const t = candidates
      .map((c) => this.one(`SELECT id, type, status, meta, tags, roles FROM artefacts WHERE id = ? AND type IN ('task','question')`, c))
      .find(Boolean);
    if (!t) return;
    const tmeta = JSON.parse(t.meta ?? "{}");
    const tTags: string[] = parseTags(t.tags);
    const tRoles: string[] = parseTags(t.roles);
    const isQualifier = tRoles.includes("analysis") || tRoles.includes("review") || tRoles.includes("unblock");
    if (t.status === "blocked" && (tmeta.blocked?.reason ?? "").startsWith("abandoned")) {
      await this.transition({ id: t.id, to: "in_progress", note: "re-claimed — progress artefact logged" }, actor);
      delete tmeta.blocked;
    } else if (t.status === "todo") {
      // pickup gate applies: only qualified work (or qualifier roles) auto-starts.
      // Questions are never auto-started — contributions don't claim.
      const q = isQualifier ? { ok: true } : this.qualifyCheck(t, "analysis");
      if (q.ok && t.type !== "question") await this.transition({ id: t.id, to: "in_progress", note: "started — progress artefact logged" }, actor);
    }
    const prevGauges = tmeta.last_progress ?? {};
    tmeta.last_progress = {
      note: title.slice(0, 200), sentiment: "neutral", actor, ts: Date.now(), session: tmeta.session,
      completion_pct: prevGauges.completion_pct, confidence_pct: prevGauges.confidence_pct,
      risk_pct: prevGauges.risk_pct, context_pct: prevGauges.context_pct,
    };
    delete tmeta.grace_until; // an artefact heartbeat means the agent is active — grace over
    this.state.storage.sql.exec(
      `UPDATE artefacts SET meta = ?, updated_ts = ? WHERE id = ?`,
      JSON.stringify(tmeta), Date.now(), t.id,
    );
    this.version(t.id, actor, "progress", title.slice(0, 500), { note: title.slice(0, 200) });
    this.audit(actor, "progress", t.id, { note: title.slice(0, 200), via: "progress_artefact" });
  }

  /** Human boost: priority 0 in the pickup ranking, above unblock duty.
   *  Cascades to all TRANSITIVE OPEN children (todo/blocked/in_progress) —
   *  a task cannot complete while its children are open, so the dependency
   *  set IS the children. Audited per task; boost ts orders multiple boosts. */
  private async boost(body: any, actor: string) {
    const id = String(body.id ?? "");
    const on = body.boost !== false;
    const row = this.one(`SELECT id, type FROM artefacts WHERE id = ?`, id);
    if (!row) throw new Error(`no such artefact: ${id}`);
    if (row.type !== "task") throw new Error(`boost applies to tasks, not ${row.type}`);
    const boosted: string[] = [];
    const queue = [id];
    const seen = new Set<string>([id]);
    while (queue.length) {
      const tid = queue.shift()!;
      const t = this.one(`SELECT id, status, meta FROM artefacts WHERE id = ?`, tid);
      if (!t || t.status === "done" || t.status === "superseded") continue;
      const meta = JSON.parse(t.meta ?? "{}");
      if (on) meta.boosted = Date.now();
      else delete meta.boosted;
      this.state.storage.sql.exec(
        `UPDATE artefacts SET meta = ?, updated_ts = ? WHERE id = ?`,
        JSON.stringify(meta), Date.now(), t.id,
      );
      this.audit(actor, on ? "boost" : "unboost", t.id, { root: id });
      this.version(t.id, actor, "update", on ? `boosted (priority 0, via ${id})` : `boost removed (via ${id})`, {});
      boosted.push(t.id);
      for (const c of this.state.storage.sql.exec(
        `SELECT c.id AS id FROM relations r JOIN artefacts c ON c.id = r.src_id
         WHERE r.relation = 'child_of' AND r.dst_id = ?`, t.id,
      ).toArray() as any[]) {
        if (!seen.has(c.id)) { seen.add(c.id); queue.push(c.id); }
      }
    }
    return { id, boosted, on };
  }

  private async get(id: string) {
    const row = this.one(`SELECT * FROM artefacts WHERE id = ?`, id);
    if (!row) throw new Error(`no such artefact: ${id}`);
    return this.shape(row);
  }

  private async list(body: any) {
    const conds: string[] = [], params: any[] = [];
    if (body.type) { conds.push("type = ?"); params.push(String(body.type)); }
    if (body.status) { conds.push("status = ?"); params.push(String(body.status)); }
    if (body.tag) { conds.push("tags LIKE ?"); params.push(`%"${String(body.tag).replace(/[^a-z0-9:_-]/g, "")}"%`); }
    const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
    const rows = this.state.storage.sql
      .exec(`SELECT * FROM artefacts ${where} ORDER BY updated_ts DESC LIMIT ?`, ...params, Math.min(Number(body.limit ?? 50), 200))
      .toArray();
    return { artefacts: rows.map((r) => this.shape(r)) };
  }

  /** Hybrid: FTS5 keyword + embedding cosine, merged. Falls back to FTS-only when AI is unavailable. */
  private async search(body: any) {
    const rawQ = String(body.q ?? "");
    const limit = Math.min(Number(body.limit ?? 20), 100);
    const q = ftsQuery(rawQ);
    if (!q) return { artefacts: [], note: "empty query" };
    const typeFilter = body.type ? `AND a.type = '${String(body.type).replace(/[^a-z_]/g, "")}'` : "";

    const ftsRows = this.state.storage.sql
      .exec(
        `SELECT a.id FROM artefacts_fts f JOIN artefacts a ON a.rowid = f.rowid
         WHERE artefacts_fts MATCH ? ${typeFilter} ORDER BY rank LIMIT ?`,
        q, limit,
      )
      .toArray()
      .map((r: any, i: number) => ({ id: r.id, score: 1 / (1 + i) }));

    let vecRows: Array<{ id: string; score: number }> = [];
    let qvec: Float32Array | null = null;
    let qdim = 0;
    try {
      if (this.env?.AI) {
        const out: any = await this.env.AI.run(EMBED_MODEL, { text: [embedText(rawQ, "")] });
        if (Array.isArray(out?.data?.[0])) { qvec = Float32Array.from(out.data[0]); qdim = qvec.length; }
      }
    } catch { /* AI unavailable */ }
    if (!qvec) { qvec = Float32Array.from(trigramVec(embedText(rawQ, ""), TRIGRAM_DIM)); qdim = TRIGRAM_DIM; }
    {
      const rows = this.state.storage.sql.exec(`SELECT artefact_id, vec FROM embeddings WHERE dim = ?`, qdim).toArray();
      const scored = rows.map((r: any) => {
        const v = new Float32Array(r.vec.buffer ?? r.vec);
        return { id: r.artefact_id, score: cosine(qvec as Float32Array, v) };
      }).filter((r) => r.score > 0.3);
      scored.sort((a, b) => b.score - a.score);
      vecRows = scored.slice(0, limit);
    }

    const merged = hybridMerge(ftsRows, vecRows, limit);
    if (merged.length === 0) return { artefacts: [], note: "no matches (keyword + semantic)" };
    const ids = merged.map((m) => m.id);
    const marks = ids.map(() => "?").join(",");
    const rows = this.state.storage.sql.exec(
      `SELECT * FROM artefacts WHERE id IN (${marks})`, ...ids,
    ).toArray().map((r: any) => this.shape(r));
    const byId = new Map(rows.map((r: any) => [r.id, r]));
    const scored = merged
      .map((m) => {
        const r: any = byId.get(m.id);
        return r ? { ...r, _score: m.score, _via: m.via } : null;
      })
      .filter((r): r is any => !!r);
    return { artefacts: scored, hybrid: { keyword: ftsRows.length, semantic: vecRows.length } };
  }

  /** "What relates to X?" — nearest artefacts by embedding. */
  private async related(id: string, limit: number) {
    const row = this.one(`SELECT vec, dim FROM embeddings WHERE artefact_id = ?`, id);
    if (!row) return { artefacts: [], note: "no embedding for artefact" };
    const qvec = new Float32Array(row.vec.buffer ?? row.vec);
    const rows = this.state.storage.sql.exec(`SELECT artefact_id, vec FROM embeddings WHERE artefact_id != ? AND dim = ?`, id, row.dim).toArray();
    const scored = rows.map((r: any) => {
      const v = new Float32Array(r.vec.buffer ?? r.vec);
      return { id: r.artefact_id, score: cosine(qvec, v) };
    }).filter((r) => r.score > 0.3);
    scored.sort((a, b) => b.score - a.score);
    const ids = scored.slice(0, limit).map((r) => r.id);
    if (ids.length === 0) return { artefacts: [] };
    const marks = ids.map(() => "?").join(",");
    const arts = this.state.storage.sql.exec(`SELECT * FROM artefacts WHERE id IN (${marks})`, ...ids).toArray().map((r: any) => this.shape(r));
    const byId = new Map(arts.map((a: any) => [a.id, a]));
    return { artefacts: ids.map((i) => byId.get(i)).filter((a): a is any => !!a) };
  }

  /**
   * Embed title-weighted text; store as float32 BLOB with the vector dim.
   * Two spaces: Workers AI (prod, 768d) when bound; local hashed-trigram (256d) fallback.
   * Best-effort — never fails the write.
   */
  private async embedArtefact(id: string, title: string, body: string) {
    let vec: number[] | null = null;
    let dim = 0;
    try {
      if (this.env?.AI) {
        const out: any = await this.env.AI.run(EMBED_MODEL, { text: [embedText(title, body)] });
        if (Array.isArray(out?.data?.[0])) { vec = out.data[0]; dim = vec.length; }
      }
    } catch { /* AI unavailable */ }
    if (!vec) {
      vec = trigramVec(embedText(title, body), TRIGRAM_DIM);
      dim = TRIGRAM_DIM;
    }
    const f32 = Float32Array.from(vec);
    this.state.storage.sql.exec(
      `INSERT INTO embeddings (artefact_id, vec, dim) VALUES (?, ?, ?)
       ON CONFLICT(artefact_id) DO UPDATE SET vec = excluded.vec, dim = excluded.dim`,
      id, new Uint8Array(f32.buffer), dim,
    );
  }

  private async update(body: any, actor: string) {
    const id = String(body.id ?? "");
    const row = this.one(`SELECT * FROM artefacts WHERE id = ?`, id);
    if (!row) throw new Error(`no such artefact: ${id}`);
    // any mutation is a heartbeat: abandoned tasks re-claim on first contact
    const preMeta = JSON.parse(row.meta ?? "{}");
    const reclaimed =
      row.status === "blocked" && (preMeta.blocked?.reason ?? "").startsWith("abandoned");
    if (reclaimed) {
      await this.transition({ id, to: "in_progress", note: "re-claimed — agent resumed (heartbeat)" }, actor);
    }
    const title = body.title !== undefined ? String(body.title) : row.title;
    const bodyMd = body.body_md !== undefined ? String(body.body_md) : row.body_md;
    // row.meta predates the re-claim transition — strip the stale blocked record so we don't resurrect it
    const metaObj = body.meta !== undefined ? JSON.parse(JSON.stringify(body.meta)) : JSON.parse(row.meta ?? "{}");
    if (reclaimed) delete metaObj.blocked;
    const meta = JSON.stringify(metaObj);
    if (row.type === "progress") await this.progressHeartbeat(metaObj, title, actor);
    const tags = body.tags !== undefined ? sanitizeTags(body.tags) : row.tags;
    // roles replacement semantics, same as tags (explicit array = replace)
    let roles: string[] | null = parseTags(row.roles);
    if (body.roles !== undefined) {
      const rolesIn = parseRolesInput(body.roles);
      if (rolesIn.ok === false) throw new Error(rolesIn.error);
      roles = rolesIn.roles;
    }
    const limitErr = checkLimits(title, bodyMd, JSON.parse(meta));
    if (limitErr) throw new Error(limitErr);
    // update does not touch status — transitions are the only status path
    this.state.storage.sql.exec(
      `UPDATE artefacts SET title = ?, body_md = ?, meta = ?, tags = ?, roles = ?, updated_ts = ? WHERE id = ?`,
      title, bodyMd, meta, tags ? JSON.stringify(tags) : null, roles && roles.length ? JSON.stringify(roles) : null, Date.now(), id,
    );
    this.audit(actor, "update", id, {});
    const changed = [
      body.title !== undefined && "title", body.body_md !== undefined && "body",
      body.meta !== undefined && "meta", body.tags !== undefined && "tags",
      body.roles !== undefined && "roles",
    ].filter(Boolean);
    this.version(id, actor, "update", `updated ${changed.join(", ") || "fields"}`, { title, body_md: bodyMd });
    await this.embedArtefact(id, title, bodyMd);
    return { id };
  }

  /** Pure evidence for a qualification kind: a done analysis/review child, or an accepted
   *  decision linked either way. Declarations (meta.qualified / meta.qualification) don't count. */
  private hasEvidence(row: any, kind: "analysis" | "review"): { ok: boolean; via?: string } {
    const roleFilter = kind === "analysis"
      ? `(c.roles LIKE '%"analysis"%' OR c.roles LIKE '%"review"%')`
      : `c.roles LIKE '%"review"%'`;
    const child = this.one(
      `SELECT c.id AS id FROM relations r JOIN artefacts c ON c.id = r.src_id
       WHERE r.relation = 'child_of' AND r.dst_id = ? AND c.status = 'done' AND ${roleFilter} LIMIT 1`,
      row.id,
    );
    if (child) return { ok: true, via: child.id };
    const dec = this.one(
      `SELECT d.id AS id FROM relations r JOIN artefacts d ON d.id = r.src_id
       WHERE r.relation = 'supports' AND r.dst_id = ? AND d.type = 'decision' AND d.status = 'accepted' LIMIT 1`,
      row.id,
    );
    if (dec) return { ok: true, via: dec.id };
    return { ok: false };
  }

  /** Swimlane qualification: declared (self-analyzed at intake / preset), pure evidence,
   *  or inherited from the parent's decomposition (the pass that qualified the parent
   *  covered its children). */
  private qualifyCheck(row: any, kind: "analysis" | "review"): { ok: boolean; via?: string } {
    const meta = JSON.parse(row.meta ?? "{}");
    const q = meta.qualification ?? {};
    if (kind === "analysis" && (meta.qualified === true || q.state === "qualified")) return { ok: true, via: "declared" };
    const ev = this.hasEvidence(row, kind);
    if (ev.ok) return ev;
    const parent = this.one(
      `SELECT p.id AS id, p.meta AS meta FROM relations r JOIN artefacts p ON p.id = r.dst_id
       WHERE r.relation = 'child_of' AND r.src_id = ? LIMIT 1`,
      row.id,
    );
    if (parent) {
      const pm = JSON.parse(parent.meta ?? "{}");
      if (kind === "analysis" && (pm.qualified === true || (pm.qualification ?? {}).state === "qualified"))
        return { ok: true, via: `parent:${parent.id}` };
      const sib = this.one(
        `SELECT c.id AS id FROM relations r JOIN artefacts c ON c.id = r.src_id
         WHERE r.relation = 'child_of' AND r.dst_id = ? AND c.status = 'done' AND ${kind === "analysis"
           ? `(c.roles LIKE '%"analysis"%' OR c.roles LIKE '%"review"%')`
           : `c.roles LIKE '%"review"%'`} LIMIT 1`,
        parent.id,
      );
      if (sib) return { ok: true, via: `sibling:${sib.id}` };
    }
    return { ok: false };
  }

  /** Requested-but-unmet qualification bars (qualifications stack: a publisher may
   *  self-qualify AND ask for further confirmation before the task goes ready). */
  /** Bars that can actually gate a CLAIM: things satisfiable before work
   *  starts (human sign-off, an accepted decision...). Qualifier-role bars
   *  (role:analysis/review/impl/unblock) are NOT enforceable pre-claim —
   *  they demand a done role child of the task itself, i.e. a review of
   *  work the gate prevents from existing (the Oct-20 empty-pool incident:
   *  10/10 backlog items unclaimable, runner churning failed claims).
   *  Roles are playbooks, not gates — the done-gate already enforces
   *  review-before-completion where it belongs. */
  private enforceableBars(bars: string[]): string[] {
    return bars.filter((b) => !/^(?:role:)?(analysis|review|impl|unblock)$/.test(String(b)));
  }

  private unmetBars(row: any): string[] {
    const meta = JSON.parse(row.meta ?? "{}");
    const bars: string[] = (meta.qualification ?? {}).bars ?? [];
    return this.enforceableBars(bars).filter((b) => !this.hasEvidence(row, /review/.test(b) ? "review" : "analysis").ok);
  }

  /** Bulk evidence for readiness projections: done role-tagged children per parent +
   *  accepted decisions per task. Review evidence also satisfies the analysis kind. */
  private qualificationEvidence(): { analysisEv: Set<string>; reviewEv: Set<string> } {
    const analysisEv = new Set<string>(), reviewEv = new Set<string>();
    for (const k of this.state.storage.sql.exec(
      `SELECT r.dst_id AS pid, c.roles AS roles FROM relations r JOIN artefacts c ON c.id = r.src_id
       WHERE r.relation = 'child_of' AND c.status = 'done'`,
    ).toArray() as any[]) {
      const roles: string[] = parseTags(k.roles);
      if (roles.includes("review")) { reviewEv.add(k.pid); analysisEv.add(k.pid); }
      else if (roles.includes("analysis")) analysisEv.add(k.pid);
    }
    for (const d of this.state.storage.sql.exec(
      `SELECT r.dst_id AS tid FROM relations r JOIN artefacts d ON d.id = r.src_id
       WHERE r.relation = 'supports' AND d.type = 'decision' AND d.status = 'accepted'`,
    ).toArray() as any[]) { analysisEv.add(d.tid); reviewEv.add(d.tid); }
    return { analysisEv, reviewEv };
  }

  /** Agent roles for an actor label (empty for humans "web" and system actors). */
  private actorTagsFor(label: string): string[] {
    if (!label || /^(web|system:)/.test(label)) return [];
    const row = this.one(`SELECT tags FROM auth_tokens WHERE label = ?`, label);
    try { return parseTags(row?.tags); } catch { return []; }
  }

  /** Every rejected transition is audited (transition_rejected: actor, from, to,
   *  reason) — gaming the gates is visible in the Log and costs behaviour score.
   *  The rejection then goes through the breach door: storms raise ONE card. */
  private async transition(body: any, actor: string) {
    try {
      return await this.doTransition(body, actor);
    } catch (e) {
      const id = String(body?.id ?? "");
      const to = String(body?.to ?? "");
      if (id) {
        const cur = this.one(`SELECT status FROM artefacts WHERE id = ?`, id);
        this.audit(actor, "transition_rejected", id, {
          from: cur?.status, to, reason: String((e as Error)?.message ?? e).slice(0, 300),
        });
        try { await this.foldBreaches(id); } catch { /* the breach door never blocks the gate */ }
        // BR#3361 (b): the auto-derivation half of terminal-leg ownership.
        // A done rejected by done-close-legs derives the close-duty child
        // (flood-guarded: one per legs-shape per hour) so the very next
        // attempt has an owner to point at — no orphan terminal legs.
        if (String((e as Error)?.message ?? "").includes("[rule: done-close-legs]")) {
          try { await this.spawnCloseLegDuty(id, actor, String((e as Error)?.message ?? "")); } catch (se) {
            this.audit(actor, "close_leg_spawn_error", id, { error: String((se as Error).message ?? se).slice(0, 300) });
          }
        }
      }
      throw e;
    }
  }

  /** BR#3361 (b): the close-duty child a rejected done auto-derives. One per
   *  legs-shape per flood window; carries the receipt contract and the
   *  close-then-complete-parent contract so the leg ends owned. The legs
   *  come from the gate's own rejection message — the authoritative list. */
  private async spawnCloseLegDuty(parentId: string, actor: string, rejectionMessage: string): Promise<void> {
    const row = this.one(`SELECT id, title, body_md, meta, status FROM artefacts WHERE id = ?`, parentId);
    if (!row || row.status === "done") return; // leg executed between rejection and spawn
    const ts = Date.now();
    const meta = JSON.parse(row.meta ?? "{}");
    const listed = /not receipted: ([^—]+)—/.exec(rejectionMessage)?.[1] ?? "";
    const legs: CloseLeg[] = [...listed.matchAll(/(?:(?:([A-Za-z0-9-]+)\/([A-Za-z0-9.-]+))?#|#)(\d+)/g)].map((m) => ({
      repo: m[1] && m[2] ? `${m[1]}/${m[2]}` : null,
      number: Number(m[3]),
      raw: m[0],
    }));
    if (!legs.length) return;
    const stamp = meta.last_close_leg_spawn;
    const shape = legs.map(legLabel).join(",");
    if (stamp && typeof stamp.at === "number" && ts - stamp.at < UNBLOCK_FLOOD_MS && String(stamp.legs ?? "") === shape) return;
    // one live close-leg duty per parent at a time — the machine's cap shape
    const live = this.one(
      `SELECT c.id AS id FROM relations r JOIN artefacts c ON c.id = r.src_id
       WHERE r.relation = 'child_of' AND r.dst_id = ? AND c.status IN ('todo','in_progress','blocked')
         AND c.roles LIKE '%"unblock"%' AND (c.title || ' ' || c.body_md) LIKE '%close-leg duty%' LIMIT 1`,
      parentId,
    );
    if (live) {
      meta.last_close_leg_spawn = { at: ts, legs: shape, child: live.id };
      this.state.storage.sql.exec(`UPDATE artefacts SET meta = ? WHERE id = ?`, JSON.stringify(meta), parentId);
      return;
    }
    const rootTitle = String(row.title ?? "").replace(/^(?:Unblock:\s*)+/, "");
    const legLines = legs.map((l) => `- close ${legLabel(l)}${l.repo ? ` (${l.repo})` : " (repo: resolve from the card's context — bare-number legs take the project's default paperwork repo)"}`).join("\n");
    const created = await this.create(
      {
        type: "task",
        title: `Close-leg duty: ${rootTitle.slice(0, 160)}`.slice(0, 200),
        session: "", // session-less spawn: the closer stamps it when they claim (a
        // pre-attributed child would trip review-separation against the real closer)
        body_md: `Terminal close-leg duty for ${parentId} — "${rootTitle}".\n\nThe parent's done was gate-rejected by done-close-legs (BR#3361): its Done-when ends in a terminal GitHub close leg that was not receipted. The hub auto-derived this duty so the leg has an owner — no orphan terminal legs.\n\nLegs:\n${legLines}\n\nEvery receipt must carry: ${RECEIPT_CONTRACT}.\n\nContract: (1) verify live state first (gh issue view <N> --repo <repo> --json state). If the issue is already CLOSED, capture the receipt and close yourself done citing it. If it is OPEN: execute the close per the parent's grammar (bug-corpus scenario id, or scenario: none with justification), capture the receipt, close yourself done with the receipt in the note. (2) Then transition ${parentId} → done citing the receipt — the parent's gate accepts a receipted note or this closed child.`,
        roles: ["unblock"],
      },
      actor,
    );
    this.state.storage.sql.exec(
      `INSERT OR IGNORE INTO relations (src_id, relation, dst_id, created_ts) VALUES (?, 'child_of', ?, ?)`,
      created.id, parentId, ts,
    );
    meta.last_close_leg_spawn = { at: ts, legs: shape, child: created.id };
    this.state.storage.sql.exec(`UPDATE artefacts SET meta = ? WHERE id = ?`, JSON.stringify(meta), parentId);
    this.audit(actor, "create", created.id, { type: "task", auto: "close_leg", parent: parentId, legs: shape });
    this.version(parentId, actor, "note", `close leg(s) ${shape} unowned at done — auto-derived close-duty child ${created.id} (BR#3361)`, { child: created.id, legs: shape });
  }

  /** Lazy SQL-backed context for the machine rules — a guard only queries
   *  what it actually reads, so cheap transitions stay cheap. */
  private ruleCtx(row: any, body: any, id: string, tTags: string[]): RuleCtx {
    return {
      qualify: (kind) => {
        // Bar-based claim gate: a claim is legal unless the task DECLARES
        // enforceable bars that are unmet. Task tags declare the KIND of work
        // (analysis/impl/review) for the dispatched session's delivery
        // contract; there are no agent roles and no default qualification
        // requirement — separation of duties lives in the session-history
        // check, not here.
        const unmet = this.unmetBars(row);
        return unmet.length === 0 ? { ok: true, via: "no-bars" } : { ok: false };
      },
      unmetBars: () => this.unmetBars(row),
      session: () => this.resolveSession(body, String(body?.token_id ?? "")),
      evidence: (eid) => this.one(`SELECT type, tags, roles, meta FROM artefacts WHERE id = ?`, eid),
      parent: () =>
        this.one(
          `SELECT p.id AS id, p.status AS status, p.meta AS meta FROM relations r JOIN artefacts p ON p.id = r.dst_id
           WHERE r.relation = 'child_of' AND r.src_id = ? LIMIT 1`,
          id,
        ),
      openChildren: () =>
        this.one(
          `SELECT COUNT(*) AS n FROM relations r JOIN artefacts c ON c.id = r.src_id
           WHERE r.relation = 'child_of' AND r.dst_id = ? AND c.status NOT IN ('done', 'superseded')`,
          id,
        )?.n ?? 0,
      // verify-of-verify / nesting-cap guard: the spawn-blocker reason or null
      spawnGuard: () => {
        let cursor = id, depth = 0;
        while (depth < 10) {
          const p = this.one(
            `SELECT p.id AS id, p.roles AS roles FROM relations r JOIN artefacts p ON p.id = r.dst_id
             WHERE r.relation = 'child_of' AND r.src_id = ? LIMIT 1`, cursor,
          );
          if (!p) return null;
          depth++;
          if (parseTags(p.roles).includes("review")) return `ancestor ${p.id} is a review task — verify-of-verify is blocked`;
          if (depth >= 3) return `nesting depth ${depth} would exceed the child_of cap of 3`;
          cursor = p.id;
        }
        return null;
      },
      // newest OPEN verify round (reuse candidate) — a re-handoff re-enters the
      // same round instead of stacking a fresh card per bounce cycle
      openVerifyChild: () =>
        this.one(
          `SELECT c.id AS id FROM relations r JOIN artefacts c ON c.id = r.src_id
           WHERE r.relation = 'child_of' AND r.dst_id = ? AND c.status IN ('todo','in_progress','blocked')
             AND c.roles LIKE '%"review"%' ORDER BY c.updated_ts DESC LIMIT 1`, id,
        ),
      // at most ONE live unblock child per parent, ever (cap ≤1 open)
      openUnblockChild: () =>
        this.one(
          `SELECT c.id AS id FROM relations r JOIN artefacts c ON c.id = r.src_id
           WHERE r.relation = 'child_of' AND r.dst_id = ? AND c.status IN ('todo','in_progress','blocked')
             AND c.roles LIKE '%"unblock"%' ORDER BY c.updated_ts DESC LIMIT 1`, id,
        ),
      // BR#3361: the task's own body (Done-when section source for the
      // terminal close-leg gate)
      cardBody: () => String(row.body_md ?? ""),
      // BR#3361 terminal-leg ownership: a CLOSED child that owns the leg —
      // its title/body names both the close and the issue number
      closeLegChildClosed: (leg: CloseLeg) => {
        const hit = this.one(
          `SELECT c.id AS id FROM relations r JOIN artefacts c ON c.id = r.src_id
           WHERE r.relation = 'child_of' AND r.dst_id = ? AND c.status = 'done'
             AND (c.title || ' ' || c.body_md) LIKE '%close%'
             AND (c.title || ' ' || c.body_md) LIKE ${"?"}
             AND c.roles LIKE '%"unblock"%' LIMIT 1`,
          id, `%#${leg.number}%`,
        );
        return !!hit;
      },
      // recent version-log rows (newest first) for the server-side silent-churn fold
      recentEvents: () =>
        (this.state.storage.sql.exec(
          `SELECT ts, actor, action, summary FROM artefact_versions WHERE artefact_id = ? ORDER BY seq DESC LIMIT 50`,
          id,
        ).toArray() as any[]).map((r) => ({ ts: Number(r.ts), actor: String(r.actor), action: String(r.action), summary: String(r.summary ?? "") })),
    };
  }

  private async doTransition(body: any, actor: string) {
    const id = String(body.id ?? "");
    const to = String(body.to ?? "");
    const row = this.one(`SELECT * FROM artefacts WHERE id = ?`, id);
    if (!row) throw new Error(`no such artefact: ${id}`);
    // ---- the law: one table, one executor (machine.ts). Legality AND every
    // spawn/escalate/supersede decision come back as a typed Verdict
    // (Applied | Rejection); this function persists and executes the effects,
    // it never invents legality or decisions. ----
    const tTags: string[] = parseTags(row.tags);
    const tRoles: string[] = parseTags(row.roles);
    const ts0 = Date.now();
    const verdict = await decide(
      { id, type: row.type, status: row.status, to, roles: tRoles, tags: tTags, meta: JSON.parse(row.meta ?? "{}"), actor, body, owner: row.owner, now: ts0 },
      this.ruleCtx(row, body, id, tTags),
    );
    if (verdict.ok === false) throw new Error(`${verdict.message} [rule: ${verdict.rule}]`);
    // (B) subprocess class: a declared block on a long/handed-off op, with a
    // budget. The watchdog pauses until the budget lapses; past it the
    // subprocess = declared silence while STILL WORKING: the task stays
    // in_progress (it isn't blocked — nothing else must finish first). The
    // watchdog pauses until the declared budget lapses; past it the sweep
    // converts the silence to abandoned. Blocked is reserved for tasks
    // awaiting OTHER tasks/decisions.
    const isSubprocess = body.class === "subprocess";
    const sentiment = isSentiment(body.sentiment) ? body.sentiment : undefined;
    const ts = ts0;
    const meta = JSON.parse(row.meta ?? "{}");
    if (isSubprocess && row.type === "task" && row.status === "in_progress") {
      const bm = Math.max(1, Math.min(1440, Number(body.budget_minutes) || 0));
      if (!bm) throw new Error("class: subprocess requires budget_minutes (1-1440) — a declared window without a deadline never trips, which is worse than abandonment");
      meta.subprocess = { reason: String(body.note ?? body.reason ?? "").trim(), budget_minutes: bm, deadline_ts: ts + bm * 60_000, ts };
      this.state.storage.sql.exec(
        `UPDATE artefacts SET meta = ?, updated_ts = ?, status_ts = ? WHERE id = ?`,
        JSON.stringify(meta), ts, ts, id,
      );
      this.audit(actor, "transition", id, { from: row.status, to: "in_progress (subprocess)", note: String(body.note ?? ""), class: "subprocess", budget_minutes: bm });
      this.version(id, actor, "transition", `subprocess declared — watchdog paused until +${bm}m — ${String(body.note ?? "").slice(0, 120)}`, { from: row.status, to: "in_progress", class: "subprocess" });
      return { id, status: "in_progress", subprocess: true };
    }
    // stamp the executor's meta_patch (value `undefined` deletes the key),
    // then normalize the blocked record to the FINAL status — the churn
    // redirect lands blocked with its own reason + unblock condition.
    for (const [k, v] of Object.entries(verdict.meta_patch)) {
      if (v === undefined) delete meta[k];
      else meta[k] = v;
    }
    if (verdict.status === "blocked") {
      if (!meta.blocked) {
        // BR#3578: store the TYPED await (the guard validated one exists or
        // exempted a machine-managed park). Free text is optional annotation,
        // derived from the structured event when absent.
        const aw = validateAwaitEvent(body.await_event)
          ?? awaitEventFromAtoms(parseProxyCondition(String(body.unblock_condition ?? "")).atoms);
        meta.blocked = {
          reason: String(body.note ?? body.reason ?? "").trim(),
          unblock_condition: String(body.unblock_condition ?? "").trim() || (aw ? describeAwaitEvent(aw) : ""),
          ts,
          ...(aw ? { await_event: aw } : {}),
        };
      }
      delete meta.subprocess; // a real block supersedes a declared subprocess window
    } else if (meta.blocked) {
      delete meta.blocked; // unblocking clears the dead-end record
    }
    // claim semantics: in_progress on a task claims it for the actor (system actors don't steal claims)
    let owner = row.owner;
    // claim only on fresh pickup or abandoned re-claim — a review bounce returns to the AUTHOR
    const bounceFromReview = row.status === "in_review";
    // GHOST-BOUNCE CONVERSION (2026-10-25, Ray GO): a verify bounce hands the
    // parent back to its impl owner — but if that owning session is DEAD (no
    // heartbeat within the stall window), the bounce lands on a ghost and the
    // PR ages into the conflict pile. Release to the pool IN THE SAME TICK:
    // owner cleared, reason stamped, the card is dispatchable immediately.
    // The reaper stays as backstop for the non-bounce stall cases.
    let ghostBounce = false;
    if (row.type === "task" && bounceFromReview && owner && owner !== actor && !/^(web|system:)/.test(owner)) {
      // dead-by-construction: no auth_token for the owner label → it can never
      // heartbeat again (revoked/never-provisioned). Otherwise liveness = the
      // owner token's freshest session.
      const ownerToken = this.one(
        `SELECT id FROM auth_tokens WHERE label = ? OR principal = ? LIMIT 1`, owner, owner,
      );
      const ownerSession = ownerToken
        ? this.one(
            `SELECT last_seen_ts FROM sessions WHERE token_id = ? ORDER BY last_seen_ts DESC LIMIT 1`,
            ownerToken.id,
          )
        : null;
      const staleMin = (() => {
        const s = this.one(`SELECT value FROM settings WHERE key = 'stale_minutes'`);
        return s ? Math.max(1, Math.min(120, parseInt(s.value, 10) || 10)) : 10;
      })();
      // liveness = EITHER real signal: the owner session's hub ping, or the
      // task's own heartbeat (meta.last_progress.ts — what log_progress writes).
      // A live owner does at least one of these within the stall window.
      const lastProgressTs = Number(JSON.parse(row.meta ?? "{}").last_progress?.ts ?? 0);
      const lastSignal = Math.max(Number(ownerSession?.last_seen_ts ?? 0), lastProgressTs);
      const dead = !ownerToken || !lastSignal || (Date.now() - lastSignal > staleMin * 60_000);
      if (dead) {
        ghostBounce = true;
        owner = "";
        meta.bounce_released = { reason: "owning session dead at bounce — released to pool", at: Date.now() };
      }
    }
    // gateway attribution: a gateway-tagged token is infrastructure — it claims
    // on behalf of the agent it dispatched as (ADR BR#899). body.agent names
    // that agent; mcp.ts only forwards it when the token carries the "gateway"
    // tag, so a plain agent token cannot attribute its work elsewhere.
    const attributedAgent = body.gateway && String(body.agent ?? "").trim()
      ? String(body.agent).trim().slice(0, 60)
      : undefined;
    if (row.type === "task" && verdict.status === "in_progress" && !bounceFromReview && !/^system:/.test(actor) && owner !== actor) {
      owner = attributedAgent ?? actor;
    }
    // identity phase 2: ownership references the stable principal when the
    // acting token carries one (labels are display; principals are the anchor)
    const actingPrincipal = typeof body.token_id === "string" && body.token_id
      ? this.one(`SELECT principal FROM auth_tokens WHERE id = ?`, body.token_id)?.principal
      : null;
    if (row.type === "task" && to === "in_progress" && !bounceFromReview && !/^system:/.test(actor) && actingPrincipal) {
      owner = actingPrincipal;
    }
    // attribution bookkeeping (BR#2455): when a gateway-tagged token acts as
    // another agent, record the gateway→agent edge for Connect grouping. The
    // token row is the authority — a forged body.gateway without the tag no-ops.
    if (attributedAgent && attributedAgent !== actor && this.isGatewayActor(actor)) {
      this.gatewayTouch(actor, attributedAgent);
    }
    // session attribution: stamp which session claimed/acted, first-wins, resolved
    // explicit → the token's most recent session (agents pass session on orient only)
    if (row.type === "task" && !meta.session) {
      const sess = await this.resolveSession(body, String(body.token_id ?? ""));
      if (sess) meta.session = String(sess).slice(0, 120);
    }
    // (release ownership, churn escalate/redirect and the attempt stamp are
    // executor decisions now — machine.ts RULES + effects, BR#2420 F4)
    // separation of duties, mechanical: a session that completed the analysis
    // child cannot carry the parent into implementation. If the parent is
    // claimed by the same session, release it — impl requires a fresh claim
    // (fresh session). The claim gate will then allow it (evidence session ≠ new session).
    if (row.type === "task" && verdict.status === "done" && tRoles.includes("analysis")) {
      const parent = this.one(
        `SELECT p.id AS id, p.status AS status, p.owner AS owner, p.meta AS meta FROM relations r JOIN artefacts p ON p.id = r.dst_id
         WHERE r.relation = 'child_of' AND r.src_id = ? LIMIT 1`, id,
      );
      const implSession = parent ? JSON.parse(parent.meta ?? "{}").session : undefined;
      const analysisSession = JSON.parse(row.meta ?? "{}").session;
      if (parent?.status === "in_progress" && implSession && analysisSession && implSession === analysisSession) {
        await this.transition(
          { id: parent.id, to: "todo", note: `analysis complete (${id}) — released for fresh-claim implementation` },
          "system:separation",
        );
      }
    }
    // (done open-children gate lives in machine.ts RULES — BR#2420)
    // BR#3361 (c): a done card that claims close legs must be auditable —
    // stamp the legs + the parsed receipts from the done note so the
    // closure-receipt audit sweep can live-verify them post-done (the
    // BR#3220 class: a done card reporting a close that never happened).
    if (row.type === "task" && verdict.status === "done") {
      const doneNote = String(body?.note ?? body?.resolution ?? body?.reason ?? "").trim();
      const legs = parseCloseLegs(`${doneWhenSection(String(row.body_md ?? ""))}\n${doneNote}`);
      if (legs.length) {
        meta.close_leg_audit = {
          ts,
          legs: legs.map((l) => ({ repo: l.repo, number: l.number })),
          receipts: legs.map((l) => ({ ...l, ...(parseClosureReceipt(doneNote, l) ?? { closed: false, commentId: null, guardRun: null }) })),
          checked_ts: null,
        };
      }
    }
    // BR#3361 (d): duplicate-executor fence, visible half. A transition by a
    // session that is NOT the stamped executor while the executor's liveness
    // is fresh is observable (audit duplicate_executor) — the BR#3348 class:
    // two executor sessions doing the same GH paperwork concurrently.
    // Advisory: additive contributions (log_progress) are legitimate and
    // never audited here; this fires on state-changing ops only, and only
    // when the acting session named itself (an unnamed session on a shared
    // token is ambiguous — the token's last-session fallback must not frame
    // the holder's own session).
    try {
      const holder = JSON.parse(row.meta ?? "{}");
      const actingSession = body.session ? await this.resolveSession(body, String(body.token_id ?? "")) : undefined;
      const holderSession = holder.session;
      if (
        row.type === "task" && row.status === "in_progress" &&
        holderSession && actingSession && holderSession !== actingSession
      ) {
        const holderAlive = Math.max(holder.last_progress?.ts ?? 0, holder.session_alive_ts ?? 0, row.updated_ts ?? 0);
        if (Date.now() - holderAlive <= 10 * 60_000) {
          this.audit("system:fence", "duplicate_executor", id, {
            holder: holderSession, actor: actingSession, from: row.status, to,
          });
        }
      }
    } catch { /* the fence is observability — never blocks the gate */ }
    // body_md rides the transition too when the caller supplies it (the train's
    // bounce/stop briefs append to the card body on the same write) — absent a
    // supplied body, the existing body is preserved.
    const nextBodyMd = typeof body.body_md === "string" && body.body_md.trim()
      ? body.body_md
      : String(row.body_md ?? "");
    this.state.storage.sql.exec(
      `UPDATE artefacts SET status = ?, status_ts = ?, meta = ?, updated_ts = ?, owner = ?, tags = ?, body_md = ? WHERE id = ?`,
      verdict.status, ts, JSON.stringify(meta), ts, verdict.owner_clear ? "" : owner, JSON.stringify(tagsForWrite(verdict, tTags)), nextBodyMd, id,
    );
    // post-conditions on the single write path: violations are breaches (a
    // loud audited trail), never silent repairs.
    const violations = checkInvariants({ type: row.type, status: verdict.status, roles: tRoles, tags: tTags, meta });
    if (violations.length) {
      this.audit("system:invariants", "invariant_violation", id, { violations, from: row.status, to: verdict.status });
      this.version(id, "system:invariants", "note", `INVARIANT VIOLATION after ${row.status} → ${verdict.status}: ${violations.join("; ")}`, { violations });
      try { await this.foldBreaches(id); } catch { /* the breach door never blocks the gate */ }
    }
    if (verdict.status === "superseded" && body.replacement_id) {
      const rep = this.one(`SELECT id, type FROM artefacts WHERE id = ?`, String(body.replacement_id));
      if (rep && rep.type === row.type)
        this.state.storage.sql.exec(
          `INSERT OR IGNORE INTO relations (src_id, relation, dst_id, created_ts) VALUES (?, 'supersedes', ?, ?)`,
          String(body.replacement_id), id, ts,
        );
    }
    this.audit(actor, "transition", id, {
      from: row.status, to: verdict.status, note: body.note ?? "", sentiment,
      ...(attributedAgent ? { agent: attributedAgent } : {}),
      ...(body.result_class ? { result_class: String(body.result_class).slice(0, 60) } : {}),
    });
    this.version(id, actor, "transition", `${row.status} → ${verdict.status}${body.note ? ` — ${String(body.note).slice(0, 120)}` : ""}`, { from: row.status, to: verdict.status, note: body.note ?? "" });
    // SERIALIZED MERGE TRAIN (BR#3516): a verify duty closing done on an impl
    // card is the ACCEPT event — stamp the card's PR provenance and queue it
    // onto the train (the train owns delivery; the verifier never merges).
    // The hub parses the PR + head from BOARD data only (no hub GitHub calls).
    if (row.type === "task" && verdict.status === "done" && parseTags(row.roles ?? "").includes("review")) {
      try {
        const parent = this.one(
          `SELECT p.id AS id FROM relations r JOIN artefacts p ON p.id = r.dst_id WHERE r.relation = 'child_of' AND r.src_id = ? LIMIT 1`,
          id,
        );
        if (parent?.id) await this.trainQueueOnAccept(parent.id, { note: String(body.note ?? "") }, actor);
      } catch (e) {
        this.audit("system:merge-train", "queue_hook_error", id, { error: String((e as Error).message ?? e).slice(0, 200) });
      }
    }
    // verify-verdict decisions are actionable: the human's answer DOES the
    // thing, not just records it. Accepting a VERIFIED verdict closes the
    // verified task (the accepted decision satisfies its done-gate via the
    // supports link). Accepting a BOUNCE verdict bounces the task back to
    // work with the findings. Without this, verdicts pile up as prose and the
    // human's click changes nothing — 35 proposed decisions taught us that.
    if (row.type === "decision" && verdict.status === "accepted") {
      const dm = meta ?? {};
      if (dm.decision_class === "verify-verdict") {
        const target = String(dm.task ?? dm.verify_target ?? "").trim();
        const isBounce = String(dm.verdict ?? "").toLowerCase() === "bounce";
        if (target) {
          // verifiers often apply their own verdict before proposing it — the
          // task is already done/bounced/queued. Ratification must be a clean
          // no-op, not an "apply failed" error the human has to interpret.
          const cur = this.one(`SELECT status, roles, meta FROM artefacts WHERE id = ?`, target);
          const curRoles = parseTags((cur as any)?.roles ?? "");
          const targetIsVerify = curRoles.includes("review");
          const already = cur && (isBounce
            ? cur.status === "in_progress"
            : targetIsVerify
              ? cur.status === "done"
              : String(JSON.parse(cur.meta ?? "{}")?.merge_train?.state ?? "") === "queued");
          if (already) {
            this.audit(actor, "verdict_already_applied", target, { decision: id, status: cur.status });
          } else if (!isBounce && !targetIsVerify && cur?.status === "in_progress") {
            // VERIFIED verdict landing on an IMPL card: under the serialized
            // merge train the card is QUEUED, not closed (BR#3516 — the train
            // owns delivery; the merge event closes it later). Same accept
            // event as the verify-close hook, cited from the decision body.
            await this.trainQueueOnAccept(target, { note: String((meta?.body_md ?? this.one(`SELECT body_md FROM artefacts WHERE id = ?`, id)?.body_md) ?? "") }, actor);
            this.audit(actor, "verdict_applied", target, { decision: id, effect: "queued" });
          } else try {
            await this.transition(
              {
                id: target,
                to: isBounce ? "in_progress" : "done",
                note: isBounce
                  ? `verdict ${id} rejected by human — bounce with the verifier's findings`
                  : `verdict ${id} accepted by human — closed on a verified (non-void) verdict`,
              },
              actor,
            );
            this.audit(actor, "verdict_applied", target, { decision: id, effect: isBounce ? "bounced" : "closed" });
          } catch (e) {
            // gate refused (e.g. open children) — surface it on the decision
            // instead of silently swallowing the human's click
            const msg = String((e as Error).message ?? e).slice(0, 300);
            this.audit("decision:verdict", "apply_failed", target, { decision: id, error: msg });
            this.version(id, "decision:verdict", "note", `verdict apply failed on ${target}: ${msg}`, { target, error: msg });
          }
        }
      }
    }
    // BR#3457 act-time prong: the human acted on THIS verdict — any other
    // still-proposed verdict for the same target must not survive to regrow
    // the For Me card (legacy stacked rounds created before the create-time
    // sweep, or create-race stragglers). The sweeper's own transitions don't
    // cascade — the guard keeps the takeover verdict safe.
    if (row.type === "decision" && (verdict.status === "accepted" || verdict.status === "superseded") && actor !== "system:verdictsweep") {
      const dm = meta ?? {};
      if (dm.decision_class === "verify-verdict") {
        const target = String(dm.task ?? dm.verify_target ?? "").trim();
        if (target) await this.supersedeStaleVerdicts(target, id, `superseded by human action on ${id} — one actionable verdict per target (BR#3457)`);
      }
    }
    // ---- execute the effects the executor decided (do.ts never decides) ----
    let verifyTaskId: string | undefined;
    for (const fx of verdict.effects) {
      switch (fx.kind) {
        case "spawn_verify": {
          // verification duty: entering review spawns the Verify task into the
          // unclaimed pool. A verifier (any agent, fresh session) picks it up,
          // checks receipts, completes it, then closes the parent (done) or
          // bounces it (in_progress with findings).
          const rootTitle = row.title.replace(/^(?:Verify:\s*)+/, "");
          const created = await this.create(
            {
              type: "task",
              title: `Verify: ${rootTitle.slice(0, 200)}`,
              body_md: `Verification duty for ${id} — "${rootTitle}".\n\nYour duty is the DOUBLE-CHECK, not the delivery — the serialized merge train owns the merge (BR#3516). You never merge, never close the parent done.\n\nVERIFY GATE — mergeability is a precondition, NOT a finding (2026-10-23 unsigned-PR incident):\n1. FIRST, before any substance check: gh pr view <N> --json mergeable,mergeStateStatus,reviewDecision and confirm every commit signature isValid=true. If mergeable=false / CONFLICTING / any unsigned commit: STOP — zero substance checks, NO ask to the human.\n2. Bounce to impl: transition ${id} in_progress with the mechanical defect ("PR #N unmergeable — unsigned commits | conflicts | failing check X. Re-sign/rebase/resolve and re-push.").\n3. Broken signing environment (key unavailable / NO_USER): file ONE ask for the whole class, never per PR.\n\nThen double-check, don't reimplement: confirm the receipts (PR: ${fx.pr ?? "see note"}, merge state, findings) and that the work matches the task.\n\nACCEPT (substance AND mergeability both hold):\n1. Record the LIVE head: gh pr view <N> --json headRefOid, then put \`head <full-40-hex>\` in your close note — the hub stamps head_sha_at_acceptance from it (zero hub GitHub calls).\n2. Transition the parent ${id} to blocked with note \`merge-train: queued\` — the train gates it, merges it, waits out main CI, and closes it citing the mergeCommit (machine proxy: mergeCommit non-null AND main green).\n3. Close yourself done citing the receipts. A conflicted PR bounces off the train back here with the conflict file list — resolution invalidates the verdict, re-verify at the new head, re-queue.\n\nProblems found → bounce the parent back to impl with findings (in_review → in_progress, one round, N bounces).`,
              roles: ["review"],
            },
            actor,
          );
          verifyTaskId = created.id;
          this.state.storage.sql.exec(
            `INSERT OR IGNORE INTO relations (src_id, relation, dst_id, created_ts) VALUES (?, 'child_of', ?, ?)`,
            created.id, id, ts,
          );
          this.audit(actor, "create", created.id, { type: "task", auto: "verification", parent: id });
          break;
        }
        case "reuse_verify": {
          verifyTaskId = fx.verify;
          this.audit("system:separation", "verify_reused", id, { verify: fx.verify });
          break;
        }
        case "skip_verify_spawn": {
          this.audit("system:guard", "spawn_skipped", id, { auto: "verification", reason: fx.reason });
          try { await this.foldBreaches(id); } catch { /* the breach door never blocks the gate */ }
          break;
        }
        case "spawn_unblock": {
          // every blocked task gets an unblock child — the executor already
          // ran the cap (≤1 open per parent) and the flood guard; this is the
          // only spawn site and it only executes.
          const rootTitle = row.title.replace(/^(?:Unblock:\s*)+/, "");
          const created = await this.create(
            {
              type: "task",
              title: `Unblock: ${rootTitle.slice(0, 200)}`,
              session: "", // session-less spawn: the unblock contract is "then a
              // FRESH session" — a pre-attributed child would trip review-separation against the legitimate closer
              body_md: `Unblock duty for ${id} — "${rootTitle}".\n\nBlocked why: ${fx.reason || "see parent"}.\nExit condition: ${fx.exit_condition || "none recorded — read the card and history, then decide: clear the block, re-scope the task, or escalate via ask_agent"}.\n\nContract: check whether the exit condition now holds (live receipts, GitHub state, answered decision). If it holds: transition ${id} to in_progress with the resolution note, then close yourself done citing what unblocked it. If it does not: record findings via log_progress and close yourself done with the findings — do NOT respawn an unblock task, do not leave yourself open.`,
              roles: ["unblock"],
            },
            actor,
          );
          this.state.storage.sql.exec(
            `INSERT OR IGNORE INTO relations (src_id, relation, dst_id, created_ts) VALUES (?, 'child_of', ?, ?)`,
            created.id, id, ts,
          );
          this.audit(actor, "create", created.id, { type: "task", auto: "unblock", parent: id });
          meta.last_unblock_spawn = { at: ts, exit: fx.exit_condition };
          this.state.storage.sql.exec(`UPDATE artefacts SET meta = ? WHERE id = ?`, JSON.stringify(meta), id);
          break;
        }
        case "skip_unblock_spawn": {
          this.audit(actor, "spawn_skipped", id, { auto: "unblock", reason: fx.reason });
          try { await this.foldBreaches(id); } catch { /* the breach door never blocks the gate */ }
          break;
        }
        case "supersede_children": {
          // children are ephemeral: when the parent moves on, their round
          // closes. keep_newest keeps the newest verify child alive across a
          // bounce — the bounce re-enters the SAME round (the churn that
          // drowned the pool was 3-6 cards per parent).
          const kids = this.state.storage.sql.exec(
            `SELECT c.id AS id, c.status AS status, c.meta AS meta, c.updated_ts AS uts FROM relations r JOIN artefacts c ON c.id = r.src_id
             WHERE r.relation = 'child_of' AND r.dst_id = ? AND c.status IN ('todo','in_progress','blocked') AND c.roles LIKE ? ORDER BY c.updated_ts DESC`,
            id, `%"${fx.tag}"%`,
          ).toArray() as any[];
          kids.forEach((v, i) => {
            if (fx.keep_newest && i === 0) return;
            const vm = JSON.parse(v.meta ?? "{}");
            vm.superseded_reason = fx.cause;
            this.state.storage.sql.exec(
              `UPDATE artefacts SET status = 'superseded', meta = ?, status_ts = ?, updated_ts = ? WHERE id = ?`,
              JSON.stringify(vm), ts, ts, v.id,
            );
            this.audit("system:separation", "transition", v.id, { from: v.status, to: "superseded", note: fx.cause });
            this.version(v.id, "system:separation", "transition", fx.cause, { from: v.status, to: "superseded" });
          });
          break;
        }
        case "escalate": {
          this.audit("system:churn-guard", "escalated", id, { attempts: fx.attempts, silent_cycles: fx.silent_cycles, duty: tRoles[0] ?? "unknown" });
          // a NOTE, not a second transition row: the applied transition above
          // already stamped the real from→to. A duplicate transition stamp
          // with the stale pre-applied from broke the version-log chain and
          // re-fired the replay breach on every later transition (BR#3322).
          this.version(id, "system:churn-guard", "note", `escalated to human — verdict duties cannot block (attempts ${fx.attempts}, silent cycles ${fx.silent_cycles})`, { attempts: fx.attempts, silent_cycles: fx.silent_cycles });
          break;
        }
        case "release_redirect": {
          this.audit("system:churn-guard", "release_redirected", id, { attempts: fx.attempts, silent_cycles: fx.silent_cycles, from: row.status });
          // same: the redirect IS the applied transition — explain it as a note
          this.version(id, "system:churn-guard", "note", `release redirected to blocked — ${fx.attempts} attempts without completion`, { attempts: fx.attempts, silent_cycles: fx.silent_cycles });
          break;
        }
      }
    }
    // replay consistency: fold the version log forward and compare with the
    // stored state — fold(events) != stored_state is itself a breach
    // (BR#2419 item 6).
    try { await this.replayCheck(id); } catch { /* fail-soft: the log fold never blocks a legal write */ }
    return { id, status: verdict.status, ...(sentiment ? { sentiment } : {}), verify_task: verifyTaskId };
  }

  private async link(body: any, actor: string) {
    const srcId = String(body.src ?? ""), rel = String(body.relation ?? ""), dstId = String(body.dst ?? "");
    if (!isRelation(rel)) throw new Error(`unknown relation '${rel}'`);
    const src = this.one(`SELECT id, type, tags, roles FROM artefacts WHERE id = ?`, srcId);
    const dst = this.one(`SELECT id, type, tags, roles FROM artefacts WHERE id = ?`, dstId);
    if (!src || !dst) throw new Error("both src and dst must exist");
    const verdict = validateRelation(rel, src.type as ArtefactType, dst.type as ArtefactType);
    if (verdict.ok === false) throw new Error(verdict.reason);
    // verify-of-verify is structurally impossible: a verify task can never be
    // a child of a verify task (or of an unblock task — same ephemerality).
    // Enforced here at the relation level, not just the auto-spawn path.
    if (rel === "child_of") {
      const childRoles = parseTags((src as any).roles);
      const parentRoles = parseTags((dst as any).roles);
      if (childRoles.includes("review") && (parentRoles.includes("review") || parentRoles.includes("unblock")))
        throw new Error(`link rejected: ${srcId} is a verify task — verify tasks are terminal-at-birth and cannot nest under ${parentRoles.includes("review") ? "another verify" : "an unblock"} task`);
      if (childRoles.includes("unblock") && (parentRoles.includes("unblock") || parentRoles.includes("review")))
        throw new Error(`link rejected: ${srcId} is an unblock task — unblock tasks are terminal-at-birth and cannot nest under another ephemeral task`);
      // ONE-OPEN-VERIFY-CHILD INVARIANT (2026-10-25, Ray GO): linking a second
      // open verify child under the same parent supersedes the older one
      // (keep-newest) instead of stacking. The spawn path already reuses; this
      // is the structural backstop for every other path that creates+links.
      if (childRoles.includes("review") && !["done", "superseded"].includes(String((src as any).status))) {
        const openSiblings = this.state.storage.sql.exec(
          `SELECT c.id AS id, c.updated_ts AS uts FROM relations r JOIN artefacts c ON c.id = r.src_id
           WHERE r.relation = 'child_of' AND r.dst_id = ? AND c.id != ?
             AND c.roles LIKE '%"review"%' AND c.status IN ('todo','in_progress','blocked')
           ORDER BY c.updated_ts ASC`,
          dstId, srcId,
        ).toArray() as any[];
        for (const sib of openSiblings) {
          const vm = JSON.parse(this.one(`SELECT meta FROM artefacts WHERE id = ?`, sib.id)?.meta ?? "{}");
          vm.superseded_reason = `${srcId} linked as the parent's verify round — older open verify child superseded (one round, N bounces)`;
          this.state.storage.sql.exec(
            `UPDATE artefacts SET status = 'superseded', meta = ?, updated_ts = ? WHERE id = ?`,
            JSON.stringify(vm), Date.now(), sib.id,
          );
          this.audit("system:invariant", "verify_superseded", sib.id, { parent: dstId, newer: srcId, reason: "one-open-verify-child" });
        }
      }
    }
    // nesting depth cap: child_of chains max 3 deep — references give structure,
    // not unbounded trees (verify recursion taught us this the hard way)
    if (rel === "child_of") {
      let cursor = dstId, depth = 0, hit: string | undefined;
      while (depth < 10) {
        const p = this.one(
          `SELECT p.id AS id FROM relations r JOIN artefacts p ON p.id = r.dst_id
           WHERE r.relation = 'child_of' AND r.src_id = ? LIMIT 1`, cursor,
        );
        if (!p) break;
        depth++;
        if (depth >= 3) { hit = `${dstId} is already 3 levels deep in a child_of chain — nesting is capped at 3 to keep the task graph flat`; break; }
        cursor = p.id;
      }
      if (hit) throw new Error(`link rejected: ${hit}`);
    }
    const count = this.one(
      `SELECT COUNT(*) AS n FROM relations WHERE src_id = ?`, srcId,
    ) as any;
    if (Number(count.n) >= LIMITS.relationsPerArtefact)
      throw new Error(`artefact ${srcId} already has ${LIMITS.relationsPerArtefact} relations`);
    this.state.storage.sql.exec(
      `INSERT OR IGNORE INTO relations (src_id, relation, dst_id, created_ts) VALUES (?, ?, ?, ?)`,
      srcId, rel, dstId, Date.now(),
    );
    this.audit(actor, "link", srcId, { relation: rel, dst: dstId });
    return { src: srcId, relation: rel, dst: dstId };
  }

  private async relations(id: string) {
    const out = this.state.storage.sql.exec(
      `SELECT relation, dst_id AS artefact_id, 'out' AS dir FROM relations WHERE src_id = ?
       UNION ALL
       SELECT relation, src_id AS artefact_id, 'in' AS dir FROM relations WHERE dst_id = ?`,
      id, id,
    ).toArray();
    return { id, relations: out };
  }

  /** Task-done throughput (BR#2937): done transitions per bucket + cumulative,
   *  aggregated from ledger mutation rows (true transition events — immune to
   *  later status flips) with a status_ts fallback for rows whose history has
   *  compacted. Read-only; no audit (reads don't ledger). */
  private async metricsThroughput(sp: URLSearchParams) {
    const parsed = parseThroughputParams(sp.get("bucket"), sp.get("range"));
    if ("error" in parsed) throw new Error(parsed.error);
    const now = Date.now();
    const from = now - parsed.rangeDays * 86_400_000;
    // task ids — only tasks count (decisions/goals have their own lifecycles)
    const taskIds = new Set(
      (this.state.storage.sql.exec(`SELECT id FROM artefacts WHERE type = 'task'`).toArray() as any[]).map((r) => String(r.id)),
    );
    // done transition events in range (LIKE prefilter, JSON.parse for truth —
    // data carries {from, to}; ask-answer rows carry {status:'done'} instead)
    const events: Array<{ ts: number; artefact_id: string }> = [];
    for (const r of this.state.storage.sql.exec(
      `SELECT ts, artefact_id, data FROM ledger
       WHERE kind = 'mutation' AND action = 'transition' AND ts >= ? AND data LIKE '%"to":"done"%'`,
      from,
    ).toArray() as any[]) {
      let to = "";
      try { to = String(JSON.parse(r.data ?? "{}").to ?? ""); } catch { continue; }
      if (to !== "done" || !taskIds.has(String(r.artefact_id))) continue;
      events.push({ ts: Number(r.ts), artefact_id: String(r.artefact_id) });
    }
    // compaction fallback: currently-done tasks with no done-transition row
    const fallback = (this.state.storage.sql.exec(
      `SELECT id, status_ts FROM artefacts WHERE type = 'task' AND status = 'done' AND status_ts >= ?`,
      from,
    ).toArray() as any[]).map((r) => ({ id: String(r.id), status_ts: Number(r.status_ts) }));
    const buckets = aggregateThroughput(events, fallback, { bucket: parsed.bucket, rangeDays: parsed.rangeDays, now });
    return {
      bucket: parsed.bucket,
      range_days: parsed.rangeDays,
      from_ts: buckets[0]?.t ?? from,
      to_ts: now,
      total: buckets.reduce((n, b) => n + b.n, 0),
      buckets,
    };
  }

  private async stats() {
    const byType = this.state.storage.sql.exec(
      `SELECT type, status, COUNT(*) AS n FROM artefacts GROUP BY type, status ORDER BY type`,
    ).toArray();
    const tick = this.one(`SELECT value FROM settings WHERE key = 'watchdog.last_tick'`);
    const sweep = this.one(`SELECT value FROM settings WHERE key = 'watchdog.sweep'`);
    const openAsks = this.one(`SELECT COUNT(*) AS n FROM asks WHERE status = 'open'`)?.n ?? 0;
    let watchdog: Record<string, unknown> | undefined;
    try {
      const recent = this.state.storage.sql.exec(
        `SELECT op, ts FROM events WHERE artefact_id = 'watchdog' ORDER BY seq DESC LIMIT 3`,
      ).toArray() as any[];
      watchdog = {
        last_tick: tick ? Number(tick.value) : 0,
        next_alarm_ts: await this.state.storage.getAlarm(),
        recent_events: recent.map((e) => ({ op: e.op, age_min: Math.round((Date.now() - Number(e.ts)) / 60000) })),
        open_asks: openAsks,
        ...(sweep ? JSON.parse(sweep.value) : {}),
      };
    } catch { /* older sweep shape */ }
    return { counts: byType, watchdog };
  }

  /**
   * Fine-grained progress from a working agent: note + sentiment, shown live on the board.
   * Optional self-reported gauge fields: completion_pct, confidence_pct, risk_pct, context_pct (0–100).
   * completion = how far along; confidence = belief the result is right; risk = chance of
   * failure/drift. Correlated, not the same — charted as separate series.
   */
  private async progressLog(body: any, actor: string) {
    const id = String(body.id ?? "");
    const note = String(body.note ?? body.did ?? "").trim().slice(0, 500);
    const will = String(body.will ?? "").trim().slice(0, 500);
    const sentiment = isSentiment(body.sentiment) ? body.sentiment : "neutral";
    const pct = (v: any) => (Number.isFinite(v) ? Math.max(0, Math.min(100, Math.round(v))) : undefined);
    const completion_pct = pct(body.completion_pct);
    const confidence_pct = pct(body.confidence_pct);
    const risk_pct = pct(body.risk_pct);
    const context_pct = pct(body.context_pct);
    const row = this.one(`SELECT id, status, meta, tags FROM artefacts WHERE id = ?`, id);
    if (!row) throw new Error(`no such artefact: ${id}`);
    const meta = JSON.parse(row.meta ?? "{}");
    const m = this.settingsMap();
    const myScore = this.agentScores().find((a) => a.label === actor);
    const scoreLine = myScore
      ? `\n\nYour behaviour score: ${myScore.score}/100 (${myScore.grade}).` + (myScore.hints.length ? ` ${myScore.hints.join(" ")}` : "")
      : "";
    const instructions = composeBootstrap(m.project_name || "Superpositional", m.board ?? DEFAULT_BOARD) + (m.bootstrap_md ? `\n${m.bootstrap_md}` : "") + scoreLine;
    // Re-claim: logging progress on a watchdog-abandoned task flips it back to
    // in_progress (the unblock condition the watchdog promised). Subprocess
    // blocks re-claim the same way — the agent is back, the subprocess resolved.
    // Legitimately blocked tasks (human reasons) keep their status until explicitly resumed.
    const isSubprocessBlock = meta.blocked?.class === "subprocess";
    // gateway attribution (ADR BR#899): re-claims via gateway tokens attribute
    // to the dispatched agent, same as ordinary claims
    const attributedAgent = body.gateway && String(body.agent ?? "").trim()
      ? String(body.agent).trim().slice(0, 60)
      : undefined;
    if (row.status === "blocked" && ((meta.blocked?.reason ?? "").startsWith("abandoned") || isSubprocessBlock)) {
      await this.transition({ id, to: "in_progress", note: isSubprocessBlock ? "re-claimed — subprocess resolved" : "re-claimed — agent resumed (heartbeat)", gateway: body.gateway, agent: body.agent }, actor);
      delete meta.blocked; // transition cleared it in DB — don't resurrect it here
    } else if (row.status === "todo") {
      // progress on an unclaimed task = intent to work it. Claim if allowed;
      // otherwise say WHY instead of silently logging into a card that never moves.
      const tRoles: string[] = parseTags(row.roles);
      // questions: contributions never claim — the author closes with an ADR
      if (row.type === "question") {
        return {
          id, note, will: will || undefined, sentiment, completion_pct, confidence_pct, risk_pct, context_pct, instructions,
          note_postscript: "contribution logged on a question — questions are answered, not claimed. The author weighs contributions and closes it with an ADR (decision artefact, derived_from this task).",
        };
      }
      const isQualifier = tRoles.includes("analysis") || tRoles.includes("review") || tRoles.includes("unblock");
      const q = isQualifier ? { ok: true } : this.qualifyCheck(row, "analysis");
      if (!q.ok) {
        return {
          id, note, will: will || undefined, sentiment, completion_pct, confidence_pct, risk_pct, context_pct, instructions,
          note_postscript: `PROGRESS LOGGED BUT TASK NOT CLAIMED — ${id} is unclaimed todo and not qualified for you (label ${actor}). transition {to: "in_progress"} will be rejected until it is qualified: complete an analysis child task, link an accepted decision, or pick qualified work. Analysis/review-role agents may claim unqualified work.`,
        };
      }
      await this.transition({ id, to: "in_progress", note: "started — progress logged", gateway: body.gateway, agent: body.agent }, actor);
    }
    // (A) declared grace: a silence window for a long op, made while still
    // running. Requires a will (what the silence is FOR). Cleared by the next
    // ordinary log (the agent is back). Watchdog honors it until it lapses.
    const gm = Math.max(0, Math.min(60, Number(body.grace_minutes) || 0));
    let graceUntil: number | undefined;
    if (gm > 0) {
      if (!will) throw new Error("grace_minutes requires a will — declare what you will be doing during the silence (e.g. 're-index runs, silence ~25m')");
      graceUntil = Date.now() + gm * 60_000;
      meta.grace_until = graceUntil;
    } else {
      delete meta.grace_until; // ordinary log = agent is back
      // an ordinary log on a task with a declared subprocess window = the
      // subprocess resolved (or the agent is back mid-window) — clear it
      delete meta.subprocess;
    }
    const session = await this.resolveSession(body, String(body.token_id ?? ""));
    // gateway attribution: progress made by a gateway token on behalf of a
    // dispatched agent shows the AGENT as the actor on cards (ADR BR#899) —
    // the gateway stays in the audit trail as the actor of record.
    const progressActor = body.gateway && String(body.agent ?? "").trim()
      ? String(body.agent).trim().slice(0, 60)
      : actor;
    if (progressActor !== actor && this.isGatewayActor(actor)) {
      this.gatewayTouch(actor, progressActor); // gateway→agent edge (BR#2455)
    }
    const prev = meta.last_progress ?? {};
    meta.last_progress = {
      note, will: will || undefined, sentiment, actor: progressActor, ts: Date.now(), session: session ?? meta.session,
      completion_pct:  completion_pct  ?? prev.completion_pct,
      confidence_pct:  confidence_pct  ?? prev.confidence_pct,
      risk_pct:        risk_pct        ?? prev.risk_pct,
      context_pct:     context_pct     ?? prev.context_pct,
    };
    if (session && !meta.session) meta.session = session;
    this.state.storage.sql.exec(
      `UPDATE artefacts SET meta = ?, updated_ts = ? WHERE id = ?`,
      JSON.stringify(meta), Date.now(), id,
    );
    this.audit(actor, "progress", id, { note, sentiment, will: will || undefined });
    this.version(id, actor, "progress", note, { note, will: will || undefined, sentiment, completion_pct, confidence_pct, risk_pct, context_pct });
    return {
      id, note, will: will || undefined, sentiment, completion_pct, confidence_pct, risk_pct, context_pct,
      grace_until: graceUntil, instructions,
    };
  }

  // ---------- the breach door: one fold, one open card per (task, class) ----------
  /** The single breach door (BR#2419 item 6): fold recent audit events for a
   *  task into breach cards. One OPEN card per (task, class) key —
   *  reoccurrences coalesce onto the open card, never spawn duplicates.
   *  Call sites: every transition_rejected, invariant_violation,
   *  spawn_skipped and replay_mismatch lands here through the fold.
   *  BR#3443: a CLOSED card's events never re-fold either. Every card
   *  carries a fold high-water in meta.breach_high_water — the newest event
   *  ts its adjudication covered — and a key with any prior card only counts
   *  events strictly above that mark, so closing a card can never re-arm
   *  its key (specimen BR#3439: a duplicate raised from events that all
   *  predated the predecessor card's close). */
  private async foldBreaches(taskId: string) {
    const since = Date.now() - BREACH_WINDOW_MS * 8; // look back several windows
    const rows = this.state.storage.sql.exec(
      `SELECT ts, op, detail FROM events WHERE artefact_id = ? AND ts > ?
        AND op IN ('transition_rejected','invariant_violation','spawn_skipped','replay_mismatch')
        ORDER BY seq ASC LIMIT 200`,
      taskId, since,
    ).toArray() as any[];
    if (!rows.length) return;
    const events = rows.map((r) => {
      let d: any = {};
      try { d = JSON.parse(r.detail ?? "{}"); } catch { /* tolerate junk detail */ }
      const reason = String(d?.reason ?? (Array.isArray(d?.violations) ? d.violations[0] : "") ?? "unknown");
      return { ts: Number(r.ts), task: taskId, op: String(r.op), reason };
    });
    // BR#3443: load EVERY breach card on this task, open AND closed. Open
    // cards suppress their key (reoccurrences coalesce onto them); every
    // card's high-water fences off the events it already folded.
    const openKeys = new Set<string>();
    const highWater = new Map<string, number>(); // key → newest already-folded event ts
    const openCards = new Map<string, { id: string; meta: string; stamped: number }>();
    for (const b of this.state.storage.sql.exec(
      `SELECT id, status, meta, status_ts, created_ts FROM artefacts WHERE type = 'task' AND meta LIKE ?`,
      `%"breach_key":"${taskId}|%`,
    ).toArray() as any[]) {
      let m: any = {};
      try { m = JSON.parse(b.meta ?? "{}"); } catch { /* garbage meta is not a breach */ }
      const key = m?.breach_key;
      if (typeof key !== "string") continue;
      if (b.status === "done" || b.status === "superseded") {
        // A closed card adjudicated everything up to the moment it closed:
        // its raised group, plus every reoccurrence that coalesced while it
        // was open. Stamped cards carry the exact mark; pre-BR#3443 cards
        // fall back to their close time (then creation time). Anything
        // strictly after the mark is genuinely new evidence.
        const hw = Number(m?.breach_high_water ?? 0) || Number(b.status_ts ?? 0) || Number(b.created_ts ?? 0) || 0;
        const prev = highWater.get(key);
        if (prev === undefined || hw > prev) highWater.set(key, hw);
      } else {
        openKeys.add(key);
        // An open card covered the group it was raised from (its creation
        // for unstamped legacy cards); the pass below advances the stamp as
        // reoccurrences coalesce.
        const stamped = Number(m?.breach_high_water ?? 0) || Number(b.created_ts ?? 0) || 0;
        openCards.set(key, { id: String(b.id), meta: String(b.meta ?? "{}"), stamped });
      }
    }
    const breaches = detectBreaches(events, openKeys, { highWater });
    for (const b of breaches) {
      const created = await this.create(
        {
          type: "task",
          title: `Breach: ${b.klass} on ${taskId} — ${b.count} event${b.count === 1 ? "" : "s"}`,
          body_md: `Structural breach detected server-side (fold over the audit stream).\n\n- class: ${b.klass}\n- task: ${taskId}\n- events: ${b.count} in the window (first ${new Date(b.first_ts).toISOString()}, last ${new Date(b.last_ts).toISOString()})\n- sample: ${b.sample}\n\nOne open card per (task, class) — reoccurrences coalesce here instead of spawning duplicates. Investigate the cause (get_history on ${taskId}, the Log), fix the loop, then close this card with what you found.`,
          tags: ["breach", `breach:${b.klass}`],
        },
        "system:breach",
      );
      this.state.storage.sql.exec(
        `UPDATE artefacts SET meta = ? WHERE id = ?`,
        JSON.stringify({ breach_key: b.key, breach_task: taskId, breach_class: b.klass, breach_count: b.count, breach_high_water: b.last_ts }),
        created.id,
      );
      this.audit("system:breach", "breach_raised", created.id, { key: b.key, task: taskId, klass: b.klass, count: b.count });
      this.version(created.id, "system:breach", "create", `breach card raised — ${b.klass} on ${taskId} (${b.count} events)`, { key: b.key, sample: b.sample });
    }
    // BR#3443: reoccurrences coalescing onto an OPEN card advance its
    // high-water, so when the card later closes, its coalesced evidence
    // stays folded instead of re-raising a duplicate.
    const maxSeen = new Map<string, number>();
    for (const e of events) {
      const key = `${e.task}|${classOf(e)}`;
      const ts = Number(e.ts);
      if (!Number.isFinite(ts)) continue;
      const cur = maxSeen.get(key);
      if (cur === undefined || ts > cur) maxSeen.set(key, ts);
    }
    for (const [key, card] of openCards) {
      const seen = maxSeen.get(key) ?? 0;
      if (seen <= card.stamped) continue;
      let m: any = {};
      try { m = JSON.parse(card.meta); } catch { /* garbage meta — still stamp the high-water */ }
      m.breach_high_water = seen;
      this.state.storage.sql.exec(`UPDATE artefacts SET meta = ? WHERE id = ?`, JSON.stringify(m), card.id);
    }
  }

  /** Replay consistency (BR#2419 item 6): fold the version log's transition
   *  chain forward and compare with the stored status. A mismatch — or a
   *  broken chain (an event's `from` doesn't match the folded state:
   *  forged, deleted, or out-of-order history) — is a replay_mismatch event
   *  through the breach door. */
  private async replayCheck(id: string) {
    const row = this.one(`SELECT status FROM artefacts WHERE id = ?`, id);
    if (!row) return;
    const versions = (
      this.state.storage.sql.exec(
        `SELECT action, data FROM artefact_versions WHERE artefact_id = ? ORDER BY seq DESC LIMIT 200`,
        id,
      ).toArray() as any[]
    ).reverse();
    if (!versions.length) return;
    const events = versions.map((v) => {
      let d: any = {};
      try { d = JSON.parse(v.data ?? "{}"); } catch { /* tolerate junk rows */ }
      return { action: String(v.action), data: d };
    });
    const fold = replayStatus("", events);
    if (fold.status && fold.status !== row.status) {
      // the law: fold(events) != stored_state is itself a breach (BR#2419 item 6)
      this.audit("system:replay", "replay_mismatch", id, { stored: row.status, folded: fold.status, chain_breaks: fold.breaks });
      this.version(id, "system:replay", "note", `REPLAY MISMATCH: version log folds to '${fold.status}' (${fold.breaks} chain break${fold.breaks === 1 ? "" : "s"}) but stored status is '${row.status}'`, { stored: row.status, folded: fold.status, chain_breaks: fold.breaks });
      try { await this.foldBreaches(id); } catch { /* the breach door never blocks the gate */ }
    } else if (fold.tailBreak) {
      // The newest transition row didn't chain (a stale/duplicate stamp or a
      // silent status write just landed). The fold healed past it — but fresh
      // damage is audited the moment it happens, while historical gaps
      // (pre-gate rows, BR#3322) re-anchor silently instead of re-firing the
      // breach on every transition forever.
      this.audit("system:replay", "chain_break", id, { breaks: fold.breaks });
    }
  }

  private async getHistory(artefactId: string, limit = 100) {
    const rows = this.state.storage.sql.exec(
      `SELECT seq, ts, actor, action, summary, data FROM artefact_versions
       WHERE artefact_id = ? ORDER BY seq DESC LIMIT ?`,
      artefactId, Math.min(limit, 200),
    ).toArray().map((r: any) => ({ ...r, data: JSON.parse(r.data ?? "{}") }));
    return { artefact_id: artefactId, versions: rows };
  }

  // ---------- identity, sessions, asks, settings, orient ----------

  /** Resolve a bearer secret to an agent identity; touches last_seen. */
  private async identify(bearer: string) {
    if (!bearer) throw new Error("missing bearer");
    const hash = await hashAuthToken(bearer);
    let row = this.one(`SELECT id, label, tags, principal, revoked_ts FROM auth_tokens WHERE hash = ?`, hash);
    if (!row) {
      // absorb dev-mode write-visibility hiccups right after mint
      await new Promise((r) => setTimeout(r, 250));
      row = this.one(`SELECT id, label, tags, principal, revoked_ts FROM auth_tokens WHERE hash = ?`, hash);
    }
    if (!row) throw new Error("unknown auth token");
    if (row.revoked_ts) throw new Error("auth token revoked");
    this.state.storage.sql.exec(`UPDATE auth_tokens SET last_seen_ts = ? WHERE id = ?`, Date.now(), row.id);
    return { token_id: row.id, label: row.label, tags: parseTags(row.tags), principal: row.principal ?? null };
  }

  /**
   * Connected identities, separated by class (BR#2455): `gateways` are the
   * infrastructure tokens (each with the agent labels it dispatched recently),
   * `agents` is everyone else. MCP peers never see gateways inside the agents
   * array — a gateway is not an agent.
   */
  private async listAgents() {
    const cutoff = Date.now() - 10 * 60_000;
    const rows = this.state.storage.sql.exec(
      `SELECT label, tags, transport, last_seen_ts, revoked_ts FROM auth_tokens ORDER BY last_seen_ts DESC`,
    ).toArray().filter((a) => !a.revoked_ts);
    const shape = (a: any) => ({
      label: a.label,
      tags: parseTags(a.tags),
      transport: a.transport ?? "mcp",
      online: a.last_seen_ts >= cutoff,
      last_seen_ts: a.last_seen_ts,
    });
    const agents = rows.filter((a) => !tagsSayGateway(a.tags)).map((a: any) => ({ ...shape(a), tags: [] }));
    const gateways = rows.filter((a) => tagsSayGateway(a.tags)).map((g: any) => ({
      ...shape(g),
      agents: this.state.storage.sql.exec(
        `SELECT agent AS label, last_seen_ts FROM gateway_agents WHERE gateway = ? ORDER BY last_seen_ts DESC LIMIT 20`,
        g.label,
      ).toArray(),
    }));
    return { agents, gateways, note: "bridge routes between agents — gateways are listed separately with the agents they dispatched; transport shows how each is reachable today (mcp) or next (a2a, acp-proxy, board)" };
  }

  /** Does this label's token carry the gateway tag? (attribution authority) */
  private isGatewayActor(label: string): boolean {
    const row = this.one(`SELECT tags FROM auth_tokens WHERE label = ?`, label);
    return !!row && tagsSayGateway(row.tags);
  }

  /** Stamp/refresh the gateway→dispatched-agent edge (Connect grouping). */
  private gatewayTouch(gateway: string, agent: string) {
    this.state.storage.sql.exec(
      `INSERT INTO gateway_agents (gateway, agent, last_seen_ts) VALUES (?, ?, ?)
       ON CONFLICT(gateway, agent) DO UPDATE SET last_seen_ts = excluded.last_seen_ts`,
      gateway.slice(0, 80), agent.slice(0, 80), Date.now(),
    );
  }

  /** The session a write belongs to: explicit, else the token's most recent session. */
  private async resolveSession(body: any, tokenId: string): Promise<string | undefined> {
    if (body.session !== undefined) {
      const named = String(body.session ?? "").trim();
      // an explicitly EMPTY session is anonymous (hub/auto-spawned children
      // start session-less so the token's last-session fallback cannot
      // misattribute them — the first real session to act stamps the card)
      if (!named) return undefined;
      await this.sessionTouch({ token_id: tokenId, session: named, worktree: body.worktree }).catch(() => {});
      return named;
    }
    const row = this.one(
      `SELECT name FROM sessions WHERE token_id = ? ORDER BY last_seen_ts DESC LIMIT 1`, tokenId,
    ) as any;
    return row?.name ?? undefined;
  }

  /** Register/refresh a session. Names are unique per auth token.
   *  `worktree` (BR#3204): where the session's git tree lives — surfaced on
   *  orient so the board can spot two sessions sharing a checkout. */
  private async sessionTouch(body: any) {
    const token_id = String(body.token_id ?? "");
    const name = String(body.session ?? "").trim().slice(0, 80) || `session-${Math.random().toString(36).slice(2, 6)}`;
    const worktree = String(body.worktree ?? "").trim().slice(0, 400) || null;
    const ts = Date.now();
    this.state.storage.sql.exec(
      `INSERT INTO sessions (token_id, name, kind, worktree, first_seen_ts, last_seen_ts)
       VALUES (?, ?, (SELECT CASE WHEN tags LIKE '%gateway%' THEN 'gateway' END FROM auth_tokens WHERE id = ?), ?, ?, ?)
       ON CONFLICT(token_id, name) DO UPDATE SET last_seen_ts = excluded.last_seen_ts, kind = COALESCE(kind, excluded.kind),
         worktree = COALESCE(excluded.worktree, sessions.worktree)`,
      token_id, name, token_id, worktree, ts, ts,
    );
    return { session: name, worktree };
  }

  private async askCreate(body: any, actor: string) {
    const to = String(body.to ?? "any");
    const question = String(body.question ?? "").trim();
    if (!question) throw new Error("question is required");
    // the question IS the ask — one answerable sentence ending in '?'.
    // Reports, receipts and narrative belong in details (body_md).
    if (question.length > 240) throw new Error("question must be the ask itself, one sentence ≤240 chars — put reports/receipts in details");
    if (!question.endsWith("?")) throw new Error("phrase the ask as an answerable question ending in '?' — e.g. 'Do you want to merge PR #84 into main?' (you sent a status report, not a question)");
    const details = String(body.details ?? "").trim();
    // WHY IT'S ESCALATED is not optional for human-directed asks: "merge PR
    // #84?" is unanswerable without "review is red but rebuttable per guidance".
    const reason = String(body.reason ?? "").trim().slice(0, 400);
    if (!reason && (to === "human" || to === "ray")) throw new Error("asks to a human must state why they are escalated instead of automatic (reason: '…')");
    if (!isValidAskTarget(to)) throw new Error(`invalid ask target '${to}'`);
    const artefactId = body.artefact_id ? String(body.artefact_id).trim() : "";
    // asks REQUIRE options: the human answers by clicking one of 2-4 buttons
    // (free-text refinement lives in the detail view). No options = rejected
    // at the contract, not a button-less ask the UI can't surface.
    // options are strings the human clicks — objects are flattened to their
    // label-ish field and [object Object] garbage never stores
    const options = [...new Set((Array.isArray(body.options) ? body.options : [])
      .map((o: any) => typeof o === "string" ? o
        : String(o?.label ?? o?.text ?? o?.value ?? o?.title ?? ""))
      .map((x: string) => x.trim())
      .filter((x: string) => x && !/\[object\s*object\]/i.test(x))
      .map((x: string) => x.slice(0, 200)))].slice(0, 8);
    if (options.length < 2) throw new Error("asks require 2-8 answer options — give the human one-click answers (options: ['GO', 'NO-GO'])");
    // urgency is an ASK vocabulary (contract v2 — the same words the FlowsHub
    // ingest accepts and DecisionCard renders; "time-sensitive" = the urgent
    // NOW chip), not a progress sentiment. Validating with isSentiment made
    // every urgent ask collapse to a normal-looking one: the urgent door
    // silently failed (found wiring BR#3008's stop-the-line sweep).
    const urgency = body.urgency === "time-sensitive" ? "time-sensitive" : "normal";

    // the ask IS a question node: BR#-numbered, child_of its subject, answered
    // by transition. The legacy asks row is no longer written.
    if (artefactId) {
      const dup = this.one(
        `SELECT c.id AS id FROM relations r JOIN artefacts c ON c.id = r.src_id
         WHERE r.relation = 'child_of' AND r.dst_id = ? AND c.status IN ('todo','in_progress','blocked')
           AND c.type = 'question' AND c.title = ? LIMIT 1`,
        artefactId, question.slice(0, 200),
      );
      if (dup) throw new Error(`an identical ask is already open: ${dup.id} — answer or reframe it instead of re-asking`);
    }
    const created = await this.create(
      {
        type: "question",
        title: question.slice(0, 200),
        body_md: details || question,
        owner: "",
        meta: { ask: { to, urgency, options, from: actor, reason: reason || undefined, artefact_id: artefactId || undefined } },
      },
      actor,
    );
    const id = created.id;
    let taskStatus: string | undefined;
    if (artefactId) {
      const row = this.one(`SELECT type, status, meta FROM artefacts WHERE id = ?`, artefactId);
      if (!row) throw new Error(`no such artefact: ${artefactId}`);
      this.state.storage.sql.exec(
        `INSERT OR IGNORE INTO relations (src_id, relation, dst_id, created_ts) VALUES (?, 'child_of', ?, ?)`,
        id, artefactId, Date.now(),
      );
      if (row.type === "task" && (row.status === "in_progress" || row.status === "blocked")) {
        if (row.status === "in_progress") {
          // blocked-on-ask (rule 6): the ask pauses the subject and the ANSWER
          // auto-resumes it — the unblock condition IS the ask, so the gate's
          // no-dead-end rule holds and askAnswer's resume leg finds it parked
          // with a live path out (this flip previously hard-failed: the
          // transition went out with a note but no unblock condition).
          await this.transition({
            id: artefactId, to: "blocked",
            note: `blocked on ${to}: ${question.slice(0, 100)}`,
            unblock_condition: `answer ask ${id}`,
            await_event: { event: "ask", ask_id: id },
          }, actor);
          taskStatus = "blocked";
        }
      }
    }
    this.audit(actor, "ask", artefactId || null, { to, question, options, urgency, ask_id: id });
    return { id, ask: id, question, artefact_id: artefactId || undefined, options, urgency, task_status: taskStatus };
  }
  private async askInbox(body: any) {
    const label = String(body.label ?? "");
    // nodes are the inbox; open legacy rows are shown until the v2 migration
    // converts them (they then read status 'migrated' and vanish naturally)
    const nodes = this.state.storage.sql.exec(
      `SELECT id, meta, created_ts FROM artefacts
       WHERE type = 'question' AND status IN ('todo','in_progress','blocked')
       ORDER BY created_ts DESC LIMIT 50`,
    ).toArray() as any[];
    // BR#3578 follow-up (the cody inbox dump): the addressee filter used to
    // end in `|| true` (a debug leftover) — EVERY open ask landed in EVERY
    // agent's inbox, so a freshly-minted token inherited all ~57 human-
    // directed migration asks as its own and its score hint mis-fired. An
    // ask is yours iff it targets `any`, your exact label, your
    // label@session, or one of your capability tags (`tag:<t>`). Human-
    // directed asks (`ray`, `human`, a GitHub login) surface on the human
    // planes (For Me / ask band), never in agent inboxes.
    const tags: string[] = Array.isArray(body.tags) ? body.tags.map(String) : [];
    const inbox = nodes
      .map((n) => {
        const m = JSON.parse(n.meta ?? "{}");
        if (!m.ask) return null;
        const out: any = { id: n.id, from_label: m.ask.from ?? "agent", to_target: m.ask.to ?? "any", question: n.title, created_ts: n.created_ts, node: true };
        if (m.ask.reframe) out.reframe = m.ask.reframe;
        return out;
      })
      .filter((x): x is any => !!x && (
        x.to_target === "any" ||
        x.to_target === label ||
        String(x.to_target).startsWith(`${label}@`) ||
        tags.some((t) => x.to_target === `tag:${t}`)
      ));
    const open = this.state.storage.sql.exec(
      `SELECT id, from_label, to_target, question, created_ts FROM asks
       WHERE status = 'open' AND from_label != ? ORDER BY created_ts DESC LIMIT 50`,
      label,
    ).toArray();
    const sent = this.state.storage.sql.exec(
      `SELECT id, to_target, question, status, answer, answered_by, created_ts FROM asks
       WHERE from_label = ? ORDER BY created_ts DESC LIMIT 50`,
      label,
    ).toArray();
    return { inbox: [...inbox, ...open], sent };
  }


  /** Reframe: the human kicks an ask back to the asker to restructure.
   *  Feedback is recorded on the node and surfaces in the asker's inbox.
   *  Deliberately does NOT answer/resume — the parent stays parked until
   *  a structured re-ask or an explicit answer. */
  private async askReframe(body: any, actor: string) {
    const id = String(body.id ?? "");
    const feedback = String(body.feedback ?? "").trim().slice(0, 1000) ||
      "REFRAME — restructure per the ask contract: one imperative question ≤240 chars, 2-8 one-click options, and why this is escalated instead of automatic.";
    const node = this.one(`SELECT id, meta FROM artefacts WHERE id = ? AND type = 'question'`, id);
    if (!node) throw new Error(`no such ask: ${id}`);
    const m = JSON.parse(node.meta ?? "{}");
    m.ask = { ...(m.ask ?? {}), reframe: { by: actor, feedback, ts: Date.now() } };
    this.state.storage.sql.exec(`UPDATE artefacts SET meta = ? WHERE id = ?`, JSON.stringify(m), id);
    this.version(id, actor, "update", `ask reframed by human — ${feedback.slice(0, 160)}`, { reframe: m.ask.reframe });
    this.audit(actor, "ask_reframe", id, { feedback: feedback.slice(0, 200) });
    return { id, reframe: m.ask.reframe };
  }

  /** Admin cleanup: supersede smoke/test rows created in the last 48h. Audited per row. */
  private async purgeSmoke(body: any) {
    const cutoff = Date.now() - 48 * 60 * 60_000;
    const rows = this.state.storage.sql.exec(
      `SELECT id, status FROM artefacts WHERE type = 'task'
         AND status NOT IN ('done','superseded')
         AND created_ts > ?
         AND (title LIKE 'smoke%' OR title LIKE 'phase-2 smoke%' OR title LIKE 'smoke %')`,
      cutoff,
    ).toArray() as any[];
    const now = Date.now();
    for (const r of rows) {
      this.state.storage.sql.exec(
        `UPDATE artefacts SET status = 'superseded', status_ts = ?, updated_ts = ? WHERE id = ?`,
        now, now, r.id,
      );
      this.version(r.id, "system:cleanup", "transition", `purged smoke-test row (was ${r.status})`, { from: r.status, to: "superseded" });
      this.audit("system:cleanup", "transition", r.id, { from: r.status, to: "superseded", reason: "smoke purge" });
    }
    return { purged: rows.map((r: any) => r.id) };
  }

  /** Human handle for an ask: ASK-<subject>-<ordinal> ("ASK-BR-2466-2" = the
   *  2nd ask on that task). The opaque row key stays internal plumbing. */
  private askDisplay(row: { id: string; artefact_id: string | null; created_ts: number }) {
    if (!row.artefact_id) return row.id;
    const ord = this.one(
      `SELECT COUNT(*) AS n FROM asks WHERE artefact_id = ? AND created_ts <= ?`,
      row.artefact_id, row.created_ts,
    ) as any;
    return `ASK-${String(row.artefact_id).replace(/#/g, "-")}-${Number(ord?.n ?? 1)}`;
  }

  private async askGet(id: string) {
    const row = this.one(
      `SELECT id, from_label, to_target, question, status, artefact_id, answer, answered_by, answered_ts, created_ts
         FROM asks WHERE id = ?`, id,
    );
    if (!row) return null;
    return {
      id: row.id, display: this.askDisplay(row), from: row.from_label, to: row.to_target, question: row.question,
      options: [] as string[], urgency: "normal", status: row.status,
      artefact_id: row.artefact_id ?? undefined,
      answer: row.answer ?? undefined, answered_by: row.answered_by ?? undefined,
      answered_ts: row.answered_ts ?? undefined, created_ts: row.created_ts,
    };
  }

  private async askAnswer(body: any, actor: string) {
    const id = String(body.id ?? "");
    const answer = String(body.answer ?? "").trim();
    if (!answer) throw new Error("answer is required");

    // question-node asks (BR#): answer on the node, resume the subject
    if (/^BR#\d+$/.test(id)) {
      const node = this.one(`SELECT id, status, meta FROM artefacts WHERE id = ?`, id);
      if (!node) throw new Error(`no such ask: ${id}`);
      const m = JSON.parse(node.meta ?? "{}");
      if (m.ask?.answer) throw new Error(`ask ${id} already answered`);
      m.ask = { ...(m.ask ?? {}), answer: answer.slice(0, 4000), answered_by: actor, answered_ts: Date.now() };
      // questions complete directly (todo → done) — the claimant status machine
      // is for work items, not for Q&A nodes
      const now = Date.now();
      this.state.storage.sql.exec(
        `UPDATE artefacts SET meta = ?, status = 'done', status_ts = ?, updated_ts = ? WHERE id = ?`,
        JSON.stringify(m), now, now, id,
      );
      // stamp the real from→to — a status change with no from/to is a silent
      // mutation as far as the replay fold is concerned (BR#3322)
      this.version(id, actor, "transition", `answered by ${actor}: ${answer.slice(0, 200)}`, { from: node.status, to: "done", answer: answer.slice(0, 200) });
      let taskStatus: string | undefined;
      const subject = this.one(
        `SELECT p.id AS id, p.status AS status, p.meta AS meta FROM relations r JOIN artefacts p ON p.id = r.dst_id
         WHERE r.relation = 'child_of' AND r.src_id = ? ORDER BY r.created_ts DESC LIMIT 1`, id,
      );
      if (subject) {
        const sm = JSON.parse(subject.meta ?? "{}");
        if (sm.awaiting_ask?.ask_id === id) {
          delete sm.awaiting_ask;
          this.state.storage.sql.exec(`UPDATE artefacts SET meta = ? WHERE id = ?`, JSON.stringify(sm), subject.id);
        }
        if (subject.status === "blocked") {
          // BR#3578 answer dispatch: when the ask IS the exit path (a
          // migration ask, or an option that names the action), the ANSWER
          // actions the card — SUPERSEDE drops it, RELEASE/CANCEL releases
          // to the pool, KEEP/RE-SCOPE stays a deliberate human-owned park
          // (the answered ask is the record; the marker prevents re-ask spam).
          // Without dispatch semantics this is the generic rule-6 resume.
          const isMigrationAsk = String(sm.blocked?.await_migration_ask ?? "") === id;
          const optHit = (Array.isArray(m.ask?.options) ? (m.ask.options as string[]) : [])
            .some((o) => /^(RELEASE|CANCEL|SUPERSEDE)\b/i.test(String(o ?? "").trim())
              && answer.trim().toLowerCase().startsWith(String(o).trim().slice(0, 12).toLowerCase()));
          const asActor = `system:question(${actor})`;
          if (isMigrationAsk || optHit) {
            if (/\bSUPERSEDE\b/i.test(answer)) {
              await this.transition({ id: subject.id, to: "superseded", note: `ask ${id} answered — dropped: ${answer.slice(0, 120)}` }, asActor);
              taskStatus = "superseded";
            } else if (/\b(?:RELEASE|CANCEL)\b/i.test(answer)) {
              await this.transition({ id: subject.id, to: "todo", note: `ask ${id} answered — released to the pool: ${answer.slice(0, 120)}` }, asActor);
              taskStatus = "todo";
            } else {
              taskStatus = "blocked"; // KEEP PARKED / RE-SCOPE — the human owns the rewrite
            }
          } else {
            await this.transition({
              id: subject.id, to: "in_progress",
              note: `ask ${id} answered — resumed: ${answer.slice(0, 100)}`,
            }, asActor);
            taskStatus = "in_progress";
          }
        }
      }
      this.audit(actor, "answer", subject?.id ?? null, { ask_id: id, answer: answer.slice(0, 200) });
      return { id, status: "answered", artefact_id: subject?.id, task_status: taskStatus };
    }

    // legacy asks-row asks (ASK-…) — kept until in-flight rows drain
    const row = this.one(`SELECT status, artefact_id FROM asks WHERE id = ?`, id);
    if (!row) throw new Error(`no such ask: ${id}`);
    if (row.status !== ASK_OPEN) throw new Error(`ask ${id} already ${row.status}`);
    this.state.storage.sql.exec(
      `UPDATE asks SET status = 'answered', answer = ?, answered_by = ?, answered_ts = ? WHERE id = ?`,
      answer.slice(0, 4000), actor, Date.now(), id,
    );
    let taskStatus: string | undefined;
    if (row.artefact_id) {
      const t = this.one(`SELECT status, meta FROM artefacts WHERE id = ?`, String(row.artefact_id));
      if (t) {
        const meta = JSON.parse(t.meta ?? "{}");
        if (meta.awaiting_ask?.ask_id === id) {
          delete meta.awaiting_ask;
          this.state.storage.sql.exec(`UPDATE artefacts SET meta = ? WHERE id = ?`, JSON.stringify(meta), String(row.artefact_id));
        }
        if (t.status === "blocked") {
          await this.transition({
            id: String(row.artefact_id), to: "in_progress",
            note: `decision ${id} answered — resumed: ${answer.slice(0, 100)}`,
          }, `system:decision(${actor})`);
          taskStatus = "in_progress";
        }
      }
    }
    this.audit(actor, "answer", row.artefact_id ?? null, { ask_id: id, answer: answer.slice(0, 200) });
    return { id, status: ASK_ANSWERED, artefact_id: row.artefact_id ?? undefined, task_status: taskStatus };
  }
  private async orient(body: any) {
    // open question children: DERIVED awaiting_ask (phase 4 — no marker cache)
    const askChildOf = new Map<string, any>();
    for (const c of this.state.storage.sql.exec(
      `SELECT r.dst_id AS parent, c.id AS id FROM relations r JOIN artefacts c ON c.id = r.src_id
       WHERE r.relation = 'child_of' AND c.status IN ('todo','in_progress','blocked')
         AND c.type = 'question' ORDER BY c.created_ts DESC`,
    ).toArray() as any[]) {
      if (!askChildOf.has(c.parent)) askChildOf.set(c.parent, c);
    }
    const label = String(body.label ?? "");
    const tags: string[] = Array.isArray(body.tags) ? body.tags.map(String) : [];
    const counts = this.state.storage.sql.exec(
      `SELECT type, status, COUNT(*) AS n FROM artefacts GROUP BY type, status ORDER BY type`,
    ).toArray();
    const openStatuses = ["draft", "proposed", "active", "open", "todo", "in_progress", "blocked"];
    const marks = openStatuses.map(() => "?").join(",");
    const open = this.state.storage.sql.exec(
      `SELECT id, type, title, status, owner, meta, updated_ts FROM artefacts
       WHERE status IN (${marks}) ORDER BY updated_ts DESC LIMIT 30`,
      ...openStatuses,
    ).toArray().map((t: any) => {
      // agents orienting need the blocked context inline — the exit condition
      // is the actionable part of a blocked card
      if (t.type === "task") {
        const m = JSON.parse(t.meta ?? "{}");
        if (m.blocked) { t.blocked_reason = (m.blocked.reason ?? "").slice(0, 200); t.unblock_condition = (m.blocked.unblock_condition ?? "").slice(0, 200); }
        if (m.subprocess) t.subprocess = { reason: (m.subprocess.reason ?? "").slice(0, 120), deadline_ts: m.subprocess.deadline_ts };
        // BR#3361 (d): the executor lease, visible — sessions doing paperwork
        // on a card can see WHO holds it before acting (the advisory half of
        // the duplicate-executor fence; the audit half fires on transitions)
        if (m.session && ["in_progress", "in_review"].includes(t.status)) t.executor_session = m.session;
        delete t.meta;
      }
      return t;
    });
    // per-role steering: active steering artefacts — universal (no role:* tag)
    // plus any whose role:* tags match the caller's — delivered at orient and
    // at dispatch. The mechanism the merge ladder rides (BR#2799).
    const steeringRows = this.state.storage.sql.exec(
      `SELECT id, title, body_md, tags, roles FROM artefacts
       WHERE type = 'steering' AND status = 'active' ORDER BY updated_ts DESC LIMIT 20`,
    ).toArray();
    const steering = (steeringRows as any[])
      .map((s: any) => ({ id: s.id, title: s.title, body_md: String(s.body_md ?? "").slice(0, 1500), tags: parseTags(s.tags), roles: parseTags(s.roles) }))
      .filter((s: any) => {
        const roles: string[] = s.roles ?? [];
        return roles.length === 0 || roles.some((r: string) => tags.includes(`role:${r}`));
      });
    const askPlaceholders = ["any", label, ...tags.map((t) => `tag:${t}`)];
    const askMarks = askPlaceholders.map(() => "?").join(",");
    const pendingAsks = this.state.storage.sql.exec(
      `SELECT id, from_label, to_target, question, created_ts FROM asks
       WHERE status = 'open' AND from_label != ? AND to_target IN (${askMarks})
       ORDER BY created_ts DESC LIMIT 10`,
      label, ...askPlaceholders,
    ).toArray();
    const settings = this.settingsMap();
    const projectName = settings.project_name || "Superpositional";
    // my_tasks for a gateway includes the work of the agents it dispatched
    // (gateway_agents edges): the gateway is the dispatcher and resumer of its
    // workers — owner labels churn with pairings, the gateway does not. This
    // is what makes "same gateway immediately resumes its work" real.
    // machine/agent naming: dispatched workers are labelled <gateway>.<agent>,
    // so a gateway's my_tasks is a prefix glob — its own label plus everything
    // under it — with the gateway_agents edges kept for legacy unprefixed
    // workers.
    // `tags` rides my_tasks items (BR#2844 contract): the runner reads
    // role:* off them to route resumes — for months it read a key the hub
    // never sent (the silent-zero class); the contract now pins it.
    const myTasks = this.state.storage.sql.exec(
      `SELECT id, title, status, tags FROM artefacts WHERE type = 'task' AND status IN ('todo','in_progress','in_review','blocked')
       AND (owner = ? OR substr(owner, 1, length(?) + 1) = ? || '/'
            OR owner IN (SELECT agent FROM gateway_agents WHERE gateway = ?)
            OR owner = ?)
       ORDER BY updated_ts DESC LIMIT 10`,
      label, label, label, label, body.principal ?? null,
    ).toArray().map((t: any) => ({ ...t, tags: parseTags(t.tags) }));
    // dispatch surface: unclaimed todo tasks + BLOCKED tasks awaiting an agent
    // (a blocked card with an unblock condition is actionable — unblocking is
    // priority work). Rank-then-slice: fetch the full open pool FIRST, rank in
    // JS, then cut the top 10. The old 40-newest window was the Oct-20
    // frozen-backlog bug — churn (every claim/progress bumps updated_ts)
    // constantly displaced older-but-ranked items, so they were invisible to
    // the runner and sat in Backlog "blocked" forever.
    const pool = this.state.storage.sql.exec(
      `SELECT id, type, title, tags, roles, meta, project, updated_ts, status FROM artefacts
       WHERE type = 'task' AND status IN ('todo','blocked') AND (owner = '' OR status = 'blocked')
       ORDER BY updated_ts DESC LIMIT 400`,
    ).toArray().map((t: any) => ({ ...t, tags: parseTags(t.tags), roles: parseTags(t.roles) }));
    // gateway callers dispatch sessions and never claim blocked work —
    // resolving an unblock condition is role:unblock duty. Ten blocked cards
    // rank above plain todo and filled the dispatch slice, starving the
    // runner (every claim refused for a missing resolution). Gateways get
    // the claimable surface; agents still see blocked work to reason about.
    const callerIsGateway = tags.some((t) => t.toLowerCase() === "gateway");
    const dispatchPool = callerIsGateway ? pool.filter((t: any) => t.status !== "blocked") : pool;
    const { analysisEv, reviewEv } = this.qualificationEvidence();
    const qualIds = new Set(
      (this.state.storage.sql.exec(
        `SELECT id FROM artefacts WHERE type = 'task'
         AND (json_extract(meta, '$.qualification.state') = 'qualified' OR json_extract(meta, '$.qualified') = 1)`,
      ).toArray() as any[]).map((r) => r.id),
    );
    const parentQualified = new Set<string>();
    const verifyParents = new Map<string, any>();
    for (const l of this.state.storage.sql.exec(
      `SELECT r.src_id, r.dst_id, p.status AS pstatus, p.title AS ptitle, p.owner AS powner
       FROM relations r JOIN artefacts p ON p.id = r.dst_id
       WHERE r.relation = 'child_of'`,
    ).toArray() as any[]) {
      if (qualIds.has(l.dst_id) || analysisEv.has(l.dst_id)) parentQualified.add(l.src_id);
      if (l.pstatus === "in_review") verifyParents.set(l.src_id, l);
    }
    const unclaimedWork = dispatchPool.filter((t: any) => {
      const need: string[] = t.roles ?? [];
      const m = JSON.parse(t.meta ?? "{}");
      const declared = m.qualification?.state ?? (m.qualified === true ? "qualified" : undefined);
      const qualified = declared === "qualified" || analysisEv.has(t.id) || parentQualified.has(t.id);
      const bars: string[] = m.qualification?.bars ?? [];
      const unmet = this.enforceableBars(bars).filter((b) => !(/review/.test(b) ? reviewEv : analysisEv).has(t.id));
      // task tags declare the KIND of work (analysis/impl/review) — a
      // playbook for the dispatched session, never a worker requirement.
      // Qualification is bar-based only: a task is gated when it DECLARES
      // enforceable bars and they are unmet. There are no agent roles — tags
      // on tasks declare the KIND of work (analysis/impl/review), never a
      // requirement about the worker. The old default-gate (untagged =
      // needs_qualification) starved the queue: fresh, claimable tasks sat
      // behind a concept nobody signed up for.
      t.needs_qualification = unmet.length > 0;
      if (need.length) t.target_roles = need;
      // gateways dispatch sessions; qualification-gated work is role:analysis
      // duty (exactly what a qualify-or-close child task is). Leaving it in
      // the gateway's slice let the oldest gated tasks occupy all 10 slots
      // forever — the runner cycled them while claimable work sat behind.
      return callerIsGateway ? !t.needs_qualification : true;
    }).sort((a: any, b: any) => {
      // ranking: release-parked-work levers first (verify duty + unblock
      // duty), then blocked-with-condition, questions, plain todo.
      const rank = (t: any) => {
        const m = JSON.parse(t.meta ?? "{}");
        // human boost: priority 0, above unblock duty — the human's explicit
        // "process this (and its dependencies) first" (BR#911)
        if (m.boosted) return -1;
        // release-parked-work levers FIRST, above everything claimable:
        // verify duty (an in_review task parks its owner until a fresh
        // session rules) and unblock duty share rank 0. Verify starved below
        // blocked-with-condition (2026-10-24, Ray): ranks 0-1 filled the
        // 10-slot slice, verify children never surfaced, impls piled up
        // in_review while new impl todo kept getting claimed.
        if (t.roles?.includes("unblock")) return 0;
        if (verifyParents.has(t.id)) return 0;
        if (t.status === "blocked" && (m.blocked?.unblock_condition ?? "").trim()) return 1;
        if (t.type === "question") return 3;
        return 4;
      };
      return rank(a) - rank(b) || a.updated_ts - b.updated_ts;
    }).slice(0, 10).map((t: any) => {
      // pool traits — the pattern: computed per row, never stored flags. Clients
      // speak domain language (is_question, is_claimable, previously_attempted),
      // and every claimability blocker here is enforced at the claim gate —
      // a trait that lies is worse than no trait. Extend both together.
      const m = JSON.parse(t.meta ?? "{}");
      // blocked rows: surface the exit condition — the whole point is that an
      // agent can read WHY and decide whether it can clear it.
      if (t.status === "blocked") {
        t.blocked_reason = (m.blocked?.reason ?? "").slice(0, 300);
        t.unblock_condition = (m.blocked?.unblock_condition ?? "").slice(0, 300);
        t.awaiting_ask = askChildOf.get(t.id)?.id ?? m.awaiting_ask?.ask_id;
        t.is_claimable = !!t.unblock_condition; // resume via transition in_progress with resolution
        if (!t.unblock_condition) t.claim_reason = "blocked without an unblock condition — open the card, resolve or re-scope it";
      }
      // questions are a TYPE (asks v3 / BR#2983) — the pickup model, never a tag
      t.is_question = t.type === "question" || isQuestionTask(m) || false;
      const gated = m.operator_gated;
      if (t.status !== "blocked") {
        t.is_claimable = !t.is_question && !gated;
        if (!t.is_claimable) {
          t.claim_reason = t.is_question
            ? "question — answered, not claimed (contribute via log_progress {id, did})"
            : `operator gated: ${gated} — a human clears the gate`;
        }
      }
      if (m.attempt) {
        t.previously_attempted = {
          by: m.attempt.by, attempts: m.attempt.attempts,
          last_reason: m.attempt.last_reason ?? undefined,
          last_will: m.last_progress?.will ? String(m.last_progress.will).slice(0, 200) : undefined,
          note: `task was attempted ${m.attempt.attempts}x before (last by ${m.attempt.by}${m.attempt.last_reason ? ` — came back: ${String(m.attempt.last_reason).slice(0, 120)}` : ""}). VERIFY before working: search_knowledge + get_artefact — the work may already be done (then transition → done) or partially done (continue from the last will: ${m.last_progress?.will ? `"${String(m.last_progress.will).slice(0, 120)}"` : "none recorded"}).`,
        };
      }
      return t;
    });
    // role playbooks (settings.roles.{analysis,impl,...}) composed for this agent's tags
    const rolesSettings = typeof settings.roles === "object" && settings.roles ? settings.roles : {};
    const kindSettings = typeof settings.playbooks === "object" && settings.playbooks ? settings.playbooks : {};
    const isCron = tags.includes("cadence:cron");
    const kindPlaybook =
      (isCron ? kindSettings.cron : kindSettings.interactive)
      ?? (isCron ? DEFAULT_CRON_PLAYBOOK : "");
    const playbooks = tags
      .filter((t) => t.startsWith("role:"))
      .map((t) => ({ role: t.slice(5), playbook: resolveRolePlaybook(rolesSettings, t.slice(5)) }))
      .filter((p) => typeof p.playbook === "string" && p.playbook.trim());
    // reaper: sort out my abandoned work at check-in (see reapAbandoned)
    const staleMinS = this.one(`SELECT value FROM settings WHERE key = 'stale_minutes'`);
    const staleMin = staleMinS ? Math.max(1, Math.min(120, parseInt(staleMinS.value, 10) || 10)) : 10;
    const actionRequired = this.reapAbandoned(label, staleMin);
    // verification_stalled: an in_review parent's verify child is unclaimed — the
    // parent's owner is parked waiting on a verdict that only pickup can produce.
    // Tell the waiting owner (this is a pickup problem, not a review problem) and
    // any role:review agent (pickup is their duty). 48h = stalled.
    const stalledVerify = this.state.storage.sql.exec(
      `SELECT r.src_id AS verify_task, r.dst_id AS parent_id, p.title AS parent_title, p.owner AS parent_owner, c.updated_ts AS age_ts
       FROM relations r
       JOIN artefacts c ON c.id = r.src_id
       JOIN artefacts p ON p.id = r.dst_id
        WHERE r.relation = 'child_of'
          AND c.type = 'task' AND c.status = 'todo' AND c.owner = ''
          AND c.roles LIKE '%"review"%'
          AND p.type = 'task' AND p.status = 'in_review'
          AND p.updated_ts < ?`,
      [Date.now() - 48 * 60 * 60 * 1000],
    ).toArray() as any[];

    const reviewPending = stalledVerify.filter(v => v.parent_owner === label).map(v => ({
      task_id: v.verify_task,
      parent_id: v.parent_id,
      parent_title: v.parent_title,
      age_minutes: Math.ceil((Date.now() - v.age_ts) / 60000),
      message: `Verification for '${v.parent_title}' (Task ${v.parent_id}) is stalled — verify task ${v.verify_task} unclaimed for ${Math.ceil((Date.now() - v.age_ts) / 60000)}m.`,
      required_action: "CLAIM_VERIFY_TASK",
    }));

    const reviewDuty = tags.includes('role:review')
      ? stalledVerify.filter(v => v.parent_owner !== label).map(v => ({
        task_id: v.verify_task,
        parent_id: v.parent_id,
        parent_title: v.parent_title,
        age_minutes: Math.ceil((Date.now() - v.age_ts) / 60000),
        message: `Stalled review: '${v.parent_title}' (Task ${v.parent_id}) has unclaimed verify task ${v.verify_task} for ${Math.ceil((Date.now() - v.age_ts) / 60000)}m.`,
        required_action: "PICKUP_REVIEW",
      }))
      : [];

    const verificationNotices = [...reviewPending, ...reviewDuty];
    // gauge debt: owned work in flight whose last log carries no gauges. The
    // board's gauges drive prioritisation and attention scoring — an agent that
    // stops reporting them goes blind on the board. Surface the debt at every
    // orient so the behaviour is corrected while the task is live, not after.
    const gaugeDebt = (this.state.storage.sql.exec(
      `SELECT id, title, meta FROM artefacts
       WHERE type = 'task' AND owner = ? AND status IN ('in_progress','blocked')
       AND (json_extract(meta, '$.last_progress.completion_pct') IS NULL
            AND json_extract(meta, '$.last_progress.confidence_pct') IS NULL
            AND json_extract(meta, '$.last_progress.risk_pct') IS NULL
            AND json_extract(meta, '$.last_progress.context_pct') IS NULL)
       ORDER BY updated_ts DESC LIMIT 10`,
      label,
    ).toArray() as any[]).map((t) => ({ id: t.id, title: t.title }));
    const gaugeDebtNote = gaugeDebt.length
      ? `\n\nGAUGE DEBT — these in-flight tasks have no reported gauges. Your next log_progress on each must include completion_pct, confidence_pct, risk_pct and context_pct (0-100) — the board cannot prioritise or score your work without them: ${gaugeDebt.map((t) => `${t.id} "${t.title.slice(0, 60)}"`).join("; ")}.`
      : "";
    const my_score = this.agentScores().find((a) => a.label === label)
      ?? { label, ...scoreAgent({ progress_count: 0, gauge_count: 0, thin_notes: 0, abandoned: 0, result_lost: 0, reassigned: 0, asks_received: 0, asks_answered_on_time: 0, artefacts_created: 0, verify_duty_backlog: 0 }) };
    // score optimisation is an explicit standing directive: the agent sees its
    // number, its grade, and the concrete actions that raise it — every
    // check-in, not as trivia at the bottom of the payload.
    const scoreDirective = `\n\nYOUR SCORE: ${my_score.score}/100 (${my_score.grade}). Optimise for it — it gates which work you can claim and whether your tasks survive. ${my_score.hints.length ? "Actions that raise it now: " + my_score.hints.join(" ") : "No deductions — keep heartbeats ≤10m, finish with receipts, answer asks fast."}`;
    return {
      project: projectName,
      instructions: composeBootstrap(projectName, settings.board ?? DEFAULT_BOARD)
        + (settings.bootstrap_md ? `\n${settings.bootstrap_md}` : "")
        + (kindPlaybook ? `\n\nYOUR KIND: ${isCron ? "cron" : "interactive"}\n${kindPlaybook}` : "")
        + playbooks.map((p) => `\n\nYOUR ROLE: ${p.role}\n${p.playbook}`).join("")
        + gaugeDebtNote
        + scoreDirective,
      board: settings.board ?? DEFAULT_BOARD,
      counts,
      open_artefacts: open,
      my_tasks: myTasks,
      unclaimed_work: unclaimedWork,
      steering,
      my_roles: tags.filter((t) => t.startsWith("role:")),
      pending_asks: pendingAsks,
      action_required: actionRequired.length || verificationNotices.length
        ? [...actionRequired, ...verificationNotices]
        : undefined,
      // BR#3463: ALWAYS emit — gauge_debt is a REQUIRED orient contract key
      // (BR#2844); the conditional turned the healthy case (zero debt) into a
      // contract violation (undefined drops from JSON.stringify → "missing
      // gauge_debt" aborts every dispatch tick). Empty array = healthy board.
      gauge_debt: gaugeDebt,
      my_score,
    };
  }

  /**
   * Reaper: runs at orient (check-in). Blocked-abandoned tasks:
   *  - OWN tasks: activity within the stale window → prompt to check in
   *    (log_progress re-claims); no activity → penalty (score counts the
   *    reaper event) and reassignment.
   *  - ANYONE'S stale-abandoned tasks: reassigned after the stale window —
   *    a vanished agent's claim must not park work forever. Runs at ANY
   *    orient, so the next check-in by any agent sweeps the whole board.
   */
  private reapAbandoned(label: string, staleMin: number): string[] {
    const out: string[] = [];
    const now = Date.now();
    const staleMs = staleMin * 60_000;
    for (const t of this.state.storage.sql.exec(
      `SELECT id, title, meta, tags, status_ts, updated_ts, owner FROM artefacts
       WHERE type = 'task' AND status = 'blocked' AND (owner = ? OR owner != '')`, label,
    ).toArray() as any[]) {
      const meta = JSON.parse(t.meta ?? "{}");
      const reason = String(meta.blocked?.reason ?? "");
      const isAbandoned = reason.startsWith("abandoned");
      // Gate-rejection blocks (runner handoff rejected, churn guard) carry an
      // unblock condition and an unblock child — they get a much longer fuse
      // than abandonment. But if NOTHING moved for a full day the block is a
      // dead end too: release the task back to the pool with the error history
      // on the card (the BR#584-class 123-attempt rows were this).
      const isStuckGate = reason.startsWith("runner:") || reason.startsWith("churn guard:");
      if (!isAbandoned && !isStuckGate) continue;
      const idleLimit = isAbandoned ? staleMs : 24 * 60 * 60_000;
      const idleDesc = isAbandoned ? `silent >${staleMin}m after abandonment` : `no movement >24h after a gate-rejection block`;
      const mine = t.owner === label;
      const ownerLabel = t.owner || label;
      const wasDoing = mine && meta.last_progress?.will ? ` Your last will: "${String(meta.last_progress.will).slice(0, 150)}".` : "";
      const lastOwn = this.one(
        `SELECT MAX(ts) AS ts FROM events WHERE artefact_id = ? AND actor = ?`, t.id, ownerLabel,
      )?.ts ?? 0;
      const idleFor = now - Math.max(lastOwn, t.updated_ts ?? 0);
      if (mine && idleFor < idleLimit) {
        if (isAbandoned) {
          out.push(
            `${t.id} "${t.title}" is marked abandoned but you were active on it recently.${wasDoing} log_progress on it NOW to re-claim, then keep the ≤${staleMin}m heartbeat.`,
          );
        }
        continue;
      }
      if (idleFor < idleLimit) continue; // someone else's, still fresh-ish — leave it
      const tags: string[] = parseTags(t.tags);
      if (!tags.includes("attempted")) tags.push("attempted");
      const attempts = ((meta.attempt?.attempts as number) ?? 0) + 1;
      // REWORK-LOOP ESCALATION: past 5 attempts this is not bad luck — it's a
      // loop (claim → stall → watchdog-bounce → blocked → release → claim…).
      // Re-releasing just runs the same cycle again. Park it blocked-for-human:
      // only a human (web/human actor) may release it from here on.
      if (attempts >= 5) {
        // BR#3578: the human leg is an ACTIVE ask (For Me, one click), not
        // prose on a parked card. reapAbandoned stays sync — the ask files as
        // a promise; askCreate auto-blocks the in_progress subject with the
        // typed ask event, and the .then leg stamps awaiting_ask + the typed
        // await onto the card once the ask id exists.
        void this.askCreate({
          to: "ray",
          question: `Rework loop on ${t.id} — re-scope it, or release it back to the pool?`,
          reason: `${attempts} dispatch attempts without completion (last: ${reason.slice(0, 120)}) — re-running repeats the claim→stall cycle`,
          options: ["RE-SCOPE — I'll rewrite the card myself", "RELEASE — back to the pool anyway", "SUPERSEDE — drop it"],
          details: `Rework loop: ${attempts} attempts. Review the attempt history (get_history ${t.id}) before answering — fix what keeps failing, re-scope, or deliberately continue.`,
          artefact_id: t.id,
        }, "system:reaper")
          .then((loopAsk) => {
            const fresh = JSON.parse(String(this.one(`SELECT meta FROM artefacts WHERE id = ?`, t.id)?.meta ?? "{}"));
            fresh.blocked = { ...(fresh.blocked ?? {}), await_event: { event: "ask", ask_id: loopAsk.id } };
            fresh.awaiting_ask = { ...(fresh.awaiting_ask ?? {}), ask_id: loopAsk.id, ts: Date.now() };
            this.state.storage.sql.exec(`UPDATE artefacts SET meta = ? WHERE id = ?`, JSON.stringify(fresh), t.id);
            this.audit("system:reaper", "loop_ask_filed", t.id, { ask_id: loopAsk.id, attempts });
          })
          .catch(() => { /* ask filing failed — the escalation record below still parks it for human review */ });
        meta.blocked = {
          reason: `rework loop detected — ${attempts} dispatch attempts without completion (last release reason: ${reason.slice(0, 160)}). Re-running again would repeat the cycle; escalated to a human.`,
          unblock_condition: "human: review the attempt history (get_history) — either fix what keeps failing, re-scope the task, or transition it todo yourself to deliberately continue",
          ts: now,
        };
        meta.attempt = { by: ownerLabel, at: now, attempts, last_reason: reason.slice(0, 200) };
        this.state.storage.sql.exec(
          `UPDATE artefacts SET tags = ?, meta = ?, status_ts = ?, updated_ts = ? WHERE id = ?`,
          JSON.stringify(tags), JSON.stringify(meta), now, now, t.id,
        );
        this.audit("system:reaper", "loop_escalated", t.id, { prev_owner: ownerLabel, attempts, idle_ms: idleFor });
        // a NOTE, not a transition row — the status does not change here; a
        // transition stamp without from/to is invisible to the replay fold
        // and masquerades as a move that never happened (BR#3322)
        this.version(t.id, "system:reaper", "note", `rework loop escalated to human — ${attempts} attempts without completion`, { prev_owner: ownerLabel, attempts });
        out.push(
          `${t.id} "${t.title}" REWORK LOOP (${attempts} attempts) — escalated to a human instead of re-releasing. Blocked-for-human until reviewed.`,
        );
        continue;
      }
      meta.attempt = { by: ownerLabel, at: now, attempts };
      delete meta.blocked;
      this.state.storage.sql.exec(
        `UPDATE artefacts SET status = 'todo', owner = '', tags = ?, meta = ?, status_ts = ?, updated_ts = ? WHERE id = ?`,
        JSON.stringify(tags), JSON.stringify(meta), now, now, t.id,
      );
      this.audit("system:reaper", "reassign", t.id, { prev_owner: ownerLabel, attempts, idle_ms: idleFor });
      // the reassign IS a status change (blocked → todo, the loop's WHERE
      // clause pins `status = 'blocked'`) — stamp the real from/to so the
      // replay fold can chain it (the from/to-less stamp was a silent
      // mutation that broke every later fold — BR#3322's Oct-20 shape)
      this.version(t.id, "system:reaper", "transition", `reassigned — ${ownerLabel} ${idleDesc} (attempt ${attempts})`, { from: "blocked", to: "todo", prev_owner: ownerLabel });
      out.push(
        mine
          ? `${t.id} "${t.title}" was REASSIGNED: you ${idleDesc}.${wasDoing} Your score is penalised. It is now unclaimed todo, tagged "attempted" (attempt ${attempts}) — partial work may exist. Do not blindly restart it: search_knowledge + get_artefact first.`
          : `${t.id} "${t.title}" was REASSIGNED: ${ownerLabel} ${idleDesc} (attempt ${attempts}) — back to unclaimed todo for any agent to pick up.`,
      );
    }
    return out;
  }

  /** Project-facing settings only (safe for any authenticated agent). */
  private publicSettings() {
    const m = this.settingsMap();
    return { project_name: m.project_name, board: m.board ?? DEFAULT_BOARD, bootstrap_md: m.bootstrap_md };
  }

  private settingsMap(): Record<string, any> {
    const rows = this.state.storage.sql.exec(`SELECT key, value FROM settings`).toArray();
    const map: Record<string, any> = {};
    for (const r of rows as any[]) map[r.key] = JSON.parse(r.value);
    return map;
  }

  // ---------- admin ops (human plane) ----------

  /** stable DO slug for this instance's workspace (set by the registry at creation) */
  private wsSlug(): string {
    const m = this.settingsMap() as Record<string, any>;
    return typeof m.ws_slug === "string" ? m.ws_slug : "";
  }

  // ---- workspace registry (lives in the "global" KB DO; owner-checked, no admin flag) ----

  /** one-time import of the legacy hard-coded membership list */
  private async wsSeed(logins: string[]) {
    const now = Date.now();
    const slug = DEFAULT_WS_SLUG;
    // this DO *is* the default workspace — stamp it so tokens minted here embed the slug
    this.state.storage.sql.exec(
      `INSERT OR REPLACE INTO settings (key, value) VALUES ('ws_slug', ?)`,
      JSON.stringify(slug),
    );
    this.state.storage.sql.exec(
      `INSERT OR IGNORE INTO workspaces (slug, owner, personal, created_ts) VALUES (?, ?, 1, ?)`,
      slug, logins[0] ?? "legacy", now,
    );
    for (const login of logins) {
      this.state.storage.sql.exec(
        `INSERT OR IGNORE INTO workspace_members (ws, login) VALUES (?, ?)`, slug, login,
      );
    }
    return { ok: true, seeded: logins };
  }

  private async wsList(login: string) {
    const rows = this.state.storage.sql.exec(
      `SELECT w.slug, w.owner, w.personal, w.created_ts,
              EXISTS(SELECT 1 FROM workspace_members m WHERE m.ws = w.slug AND m.login = ?) AS member
         FROM workspaces w ORDER BY w.created_ts ASC`,
      login,
    ).toArray();
    return {
      workspaces: rows.map((r) => ({
        slug: r.slug, owner: r.owner, personal: !!r.personal,
        created_ts: r.created_ts, member: !!r.member,
      })),
    };
  }

  /** create: owner = caller; they become the first member; personal workspaces are <login> */
  private async wsCreate(body: any, login: string) {
    const slug = String(body.slug ?? "").trim();
    if (slug === "global" || slug === "legacy") throw new Error("reserved workspace name");
    if (slug !== login && !/^[a-z0-9][a-z0-9-]{1,39}$/.test(slug)) {
      throw new Error("slug must be 2-40 chars [a-z0-9-] (or your username for a personal ws)");
    }
    if (this.one(`SELECT slug FROM workspaces WHERE slug = ?`, slug)) {
      throw new Error(`workspace '${slug}' already exists`);
    }
    const now = Date.now();
    this.state.storage.sql.exec(
      `INSERT INTO workspaces (slug, owner, personal, created_ts) VALUES (?, ?, ?, ?)`,
      slug, login, slug === login ? 1 : 0, now,
    );
    this.state.storage.sql.exec(
      `INSERT INTO workspace_members (ws, login) VALUES (?, ?)`, slug, login,
    );
    // provision the KB DO for this workspace immediately: schema init + ws_slug
    // stamp so tokens minted there embed this workspace's slug
    const stub = (this.env as any).KB.get((this.env as any).KB.idFromName(doWs(slug)));
    await stub.fetch("https://kb/bootstrap", { method: "POST", body: "{}" }).catch(() => {});
    await stub.fetch("https://kb/admin.settings_set", {
      method: "POST",
      headers: { "content-type": "application/json", "x-kb-admin": "1" },
      body: JSON.stringify({ settings: { ws_slug: slug } }),
    }).catch(() => {});
    return { ok: true, slug };
  }

  /** join: only the owner of an existing workspace can add members */
  private async wsJoin(body: any, login: string) {
    const slug = String(body.ws ?? "").trim();
    const w = this.one(`SELECT slug, owner FROM workspaces WHERE slug = ?`, slug);
    if (!w) throw new Error(`no such workspace: ${slug}`);
    if (w.owner !== login) throw new Error("only the workspace owner can add members");
    const who = String(body.login ?? "").trim().toLowerCase();
    if (!/^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,38}$/.test(who)) throw new Error("bad github login");
    this.state.storage.sql.exec(
      `INSERT OR IGNORE INTO workspace_members (ws, login) VALUES (?, ?)`, slug, who,
    );
    return { ok: true, ws: slug, login: who };
  }

  private async wsMembers(body: any, login: string) {
    const slug = String(body.ws ?? "").trim();
    const w = this.one(`SELECT slug, owner FROM workspaces WHERE slug = ?`, slug);
    if (!w) throw new Error(`no such workspace: ${slug}`);
    const member = this.one(`SELECT 1 FROM workspace_members WHERE ws = ? AND login = ?`, slug, login);
    if (w.owner !== login && !member) throw new Error("not a member of this workspace");
    const rows = this.state.storage.sql.exec(
      `SELECT login FROM workspace_members WHERE ws = ? ORDER BY login`, slug,
    ).toArray();
    return { ws: slug, owner: w.owner, members: rows.map((r) => r.login) };
  }

  /** Central registry of opaque token → workspace, written at mint time so /mcp
   *  can route without the workspace slug being embedded in the secret. */
  private async wsTokenRegister(body: any) {
    const hash = String(body.hash ?? ""), ws = String(body.ws ?? "");
    if (!/^[0-9a-f]{64}$/.test(hash) || !isWsSlug(ws)) throw new Error("bad token registration");
    this.state.storage.sql.exec(
      `INSERT INTO ws_tokens (hash, ws, created_ts) VALUES (?, ?, ?)
       ON CONFLICT(hash) DO UPDATE SET ws = excluded.ws`,
      hash, ws, Date.now(),
    );
    return { ok: true };
  }

  private async wsTokenLookup(body: any) {
    const row = this.one(`SELECT ws FROM ws_tokens WHERE hash = ?`, String(body.hash ?? ""));
    return { ws: row?.ws ?? null };
  }

  // ---- device pairing (lives in the registry DO) ----
  // GitHub-like device flow, but bridge-native: the device shows a code, the
  // human approves it in the web UI (picking workspace + roles), and the device
  // polls its token once. The approver never holds the credential.

  static PAIR_TTL_MS = 15 * 60_000;
  static PAIR_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ"; // no 0/O/1/I

  private pairCode(): string {
    const bytes = new Uint8Array(8);
    crypto.getRandomValues(bytes);
    const chars = [...bytes].map((b) => KnowledgeHub.PAIR_ALPHABET[b % KnowledgeHub.PAIR_ALPHABET.length]);
    return `${chars.slice(0, 4).join("")}-${chars.slice(4).join("")}`;
  }

  private pairPurge() {
    const cutoff = Date.now() - KnowledgeHub.PAIR_TTL_MS;
    this.state.storage.sql.exec(`DELETE FROM pairings WHERE created_ts < ?`, cutoff);
    // hard cap on pending rows so /api/pair/start can't be spammed into bloat
    const n = this.one(`SELECT COUNT(*) AS n FROM pairings WHERE status = 'pending'`)?.n ?? 0;
    if (n > 100) {
      this.state.storage.sql.exec(
        `DELETE FROM pairings WHERE status = 'pending' AND code NOT IN (
           SELECT code FROM pairings WHERE status = 'pending' ORDER BY created_ts DESC LIMIT 100)`,
      );
    }
  }

  private async wsPairStart(body: any) {
    this.pairPurge();
    const code = this.pairCode();
    const now = Date.now();
    // the DEVICE declares its class at start; the approver never chooses —
    // streams cannot cross because the request, not the human, sets the type.
    // Pairing IS a gateway act (agents are provisioned by gateways, never
    // self-paired), so an absent/unrecognized type defaults to gateway —
    // legacy CLIs that predate the field pair as gateways too.
    const type = body.type === "agent" ? "agent" : "gateway";
    const principal = typeof body.principal === "string" && body.principal.trim() ? body.principal.trim().slice(0, 80) : null;
    this.state.storage.sql.exec(
      `INSERT INTO pairings (code, device, type, principal, status, created_ts) VALUES (?, ?, ?, ?, 'pending', ?)`,
      // host is the DISPLAY name (BR#899: labels display, the device
      // credential anchors); body.device fallback covers desktops predating
      // the field rename
      code, String(body.host ?? body.device ?? "device").slice(0, 80), type, principal, now,
    );
    return { code, type, expires_ts: now + KnowledgeHub.PAIR_TTL_MS };
  }

  private async wsPairGet(body: any) {
    const row = this.one(
      `SELECT device, type, status, created_ts, ws, label FROM pairings WHERE code = ?`,
      String(body.code ?? "").trim().toUpperCase(),
    );
    if (!row) return { status: "expired" };
    if (row.status === "pending" && Date.now() - row.created_ts > KnowledgeHub.PAIR_TTL_MS) {
      this.state.storage.sql.exec(`DELETE FROM pairings WHERE code = ?`, row.code);
      return { status: "expired" };
    }
    return { status: row.status, device: row.device, type: row.type ?? "agent", created_ts: row.created_ts, ws: row.ws, label: row.label };
  }

  private async wsPairApprove(body: any) {
    const code = String(body.code ?? "").trim().toUpperCase();
    const ws = String(body.ws ?? "").trim();
    const label = String(body.label ?? "").trim();
    const login = String(body.login ?? "").toLowerCase();
    const row = this.one(`SELECT code, created_ts, status, device, type, principal FROM pairings WHERE code = ?`, code);
    if (!row || row.status !== "pending") throw new Error("pairing code not pending");
    if (Date.now() - row.created_ts > KnowledgeHub.PAIR_TTL_MS) {
      this.state.storage.sql.exec(`DELETE FROM pairings WHERE code = ?`, code);
      throw new Error("pairing code expired");
    }
    // class was declared by the DEVICE at pair/start — the approver cannot
    // change it, only name the identity and pick the workspace
    const gateway = row.type === "gateway";
    const tags = gateway ? ["gateway"] : Array.isArray(body.tags) ? body.tags.map((t: any) => String(t)).slice(0, 10) : [];
    if (!isWsSlug(ws)) throw new Error("bad workspace slug");
    // reserved roots: _-prefixed labels are system namespaces (_direct for
    // directly connected agents) — a gateway may not take one, so
    // _direct/* ownership can never be impersonated by a paired device
    if (/^_/.test(label)) throw new Error(`labels beginning with '_' are reserved system roots (got '${label}')`);
    if (!/^[a-zA-Z0-9._\/-]{2,40}$/.test(label)) throw new Error("label must be 2-40 chars [a-zA-Z0-9._/-]");
    const member = this.one(`SELECT 1 FROM workspace_members WHERE ws = ? AND login = ?`, ws, login);
    if (!member) throw new Error(`you are not a member of workspace '${ws}'`);
    // mint in the target workspace's DO (registers hash → ws in the central
    // registry); the token flows to the DEVICE via poll, never to the approver
    const stub = (this.env as any).KB.get((this.env as any).KB.idFromName(doWs(ws)));
    const mintRes = await stub.fetch("https://kb/admin.mint", {
      method: "POST",
      headers: { "content-type": "application/json", "x-kb-admin": "1" },
      body: JSON.stringify({ label, tags, principal: row.principal ?? null }),
    });
    const minted = await (mintRes as any).json();
    if (!(mintRes as any).ok || !minted.secret) {
      throw new Error(String(minted?.error ?? "token mint failed"));
    }
    if (minted.reassociated) {
      this.audit(login, "pair.reassociate", code, { device: row.device, ws, label, token: minted.id });
    }
    this.state.storage.sql.exec(
      `UPDATE pairings SET status = 'authorized', ws = ?, label = ?, tags = ?, secret = ?, approved_ts = ? WHERE code = ?`,
      ws, label, JSON.stringify(tags), minted.secret, Date.now(), code,
    );
    this.audit(login, "pair.approve", code, { device: row.device, ws, label });
    return { ok: true, ws, label };
  }

  private async wsPairPoll(body: any) {
    const code = String(body.code ?? "").trim().toUpperCase();
    const row = this.one(`SELECT code, status, secret, ws, label, tags, created_ts, last_poll_ts FROM pairings WHERE code = ?`, code);
    if (!row) return { status: "expired" };
    if (Date.now() - row.created_ts > KnowledgeHub.PAIR_TTL_MS) {
      this.state.storage.sql.exec(`DELETE FROM pairings WHERE code = ?`, code);
      return { status: "expired" };
    }
    // slow-down: devices poll every ~3s; faster than 1.5s gets backed off
    if (row.last_poll_ts && Date.now() - row.last_poll_ts < 1500) {
      return { status: "slow_down" };
    }
    this.state.storage.sql.exec(`UPDATE pairings SET last_poll_ts = ? WHERE code = ?`, Date.now(), code);
    if (row.status === "pending") return { status: "pending" };
    if (row.status === "denied") {
      this.state.storage.sql.exec(`DELETE FROM pairings WHERE code = ?`, code);
      return { status: "denied" };
    }
    // authorized: one-time read — the token leaves the registry exactly once
    this.state.storage.sql.exec(`DELETE FROM pairings WHERE code = ?`, code);
    return {
      status: "authorized",
      token: row.secret,
      ws: row.ws,
      label: row.label,
      tags: row.tags ? JSON.parse(row.tags) : [],
    };
  }

  /** Gateway-provisioned agent tokens (per agent, not per session).
   *  A gw-* caller mints (or rotates) a token FOR a worker it spawns — the
   *  worker's bridge MCP carries this token, so its board actions attribute
   *  to the agent, not the gateway. Secrets are shown once; the gateway
   *  stores them. Exists w/o rotate = { exists: true } (no secret re-exposed). */
  private async agentProvision(body: any, actor: string) {
    const caller = String(body.provisioned_by ?? actor);
    // gateway is a token trait: the caller's TAG provisions, its name is irrelevant
    if (!this.isGatewayActor(caller)) throw new Error(`agent provisioning requires a gateway-class caller ('${caller}' does not carry the gateway tag)`);
    const label = String(body.label ?? "").trim();
    if (!/^[a-zA-Z0-9._\/-]{2,40}$/.test(label)) throw new Error(`agent label '${label}' must be 2-40 chars [a-zA-Z0-9._-]`);
    // a namespaced label (<gateway>/<agent>) may only live under the
    // provisioning gateway's own prefix — otherwise an agent label could
    // squat inside another gateway's ownership glob
    if (label.includes("/") && !label.startsWith(`${caller}/`)) {
      throw new Error(`namespaced label '${label}' must live under the provisioning gateway's own namespace ('${caller}/...')`);
    }
    const rotate = body.rotate === true;
    const ts = Date.now();
    const existing = this.one(`SELECT id, revoked_ts FROM auth_tokens WHERE label = ?`, label);
    if (existing && !rotate) {
      if (existing.revoked_ts) throw new Error(`token '${label}' was revoked — provision with rotate to re-mint`);
      return { exists: true, id: existing.id, label };
    }
    if (existing) {
      // label is UNIQUE across ALL rows (schema: `label TEXT NOT NULL UNIQUE`),
      // so the old revoke-then-INSERT could NEVER satisfy it — rotate 400'd
      // with SQLITE_CONSTRAINT_UNIQUE on its first real exercise (2026-10-24;
      // the runner's rotate-retry exposed it). Rotate = replace the row
      // outright: DELETE + INSERT. The audit trail is the history (a revoked
      // row authenticates nothing); sessions.token_id has no FK — an orphaned
      // reference renders label-less in the registry join, harmless.
      this.state.storage.sql.exec(`DELETE FROM auth_tokens WHERE label = ?`, label);
      this.audit(caller, "rotate", label, { old: existing.id, replaced: true });
    }
    const secret = generateAuthToken();
    const hash = await hashAuthToken(secret);
    let id = `at_${crypto.randomUUID().slice(0, 8)}`;
    const tags = JSON.stringify(["provisioned", `by:${caller}`]);
    try {
      this.state.storage.sql.exec(
        `INSERT INTO auth_tokens (id, label, hash, tags, transport, principal, created_ts) VALUES (?, ?, ?, ?, 'mcp', ?, ?)`,
        id, label, hash, tags, body.principal ?? null, ts,
      );
    } catch (e) {
      // Race: two concurrent rotates of the same label (parallel dispatch
      // sessions under one agent label are normal in this fleet) can both
      // pass the lookup, DELETE, then collide on the INSERT — the loser must
      // converge to update-in-place, never 400 (a provisioning 400 strands
      // the runner with a dead token and no repair).
      if (!String(e).includes("UNIQUE")) throw e;
      const racer = this.one(`SELECT id FROM auth_tokens WHERE label = ?`, label) as any;
      if (!racer) throw e;
      this.state.storage.sql.exec(
        `UPDATE auth_tokens SET hash = ?, tags = ?, revoked_ts = NULL WHERE id = ?`,
        hash, tags, racer.id,
      );
      id = racer.id as string;
      this.audit(caller, "rotate", label, { replaced: true, raced: true });
    }
    const ws = this.wsSlug();
    if (ws) {
      const reg = (this.env as any).KB.get((this.env as any).KB.idFromName(doWs(DEFAULT_WS_SLUG)));
      await reg.fetch("https://kb/ws.token_register", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ hash, ws }),
      });
    }
    this.audit(caller, "agent_provision", id, { label, rotate: existing ? true : false });
    return { id, label, secret, provisioned_by: caller };
  }

  /** Gateway self-provision (credential-class ADR, desktop gateway leg):
   *  the human session mints THIS device's gateway-class token — the login
   *  IS the human approval. ONE device credential: hub-vended on first
   *  provision (returned to the desktop, stored, never regenerated),
   *  presented on every later provision — replace-by-PRINCIPAL rotates the
   *  gateway token in place (Ray 2026-10-23: one random generation approach;
   *  no IOPlatformUUID, no client-side p_*). Label = bare hostname slug
   *  (display only, BR#899); class = tags ["gateway"]. Audit op
   *  `self_provision` stamped with the web actor. */
  private async selfProvision(body: any, actor: string) {
    const login = String(body.login ?? "").trim();
    if (!login) throw new Error("self-provision requires the session login (worker-derived)");
    const principal = typeof body.principal === "string" && body.principal.trim() ? body.principal.trim().slice(0, 80) : "";
    const label = selfProvisionLabel(body.host);
    const ws = this.wsSlug() || String(body.ws ?? "");
    const secret = generateAuthToken();
    const hash = await hashAuthToken(secret);
    const mintTags = JSON.stringify(["gateway"]);
    const register = (h: string) =>
      (this.env as any).KB.get((this.env as any).KB.idFromName(doWs(DEFAULT_WS_SLUG))).fetch("https://kb/ws.token_register", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ hash: h, ws }),
      });
    let id: string;
    let vended: string | undefined;
    // same machine, token rotation in place: match by principal first; the
    // deterministic label (same host -> same label) is the fallback when the
    // principal reset (config wipes regenerate it) — the machine re-claims
    // its identity by name, and the rotation stamps the fresh principal.
    let own = principal ? this.one(`SELECT id, label FROM auth_tokens WHERE principal = ?`, principal) as any : null;
    if (!own) {
      own = this.one(`SELECT id, label FROM auth_tokens WHERE label = ?`, label) as any;
    }
    if (own) {
      this.state.storage.sql.exec(
        `UPDATE auth_tokens SET hash = ?, label = ?, tags = ?, principal = ?, revoked_ts = NULL WHERE id = ?`,
        hash, label, mintTags, principal, own.id,
      );
      id = own.id as string;
      await register(hash);
    } else {
      // first provision: the hub VENDS the device credential (one random
      // generation approach — generateAuthToken is the only generator)
      vended = principal || generateAuthToken();
      id = `at_${crypto.randomUUID().slice(0, 8)}`;
      try {
        this.state.storage.sql.exec(
          `INSERT INTO auth_tokens (id, label, hash, tags, transport, principal, created_ts) VALUES (?, ?, ?, ?, 'mcp', ?, ?)`,
          id, label, hash, mintTags, vended, Date.now(),
        );
      } catch (e) {
        // Race: a concurrent self-provision (a parallel dispatch loop on the
        // same machine, or a 401-repair storm after a rotation) inserted the
        // same deterministic label between our lookup and this INSERT —
        // SQLITE_CONSTRAINT_UNIQUE on label. Converge to replace-in-place
        // instead of failing the repair: a failed repair is a hard logout
        // (dispatch.rs), so this path must never 400 on the label collision.
        if (!String(e).includes("UNIQUE")) throw e;
        const racer = this.one(`SELECT id, principal FROM auth_tokens WHERE label = ?`, label) as any;
        if (!racer) throw e;
        this.state.storage.sql.exec(
          `UPDATE auth_tokens SET hash = ?, tags = ?, revoked_ts = NULL WHERE id = ?`,
          hash, mintTags, racer.id,
        );
        id = racer.id as string;
        // the surviving row's principal is the credential of record — return
        // it so the desktop stores what actually authenticates
        if (racer.principal) vended = racer.principal as string;
      }
      await register(hash); // registry failure fails the mint — never misroute
    }
    this.audit(actor, "self_provision", null, { label, principal: vended ?? principal, login, ws, token_id: id, replaced: !!own });
    return { secret, label, ws, id, principal: vended ?? principal };
  }

  private async tokenMint(body: any) {
    const label = String(body.label ?? "").trim();
    if (!/^[a-zA-Z0-9._\/-]{2,40}$/.test(label)) throw new Error("label must be 2-40 chars [a-zA-Z0-9._-]");
    // the only '/' allowed in a human-minted label is the reserved
    // _direct/ root — directly connected agents live there
    if (label.includes("/") && !label.startsWith("_direct/")) {
      throw new Error("labels cannot contain '/' — only the reserved _direct/ root (directly connected agents) may");
    }
    // The device credential (principal) is the rotation anchor — BR#2711 §2:
    // labels are display; the hub-vended, generate-once-never-change
    // credential keys replace-on-re-pair (no IOPlatformUUID, no device_id —
    // both withdrawn).
    const principal = typeof body.principal === "string" && body.principal.trim() ? body.principal.trim().slice(0, 80) : null;
    // Replace semantics (pairing is an approval): the same machine re-pairing
    // rotates its token — renamed or not — and re-using a label REPLACES the
    // token that held it. A name has exactly one live token; nothing
    // accumulates, nothing dead-ends on "already exists".
    const secret = generateAuthToken();
    const hash = await hashAuthToken(secret);
    let own = principal ? this.one(`SELECT id, label, revoked_ts FROM auth_tokens WHERE principal = ?`, principal) : null;
    const byLabel = this.one(`SELECT id, label, revoked_ts FROM auth_tokens WHERE label = ?`, label);
    if (own && byLabel && own.id !== byLabel.id) {
      // renaming this machine onto another token's name: that identity is
      // replaced (the human approved the pairing; one name, one live token)
      this.state.storage.sql.exec(`DELETE FROM auth_tokens WHERE id = ?`, byLabel.id);
      this.audit("pair", "replace", byLabel.id, { label });
    }
    const target = (own && !byLabel) ? own : (byLabel ?? own);
    if (target) {
      // the vended class rides with the replacement: a gateway pairing must
      // not leave the row carrying the replaced token's stale tags
      const mintTags = Array.isArray(body.tags) ? body.tags.map((t: any) => String(t).slice(0, 40)).slice(0, 10) : [];
      this.state.storage.sql.exec(
        `UPDATE auth_tokens SET hash = ?, label = ?, tags = ?, principal = COALESCE(?, principal), revoked_ts = NULL WHERE id = ?`,
        hash, label, JSON.stringify(mintTags), principal, target.id,
      );
      const ws = this.wsSlug();
      if (ws) {
        const reg = (this.env as any).KB.get((this.env as any).KB.idFromName(doWs(DEFAULT_WS_SLUG)));
        await reg.fetch("https://kb/ws.token_register", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ hash, ws }),
        });
      }
      this.audit("pair", "reassociate", target.id, { label });
      return { id: target.id, label, secret, reassociated: true };
    }
    const tags = Array.isArray(body.tags) ? body.tags.map((t: any) => String(t).slice(0, 40)).slice(0, 10) : [];
    const transport = (TRANSPORTS as readonly string[]).includes(body.transport) ? body.transport : "mcp";
    let id = `at_${crypto.randomUUID().slice(0, 8)}`;
    const ts = Date.now();
    this.state.storage.sql.exec(
      `INSERT INTO auth_tokens (id, label, hash, tags, transport, principal, created_ts) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      id, label, hash, JSON.stringify(tags), transport, principal, ts,
    );
    // register hash → workspace in the central registry so /mcp routes this
    // token here. Registry failure must fail the mint — a silently unregistered
    // token would misroute to the default workspace.
    const ws = this.wsSlug();
    if (ws) {
      const reg = (this.env as any).KB.get((this.env as any).KB.idFromName(doWs(DEFAULT_WS_SLUG)));
      await reg.fetch("https://kb/ws.token_register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ hash, ws }),
      });
    }
    this.audit("admin", "mint", id, { label, transport, tags });
    return { id, label, tags, transport, secret }; // secret shown exactly once
  }

  private async tokenList() {
    const rows = this.state.storage.sql.exec(
      `SELECT id, label, tags, transport, created_ts, last_seen_ts, revoked_ts FROM auth_tokens ORDER BY created_ts DESC`,
    ).toArray();
    const sessions = this.state.storage.sql.exec(
      `SELECT token_id, name, first_seen_ts, last_seen_ts FROM sessions ORDER BY last_seen_ts DESC`,
    ).toArray();
    // gateway → dispatched-agent edges for Connect's grouping (BR#2455)
    const gateway_agents = this.state.storage.sql.exec(
      `SELECT gateway, agent, last_seen_ts FROM gateway_agents ORDER BY last_seen_ts DESC LIMIT 200`,
    ).toArray();
    return { tokens: rows.map((r) => ({ ...r, tags: parseTags(r.tags) })), sessions, gateway_agents };
  }

  private async tokenRevoke(body: any) {
    const id = String(body.id ?? "");
    const row = this.one(`SELECT id, label FROM auth_tokens WHERE id = ?`, id);
    if (!row) throw new Error(`no such auth token: ${id}`);
    this.state.storage.sql.exec(`UPDATE auth_tokens SET revoked_ts = ? WHERE id = ?`, Date.now(), id);
    this.audit("admin", "revoke", id, { label: row.label });
    return { id, revoked: true };
  }

  /** Update an agent's tags (roles/capabilities) in place — no re-mint, the secret stays valid. */
  private async tokenTags(body: any) {
    const id = String(body.id ?? "");
    const row = this.one(`SELECT id, label, tags FROM auth_tokens WHERE id = ?`, id);
    if (!row) throw new Error(`no such auth token: ${id}`);
    const tags = sanitizeTags(body.tags);
    this.state.storage.sql.exec(
      `UPDATE auth_tokens SET tags = ? WHERE id = ?`,
      tags ? JSON.stringify(tags) : "[]", id,
    );
    this.audit("admin", "tags", id, { label: row.label, tags: tags ?? [] });
    return { id, label: row.label, tags: tags ?? [] };
  }

  private async settingsGet() {
    return { settings: this.settingsMap() };
  }

  private async settingsSet(body: any) {
    const entries = Object.entries(body.settings ?? {}).filter(([k]) => /^[a-z0-9_]{1,40}$/.test(k));
    if (entries.length === 0) throw new Error("no valid settings keys (lowercase [a-z0-9_])");
    for (const [k, v] of entries) {
      this.state.storage.sql.exec(
        `INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`,
        k, JSON.stringify(v),
      );
      this.audit("admin", "settings", k, {});
    }
    return { settings: this.settingsMap() };
  }

  // ---------- serialized merge train (BR#3516) ----------
  // Lane card primitive + lease CAS + train events + the derived queue, on
  // the DO. Division of labour: the EXECUTOR (scripts/merge-train.mjs on a
  // gateway machine, worker-local gh, doctor-defended) fetches GitHub facts
  // and performs the merge; the HUB decides (this state machine) and holds
  // NO VCS credentials — every fact here was reported by a gateway, the
  // verify duty's close note, or the queue derive. Pinned in
  // test/merge-train.test.ts + test/train-hub.test.ts.

  /** Lane card lookup by meta.lane.key (exact). */
  private laneRow(laneKeyValue: string): any {
    return this.one(
      `SELECT id, type, status, title, body_md, meta, tags, roles, status_ts, owner FROM artefacts
       WHERE type = 'task' AND json_extract(meta, '$.lane.key') = ? LIMIT 1`,
      laneKeyValue,
    );
  }

  /** Find-or-create the standing lane card for (repo, base). Seed config:
   *  settings key `train_lane` (JSON map keyed by "repo@base" →
   *  {required_workflows, ci_typical_minutes}); the card's meta.lane is the
   *  working copy (config, never hardcoded — BR#3516 §1). */
  private async laneEnsure(repo: string, base: string, actor: string, cfg?: Partial<LaneSpec>): Promise<any> {
    const key = laneKey(repo, base);
    const existing = this.laneRow(key);
    if (existing) {
      // config updates ride the op that knows better (operator/executor):
      // required_workflows / ci_typical_minutes refresh in place.
      const cur = laneOfMeta(existing.meta);
      if (cfg && cur && (cfg.required_workflows || cfg.ci_typical_minutes != null) &&
          (JSON.stringify(cfg.required_workflows ?? cur.required_workflows) !== JSON.stringify(cur.required_workflows) ||
            (cfg.ci_typical_minutes ?? cur.ci_typical_minutes) !== cur.ci_typical_minutes)) {
        const meta = JSON.parse(existing.meta ?? "{}");
        meta.lane = { ...meta.lane, ...(cfg.required_workflows ? { required_workflows: cfg.required_workflows } : {}), ...(cfg.ci_typical_minutes != null ? { ci_typical_minutes: cfg.ci_typical_minutes } : {}) };
        meta.lane.key = key;
        this.state.storage.sql.exec(`UPDATE artefacts SET meta = ? WHERE id = ?`, JSON.stringify(meta), existing.id);
        this.audit(actor, "train_lane_config", existing.id, { lane: meta.lane });
      }
      return existing;
    }
    // seed from settings (admin.settings_set) — the operator's lane config
    let seeded: Partial<LaneSpec> = cfg ?? {};
    try {
      const raw = this.settingValue("train_lane", "");
      if (raw) {
        const map = JSON.parse(raw);
        const s = map?.[key] ?? {};
        seeded = { required_workflows: Array.isArray(s.required_workflows) ? s.required_workflows.map(String) : undefined, ci_typical_minutes: typeof s.ci_typical_minutes === "number" ? s.ci_typical_minutes : undefined, ...seeded };
      }
    } catch { /* no/broken setting — defaults hold */ }
    const lane: LaneSpec = { repo, base, required_workflows: seeded.required_workflows ?? [], ci_typical_minutes: seeded.ci_typical_minutes ?? TRAIN_CI_TYPICAL_MINUTES };
    const alarmSink = this.settingValue("train_alarm_sink_id", TRAIN_ALARM_SINK_ID);
    const created = await this.create(
      {
        type: "task",
        title: laneCardTitle(repo, base),
        body_md: laneCardBody(lane, { alarm_sink: alarmSink }),
        meta: { lane: { ...lane, key }, lease: null, currently: null, stop: null },
        tags: ["merge-train", "infrastructure"],
      },
      actor,
    );
    // infrastructure card: blocked from birth, never claimed. The merge_train
    // flag suppresses the unblock-duty spawn (the train advances this card).
    // The blocked-needs-path invariant demands the unblock condition — the
    // lane's exit path is the executor, not an agent.
    await this.transition(
      {
        id: created.id,
        to: "blocked",
        note: "merge-train: awaiting an available gateway",
        merge_train: true,
        unblock_condition: "the train advances this card — run scripts/merge-train.mjs on a gateway (doctor-gated)",
      },
      actor,
    );
    this.audit(actor, "create", created.id, { type: "task", auto: "lane", lane_key: key });
    return this.laneRow(key);
  }

  /** Recompute the lane card's blocked reason from its meta — the ONLY
   *  reason-writer, so the lane always shows the truth (idle / leased /
   *  awaiting CI / stopped / no gateway). Idempotent. */
  private laneSyncReason(laneId: string, meta: any, now: number): string {
    const lane = laneOfMeta(meta);
    const lease: TrainLease | null = meta.lease ?? null;
    const currently = meta.currently ?? null;
    const stop = meta.stop ?? null;
    let reason: string;
    if (stop) reason = `merge-train: STOPPED — ${stop.reason} (resume when the line is green)`;
    else if (currently) {
      const who = lease ? ` by ${lease.holder}` : "";
      reason = `merge-train: leased${who} — awaiting CI on ${String(currently.merge_sha ?? "").slice(0, 9)} (PR #${currently.pr})`;
    } else if (lease && lease.expires_ts > now) reason = `merge-train: leased by ${lease.holder} — idle`;
    else reason = "merge-train: awaiting an available gateway";
    if (meta.blocked?.reason !== reason) {
      meta.blocked = { ...(meta.blocked ?? {}), reason, unblock_condition: meta.blocked?.unblock_condition ?? "the train advances this card — run scripts/merge-train.mjs on a gateway (doctor-gated)" };
      this.state.storage.sql.exec(`UPDATE artefacts SET meta = ? WHERE id = ?`, JSON.stringify(meta), laneId);
    }
    return reason;
  }

  /** Arm (G) — train-watch: lease staleness (the hub's credential-free
   *  monitoring job). A lapsed lease is cleared and the lane shows the honest
   *  `awaiting an available gateway`; the next gateway reconciles from live
   *  GitHub and acquires. No GitHub calls, no asks (an idle lane is not an
   *  incident — the red line is, and that lives in the stopped flow). */
  private async trainWatchSweep(now: number): Promise<void> {
    const rows = this.state.storage.sql.exec(
      `SELECT id, meta FROM artefacts WHERE type = 'task' AND json_extract(meta, '$.lane.key') IS NOT NULL`,
    ).toArray() as any[];
    for (const r of rows) {
      try {
        const meta = JSON.parse(r.meta ?? "{}");
        const lease: TrainLease | null = meta.lease ?? null;
        const lapsed = !!lease && lease.expires_ts <= now;
        if (lapsed) {
          const holder = lease!.holder;
          meta.lease = null;
          const reason = this.laneSyncReason(r.id, meta, now);
          this.audit("system:merge-train", "lease_lapsed", r.id, { holder, expired_at: new Date(lease!.expires_ts).toISOString(), reason });
          this.version(r.id, "system:merge-train", "lease_lapsed", `lease of ${holder} lapsed — ${reason}`, {});
        } else if (meta.blocked?.reason === "merge-train: leased by ..." || !meta.blocked?.reason?.startsWith("merge-train:")) {
          // reason drifted (older class version) — resync to the truth
          this.laneSyncReason(r.id, meta, now);
        }
      } catch (e) {
        this.audit("system:merge-train", "watch_error", r.id, { error: String((e as Error).message ?? e).slice(0, 200) });
      }
    }
  }

  /** train.lease — the CAS op. The DO is single-threaded, so the
   *  read-check-write is atomic by construction; leaseDecide is the check.
   *  holder defaults to the authenticated actor (the acting gateway). */
  private async trainLease(body: any, actor: string): Promise<any> {
    const repo = String(body.repo ?? "").trim();
    const base = String(body.base ?? "main").trim();
    const action: LeaseAction = ["acquire", "renew", "release"].includes(String(body.action)) ? body.action : null;
    if (!action) throw new Error("action must be acquire | renew | release");
    const holder = String(body.holder ?? actor).trim() || actor;
    const lane = await this.laneEnsure(repo, base, actor);
    const meta = JSON.parse(lane.meta ?? "{}");
    const now = Date.now();
    const decided = leaseDecide(meta.lease ?? null, now, holder, action);
    if (decided.ok === false) throw Object.assign(new Error(decided.reason), { lease_conflict: true });
    meta.lease = decided.lease;
    // acquisition carries the executor's lane config (required workflows —
    // config, never hardcoded); release clears the stop when the line is green again.
    if (action === "acquire" && (body.required_workflows || body.ci_typical_minutes != null)) {
      meta.lane = { ...meta.lane, ...(body.required_workflows ? { required_workflows: (body.required_workflows as unknown[]).map(String).filter(Boolean) } : {}), ...(body.ci_typical_minutes != null ? { ci_typical_minutes: Number(body.ci_typical_minutes) } : {}) };
      meta.lane.key = laneKey(repo, base);
    }
    if (action === "release" && body.line_green) {
      meta.stop = null;
      // the stopped phase's in-flight record is the BROKEN merge commit —
      // never poll it toward a landing; the culprit card was bounced at stop
      // time, so the lane simply goes idle.
      if (meta.currently?.phase === "stopped") meta.currently = null;
    }
    const reason = this.laneSyncReason(lane.id, meta, now);
    this.audit(actor, `train:lease_${action}`, lane.id, { lane: laneKey(repo, base), note: decided.note });
    this.version(lane.id, actor, `train:lease_${action}`, decided.note, { lease: meta.lease, reason });
    return { ok: true, lane: laneKey(repo, base), lease: meta.lease, currently: meta.currently ?? null, stop: meta.stop ?? null, reason, note: decided.note };
  }

  /** Resolve the delivery chain for a queued/landed PR — task, verdict
   *  (closed verify child), session — board data only, zero GitHub calls
   *  (BR#3516 §7). */
  private trainChain(taskId: string | null): { task_id: string | null; verdict_id: string | null; session: string | null } {
    if (!taskId) return { task_id: null, verdict_id: null, session: null };
    const v = this.one(
      `SELECT c.id AS id, c.meta AS meta FROM relations r JOIN artefacts c ON c.id = r.src_id
       WHERE r.relation = 'child_of' AND r.dst_id = ? AND c.status = 'done' AND c.roles LIKE '%"review"%'
       ORDER BY c.updated_ts DESC LIMIT 1`,
      taskId,
    ) as any;
    return {
      task_id: taskId,
      verdict_id: v?.id ?? null,
      session: v ? (JSON.parse(v.meta ?? "{}").session ?? null) : null,
    };
  }

  /** Stamp the provenance index (BR#3287 chain) from a train:merged event —
   *  board-side storage of record; the lookup endpoint serves it with zero
   *  hub GitHub calls. */
  private trainStampProvenance(rec: { repo: string; pr: number; merge_sha: string; head_sha: string | null; task_id: string | null; verdict_id: string | null; session: string | null; signer: string; merged_at: number }) {
    this.state.storage.sql.exec(
      `INSERT INTO provenance (repo, pr, merge_sha, head_sha, task_id, verdict_id, session, signer, merged_at, stamped_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (repo, pr) DO UPDATE SET merge_sha = excluded.merge_sha, head_sha = excluded.head_sha,
         task_id = excluded.task_id, verdict_id = excluded.verdict_id, session = excluded.session,
         signer = excluded.signer, merged_at = excluded.merged_at, stamped_at = excluded.stamped_at`,
      rec.repo, rec.pr, rec.merge_sha, rec.head_sha ?? "", rec.task_id, rec.verdict_id, rec.session, rec.signer, rec.merged_at, Date.now(),
    );
  }

  /** train.event — kind merged | bounced | stopped | landed. The acting
   *  gateway (actor) must hold the lease; every event is audited with the
   *  gateway for attribution and written to the train_events ledger. */
  private async trainEvent(body: any, actor: string): Promise<any> {
    const repo = String(body.repo ?? "").trim();
    const base = String(body.base ?? "main").trim();
    const kind = String(body.kind ?? "").trim();
    if (!["merged", "bounced", "stopped", "landed"].includes(kind)) throw new Error("kind must be merged | bounced | stopped | landed");
    const lane = await this.laneEnsure(repo, base, actor);
    const meta = JSON.parse(lane.meta ?? "{}");
    const now = Date.now();
    const lease: TrainLease | null = meta.lease ?? null;
    if (!lease || lease.holder !== actor) throw new Error(`train events require the lane lease — held by ${lease?.holder ?? "nobody"}, you are ${actor}`);
    const pr = Number(body.pr ?? 0) || null;
    const headSha = body.head_sha ? String(body.head_sha) : null;
    const mergeSha = body.merge_sha ? String(body.merge_sha) : null;
    const row = (id: string) => this.one(`SELECT id, status, meta, body_md FROM artefacts WHERE id = ?`, id);
    const ev = (detail: Record<string, unknown>, taskId: string | null) => {
      this.state.storage.sql.exec(
        `INSERT INTO train_events (ts, kind, repo, base, gateway, pr, task_id, merge_sha, head_sha, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        now, kind, repo, base, actor, pr, taskId, mergeSha, headSha, JSON.stringify(detail),
      );
      this.audit(actor, `train:${kind}`, lane.id, { lane: laneKey(repo, base), pr, task: taskId, sha: mergeSha ?? headSha, ...detail });
    };

    if (kind === "merged") {
      if (!mergeSha) throw new Error("train:merged needs merge_sha");
      if (!pr) throw new Error("train:merged needs pr");
      const chain = this.trainChain(String(body.task_id ?? "") || null);
      this.trainStampProvenance({ repo, pr, merge_sha: mergeSha, head_sha: headSha, ...chain, signer: String(body.signer ?? "worker-executor"), merged_at: now });
      // carry-record: a clean machine update moved the verified head X→Y and
      // the verdict CARRIES (BR#3516 §5) — appended on the impl card. ONE
      // meta write: carry + awaiting-ci stamp + provenance + (blocked)
      // reason, so no leg clobbers another.
      if (chain.task_id) {
        const card = row(chain.task_id);
        if (card) {
          const cm = JSON.parse(card.meta ?? "{}");
          const stamped = String(cm.pr?.head_sha_at_acceptance ?? "");
          let next = cm;
          if (stamped && headSha && stamped.toLowerCase() !== headSha.toLowerCase()) {
            next = carryAppend(cm, { from_head: stamped, to_head: headSha, prior_verdict_id: chain.verdict_id, carried_ts: now, via: "update-branch" as const });
            this.version(chain.task_id, actor, "train_carry", `verdict carried across clean update ${stamped.slice(0, 9)}→${headSha.slice(0, 9)} (prior verdict ${chain.verdict_id ?? "unrecorded"} cited)`, {});
          }
          next.merge_train = { ...(next.merge_train ?? {}), state: "awaiting-ci", pr, merge_sha: mergeSha, merged_at: now };
          next.provenance = { repo, pr, head_sha: headSha ?? "", merge_sha: mergeSha, task_id: chain.task_id, verdict_id: chain.verdict_id, session: chain.session, signer: String(body.signer ?? "worker-executor"), merged_at: now };
          // blocked stays blocked (lifecycle forbids blocked→blocked) — the
          // state rides meta.merge_train; the reason says awaiting-CI.
          if (card.status === "blocked") {
            next.blocked = { ...(next.blocked ?? {}), reason: `merge-train: awaiting-ci — PR #${pr} merged as ${mergeSha.slice(0, 9)}, main CI pending` };
            this.state.storage.sql.exec(`UPDATE artefacts SET meta = ?, updated_ts = ? WHERE id = ?`, JSON.stringify(next), now, chain.task_id);
          } else {
            this.state.storage.sql.exec(`UPDATE artefacts SET meta = ? WHERE id = ?`, JSON.stringify(next), chain.task_id);
          }
        }
      }
      meta.currently = { pr, merge_sha: mergeSha, head_sha: headSha, merged_at: now, phase: "awaiting-ci", task_id: chain.task_id };
      const reason = this.laneSyncReason(lane.id, meta, now);
      ev({ task: chain.task_id, verdict: chain.verdict_id, session: chain.session, carry: !!(headSha && String(body.carry_from ?? "")) }, chain.task_id);
      this.version(lane.id, actor, `train:${kind}`, `PR #${pr} merged as ${mergeSha.slice(0, 9)} — awaiting main CI`, { currently: meta.currently, reason });
      return { ok: true, kind, lane: laneKey(repo, base), pr, merge_sha: mergeSha, task: chain.task_id, reason };
    }

    if (kind === "bounced") {
      if (!pr) throw new Error("train:bounced needs pr");
      const taskId = String(body.task_id ?? "") || (meta.currently?.task_id ?? null);
      const conflictFiles: string[] = Array.isArray(body.conflict_files) ? body.conflict_files.map(String).filter(Boolean) : [];
      const card = taskId ? row(taskId) : null;
      if (!card) throw new Error(`train:bounced could not resolve the impl card (task_id ${taskId ?? "none"})`);
      const cm = JSON.parse(card.meta ?? "{}");
      const brief = trainBounceBrief({ prNumber: pr, repo, headSha, conflictFiles, verdictId: this.trainChain(taskId).verdict_id });
      // blocked→in_progress with the fix-up brief; resolution invalidates the
      // verdict — the card re-enters the queue only after a fresh verify.
      await this.transition(
        {
          id: taskId,
          to: "in_progress",
          note: `merge-train bounce — PR #${pr} conflicts with base${conflictFiles.length ? ` (${conflictFiles.length} file(s))` : ""}`,
          body_md: `${String(card.body_md ?? "").replace(/\n\n---\n\nMerge-train bounce[\s\S]*$/, "")}\n\n---\n\n${brief}`,
        },
        actor,
      );
      cm.merge_train = { ...(cm.merge_train ?? {}), state: "bounced", pr, bounced_at: now };
      this.state.storage.sql.exec(`UPDATE artefacts SET meta = ? WHERE id = ?`, JSON.stringify(cm), taskId);
      meta.currently = null;
      const reason = this.laneSyncReason(lane.id, meta, now);
      ev({ task: taskId, conflict_files: conflictFiles }, taskId);
      this.version(lane.id, actor, `train:${kind}`, `PR #${pr} bounced — ${conflictFiles.length} conflicting file(s); re-verify then re-queue at the back`, { reason });
      return { ok: true, kind, lane: laneKey(repo, base), pr, task: taskId, conflict_files: conflictFiles, reason };
    }

    if (kind === "stopped") {
      if (!mergeSha && !headSha) throw new Error("train:stopped needs sha (merge_sha or head_sha)");
      const sha = mergeSha ?? headSha!;
      const failing: { name: string; conclusion?: string | null; url?: string | null }[] = Array.isArray(body.failing) ? body.failing : [];
      const culprit = String(body.culprit_task ?? "") || (meta.currently?.task_id ?? null) || null;
      const why = String(body.reason ?? (failing.length ? `required workflows RED: ${failing.map((f) => f.name).join(", ")}` : "stop-the-line"));
      meta.stop = { sha, reason: why, at: now, pr, failing };
      // red AFTER merge ⇒ the culprit (just-merged) card bounces with the
      // failing runs; red at admission ⇒ no merge happened, nothing bounces.
      if (culprit && meta.currently) {
        const card = row(culprit);
        if (card && card.status === "blocked") {
          const lines = [
            `Merge-train STOP THE LINE: your PR #${pr} landed as ${sha.slice(0, 9)} and broke main — required workflows RED.`,
            ...failing.map((f) => `- ${f.name}: ${f.conclusion ?? "failed"}${f.url ? ` (${f.url})` : ""}`),
            ``,
            `Fix forward or revert, then re-enter review. The lane is stopped until main is green again (BR#3516 §6 — v1 stops the line; no auto-revert).`,
          ];
          await this.transition(
            {
              id: culprit,
              to: "in_progress",
              note: `merge-train stop-the-line — main RED at ${sha.slice(0, 9)}: ${failing.map((f) => f.name).join(", ") || why}`,
              body_md: `${String(card.body_md ?? "")}\n\n---\n\n${lines.join("\n")}`,
            },
            actor,
          );
          const cm2 = JSON.parse(card.meta ?? "{}");
          cm2.merge_train = { ...(cm2.merge_train ?? {}), state: "stopped", pr, sha, at: now };
          this.state.storage.sql.exec(`UPDATE artefacts SET meta = ? WHERE id = ?`, JSON.stringify(cm2), culprit);
        }
      }
      meta.currently = meta.currently ? { ...meta.currently, phase: "stopped" } : null;
      const reason = this.laneSyncReason(lane.id, meta, now);
      // ONE ask per class: the sha+workflows make the title unique per red
      // episode; askCreate's identical-open-ask guard dedupes the rest.
      const askTitle = trainStopAskTitle({ repo, base }, sha, failing.map((f) => f.name).length ? failing.map((f) => f.name) : [why]);
      try {
        await this.askCreate(
          {
            to: "human",
            question: askTitle,
            reason: `the merge train stopped the ${repo}@${base} line — merges halt until green (BR#3516 §6)`,
            details: [
              `Lane ${laneKey(repo, base)} stopped by gateway ${actor} at ${new Date(now).toISOString()}.`,
              `Commit: ${sha}`,
              failing.length ? `Failing required workflows:\n${failing.map((f) => `- ${f.name}${f.url ? ` — ${f.url}` : ""}`).join("\n")}` : `Reason: ${why}`,
              culprit ? `Culprit card: ${culprit} (bounced with the failing runs).` : "No merge had landed — stopped at admission.",
              `Resume: main green again (the executor auto-resumes next tick) or a recorded authority decision.`,
            ].join("\n\n"),
            options: ["Ack — on it", "Revert the culprit", "Waive — resume the lane"],
            artefact_id: this.settingValue("train_alarm_sink_id", TRAIN_ALARM_SINK_ID),
            urgency: "time-sensitive",
          },
          actor,
        );
      } catch (e) {
        // an identical ask is already open for this episode — that IS one per class
        this.audit(actor, "train:stopped", lane.id, { ask_deduped: String((e as Error).message ?? e).slice(0, 160) });
      }
      ev({ reason: why, failing, culprit }, culprit);
      this.version(lane.id, actor, `train:${kind}`, `line stopped — ${why}`, { stop: meta.stop, reason });
      return { ok: true, kind, lane: laneKey(repo, base), sha, stop: meta.stop, reason };
    }

    // kind === "landed": the hub decides from facts — checks ride the event
    // and MUST classify green (the executor never self-certifies; a stale or
    // lying landed is rejected, not applied).
    if (!meta.currently || meta.currently.phase === "stopped") throw new Error("train:landed with no awaiting-CI merge on the lane");
    if (!mergeSha || Number(meta.currently.pr) !== Number(pr)) throw new Error(`train:landed must cite the lane's in-flight merge (PR #${meta.currently.pr}, ${String(meta.currently.merge_sha).slice(0, 9)})`);
    const checks: MainCheckRun[] = Array.isArray(body.checks) ? body.checks : [];
    const laneSpec = laneOfMeta(meta)!;
    const classified = classifyRequiredRuns(checks, laneSpec.required_workflows, { merged_at: Number(meta.currently.merged_at ?? now), now, typical_ms: (laneSpec.ci_typical_minutes ?? TRAIN_CI_TYPICAL_MINUTES) * 60_000 });
    if (classified.verdict !== "green") throw new Error(`train:landed rejected — required runs classify ${classified.verdict} (failing: ${classified.failing.map((f) => f.name).join(", ") || "none"}; pending: ${classified.pending.join(", ") || "none"}); post train.ci instead and let the hub decide`);
    return this.landedFlow(lane, meta, actor, { pr: Number(pr), mergeSha: mergeSha!, greenRunUrl: classified.failing.length ? null : (checks.find((c) => laneSpec.required_workflows.includes(c.name ?? ""))?.html_url ?? body.run_url ?? null) });
  }

  /** The landed close: impl card blocked→in_progress→done (lifecycle law:
   *  blocked→done is illegal) citing mergeCommit + main green — the machine
   *  proxy — then the lane idles and the derived queue advances. */
  private async landedFlow(lane: any, meta: any, actor: string, p: { pr: number; mergeSha: string; greenRunUrl?: string | null }): Promise<any> {
    const now = Date.now();
    const laneSpec = laneOfMeta(meta)!;
    const taskId: string | null = meta.currently?.task_id ?? null;
    if (taskId) {
      const card = this.one(`SELECT id, status, meta FROM artefacts WHERE id = ?`, taskId);
      if (card && card.status !== "done" && card.status !== "superseded") {
        const note = trainLandedCloseNote({ repo: laneSpec.repo, prNumber: p.pr, mergeSha: p.mergeSha, gateway: actor, greenRunUrl: p.greenRunUrl });
        if (card.status === "blocked")
          await this.transition({ id: taskId, to: "in_progress", note: `merge-train: landed — closing on the machine proxy (mergeCommit ${p.mergeSha.slice(0, 9)} non-null + main green)`, merge_train: true }, actor);
        await this.transition({ id: taskId, to: "done", note }, actor);
        const cm = JSON.parse(card.meta ?? "{}");
        cm.merge_train = { ...(cm.merge_train ?? {}), state: "landed", pr: p.pr, merge_sha: p.mergeSha, landed_at: now };
        this.state.storage.sql.exec(`UPDATE artefacts SET meta = ? WHERE id = ?`, JSON.stringify(cm), taskId);
      }
    }
    meta.currently = null;
    const reason = this.laneSyncReason(lane.id, meta, now);
    this.state.storage.sql.exec(
      `INSERT INTO train_events (ts, kind, repo, base, gateway, pr, task_id, merge_sha, head_sha, detail) VALUES (?, 'landed', ?, ?, ?, ?, ?, ?, NULL, ?)`,
      now, laneSpec.repo, laneSpec.base, actor, p.pr, taskId, p.mergeSha, JSON.stringify({ run: p.greenRunUrl ?? null }),
    );
    this.audit(actor, "train:landed", lane.id, { lane: laneKey(laneSpec.repo, laneSpec.base), pr: p.pr, task: taskId, merge_sha: p.mergeSha });
    this.version(lane.id, actor, "train:landed", `PR #${p.pr} landed — ${p.mergeSha.slice(0, 9)} green on main; card ${taskId ?? "n/a"} closed`, { reason });
    return { ok: true, kind: "landed", pr: p.pr, merge_sha: p.mergeSha, task: taskId, reason };
  }

  /** train.ci — executor-fed CI facts on the lane's merge commit; the HUB
   *  decides (BR#3516: executor-fed facts, hub-decided). Green ⇒ landed;
   *  red ⇒ stop-the-line; pending past the bound ⇒ fail-closed stop. */
  private async trainCi(body: any, actor: string): Promise<any> {
    const repo = String(body.repo ?? "").trim();
    const base = String(body.base ?? "main").trim();
    const lane = await this.laneEnsure(repo, base, actor);
    const meta = JSON.parse(lane.meta ?? "{}");
    const now = Date.now();
    const lease: TrainLease | null = meta.lease ?? null;
    if (!lease || lease.holder !== actor) throw new Error(`train.ci requires the lane lease — held by ${lease?.holder ?? "nobody"}`);
    if (!meta.currently) {
      // nothing in flight — the executor is just heartbeating; facts noted.
      this.audit(actor, "train:ci_idle", lane.id, { lane: laneKey(repo, base), sha: String(body.sha ?? "").slice(0, 9) });
      return { ok: true, decided: "idle", lane: laneKey(repo, base) };
    }
    const sha = String(body.sha ?? "");
    if (sha && String(meta.currently.merge_sha).toLowerCase() !== sha.toLowerCase())
      throw new Error(`stale CI report — the lane's in-flight merge is ${String(meta.currently.merge_sha).slice(0, 9)}, not ${sha.slice(0, 9)}`);
    const checks: MainCheckRun[] = Array.isArray(body.checks) ? body.checks : [];
    const laneSpec = laneOfMeta(meta)!;
    const v: RequiredRunsVerdict = classifyRequiredRuns(checks, laneSpec.required_workflows, { merged_at: Number(meta.currently.merged_at ?? now), now, typical_ms: (laneSpec.ci_typical_minutes ?? TRAIN_CI_TYPICAL_MINUTES) * 60_000 });
    const pr = Number(meta.currently.pr);
    const mergeSha = String(meta.currently.merge_sha);
    if (v.verdict === "green") {
      const out = await this.landedFlow(lane, meta, actor, { pr, mergeSha, greenRunUrl: checks.find((c) => laneSpec.required_workflows.includes(c.name ?? ""))?.html_url ?? body.run_url ?? null });
      return { ...out, decided: "landed" };
    }
    if (v.verdict === "red") {
      const out = await this.trainEvent({ repo, base, kind: "stopped", pr, merge_sha: mergeSha, failing: v.failing }, actor);
      return { ...out, decided: "stopped" };
    }
    // pending — the bound decides: unknown past ~3× typical ⇒ fail-closed
    if (v.bound_exceeded) {
      const out = await this.trainEvent({ repo, base, kind: "stopped", pr, merge_sha: mergeSha, reason: `CI unknown past the fail-closed bound (~${TRAIN_CI_BOUND_MULTIPLIER}× typical)` }, actor);
      return { ...out, decided: "stopped_bound" };
    }
    const reason = this.laneSyncReason(lane.id, { ...meta, currently: { ...meta.currently } }, now);
    this.audit(actor, "train:ci_pending", lane.id, { lane: laneKey(repo, base), pending: v.pending, missing: v.missing });
    return { ok: true, decided: "pending", lane: laneKey(repo, base), pending: v.pending, missing: v.missing, reason };
  }

  /** The ACCEPT hook (verify-side convention, BR#3516 §1): a verify duty
   *  closing done on an impl card stamps meta.pr{repo, number,
   *  head_sha_at_acceptance} and queues the card onto the train. Parses the
   *  PR + head from BOARD data (the close note) — zero hub GitHub calls.
   *  Idempotent: an already-queued card just re-stamps the (new) head. */
  private async trainQueueOnAccept(parentId: string, src: { note?: string }, actor: string): Promise<void> {
    const parent = this.one(`SELECT id, type, status, meta, body_md FROM artefacts WHERE id = ?`, parentId);
    if (!parent || parent.type !== "task" || parent.status === "done" || parent.status === "superseded") return;
    const meta = JSON.parse(parent.meta ?? "{}");
    const note = String(src.note ?? "");
    // the head sha the verifier recorded in the close note (head <40-hex>)
    const headMatch = TRAIN_HEAD_STAMP_RE.exec(note);
    const headSha = headMatch ? headMatch[1] : null;
    // the PR: this note → the parent's stamp → the parent's body
    const prFrom = (text: string) => {
      const m = /https?:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d+)/.exec(text);
      return m ? { repo: `${m[1]}/${m[2]}`, number: Number(m[3]) } : null;
    };
    const ref = prFrom(note) ?? (meta.pr?.repo && meta.pr?.number ? { repo: String(meta.pr.repo), number: Number(meta.pr.number) } : null) ?? prFrom(String(parent.body_md ?? ""));
    if (!ref) {
      // not a PR card (or the verifier forgot the link) — nothing to queue
      this.audit("system:merge-train", "queue_skipped", parentId, { reason: "no PR reference in the close note, stamp, or card body" });
      return;
    }
    if (!headSha && !meta.pr?.head_sha_at_acceptance) {
      // the verdict cannot be bound to a head — do NOT queue (the train's
      // gate would fail-closed); stamp the miss and leave the card in flight.
      meta.merge_train = { ...(meta.merge_train ?? {}), state: "unbound", pr: ref.number, at: Date.now() };
      this.state.storage.sql.exec(`UPDATE artefacts SET meta = ? WHERE id = ?`, JSON.stringify(meta), parentId);
      this.audit("system:merge-train", "queue_unbound", parentId, { reason: "verify close carried no `head <sha>` — re-verify close must cite the live head before the train can gate it" });
      return;
    }
    meta.pr = { ...(meta.pr ?? {}), repo: ref.repo, number: ref.number, ...(headSha ? { head_sha_at_acceptance: headSha } : {}) };
    meta.merge_train = { ...(meta.merge_train ?? {}), state: "queued", at: Date.now(), pr: ref.number };
    const alreadyQueued = parent.status === "blocked" && String(meta.blocked?.reason ?? "").startsWith(MERGE_TRAIN_REASON_PREFIX);
    this.state.storage.sql.exec(`UPDATE artefacts SET meta = ? WHERE id = ?`, JSON.stringify(meta), parentId);
    if (!alreadyQueued) {
      await this.transition(
        {
          id: parentId,
          to: "blocked",
          note: MERGE_TRAIN_QUEUED_REASON,
          merge_train: true,
          unblock_condition: "the merge train advances this card — no agent action needed until it bounces (then fix per the brief)",
        },
        actor,
      );
    }
    // the lane card exists before anything can lease it
    await this.laneEnsure(ref.repo, String(meta.pr.base ?? "main"), actor);
    this.audit(actor, "train_queued", parentId, { pr: ref.number, repo: ref.repo, head: (headSha ?? "").slice(0, 9), requeued: alreadyQueued });
    this.version(parentId, actor, "train_queued", `queued on the merge train — ${ref.repo}#${ref.number}${headSha ? ` @ ${headSha.slice(0, 9)}` : ""}${alreadyQueued ? " (re-queued, stamp refreshed)" : ""}`, { pr: ref.number });
  }

  /** train.status — the lane + derived-queue snapshot (GET /train mirrors
   *  this). The queue is COMPUTED here (mergeTrainQueue), never stored. */
  private async trainStatus(body: any): Promise<any> {
    const repoFilter = String(body?.repo ?? "").trim();
    const lanes = this.state.storage.sql.exec(
      `SELECT id, title, status, meta, status_ts, updated_ts FROM artefacts
       WHERE type = 'task' AND json_extract(meta, '$.lane.key') IS NOT NULL ORDER BY title`,
    ).toArray() as any[];
    const out: any[] = [];
    for (const l of lanes) {
      const meta = JSON.parse(l.meta ?? "{}");
      const lane = laneOfMeta(meta);
      if (!lane) continue;
      if (repoFilter && lane.repo !== repoFilter) continue;
      const cards = this.state.storage.sql.exec(
        `SELECT id, status_ts, meta FROM artefacts WHERE type = 'task' AND status = 'blocked'
         AND CAST(json_extract(meta, '$.merge_train.pr') AS INTEGER) > 0`,
      ).toArray() as any[];
      const queue = mergeTrainQueue(
        cards.map((c) => ({ id: c.id, status_ts: c.status_ts, meta: JSON.parse(c.meta ?? "{}") })),
      ).filter((c) => {
        const cm = cards.find((x) => x.id === c.id);
        return cm && String(JSON.parse(cm.meta ?? "{}").merge_train?.repo ?? lane.repo) === lane.repo;
      });
      out.push({
        lane: `${lane.repo}@${lane.base}`,
        card: l.id,
        lease: meta.lease ?? null,
        currently: meta.currently ?? null,
        stop: meta.stop ?? null,
        required_workflows: lane.required_workflows,
        reason: String(meta.blocked?.reason ?? ""),
        queue,
      });
    }
    return { lanes: out };
  }

  /** train.history — the train_events ledger (provenance serving). */
  private trainHistory(body: any): any {
    const clauses: string[] = [];
    const args: unknown[] = [];
    if (body?.repo) { clauses.push("repo = ?"); args.push(String(body.repo)); }
    if (body?.base) { clauses.push("base = ?"); args.push(String(body.base)); }
    if (body?.kind) { clauses.push("kind = ?"); args.push(String(body.kind)); }
    if (body?.pr) { clauses.push("pr = ?"); args.push(Number(body.pr)); }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.state.storage.sql.exec(
      `SELECT seq, ts, kind, repo, base, gateway, pr, task_id, merge_sha, head_sha, detail FROM train_events ${where} ORDER BY seq DESC LIMIT ?`,
      ...args, Math.min(Number(body?.limit ?? 50), 200),
    ).toArray() as any[];
    return { events: rows.map((r) => ({ ...r, detail: JSON.parse(r.detail ?? "{}") })) };
  }

  // ---------- helpers ----------

  /** THE append-only ledger — every mutation (kind 'mutation') and every
   *  signal (kind 'signal') is one row in one sequence. events/artefact_versions
   *  are views over this. */
  private ledgerWrite(kind: 'signal' | 'mutation', actor: string, action: string, artefactId: string | null, summary: string, data: object): { seq: number; ts: number } {
    const ts = Date.now();
    const r = this.state.storage.sql.exec(
      `INSERT INTO ledger (ts, actor, kind, action, artefact_id, summary, data) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING seq`,
      ts, actor, kind, action, artefactId, summary.slice(0, 500), JSON.stringify(data),
    ).toArray()[0] as any;
    return { seq: Number(r?.seq ?? 0), ts };
  }

  /** Append-only per-artefact history: every mutation gets one mutation row. */
  private version(artefactId: string, actor: string, action: string, summary: string, data: object = {}) {
    const { seq, ts } = this.ledgerWrite('mutation', actor, action, artefactId, summary, data);
    // remember it so the paired audit() broadcast reuses this row instead of
    // writing a second signal row for the same fact
    this._lastMutation = { key: `${artefactId}:${action}`, seq, ts, actor, action, artefactId, data };
  }

  private audit(actor: string, op: string, artefactId: string | null, detail: object) {
    const key = `${artefactId}:${op}`;
    let seq: number; let ts: number;
    const last = this._lastMutation;
    if (last && last.key === key && Date.now() - last.ts < 5_000) {
      // same fact already recorded as a mutation — broadcast THAT row, no second write
      ({ seq, ts } = last);
      this.broadcastEvent({ seq, ts, actor: last.actor, op: last.action, artefact_id: last.artefactId, detail: last.data });
      this._lastMutation = null;
      this.scoreCache = null;
      return;
    }
    ({ seq, ts } = this.ledgerWrite('signal', actor, op, artefactId, "", detail));
    this.broadcastEvent({ seq, ts, actor, op, artefact_id: artefactId, detail });
    // every mutation can move behaviour signals — drop the 30s score cache so
    // board reads after writes are fresh (the cache exists for DO row-read quota)
    this.scoreCache = null;
  }

  private _lastMutation: { key: string; seq: number; ts: number; actor: string; action: string; artefactId: string | null; data: object } | null = null;

  private async nextSeq(_type: ArtefactType): Promise<number> {
    const rows = this.state.storage.sql.exec(`SELECT id FROM artefacts`).toArray();
    let max = 0;
    for (const r of rows as any[]) {
      const m = /^BR#(\d+)$/.exec(String(r.id));
      if (m) max = Math.max(max, parseInt(m[1], 10));
    }
    return max + 1;
  }

  // :any on purpose — rows come back as Record<string, SqlStorageValue> and every
  // caller immediately narrows to the columns it selected; the per-site casts the
  // strict ratchet will want are deferred until that pass (BR#2505 guard landed
  // non-strict on purpose).
  private one(query: string, ...params: any[]): any {
    return this.state.storage.sql.exec(query, ...params).toArray()[0] ?? null;
  }

  private shape(row: any): any {
    return { ...row, meta: JSON.parse(row.meta ?? "{}"), tags: parseTags(row.tags), roles: parseTags(row.roles) };
  }

  private json(obj: unknown, status = 200) {
    return new Response(JSON.stringify(obj), {
      status,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
  }
}

// re-export for the worker entry's type-free JS import
export { idSeq };

/** Final tags to write: the executor's tags_add merged into the row's tags. */
function tagsForWrite(verdict: Extract<Awaited<ReturnType<typeof decide>>, { ok: true }>, base: string[]): string[] {
  if (!verdict.tags_add.length) return base;
  const t = [...base];
  for (const x of verdict.tags_add) if (!t.includes(x)) t.push(x);
  return t;
}
