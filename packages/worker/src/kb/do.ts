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
  issueRef,
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
  TRANSPORTS,
  ARTEFACT_TYPES,
  ArtefactType,
  DEFAULT_BOARD,
  DEFAULT_CRON_PLAYBOOK,
  DEFAULT_ROLE_PLAYBOOKS,
  DEFAULT_WS_SLUG,
  doWs,
  INITIAL_STATUS,
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
  isWsSlug,
  isValidAskTarget,
  tagsSayGateway,
  parseTags,
  sanitizeTags,
  validateRelation,
} from "./core.ts";
import {
  check as checkRules,
  invariants as checkInvariants,
  CHURN_REDIRECT_ATTEMPTS,
  CHURN_ESCALATE_ATTEMPTS,
  RuleCtx,
} from "./machine.ts";

export class KnowledgeHub {
  constructor(private state: DurableObjectState, private env: any) {}

  /** ensureSchema runs once per isolate, not per request — its migration
   *  queries are full-table scans, and the free-tier DO row-read quota
   *  dies under per-request schema checks (2026-10-18 outage). */
  private schemaReady = false;

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
      if (meta.awaiting_ask) continue;
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
      );
      if (now - lastTs <= staleMs) continue;
      const openAsk = this.one(
        `SELECT id FROM asks WHERE status = 'open' AND artefact_id = ?`, r.id,
      );
      if (openAsk) continue;
      const will = meta.last_progress?.will ? `; was about to: ${String(meta.last_progress.will).slice(0, 120)}` : "";
      const lapsedSub = meta.subprocess ? ` (declared subprocess window of ${meta.subprocess.budget_minutes ?? "?"}m lapsed)` : "";
      // STALLED, not blocked: silence means "we haven't heard from the agent"
      // — blocked is reserved for the agent's own explicit "I cannot continue
      // until X". Release straight to todo: the claim drops, the attempted tag
      // records the try, and the next orient reassigns it. No blocked
      // intermediate, no unblock-child spawn for silence.
      await this.transition({
        id: r.id, to: "todo",
        note: `stalled — no update for >${staleMin}m${lapsedSub}; released to the pool by watchdog${will}`,
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
             AND c.tags LIKE '%"role:review"%' LIMIT 1`, r.id,
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
         AND c.tags LIKE '%"role:review"%'
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
    // observability: the board can answer "is the watchdog alive?" via
    // /api/kb/stats — last tick, next alarm ts (poison detection: a
    // next_alarm_ts stuck in the past means the schedule is jammed), stale
    // in-flight count, open asks.
    const nextAlarm = await this.state.storage.getAlarm();
    this.state.storage.sql.exec(
      `INSERT INTO settings (key, value) VALUES ('watchdog.last_tick', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      String(now),
    );
    this.state.storage.sql.exec(
      `INSERT INTO settings (key, value) VALUES ('watchdog.next_alarm', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
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
      `INSERT INTO settings (key, value) VALUES ('watchdog.sweep', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      JSON.stringify({ ts: now, stale_in_progress: staleNow, stale_in_review: staleReviewNow, review_stale_minutes: reviewStaleMin, open_asks: openAsks }),
    );
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
    const events = rows.map((e) => ({ ...e, detail: JSON.parse(e.detail ?? "{}") }));
    return { events, last_seq: events.length ? events[events.length - 1].seq : since };
  }

  async board() {
    const tasks = this.state.storage.sql.exec(
      `SELECT id, title, status, owner, tags, meta, body_md, status_ts, created_ts, updated_ts, project FROM artefacts
       WHERE type = 'task' ORDER BY updated_ts DESC LIMIT 200`,
    ).toArray().map((t) => ({ ...t, meta: JSON.parse(t.meta ?? "{}"), tags: parseTags(t.tags) }));
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
      const roleTagged = tagsArr.some((x) => ["role:analysis", "role:review", "role:impl", "role:unblock"].includes(x));
      const isQ = tagsArr.includes("question") || (t.meta.kind === "question");
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
      `SELECT s.token_id, s.name, s.first_seen_ts, s.last_seen_ts, t.label
       FROM sessions s LEFT JOIN auth_tokens t ON t.id = s.token_id ORDER BY s.last_seen_ts DESC LIMIT 100`,
    ).toArray();
    const progress = this.state.storage.sql.exec(
      `SELECT seq, ts, actor, artefact_id, detail FROM events
       WHERE op = 'progress' ORDER BY seq DESC LIMIT 120`,
    ).toArray().map((e) => ({ ...e, detail: JSON.parse(e.detail ?? "{}") }));
    const series = this.state.storage.sql.exec(
      `SELECT artefact_id, ts, actor, data FROM artefact_versions
       WHERE action = 'progress' ORDER BY seq DESC LIMIT 400`,
    ).toArray().map((v: any) => {
      const d = JSON.parse(v.data ?? "{}");
      return { artefact_id: v.artefact_id, ts: v.ts, actor: v.actor, ...d };
    });
    return { tasks, sessions, progress, series, agents: this.agentScores() };
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
    const windowTs = Date.now() - 7 * 24 * 60 * 60_000;
    const tokens = this.state.storage.sql.exec(
      `SELECT label, tags FROM auth_tokens WHERE revoked_ts IS NULL`,
    ).toArray() as any[];
    const signals = new Map<string, AgentSignals>();
    const sig = (label: string): AgentSignals => {
      let s = signals.get(label);
      if (!s) {
        s = { progress_count: 0, gauge_count: 0, thin_notes: 0, abandoned: 0, reassigned: 0, asks_received: 0, asks_answered_on_time: 0, artefacts_created: 0 };
        signals.set(label, s);
      }
      return s;
    };
    for (const t of tokens) sig(t.label); // agents with no activity still get a row
    for (const p of this.state.storage.sql.exec(
      `SELECT actor, data FROM artefact_versions WHERE action = 'progress' AND ts >= ?`,
      windowTs,
    ).toArray() as any[]) {
      const s = sig(p.actor);
      const d = JSON.parse(p.data ?? "{}");
      s.progress_count++;
      if (d.completion_pct != null || d.confidence_pct != null || d.risk_pct != null) s.gauge_count++;
      if (String(d.note ?? "").trim().length < 10) s.thin_notes++;
    }
    for (const r of this.state.storage.sql.exec(
      `SELECT a.owner AS owner, COUNT(*) AS n FROM events e JOIN artefacts a ON a.id = e.artefact_id
       WHERE e.op = 'transition' AND e.actor = 'system:watchdog' AND e.ts >= ? GROUP BY a.owner`,
      windowTs,
    ).toArray() as any[]) sig(r.owner || "unknown").abandoned += r.n;
    for (const r of this.state.storage.sql.exec(
      `SELECT detail FROM events WHERE op = 'reassign' AND ts >= ?`, windowTs,
    ).toArray() as any[]) {
      const d = JSON.parse(r.detail ?? "{}");
      sig(d.prev_owner || "unknown").reassigned++;
    }
    for (const r of this.state.storage.sql.exec(
      `SELECT owner, COUNT(*) AS n FROM artefacts
       WHERE created_ts >= ? AND LENGTH(body_md) >= 200 AND owner != '' GROUP BY owner`,
      windowTs,
    ).toArray() as any[]) sig(r.owner).artefacts_created += r.n;
    for (const t of tokens) {
      const s = sig(t.label);
      const tags: string[] = parseTags(t.tags);
      const targets = ["any", t.label, ...tags.map((x: string) => `tag:${x}`)];
      const marks = targets.map(() => "?").join(",");
      s.asks_received = this.one(
        `SELECT COUNT(*) AS n FROM asks WHERE status IN ('open','answered') AND from_label != ?
         AND created_ts >= ? AND to_target IN (${marks})`, t.label, windowTs, ...targets,
      )?.n ?? 0;
      s.asks_answered_on_time = this.one(
        `SELECT COUNT(*) AS n FROM asks WHERE status = 'answered' AND answered_by = ? AND answered_ts IS NOT NULL
         AND answered_ts - created_ts <= ${30 * 60_000} AND created_ts >= ?`, t.label, windowTs,
      )?.n ?? 0;
      // verification duty backlog: role:review agents carry the pool's stalled
      // verify rounds — each one is an implementer parked in in_review.
      if (tags.includes("role:review")) {
        s.verify_duty_backlog = this.one(
          `SELECT COUNT(*) AS n FROM relations r JOIN artefacts c ON c.id = r.src_id JOIN artefacts p ON p.id = r.dst_id
           WHERE r.relation = 'child_of' AND c.type = 'task' AND c.status = 'todo' AND c.owner = ''
           AND c.tags LIKE '%"role:review"%' AND p.status = 'in_review'`,
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
    if (this.schemaReady) return;
    this.schemaReady = true;
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
      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        actor TEXT NOT NULL,
        op TEXT NOT NULL,
        artefact_id TEXT,
        detail TEXT NOT NULL DEFAULT '{}'
      );
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
        device_id TEXT,
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
        device_id TEXT,
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
      CREATE TABLE IF NOT EXISTS artefact_versions (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        artefact_id TEXT NOT NULL,
        ts INTEGER NOT NULL,
        actor TEXT NOT NULL,
        action TEXT NOT NULL,
        summary TEXT,
        data TEXT NOT NULL DEFAULT '{}'
      );
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
      `ALTER TABLE embeddings ADD COLUMN dim INTEGER DEFAULT 0`,
      `ALTER TABLE asks ADD COLUMN artefact_id TEXT`,
      `ALTER TABLE artefacts ADD COLUMN project TEXT NOT NULL DEFAULT ''`,
      `ALTER TABLE artefacts ADD COLUMN created_by TEXT NOT NULL DEFAULT ''`,
      `ALTER TABLE pairings ADD COLUMN type TEXT`,
      `ALTER TABLE pairings ADD COLUMN device_id TEXT`,
      `ALTER TABLE auth_tokens ADD COLUMN device_id TEXT`,
    ]) {
      try { this.state.storage.sql.exec(ddl); } catch { /* column exists */ }
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
      const body = await request.json();
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
      const body = await request.json();
      const identity = await this.identify(String(body.bearer ?? ""));
      const newLabel = String(body.label ?? "").trim();
      if (!/^[a-zA-Z0-9._-]{2,40}$/.test(newLabel)) throw new Error("label must be 2-40 chars [a-zA-Z0-9._-]");
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

    // human-plane GET mirror
    if (request.method === "GET") {
      switch (url.pathname) {
        case "/artefacts": return this.json(await this.list({ type: url.searchParams.get("type") ?? undefined, status: url.searchParams.get("status") ?? undefined, tag: url.searchParams.get("tag") ?? undefined, limit: url.searchParams.get("limit") ?? undefined }));
        case "/artefact": return this.json(await this.getWithRelations(String(url.searchParams.get("id"))));
        case "/search": return this.json(await this.search({ q: url.searchParams.get("q") ?? "", type: url.searchParams.get("type") ?? undefined, limit: url.searchParams.get("limit") ?? undefined }));
        case "/events": return this.json(await this.eventsSince(Number(url.searchParams.get("since") ?? 0), Math.min(Number(url.searchParams.get("limit") ?? 100), 500)));
        case "/board": return this.json(await this.board());
        case "/stats": return this.json(await this.stats());
        case "/history": return this.json(await this.getHistory(String(url.searchParams.get("id")), Math.min(Number(url.searchParams.get("limit") ?? 100), 200)));
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
        case "related": return this.json(await this.related(String(body.id), Number(body.limit ?? 10)));
        case "enrich": return this.json(await this.enrich(body, actor));
        case "update": return this.json(await this.update(body, actor));
        case "transition": return this.json(await this.transition(body, actor));
        case "link": return this.json(await this.link(body, actor));
        case "relations": return this.json(await this.relations(String(body.id)));
        case "stats": return this.json(await this.stats());
        case "get_history": return this.json(await this.getHistory(String(body.id ?? ""), Number(body.limit ?? 100)));
        // ---- machine-plane identity + sessions + asks ----
        case "auth.identify": return this.json(await this.identify(String(body.bearer ?? "")));
        case "agent.provision": return this.json(await this.agentProvision(body, actor));
        case "agents.list": return this.json(await this.listAgents());
        case "session.touch": return this.json(await this.sessionTouch(body));
        case "ask.create": return this.json(await this.askCreate(body, actor));
        case "ask.inbox": return this.json(await this.askInbox(body));
        case "ask.answer": return this.json(await this.askAnswer(body, actor));
        case "orient": return this.json(await this.orient(body));
        case "progress.log": return this.json(await this.progressLog(body, actor));
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
          if (!isAdmin) return this.json({ error: "admin only" }, 403);
          if (op === "admin.mint") return this.json(await this.tokenMint(body));
          if (op === "admin.list_tokens") return this.json(await this.tokenList());
          if (op === "admin.revoke") return this.json(await this.tokenRevoke(body));
          if (op === "admin.token_tags") return this.json(await this.tokenTags(body));
          if (op === "admin.settings_get") return this.json(await this.settingsGet());
          return this.json(await this.settingsSet(body));
        default: return this.json({ error: `unknown op ${op}` }, 404);
      }
    } catch (e) {
      return this.json({ error: String((e as Error).message ?? e) }, 400);
    }
  }

  // ---------- ops ----------

  private async create(body: any, actor: string) {
    const type = body.type as ArtefactType;
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
    const session = await this.resolveSession(body, String(body.token_id ?? ""));
    // project: explicit override or the deployment's project; tasks enter UNCLAIMED (owner = pool)
    const project = String(body.project ?? "").trim() || this.settingsMap().project_name || "superpositional";
    const owner = type === "task" ? String(body.owner ?? "").trim() : String(body.owner ?? actor);
    // qualifications stack: a publisher may declare self-analyzed readiness AND request
    // further confirmation bars (await: ["role:review"]) before the task goes ready
    const createMeta: any = { ...(body.meta ?? {}) };
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
            tm.last_progress = { note: `verify round ${round}: verdict ${verdict} UNCHANGED — auto-applied, no new decision card`, sentiment: "neutral", actor, ts: Date.now() };
            const alreadyRight = verdict === "bounce" ? trow.status === "in_progress" : trow.status === "done";
            if (!alreadyRight) {
              // 3 identical rounds = the loop is stalled; park it for a human
              if (round >= 3) {
                await this.transition({
                  id: trow.id, to: "blocked",
                  note: `verify loop stalled — ${round} rounds with identical verdict (${verdict}); auto-applied each time, no progress. Needs human intervention.`,
                  unblock_condition: "human: read the verify history on this card; either clear the blocker the verifier keeps naming, or cancel the loop (transition todo and address the task differently)",
                }, "system:verifier");
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
    this.state.storage.sql.exec(
      `INSERT INTO artefacts (id, type, title, status, body_md, meta, owner, created_ts, updated_ts, tags, status_ts, project, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, type, title, status, bodyMd, JSON.stringify({ ...createMeta, session }), owner, ts, ts,
      tags ? JSON.stringify(tags) : null, ts, project, actor,
    );
    if (!bodyMd.trim() && (type === "task" || type === "goal")) {
      bodyMd = scaffoldBody(title, owner || actor);
    }
    this.audit(actor, "create", id, { type, title });
    this.version(id, actor, "create", title, { type, title, body_md: bodyMd, tags: tags ?? [] });
    await this.embedArtefact(id, title, bodyMd);
    // GitHub auto-enrichment: "#1886" in the title pulls issue body/labels
    if (this.env.GH_TOKEN) {
      const ref = issueRef(title);
      if (ref) { try { await this.enrichFromGitHub(id, ref); } catch { /* GH unavailable — stay bare */ } }
    }
    if (type === "progress") await this.progressHeartbeat(body.meta, title, actor);
    return { id, type, status };
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
      .map((c) => this.one(`SELECT id, status, meta, tags FROM artefacts WHERE id = ? AND type = 'task'`, c))
      .find(Boolean);
    if (!t) return;
    const tmeta = JSON.parse(t.meta ?? "{}");
    const tTags: string[] = parseTags(t.tags);
    const isQualifier = tTags.includes("role:analysis") || tTags.includes("role:review") || tTags.includes("role:unblock");
    if (t.status === "blocked" && (tmeta.blocked?.reason ?? "").startsWith("abandoned")) {
      await this.transition({ id: t.id, to: "in_progress", note: "re-claimed — progress artefact logged" }, actor);
      delete tmeta.blocked;
    } else if (t.status === "todo") {
      // pickup gate applies: only qualified work (or qualifier roles) auto-starts.
      // Question tasks are never auto-started — contributions don't claim.
      const q = isQualifier ? { ok: true } : this.qualifyCheck(t, "analysis");
      if (q.ok && !tTags.includes("question")) await this.transition({ id: t.id, to: "in_progress", note: "started — progress artefact logged" }, actor);
    }
    tmeta.last_progress = { note: title.slice(0, 200), sentiment: "neutral", actor, ts: Date.now(), session: tmeta.session };
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
    const limitErr = checkLimits(title, bodyMd, JSON.parse(meta));
    if (limitErr) throw new Error(limitErr);
    // update does not touch status — transitions are the only status path
    this.state.storage.sql.exec(
      `UPDATE artefacts SET title = ?, body_md = ?, meta = ?, tags = ?, updated_ts = ? WHERE id = ?`,
      title, bodyMd, meta, tags ? JSON.stringify(tags) : null, Date.now(), id,
    );
    this.audit(actor, "update", id, {});
    const changed = [
      body.title !== undefined && "title", body.body_md !== undefined && "body",
      body.meta !== undefined && "meta", body.tags !== undefined && "tags",
    ].filter(Boolean);
    this.version(id, actor, "update", `updated ${changed.join(", ") || "fields"}`, { title, body_md: bodyMd });
    await this.embedArtefact(id, title, bodyMd);
    return { id };
  }

  /** Pure evidence for a qualification kind: a done analysis/review child, or an accepted
   *  decision linked either way. Declarations (meta.qualified / meta.qualification) don't count. */
  private hasEvidence(row: any, kind: "analysis" | "review"): { ok: boolean; via?: string } {
    const roleFilter = kind === "analysis"
      ? `(c.tags LIKE '%"role:analysis"%' OR c.tags LIKE '%"role:review"%')`
      : `c.tags LIKE '%"role:review"%'`;
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
           ? `(c.tags LIKE '%"role:analysis"%' OR c.tags LIKE '%"role:review"%')`
           : `c.tags LIKE '%"role:review"%'`} LIMIT 1`,
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
    return bars.filter((b) => !/^role:(analysis|review|impl|unblock)$/.test(String(b)));
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
      `SELECT r.dst_id AS pid, c.tags AS tags FROM relations r JOIN artefacts c ON c.id = r.src_id
       WHERE r.relation = 'child_of' AND c.status = 'done'`,
    ).toArray() as any[]) {
      const tags: string[] = parseTags(k.tags);
      if (tags.includes("role:review")) { reviewEv.add(k.pid); analysisEv.add(k.pid); }
      else if (tags.includes("role:analysis")) analysisEv.add(k.pid);
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
   *  reason) — gaming the gates is visible in the Log and costs behaviour score. */
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
      }
      throw e;
    }
  }

  /** Lazy SQL-backed context for the machine rules — a guard only queries
   *  what it actually reads, so cheap transitions stay cheap. */
  private ruleCtx(row: any, body: any, id: string, tTags: string[]): RuleCtx {
    return {
      qualify: (kind) => {
        if (kind === "analysis") {
          // gateway-attributed claims: the role lives in the TASK, not the
          // token — a role-tagged task dispatched by its gateway IS that work.
          const dispatchedRoleWork =
            body?.gateway && ["role:analysis", "role:review", "role:impl", "role:unblock"].some((t) => tTags.includes(t));
          return dispatchedRoleWork ? { ok: true, via: "dispatch" } : this.qualifyCheck(row, "analysis");
        }
        return this.qualifyCheck(row, "review");
      },
      unmetBars: () => this.unmetBars(row),
      session: () => this.resolveSession(body, String(body?.token_id ?? "")),
      evidence: (eid) => this.one(`SELECT type, tags, meta FROM artefacts WHERE id = ?`, eid),
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
    };
  }

  private async doTransition(body: any, actor: string) {
    const id = String(body.id ?? "");
    let to = String(body.to ?? "");
    const row = this.one(`SELECT * FROM artefacts WHERE id = ?`, id);
    if (!row) throw new Error(`no such artefact: ${id}`);
    // ---- the law: one table, one checker (machine.ts). Every role/intent
    // rule lives in RULES there; this is the only legality gate. ----
    const tTags: string[] = parseTags(row.tags);
    const rejection = await checkRules(
      { id, type: row.type, status: row.status, to, tags: tTags, meta: JSON.parse(row.meta ?? "{}"), actor, body },
      this.ruleCtx(row, body, id, tTags),
    );
    if (rejection) throw new Error(rejection);
    // (remaining guard rules live in machine.ts RULES — BR#2420)
    // (B) subprocess class: a declared block on a long/handed-off op, with a
    // budget. The watchdog pauses until the budget lapses; past it the
    // subprocess = declared silence while STILL WORKING: the task stays
    // in_progress (it isn't blocked — nothing else must finish first). The
    // watchdog pauses until the declared budget lapses; past it the sweep
    // converts the silence to abandoned. Blocked is reserved for tasks
    // awaiting OTHER tasks/decisions.
    const isSubprocess = body.class === "subprocess";
    const sentiment = isSentiment(body.sentiment) ? body.sentiment : undefined;
    const ts = Date.now();
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
    if (to === "blocked") {
      meta.blocked = { reason: String(body.note ?? body.reason ?? "").trim(), unblock_condition: String(body.unblock_condition ?? "").trim(), ts };
      delete meta.subprocess; // a real block supersedes a declared subprocess window
    } else if (meta.blocked) {
      delete meta.blocked; // unblocking clears the dead-end record
    }
    // claim semantics: in_progress on a task claims it for the actor (system actors don't steal claims)
    let owner = row.owner;
    // claim only on fresh pickup or abandoned re-claim — a review bounce returns to the AUTHOR
    const bounceFromReview = row.status === "in_review";
    // gateway attribution: a gateway-tagged token is infrastructure — it claims
    // on behalf of the agent it dispatched as (ADR BR#899). body.agent names
    // that agent; mcp.ts only forwards it when the token carries the "gateway"
    // tag, so a plain agent token cannot attribute its work elsewhere.
    const attributedAgent = body.gateway && String(body.agent ?? "").trim()
      ? String(body.agent).trim().slice(0, 60)
      : undefined;
    if (row.type === "task" && to === "in_progress" && !bounceFromReview && !/^system:/.test(actor) && owner !== actor) {
      owner = attributedAgent ?? actor;
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
    // retry / release: pushing a card back to todo releases the claim — it
    // re-enters the unclaimed pool for any matching agent (or the cron sweep)
    // to pick up fresh. Only the current owner or a human may release a claim —
    // agents can't dump each other's work.
    if (row.type === "task" && to === "todo") {
      const isHuman = actor === "web" || actor.startsWith("web:") || actor.startsWith("human:");
      const isSystem = /^system:/.test(actor);
      if (row.owner && row.owner !== actor && !isHuman && !isSystem)
        throw new Error(`task ${id} is claimed by ${row.owner} — only the owner or a human can release it to the pool. If the work overlaps yours, coordinate via ask_agent instead.`);
      const nextAttempts = ((meta.attempt?.attempts as number) ?? 0) + 1;
      const verdictDuty = tTags.includes("role:review") || tTags.includes("role:unblock");
      if (verdictDuty && nextAttempts >= CHURN_ESCALATE_ATTEMPTS) {
        // verdict duties may not block (machine.ts) — repeated gate rejections
        // escalate to a human instead of redirecting into blocked + spawn.
        owner = "";
        meta.escalate = {
          at: ts,
          attempts: nextAttempts,
          reason: `verdict duty released ${nextAttempts} times without completing — the same gate keeps rejecting the handoff (last: ${String(meta.attempt?.last_reason ?? "").slice(0, 200)}). Human: review get_history, fix the recurring failure, or re-scope`,
        };
        meta.attempt = { by: actor, at: ts, attempts: nextAttempts, last_reason: String(body.note ?? "").trim() || meta.attempt?.last_reason, last_will: meta.last_progress?.will };
        this.audit("system:churn-guard", "escalated", id, { attempts: nextAttempts, duty: tTags.find((t) => t.startsWith("role:")) ?? "unknown" });
        this.version(id, "system:churn-guard", "transition", `escalated to human — ${nextAttempts} releases without completing (verdict duties cannot block)`, { from: row.status, to: "todo" });
      } else if (nextAttempts >= CHURN_REDIRECT_ATTEMPTS && row.status !== "blocked") {
        // churn guard: the pool has re-run this task N times and a gate keeps
        // rejecting the completion. Re-releasing just loops claim → dispatch →
        // reject → release forever (104-attempt rows taught us this), and each
        // hop refreshes the timestamps so the watchdog never fires. Redirect
        // the release into an honest block: the reason and exit are on the
        // card, a human or a competent agent resolves it.
        to = "blocked";
        meta.blocked = {
          reason: `churn guard: released to the pool ${nextAttempts} times without completing — the same gate keeps rejecting the handoff (last: ${String(meta.attempt?.last_reason ?? "").slice(0, 200)})`,
          unblock_condition: "read the task history (get_history) and the last gate error, resolve what it names, then re-claim or re-issue the task",
          ts,
        };
        meta.attempt = { by: actor, at: ts, attempts: nextAttempts, last_reason: String(body.note ?? "").trim() || meta.attempt?.last_reason, last_will: meta.last_progress?.will };
        this.audit("system:churn-guard", "release_redirected", id, { attempts: nextAttempts, from: row.status });
        this.version(id, "system:churn-guard", "transition", `release redirected to blocked — ${nextAttempts} attempts without completion`, { from: row.status, to: "blocked" });
      } else {
        owner = "";
        const tags: string[] = parseTags(row.tags);
        if (!tags.includes("attempted")) tags.push("attempted");
        this.state.storage.sql.exec(`UPDATE artefacts SET tags = ? WHERE id = ?`, JSON.stringify(tags), id);
        meta.attempt = {
          by: actor, at: ts,
          attempts: nextAttempts,
          last_reason: meta.blocked?.reason ?? (String(body.note ?? "").trim() || undefined),
          last_will: meta.last_progress?.will,
        };
      }
    }
    // (verdict-done receipts + review separation live in machine.ts RULES)
    // separation of duties, mechanical: a session that completed the analysis
    // child cannot carry the parent into implementation. If the parent is
    // claimed by the same session, release it — impl requires a fresh claim
    // (fresh session). The claim gate will then allow it (evidence session ≠ new session).
    if (row.type === "task" && to === "done" && tTags.includes("role:analysis")) {
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
    this.state.storage.sql.exec(
      `UPDATE artefacts SET status = ?, status_ts = ?, meta = ?, updated_ts = ?, owner = ? WHERE id = ?`, to, ts, JSON.stringify(meta), ts, owner, id,
    );
    // post-conditions on the single write path: violations are breaches (a
    // loud audited trail), never silent repairs.
    const violations = checkInvariants({ type: row.type, status: to, tags: tTags, meta });
    if (violations.length) {
      this.audit("system:invariants", "invariant_violation", id, { violations, from: row.status, to });
      this.version(id, "system:invariants", "note", `INVARIANT VIOLATION after ${row.status} → ${to}: ${violations.join("; ")}`, { violations });
    }
    if (to === "superseded" && body.replacement_id) {
      const rep = this.one(`SELECT id, type FROM artefacts WHERE id = ?`, String(body.replacement_id));
      if (rep && rep.type === row.type)
        this.state.storage.sql.exec(
          `INSERT OR IGNORE INTO relations (src_id, relation, dst_id, created_ts) VALUES (?, 'supersedes', ?, ?)`,
          String(body.replacement_id), id, ts,
        );
    }
    this.audit(actor, "transition", id, {
      from: row.status, to, note: body.note ?? "", sentiment,
      ...(attributedAgent ? { agent: attributedAgent } : {}),
      ...(isSubprocess ? { class: "subprocess", budget_minutes: meta.blocked.budget_minutes } : {}),
    });
    this.version(id, actor, "transition", `${row.status} → ${to}${body.note ? ` — ${String(body.note).slice(0, 120)}` : ""}`, { from: row.status, to, note: body.note ?? "" });
    // verify-verdict decisions are actionable: the human's answer DOES the
    // thing, not just records it. Accepting a VERIFIED verdict closes the
    // verified task (the accepted decision satisfies its done-gate via the
    // supports link). Accepting a BOUNCE verdict bounces the task back to
    // work with the findings. Without this, verdicts pile up as prose and the
    // human's click changes nothing — 35 proposed decisions taught us that.
    if (row.type === "decision" && to === "accepted") {
      const dm = meta ?? {};
      if (dm.decision_class === "verify-verdict") {
        const target = String(dm.task ?? dm.verify_target ?? "").trim();
        const isBounce = String(dm.verdict ?? "").toLowerCase() === "bounce";
        if (target) {
          // verifiers often apply their own verdict before proposing it — the
          // task is already done/bounced. Ratification must be a clean no-op,
          // not an "apply failed" error the human has to interpret.
          const cur = this.one(`SELECT status FROM artefacts WHERE id = ?`, target);
          const already = cur && (isBounce ? cur.status === "in_progress" : cur.status === "done");
          if (already) {
            this.audit(actor, "verdict_already_applied", target, { decision: id, status: cur.status });
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
    // verification duty: entering review auto-spawns the Verify task into the
    // unclaimed pool. A verifier (any agent, fresh session) picks it up, checks
    // receipts (PR/merge state), completes it, then closes the parent (done) or
    // bounces it (in_progress with findings). The impl agent keeps the parent
    // claim and waits — in_review is the blocked-until-verdict state.
    let verifyTaskId: string | undefined;
    if (row.type === "task" && to === "in_review" && !tTags.includes("role:review")) {
      // recursion guard, enforced: reviews don't spawn verify-of-verify, and
      // child_of chains are capped at 3. The verify round always names the
      // ROOT task in its title — the chain lives in child_of, never "Verify: Verify: ...".
      let guardHit: string | undefined;
      let cursor = id, depth = 0;
      while (depth < 10) {
        const p = this.one(
          `SELECT p.id AS id, p.tags AS tags FROM relations r JOIN artefacts p ON p.id = r.dst_id
           WHERE r.relation = 'child_of' AND r.src_id = ? LIMIT 1`, cursor,
        );
        if (!p) break;
        depth++;
        if (String(p.tags ?? "").includes("role:review")) { guardHit = `ancestor ${p.id} is a review task — verify-of-verify is blocked`; break; }
        if (depth >= 3) { guardHit = `nesting depth ${depth} would exceed the child_of cap of 3`; break; }
        cursor = p.id;
      }
      if (guardHit) {
        this.audit("system:guard", "spawn_skipped", id, { auto: "verification", reason: guardHit });
      } else {
        // reuse an OPEN verify round when one exists — a re-handoff re-enters
        // the same round instead of stacking a fresh card per bounce cycle
        const existing = this.one(
          `SELECT c.id AS id FROM relations r JOIN artefacts c ON c.id = r.src_id
           WHERE r.relation = 'child_of' AND r.dst_id = ? AND c.status IN ('todo','in_progress','blocked')
             AND c.tags LIKE '%"role:review"%' ORDER BY c.updated_ts DESC LIMIT 1`, id,
        );
        if (existing) {
          verifyTaskId = existing.id;
          this.audit("system:separation", "verify_reused", id, { verify: existing.id });
        } else {
          const pr = (String(body.note ?? "").match(/https?:\/\/\S+/) || [])[0];
          const rootTitle = row.title.replace(/^(?:Verify:\s*)+/, "");
          const created = await this.create(
            {
              type: "task",
              title: `Verify: ${rootTitle.slice(0, 200)}`,
              body_md: `Verification duty for ${id} — "${rootTitle}".\n\nDouble-check, don't reimplement: confirm the receipts (PR: ${pr ?? "see note"}, merge state, findings) and that the work matches the task.\nComplete with receipts in the note, then close ${id} (done) or bounce it (in_progress with findings).`,
              tags: ["role:review"],
            },
            actor,
          );
          verifyTaskId = created.id;
          this.state.storage.sql.exec(
            `INSERT OR IGNORE INTO relations (src_id, relation, dst_id, created_ts) VALUES (?, 'child_of', ?, ?)`,
            verifyTaskId, id, ts,
          );
          this.audit(actor, "create", verifyTaskId, { type: "task", auto: "verification", parent: id });
        }
      }
    }
    // unblock children are ephemeral: their whole job is to test the exit
    // condition. The moment the parent moves — resumes from blocked, gets
    // released to todo, done, or bounced — every open unblock child is
    // superseded. Without this each block episode spawns a fresh child and
    // the open ones accumulate (and then block the parent's own completion).
    if (row.type === "task" && ["in_progress", "todo", "done"].includes(to)) {
      const fromStatuses = ["todo", "in_progress", "blocked"];
      for (const v of this.state.storage.sql.exec(
        `SELECT c.id AS id, c.status AS status, c.meta AS meta FROM relations r JOIN artefacts c ON c.id = r.src_id
         WHERE r.relation = 'child_of' AND r.dst_id = ? AND c.status IN ('todo','in_progress','blocked') AND c.tags LIKE '%"role:unblock"%'`, id,
      ).toArray() as any[]) {
        const vm = JSON.parse(v.meta ?? "{}");
        vm.superseded_reason = to === "in_progress"
          ? `${id} resumed from blocked — unblock confirmed, child superseded`
          : `${id} → ${to} — unblock round closed`;
        this.state.storage.sql.exec(
          `UPDATE artefacts SET status = 'superseded', meta = ?, status_ts = ?, updated_ts = ? WHERE id = ?`,
          JSON.stringify(vm), ts, ts, v.id,
        );
        this.audit("system:separation", "transition", v.id, { from: v.status, to: "superseded", note: vm.superseded_reason });
        this.version(v.id, "system:separation", "transition", vm.superseded_reason, { from: v.status, to: "superseded" });
      }
    }
    // stale verification rounds: a done closes out ANY open Verify children.
    // A BOUNCE (in_review → in_progress) keeps the NEWEST open Verify child
    // alive and supersedes the rest — the bounce should re-enter the SAME
    // verify round, not supersede-and-respawn (the churn that drowned the
    // pool: 3-6 cards per parent, real claims starving behind them).
    if (row.type === "task" && (to === "done" || (row.status === "in_review" && to === "in_progress"))) {
      const isBounce = row.status === "in_review" && to === "in_progress";
      const verifyChildren = this.state.storage.sql.exec(
        `SELECT c.id AS id, c.status AS status, c.meta AS meta, c.updated_ts AS uts FROM relations r JOIN artefacts c ON c.id = r.src_id
         WHERE r.relation = 'child_of' AND r.dst_id = ? AND c.status IN ('todo','in_progress','blocked') AND c.tags LIKE '%"role:review"%' ORDER BY c.updated_ts DESC`, id,
      ).toArray() as any[];
      verifyChildren.forEach((v, i) => {
        if (isBounce && i === 0) return; // newest survives the bounce — same round re-enters
        const vm = JSON.parse(v.meta ?? "{}");
        vm.superseded_reason = `${id} ${to === "done" ? "done" : "bounced"} — ${isBounce ? "older verification round superseded (newest kept for re-entry)" : "verification round closed"}`;
        this.state.storage.sql.exec(
          `UPDATE artefacts SET status = 'superseded', meta = ?, status_ts = ?, updated_ts = ? WHERE id = ?`,
          JSON.stringify(vm), ts, ts, v.id,
        );
        this.audit("system:separation", "transition", v.id, { from: v.status, to: "superseded", note: vm.superseded_reason });
        this.version(v.id, "system:separation", "transition", vm.superseded_reason, { from: v.status, to: "superseded" });
      });
      // same for open unblock children: one per block episode, superseded when
      // the parent moves on (done or bounce) — never accumulating orphans
      for (const v of this.state.storage.sql.exec(
        `SELECT c.id AS id, c.status AS status, c.meta AS meta FROM relations r JOIN artefacts c ON c.id = r.src_id
         WHERE r.relation = 'child_of' AND r.dst_id = ? AND c.status IN ('todo','in_progress','blocked') AND c.tags LIKE '%"role:unblock"%'`, id,
      ).toArray() as any[]) {
        const vm = JSON.parse(v.meta ?? "{}");
        vm.superseded_reason = `${id} ${to === "done" ? "done" : "bounced"} — unblock round closed`;
        this.state.storage.sql.exec(
          `UPDATE artefacts SET status = 'superseded', meta = ?, status_ts = ?, updated_ts = ? WHERE id = ?`,
          JSON.stringify(vm), ts, ts, v.id,
        );
        this.audit("system:separation", "transition", v.id, { from: v.status, to: "superseded", note: vm.superseded_reason });
        this.version(v.id, "system:separation", "transition", vm.superseded_reason, { from: v.status, to: "superseded" });
      }
    }
    // every blocked task gets an unblock child: a priority-ranked task whose
    // contract is "verify whether the exit condition holds; if yes, resume the
    // parent (in_progress with resolution); if no, record findings and close
    // yourself". Ask-gated blocks are excluded — the ask answer auto-resumes
    // them, and a spawned unblock task would race the answer.
    if (row.type === "task" && to === "blocked" && !meta.awaiting_ask && !tTags.includes("role:unblock")) {
      // at most ONE live unblock child per parent, ever: if any exists in an
      // open state (todo/in_progress/blocked), reuse it — refresh its body
      // with the current exit condition instead of spawning a duplicate.
      const existing = this.one(
        `SELECT c.id AS id FROM relations r JOIN artefacts c ON c.id = r.src_id
         WHERE r.relation = 'child_of' AND r.dst_id = ? AND c.status IN ('todo','in_progress','blocked') AND c.tags LIKE '%"role:unblock"%' LIMIT 1`, id,
      );
      if (existing) {
        this.audit(actor, "spawn_skipped", id, { auto: "unblock", reason: `existing unblock child ${existing.id} reused` });
      } else if (
        meta.last_unblock_spawn &&
        ts - meta.last_unblock_spawn.at < 60 * 60_000 &&
        String(meta.last_unblock_spawn.exit ?? "") === String(meta.blocked?.unblock_condition ?? "").trim()
      ) {
        // flood guard: a superseded round still counts while fresh and the exit
        // condition is unchanged — the BR#909 class spawned one child per churn
        // cycle (17 cards) because each cycle superseded the last.
        this.audit(actor, "spawn_skipped", id, {
          auto: "unblock",
          reason: `unblock round issued ${Math.round((ts - meta.last_unblock_spawn.at) / 60_000)}m ago with the same exit condition — flood guard`,
        });
      } else {
      const exitCond = String(meta.blocked?.unblock_condition ?? "").trim();
      const blockWhy = String(meta.blocked?.reason ?? "").trim();
      const rootTitle = row.title.replace(/^(?:Unblock:\s*)+/, "");
      const created = await this.create(
        {
          type: "task",
          title: `Unblock: ${rootTitle.slice(0, 200)}`,
          body_md: `Unblock duty for ${id} — "${rootTitle}".\n\nBlocked why: ${blockWhy || "see parent"}.\nExit condition: ${exitCond || "none recorded — read the card and history, then decide: clear the block, re-scope the task, or escalate via ask_agent"}.\n\nContract: check whether the exit condition now holds (live receipts, GitHub state, answered decision). If it holds: transition ${id} to in_progress with the resolution note, then close yourself done citing what unblocked it. If it does not: record findings via log_progress and close yourself done with the findings — do NOT respawn an unblock task, do not leave yourself open.`,
          tags: ["role:unblock"],
        },
        actor,
      );
      this.state.storage.sql.exec(
        `INSERT OR IGNORE INTO relations (src_id, relation, dst_id, created_ts) VALUES (?, 'child_of', ?, ?)`,
        created.id, id, ts,
      );
      this.audit(actor, "create", created.id, { type: "task", auto: "unblock", parent: id });
        meta.last_unblock_spawn = { at: ts, exit: exitCond };
        this.state.storage.sql.exec(`UPDATE artefacts SET meta = ? WHERE id = ?`, JSON.stringify(meta), id);
      }
    }
    return { id, status: to, ...(sentiment ? { sentiment } : {}), verify_task: verifyTaskId };
  }

  private async link(body: any, actor: string) {
    const srcId = String(body.src ?? ""), rel = String(body.relation ?? ""), dstId = String(body.dst ?? "");
    if (!isRelation(rel)) throw new Error(`unknown relation '${rel}'`);
    const src = this.one(`SELECT id, type FROM artefacts WHERE id = ?`, srcId);
    const dst = this.one(`SELECT id, type FROM artefacts WHERE id = ?`, dstId);
    if (!src || !dst) throw new Error("both src and dst must exist");
    const verdict = validateRelation(rel, src.type as ArtefactType, dst.type as ArtefactType);
    if (!verdict.ok) throw new Error(verdict.reason);
    // verify-of-verify is structurally impossible: a verify task can never be
    // a child of a verify task (or of an unblock task — same ephemerality).
    // Enforced here at the relation level, not just the auto-spawn path.
    if (rel === "child_of") {
      const childTags = parseTags(src.tags);
      const parentTags = parseTags(dst.tags);
      if (childTags.includes("role:review") && (parentTags.includes("role:review") || parentTags.includes("role:unblock")))
        throw new Error(`link rejected: ${srcId} is a verify task — verify tasks are terminal-at-birth and cannot nest under ${parentTags.includes("role:review") ? "another verify" : "an unblock"} task`);
      if (childTags.includes("role:unblock") && (parentTags.includes("role:unblock") || parentTags.includes("role:review")))
        throw new Error(`link rejected: ${srcId} is an unblock task — unblock tasks are terminal-at-birth and cannot nest under another ephemeral task`);
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
      const tTags: string[] = JSON.parse(row.tags ?? "[]");
      // question tasks: contributions never claim — the author closes with an ADR
      if (tTags.includes("question")) {
        return {
          id, note, will: will || undefined, sentiment, completion_pct, confidence_pct, risk_pct, context_pct, instructions,
          note_postscript: "contribution logged on a question task — questions are answered, not claimed. The author weighs contributions and closes it with an ADR (decision artefact, derived_from the task).",
        };
      }
      const isQualifier = tTags.includes("role:analysis") || tTags.includes("role:review") || tTags.includes("role:unblock");
      const q = isQualifier ? { ok: true } : this.qualifyCheck(row, "analysis");
      if (!q.ok) {
        return {
          id, note, will: will || undefined, sentiment, completion_pct, confidence_pct, risk_pct, context_pct, instructions,
          note_postscript: `PROGRESS LOGGED BUT TASK NOT CLAIMED — ${id} is unclaimed todo and not qualified for you (label ${actor}). transition {to: "in_progress"} will be rejected until it is qualified: complete a role:analysis child task, link an accepted decision, or pick qualified work. role:analysis/role:review agents may claim unqualified work.`,
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
    meta.last_progress = { note, will: will || undefined, sentiment, actor: progressActor, ts: Date.now(), session: session ?? meta.session, completion_pct, confidence_pct, risk_pct, context_pct };
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

  /** Append-only history: every mutation of every artefact gets a version row. */
  private version(artefactId: string, actor: string, action: string, summary: string, data: object = {}) {
    const ts = Date.now();
    this.state.storage.sql.exec(
      `INSERT INTO artefact_versions (artefact_id, ts, actor, action, summary, data) VALUES (?, ?, ?, ?, ?, ?)`,
      artefactId, ts, actor, action, summary.slice(0, 500), JSON.stringify(data),
    );
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
    let row = this.one(`SELECT id, label, tags, revoked_ts FROM auth_tokens WHERE hash = ?`, hash);
    if (!row) {
      // absorb dev-mode write-visibility hiccups right after mint
      await new Promise((r) => setTimeout(r, 250));
      row = this.one(`SELECT id, label, tags, revoked_ts FROM auth_tokens WHERE hash = ?`, hash);
    }
    if (!row) throw new Error("unknown auth token");
    if (row.revoked_ts) throw new Error("auth token revoked");
    this.state.storage.sql.exec(`UPDATE auth_tokens SET last_seen_ts = ? WHERE id = ?`, Date.now(), row.id);
    return { token_id: row.id, label: row.label, tags: parseTags(row.tags) };
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
    const agents = rows.filter((a) => !tagsSayGateway(a.tags)).map(shape);
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
    if (body.session) {
      await this.sessionTouch({ token_id: tokenId, session: body.session }).catch(() => {});
      return String(body.session);
    }
    const row = this.one(
      `SELECT name FROM sessions WHERE token_id = ? ORDER BY last_seen_ts DESC LIMIT 1`, tokenId,
    ) as any;
    return row?.name ?? undefined;
  }

  /** Register/refresh a session. Names are unique per auth token. */
  private async sessionTouch(body: any) {
    const token_id = String(body.token_id ?? "");
    const name = String(body.session ?? "").trim().slice(0, 80) || `session-${Math.random().toString(36).slice(2, 6)}`;
    const ts = Date.now();
    this.state.storage.sql.exec(
      `INSERT INTO sessions (token_id, name, first_seen_ts, last_seen_ts) VALUES (?, ?, ?, ?)
       ON CONFLICT(token_id, name) DO UPDATE SET last_seen_ts = excluded.last_seen_ts`,
      token_id, name, ts, ts,
    );
    return { session: name };
  }

  private async askCreate(body: any, actor: string) {
    const to = String(body.to ?? "any");
    const question = String(body.question ?? "").trim();
    if (!question) throw new Error("question is required");
    if (question.length > 2000) throw new Error("question exceeds 2000 chars");
    if (!isValidAskTarget(to)) throw new Error(`invalid ask target '${to}'`);
    const artefactId = body.artefact_id ? String(body.artefact_id).trim() : "";
    const options = Array.isArray(body.options) ? body.options.map((o: any) => String(o).slice(0, 200)).filter(Boolean).slice(0, 8) : [];
    const urgency = isSentiment(body.urgency) ? String(body.urgency) : "normal";
    const id = `ASK-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    let taskStatus: string | undefined;
    if (artefactId) {
      const row = this.one(`SELECT type, status, meta FROM artefacts WHERE id = ?`, artefactId);
      if (!row) throw new Error(`no such artefact: ${artefactId}`);
      if (row.type === "task" && (row.status === "in_progress" || row.status === "blocked")) {
        const meta = JSON.parse(row.meta ?? "{}");
        meta.awaiting_ask = { ask_id: id, ts: Date.now() };
        this.state.storage.sql.exec(`UPDATE artefacts SET meta = ? WHERE id = ?`, JSON.stringify(meta), artefactId);
        if (row.status === "in_progress") {
          await this.transition({
            id: artefactId, to: "blocked",
            note: `blocked on decision — ${id}: ${question.slice(0, 120)}`,
            unblock_condition: `answer to ask ${id}`,
            awaiting_ask_id: id, // machine.ts: the only legal blocked for verdict duties
          }, actor);
          taskStatus = "blocked";
        } else {
          taskStatus = "blocked";
        }
      }
    }
    this.state.storage.sql.exec(
      `INSERT INTO asks (id, from_label, to_target, question, status, created_ts, artefact_id) VALUES (?, ?, ?, ?, 'open', ?, ?)`,
      id, actor, to, question, Date.now(), artefactId || null,
    );
    this.audit(actor, "ask", artefactId || null, { to, question, options, urgency, ask_id: id });
    return { id, to, question, artefact_id: artefactId || undefined, options, urgency, task_status: taskStatus };
  }

  private async askInbox(body: any) {
    const label = String(body.label ?? "");
    const tags: string[] = Array.isArray(body.tags) ? body.tags.map(String) : [];
    const placeholders = ["any", label, ...tags.map((t) => `tag:${t}`)];
    const marks = placeholders.map(() => "?").join(",");
    const open = this.state.storage.sql.exec(
      `SELECT id, from_label, to_target, question, created_ts FROM asks
       WHERE status = 'open' AND from_label != ? AND to_target IN (${marks})
       ORDER BY created_ts DESC LIMIT 50`,
      label, ...placeholders,
    ).toArray();
    const sent = this.state.storage.sql.exec(
      `SELECT id, to_target, question, status, answer, answered_by, created_ts FROM asks
       WHERE from_label = ? ORDER BY created_ts DESC LIMIT 50`,
      label,
    ).toArray();
    return { inbox: open, sent };
  }

  private async askAnswer(body: any, actor: string) {
    const id = String(body.id ?? "");
    const answer = String(body.answer ?? "").trim();
    if (!answer) throw new Error("answer is required");
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
        delete t.meta;
      }
      return t;
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
    const myTasks = this.state.storage.sql.exec(
      `SELECT id, title, status FROM artefacts WHERE type = 'task' AND owner = ? AND status IN ('todo','in_progress','in_review','blocked') ORDER BY updated_ts DESC LIMIT 10`,
      label,
    ).toArray();
    // dispatch surface: unclaimed todo tasks + BLOCKED tasks awaiting an agent
    // (a blocked card with an unblock condition is actionable — unblocking is
    // priority work). Rank-then-slice: fetch the full open pool FIRST, rank in
    // JS, then cut the top 10. The old 40-newest window was the Oct-20
    // frozen-backlog bug — churn (every claim/progress bumps updated_ts)
    // constantly displaced older-but-ranked items, so they were invisible to
    // the runner and sat in Backlog "blocked" forever.
    const pool = this.state.storage.sql.exec(
      `SELECT id, title, tags, meta, project, updated_ts, status FROM artefacts
       WHERE type = 'task' AND status IN ('todo','blocked') AND (owner = '' OR status = 'blocked')
       ORDER BY updated_ts DESC LIMIT 400`,
    ).toArray().map((t: any) => ({ ...t, tags: parseTags(t.tags) }));
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
    const unclaimedWork = pool.filter((t: any) => {
      const need = t.tags.filter((x: string) => x.startsWith("role:"));
      const m = JSON.parse(t.meta ?? "{}");
      const declared = m.qualification?.state ?? (m.qualified === true ? "qualified" : undefined);
      const qualified = declared === "qualified" || analysisEv.has(t.id) || parentQualified.has(t.id);
      const bars: string[] = m.qualification?.bars ?? [];
      const unmet = this.enforceableBars(bars).filter((b) => !(/review/.test(b) ? reviewEv : analysisEv).has(t.id));
      // role-tagged tasks are claimable by their gateway: the role lives in the
      // task, and dispatch IS that work (the Oct-20 frozen-backlog lesson)
      const dispatchedRoleWork = (t.tags ?? []).some((x: string) => ["role:analysis", "role:review", "role:impl", "role:unblock"].includes(x));
      // roles are playbooks, not gates: every agent sees everything claimable.
      // Flag instead of filter — agents stand down on work they can't do, and
      // the server's separation-of-duties check is the actual integrity gate.
      t.needs_qualification = !dispatchedRoleWork && (!qualified || unmet.length > 0);
      if (need.length) t.target_roles = need;
      return true;
    }).sort((a: any, b: any) => {
      // ranking: unblock children first (cheapest unblocking lever — a check
      // that releases parked work), then blocked-with-condition, then verify
      // duty, questions, plain todo.
      const rank = (t: any) => {
        const m = JSON.parse(t.meta ?? "{}");
        // human boost: priority 0, above unblock duty — the human's explicit
        // "process this (and its dependencies) first" (BR#911)
        if (m.boosted) return -1;
        if (t.tags?.includes("role:unblock")) return 0;
        if (t.status === "blocked" && (m.blocked?.unblock_condition ?? "").trim()) return 1;
        if (verifyParents.has(t.id)) return 2;
        if (t.tags?.includes("question")) return 3;
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
        t.awaiting_ask = m.awaiting_ask?.ask_id;
        t.is_claimable = !!t.unblock_condition; // resume via transition in_progress with resolution
        if (!t.unblock_condition) t.claim_reason = "blocked without an unblock condition — open the card, resolve or re-scope it";
      }
      // questions by kind (meta.kind = "question"), not by legacy tag — tags are
      // roles, kind is the pickup model. Legacy-tagged rows still register.
      t.is_question = isQuestionTask(m) || t.tags?.includes("question") || false;
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
      .map((t) => ({ role: t.slice(5), playbook: rolesSettings[t.slice(5)] ?? DEFAULT_ROLE_PLAYBOOKS[t.slice(5)] }))
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
         AND c.tags LIKE '%"role:review"%'
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
      ?? { label, ...scoreAgent({ progress_count: 0, gauge_count: 0, thin_notes: 0, abandoned: 0, reassigned: 0, asks_received: 0, asks_answered_on_time: 0, artefacts_created: 0 }) };
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
      my_roles: tags.filter((t) => t.startsWith("role:")),
      pending_asks: pendingAsks,
      action_required: actionRequired.length || verificationNotices.length
        ? [...actionRequired, ...verificationNotices]
        : undefined,
      gauge_debt: gaugeDebt.length ? gaugeDebt : undefined,
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
        this.version(t.id, "system:reaper", "transition", `rework loop escalated to human — ${attempts} attempts without completion`, { prev_owner: ownerLabel });
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
      this.version(t.id, "system:reaper", "transition", `reassigned — ${ownerLabel} ${idleDesc} (attempt ${attempts})`, { prev_owner: ownerLabel });
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
    for (const r of rows) map[r.key] = JSON.parse(r.value);
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
      `INSERT INTO settings (key, value) VALUES ('ws_slug', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
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
    const device_id = typeof body.device_id === "string" && body.device_id.trim() ? body.device_id.trim().slice(0, 80) : null;
    this.state.storage.sql.exec(
      `INSERT INTO pairings (code, device, type, device_id, status, created_ts) VALUES (?, ?, ?, ?, 'pending', ?)`,
      code, String(body.device ?? "device").slice(0, 80), type, device_id, now,
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
    const row = this.one(`SELECT code, created_ts, status, device, type, device_id FROM pairings WHERE code = ?`, code);
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
    if (!/^[a-zA-Z0-9._-]{2,40}$/.test(label)) throw new Error("label must be 2-40 chars [a-zA-Z0-9._-]");
    const member = this.one(`SELECT 1 FROM workspace_members WHERE ws = ? AND login = ?`, ws, login);
    if (!member) throw new Error(`you are not a member of workspace '${ws}'`);
    // mint in the target workspace's DO (registers hash → ws in the central
    // registry); the token flows to the DEVICE via poll, never to the approver
    const stub = (this.env as any).KB.get((this.env as any).KB.idFromName(doWs(ws)));
    const mintRes = await stub.fetch("https://kb/admin.mint", {
      method: "POST",
      headers: { "content-type": "application/json", "x-kb-admin": "1" },
      body: JSON.stringify({ label, tags, device_id: row.device_id ?? null }),
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
    if (!/^[a-zA-Z0-9._-]{2,40}$/.test(label)) throw new Error(`agent label '${label}' must be 2-40 chars [a-zA-Z0-9._-]`);
    const rotate = body.rotate === true;
    const ts = Date.now();
    const existing = this.one(`SELECT id, revoked_ts FROM auth_tokens WHERE label = ?`, label);
    if (existing && !rotate) {
      if (existing.revoked_ts) throw new Error(`token '${label}' was revoked — provision with rotate to re-mint`);
      return { exists: true, id: existing.id, label };
    }
    if (existing) {
      this.state.storage.sql.exec(`UPDATE auth_tokens SET revoked_ts = ? WHERE id = ?`, ts, existing.id);
      this.audit(caller, "rotate", label, { old: existing.id });
    }
    const secret = generateAuthToken();
    const hash = await hashAuthToken(secret);
    const id = `at_${crypto.randomUUID().slice(0, 8)}`;
    const tags = JSON.stringify(["provisioned", `by:${caller}`]);
    this.state.storage.sql.exec(
      `INSERT INTO auth_tokens (id, label, hash, tags, transport, device_id, created_ts) VALUES (?, ?, ?, ?, 'mcp', ?, ?)`,
      id, label, hash, tags, ts,
    );
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

  private async tokenMint(body: any) {
    const label = String(body.label ?? "").trim();
    if (!/^[a-zA-Z0-9._-]{2,40}$/.test(label)) throw new Error("label must be 2-40 chars [a-zA-Z0-9._-]");
    const device_id = typeof body.device_id === "string" && body.device_id.trim() ? body.device_id.trim().slice(0, 80) : null;
    // Replace semantics (pairing is an approval): the same machine re-pairing
    // rotates its token — renamed or not — and re-using a label REPLACES the
    // token that held it. A name has exactly one live token; nothing
    // accumulates, nothing dead-ends on "already exists".
    const secret = generateAuthToken();
    const hash = await hashAuthToken(secret);
    let own = device_id ? this.one(`SELECT id, label, revoked_ts FROM auth_tokens WHERE device_id = ?`, device_id) : null;
    const byLabel = this.one(`SELECT id, label, revoked_ts FROM auth_tokens WHERE label = ?`, label);
    if (own && byLabel && own.id !== byLabel.id) {
      // renaming this machine onto another token's name: that identity is
      // replaced (the human approved the pairing; one name, one live token)
      this.state.storage.sql.exec(`DELETE FROM auth_tokens WHERE id = ?`, byLabel.id);
      this.audit("pair", "replace", byLabel.id, { label });
    }
    const target = (own && !byLabel) ? own : (byLabel ?? own);
    if (target) {
      this.state.storage.sql.exec(
        `UPDATE auth_tokens SET hash = ?, label = ?, device_id = COALESCE(?, device_id), revoked_ts = NULL WHERE id = ?`,
        hash, label, device_id, target.id,
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
    const id = `at_${crypto.randomUUID().slice(0, 8)}`;
    const ts = Date.now();
    this.state.storage.sql.exec(
      `INSERT INTO auth_tokens (id, label, hash, tags, transport, device_id, created_ts) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      id, label, hash, JSON.stringify(tags), transport, device_id, ts,
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
        `INSERT INTO settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        k, JSON.stringify(v),
      );
      this.audit("admin", "settings", k, {});
    }
    return { settings: this.settingsMap() };
  }

  // ---------- GitHub enrichment ----------

  private ghCache = new Map<string, { ts: number; data: any }>();

  private async ghIssue(num: number): Promise<any | null> {
    if (!this.env.GH_TOKEN) return null;
    const repo = this.settingsMap().github_repo ?? "state-vector/superpositional";
    const key = `${repo}#${num}`;
    const hit = this.ghCache.get(key);
    if (hit && Date.now() - hit.ts < 600_000) return hit.data;
    try {
      const r = await fetch(`https://api.github.com/repos/${repo}/issues/${num}`, {
        headers: {
          authorization: `Bearer ${this.env.GH_TOKEN}`,
          accept: "application/vnd.github+json",
          "user-agent": "bridge-kb",
        },
      });
      if (!r.ok) return null;
      const data = await r.json();
      this.ghCache.set(key, { ts: Date.now(), data });
      return data;
    } catch { return null; }
  }

  /** Pull issue body/labels into a bare artefact. Idempotent via the "## From GitHub" marker. */
  private async enrichFromGitHub(id: string, num: number) {
    const row = this.one(`SELECT title, body_md, tags, updated_ts FROM artefacts WHERE id = ?`, id);
    if (!row || (row.body_md ?? "").includes("## From GitHub")) return null;
    const issue = await this.ghIssue(num);
    if (!issue) return null;
    const labels: string[] = (issue.labels ?? []).map((l: any) => String(l.name ?? l));
    const body = `${row.body_md ?? ""}\n## From GitHub — #${num}\n**${issue.title}** · state: ${issue.state}${labels.length ? ` · labels: ${labels.join(", ")}` : ""}\n\n${String(issue.body ?? "").slice(0, 2000)}\n`;
    const existing = parseTags(row.tags);
    const merged = [...new Set([...existing, ...labels.map((l) => l.toLowerCase().replace(/[^a-z0-9:_-]/g, "-"))])].slice(0, 10);
    this.state.storage.sql.exec(
      `UPDATE artefacts SET body_md = ?, tags = ?, updated_ts = ? WHERE id = ?`,
      body, JSON.stringify(merged), Date.now(), id,
    );
    await this.embedArtefact(id, row.title, body);
    this.audit("system", "enrich", id, { issue: num });
    return id;
  }

  /** Enrich one or all bare, issue-referencing tasks. */
  private async enrich(body: any, actor: string) {
    if (!this.env.GH_TOKEN) throw new Error("GH_TOKEN not configured — GitHub enrichment unavailable");
    const targets = body.id
      ? [String(body.id)]
      : this.state.storage.sql.exec(
          `SELECT id, title, body_md FROM artefacts
           WHERE type = 'task' AND status = 'open' OR (type = 'task' AND status IN ('todo','in_progress','blocked'))
           ORDER BY updated_ts DESC LIMIT 50`,
        ).toArray()
          .filter((r: any) => !(r.body_md ?? "").includes("## From GitHub"))
          .map((r: any) => r.id);
    const done: string[] = [];
    for (const id of targets) {
      const row = this.one(`SELECT title, body_md FROM artefacts WHERE id = ?`, id);
      if (!row) continue;
      const num = issueRef(row.title);
      if (num && !(row.body_md ?? "").includes("## From GitHub")) {
        const r = await this.enrichFromGitHub(id, num);
        if (r) done.push(id);
      }
    }
    this.audit(actor, "enrich", null, { count: done.length });
    return { enriched: done };
  }

  // ---------- helpers ----------

  private audit(actor: string, op: string, artefactId: string | null, detail: object) {
    const ts = Date.now();
    const r = this.state.storage.sql.exec(
      `INSERT INTO events (ts, actor, op, artefact_id, detail) VALUES (?, ?, ?, ?, ?) RETURNING seq`,
      ts, actor, op, artefactId, JSON.stringify(detail),
    ).toArray()[0] as any;
    this.broadcastEvent({ seq: Number(r?.seq ?? 0), ts, actor, op, artefact_id: artefactId, detail });
    // every mutation can move behaviour signals — drop the 30s score cache so
    // board reads after writes are fresh (the cache exists for DO row-read quota)
    this.scoreCache = null;
  }

  private async nextSeq(_type: ArtefactType): Promise<number> {
    const rows = this.state.storage.sql.exec(`SELECT id FROM artefacts`).toArray();
    let max = 0;
    for (const r of rows as any[]) {
      const m = /^BR#(\d+)$/.exec(String(r.id));
      if (m) max = Math.max(max, parseInt(m[1], 10));
    }
    return max + 1;
  }

  private one(query: string, ...params: any[]) {
    return this.state.storage.sql.exec(query, ...params).toArray()[0] ?? null;
  }

  private shape(row: any) {
    return { ...row, meta: JSON.parse(row.meta ?? "{}"), tags: parseTags(row.tags) };
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
