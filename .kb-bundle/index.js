var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });
var __esm = (fn, res, err2) => function __init() {
  if (err2) throw err2[0];
  try {
    return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
  } catch (e) {
    throw err2 = [e], e;
  }
};
var __commonJS = (cb, mod) => function __require() {
  try {
    return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
  } catch (e) {
    throw mod = 0, e;
  }
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// src/kb/core.ts
function isArtefactType(t) {
  return typeof t === "string" && ARTEFACT_TYPES.includes(t);
}
function parseRolesInput(raw) {
  if (raw == null) return { ok: true, roles: [] };
  const arr = typeof raw === "string" ? raw.split(",") : raw;
  if (!Array.isArray(arr)) return { ok: false, error: "roles must be an array of role names" };
  const out = [];
  for (const v of arr) {
    const name = String(v ?? "").trim().toLowerCase().replace(/^role:/, "");
    if (!name) continue;
    if (!ROLE_NAMES.includes(name))
      return { ok: false, error: `unknown role '${name}' (valid: ${ROLE_NAMES.join(", ")})` };
    if (!out.includes(name)) out.push(name);
  }
  return { ok: true, roles: out.slice(0, 5) };
}
function splitSystemTags(rowType, rawTags, meta, now) {
  const tags = [...rawTags];
  const roles = [...new Set(tags.filter((t) => t.startsWith("role:")).map((t) => t.slice(5)))];
  const wasQuestion = tags.includes("question");
  const wasAttempted = tags.includes("attempted");
  const rest = tags.filter((t) => !t.startsWith("role:") && t !== "question" && t !== "attempted");
  const m = meta && typeof meta === "object" ? { ...meta } : {};
  let type = rowType;
  if (rowType === "task" && wasQuestion) type = "question";
  if (wasAttempted && !m.attempt) m.attempt = { by: "system:migration", at: now, attempts: 1 };
  const changed = roles.length > 0 || rest.length !== tags.length || type !== rowType || wasAttempted && !(meta && typeof meta === "object" && meta.attempt);
  return { type, tags: rest, roles, meta: m, changed };
}
function taskKind(meta) {
  const k = typeof meta?.kind === "string" ? meta.kind : void 0;
  return TASK_KINDS.includes(k ?? "") ? k : "impl";
}
function isQuestionTask(meta) {
  return taskKind(meta) === "question";
}
function validateTransition(type, from, to) {
  const allowed = LIFECYCLES[type]?.[from];
  if (!allowed) return { ok: false, reason: `status '${from}' is terminal for ${type}` };
  if (!allowed.includes(to))
    return { ok: false, reason: `${type}: '${from}' \u2192 '${to}' not allowed (allowed: ${allowed.join(", ")})` };
  return { ok: true };
}
function isRelation(r) {
  return typeof r === "string" && RELATIONS.includes(r);
}
function validateRelation(relation, srcType, dstType) {
  if (relation === "supersedes" && srcType !== dstType)
    return { ok: false, reason: "supersedes requires both artefacts to have the same type" };
  if (relation === "implements" && !(srcType === "task" && dstType === "goal"))
    return { ok: false, reason: "implements: source must be a task, target a goal" };
  if (relation === "constrains" && srcType !== "steering")
    return { ok: false, reason: "constrains: source must be steering" };
  if (relation === "child_of" && !((srcType === "task" || srcType === "question") && dstType === "task"))
    return { ok: false, reason: "child_of: source must be a task or question, target a task (flat structure \u2014 the board never nests, relations do)" };
  return { ok: true };
}
function formatId(seq) {
  return `BR#${seq}`;
}
function ftsQuery(input) {
  const tokens = input.replace(/["'`*():^{}[\]-]/g, " ").split(/\s+/).map((t) => t.trim()).filter((t) => t.length > 1);
  if (tokens.length === 0) return null;
  return tokens.map((t) => `"${t}"`).join(" OR ");
}
function isWsSlug(s) {
  return typeof s === "string" && WS_RE.test(s);
}
function generateAuthToken(ws) {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  const hex2 = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return isWsSlug(ws) ? `bkw_${ws}_${hex2}` : `bkw_${hex2}`;
}
async function hashAuthToken(secret) {
  const digest2 = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return [...new Uint8Array(digest2)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function tokenWorkspace(secret) {
  const m = secret.match(/^bkw_([a-z0-9][a-z0-9-]{0,39})_[0-9a-f]{48}$/);
  return m ? m[1] : null;
}
function tagsSayGateway(tags) {
  return parseTags(tags).some((t) => t.toLowerCase() === "gateway");
}
function selfProvisionLabel(host) {
  const raw = typeof host === "string" ? host : "";
  const slug = raw.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30);
  return slug || "device";
}
function doWs(ws) {
  return ws === DEFAULT_WS_SLUG ? "global" : `ws:${ws}`;
}
function isValidAskTarget(to) {
  if (!to || to.length > 120) return false;
  if (to === "any") return true;
  if (to.startsWith("tag:")) return /^[a-z0-9:_-]{1,100}$/.test(to.slice(4));
  return /^[a-zA-Z0-9._@-]{1,100}$/.test(to);
}
function composeBootstrap(projectName, board) {
  const lines = [
    `BRIDGE OPERATING RULES \u2014 ${projectName || DEFAULT_PROJECT}. Follow all of them.`,
    `1. BRIDGE RESPONSE PROMPTS ARE COMMANDS. Responses carry note / attention / coordination / hint fields and orient carries my_score.hints. Read them, comply. That is how the hub steers you mid-session.`,
    `2. orient first, every session (session: "<unique-name>"). Work from its response, not memory. Pass session on every tool call \u2014 claims, transitions, progress. Multi-session agents are ambiguous without it, and separation of duties is enforced per session.`,
    `3. Check before you build: search_knowledge + get_artefact before starting or creating anything. If someone owns overlapping open work, ask_agent \u2014 don't fork.`,
    `4. HEARTBEAT: while in_progress, log_progress at least every 10 minutes \u2014 did (what just happened) + will (what you do next) + sentiment + gauges (completion_pct, confidence_pct, risk_pct, context_pct \u2014 0-100; context_pct = how full your context window is, report it so the board can spot sessions that should hand off before quality degrades). Silence >10m = abandoned: the task is reassigned and your score drops. Re-claim by logging progress.`,
    `4b. DECLARE SILENCE before any quiet stretch >10m: short op still yours (build, CI wait) \u2192 log_progress {will, grace_minutes \u2264 60}. Long or handed-off op (re-index, deploy, background batch) \u2192 transition {to: "blocked", class: "subprocess", note, unblock_condition, budget_minutes \u2264 1440}. Declared silence is honest and watchdog-safe; undeclared silence = abandoned. Overrun your declared window and it trips as abandoned anyway.`,
    `5. Status is your responsibility: claim \u2192 in_progress immediately; finish \u2192 in_review with the PR link in the note; stuck \u2192 blocked with BOTH a reason and an unblock condition. in_review is NOT done: you stay owner, poll get_history {id} for the verdict \u2014 bounce = action the findings; done = released. Gates are enforced \u2014 unqualified todo is picked up only by role:analysis/role:review agents; done requires review acceptance. Don't route around them; qualify, review, resolve.`,
    `5b. SEPARATION OF DUTIES: analysis, impl, and review happen in different sessions \u2014 every agent can do all three, never in one session. A session that completed the analysis on a task cannot claim it for impl (the gate also auto-releases the parent if you try); a session that implemented cannot produce the review. Verification is a double-check by a fresh session: check the actual state (PR, findings) and cite receipts in the note \u2014 a review without receipts is rejected. If a gate rejects you, end the session and start a new one.`,
    `5c. VERIFY GATE \u2014 mergeability is a precondition, NOT a finding (2026-10-23 unsigned-PR incident). Verification agents: BEFORE any substance check, confirm the PR is mechanically mergeable \u2014 gh pr view --json mergeable,mergeStateStatus,reviewDecision AND every commit signature isValid=true. mergeable=false / CONFLICTING / any unsigned or NO_USER commit \u2192 STOP: zero substance checks, and bounce the parent to in_progress with the mechanical defect ("PR #N unmergeable \u2014 unsigned commits | conflicts | failing check X. Re-sign/rebase/resolve and re-push"). Never file a human ask for a mechanical defect, never report "verified, awaiting merge" for an unmergeable PR (false report \u2014 it has zero verified legs), and never treat "accept the unsigned commit" as an option (the ruleset forbids it by construction). The ONLY escalation to a human: a broken signing environment (key unavailable / NO_USER) \u2014 one ask describing the environment covers the whole class, never one per PR.`,
    `6. Blocked on a decision \u2192 ask_agent immediately, bound to your task (artefact_id). The ask pauses the watchdog; the answer auto-resumes you.`,
    `6b. QUESTIONS are tasks tagged 'question' \u2014 answered, not claimed. Contribute via log_progress {id, did, will}; any number of agents, additive input. The author weighs contributions and closes it with an ADR (decision artefact, derived_from the task, contributors + receipts in the body). Answers thin? the author adds steering with specifics and re-issues the task in todo. Humans are the final escalation \u2014 consensus among agents escalates to them for the last say.`,
    `7. Findings belong in Knowledge, not session memory. Open questions become question tasks; conclusions become decisions.`,
    `7b. DOCS RIDE WITH THE CHANGE: if your work alters user-visible behaviour (UI, config, protocol, gates), update README.md and packages/site/content.md in the same branch \u2014 the docs are the interface, stale docs are a defect.`,
    `8. Accepted decisions are settled. Steering constrains you. Supersede, never contradict.`,
    `9. Real progress or let go: if you cannot advance a claimed task this run, transition it \u2192 todo (retry) \u2014 that releases the claim so any matching agent can pick it up fresh. Squatting on untouched work starves the pool.`,
    `DELEGATION: if you spawn subagents, copy the PROTOCOL CARD below verbatim to the top of each subagent's prompt.`,
    `PROTOCOL CARD: 1. START: orient (session: "<unique-name>"). 2. CLAIM: transition {id, to: "in_progress", session} before coding. 3. HEARTBEAT: log_progress {id, did, will, session} every \u226410 min. 4. LONG OP: declare silence \u2014 grace_minutes or subprocess-block with a budget. 5. UNCERTAIN: ask_agent first. 6. FINISH: PR, then transition {to: "in_review", note: "PR <link>"} \u2014 a Verify task auto-spawns into the pool; a fresh-session verifier closes or bounces. Verification is a double-check with receipts \u2014 mergeability first (2026-10-23 rule).`,
    `Scoring: orient returns my_score \u2014 it measures heartbeats, gauge completeness, answered asks, zero abandonments. Raise it by following rules 1\u20138.`
  ];
  if (board.mode === "external") {
    lines.push(
      `Work is tracked on the team's external board${board.kind ? ` (${board.kind})` : ""}${board.url ? `: ${board.url}` : "."} Follow it.`
    );
    if (board.prompt) lines.push(board.prompt);
  }
  return lines.join("\n");
}
function resolveRolePlaybook(rolesSettings, role2) {
  const v = rolesSettings?.[role2];
  if (typeof v === "string" && v.trim()) return v.trim();
  return DEFAULT_ROLE_PLAYBOOKS[role2] ?? "";
}
function isSentiment(v) {
  return typeof v === "string" && SENTIMENTS.includes(v);
}
function sanitizeTags(raw) {
  const arr = typeof raw === "string" ? raw.split(",") : raw;
  if (!Array.isArray(arr)) return null;
  const out = [...new Set(arr.map((t) => String(t).trim().toLowerCase().replace(/[^a-z0-9:_-]/g, "-")).filter((t) => t.length > 0 && t.length <= 30))].slice(0, 10);
  return out.length ? out : null;
}
function parseTags(raw) {
  if (raw == null || raw === "") return [];
  let v = raw;
  const unwrap3 = /* @__PURE__ */ __name((x, depth) => {
    if (typeof x === "string") {
      const s = x.trim();
      if (!s) return [];
      if (s.startsWith("[") || s.startsWith('"')) {
        try {
          return unwrap3(JSON.parse(s), depth + 1);
        } catch {
          return [s];
        }
      }
      if (s.includes(",")) return s.split(",").map((t) => t.trim()).filter(Boolean);
      return [s];
    }
    if (Array.isArray(x)) return x.flatMap((e) => unwrap3(e, depth + 1));
    return [];
  }, "unwrap");
  return unwrap3(v, 0);
}
function checkLimits(title, body, meta) {
  if (!title.trim()) return "title is required";
  if (title.length > LIMITS.title) return `title exceeds ${LIMITS.title} chars`;
  if (body.length > LIMITS.body) return `body exceeds ${LIMITS.body} chars`;
  if (meta !== void 0 && (typeof meta !== "object" || meta === null || Array.isArray(meta)))
    return "meta must be an object";
  if (meta && Object.keys(meta).length > LIMITS.metaKeys)
    return `meta exceeds ${LIMITS.metaKeys} keys`;
  return null;
}
function verifyVerdictStatement(meta) {
  const m = meta ?? {};
  const target = String(m.task ?? m.verify_target ?? "").trim() || "the task";
  const isBounce = String(m.verdict ?? "").toLowerCase() === "bounce";
  const session = String(m.session ?? "").trim();
  const roundRaw = m.round ?? m.verify_round;
  const round = roundRaw == null || roundRaw === "" ? null : Number(roundRaw);
  const effect = isBounce ? `bounces **${target}** back to \`in_progress\` with the findings` : `closes **${target}** as **done**`;
  const checked = `the receipts below were checked live${session ? ` by session \`${session}\`` : ""}${round ? ` (round ${round})` : ""}`;
  return [
    `> \u2696\uFE0F **What you are deciding** \u2014 *auto-added, not part of the verifier's receipts*`,
    `>`,
    `> You are the acceptance gate: agents propose, only a human accepts. Your click settles the verdict.`,
    `> - **Accept** = ratify it \u2014 the verdict ${effect}.`,
    `> - **Supersede** = the verdict doesn't hold; record why.`,
    `> You are NOT being asked to re-verify \u2014 ${checked}.`
  ].join("\n");
}
function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}
function hybridMerge(fts, vec, k = 20) {
  const byId = /* @__PURE__ */ new Map();
  for (const r of fts) {
    const e = byId.get(r.id) ?? { score: 0, via: /* @__PURE__ */ new Set() };
    e.score = Math.max(e.score, r.score);
    e.via.add("keyword");
    byId.set(r.id, e);
  }
  for (const r of vec) {
    const e = byId.get(r.id) ?? { score: 0, via: /* @__PURE__ */ new Set() };
    e.score = Math.max(e.score, r.score);
    e.via.add("semantic");
    byId.set(r.id, e);
  }
  return [...byId.entries()].map(([id, e]) => ({ id, score: e.score, via: [...e.via] })).sort((a, b) => b.score - a.score).slice(0, k);
}
function embedText(title, body) {
  return (title + "\n" + title + "\n" + body).slice(0, 4e3);
}
function issueRef(title) {
  const m = /#(\d+)/.exec(title);
  return m ? parseInt(m[1], 10) : null;
}
function scaffoldBody(title, owner) {
  return `## Context
Raised by ${owner || "unknown"} \u2014 no detail provided at creation.

## Acceptance
- (to be defined)
`;
}
function trigramVec(text2, dim = TRIGRAM_DIM) {
  const clean = text2.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const v = new Array(dim).fill(0);
  const padded = `  ${clean}  `;
  for (let i = 0; i < padded.length - 2; i++) {
    const g = padded.slice(i, i + 3);
    let h = 0;
    for (let j = 0; j < g.length; j++) h = h * 31 + g.charCodeAt(j) >>> 0;
    v[h % dim] += 1;
  }
  const norm = Math.sqrt(v.reduce((a, x) => a + x * x, 0));
  return norm ? v.map((x) => x / norm) : v;
}
function scoreAgent(raw) {
  const s = { ...raw };
  for (const k of ["progress_count", "gauge_count", "thin_notes", "abandoned", "reassigned", "asks_received", "asks_answered_on_time", "artefacts_created"])
    if (typeof s[k] !== "number" || Number.isNaN(s[k])) s[k] = 0;
  let score = 50;
  const hints = [];
  score += Math.min(20, s.gauge_count * 2);
  score -= Math.min(25, s.abandoned * 10);
  if (s.abandoned > 0)
    hints.push(`${s.abandoned} task(s) went silent and were watchdog-blocked \u2014 send log_progress every \u226410m`);
  score -= Math.min(30, s.reassigned * 15);
  if (s.reassigned > 0)
    hints.push(`${s.reassigned} task(s) were taken from you after going silent post-abandonment \u2014 reclaim abandoned work or it is reassigned to other agents`);
  score += Math.min(15, s.asks_answered_on_time * 3);
  if (s.asks_received >= 2 && s.asks_answered_on_time === 0)
    hints.push("asks addressed to you went unanswered \u2014 they block other agents; answer or redirect them");
  score += Math.min(10, s.artefacts_created * 2);
  if (s.artefacts_created === 0)
    hints.push("no artefacts created in the last 7 days \u2014 outcomes belong in Knowledge, not session memory");
  score -= Math.min(10, s.thin_notes * 2);
  if (s.thin_notes > 2)
    hints.push(`${s.thin_notes} progress notes looked like padding \u2014 write what actually happened`);
  if (s.verify_duty_backlog > 0) {
    score -= Math.min(20, s.verify_duty_backlog * 10);
    hints.push(`${s.verify_duty_backlog} stalled verify task(s) are unclaimed and blocking their parent's owner \u2014 pick one up: check receipts, close or bounce the parent`);
  }
  score = Math.max(0, Math.min(100, Math.round(score)));
  const grade = score >= 80 ? "excellent" : score >= 60 ? "good" : score >= 40 ? "fair" : "poor";
  return { score, grade, hints };
}
function classifyMainCheckRuns(runs) {
  if (!runs.length) return { verdict: "empty", red: [], unsettled: [], green: 0 };
  const byName = /* @__PURE__ */ new Map();
  for (const r of runs) {
    const list = byName.get(r.name ?? "") ?? [];
    list.push(r);
    byName.set(r.name ?? "", list);
  }
  const red = [];
  const unsettled = [];
  let green = 0;
  for (const [name, list] of byName) {
    const judge = [...list].sort((a, b) => (b.id ?? 0) - (a.id ?? 0)).find((r) => r.conclusion !== "cancelled");
    if (!judge || judge.conclusion == null) {
      unsettled.push(judge ? name : `${name} (only cancelled runs)`);
      continue;
    }
    if (MAIN_RED_CONCLUSIONS.has(judge.conclusion)) {
      red.push({ name, conclusion: judge.conclusion, url: judge.html_url ?? "" });
    } else if (judge.conclusion === "success" || judge.conclusion === "skipped" || judge.conclusion === "neutral") {
      green += 1;
    } else {
      unsettled.push(`${name} (unknown conclusion: ${judge.conclusion})`);
    }
  }
  if (red.length) return { verdict: "red", red, unsettled, green };
  if (unsettled.length) return { verdict: "unsettled", red, unsettled, green };
  return { verdict: "green", red, unsettled, green };
}
function stopLineAskTitle(sha, names) {
  const prefix = `STOP THE LINE: bridge main ${sha.slice(0, 9)} is RED (`;
  const suffix = `) \u2014 merges halted until green. Acknowledge?`;
  const budget = 240 - prefix.length - suffix.length;
  let namesText = names.join(", ");
  if (namesText.length > budget) namesText = namesText.slice(0, Math.max(0, budget - 1)).trimEnd() + "\u2026";
  return prefix + namesText + suffix;
}
function isExemptCheckName(name) {
  const n = name.toLowerCase();
  return MERGE_EXEMPT_CHECK_PATTERNS.some((p) => n.includes(p));
}
function classifyHeadChecks(runs) {
  const red = [];
  const unsettled = [];
  const external = [];
  let green = 0;
  for (const r of runs) {
    if (r.conclusion == null) {
      if (isExemptCheckName(r.name ?? "")) continue;
      unsettled.push(r.name ?? "");
      continue;
    }
    if (isExemptCheckName(r.name ?? "")) {
      if (MAIN_RED_CONCLUSIONS.has(r.conclusion)) external.push({ name: r.name ?? "", conclusion: r.conclusion, url: r.html_url ?? "" });
      else if (r.conclusion === "success" || r.conclusion === "skipped" || r.conclusion === "neutral") green += 1;
      continue;
    }
    if (MAIN_RED_CONCLUSIONS.has(r.conclusion)) red.push({ name: r.name ?? "", conclusion: r.conclusion, url: r.html_url ?? "" });
    else if (r.conclusion === "success" || r.conclusion === "skipped" || r.conclusion === "neutral") green += 1;
    else unsettled.push(r.name ?? "");
  }
  if (red.length) return { verdict: "red", red, unsettled, external, green };
  if (unsettled.length) return { verdict: "unsettled", red, unsettled, external, green };
  return { verdict: "green", red, unsettled, external, green };
}
function decideMergeAction(i) {
  if (i.cardStatus === "superseded")
    return { kind: "close_superseded", reason: "linked card is superseded \u2014 closing PR without review" };
  if (i.cardStatus === "done")
    return { kind: "skip", reason: "linked card already done \u2014 nothing to merge under it" };
  const short = i.headSha.slice(0, 9);
  if (i.mergeable !== true) {
    if (i.mergeable === null) return { kind: "skip", reason: "GitHub still computing mergeability \u2014 not yet, skip this tick" };
    return { kind: "bounce", defect: `PR #${i.prNumber} unmergeable \u2014 CONFLICTING against base. Rebase, resolve, re-push, re-enter the queue` };
  }
  if (i.mergeStateStatus && i.mergeStateStatus !== "clean" && i.mergeStateStatus !== "unstable")
    return { kind: "bounce", defect: `PR #${i.prNumber} mergeStateStatus=${i.mergeStateStatus} \u2014 not clean. Fix the named state (rebase/re-sign/re-approve) and re-enter` };
  const unverified = i.commits.filter((c) => !c.verified);
  if (unverified.length)
    return { kind: "human_leg", reason: `PR #${i.prNumber} has ${unverified.length} commit(s) not GitHub-verified \u2014 signing-environment class, never per-PR` };
  if (i.baseVerdict !== "green")
    return { kind: "skip", reason: `base main ${i.baseVerdict === "red" ? "RED" : "not green"} \u2014 the standing order never merges onto a non-green destination; the stop-the-line sweep owns the alert` };
  const head = classifyHeadChecks(i.headChecks);
  if (head.verdict === "red") {
    const names = head.red.map((r) => r.name).join(", ");
    return i.cardStatus === "in_review" ? { kind: "bounce", defect: `PR #${i.prNumber} head check RED: ${names}. Fix or bounce to impl` } : { kind: "note", reason: `PR #${i.prNumber} head check RED: ${names} \u2014 card not in_review, no bounce; the linked session owns it` };
  }
  if (head.verdict === "unsettled") return { kind: "skip", reason: `head checks unsettled (${head.unsettled.join(", ")}) \u2014 not yet, skip this tick` };
  if (i.cardStatus === "in_review" && i.verifyAcceptedAny && !i.verifyAcceptedOnHead)
    return { kind: "bounce", defect: `PR #${i.prNumber} head ${short} moved past the accepted verify verdict \u2014 re-verify the new head (a mechanical rebase is content-preserving; fresh 5c only)` };
  if (!i.verifyAcceptedOnHead)
    return { kind: "skip", reason: `no accepted verify verdict covering head ${short} \u2014 the verify pool owns the verdict; the sweep merges only verified PRs` };
  return { kind: "merge", receipt: `PR #${i.prNumber} merged by the standing merge sweep (BR#3033): head ${short} \u2014 5c gate pass (mergeable, clean, ${i.commits.length} verified commits), base green, head checks green, verify accepted on head` };
}
function mergeSweepHumanLegTitle(repo, reasons) {
  const prefix = `Merge sweep human legs on ${repo}: `;
  const suffix = ` \u2014 fix the class?`;
  const budget = 240 - prefix.length - suffix.length;
  let text2 = reasons.join("; ");
  if (text2.length > budget) text2 = text2.slice(0, Math.max(0, budget - 1)).trimEnd() + "\u2026";
  return prefix + text2 + suffix;
}
var ARTEFACT_TYPES, TASK_KINDS, KIND_TYPE, KIND_ROLE, KIND_TAG, ROLE_NAMES, LIFECYCLES, INITIAL_STATUS, RELATIONS, WS_RE, DEFAULT_WS_SLUG, ASK_OPEN, ASK_ANSWERED, TRANSPORTS, DEFAULT_BOARD, DEFAULT_PROJECT, DEFAULT_CRON_PLAYBOOK, DEFAULT_ROLE_PLAYBOOKS, SENTIMENTS, LIMITS, EMBED_MODEL, TRIGRAM_DIM, MAIN_RED_CONCLUSIONS, MERGE_EXEMPT_CHECK_PATTERNS;
var init_core = __esm({
  "src/kb/core.ts"() {
    ARTEFACT_TYPES = [
      "steering",
      "goal",
      "decision",
      "task",
      "question",
      "progress",
      "agent"
    ];
    __name(isArtefactType, "isArtefactType");
    TASK_KINDS = ["impl", "analysis", "review", "research", "question"];
    KIND_TYPE = { question: "question" };
    KIND_ROLE = { analysis: "analysis", review: "review" };
    KIND_TAG = { research: "research" };
    ROLE_NAMES = ["impl", "analysis", "review", "unblock", "human"];
    __name(parseRolesInput, "parseRolesInput");
    __name(splitSystemTags, "splitSystemTags");
    __name(taskKind, "taskKind");
    __name(isQuestionTask, "isQuestionTask");
    LIFECYCLES = {
      steering: { draft: ["active"], active: ["superseded"] },
      goal: { draft: ["active"], active: ["achieved", "dropped"] },
      decision: { proposed: ["accepted", "superseded"], accepted: ["superseded"] },
      task: { todo: ["in_progress", "blocked"], in_progress: ["in_review", "done", "blocked", "todo"], in_review: ["done", "in_progress", "blocked"], blocked: ["in_progress", "todo"] },
      // questions are answered, never claimed: todo → done (answer) or superseded (closed by ADR)
      question: { todo: ["done", "superseded"] },
      progress: {},
      agent: {}
    };
    INITIAL_STATUS = {
      steering: "draft",
      goal: "draft",
      decision: "proposed",
      task: "todo",
      question: "todo",
      progress: "logged",
      agent: "active"
    };
    __name(validateTransition, "validateTransition");
    RELATIONS = [
      "supports",
      "contradicts",
      "constrains",
      "implements",
      "supersedes",
      "depends_on",
      "discusses",
      "derived_from",
      "child_of",
      "relates"
    ];
    __name(isRelation, "isRelation");
    __name(validateRelation, "validateRelation");
    __name(formatId, "formatId");
    __name(ftsQuery, "ftsQuery");
    WS_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
    __name(isWsSlug, "isWsSlug");
    __name(generateAuthToken, "generateAuthToken");
    __name(hashAuthToken, "hashAuthToken");
    __name(tokenWorkspace, "tokenWorkspace");
    __name(tagsSayGateway, "tagsSayGateway");
    __name(selfProvisionLabel, "selfProvisionLabel");
    DEFAULT_WS_SLUG = "state-vector";
    __name(doWs, "doWs");
    __name(isValidAskTarget, "isValidAskTarget");
    ASK_OPEN = "open";
    ASK_ANSWERED = "answered";
    TRANSPORTS = ["mcp", "a2a", "acp-proxy", "board"];
    DEFAULT_BOARD = { mode: "none" };
    DEFAULT_PROJECT = "Superpositional";
    __name(composeBootstrap, "composeBootstrap");
    DEFAULT_CRON_PLAYBOOK = `You run in single-shot ticks on a schedule \u2014 each run is one pass, not a conversation.
1. REBASE LEG (standing order BR#3033): the hub's deterministic merge-queue sweep (BR#3198) drains mergeable PRs every tick automatically \u2014 do NOT duplicate its merges or its bounces. Your role is the repair leg: a card bounced by the sweep (note: "unmergeable \u2014 CONFLICTING", "mergeStateStatus=...", or "head moved past the accepted verify verdict") is yours to claim: rebase onto current main, resolve conflicts mechanically (substance-preserving), re-sign as detached-cody per BR#3181, re-push with --force-with-lease \u2014 it re-enters the sweep next tick. A red substance check bounce means the implementation is wrong: claim, fix, re-enter.
2. Answer your asks first (asks + answer_ask): an answer unblocks whoever is waiting, and open asks pause their watchdog.
3. If you own in_progress tasks: log_progress on each (one line + sentiment \u2014 the heartbeat) WITH gauges (completion_pct/confidence_pct/risk_pct/context_pct \u2014 rows without gauges show no stats and the board can't prioritise them), then resume the oldest one.
4. Otherwise claim ONE task from unclaimed_work that matches your role tags: transition it to in_progress. Claiming sets you as owner; you own it end-to-end. VERIFY-FIRST: verify duties (children of in_review tasks) and unblock duties outrank new impl claims \u2014 an in_review task parks its owner until a fresh session rules on it; clear those before starting new work.
5. Finish cleanly or hand back: in_review when complete (PR link in the note \u2014 and the PR itself must be MERGEABLE: rebase onto main before every in_review, keep checks green. A conflicting PR is YOUR defect, not the reviewer's \u2014 verify bounces it straight back). Blocked with BOTH a reason and an unblock condition, then ask_agent, when a decision is needed; transition to todo (retry) when you cannot make real progress this tick.
6. Nothing claimable this tick: exit quietly. No filler artefacts, no noise.`;
    DEFAULT_ROLE_PLAYBOOKS = {
      analysis: `DECOMPOSE, DON'T BUILD: your job is to make work READY, not to do it.
- Unqualified todo is gated to you on purpose (the pickup gate routes it here). That gate is your job description.
- Analyse first: search_knowledge the topic, get_artefact the task and its see_also; coordinate via ask_agent instead of forking overlapping work.
- Decompose into child tasks (child_of the parent): one per coherent unit, each carrying its role (roles: ["impl"] / ["review"] \u2014 never tags), each carrying concrete checkable acceptance criteria in body_md ("done when X" plus what is OUT of scope). A vague child task is a defect you created; rewrite it before you finish.
- Qualify the parent by completing an analysis child (roles: ["analysis"]) that summarises the plan and open questions, then transition it to done. A done analysis child is what lifts the parent's pickup gate. If the publisher requested stacked bars (await), create the matching review child (roles: ["review"]) so the bar can be met.
- Never implement the children; never transition the parent to done. Unanalysable? Move it to blocked with a reason + unblock condition and ask the specific question.`,
      impl: `BUILD: claim qualified work matching your roles, work it to a natural stopping point, and hand over for review \u2014 in_review with the PR link in the note. You cannot self-approve done; you stay owner until the verdict.`,
      review: `VERIFY: claim role:review tasks. Check the work against the parent's acceptance criteria, record a verdict (decision artefact linked to the implementation, transitioned to accepted or rejected with reasons), and link it. Your accepted verdict is what lets work complete.`
    };
    __name(resolveRolePlaybook, "resolveRolePlaybook");
    SENTIMENTS = ["going_well", "neutral", "struggling", "converging", "diverging"];
    __name(isSentiment, "isSentiment");
    __name(sanitizeTags, "sanitizeTags");
    __name(parseTags, "parseTags");
    LIMITS = {
      title: 300,
      body: 1e5,
      metaKeys: 20,
      relationsPerArtefact: 100
    };
    __name(checkLimits, "checkLimits");
    __name(verifyVerdictStatement, "verifyVerdictStatement");
    __name(cosine, "cosine");
    __name(hybridMerge, "hybridMerge");
    __name(embedText, "embedText");
    EMBED_MODEL = "@cf/baai/bge-base-en-v1.5";
    __name(issueRef, "issueRef");
    __name(scaffoldBody, "scaffoldBody");
    TRIGRAM_DIM = 256;
    __name(trigramVec, "trigramVec");
    __name(scoreAgent, "scoreAgent");
    MAIN_RED_CONCLUSIONS = /* @__PURE__ */ new Set([
      "failure",
      "timed_out",
      "action_required",
      "startup_failure"
    ]);
    __name(classifyMainCheckRuns, "classifyMainCheckRuns");
    __name(stopLineAskTitle, "stopLineAskTitle");
    MERGE_EXEMPT_CHECK_PATTERNS = [
      "workers builds",
      "workers-builds",
      "cloudflare pages",
      "cloudflare workers",
      "deploy preview",
      "codeql"
    ];
    __name(isExemptCheckName, "isExemptCheckName");
    __name(classifyHeadChecks, "classifyHeadChecks");
    __name(decideMergeAction, "decideMergeAction");
    __name(mergeSweepHumanLegTitle, "mergeSweepHumanLegTitle");
  }
});

// src/kb/throughput.ts
function parseThroughputParams(bucket, range) {
  const b = String(bucket ?? "day");
  if (!(b in BUCKET_MS)) return { error: `bucket must be one of ${Object.keys(BUCKET_MS).join(", ")} (got '${b}')` };
  const m = /^(\d{1,3})d?$/.exec(String(range ?? "30d"));
  if (!m) return { error: `range must look like '30d' or '30' (got '${String(range)}')` };
  const days = parseInt(m[1], 10);
  if (days < 1 || days > 365) return { error: `range must be 1-365 days (got ${days})` };
  return { bucket: b, rangeDays: days };
}
function aggregateThroughput(events, fallback, opts) {
  const bucketMs = BUCKET_MS[opts.bucket];
  const to = opts.now;
  const from = to - opts.rangeDays * 864e5;
  const lastStart = Math.floor(to / bucketMs) * bucketMs;
  const firstStart = lastStart - (Math.ceil(opts.rangeDays * 864e5 / bucketMs) - 1) * bucketMs;
  const nBuckets = Math.round((lastStart - firstStart) / bucketMs) + 1;
  const buckets = Array.from({ length: nBuckets }, (_, i) => ({ t: firstStart + i * bucketMs, n: 0, cumulative: 0 }));
  const seenViaEvent = /* @__PURE__ */ new Set();
  let running = 0;
  const idxOf = /* @__PURE__ */ __name((ts) => ts < from ? -1 : Math.floor(ts / bucketMs) - Math.floor(firstStart / bucketMs), "idxOf");
  for (const e of events) {
    seenViaEvent.add(e.artefact_id);
    const idx = idxOf(e.ts);
    if (idx >= 0 && idx < nBuckets) buckets[idx].n++;
  }
  for (const f of fallback) {
    if (seenViaEvent.has(f.id)) continue;
    const idx = idxOf(f.status_ts);
    if (idx >= 0 && idx < nBuckets) buckets[idx].n++;
  }
  for (const b of buckets) {
    running += b.n;
    b.cumulative = running;
  }
  return buckets;
}
var BUCKET_MS;
var init_throughput = __esm({
  "src/kb/throughput.ts"() {
    BUCKET_MS = { day: 864e5, week: 7 * 864e5 };
    __name(parseThroughputParams, "parseThroughputParams");
    __name(aggregateThroughput, "aggregateThroughput");
  }
});

// src/kb/provenance.ts
function prCardRef(branch, text2) {
  const br = /(?:^|[/\-_])BR-?(\d{1,6})(?:[/\-_]|$)/i.exec(branch ?? "");
  if (br) return `BR#${br[1]}`;
  const tx = /BR#(\d{1,6})/.exec(text2 ?? "");
  return tx ? `BR#${tx[1]}` : null;
}
function signerFromCommits(commits) {
  if (!commits.length) return "unknown";
  if (commits.some((c) => c.verified && /detached-cody|297316395\+/.test(c.committer_email ?? ""))) return "detached-cody";
  if (commits.every((c) => c.verified)) return "signed";
  if (commits.some((c) => c.verified)) return "partially-signed";
  return "unsigned";
}
function parseProvenanceSha(sp) {
  const sha = String(sp.get("sha") ?? "").trim().toLowerCase();
  if (!/^[0-9a-f]{7,40}$/.test(sha)) throw new Error("provenance lookup needs ?sha=<7-40 hex chars>");
  return sha;
}
function withinBackfillWindow(mergedAtIso, now, backfillDays) {
  if (!mergedAtIso) return null;
  const t = Date.parse(mergedAtIso);
  if (!Number.isFinite(t)) return null;
  if (t < now - backfillDays * 864e5) return null;
  return t;
}
var init_provenance = __esm({
  "src/kb/provenance.ts"() {
    __name(prCardRef, "prCardRef");
    __name(signerFromCommits, "signerFromCommits");
    __name(parseProvenanceSha, "parseProvenanceSha");
    __name(withinBackfillWindow, "withinBackfillWindow");
  }
});

// src/kb/machine.ts
function effectiveRole(roles) {
  if (roles.includes("review")) return "review";
  if (roles.includes("unblock")) return "unblock";
  if (roles.includes("analysis")) return "analysis";
  if (roles.includes("impl")) return "impl";
  if (roles.includes("human")) return "human";
  return "plain";
}
function metaOf(m) {
  if (typeof m === "string") {
    try {
      return JSON.parse(m || "{}");
    } catch {
      return {};
    }
  }
  return m ?? {};
}
async function decide(i, c) {
  const base = validateTransition(i.type, i.status, i.to);
  if (base.ok === false) return { ok: false, code: "illegal-edge", rule: "lifecycle", message: base.reason };
  for (const r2 of RULES) {
    if (!r2.when(i)) continue;
    const err2 = await r2.guard(i, c);
    if (err2) return { ok: false, code: "guard-failed", rule: r2.name, message: err2 };
  }
  if (i.type !== "task") return { ok: true, status: i.to, owner_clear: false, tags_add: [], meta_patch: {}, effects: [] };
  const now = i.now ?? Date.now();
  const meta = metaOf(i.meta);
  const r = role(i);
  const patch = {};
  const tagsAdd = [];
  const effects = [];
  let status = i.to;
  let ownerClear = false;
  if (i.to === "todo") {
    const nextAttempts = (meta.attempt?.attempts ?? 0) + 1;
    const silent = silentCycles(await c.recentEvents());
    const verdictDuty = r === "review" || r === "unblock";
    const lastReason = String(i.body?.note ?? "").trim() || meta.attempt?.last_reason;
    const attempt = { by: i.actor, at: now, attempts: nextAttempts, last_reason: lastReason, last_will: meta.last_progress?.will };
    if (verdictDuty && (nextAttempts >= CHURN_ESCALATE_ATTEMPTS || silent >= SILENT_ESCALATE_CYCLES)) {
      const reason = silent >= SILENT_ESCALATE_CYCLES && nextAttempts < CHURN_ESCALATE_ATTEMPTS ? `verdict duty went silent ${silent} watchdog cycles with no agent output \u2014 server-side churn escalation (last: ${String(lastReason ?? "").slice(0, 200)}). Human: review get_history, fix the recurring failure, or re-scope` : `verdict duty released ${nextAttempts} times without completing \u2014 the same gate keeps rejecting the handoff (last: ${String(lastReason ?? "").slice(0, 200)}). Human: review get_history, fix the recurring failure, or re-scope`;
      patch.escalate = { at: now, attempts: nextAttempts, silent_cycles: silent, reason };
      patch.attempt = attempt;
      ownerClear = true;
      effects.push({ kind: "escalate", attempts: nextAttempts, silent_cycles: silent, reason });
    } else if (!verdictDuty && i.status !== "blocked" && (nextAttempts >= CHURN_REDIRECT_ATTEMPTS || silent >= SILENT_REDIRECT_CYCLES)) {
      const blockReason = silent >= SILENT_REDIRECT_CYCLES && nextAttempts < CHURN_REDIRECT_ATTEMPTS ? `churn guard: ${silent} consecutive zero-output watchdog cycles \u2014 silent churn, server-side escalated` : `churn guard: released to the pool ${nextAttempts} times without completing \u2014 the same gate keeps rejecting the handoff (last: ${String(lastReason ?? "").slice(0, 200)})`;
      status = "blocked";
      patch.blocked = {
        reason: blockReason,
        unblock_condition: "read the task history (get_history) and the last gate error, resolve what it names, then re-claim or re-issue the task",
        ts: now
      };
      patch.attempt = attempt;
      effects.push({ kind: "release_redirect", attempts: nextAttempts, silent_cycles: silent });
    } else {
      ownerClear = true;
      patch.attempt = {
        by: i.actor,
        at: now,
        attempts: nextAttempts,
        last_reason: meta.blocked?.reason ?? (String(i.body?.note ?? "").trim() || void 0),
        last_will: meta.last_progress?.will
      };
      if (!i.tags.includes("attempted")) tagsAdd.push("attempted");
    }
  }
  if ((i.to === "done" || i.to === "superseded") && meta.attempt && typeof meta.attempt === "object")
    patch.attempt = { ...meta.attempt, attempts: 0 };
  if (i.to === "in_review" && r !== "review") {
    const guard = await c.spawnGuard();
    if (guard) {
      effects.push({ kind: "skip_verify_spawn", parent: i.id, reason: guard });
    } else {
      const open = await c.openVerifyChild();
      if (open) effects.push({ kind: "reuse_verify", parent: i.id, verify: open.id });
      else
        effects.push({
          kind: "spawn_verify",
          parent: i.id,
          pr: (String(i.body?.note ?? "").match(/https?:\/\/\S+/) || [])[0] ?? null
        });
    }
  }
  if (["in_progress", "todo", "done"].includes(i.to)) {
    const cause = i.to === "in_progress" && i.status === "blocked" ? `${i.id} resumed from blocked \u2014 unblock confirmed, child superseded` : i.to === "in_progress" && i.status === "in_review" ? `${i.id} bounced \u2014 unblock round closed` : `${i.id} \u2192 ${i.to} \u2014 unblock round closed`;
    effects.push({ kind: "supersede_children", parent: i.id, tag: "unblock", keep_newest: false, cause });
  }
  if (i.to === "done" || i.status === "in_review" && i.to === "in_progress") {
    const isBounce = i.status === "in_review" && i.to === "in_progress";
    effects.push({
      kind: "supersede_children",
      parent: i.id,
      tag: "review",
      keep_newest: isBounce,
      cause: isBounce ? `${i.id} bounced \u2014 older verification rounds superseded (newest kept for re-entry)` : `${i.id} done \u2014 verification round closed`
    });
  }
  if (i.to === "blocked" && r !== "unblock" && !meta.awaiting_ask && !i.body?.awaiting_ask_id && i.body?.class !== "subprocess") {
    const open = await c.openUnblockChild();
    if (open) {
      effects.push({ kind: "skip_unblock_spawn", parent: i.id, reason: `existing unblock child ${open.id} reused` });
    } else {
      const exit = String(i.body?.unblock_condition ?? "").trim();
      const last = meta.last_unblock_spawn;
      if (last && typeof last.at === "number" && now - last.at < UNBLOCK_FLOOD_MS && String(last.exit ?? "") === exit) {
        effects.push({
          kind: "skip_unblock_spawn",
          parent: i.id,
          reason: `unblock round issued ${Math.round((now - last.at) / 6e4)}m ago with the same exit condition \u2014 flood guard`
        });
      } else {
        effects.push({
          kind: "spawn_unblock",
          parent: i.id,
          reason: String(i.body?.note ?? i.body?.reason ?? "").trim(),
          exit_condition: exit
        });
      }
    }
  }
  return { ok: true, status, owner_clear: ownerClear, tags_add: tagsAdd, meta_patch: patch, effects };
}
function invariants(a) {
  const v = [];
  const r = effectiveRole(a.roles ?? []);
  if (a.type === "task") {
    if (VERDICT_ROLES.includes(r) && a.status === "blocked")
      v.push(`verdict role ${r} is blocked \u2014 verdict duties are done-only terminals`);
    if (VERDICT_ROLES.includes(r) && a.status === "in_review")
      v.push(`verdict role ${r} is in_review \u2014 verdict duties are never reviewed`);
    if (!a.meta?.blocked && a.status === "blocked")
      v.push("status is blocked with no meta.blocked record (reason + unblock condition missing)");
    if (a.meta?.blocked && a.status !== "blocked")
      v.push("meta.blocked record on a non-blocked task (stale dead-end record)");
  }
  if (a.type === "question" && a.status === "in_progress")
    v.push("question is in_progress \u2014 questions are answered, not claimed");
  return v;
}
function silentCycles(events) {
  const asc = [...events].sort((a, b) => a.ts - b.ts);
  let run = 0;
  for (const e of asc) {
    if (isAgentOutput(e)) run = 0;
    else if (isWatchdogStall(e)) run++;
  }
  return run;
}
function replayStatus(from, versions) {
  let expected = from;
  let anchored = false;
  for (const v of versions) {
    if (v.action !== "transition") continue;
    const to = v.data?.to;
    if (typeof to !== "string") continue;
    if (anchored && v.data?.from !== expected) return { status: expected, ok: false };
    expected = to;
    anchored = true;
  }
  return { status: expected, ok: true };
}
function breachClass(reason) {
  const r = reason.toLowerCase();
  if (r.includes("pr link")) return "gate:review-needs-pr";
  if (r.includes("unreviewed")) return "gate:done-unreviewed";
  if (r.includes("references no git repository")) return "gate:no-repo";
  if (r.includes("without receipts")) return "gate:verdict-receipts";
  if (r.includes("separation of duties")) return "gate:separation";
  if (r.includes("open child")) return "gate:open-children";
  if (r.includes("cannot block")) return "gate:verdict-no-blocked";
  if (r.includes("never reviewed")) return "gate:verdict-no-in_review";
  return "other";
}
function classOf(e) {
  if (e.op === "invariant_violation") return "invariant";
  if (e.op === "spawn_skipped") return "spawn-while-open";
  if (e.op === "replay_mismatch") return "replay";
  return breachClass(e.reason);
}
function detectBreaches(events, openKeys, opts) {
  const windowMs = opts?.windowMs ?? BREACH_WINDOW_MS;
  const relevant = events.filter(
    (e) => ["transition_rejected", "invariant_violation", "spawn_skipped", "replay_mismatch"].includes(e.op)
  );
  relevant.sort((a, b) => a.ts - b.ts);
  const groups = /* @__PURE__ */ new Map();
  for (const e of relevant) {
    const klass = classOf(e);
    const key = `${e.task}|${klass}`;
    const g = groups.get(key);
    if (g) {
      if (e.ts - g.first_ts <= windowMs) {
        g.count++;
        g.last_ts = e.ts;
      }
    } else {
      groups.set(key, { key, task: e.task, klass, count: 1, first_ts: e.ts, last_ts: e.ts, sample: e.reason.slice(0, 200) });
    }
  }
  return [...groups.values()].filter((b) => b.count >= (BREACH_THRESHOLDS[b.klass] ?? BREACH_THRESHOLDS.default) && !openKeys.has(b.key));
}
var VERDICT_ROLES, HUMAN_ACTOR, OWNER_RELEASE_EXEMPT, role, isTask, noteOf, hasEvidenceLink, hasReceipts, CHURN_REDIRECT_ATTEMPTS, CHURN_ESCALATE_ATTEMPTS, SILENT_ESCALATE_CYCLES, SILENT_REDIRECT_CYCLES, UNBLOCK_FLOOD_MS, RULES, isAgentOutput, isWatchdogStall, BREACH_WINDOW_MS, BREACH_THRESHOLD, BREACH_THRESHOLDS;
var init_machine = __esm({
  "src/kb/machine.ts"() {
    init_core();
    __name(effectiveRole, "effectiveRole");
    VERDICT_ROLES = ["review", "unblock"];
    HUMAN_ACTOR = /^web(:|$)|^human:/;
    OWNER_RELEASE_EXEMPT = /^(web(:|$)|human:|system:)/;
    role = /* @__PURE__ */ __name((i) => effectiveRole(i.roles ?? []), "role");
    isTask = /* @__PURE__ */ __name((i) => i.type === "task", "isTask");
    noteOf = /* @__PURE__ */ __name((i) => String(i.body?.note ?? i.body?.resolution ?? i.body?.reason ?? "").trim(), "noteOf");
    hasEvidenceLink = /* @__PURE__ */ __name((s) => /https?:\/\/\S+|(^|\s)PR[\s#:]/i.test(s), "hasEvidenceLink");
    hasReceipts = /* @__PURE__ */ __name((s) => /https?:\/\/\S+|(^|\s)(PR|merged|passed|unblocked|still blocked)\b/i.test(s), "hasReceipts");
    __name(metaOf, "metaOf");
    CHURN_REDIRECT_ATTEMPTS = 5;
    CHURN_ESCALATE_ATTEMPTS = 3;
    SILENT_ESCALATE_CYCLES = 3;
    SILENT_REDIRECT_CYCLES = 5;
    UNBLOCK_FLOOD_MS = 60 * 6e4;
    RULES = [
      {
        name: "verdict-no-in_review",
        when: /* @__PURE__ */ __name((i) => isTask(i) && i.to === "in_review" && VERDICT_ROLES.includes(role(i)), "when"),
        guard: /* @__PURE__ */ __name((i) => `${i.id} is a ${role(i) === "review" ? "verify" : "unblock"} task \u2014 verification is its own terminal state. ${role(i) === "review" ? "Verify" : "Unblock"} tasks close directly via done with receipts; they are never reviewed again.`, "guard")
      },
      {
        name: "verdict-no-blocked",
        when: /* @__PURE__ */ __name((i) => isTask(i) && i.to === "blocked" && VERDICT_ROLES.includes(role(i)) && !i.body?.awaiting_ask_id, "when"),
        // an ask-gate pauses the duty; it auto-resumes on the answer
        guard: /* @__PURE__ */ __name((i) => `${i.id} is a ${role(i) === "review" ? "verify" : "unblock"} task \u2014 verdict duties cannot block. They either render the verdict (done with receipts) or record findings and close done; "cannot proceed" is itself a verdict. Escalate via ask_agent instead.`, "guard")
      },
      {
        name: "release-needs-ownership",
        when: /* @__PURE__ */ __name((i) => isTask(i) && i.to === "todo" && !!i.owner && i.owner !== i.actor && !OWNER_RELEASE_EXEMPT.test(i.actor), "when"),
        guard: /* @__PURE__ */ __name((i) => `task ${i.id} is claimed by ${i.owner} \u2014 only the owner or a human can release it to the pool. If the work overlaps yours, coordinate via ask_agent instead.`, "guard")
      },
      {
        name: "decision-acceptance-human",
        when: /* @__PURE__ */ __name((i) => i.type === "decision" && i.to === "accepted" && !HUMAN_ACTOR.test(i.actor), "when"),
        guard: /* @__PURE__ */ __name((i) => `decision ${i.id} acceptance is human-authoritative \u2014 agents propose, a human accepts in the webapp. Route it to a human for the final say (an ask, or the decisions panel).`, "guard")
      },
      {
        name: "human-signoff-done",
        when: /* @__PURE__ */ __name((i) => isTask(i) && i.to === "done" && role(i) === "human" && !HUMAN_ACTOR.test(i.actor), "when"),
        guard: /* @__PURE__ */ __name((i) => `task ${i.id} is a human sign-off task (role: human) \u2014 completion is human-authoritative; a human marks it done in the webapp.`, "guard")
      },
      {
        name: "claim-bars",
        when: /* @__PURE__ */ __name((i) => isTask(i) && i.status === "todo" && i.to === "in_progress", "when"),
        guard: /* @__PURE__ */ __name(async (i, c) => {
          const bars = await c.unmetBars();
          if (!bars.length) return null;
          return `task ${i.id} is qualified but its publisher requested further confirmation before it goes ready \u2014 unmet bars: ${bars.join(", ")}. Satisfy them with a done child task of that role or an accepted decision.`;
        }, "guard")
      },
      {
        name: "claim-separation-of-duties",
        when: /* @__PURE__ */ __name((i) => isTask(i) && i.status === "todo" && i.to === "in_progress", "when"),
        guard: /* @__PURE__ */ __name(async (i, c) => {
          const q = await c.qualify("analysis");
          if (!q.ok || !q.via || q.via === "declared" || String(q.via).startsWith("parent:")) return null;
          const ev = await c.evidence(String(q.via));
          if (!ev || ev.type !== "task" || !(ev.roles ?? []).includes("analysis")) return null;
          const evSession = metaOf(ev.meta).session;
          const sess = await c.session();
          if (evSession && sess && evSession === sess)
            return `separation of duties: session "${sess}" completed the analysis on ${i.id} \u2014 analysis and impl are separate sessions. End this session, start a new one, then claim ${i.id} for implementation.`;
          return null;
        }, "guard")
      },
      {
        name: "done-unreviewed",
        when: /* @__PURE__ */ __name((i) => isTask(i) && i.to === "done" && !["analysis", "review", "unblock"].includes(role(i)), "when"),
        guard: /* @__PURE__ */ __name(async (i, c) => {
          const r = await c.qualify("review");
          if (r.ok) return null;
          return `task ${i.id} cannot be completed unreviewed \u2014 complete a verify (review-role) child task or link an accepted decision (e.g. a Superpositional verdict) first`;
        }, "guard")
      },
      {
        name: "question-not-claimable",
        when: /* @__PURE__ */ __name((i) => i.type === "question" && i.to === "in_progress", "when"),
        guard: /* @__PURE__ */ __name((i) => `task ${i.id} is a question \u2014 questions are answered, not claimed. Contribute via log_progress {id, did, will}; the author closes it with an ADR (decision artefact, derived_from this task).`, "guard")
      },
      {
        name: "operator-gated",
        when: /* @__PURE__ */ __name((i) => isTask(i) && i.to === "in_progress" && i.meta?.operator_gated, "when"),
        guard: /* @__PURE__ */ __name((i) => `task ${i.id} is operator-gated (${i.meta.operator_gated}) \u2014 a human clears this by updating the task (remove operator_gated from meta) before it can be claimed.`, "guard")
      },
      {
        name: "unblock-needs-resolution",
        when: /* @__PURE__ */ __name((i) => i.status === "blocked" && i.to === "in_progress", "when"),
        guard: /* @__PURE__ */ __name((i) => noteOf(i) ? null : `moving out of blocked requires a resolution (note) \u2014 the card promised an unblock condition; cite how it resolved`, "guard")
      },
      {
        name: "review-needs-pr",
        when: /* @__PURE__ */ __name((i) => isTask(i) && i.to === "in_review", "when"),
        guard: /* @__PURE__ */ __name((i) => hasEvidenceLink(noteOf(i)) ? null : `moving to in_review requires the PR link in the note (you stay owner until the verdict \u2014 done requires review acceptance, not your call)`, "guard")
      },
      {
        name: "bounce-needs-findings",
        when: /* @__PURE__ */ __name((i) => i.status === "in_review" && i.to === "in_progress", "when"),
        guard: /* @__PURE__ */ __name((i) => noteOf(i) ? null : `bouncing back from review requires the reviewer's findings (note) \u2014 "no" without reasons is not an answer`, "guard")
      },
      {
        name: "blocked-needs-path",
        when: /* @__PURE__ */ __name((i) => i.to === "blocked", "when"),
        guard: /* @__PURE__ */ __name((i) => {
          const reason = String(i.body?.note ?? i.body?.reason ?? "").trim();
          const unblock = String(i.body?.unblock_condition ?? "").trim();
          return reason && unblock ? null : "moving to blocked requires BOTH a reason (note) and an unblock condition \u2014 a blocked card without an unblock path is a dead end";
        }, "guard")
      },
      {
        name: "verdict-done-needs-receipts",
        when: /* @__PURE__ */ __name((i) => isTask(i) && i.to === "done" && (role(i) === "review" || role(i) === "unblock"), "when"),
        guard: /* @__PURE__ */ __name((i) => hasReceipts(noteOf(i)) ? null : `${role(i) === "unblock" ? "unblock" : "review"} ${i.id} cannot complete without receipts \u2014 cite what you verified in the note (PR link, merge state, the check you ran, or the unblock verdict).`, "guard")
      },
      {
        name: "review-separation-of-duties",
        when: /* @__PURE__ */ __name((i) => isTask(i) && i.to === "done" && (role(i) === "review" || role(i) === "unblock"), "when"),
        guard: /* @__PURE__ */ __name(async (i, c) => {
          const parent = await c.parent();
          const implSession = parent ? metaOf(parent.meta).session : void 0;
          const reviewSession = metaOf(i.meta).session;
          if (implSession && reviewSession && implSession === reviewSession)
            return `separation of duties: session "${reviewSession}" implemented ${parent?.id} \u2014 it cannot also produce the review. Review from a different session.`;
          return null;
        }, "guard")
      },
      {
        name: "done-open-children",
        when: /* @__PURE__ */ __name((i) => isTask(i) && i.to === "done", "when"),
        guard: /* @__PURE__ */ __name(async (i, c) => {
          const open = await c.openChildren();
          return open > 0 ? `parent ${i.id} still has ${open} open child task(s) \u2014 finish or close them first (decomposition owns its children)` : null;
        }, "guard")
      }
    ];
    __name(decide, "decide");
    __name(invariants, "invariants");
    isAgentOutput = /* @__PURE__ */ __name((e) => !/^system:/.test(e.actor), "isAgentOutput");
    isWatchdogStall = /* @__PURE__ */ __name((e) => /^system:/.test(e.actor) && /stall|releas|redirect/i.test(e.summary), "isWatchdogStall");
    __name(silentCycles, "silentCycles");
    __name(replayStatus, "replayStatus");
    BREACH_WINDOW_MS = 30 * 6e4;
    BREACH_THRESHOLD = 3;
    BREACH_THRESHOLDS = {
      invariant: 1,
      replay: 1,
      "spawn-while-open": 1,
      default: BREACH_THRESHOLD
    };
    __name(breachClass, "breachClass");
    __name(classOf, "classOf");
    __name(detectBreaches, "detectBreaches");
  }
});

// src/kb/do.ts
function tagsForWrite(verdict, base) {
  if (!verdict.tags_add.length) return base;
  const t = [...base];
  for (const x of verdict.tags_add) if (!t.includes(x)) t.push(x);
  return t;
}
var STOP_LINE_SINK_ID, KnowledgeHub;
var init_do = __esm({
  "src/kb/do.ts"() {
    init_core();
    init_throughput();
    init_provenance();
    init_machine();
    STOP_LINE_SINK_ID = "BR#3124";
    KnowledgeHub = class _KnowledgeHub {
      constructor(state, env) {
        this.state = state;
        this.env = env;
      }
      state;
      env;
      static {
        __name(this, "KnowledgeHub");
      }
      /** ensureSchema runs once per isolate, not per request — its migration
       *  queries are full-table scans, and the free-tier DO row-read quota
       *  dies under per-request schema checks (2026-10-18 outage). */
      // ---------- realtime (hibernating websockets) ----------
      async handleWs(request) {
        const pair = new WebSocketPair();
        this.state.acceptWebSocket(pair[1]);
        const since = Number(new URL(request.url).searchParams.get("since") ?? 0);
        const recent = await this.eventsSince(since, 100);
        pair[1].send(JSON.stringify({ type: "kb.events", events: recent.events }));
        return new Response(null, { status: 101, webSocket: pair[0] });
      }
      async webSocketMessage(_ws, message2) {
        try {
          const m = JSON.parse(message2);
          if (m?.type === "ping") _ws.send(JSON.stringify({ type: "pong" }));
        } catch {
        }
      }
      webSocketClose() {
      }
      broadcastEvent(ev) {
        const frame = JSON.stringify({ type: "kb.event", event: ev });
        for (const ws of this.state.getWebSockets()) {
          try {
            ws.send(frame);
          } catch {
          }
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
        await this.state.storage.setAlarm(Date.now() + 6e4);
        try {
          await this.alarmSweep();
        } catch (e) {
          try {
            this.audit("system:watchdog", "alarm_error", "watchdog", { error: String(e.message ?? e).slice(0, 300) });
          } catch {
          }
        }
      }
      async alarmSweep() {
        await this.ensureSchema();
        const now0 = Date.now();
        const askTtlMs = 24 * 60 * 6e4;
        for (const a of this.state.storage.sql.exec(
          `SELECT id, artefact_id, to_target, created_ts FROM asks WHERE status = 'open' AND created_ts < ?`,
          now0 - askTtlMs
        ).toArray()) {
          this.state.storage.sql.exec(
            `UPDATE asks SET status = 'expired', answered_by = 'system:watchdog', answered_ts = ? WHERE id = ?`,
            now0,
            a.id
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
            to: a.to_target ?? "",
            artefact: a.artefact_id ?? "",
            age_h: Math.round((now0 - Number(a.created_ts ?? 0)) / 36e5)
          });
        }
        const s = this.one(`SELECT value FROM settings WHERE key = 'stale_minutes'`);
        const staleMin = s ? Math.max(1, Math.min(120, parseInt(s.value, 10) || 10)) : 10;
        const staleMs = staleMin * 6e4;
        const now = Date.now();
        const rows = this.state.storage.sql.exec(
          `SELECT id, status, owner, meta, status_ts, updated_ts FROM artefacts
       WHERE type = 'task' AND status = 'in_progress'`
        ).toArray();
        for (const r of rows) {
          try {
            const meta = JSON.parse(r.meta ?? "{}");
            if (meta.awaiting_ask) {
              try {
                let ask;
                const derived = this.one(
                  `SELECT c.id AS id, c.created_ts AS created_ts, c.meta AS cmeta FROM relations r
             JOIN artefacts c ON c.id = r.src_id
              WHERE r.relation = 'child_of' AND r.dst_id = ? AND c.status IN ('todo','in_progress','blocked')
                AND c.type = 'question' ORDER BY c.created_ts DESC LIMIT 1`,
                  r.id
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
                  const hours = Math.floor((now - ask.created_ts) / 36e5);
                  if (meta.awaiting_ask.annotated_h !== hours) {
                    meta.awaiting_ask.annotated_h = hours;
                    const base = String(meta.blocked?.reason ?? "").replace(/^⏳ blocked \d+h — .*? · /, "");
                    meta.blocked = { ...meta.blocked ?? {}, reason: `\u23F3 blocked ${hours}h \u2014 awaiting ${ask.to_target ?? "human"} on ask ${meta.awaiting_ask.ask_id} \xB7 ${base}` };
                    this.state.storage.sql.exec(`UPDATE artefacts SET meta = ? WHERE id = ?`, JSON.stringify(meta), r.id);
                  }
                }
              } catch {
              }
              continue;
            }
            if (typeof meta.grace_until === "number" && meta.grace_until > now) continue;
            if (meta.subprocess && typeof meta.subprocess.deadline_ts === "number") {
              if (meta.subprocess.deadline_ts > now) continue;
            }
            const lastTs = Math.max(
              meta.last_progress?.ts ?? 0,
              r.status_ts ?? 0,
              r.updated_ts ?? 0,
              meta.session_alive_ts ?? 0
              // runner vouches the session is alive (stdout/ACP movement) — quiet work is not dead work
            );
            if (now - lastTs <= staleMs) continue;
            const openAsk = this.one(
              `SELECT id FROM asks WHERE status = 'open' AND artefact_id = ?`,
              r.id
            );
            if (openAsk) continue;
            const will = meta.last_progress?.will ? `; was about to: ${String(meta.last_progress.will).slice(0, 120)}` : "";
            const lapsedSub = meta.subprocess ? ` (declared subprocess window of ${meta.subprocess.budget_minutes ?? "?"}m lapsed)` : "";
            await this.transition({
              id: r.id,
              to: "todo",
              note: `stalled \u2014 no update for >${staleMin}m${lapsedSub}; released to the pool by watchdog${will}`
            }, "system:watchdog");
          } catch (e) {
            this.audit("system:watchdog", "sweep_error", r.id, { error: String(e.message ?? e) });
          }
        }
        const rs = this.one(`SELECT value FROM settings WHERE key = 'review_stale_minutes'`);
        const reviewStaleMin = rs ? Math.max(30, Math.min(2880, parseInt(rs.value, 10) || 360)) : 360;
        const reviewRows = this.state.storage.sql.exec(
          `SELECT id, owner, meta, status_ts, updated_ts FROM artefacts
       WHERE type = 'task' AND status = 'in_review'`
        ).toArray();
        for (const r of reviewRows) {
          try {
            const meta = JSON.parse(r.meta ?? "{}");
            if (meta.awaiting_ask) continue;
            const age = now - Math.max(r.status_ts ?? 0, r.updated_ts ?? 0);
            if (age <= reviewStaleMin * 6e4) continue;
            const openAsk = this.one(`SELECT id FROM asks WHERE status = 'open' AND artefact_id = ?`, r.id);
            if (openAsk) continue;
            const activeVerify = this.one(
              `SELECT c.id AS id FROM relations r JOIN artefacts c ON c.id = r.src_id
            WHERE r.relation = 'child_of' AND r.dst_id = ? AND c.status = 'in_progress'
              AND c.roles LIKE '%"review"%' LIMIT 1`,
              r.id
            );
            if (activeVerify) continue;
            const hours = Math.round(age / 36e5);
            const findings = `watchdog: review stalled ${hours}h \u2014 no verifier picked up the verification round. No adverse findings; resolve whatever the last gate/review named and hand off again, or let the work re-enter the pool.`;
            await this.transition({ id: r.id, to: "in_progress", note: findings }, "system:watchdog");
            await this.transition({ id: r.id, to: "todo", note: "released to the pool after a stalled review round (watchdog)" }, "system:watchdog");
          } catch (e) {
            this.audit("system:watchdog", "sweep_error", r.id, { error: String(e.message ?? e) });
          }
        }
        const subRows = this.state.storage.sql.exec(
          `SELECT id, owner, meta FROM artefacts WHERE type = 'task' AND status = 'blocked'`
        ).toArray();
        for (const r of subRows) {
          try {
            const meta = JSON.parse(r.meta ?? "{}");
            const b = meta.blocked;
            if (b?.class !== "subprocess" || typeof b.deadline_ts !== "number") continue;
            if (b.deadline_ts > now) continue;
            const wasDoing = meta.last_progress?.will ? `; was about to: ${String(meta.last_progress.will).slice(0, 120)}` : "";
            delete meta.blocked;
            delete meta.subprocess;
            const tags = parseTags(r.meta ? JSON.parse(r.meta).tags ?? "[]" : "[]");
            if (!tags.includes("attempted")) tags.push("attempted");
            const attempts = (meta.attempt?.attempts ?? 0) + 1;
            meta.attempt = { by: r.owner || "unknown", at: now, attempts };
            this.state.storage.sql.exec(
              `UPDATE artefacts SET status = 'todo', owner = '', tags = ?, meta = ?, status_ts = ?, updated_ts = ? WHERE id = ?`,
              JSON.stringify(tags),
              JSON.stringify(meta),
              now,
              now,
              r.id
            );
            this.audit("system:watchdog", "transition", r.id, { from: "blocked", to: "todo", note: `stalled \u2014 declared subprocess window (${b.budget_minutes ?? "?"}m) lapsed${wasDoing}` });
            this.version(r.id, "system:watchdog", "transition", `stalled \u2014 declared subprocess window lapsed, released to the pool`, { from: "blocked", to: "todo" });
          } catch (e) {
            this.audit("system:watchdog", "sweep_error", r.id, { error: String(e.message ?? e) });
          }
        }
        const nudgeRows = this.state.storage.sql.exec(
          `SELECT r.src_id AS verify_task, r.dst_id AS parent_id, c.updated_ts AS age_ts, p.owner AS parent_owner
       FROM relations r
       JOIN artefacts c ON c.id = r.src_id
       JOIN artefacts p ON p.id = r.dst_id
        WHERE r.relation = 'child_of'
          AND c.type = 'task' AND c.status = 'todo' AND c.owner = ''
          AND c.roles LIKE '%"review"%'
          AND p.type = 'task' AND p.status = 'in_review'`
        ).toArray();
        for (const v of nudgeRows) {
          const age = now - (v.age_ts ?? now);
          if (age <= 60 * 6e4) continue;
          const lastNudge = this.one(
            `SELECT ts FROM events WHERE artefact_id = ? AND op = 'nudge' ORDER BY ts DESC LIMIT 1`,
            v.verify_task
          );
          if (lastNudge && now - Number(lastNudge.ts) <= 60 * 6e4) continue;
          const mins = Math.round(age / 6e4);
          this.audit("system:pool", "nudge", v.verify_task, {
            note: `verify task unclaimed ${mins}m \u2014 this blocks ${v.parent_id}'s owner (${v.parent_owner || "unknown"}). Pick it up: check receipts, close or bounce the parent.`,
            parent: v.parent_id,
            parent_owner: v.parent_owner ?? "",
            age_min: mins
          });
        }
        try {
          await this.mergeQueueSweep(now);
        } catch (e) {
          try {
            this.audit("system:merge-sweep", "sweep_error", null, { error: String(e.message ?? e).slice(0, 300) });
          } catch {
          }
        }
        try {
          await this.stopTheLineSweep(now);
        } catch (e) {
          try {
            this.audit("hub:stop-the-line", "sweep_error", null, { error: String(e.message ?? e).slice(0, 300) });
          } catch {
          }
        }
        try {
          await this.provenanceSweep(now);
        } catch (e) {
          try {
            this.audit("hub:provenance", "sweep_error", null, { error: String(e.message ?? e).slice(0, 300) });
          } catch {
          }
        }
        const nextAlarm = await this.state.storage.getAlarm();
        this.state.storage.sql.exec(
          `INSERT OR REPLACE INTO settings (key, value) VALUES ('watchdog.last_tick', ?)`,
          String(now)
        );
        this.state.storage.sql.exec(
          `INSERT OR REPLACE INTO settings (key, value) VALUES ('watchdog.next_alarm', ?)`,
          String(nextAlarm ?? 0)
        );
        const staleNow = this.one(
          `SELECT COUNT(*) AS n FROM artefacts WHERE type = 'task' AND status = 'in_progress'
       AND COALESCE(json_extract(meta, '$.last_progress.ts'), 0) < ?`,
          now - staleMs
        )?.n ?? 0;
        const staleReviewNow = this.one(
          `SELECT COUNT(*) AS n FROM artefacts WHERE type = 'task' AND status = 'in_review' AND status_ts < ?`,
          now - reviewStaleMin * 6e4
        )?.n ?? 0;
        const openAsks = this.one(`SELECT COUNT(*) AS n FROM asks WHERE status = 'open'`)?.n ?? 0;
        this.state.storage.sql.exec(
          `INSERT OR REPLACE INTO settings (key, value) VALUES ('watchdog.sweep', ?)`,
          JSON.stringify({ ts: now, stale_in_progress: staleNow, stale_in_review: staleReviewNow, review_stale_minutes: reviewStaleMin, open_asks: openAsks })
        );
      }
      // ---------- destination-green stop-the-line sweep (BR#3008) ----------
      // The loud half of BR#3009's destination-green precondition. The mechanical
      // half is the required `main-green gate` check (workflow +
      // scripts/main-green-gate.sh); this sweep pages the board when the line is
      // stopped EVEN IF nobody opens a PR — a red main must be loud on its own.
      //
      // Reads main's HEAD check runs from the public GitHub API (the repo is
      // public; no token lives in the worker), classifies with the same rule as
      // the gate (classifyMainCheckRuns), and on RED files — per red episode,
      // deduped per main-HEAD sha, so ten PRs observing one red sha produce one
      // of each, not ten:
      //   1. ONE urgent ask per red episode into the BR#3124 sink — the
      //      ATTENTION channel; and
      //   2. ONE claimable P0 episode task (BR#3284) — the WORK channel: title
      //      `STOP-THE-LINE: bridge main RED @ <short-sha> — fix main first`,
      //      body carrying the red checks, the first-failing sha/PR (bisect
      //      walk), the remediation exception and the done-when, boosted
      //      (priority 0) so it tops the board's ranked queue. A new red sha
      //      supersedes the prior open episode task.
      //
      // Settings: `stop_line_sweep_minutes` (default 5, 0 = off),
      // `stop_line_artefact_id` (ask sink; the standing card the asks and episode
      // tasks bind to), `stop_line_repo` (default state-vector/bridge),
      // `stop_line_gh_api_base` (default https://api.github.com — point at a
      // GHES/mock for drills).
      settingValue(key, fallback) {
        const row = this.one(`SELECT value FROM settings WHERE key = ?`, key);
        if (!row) return fallback;
        const raw = String(row.value);
        try {
          const v = JSON.parse(raw);
          if (typeof v === "string" || typeof v === "number") return String(v);
        } catch {
        }
        return raw;
      }
      async stopTheLineSweep(now) {
        const periodMin = Math.max(0, Math.min(120, parseInt(this.settingValue("stop_line_sweep_minutes", "5"), 10) || 5));
        if (periodMin === 0) return;
        const last = Number(this.settingValue("stop_line_last_sweep_ts", "0")) || 0;
        if (now - last < periodMin * 6e4) return;
        const setLast = /* @__PURE__ */ __name((ts) => this.state.storage.sql.exec(`INSERT OR REPLACE INTO settings (key, value) VALUES ('stop_line_last_sweep_ts', ?)`, String(ts)), "setLast");
        setLast(now);
        const repo = this.settingValue("stop_line_repo", "state-vector/bridge");
        const base = this.settingValue("stop_line_gh_api_base", "https://api.github.com").replace(/\/$/, "");
        const headers = { "User-Agent": "bridge-stop-the-line-sweep", "Accept": "application/vnd.github+json" };
        const ghGet = /* @__PURE__ */ __name(async (path) => {
          const res = await fetch(`${base}/repos/${repo}${path}`, { headers });
          if (res.status === 403 || res.status === 429) {
            setLast(now + 60 * 6e4);
            throw new Error(`github rate limited (HTTP ${res.status}) \u2014 backed off 60m`);
          }
          if (!res.ok) throw new Error(`github ${path} -> HTTP ${res.status}`);
          return res;
        }, "ghGet");
        const head = await (await ghGet("/commits/main")).json();
        const sha = String(head?.sha ?? "");
        if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`commits/main returned no sha`);
        const runsBody = await (await ghGet(`/commits/${sha}/check-runs?per_page=100`)).json();
        const verdict = classifyMainCheckRuns(Array.isArray(runsBody?.check_runs) ? runsBody.check_runs : []);
        if (verdict.verdict === "green") {
          this.audit("hub:stop-the-line", "green", null, { sha: sha.slice(0, 9), green: verdict.green });
          return;
        }
        if (verdict.verdict !== "red") {
          this.audit("hub:stop-the-line", "quiet", null, { sha: sha.slice(0, 9), verdict: verdict.verdict, unsettled: verdict.unsettled.slice(0, 5) });
          return;
        }
        const names = verdict.red.map((r) => r.name);
        const title = stopLineAskTitle(sha, names);
        const sinkId = this.settingValue("stop_line_artefact_id", STOP_LINE_SINK_ID);
        const chainRec = await this.guiltyChainRec(sha);
        const dup = this.one(
          `SELECT c.id AS id FROM relations r JOIN artefacts c ON c.id = r.src_id
       WHERE r.relation = 'child_of' AND r.dst_id = ? AND c.status IN ('todo','in_progress','blocked')
         AND c.type = 'question' AND c.title = ? LIMIT 1`,
          sinkId,
          title.slice(0, 200)
        );
        if (dup) {
          this.audit("hub:stop-the-line", "already_alerted", String(dup.id), { sha: sha.slice(0, 9), red: names });
        } else {
          const details = [
            `**STOP THE LINE \u2014 bridge main is RED.** Destination-green precondition (accepted decision BR#3009): merges halt until main is green. The \`main-green gate\` required check blocks every PR merge mechanically; this ask is the loud half.`,
            ``,
            `**Red checks on main ${sha.slice(0, 9)}:**`,
            ...verdict.red.map((r) => `- ${r.name} (${r.conclusion}) \u2014 ${r.url || "run URL unavailable"}`),
            ``,
            `**Guilty chain:** ${this.guiltyChainLine(chainRec, sha)}`,
            ``,
            `**The one exception \u2014 the remediation merge:** a PR green on the exact failing checks (receipted by the \`main-green gate\` carve-out) may merge as the remediation. The alert stands until the merge commit's checks come back green.`,
            ``,
            `_Filed once per red episode by the hub sweep (BR#3008), deduped per main-HEAD sha \u2014 not per PR._`
          ].join("\n");
          const created = await this.askCreate(
            {
              to: "rayh",
              urgency: "time-sensitive",
              question: title,
              details,
              reason: "destination-green precondition (accepted BR#3009): main's HEAD has failing checks; every merge onto main is mechanically blocked until green",
              options: ["Acknowledge \u2014 on it", "Line stays stopped until green"],
              artefact_id: sinkId
            },
            "hub:stop-the-line"
          );
          this.audit("hub:stop-the-line", "alert", String(created.id), { sha: sha.slice(0, 9), red: names });
        }
        await this.stopLineEpisodeTask(sha, verdict, sinkId, ghGet);
      }
      // ---------- the P0 episode task (BR#3284) ----------
      // The ask pages; the task claims. When main's HEAD is RED the sweep files,
      // alongside the ask, ONE claimable P0 task per red episode:
      //   - deduped per main-HEAD sha (same rule as the ask — one live episode
      //     task at a time; a re-sweep of the same sha audits and skips);
      //   - child_of the sink (BR#3124) — the episode family under one anchor;
      //   - body: red check names + run links, the first failing sha (the merge
      //     that broke the line — bisect walk below) + the PR that landed it,
      //     the remediation-merge exception (BR#3009/BR#3010), and the done-when;
      //   - priority is STRUCTURAL, not vibes: meta.boosted (the existing human-
      //     boost mechanism — priority 0 in the pickup ranking, first on the
      //     board's ranked queue) + the p0/stop-the-line/gtm-blocker tag chips;
      //   - when a NEW red sha arrives, the prior OPEN episode task is superseded
      //     (direct audited write, the same mechanical pattern the separation
      //     guard and the smoke purge use — a system actor filing machinery, not
      //     a session claiming; the supersedes relation + superseded_reason point
      //     the old card's readers at the replacement).
      async stopLineEpisodeTask(sha, verdict, sinkId, ghGet) {
        const shortSha = sha.slice(0, 9);
        const title = `STOP-THE-LINE: bridge main RED @ ${shortSha} \u2014 fix main first`;
        const dup = this.one(
          `SELECT c.id AS id FROM relations r JOIN artefacts c ON c.id = r.src_id
       WHERE r.relation = 'child_of' AND r.dst_id = ? AND c.status IN ('todo','in_progress','blocked')
         AND c.type = 'task' AND c.title = ? LIMIT 1`,
          sinkId,
          title.slice(0, 200)
        );
        if (dup) {
          this.audit("hub:stop-the-line", "already_tasked", String(dup.id), { sha: shortSha, red: verdict.red.map((r) => r.name) });
          return;
        }
        const bisect = await this.stopLineBisect(ghGet, sha);
        const chainRec = await this.guiltyChainRec(bisect.first_failing_sha);
        const culprit = bisect.first_failing_sha ? bisect.first_failing_pr ? `**First failing sha:** ${bisect.first_failing_sha.slice(0, 9)} \u2014 PR [#${bisect.first_failing_pr.number}](${bisect.first_failing_pr.html_url}) "${bisect.first_failing_pr.title}" (merged ${bisect.first_failing_pr.merged_at ?? "unknown"}) landed the break.` : `**First failing sha:** ${bisect.first_failing_sha.slice(0, 9)} \u2014 the PR that landed it could not be resolved (bisect walked ${bisect.walked} commit(s)); check merge history.` : `**First failing sha:** bisect unavailable (${bisect.note ?? "history walk failed"}) \u2014 check the run history of recent merges manually.`;
        const body = [
          `**STOP-THE-LINE episode task** \u2014 bridge main HEAD ${shortSha} is RED. Merges are mechanically halted by the \`main-green gate\` (accepted decision BR#3009, destination-green precondition). This task is the claimable priority item for putting the line back up. Work continues on branches (worktrees) \u2014 only the line stops.`,
          ``,
          `**Red checks on ${shortSha}:**`,
          ...verdict.red.map((r) => `- ${r.name} (${r.conclusion}) \u2014 ${r.url || "run URL unavailable"}`),
          ``,
          culprit,
          ``,
          `**Guilty chain:** ${this.guiltyChainLine(chainRec, bisect.first_failing_sha)}`,
          ``,
          `**The one exception \u2014 the remediation merge:** a PR green on the exact failing checks (receipted by the \`main-green gate\` carve-out) may merge as the remediation \u2014 precedent BR#3010 (PR #168, the 2026-10-24 do.test.ts rig fix). The alert stands until the merge commit's checks come back green.`,
          ``,
          `**Done when:** main tip has ALL check-runs settled green (0 red, 0 unsettled) and the \`main-green gate\` reopens \u2014 close this task citing the green run receipts.`,
          ``,
          `_Filed once per red episode by the hub sweep (BR#3008 + BR#3284), deduped per main-HEAD sha. The ask in the sink (BR#3124) is the attention channel; this task is the work._`
        ].join("\n");
        const created = await this.create(
          {
            type: "task",
            title,
            body_md: body,
            // sanitizeTags lowercases (board tags are canonically lowercase — the
            // chip renders "p0"); role:impl declares the intended work kind for
            // pickup per the task-publishing norm (Ray's impl cards carry it).
            tags: ["stop-the-line", "p0", "gtm-blocker", "role:impl"],
            // the sweep KNOWS the scope, culprit and done-when — it analyzed the
            // episode as it filed it; publish claimable, not gate-throttled
            qualified: true,
            meta: {
              purpose: "stop-the-line episode task",
              stop_line: {
                sha,
                short_sha: shortSha,
                red: verdict.red.map((r) => ({ name: r.name, conclusion: r.conclusion, url: r.url })),
                green_checks: verdict.green,
                unsettled: verdict.unsettled,
                first_failing_sha: bisect.first_failing_sha ?? void 0,
                first_failing_pr: bisect.first_failing_pr,
                // the resolved guilty chain (BR#3307): null when the provenance
                // sweep has not stamped the breaking merge yet — honest absence
                guilty_chain: chainRec ? {
                  repo: chainRec.repo,
                  pr: chainRec.pr,
                  task_id: chainRec.task?.id ?? null,
                  verdict_id: chainRec.verdict_id,
                  session: chainRec.session,
                  signer: chainRec.signer
                } : null,
                sink_id: sinkId
              },
              // priority 0 — the existing urgent handling: first on the board's
              // ranked queue, top of the pickup ranking (same shape the human
              // boost endpoint writes; audited once below as part of the filing)
              boosted: Date.now()
            }
          },
          "hub:stop-the-line"
        );
        this.state.storage.sql.exec(
          `INSERT OR IGNORE INTO relations (src_id, relation, dst_id, created_ts) VALUES (?, 'child_of', ?, ?)`,
          created.id,
          sinkId,
          Date.now()
        );
        const prior = this.one(
          `SELECT id, status, meta FROM artefacts
       WHERE type = 'task' AND status IN ('todo','in_progress','blocked') AND id != ?
         AND title LIKE 'STOP-THE-LINE: bridge main RED @ %'
       ORDER BY created_ts DESC LIMIT 1`,
          created.id
        );
        if (prior) {
          const ts = Date.now();
          const pm = JSON.parse(prior.meta ?? "{}");
          pm.superseded_reason = `new red main episode @ ${shortSha} \u2014 superseded by ${created.id} (one live episode task at a time)`;
          pm.superseded_by = created.id;
          this.state.storage.sql.exec(
            `UPDATE artefacts SET status = 'superseded', meta = ?, status_ts = ?, updated_ts = ? WHERE id = ?`,
            JSON.stringify(pm),
            ts,
            ts,
            prior.id
          );
          this.state.storage.sql.exec(
            `INSERT OR IGNORE INTO relations (src_id, relation, dst_id, created_ts) VALUES (?, 'supersedes', ?, ?)`,
            created.id,
            prior.id,
            ts
          );
          this.version(prior.id, "hub:stop-the-line", "transition", `superseded \u2014 new red main episode ${shortSha} (${created.id})`, { from: prior.status, to: "superseded" });
          this.audit("hub:stop-the-line", "episode_superseded", prior.id, { by: created.id, from: prior.status, new_sha: shortSha });
        }
        this.audit("hub:stop-the-line", "episode_task", String(created.id), {
          sha: shortSha,
          red: verdict.red.map((r) => r.name),
          first_failing: bisect.first_failing_sha?.slice(0, 9) ?? "unresolved",
          boosted: true
        });
      }
      // ---------- episode attribution walk (bisect) ----------
      // Walk main's recent history (newest → oldest, bounded) to the first
      // failing sha: the newest commit back from HEAD whose parent settles green
      // is the merge that broke the line. Unauthenticated GitHub quota is shared
      // per egress IP, so the walk is CAPPED and any error downgrades to
      // "bisect unavailable" on the card — a failed attribution never blocks the
      // filing, and the settled-green boundary always stops the walk.
      async stopLineBisect(ghGet, headSha) {
        const WALK = 10;
        try {
          const listBody = await (await ghGet(`/commits?per_page=${WALK}`)).json();
          const commits = (Array.isArray(listBody) ? listBody : []).map((c) => String(c?.sha ?? "")).filter((s) => /^[0-9a-f]{40}$/.test(s));
          for (let i = 1; i < commits.length; i++) {
            const runsBody = await (await ghGet(`/commits/${commits[i]}/check-runs?per_page=100`)).json();
            const v = classifyMainCheckRuns(Array.isArray(runsBody?.check_runs) ? runsBody.check_runs : []);
            if (v.verdict !== "green") continue;
            const firstFailing = commits[i - 1] || headSha;
            let pr;
            try {
              const pullsBody = await (await ghGet(`/commits/${firstFailing}/pulls`)).json();
              const pulls = Array.isArray(pullsBody) ? pullsBody : [];
              const pick = pulls.find((p) => p?.merged_at) ?? pulls[0];
              if (pick) pr = {
                number: Number(pick.number),
                title: String(pick.title ?? ""),
                html_url: String(pick.html_url ?? ""),
                merged_at: pick.merged_at ?? null
              };
            } catch {
            }
            return { first_failing_sha: firstFailing, first_failing_pr: pr, walked: i };
          }
          return { walked: commits.length, note: `no settled-green commit within ${WALK} commits of main` };
        } catch (e) {
          return { walked: 0, note: String(e.message ?? e).slice(0, 200) };
        }
      }
      // ---------- standing merge-queue sweep (BR#3198) ----------
      // The deterministic executor of the BR#3033 standing merge order ("merge
      // when green") — the run-side complement of BR#3008's stop-the-line gate.
      // Every tick (paced by `merge_sweep_minutes`, default 15, 0 = off), for each
      // OPEN PR on both repos, oldest first:
      //   superseded-check → 5c mechanical gate (mergeable + clean + every commit
      //   GitHub-verified + base green + head checks green) + an ACCEPTED
      //   verify-verdict decision covering the current head → merge (squash per
      //   repo norm). Mechanical defects auto-bounce the linked card with the
      //   exact defect; human-leg defects (externals, signing environment) are
      //   collected into ONE class ask per repo per episode, never one per PR.
      //
      // Identity: merges as the token's identity — deploy GH_TOKEN as the
      // detached-cody credential per BR#3181, never rayh's personal credentials.
      // Settings: `merge_sweep_minutes` (default 15), `merge_sweep_repos` (JSON
      // array, default both repos), `merge_sweep_methods` (JSON map repo →
      // "merge" | "squash", default bridge=merge / superpositional=squash),
      // `merge_sweep_artefact_id` (class-ask sink, default BR#3198),
      // `merge_sweep_gh_api_base` (drills/tests only).
      /** PR provenance sweep (BR#3287): index recent merges — sha → PR → task →
       *  verify-verdict → agent session — stamp task cards (meta.provenance,
       *  board-side storage of record per decision BR#3291) and mirror
       *  best-effort to GitHub (derived, never read back). Dedupe per (repo, pr)
       *  via the provenance table; backfill window bounds the cold-start scan. */
      async provenanceSweep(now) {
        const periodMin = Math.max(0, Math.min(120, parseInt(this.settingValue("provenance_sweep_minutes", "15"), 10) || 15));
        if (periodMin === 0) return;
        const last = Number(this.settingValue("provenance_last_ts", "0")) || 0;
        if (now - last < periodMin * 6e4) return;
        const setLast = /* @__PURE__ */ __name((ts) => this.state.storage.sql.exec(`INSERT OR REPLACE INTO settings (key, value) VALUES ('provenance_last_ts', ?)`, String(ts)), "setLast");
        setLast(now);
        const token = this.env.GH_TOKEN;
        if (!token) {
          this.audit("hub:provenance", "no_identity", null, { note: "GH_TOKEN not configured \u2014 provenance sweep cannot read GitHub; skipping (endpoint + backfill resume when it returns)" });
          return;
        }
        const base = this.settingValue("provenance_gh_api_base", "https://api.github.com").replace(/\/$/, "");
        let repos = [];
        try {
          const parsed = JSON.parse(this.settingValue("provenance_repos", JSON.stringify(["state-vector/bridge", "state-vector/superpositional"])));
          if (Array.isArray(parsed)) repos = parsed.map(String);
        } catch {
          repos = [];
        }
        if (!repos.length) repos = ["state-vector/bridge", "state-vector/superpositional"];
        const backfillDays = Math.max(1, Math.min(365, parseInt(this.settingValue("provenance_backfill_days", "30"), 10) || 30));
        const ghGet = /* @__PURE__ */ __name(async (path) => {
          const res = await fetch(`${base}${path}`, {
            headers: {
              authorization: `Bearer ${token}`,
              accept: "application/vnd.github+json",
              "user-agent": "bridge-provenance-sweep (BR#3287)",
              "x-github-api-version": "2022-11-28"
            }
          });
          if (res.status === 403 || res.status === 429) {
            setLast(now + 60 * 6e4);
            throw new Error(`github rate limited (HTTP ${res.status})`);
          }
          if (!res.ok) throw new Error(`github ${path} -> HTTP ${res.status}`);
          return res.json();
        }, "ghGet");
        let indexed = 0;
        for (const repo of repos) {
          let pulls = [];
          try {
            pulls = await ghGet(`/repos/${repo}/pulls?state=closed&sort=updated&direction=desc&per_page=50`);
          } catch (e) {
            this.audit("hub:provenance", "repo_error", null, { repo, error: String(e.message ?? e).slice(0, 200) });
            continue;
          }
          for (const pr of pulls) {
            if (!pr?.merged_at || !pr?.merge_commit_sha || !pr?.number) continue;
            const mergedAt = withinBackfillWindow(pr.merged_at, now, backfillDays);
            if (mergedAt === null) continue;
            const seen = this.one(`SELECT merge_sha FROM provenance WHERE repo = ? AND pr = ?`, repo, pr.number);
            if (seen) continue;
            try {
              const detail = await ghGet(`/repos/${repo}/pulls/${pr.number}`);
              const headSha = String(detail?.head?.sha ?? "");
              const branch = String(detail?.head?.ref ?? "");
              const cardRef = prCardRef(branch, `${pr.title ?? ""}
${pr.body ?? ""}
${detail?.title ?? ""}
${detail?.body ?? ""}`);
              const commitsBody = await ghGet(`/repos/${repo}/pulls/${pr.number}/commits?per_page=100`);
              const commits = (commitsBody ?? []).map((c) => ({
                verified: c?.commit?.verification?.verified === true,
                committer_email: String(c?.commit?.committer?.email ?? "")
              }));
              const signer = signerFromCommits(commits);
              let taskId = cardRef;
              let verdictId = null;
              let session = null;
              if (taskId && /^[0-9a-f]{40}$/.test(headSha)) {
                const decisions = this.state.storage.sql.exec(
                  `SELECT d.id AS id, d.body_md AS body_md, d.meta AS meta FROM relations r
               JOIN artefacts d ON d.id = r.src_id
               WHERE r.relation = 'derived_from' AND r.dst_id = ? AND d.type = 'decision' AND d.status = 'accepted'`,
                  taskId
                ).toArray();
                const onHead = decisions.find(
                  (d) => (String(d.body_md ?? "") + String(d.meta ?? "")).includes(headSha.slice(0, 9))
                );
                if (onHead) {
                  verdictId = String(onHead.id);
                  try {
                    session = String(JSON.parse(onHead.meta ?? "{}")?.session ?? "") || null;
                  } catch {
                    session = null;
                  }
                }
              }
              this.state.storage.sql.exec(
                `INSERT OR REPLACE INTO provenance (repo, pr, merge_sha, head_sha, task_id, verdict_id, session, signer, merged_at, stamped_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                repo,
                pr.number,
                String(pr.merge_commit_sha),
                headSha,
                taskId,
                verdictId,
                session,
                signer,
                mergedAt,
                Date.now()
              );
              indexed++;
              if (taskId) {
                const row = this.one(`SELECT meta FROM artefacts WHERE id = ?`, taskId);
                if (row) {
                  const meta = JSON.parse(row.meta ?? "{}");
                  meta.provenance = {
                    pr: pr.number,
                    repo,
                    merge_sha: String(pr.merge_commit_sha).slice(0, 12),
                    head_sha: headSha.slice(0, 12),
                    verdict_id: verdictId,
                    session,
                    signer,
                    merged_at: mergedAt
                  };
                  this.state.storage.sql.exec(`UPDATE artefacts SET meta = ?, updated_ts = ? WHERE id = ?`, JSON.stringify(meta), Date.now(), taskId);
                  this.audit("hub:provenance", "stamped", taskId, { pr: pr.number, repo, merge_sha: String(pr.merge_commit_sha).slice(0, 9), signer });
                }
              } else {
                this.audit("hub:provenance", "no_card", null, { repo, pr: pr.number, merge_sha: String(pr.merge_commit_sha).slice(0, 9), signer });
              }
              if (taskId) {
                try {
                  await fetch(`${base}/repos/${repo}/issues/${pr.number}/labels`, {
                    method: "POST",
                    headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "content-type": "application/json" },
                    // label format per README/spec: bridge:BR-<id> (BR#3307 — the
                    // raw card id renders "bridge:BR#3287"; normalize the #)
                    body: JSON.stringify({ labels: [`bridge:${taskId.replace("#", "-")}`] })
                  });
                } catch {
                }
              }
            } catch (e) {
              this.audit("hub:provenance", "pr_error", null, { repo, pr: pr.number, error: String(e.message ?? e).slice(0, 200) });
            }
          }
        }
        if (indexed) this.audit("hub:provenance", "indexed", null, { indexed, repos: repos.join(",") });
      }
      /** sha → PR → task → verify-verdict → agent session (BR#3287). Matches by
       *  merge sha or head sha (7+ hex prefix). Returns null when nothing is
       *  known — an honest "no bridge provenance" (404) rather than a guess. */
      async provenanceLookup(sp) {
        return this.provenanceBySha(parseProvenanceSha(sp));
      }
      async provenanceBySha(sha) {
        const row = this.one(
          `SELECT * FROM provenance WHERE merge_sha = ? OR merge_sha LIKE ? OR head_sha = ? OR head_sha LIKE ? LIMIT 1`,
          sha,
          `${sha}%`,
          sha,
          `${sha}%`
        );
        if (!row) return null;
        const task = row.task_id ? this.one(`SELECT id, title, status, owner FROM artefacts WHERE id = ?`, row.task_id) : null;
        return {
          sha,
          repo: row.repo,
          pr: row.pr,
          merge_sha: row.merge_sha,
          head_sha: row.head_sha,
          task: task ? { id: task.id, title: task.title, status: task.status, owner: task.owner } : null,
          verdict_id: row.verdict_id,
          session: row.session,
          signer: row.signer,
          merged_at: row.merged_at,
          stamped_at: row.stamped_at
        };
      }
      /** The guilty chain for an alarm note (BR#3307, residue of BR#3287 spec
       *  item 4): resolve a sha to PR → task → verify verdict → agent session →
       *  signer from the provenance index. Defensive — attribution must never
       *  break the filing (the same downgrade philosophy as the bisect walk),
       *  and absence is honest data, never a guess. */
      async guiltyChainRec(sha) {
        if (!sha || !/^[0-9a-f]{7,40}$/.test(sha)) return null;
        try {
          return await this.provenanceBySha(sha);
        } catch {
          return null;
        }
      }
      /** One markdown chain segment: `PR #N · task BR#X · verdict BR#Y ·
       *  session s · signer class` — with an honest fallback line when the
       *  provenance sweep has not stamped the merge yet. */
      guiltyChainLine(rec, sha) {
        if (!rec) {
          return `_no bridge provenance for ${sha ? sha.slice(0, 9) : "this sha"} yet \u2014 \`GET /api/kb/provenance?sha=\` returns the chain once the provenance sweep stamps the merge_`;
        }
        const prUrl = `https://github.com/${rec.repo}/pull/${rec.pr}`;
        return [
          `PR [#${rec.pr}](${prUrl})`,
          `task ${rec.task?.id ?? "none (no bridge card)"}`,
          `verdict ${rec.verdict_id ?? "none (unverified merge)"}`,
          `session ${rec.session ?? "\u2014"}`,
          `signer ${rec.signer ?? "unknown"}`
        ].join(" \xB7 ");
      }
      async mergeQueueSweep(now) {
        const periodMin = Math.max(0, Math.min(120, parseInt(this.settingValue("merge_sweep_minutes", "15"), 10) || 15));
        if (periodMin === 0) return;
        const last = Number(this.settingValue("merge_sweep_last_ts", "0")) || 0;
        if (now - last < periodMin * 6e4) return;
        const setLast = /* @__PURE__ */ __name((ts) => this.state.storage.sql.exec(`INSERT OR REPLACE INTO settings (key, value) VALUES ('merge_sweep_last_ts', ?)`, String(ts)), "setLast");
        setLast(now);
        const token = this.env.GH_TOKEN;
        if (!token) {
          this.audit("hub:merge-sweep", "no_identity", null, { note: "GH_TOKEN not configured \u2014 the sweep cannot merge as detached-cody (BR#3181); skipping, never merging unauthenticated" });
          return;
        }
        const base = this.settingValue("merge_sweep_gh_api_base", "https://api.github.com").replace(/\/$/, "");
        let repos = [];
        try {
          const parsed = JSON.parse(this.settingValue("merge_sweep_repos", JSON.stringify(["state-vector/bridge", "state-vector/superpositional"])));
          if (Array.isArray(parsed)) repos = parsed.map(String);
        } catch {
          repos = [];
        }
        if (!repos.length) repos = ["state-vector/bridge", "state-vector/superpositional"];
        let methods = {};
        try {
          const parsed = JSON.parse(this.settingValue("merge_sweep_methods", JSON.stringify({ "state-vector/bridge": "merge", "state-vector/superpositional": "squash" })));
          if (parsed && typeof parsed === "object") methods = parsed;
        } catch {
          methods = {};
        }
        const ghGet = /* @__PURE__ */ __name(async (path) => {
          const res = await fetch(`${base}${path}`, {
            headers: {
              authorization: `Bearer ${token}`,
              accept: "application/vnd.github+json",
              "user-agent": "bridge-merge-sweep (BR#3198)",
              "x-github-api-version": "2022-11-28"
            }
          });
          if (res.status === 403 || res.status === 429) {
            setLast(now + 60 * 6e4);
            throw new Error(`github rate limited (HTTP ${res.status})`);
          }
          if (!res.ok) throw new Error(`github ${path} -> HTTP ${res.status}`);
          return res.json();
        }, "ghGet");
        const cardRef = /* @__PURE__ */ __name((text2) => {
          const m = /BR#(\d+)/.exec(text2 ?? "");
          return m ? `BR#${m[1]}` : null;
        }, "cardRef");
        const sweepNote = /* @__PURE__ */ __name((id, note) => {
          const row = this.one(`SELECT meta FROM artefacts WHERE id = ?`, id);
          if (!row) return;
          const meta = JSON.parse(row.meta ?? "{}");
          meta.last_progress = { note: note.slice(0, 500), sentiment: "neutral", actor: "system:merge-sweep", ts: Date.now() };
          this.state.storage.sql.exec(`UPDATE artefacts SET meta = ?, updated_ts = ? WHERE id = ?`, JSON.stringify(meta), Date.now(), id);
          this.audit("system:merge-sweep", "progress", id, { note: note.slice(0, 500) });
          this.version(id, "system:merge-sweep", "progress", note.slice(0, 500), { note: note.slice(0, 500) });
        }, "sweepNote");
        const results = [];
        for (const repo of repos) {
          const humanLegs = [];
          try {
            const pulls = await ghGet(`/repos/${repo}/pulls?state=open&sort=created&direction=asc&per_page=100`);
            const head = await ghGet(`/repos/${repo}/commits/main`);
            const baseSha = String(head?.sha ?? "");
            let baseVerdict = "empty";
            if (/^[0-9a-f]{40}$/.test(baseSha)) {
              const runsBody = await ghGet(`/repos/${repo}/commits/${baseSha}/check-runs?per_page=100`);
              baseVerdict = classifyMainCheckRuns(Array.isArray(runsBody?.check_runs) ? runsBody.check_runs : []).verdict;
            }
            for (const pr of pulls) {
              const prNumber = pr.number;
              try {
                const detail = await ghGet(`/repos/${repo}/pulls/${prNumber}`);
                const linked = cardRef(`${pr.title ?? ""}
${pr.body ?? ""}
${detail.title ?? ""}
${detail.body ?? ""}`);
                const card = linked ? this.one(`SELECT id, status FROM artefacts WHERE id = ?`, linked) : null;
                const cardStatus = card ? String(card.status) : null;
                let verifyAcceptedAny = false;
                let verifyAcceptedOnHead = false;
                const headSha = String(detail?.head?.sha ?? "");
                if (linked && /^[0-9a-f]{40}$/.test(headSha)) {
                  const decisions = this.state.storage.sql.exec(
                    `SELECT d.body_md AS body_md, d.meta AS meta FROM relations r
                 JOIN artefacts d ON d.id = r.src_id
                 WHERE r.relation = 'derived_from' AND r.dst_id = ? AND d.type = 'decision' AND d.status = 'accepted'`,
                    linked
                  ).toArray();
                  verifyAcceptedAny = decisions.length > 0;
                  verifyAcceptedOnHead = decisions.some(
                    (d) => (String(d.body_md ?? "") + String(d.meta ?? "")).includes(headSha.slice(0, 9))
                  );
                }
                const commitsBody = await ghGet(`/repos/${repo}/pulls/${prNumber}/commits?per_page=100`);
                const commits = (commitsBody ?? []).map((c) => ({ sha: String(c?.sha ?? ""), verified: c?.commit?.verification?.verified === true }));
                const headChecksBody = await ghGet(`/repos/${repo}/commits/${headSha}/check-runs?per_page=100`);
                const headChecks = Array.isArray(headChecksBody?.check_runs) ? headChecksBody.check_runs : [];
                const action = decideMergeAction({
                  prNumber,
                  prTitle: String(detail?.title ?? pr.title ?? ""),
                  headSha,
                  baseVerdict,
                  mergeable: detail?.mergeable ?? null,
                  mergeStateStatus: detail?.merge_state_status ?? null,
                  commits,
                  headChecks,
                  cardStatus,
                  verifyAcceptedAny,
                  verifyAcceptedOnHead
                });
                if (action.kind === "merge") {
                  const method = methods[repo] === "squash" ? "squash" : "merge";
                  const mergeRes = await fetch(`${base}/repos/${repo}/pulls/${prNumber}/merge`, {
                    method: "PUT",
                    headers: {
                      authorization: `Bearer ${token}`,
                      accept: "application/vnd.github+json",
                      "content-type": "application/json",
                      "user-agent": "bridge-merge-sweep (BR#3198)"
                    },
                    body: JSON.stringify({ merge_method: method })
                  });
                  if (mergeRes.ok) {
                    const merged = await mergeRes.json().catch(() => ({}));
                    const receipt = `${action.receipt} \u2014 mergeCommit ${String(merged?.sha ?? "unknown").slice(0, 9)}`;
                    if (linked) sweepNote(linked, receipt);
                    results.push({ repo, pr: prNumber, kind: "merge", sha: String(merged?.sha ?? "").slice(0, 9) });
                    this.audit("system:merge-sweep", "merge", linked, { repo, pr: prNumber, method, receipt: receipt.slice(0, 300) });
                  } else if (mergeRes.status === 405 || mergeRes.status === 409) {
                    const defect = `PR #${prNumber} merge refused by GitHub (HTTP ${mergeRes.status}) \u2014 no longer mergeable/clean. Rebase, resolve, re-push, re-enter the queue`;
                    if (linked && cardStatus === "in_review") await this.transition({ id: linked, to: "in_progress", note: defect }, "system:merge-sweep");
                    else if (linked) sweepNote(linked, defect);
                    results.push({ repo, pr: prNumber, kind: "bounce", defect });
                  } else {
                    throw new Error(`merge PUT -> HTTP ${mergeRes.status}`);
                  }
                } else if (action.kind === "close_superseded") {
                  const close = await fetch(`${base}/repos/${repo}/issues/${prNumber}`, {
                    method: "PATCH",
                    headers: {
                      authorization: `Bearer ${token}`,
                      accept: "application/vnd.github+json",
                      "content-type": "application/json",
                      "user-agent": "bridge-merge-sweep (BR#3198)"
                    },
                    body: JSON.stringify({ state: "closed", state_reason: "not_planned" })
                  });
                  if (close.ok) {
                    if (linked) sweepNote(linked, `${action.reason} \u2014 PR #${prNumber} closed by the merge sweep (superseded-check first)`);
                    results.push({ repo, pr: prNumber, kind: "close_superseded" });
                    this.audit("system:merge-sweep", "close_superseded", linked, { repo, pr: prNumber });
                  } else throw new Error(`close PATCH -> HTTP ${close.status}`);
                } else if (action.kind === "bounce") {
                  if (linked && cardStatus === "in_review") {
                    await this.transition({ id: linked, to: "in_progress", note: action.defect }, "system:merge-sweep");
                  } else if (linked) {
                    sweepNote(linked, action.defect);
                  }
                  results.push({ repo, pr: prNumber, kind: "bounce", defect: action.defect });
                  this.audit("system:merge-sweep", "bounce", linked, { repo, pr: prNumber, defect: action.defect.slice(0, 300) });
                } else if (action.kind === "note") {
                  if (linked) sweepNote(linked, action.reason);
                  results.push({ repo, pr: prNumber, kind: "note" });
                } else if (action.kind === "human_leg") {
                  humanLegs.push(action.reason);
                  results.push({ repo, pr: prNumber, kind: "human_leg" });
                } else {
                  this.audit("system:merge-sweep", "skip", linked, { repo, pr: prNumber, reason: action.reason.slice(0, 300) });
                  results.push({ repo, pr: prNumber, kind: "skip", reason: action.reason.slice(0, 120) });
                }
              } catch (e) {
                this.audit("system:merge-sweep", "pr_error", null, { repo, pr: prNumber, error: String(e.message ?? e).slice(0, 300) });
                results.push({ repo, pr: prNumber, kind: "pr_error", error: String(e.message ?? e).slice(0, 120) });
              }
            }
            if (humanLegs.length) {
              const sinkId = this.settingValue("merge_sweep_artefact_id", "BR#3198");
              const title = mergeSweepHumanLegTitle(repo, humanLegs);
              const dup = this.one(
                `SELECT c.id AS id FROM relations r JOIN artefacts c ON c.id = r.src_id
             WHERE r.relation = 'child_of' AND r.dst_id = ? AND c.status IN ('todo','in_progress','blocked')
               AND c.type = 'question' AND c.title = ? LIMIT 1`,
                sinkId,
                title.slice(0, 200)
              );
              if (dup) {
                this.audit("system:merge-sweep", "human_leg_dupe", String(dup.id), { repo, legs: humanLegs.slice(0, 5) });
              } else {
                const created = await this.askCreate(
                  {
                    to: "rayh",
                    urgency: "normal",
                    question: title,
                    details: [
                      `**Human-leg merge blockers (BR#3198 class ask \u2014 one ask per class, never per PR).**`,
                      ``,
                      ...humanLegs.map((r) => `- ${r}`),
                      ``,
                      `_These are the only defects the standing merge sweep (BR#3198) cannot resolve autonomously. Everything mechanical was bounced with the exact defect on the linked card._`
                    ].join("\n"),
                    reason: "merge sweep collected human-leg defects into the single class ask per rule 5c",
                    options: ["Acknowledge \u2014 on it", "Redirect the class"],
                    artefact_id: sinkId
                  },
                  "system:merge-sweep"
                );
                this.audit("system:merge-sweep", "human_leg_ask", String(created.id), { repo, legs: humanLegs.slice(0, 5) });
                results.push({ repo, pr: null, kind: "human_leg_ask", ask: created.id });
              }
            }
          } catch (e) {
            this.audit("system:merge-sweep", "repo_error", null, { repo, error: String(e.message ?? e).slice(0, 300) });
            results.push({ repo, pr: null, kind: "repo_error", error: String(e.message ?? e).slice(0, 120) });
          }
        }
        this.state.storage.sql.exec(
          `INSERT OR REPLACE INTO settings (key, value) VALUES ('merge_sweep_last', ?)`,
          JSON.stringify({ ts: now, merged: results.filter((r) => r.kind === "merge").length, bounced: results.filter((r) => r.kind === "bounce").length, closed: results.filter((r) => r.kind === "close_superseded").length, human_legs: results.filter((r) => r.kind === "human_leg").length, skipped: results.filter((r) => r.kind === "skip").length, results: results.slice(0, 50) })
        );
        const summary = results.filter((r) => ["merge", "bounce", "close_superseded", "human_leg_ask"].includes(r.kind));
        if (summary.length)
          this.audit("system:merge-sweep", "sweep", null, { repos, n: summary.length, actions: summary.slice(0, 20) });
      }
      async eventsSince(since, limit) {
        const rows = since > 0 ? this.state.storage.sql.exec(
          `SELECT seq, ts, actor, op, artefact_id, detail FROM events WHERE seq > ? ORDER BY seq ASC LIMIT ?`,
          since,
          limit
        ).toArray() : this.state.storage.sql.exec(
          `SELECT seq, ts, actor, op, artefact_id, detail FROM events WHERE seq > 0 ORDER BY seq DESC LIMIT ?`,
          limit
        ).toArray().reverse();
        const events = rows.map((e) => ({ ...e, detail: JSON.parse(e.detail ?? "{}") }));
        return { events, last_seq: events.length ? events[events.length - 1].seq : since };
      }
      async board() {
        const tasks = this.state.storage.sql.exec(
          `SELECT id, type, title, status, owner, tags, roles, meta, body_md, status_ts, created_ts, updated_ts, project FROM artefacts
       WHERE type IN ('task','question') ORDER BY updated_ts DESC LIMIT 200`
        ).toArray().map((t) => ({ ...t, meta: JSON.parse(t.meta ?? "{}"), tags: parseTags(t.tags), roles: parseTags(t.roles) }));
        const links = this.state.storage.sql.exec(
          `SELECT src_id, dst_id FROM relations WHERE relation = 'child_of'`
        ).toArray();
        const byId = new Map(tasks.map((t) => [t.id, t]));
        const parentOf = new Map(links.map((l) => [l.src_id, l.dst_id]));
        for (const t of tasks) {
          const parent = parentOf.get(t.id);
          if (parent) t.part_of = parent;
          t.children_open = 0;
          t.children_done = 0;
        }
        for (const l of links) {
          const parent = byId.get(l.dst_id);
          const child = byId.get(l.src_id);
          if (!parent || !child) continue;
          if (child.status === "done" || child.status === "superseded") parent.children_done++;
          else parent.children_open++;
        }
        const { analysisEv, reviewEv } = this.qualificationEvidence();
        for (const t of tasks) {
          const q = t.meta.qualification ?? {};
          const declared = q.state ?? (t.meta.qualified === true ? "qualified" : void 0);
          const bars = q.bars ?? [];
          const parent = t.part_of ? byId.get(t.part_of) : null;
          const pq = parent ? parent.meta.qualification ?? {} : {};
          const analysisOk = declared === "qualified" || analysisEv.has(t.id) || (parent && (pq.state === "qualified" || parent.meta.qualified === true || analysisEv.has(parent.id))) === true;
          const unmet = this.enforceableBars(bars).filter((b) => !(/review/.test(b) ? reviewEv : analysisEv).has(t.id));
          t.qualification = { state: declared ?? (analysisOk ? "qualified" : "open"), how: q.how, by: q.by, bars, unmet_bars: unmet, ready: analysisOk && unmet.length === 0 };
          const tagsArr = t.tags ?? [];
          const roleTagged = (t.roles ?? []).some((x) => ["analysis", "review", "impl", "unblock"].includes(x));
          const isQ = t.type === "question";
          const gated = t.meta.operator_gated;
          const roleWorkReady = roleTagged && t.qualification.ready !== false ? true : roleTagged;
          t.is_claimable = t.status === "todo" && !isQ && !gated && (roleWorkReady || t.qualification.ready !== false);
          if (!t.is_claimable && t.status === "todo") {
            t.claim_reason = isQ ? "question \u2014 answered, not claimed (contribute via log_progress)" : gated ? `operator gated: ${gated} \u2014 a human clears the gate` : roleTagged ? "" : "needs qualification \u2014 a done analysis child, an accepted decision, or the publisher's declaration";
          }
        }
        const sessions = this.state.storage.sql.exec(
          `SELECT s.token_id, s.name, s.worktree, s.first_seen_ts, s.last_seen_ts, t.label
       FROM sessions s LEFT JOIN auth_tokens t ON t.id = s.token_id ORDER BY s.last_seen_ts DESC LIMIT 100`
        ).toArray();
        const openAskChildren = this.state.storage.sql.exec(
          `SELECT r.dst_id AS parent, c.id AS id, c.created_ts AS created_ts, c.meta AS cmeta
       FROM relations r JOIN artefacts c ON c.id = r.src_id
       WHERE r.relation = 'child_of' AND c.status IN ('todo','in_progress','blocked')
         AND c.type = 'question'
       ORDER BY c.created_ts DESC`
        ).toArray();
        const askChildOf = /* @__PURE__ */ new Map();
        for (const c of openAskChildren) {
          if (!askChildOf.has(c.parent)) askChildOf.set(c.parent, c);
        }
        const progress = this.state.storage.sql.exec(
          `SELECT seq, ts, actor, artefact_id, detail FROM events
       WHERE op = 'progress' ORDER BY seq DESC LIMIT 120`
        ).toArray().map((e) => ({ ...e, detail: JSON.parse(e.detail ?? "{}") }));
        const series = this.state.storage.sql.exec(
          `SELECT artefact_id, ts, actor, data FROM artefact_versions
       WHERE action = 'progress' ORDER BY seq DESC LIMIT 400`
        ).toArray().map((v) => {
          const d = JSON.parse(v.data ?? "{}");
          return { artefact_id: v.artefact_id, ts: v.ts, actor: v.actor, ...d };
        });
        return { tasks, sessions, progress, series, agents: this.agentScores() };
      }
      /** Behaviour signals per agent over the trailing 7-day window, scored via scoreAgent().
       *  Cached per-isolate (30s TTL) — it fans out to several table scans per call and
       *  runs on every board/orient/log_progress; uncached it eats the DO row-read quota. */
      scoreCache = null;
      agentScores() {
        const now = Date.now();
        if (this.scoreCache && now - this.scoreCache.at < 3e4) return this.scoreCache.rows;
        const rows = this.computeAgentScores();
        this.scoreCache = { at: now, rows };
        return rows;
      }
      computeAgentScores() {
        const weekTs = Date.now() - 7 * 24 * 60 * 6e4;
        const recentTs = Date.now() - 48 * 60 * 6e4;
        const tokens = this.state.storage.sql.exec(
          `SELECT label, tags FROM auth_tokens WHERE revoked_ts IS NULL`
        ).toArray();
        const signals = /* @__PURE__ */ new Map();
        const sig = /* @__PURE__ */ __name((label) => {
          let s = signals.get(label);
          if (!s) {
            s = { progress_count: 0, gauge_count: 0, thin_notes: 0, abandoned: 0, reassigned: 0, asks_received: 0, asks_answered_on_time: 0, artefacts_created: 0, verify_duty_backlog: 0 };
            signals.set(label, s);
          }
          return s;
        }, "sig");
        for (const t of tokens) sig(t.label);
        for (const p of this.state.storage.sql.exec(
          `SELECT actor, data FROM artefact_versions WHERE action = 'progress' AND ts >= ?`,
          weekTs
        ).toArray()) {
          const s = sig(p.actor);
          const d = JSON.parse(p.data ?? "{}");
          s.progress_count++;
          if (d.completion_pct != null || d.confidence_pct != null || d.risk_pct != null) s.gauge_count++;
          if (String(d.note ?? "").trim().length < 10) s.thin_notes++;
        }
        for (const r of this.state.storage.sql.exec(
          `SELECT a.owner AS owner, COUNT(*) AS n FROM events e JOIN artefacts a ON a.id = e.artefact_id
       WHERE e.op = 'transition' AND e.actor = 'system:watchdog' AND e.ts >= ? GROUP BY a.owner`,
          recentTs
        ).toArray()) sig(r.owner || "unknown").abandoned += r.n;
        for (const r of this.state.storage.sql.exec(
          `SELECT detail FROM events WHERE op = 'reassign' AND ts >= ?`,
          recentTs
        ).toArray()) {
          const d = JSON.parse(r.detail ?? "{}");
          sig(d.prev_owner || "unknown").reassigned++;
        }
        for (const r of this.state.storage.sql.exec(
          `SELECT owner, COUNT(*) AS n FROM artefacts
       WHERE created_ts >= ? AND LENGTH(body_md) >= 200 AND owner != '' GROUP BY owner`,
          weekTs
        ).toArray()) sig(r.owner).artefacts_created += r.n;
        for (const t of tokens) {
          const s = sig(t.label);
          const tags = parseTags(t.tags);
          const targets = ["any", t.label, ...tags.map((x) => `tag:${x}`)];
          const marks = targets.map(() => "?").join(",");
          s.asks_received = this.one(
            `SELECT COUNT(*) AS n FROM asks WHERE status IN ('open','answered') AND from_label != ?
         AND created_ts >= ? AND to_target IN (${marks})`,
            t.label,
            weekTs,
            ...targets
          )?.n ?? 0;
          s.asks_answered_on_time = this.one(
            `SELECT COUNT(*) AS n FROM asks WHERE status = 'answered' AND answered_by = ? AND answered_ts IS NOT NULL
         AND answered_ts - created_ts <= ${30 * 6e4} AND created_ts >= ?`,
            t.label,
            weekTs
          )?.n ?? 0;
          if (tags.includes("role:review")) {
            s.verify_duty_backlog = this.one(
              `SELECT COUNT(*) AS n FROM relations r JOIN artefacts c ON c.id = r.src_id JOIN artefacts p ON p.id = r.dst_id
           WHERE r.relation = 'child_of' AND c.type = 'task' AND c.status = 'todo' AND c.owner = ''
           AND c.roles LIKE '%"review"%' AND p.status = 'in_review'`
            )?.n ?? 0;
          }
        }
        return [...signals.entries()].filter(([label]) => !/^(system:|web$)/.test(label)).map(([label, s]) => ({ label, ...s, ...scoreAgent(s) })).sort((a, b) => b.score - a.score);
      }
      async getWithRelations(id) {
        const a = await this.get(id);
        const rel = await this.relations(id);
        return { ...a, relations: rel.relations };
      }
      async ensureSchema() {
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
      -- gateway \u2192 dispatched-agent attribution (BR#2455): stamped whenever a
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
        -- PR provenance (BR#3287): sha \u2192 PR \u2192 task \u2192 verify-verdict \u2192 agent
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
          `ALTER TABLE sessions ADD COLUMN worktree TEXT`
          // BR#3204: where the session's tree lives — board collision visibility
        ]) {
          try {
            this.state.storage.sql.exec(ddl);
          } catch {
          }
        }
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
        try {
          this.state.storage.sql.exec(
            `UPDATE sessions SET kind = 'gateway' WHERE kind IS NULL AND token_id IN
          (SELECT id FROM auth_tokens WHERE tags LIKE '%gateway%')`
          );
        } catch {
        }
        try {
          if (!this.one(`SELECT value FROM settings WHERE key = 'asks_v2'`)) {
            const legacy = this.state.storage.sql.exec(
              `SELECT id, from_label, to_target, question, created_ts, artefact_id FROM asks WHERE status = 'open'`
            ).toArray();
            let n = 0;
            for (const a of legacy) {
              const created = await this.create(
                {
                  type: "question",
                  title: String(a.question ?? "").slice(0, 200),
                  body_md: String(a.question ?? ""),
                  owner: "",
                  meta: { ask: { to: a.to_target ?? "any", from: a.from_label ?? "agent", urgency: "normal", options: [], artefact_id: a.artefact_id || void 0, legacy_id: a.id } }
                },
                "system:migration"
              );
              if (a.artefact_id) {
                const subj = this.one(`SELECT id, meta FROM artefacts WHERE id = ?`, a.artefact_id);
                if (subj) {
                  this.state.storage.sql.exec(
                    `INSERT OR IGNORE INTO relations (src_id, relation, dst_id, created_ts) VALUES (?, 'child_of', ?, ?)`,
                    created.id,
                    a.artefact_id,
                    Date.now()
                  );
                  const sm = JSON.parse(subj.meta ?? "{}");
                  if (sm.awaiting_ask?.ask_id === a.id) sm.awaiting_ask = { ...sm.awaiting_ask, ask_id: created.id };
                  this.state.storage.sql.exec(`UPDATE artefacts SET meta = ? WHERE id = ?`, JSON.stringify(sm), a.artefact_id);
                }
              }
              this.state.storage.sql.exec(
                `UPDATE artefacts SET created_ts = ? WHERE id = ?`,
                Number(a.created_ts ?? Date.now()),
                created.id
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
        try {
          if (!this.one(`SELECT value FROM settings WHERE key = 'asks_options_v1'`)) {
            const nodes = this.state.storage.sql.exec(
              `SELECT id, title, body_md, meta FROM artefacts
           WHERE status NOT IN ('done','superseded') AND (type = 'question' OR (type = 'task' AND tags LIKE '%question%'))`
            ).toArray();
            let n = 0;
            for (const node of nodes) {
              const m = JSON.parse(node.meta ?? "{}");
              if (m.ask?.legacy_id) continue;
              if (!m.ask || Array.isArray(m.ask.options) && m.ask.options.length >= 2) continue;
              const text2 = `${node.title ?? ""} ${node.body_md ?? ""}`;
              let opts = [];
              const parts = text2.split(/\([A-Da-d1-4]\)\s+/).map((x) => x.trim());
              if (parts.length >= 3) {
                opts = parts.slice(1, 5).map((x) => {
                  const cut = x.split(/\s+(?:vs\.?|or|—|--)\s+/i)[0];
                  return cut.replace(/\s*\n\s*/g, " ").slice(0, 140).trim();
                }).filter((x) => x.length >= 2);
              }
              if (opts.length < 2) {
                opts = /GO\/NO-GO|GO or NO-GO|merge GO/i.test(text2) ? ["GO \u2014 proceed as stated", "NO-GO \u2014 hold, reason in comment"] : ["Approved \u2014 proceed as stated", "Hold \u2014 reason in comment"];
              }
              m.ask = { ...m.ask ?? {}, options: opts.slice(0, 4) };
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
        try {
          if (!this.one(`SELECT value FROM settings WHERE key = 'tags_v1'`)) {
            let fixed = 0;
            for (const r of this.state.storage.sql.exec(`SELECT id, tags FROM artefacts`).toArray()) {
              const canonical = JSON.stringify(parseTags(r.tags));
              if (canonical !== String(r.tags ?? "")) {
                this.state.storage.sql.exec(`UPDATE artefacts SET tags = ? WHERE id = ?`, canonical, r.id);
                fixed++;
              }
            }
            for (const r of this.state.storage.sql.exec(`SELECT id, tags FROM auth_tokens`).toArray()) {
              const canonical = JSON.stringify(parseTags(r.tags));
              if (canonical !== String(r.tags ?? "")) {
                this.state.storage.sql.exec(`UPDATE auth_tokens SET tags = ? WHERE id = ?`, canonical, r.id);
                fixed++;
              }
            }
            for (const r of this.state.storage.sql.exec(`SELECT token_id, name, kind FROM sessions WHERE kind IS NULL OR kind = ''`).toArray()) {
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
        try {
          if (!this.one(`SELECT value FROM settings WHERE key = 'roles_v1'`)) {
            let roleRows = 0, questionRows = 0, attemptRows = 0;
            for (const r of this.state.storage.sql.exec(`SELECT id, type, tags, meta, updated_ts FROM artefacts`).toArray()) {
              const tags = parseTags(r.tags);
              if (!tags.length) continue;
              const meta = JSON.parse(r.meta ?? "{}");
              const out = splitSystemTags(String(r.type ?? ""), tags, meta, Number(r.updated_ts ?? Date.now()));
              if (!out.changed) continue;
              this.state.storage.sql.exec(
                `UPDATE artefacts SET type = ?, tags = ?, roles = ?, meta = ? WHERE id = ?`,
                out.type,
                out.tags.length ? JSON.stringify(out.tags) : null,
                out.roles.length ? JSON.stringify(out.roles) : null,
                JSON.stringify(out.meta),
                r.id
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
        const projectName = this.settingsMap().project_name || "superpositional";
        this.state.storage.sql.exec(
          `UPDATE artefacts SET project = ? WHERE project = '' AND type = 'task'`,
          projectName
        );
        this.state.storage.sql.exec(`UPDATE artefacts SET owner = '' WHERE type = 'task' AND status = 'todo' AND owner != ''`);
      }
      async fetch(request) {
        await this.ensureSchema();
        const alarmAt = await this.state.storage.getAlarm();
        if (alarmAt === null || alarmAt < Date.now()) {
          await this.state.storage.setAlarm(Date.now() + 15e3);
        }
        const url = new URL(request.url);
        if (url.pathname === "/ws") return this.handleWs(request);
        if (url.pathname === "/token.self_revoke") {
          const body2 = await request.json();
          let identity;
          try {
            identity = await this.identify(String(body2.bearer ?? ""));
          } catch {
            return this.json({ ok: true, revoked: null });
          }
          this.state.storage.sql.exec(`UPDATE auth_tokens SET revoked_ts = ? WHERE id = ?`, Date.now(), identity.token_id);
          this.audit(identity.label, "self_revoke", identity.token_id, {});
          return this.json({ ok: true, revoked: identity.label });
        }
        if (url.pathname === "/token.rename") {
          const body2 = await request.json();
          const identity = await this.identify(String(body2.bearer ?? ""));
          const newLabel = String(body2.label ?? "").trim();
          if (!/^[a-zA-Z0-9._\/-]{2,40}$/.test(newLabel)) throw new Error("label must be 2-40 chars [a-zA-Z0-9._-]");
          const old = this.one(`SELECT label, tags FROM auth_tokens WHERE id = ?`, identity.token_id);
          if (!old) throw new Error("auth token not found");
          if (newLabel !== old.label) {
            if (this.one(`SELECT id FROM auth_tokens WHERE label = ?`, newLabel)) throw new Error(`label '${newLabel}' already exists`);
          }
          this.state.storage.sql.exec(
            `UPDATE auth_tokens SET label = ? WHERE id = ?`,
            newLabel,
            identity.token_id
          );
          this.audit(identity.label, "rename", null, { from: old.label, to: newLabel });
          return this.json({ ok: true, from: old.label, to: newLabel });
        }
        if (request.method === "GET") {
          try {
            switch (url.pathname) {
              case "/artefacts":
                return this.json(await this.list({ type: url.searchParams.get("type") ?? void 0, status: url.searchParams.get("status") ?? void 0, tag: url.searchParams.get("tag") ?? void 0, limit: url.searchParams.get("limit") ?? void 0 }));
              case "/artefact":
                return this.json(await this.getWithRelations(String(url.searchParams.get("id"))));
              case "/search":
                return this.json(await this.search({ q: url.searchParams.get("q") ?? "", type: url.searchParams.get("type") ?? void 0, limit: url.searchParams.get("limit") ?? void 0 }));
              case "/events":
                return this.json(await this.eventsSince(Number(url.searchParams.get("since") ?? 0), Math.min(Number(url.searchParams.get("limit") ?? 100), 500)));
              case "/board":
                return this.json(await this.board());
              case "/stats":
                return this.json(await this.stats());
              case "/metrics.throughput":
                return this.json(await this.metricsThroughput(url.searchParams));
              case "/provenance": {
                const b = await this.provenanceLookup(url.searchParams);
                return b ? this.json(b) : this.json({ error: "no bridge provenance for this sha" }, 404);
              }
              case "/history":
                return this.json(await this.getHistory(String(url.searchParams.get("id")), Math.min(Number(url.searchParams.get("limit") ?? 100), 200)));
              case "/ask": {
                const a = await this.askGet(String(url.searchParams.get("id")));
                return a ? this.json(a) : this.json({ error: "no such ask" }, 404);
              }
            }
          } catch (e) {
            return this.json({ error: String(e.message ?? e) }, 400);
          }
        }
        const op = url.pathname.slice(1);
        let body = {};
        if (request.method === "POST") body = await request.json();
        const isAdmin = request.headers.get("x-kb-admin") === "1";
        const actor = String(body.actor ?? "mcp");
        try {
          switch (op) {
            case "create":
              return this.json(await this.create(body, actor));
            case "boost":
              return this.json(await this.boost(body, actor));
            case "get":
              return this.json(await this.get(String(body.id)));
            case "list":
              return this.json(await this.list(body));
            case "search":
              return this.json(await this.search(body));
            case "provenance": {
              const rec = await this.provenanceBySha(parseProvenanceSha(new URLSearchParams({ sha: String(body?.sha ?? "") })));
              return rec ? this.json(rec) : this.json({ error: "no bridge provenance for this sha", sha: String(body?.sha ?? "") }, 404);
            }
            case "related":
              return this.json(await this.related(String(body.id), Number(body.limit ?? 10)));
            case "enrich":
              return this.json(await this.enrich(body, actor));
            case "update":
              return this.json(await this.update(body, actor));
            case "transition":
              return this.json(await this.transition(body, actor));
            case "link":
              return this.json(await this.link(body, actor));
            case "relations":
              return this.json(await this.relations(String(body.id)));
            case "stats":
              return this.json(await this.stats());
            case "get_history":
              return this.json(await this.getHistory(String(body.id ?? ""), Number(body.limit ?? 100)));
            // ---- machine-plane identity + sessions + asks ----
            case "auth.identify":
              return this.json(await this.identify(String(body.bearer ?? "")));
            case "agent.provision":
              return this.json(await this.agentProvision(body, actor));
            case "self.provision":
              return this.json(await this.selfProvision(body, actor));
            case "agents.list":
              return this.json(await this.listAgents());
            case "session.touch":
              return this.json(await this.sessionTouch(body));
            case "ask.create":
              return this.json(await this.askCreate(body, actor));
            case "ask.inbox":
              return this.json(await this.askInbox(body));
            case "ask.answer":
              return this.json(await this.askAnswer(body, actor));
            case "ask.get":
              return this.json(await this.askGet(String(body.id ?? "")));
            case "purge_smoke":
              return this.json(await this.purgeSmoke(body));
            case "ask.reframe":
              return this.json(await this.askReframe(body, actor));
            case "orient":
              return this.json(await this.orient(body));
            case "progress.log":
              return this.json(await this.progressLog(body, actor));
            case "session.alive": {
              const row = this.one(`SELECT id, meta FROM artefacts WHERE id = ? AND type = 'task' AND status = 'in_progress'`, String(body.id ?? ""));
              if (!row) return this.json({ ok: false, error: "task not in progress" });
              const meta = JSON.parse(row.meta ?? "{}");
              meta.session_alive_ts = Date.now();
              this.state.storage.sql.exec(`UPDATE artefacts SET meta = ? WHERE id = ?`, JSON.stringify(meta), row.id);
              return this.json({ ok: true });
            }
            case "settings.public":
              return this.json({ settings: this.publicSettings() });
            case "bootstrap": {
              const m = this.settingsMap();
              return this.json({
                project_name: m.project_name || "Superpositional",
                instructions: composeBootstrap(m.project_name || "Superpositional", m.board ?? DEFAULT_BOARD)
              });
            }
            // ---- workspace registry (global DO; human plane, owner-checked) ----
            case "ws.seed":
              return this.json(await this.wsSeed(body.logins ?? []));
            case "ws.list":
              return this.json(await this.wsList(String(body.login)));
            case "ws.create":
              return this.json(await this.wsCreate(body, String(body.login)));
            case "ws.join":
              return this.json(await this.wsJoin(body, String(body.login)));
            case "ws.members":
              return this.json(await this.wsMembers(body, String(body.login)));
            case "ws.token_register":
              return this.json(await this.wsTokenRegister(body));
            case "ws.token_lookup":
              return this.json(await this.wsTokenLookup(body));
            case "ws.pair.start":
              return this.json(await this.wsPairStart(body));
            case "ws.pair.get":
              return this.json(await this.wsPairGet(body));
            case "ws.pair.approve":
              return this.json(await this.wsPairApprove(body));
            case "ws.pair.poll":
              return this.json(await this.wsPairPoll(body));
            // ---- admin (human plane only; worker sets x-kb-admin after session auth) ----
            case "admin.mint":
            case "admin.list_tokens":
            case "admin.revoke":
            case "admin.token_tags":
            case "admin.settings_get":
            case "admin.settings_set":
            case "admin.stop_line_sweep":
            case "admin.merge_queue_sweep":
            case "admin.provenance_sweep":
              if (!isAdmin) return this.json({ error: "admin only" }, 403);
              if (op === "admin.mint") return this.json(await this.tokenMint(body));
              if (op === "admin.list_tokens") return this.json(await this.tokenList());
              if (op === "admin.revoke") return this.json(await this.tokenRevoke(body));
              if (op === "admin.token_tags") return this.json(await this.tokenTags(body));
              if (op === "admin.settings_get") return this.json(await this.settingsGet());
              if (op === "admin.stop_line_sweep") {
                await this.stopTheLineSweep(Number(body.now ?? Date.now()));
                const last = this.one(`SELECT value FROM settings WHERE key = 'stop_line_last_sweep_ts'`);
                return this.json({ ok: true, last_sweep_ts: Number(last?.value ?? 0) });
              }
              if (op === "admin.merge_queue_sweep") {
                await this.mergeQueueSweep(Number(body.now ?? Date.now()));
                const sweepLast = this.one(`SELECT value FROM settings WHERE key = 'merge_sweep_last'`);
                return this.json({ ok: true, last_sweep: sweepLast ? JSON.parse(sweepLast.value) : null });
              }
              if (op === "admin.provenance_sweep") {
                await this.provenanceSweep(Number(body.now ?? Date.now()));
                const last = this.one(`SELECT value FROM settings WHERE key = 'provenance_last_ts'`);
                const n = this.one(`SELECT COUNT(*) AS n FROM provenance`);
                return this.json({ ok: true, last_sweep_ts: Number(last?.value ?? 0), indexed: Number(n?.n ?? 0) });
              }
              return this.json(await this.settingsSet(body));
            default:
              return this.json({ error: `unknown op ${op}` }, 404);
          }
        } catch (e) {
          return this.json({ error: String(e.message ?? e) }, 400);
        }
      }
      // ---------- ops ----------
      async create(body, actor) {
        let type = body.type;
        if (!isArtefactType(type)) throw new Error(`unknown artefact type '${type}' (valid: ${ARTEFACT_TYPES.join(", ")})`);
        const title = String(body.title ?? "");
        let bodyMd = String(body.body_md ?? "");
        const limitErr = checkLimits(title, bodyMd, body.meta);
        if (limitErr) throw new Error(limitErr);
        const seq = await this.nextSeq(type);
        const id = formatId(seq);
        const ts = Date.now();
        const status = INITIAL_STATUS[type];
        const tags = sanitizeTags(body.tags);
        const rolesIn = parseRolesInput(body.roles);
        if (rolesIn.ok === false) throw new Error(rolesIn.error);
        const roles = rolesIn.roles;
        const session = await this.resolveSession(body, String(body.token_id ?? ""));
        const project = String(body.project ?? "").trim() || this.settingsMap().project_name || "superpositional";
        let owner = type === "task" ? String(body.owner ?? "").trim() : "";
        if (type !== "task") {
          const pm = body.meta ?? {};
          if (type === "decision" && !pm.proposed_by) pm.proposed_by = actor;
        }
        const createMeta = { ...body.meta ?? {} };
        if (createMeta.ask && (type === "task" || type === "question")) {
          const opts = Array.isArray(createMeta.ask.options) ? createMeta.ask.options.filter(Boolean) : [];
          if (opts.length < 2) throw new Error("asks require 2-8 answer options \u2014 give the human one-click answers (meta.ask.options)");
          if (!String(body.title ?? "").trimEnd().endsWith("?")) throw new Error("phrase the ask as an answerable question ending in '?' \u2014 e.g. 'Do you want to merge PR #84 into main?'");
        }
        if (createMeta.kind !== void 0) {
          const k = String(createMeta.kind);
          const kindType = KIND_TYPE[k];
          if (kindType && type === "task") type = kindType;
          const kindRole = KIND_ROLE[k];
          if (kindRole && !roles.includes(kindRole)) roles.push(kindRole);
          const kindTag = KIND_TAG[k];
          if (kindTag && !tags.includes(kindTag)) tags.push(kindTag);
          delete createMeta.kind;
        }
        if (type === "task" && (body.qualified === true || Array.isArray(body.await) && body.await.length)) {
          createMeta.qualification = {
            state: body.qualified === true ? "qualified" : "open",
            how: body.qualified === true ? "self-analyzed" : "open",
            by: actor,
            ts,
            bars: Array.isArray(body.await) ? body.await.map(String) : []
          };
        }
        if (type === "decision" && createMeta.decision_class === "verify-verdict") {
          const target = String(createMeta.task ?? createMeta.verify_target ?? "").trim();
          const verdict = String(createMeta.verdict ?? "").toLowerCase();
          if (target && verdict) {
            const prev = this.one(
              `SELECT id, meta FROM artefacts WHERE type = 'decision' AND status = 'proposed'
           AND json_extract(meta, '$.decision_class') = 'verify-verdict'
           AND (json_extract(meta, '$.task') = ? OR json_extract(meta, '$.verify_target') = ?)
           ORDER BY created_ts DESC LIMIT 1`,
              target,
              target
            );
            const fp = /* @__PURE__ */ __name((m) => JSON.stringify(Object.entries(m ?? {}).filter(([k]) => !["decision_class", "task", "verify_target", "verdict", "session", "round"].includes(k)).sort(([a], [b]) => a.localeCompare(b))), "fp");
            const same = prev && String(JSON.parse(prev.meta ?? "{}").verdict ?? "").toLowerCase() === verdict && fp(createMeta) === fp(JSON.parse(prev.meta ?? "{}"));
            if (same) {
              const trow = this.one(`SELECT id, status, meta FROM artefacts WHERE id = ?`, target);
              if (trow) {
                const tm = JSON.parse(trow.meta ?? "{}");
                const round = Number(createMeta.round ?? tm.verify_round ?? 0) + 1;
                tm.verify_round = round;
                const prevGauges = tm.last_progress ?? {};
                tm.last_progress = {
                  note: `verify round ${round}: verdict ${verdict} UNCHANGED \u2014 auto-applied, no new decision card`,
                  sentiment: "neutral",
                  actor,
                  ts: Date.now(),
                  completion_pct: prevGauges.completion_pct,
                  confidence_pct: prevGauges.confidence_pct,
                  risk_pct: prevGauges.risk_pct,
                  context_pct: prevGauges.context_pct
                };
                const alreadyRight = verdict === "bounce" ? trow.status === "in_progress" : trow.status === "done";
                if (!alreadyRight) {
                  if (round >= 3) {
                    await this.transition({
                      id: trow.id,
                      to: "blocked",
                      note: `verify loop stalled \u2014 ${round} rounds with identical verdict (${verdict}); auto-applied each time, no progress. Needs human intervention.`,
                      unblock_condition: "human: read the verify history on this card; either clear the blocker the verifier keeps naming, or cancel the loop (transition todo and address the task differently)"
                    }, "system:verifier");
                  } else {
                    await this.transition({
                      id: trow.id,
                      to: verdict === "bounce" ? "in_progress" : "done",
                      note: `verify round ${round}: identical verdict (${verdict}) \u2014 auto-applied (For Me flood fix; no decision card)`
                    }, "system:verifier");
                  }
                } else {
                  this.state.storage.sql.exec(`UPDATE artefacts SET meta = ?, updated_ts = ? WHERE id = ?`, JSON.stringify(tm), Date.now(), trow.id);
                }
                this.audit("system:verifier", "verdict_deduped", id, { target, verdict, round });
                return { id, deduped: true, target, round, note: "identical verdict auto-applied \u2014 no decision card created" };
              }
            }
          }
        }
        if (type === "decision" && createMeta.decision_class === "verify-verdict") {
          bodyMd = `${verifyVerdictStatement(createMeta)}

${bodyMd.trim()}`.trim();
        }
        this.state.storage.sql.exec(
          `INSERT INTO artefacts (id, type, title, status, body_md, meta, owner, created_ts, updated_ts, tags, roles, status_ts, project, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          id,
          type,
          title,
          status,
          bodyMd,
          JSON.stringify({ ...createMeta, session }),
          owner,
          ts,
          ts,
          tags ? JSON.stringify(tags) : null,
          roles.length ? JSON.stringify(roles) : null,
          ts,
          project,
          actor
        );
        if (!bodyMd.trim() && (type === "task" || type === "goal")) {
          bodyMd = scaffoldBody(title, owner || actor);
        }
        this.audit(actor, "create", id, { type, title });
        this.version(id, actor, "create", title, { type, title, body_md: bodyMd, tags: tags ?? [], roles });
        await this.embedArtefact(id, title, bodyMd);
        if (this.env.GH_TOKEN) {
          const ref = issueRef(title);
          if (ref) {
            try {
              await this.enrichFromGitHub(id, ref);
            } catch {
            }
          }
        }
        if (type === "progress") await this.progressHeartbeat(body.meta, title, actor);
        return { id, type, status };
      }
      /** A progress artefact (meta.task → task id) doubles as a heartbeat on that task:
       *  auto-starts todo tasks, re-claims watchdog-abandoned ones, and bumps last_progress.
       *  Agents post updates as progress logs instead of calling log_progress on the task —
       *  without this, the task card never moves. */
      async progressHeartbeat(metaObj, title, actor) {
        const raw = String(metaObj?.task ?? "").trim();
        if (!raw) return;
        const candidates = [raw, raw.replace(/^#/, "BR#"), `BR#${raw.replace(/^#/, "")}`];
        const t = candidates.map((c) => this.one(`SELECT id, type, status, meta, tags, roles FROM artefacts WHERE id = ? AND type IN ('task','question')`, c)).find(Boolean);
        if (!t) return;
        const tmeta = JSON.parse(t.meta ?? "{}");
        const tTags = parseTags(t.tags);
        const tRoles = parseTags(t.roles);
        const isQualifier = tRoles.includes("analysis") || tRoles.includes("review") || tRoles.includes("unblock");
        if (t.status === "blocked" && (tmeta.blocked?.reason ?? "").startsWith("abandoned")) {
          await this.transition({ id: t.id, to: "in_progress", note: "re-claimed \u2014 progress artefact logged" }, actor);
          delete tmeta.blocked;
        } else if (t.status === "todo") {
          const q = isQualifier ? { ok: true } : this.qualifyCheck(t, "analysis");
          if (q.ok && t.type !== "question") await this.transition({ id: t.id, to: "in_progress", note: "started \u2014 progress artefact logged" }, actor);
        }
        const prevGauges = tmeta.last_progress ?? {};
        tmeta.last_progress = {
          note: title.slice(0, 200),
          sentiment: "neutral",
          actor,
          ts: Date.now(),
          session: tmeta.session,
          completion_pct: prevGauges.completion_pct,
          confidence_pct: prevGauges.confidence_pct,
          risk_pct: prevGauges.risk_pct,
          context_pct: prevGauges.context_pct
        };
        delete tmeta.grace_until;
        this.state.storage.sql.exec(
          `UPDATE artefacts SET meta = ?, updated_ts = ? WHERE id = ?`,
          JSON.stringify(tmeta),
          Date.now(),
          t.id
        );
        this.version(t.id, actor, "progress", title.slice(0, 500), { note: title.slice(0, 200) });
        this.audit(actor, "progress", t.id, { note: title.slice(0, 200), via: "progress_artefact" });
      }
      /** Human boost: priority 0 in the pickup ranking, above unblock duty.
       *  Cascades to all TRANSITIVE OPEN children (todo/blocked/in_progress) —
       *  a task cannot complete while its children are open, so the dependency
       *  set IS the children. Audited per task; boost ts orders multiple boosts. */
      async boost(body, actor) {
        const id = String(body.id ?? "");
        const on = body.boost !== false;
        const row = this.one(`SELECT id, type FROM artefacts WHERE id = ?`, id);
        if (!row) throw new Error(`no such artefact: ${id}`);
        if (row.type !== "task") throw new Error(`boost applies to tasks, not ${row.type}`);
        const boosted = [];
        const queue = [id];
        const seen = /* @__PURE__ */ new Set([id]);
        while (queue.length) {
          const tid = queue.shift();
          const t = this.one(`SELECT id, status, meta FROM artefacts WHERE id = ?`, tid);
          if (!t || t.status === "done" || t.status === "superseded") continue;
          const meta = JSON.parse(t.meta ?? "{}");
          if (on) meta.boosted = Date.now();
          else delete meta.boosted;
          this.state.storage.sql.exec(
            `UPDATE artefacts SET meta = ?, updated_ts = ? WHERE id = ?`,
            JSON.stringify(meta),
            Date.now(),
            t.id
          );
          this.audit(actor, on ? "boost" : "unboost", t.id, { root: id });
          this.version(t.id, actor, "update", on ? `boosted (priority 0, via ${id})` : `boost removed (via ${id})`, {});
          boosted.push(t.id);
          for (const c of this.state.storage.sql.exec(
            `SELECT c.id AS id FROM relations r JOIN artefacts c ON c.id = r.src_id
         WHERE r.relation = 'child_of' AND r.dst_id = ?`,
            t.id
          ).toArray()) {
            if (!seen.has(c.id)) {
              seen.add(c.id);
              queue.push(c.id);
            }
          }
        }
        return { id, boosted, on };
      }
      async get(id) {
        const row = this.one(`SELECT * FROM artefacts WHERE id = ?`, id);
        if (!row) throw new Error(`no such artefact: ${id}`);
        return this.shape(row);
      }
      async list(body) {
        const conds = [], params = [];
        if (body.type) {
          conds.push("type = ?");
          params.push(String(body.type));
        }
        if (body.status) {
          conds.push("status = ?");
          params.push(String(body.status));
        }
        if (body.tag) {
          conds.push("tags LIKE ?");
          params.push(`%"${String(body.tag).replace(/[^a-z0-9:_-]/g, "")}"%`);
        }
        const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
        const rows = this.state.storage.sql.exec(`SELECT * FROM artefacts ${where} ORDER BY updated_ts DESC LIMIT ?`, ...params, Math.min(Number(body.limit ?? 50), 200)).toArray();
        return { artefacts: rows.map((r) => this.shape(r)) };
      }
      /** Hybrid: FTS5 keyword + embedding cosine, merged. Falls back to FTS-only when AI is unavailable. */
      async search(body) {
        const rawQ = String(body.q ?? "");
        const limit = Math.min(Number(body.limit ?? 20), 100);
        const q = ftsQuery(rawQ);
        if (!q) return { artefacts: [], note: "empty query" };
        const typeFilter = body.type ? `AND a.type = '${String(body.type).replace(/[^a-z_]/g, "")}'` : "";
        const ftsRows = this.state.storage.sql.exec(
          `SELECT a.id FROM artefacts_fts f JOIN artefacts a ON a.rowid = f.rowid
         WHERE artefacts_fts MATCH ? ${typeFilter} ORDER BY rank LIMIT ?`,
          q,
          limit
        ).toArray().map((r, i) => ({ id: r.id, score: 1 / (1 + i) }));
        let vecRows = [];
        let qvec = null;
        let qdim = 0;
        try {
          if (this.env?.AI) {
            const out = await this.env.AI.run(EMBED_MODEL, { text: [embedText(rawQ, "")] });
            if (Array.isArray(out?.data?.[0])) {
              qvec = Float32Array.from(out.data[0]);
              qdim = qvec.length;
            }
          }
        } catch {
        }
        if (!qvec) {
          qvec = Float32Array.from(trigramVec(embedText(rawQ, ""), TRIGRAM_DIM));
          qdim = TRIGRAM_DIM;
        }
        {
          const rows2 = this.state.storage.sql.exec(`SELECT artefact_id, vec FROM embeddings WHERE dim = ?`, qdim).toArray();
          const scored2 = rows2.map((r) => {
            const v = new Float32Array(r.vec.buffer ?? r.vec);
            return { id: r.artefact_id, score: cosine(qvec, v) };
          }).filter((r) => r.score > 0.3);
          scored2.sort((a, b) => b.score - a.score);
          vecRows = scored2.slice(0, limit);
        }
        const merged = hybridMerge(ftsRows, vecRows, limit);
        if (merged.length === 0) return { artefacts: [], note: "no matches (keyword + semantic)" };
        const ids = merged.map((m) => m.id);
        const marks = ids.map(() => "?").join(",");
        const rows = this.state.storage.sql.exec(
          `SELECT * FROM artefacts WHERE id IN (${marks})`,
          ...ids
        ).toArray().map((r) => this.shape(r));
        const byId = new Map(rows.map((r) => [r.id, r]));
        const scored = merged.map((m) => {
          const r = byId.get(m.id);
          return r ? { ...r, _score: m.score, _via: m.via } : null;
        }).filter((r) => !!r);
        return { artefacts: scored, hybrid: { keyword: ftsRows.length, semantic: vecRows.length } };
      }
      /** "What relates to X?" — nearest artefacts by embedding. */
      async related(id, limit) {
        const row = this.one(`SELECT vec, dim FROM embeddings WHERE artefact_id = ?`, id);
        if (!row) return { artefacts: [], note: "no embedding for artefact" };
        const qvec = new Float32Array(row.vec.buffer ?? row.vec);
        const rows = this.state.storage.sql.exec(`SELECT artefact_id, vec FROM embeddings WHERE artefact_id != ? AND dim = ?`, id, row.dim).toArray();
        const scored = rows.map((r) => {
          const v = new Float32Array(r.vec.buffer ?? r.vec);
          return { id: r.artefact_id, score: cosine(qvec, v) };
        }).filter((r) => r.score > 0.3);
        scored.sort((a, b) => b.score - a.score);
        const ids = scored.slice(0, limit).map((r) => r.id);
        if (ids.length === 0) return { artefacts: [] };
        const marks = ids.map(() => "?").join(",");
        const arts = this.state.storage.sql.exec(`SELECT * FROM artefacts WHERE id IN (${marks})`, ...ids).toArray().map((r) => this.shape(r));
        const byId = new Map(arts.map((a) => [a.id, a]));
        return { artefacts: ids.map((i) => byId.get(i)).filter((a) => !!a) };
      }
      /**
       * Embed title-weighted text; store as float32 BLOB with the vector dim.
       * Two spaces: Workers AI (prod, 768d) when bound; local hashed-trigram (256d) fallback.
       * Best-effort — never fails the write.
       */
      async embedArtefact(id, title, body) {
        let vec = null;
        let dim = 0;
        try {
          if (this.env?.AI) {
            const out = await this.env.AI.run(EMBED_MODEL, { text: [embedText(title, body)] });
            if (Array.isArray(out?.data?.[0])) {
              vec = out.data[0];
              dim = vec.length;
            }
          }
        } catch {
        }
        if (!vec) {
          vec = trigramVec(embedText(title, body), TRIGRAM_DIM);
          dim = TRIGRAM_DIM;
        }
        const f32 = Float32Array.from(vec);
        this.state.storage.sql.exec(
          `INSERT INTO embeddings (artefact_id, vec, dim) VALUES (?, ?, ?)
       ON CONFLICT(artefact_id) DO UPDATE SET vec = excluded.vec, dim = excluded.dim`,
          id,
          new Uint8Array(f32.buffer),
          dim
        );
      }
      async update(body, actor) {
        const id = String(body.id ?? "");
        const row = this.one(`SELECT * FROM artefacts WHERE id = ?`, id);
        if (!row) throw new Error(`no such artefact: ${id}`);
        const preMeta = JSON.parse(row.meta ?? "{}");
        const reclaimed = row.status === "blocked" && (preMeta.blocked?.reason ?? "").startsWith("abandoned");
        if (reclaimed) {
          await this.transition({ id, to: "in_progress", note: "re-claimed \u2014 agent resumed (heartbeat)" }, actor);
        }
        const title = body.title !== void 0 ? String(body.title) : row.title;
        const bodyMd = body.body_md !== void 0 ? String(body.body_md) : row.body_md;
        const metaObj = body.meta !== void 0 ? JSON.parse(JSON.stringify(body.meta)) : JSON.parse(row.meta ?? "{}");
        if (reclaimed) delete metaObj.blocked;
        const meta = JSON.stringify(metaObj);
        if (row.type === "progress") await this.progressHeartbeat(metaObj, title, actor);
        const tags = body.tags !== void 0 ? sanitizeTags(body.tags) : row.tags;
        let roles = parseTags(row.roles);
        if (body.roles !== void 0) {
          const rolesIn = parseRolesInput(body.roles);
          if (rolesIn.ok === false) throw new Error(rolesIn.error);
          roles = rolesIn.roles;
        }
        const limitErr = checkLimits(title, bodyMd, JSON.parse(meta));
        if (limitErr) throw new Error(limitErr);
        this.state.storage.sql.exec(
          `UPDATE artefacts SET title = ?, body_md = ?, meta = ?, tags = ?, roles = ?, updated_ts = ? WHERE id = ?`,
          title,
          bodyMd,
          meta,
          tags ? JSON.stringify(tags) : null,
          roles && roles.length ? JSON.stringify(roles) : null,
          Date.now(),
          id
        );
        this.audit(actor, "update", id, {});
        const changed = [
          body.title !== void 0 && "title",
          body.body_md !== void 0 && "body",
          body.meta !== void 0 && "meta",
          body.tags !== void 0 && "tags",
          body.roles !== void 0 && "roles"
        ].filter(Boolean);
        this.version(id, actor, "update", `updated ${changed.join(", ") || "fields"}`, { title, body_md: bodyMd });
        await this.embedArtefact(id, title, bodyMd);
        return { id };
      }
      /** Pure evidence for a qualification kind: a done analysis/review child, or an accepted
       *  decision linked either way. Declarations (meta.qualified / meta.qualification) don't count. */
      hasEvidence(row, kind) {
        const roleFilter = kind === "analysis" ? `(c.roles LIKE '%"analysis"%' OR c.roles LIKE '%"review"%')` : `c.roles LIKE '%"review"%'`;
        const child = this.one(
          `SELECT c.id AS id FROM relations r JOIN artefacts c ON c.id = r.src_id
       WHERE r.relation = 'child_of' AND r.dst_id = ? AND c.status = 'done' AND ${roleFilter} LIMIT 1`,
          row.id
        );
        if (child) return { ok: true, via: child.id };
        const dec = this.one(
          `SELECT d.id AS id FROM relations r JOIN artefacts d ON d.id = r.src_id
       WHERE r.relation = 'supports' AND r.dst_id = ? AND d.type = 'decision' AND d.status = 'accepted' LIMIT 1`,
          row.id
        );
        if (dec) return { ok: true, via: dec.id };
        return { ok: false };
      }
      /** Swimlane qualification: declared (self-analyzed at intake / preset), pure evidence,
       *  or inherited from the parent's decomposition (the pass that qualified the parent
       *  covered its children). */
      qualifyCheck(row, kind) {
        const meta = JSON.parse(row.meta ?? "{}");
        const q = meta.qualification ?? {};
        if (kind === "analysis" && (meta.qualified === true || q.state === "qualified")) return { ok: true, via: "declared" };
        const ev = this.hasEvidence(row, kind);
        if (ev.ok) return ev;
        const parent = this.one(
          `SELECT p.id AS id, p.meta AS meta FROM relations r JOIN artefacts p ON p.id = r.dst_id
       WHERE r.relation = 'child_of' AND r.src_id = ? LIMIT 1`,
          row.id
        );
        if (parent) {
          const pm = JSON.parse(parent.meta ?? "{}");
          if (kind === "analysis" && (pm.qualified === true || (pm.qualification ?? {}).state === "qualified"))
            return { ok: true, via: `parent:${parent.id}` };
          const sib = this.one(
            `SELECT c.id AS id FROM relations r JOIN artefacts c ON c.id = r.src_id
         WHERE r.relation = 'child_of' AND r.dst_id = ? AND c.status = 'done' AND ${kind === "analysis" ? `(c.roles LIKE '%"analysis"%' OR c.roles LIKE '%"review"%')` : `c.roles LIKE '%"review"%'`} LIMIT 1`,
            parent.id
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
      enforceableBars(bars) {
        return bars.filter((b) => !/^(?:role:)?(analysis|review|impl|unblock)$/.test(String(b)));
      }
      unmetBars(row) {
        const meta = JSON.parse(row.meta ?? "{}");
        const bars = (meta.qualification ?? {}).bars ?? [];
        return this.enforceableBars(bars).filter((b) => !this.hasEvidence(row, /review/.test(b) ? "review" : "analysis").ok);
      }
      /** Bulk evidence for readiness projections: done role-tagged children per parent +
       *  accepted decisions per task. Review evidence also satisfies the analysis kind. */
      qualificationEvidence() {
        const analysisEv = /* @__PURE__ */ new Set(), reviewEv = /* @__PURE__ */ new Set();
        for (const k of this.state.storage.sql.exec(
          `SELECT r.dst_id AS pid, c.roles AS roles FROM relations r JOIN artefacts c ON c.id = r.src_id
       WHERE r.relation = 'child_of' AND c.status = 'done'`
        ).toArray()) {
          const roles = parseTags(k.roles);
          if (roles.includes("review")) {
            reviewEv.add(k.pid);
            analysisEv.add(k.pid);
          } else if (roles.includes("analysis")) analysisEv.add(k.pid);
        }
        for (const d of this.state.storage.sql.exec(
          `SELECT r.dst_id AS tid FROM relations r JOIN artefacts d ON d.id = r.src_id
       WHERE r.relation = 'supports' AND d.type = 'decision' AND d.status = 'accepted'`
        ).toArray()) {
          analysisEv.add(d.tid);
          reviewEv.add(d.tid);
        }
        return { analysisEv, reviewEv };
      }
      /** Agent roles for an actor label (empty for humans "web" and system actors). */
      actorTagsFor(label) {
        if (!label || /^(web|system:)/.test(label)) return [];
        const row = this.one(`SELECT tags FROM auth_tokens WHERE label = ?`, label);
        try {
          return parseTags(row?.tags);
        } catch {
          return [];
        }
      }
      /** Every rejected transition is audited (transition_rejected: actor, from, to,
       *  reason) — gaming the gates is visible in the Log and costs behaviour score.
       *  The rejection then goes through the breach door: storms raise ONE card. */
      async transition(body, actor) {
        try {
          return await this.doTransition(body, actor);
        } catch (e) {
          const id = String(body?.id ?? "");
          const to = String(body?.to ?? "");
          if (id) {
            const cur = this.one(`SELECT status FROM artefacts WHERE id = ?`, id);
            this.audit(actor, "transition_rejected", id, {
              from: cur?.status,
              to,
              reason: String(e?.message ?? e).slice(0, 300)
            });
            try {
              await this.foldBreaches(id);
            } catch {
            }
          }
          throw e;
        }
      }
      /** Lazy SQL-backed context for the machine rules — a guard only queries
       *  what it actually reads, so cheap transitions stay cheap. */
      ruleCtx(row, body, id, tTags) {
        return {
          qualify: /* @__PURE__ */ __name((kind) => {
            const unmet = this.unmetBars(row);
            return unmet.length === 0 ? { ok: true, via: "no-bars" } : { ok: false };
          }, "qualify"),
          unmetBars: /* @__PURE__ */ __name(() => this.unmetBars(row), "unmetBars"),
          session: /* @__PURE__ */ __name(() => this.resolveSession(body, String(body?.token_id ?? "")), "session"),
          evidence: /* @__PURE__ */ __name((eid) => this.one(`SELECT type, tags, roles, meta FROM artefacts WHERE id = ?`, eid), "evidence"),
          parent: /* @__PURE__ */ __name(() => this.one(
            `SELECT p.id AS id, p.status AS status, p.meta AS meta FROM relations r JOIN artefacts p ON p.id = r.dst_id
           WHERE r.relation = 'child_of' AND r.src_id = ? LIMIT 1`,
            id
          ), "parent"),
          openChildren: /* @__PURE__ */ __name(() => this.one(
            `SELECT COUNT(*) AS n FROM relations r JOIN artefacts c ON c.id = r.src_id
           WHERE r.relation = 'child_of' AND r.dst_id = ? AND c.status NOT IN ('done', 'superseded')`,
            id
          )?.n ?? 0, "openChildren"),
          // verify-of-verify / nesting-cap guard: the spawn-blocker reason or null
          spawnGuard: /* @__PURE__ */ __name(() => {
            let cursor = id, depth = 0;
            while (depth < 10) {
              const p = this.one(
                `SELECT p.id AS id, p.roles AS roles FROM relations r JOIN artefacts p ON p.id = r.dst_id
             WHERE r.relation = 'child_of' AND r.src_id = ? LIMIT 1`,
                cursor
              );
              if (!p) return null;
              depth++;
              if (parseTags(p.roles).includes("review")) return `ancestor ${p.id} is a review task \u2014 verify-of-verify is blocked`;
              if (depth >= 3) return `nesting depth ${depth} would exceed the child_of cap of 3`;
              cursor = p.id;
            }
            return null;
          }, "spawnGuard"),
          // newest OPEN verify round (reuse candidate) — a re-handoff re-enters the
          // same round instead of stacking a fresh card per bounce cycle
          openVerifyChild: /* @__PURE__ */ __name(() => this.one(
            `SELECT c.id AS id FROM relations r JOIN artefacts c ON c.id = r.src_id
           WHERE r.relation = 'child_of' AND r.dst_id = ? AND c.status IN ('todo','in_progress','blocked')
             AND c.roles LIKE '%"review"%' ORDER BY c.updated_ts DESC LIMIT 1`,
            id
          ), "openVerifyChild"),
          // at most ONE live unblock child per parent, ever (cap ≤1 open)
          openUnblockChild: /* @__PURE__ */ __name(() => this.one(
            `SELECT c.id AS id FROM relations r JOIN artefacts c ON c.id = r.src_id
           WHERE r.relation = 'child_of' AND r.dst_id = ? AND c.status IN ('todo','in_progress','blocked')
             AND c.roles LIKE '%"unblock"%' ORDER BY c.updated_ts DESC LIMIT 1`,
            id
          ), "openUnblockChild"),
          // recent version-log rows (newest first) for the server-side silent-churn fold
          recentEvents: /* @__PURE__ */ __name(() => this.state.storage.sql.exec(
            `SELECT ts, actor, action, summary FROM artefact_versions WHERE artefact_id = ? ORDER BY seq DESC LIMIT 50`,
            id
          ).toArray().map((r) => ({ ts: Number(r.ts), actor: String(r.actor), action: String(r.action), summary: String(r.summary ?? "") })), "recentEvents")
        };
      }
      async doTransition(body, actor) {
        const id = String(body.id ?? "");
        const to = String(body.to ?? "");
        const row = this.one(`SELECT * FROM artefacts WHERE id = ?`, id);
        if (!row) throw new Error(`no such artefact: ${id}`);
        const tTags = parseTags(row.tags);
        const tRoles = parseTags(row.roles);
        const ts0 = Date.now();
        const verdict = await decide(
          { id, type: row.type, status: row.status, to, roles: tRoles, tags: tTags, meta: JSON.parse(row.meta ?? "{}"), actor, body, owner: row.owner, now: ts0 },
          this.ruleCtx(row, body, id, tTags)
        );
        if (verdict.ok === false) throw new Error(`${verdict.message} [rule: ${verdict.rule}]`);
        const isSubprocess = body.class === "subprocess";
        const sentiment = isSentiment(body.sentiment) ? body.sentiment : void 0;
        const ts = ts0;
        const meta = JSON.parse(row.meta ?? "{}");
        if (isSubprocess && row.type === "task" && row.status === "in_progress") {
          const bm = Math.max(1, Math.min(1440, Number(body.budget_minutes) || 0));
          if (!bm) throw new Error("class: subprocess requires budget_minutes (1-1440) \u2014 a declared window without a deadline never trips, which is worse than abandonment");
          meta.subprocess = { reason: String(body.note ?? body.reason ?? "").trim(), budget_minutes: bm, deadline_ts: ts + bm * 6e4, ts };
          this.state.storage.sql.exec(
            `UPDATE artefacts SET meta = ?, updated_ts = ?, status_ts = ? WHERE id = ?`,
            JSON.stringify(meta),
            ts,
            ts,
            id
          );
          this.audit(actor, "transition", id, { from: row.status, to: "in_progress (subprocess)", note: String(body.note ?? ""), class: "subprocess", budget_minutes: bm });
          this.version(id, actor, "transition", `subprocess declared \u2014 watchdog paused until +${bm}m \u2014 ${String(body.note ?? "").slice(0, 120)}`, { from: row.status, to: "in_progress", class: "subprocess" });
          return { id, status: "in_progress", subprocess: true };
        }
        for (const [k, v] of Object.entries(verdict.meta_patch)) {
          if (v === void 0) delete meta[k];
          else meta[k] = v;
        }
        if (verdict.status === "blocked") {
          if (!meta.blocked)
            meta.blocked = { reason: String(body.note ?? body.reason ?? "").trim(), unblock_condition: String(body.unblock_condition ?? "").trim(), ts };
          delete meta.subprocess;
        } else if (meta.blocked) {
          delete meta.blocked;
        }
        let owner = row.owner;
        const bounceFromReview = row.status === "in_review";
        const attributedAgent = body.gateway && String(body.agent ?? "").trim() ? String(body.agent).trim().slice(0, 60) : void 0;
        if (row.type === "task" && verdict.status === "in_progress" && !bounceFromReview && !/^system:/.test(actor) && owner !== actor) {
          owner = attributedAgent ?? actor;
        }
        const actingPrincipal = typeof body.token_id === "string" && body.token_id ? this.one(`SELECT principal FROM auth_tokens WHERE id = ?`, body.token_id)?.principal : null;
        if (row.type === "task" && to === "in_progress" && !bounceFromReview && !/^system:/.test(actor) && actingPrincipal) {
          owner = actingPrincipal;
        }
        if (attributedAgent && attributedAgent !== actor && this.isGatewayActor(actor)) {
          this.gatewayTouch(actor, attributedAgent);
        }
        if (row.type === "task" && !meta.session) {
          const sess = await this.resolveSession(body, String(body.token_id ?? ""));
          if (sess) meta.session = String(sess).slice(0, 120);
        }
        if (row.type === "task" && verdict.status === "done" && tRoles.includes("analysis")) {
          const parent = this.one(
            `SELECT p.id AS id, p.status AS status, p.owner AS owner, p.meta AS meta FROM relations r JOIN artefacts p ON p.id = r.dst_id
         WHERE r.relation = 'child_of' AND r.src_id = ? LIMIT 1`,
            id
          );
          const implSession = parent ? JSON.parse(parent.meta ?? "{}").session : void 0;
          const analysisSession = JSON.parse(row.meta ?? "{}").session;
          if (parent?.status === "in_progress" && implSession && analysisSession && implSession === analysisSession) {
            await this.transition(
              { id: parent.id, to: "todo", note: `analysis complete (${id}) \u2014 released for fresh-claim implementation` },
              "system:separation"
            );
          }
        }
        this.state.storage.sql.exec(
          `UPDATE artefacts SET status = ?, status_ts = ?, meta = ?, updated_ts = ?, owner = ?, tags = ? WHERE id = ?`,
          verdict.status,
          ts,
          JSON.stringify(meta),
          ts,
          verdict.owner_clear ? "" : owner,
          JSON.stringify(tagsForWrite(verdict, tTags)),
          id
        );
        const violations = invariants({ type: row.type, status: verdict.status, roles: tRoles, tags: tTags, meta });
        if (violations.length) {
          this.audit("system:invariants", "invariant_violation", id, { violations, from: row.status, to: verdict.status });
          this.version(id, "system:invariants", "note", `INVARIANT VIOLATION after ${row.status} \u2192 ${verdict.status}: ${violations.join("; ")}`, { violations });
          try {
            await this.foldBreaches(id);
          } catch {
          }
        }
        if (verdict.status === "superseded" && body.replacement_id) {
          const rep = this.one(`SELECT id, type FROM artefacts WHERE id = ?`, String(body.replacement_id));
          if (rep && rep.type === row.type)
            this.state.storage.sql.exec(
              `INSERT OR IGNORE INTO relations (src_id, relation, dst_id, created_ts) VALUES (?, 'supersedes', ?, ?)`,
              String(body.replacement_id),
              id,
              ts
            );
        }
        this.audit(actor, "transition", id, {
          from: row.status,
          to: verdict.status,
          note: body.note ?? "",
          sentiment,
          ...attributedAgent ? { agent: attributedAgent } : {}
        });
        this.version(id, actor, "transition", `${row.status} \u2192 ${verdict.status}${body.note ? ` \u2014 ${String(body.note).slice(0, 120)}` : ""}`, { from: row.status, to: verdict.status, note: body.note ?? "" });
        if (row.type === "decision" && verdict.status === "accepted") {
          const dm = meta ?? {};
          if (dm.decision_class === "verify-verdict") {
            const target = String(dm.task ?? dm.verify_target ?? "").trim();
            const isBounce = String(dm.verdict ?? "").toLowerCase() === "bounce";
            if (target) {
              const cur = this.one(`SELECT status FROM artefacts WHERE id = ?`, target);
              const already = cur && (isBounce ? cur.status === "in_progress" : cur.status === "done");
              if (already) {
                this.audit(actor, "verdict_already_applied", target, { decision: id, status: cur.status });
              } else try {
                await this.transition(
                  {
                    id: target,
                    to: isBounce ? "in_progress" : "done",
                    note: isBounce ? `verdict ${id} rejected by human \u2014 bounce with the verifier's findings` : `verdict ${id} accepted by human \u2014 closed on a verified (non-void) verdict`
                  },
                  actor
                );
                this.audit(actor, "verdict_applied", target, { decision: id, effect: isBounce ? "bounced" : "closed" });
              } catch (e) {
                const msg = String(e.message ?? e).slice(0, 300);
                this.audit("decision:verdict", "apply_failed", target, { decision: id, error: msg });
                this.version(id, "decision:verdict", "note", `verdict apply failed on ${target}: ${msg}`, { target, error: msg });
              }
            }
          }
        }
        let verifyTaskId;
        for (const fx of verdict.effects) {
          switch (fx.kind) {
            case "spawn_verify": {
              const rootTitle = row.title.replace(/^(?:Verify:\s*)+/, "");
              const created = await this.create(
                {
                  type: "task",
                  title: `Verify: ${rootTitle.slice(0, 200)}`,
                  body_md: `Verification duty for ${id} \u2014 "${rootTitle}".

YOU ARE THE MERGE AUTHORITY \u2014 substance review AND the merge click are both yours (standing order BR#3033: base green + checks green + verified signatures + mergeable \u2192 merge, no human gate).

VERIFY GATE \u2014 mergeability is a precondition, NOT a finding (2026-10-23 unsigned-PR incident):
1. FIRST, before any substance check: gh pr view <N> --json mergeable,mergeStateStatus,reviewDecision and confirm every commit signature isValid=true. If mergeable=false / CONFLICTING / any unsigned commit: STOP \u2014 zero substance checks, NO ask to the human.
2. Bounce to impl: transition ${id} in_progress with the mechanical defect ("PR #N unmergeable \u2014 unsigned commits | conflicts | failing check X. Re-sign/rebase/resolve and re-push.").
3. Broken signing environment (key unavailable / NO_USER): file ONE ask for the whole class, never per PR.
4. "Sole unmet leg = human merge gate" is only valid for a MERGEABLE, checks-green, substance-verified PR. "Accept the unsigned commit" is never an option.

Then double-check, don't reimplement: confirm the receipts (PR: ${fx.pr ?? "see note"}, merge state, findings) and that the work matches the task.

MERGE: when substance AND mergeability both hold, YOU merge the PR (gh pr merge <N> \u2014 merge-commit, the repo convention) citing the merge sha. Done-with-receipts = merged + reviewed + merge sha in the note. Problems found \u2192 bounce the parent back to impl with findings (in_review \u2192 in_progress, one round, N bounces \u2014 impl fixes and re-enters the SAME round). The loop runs until YOU merge and close.`,
                  roles: ["review"]
                },
                actor
              );
              verifyTaskId = created.id;
              this.state.storage.sql.exec(
                `INSERT OR IGNORE INTO relations (src_id, relation, dst_id, created_ts) VALUES (?, 'child_of', ?, ?)`,
                created.id,
                id,
                ts
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
              try {
                await this.foldBreaches(id);
              } catch {
              }
              break;
            }
            case "spawn_unblock": {
              const rootTitle = row.title.replace(/^(?:Unblock:\s*)+/, "");
              const created = await this.create(
                {
                  type: "task",
                  title: `Unblock: ${rootTitle.slice(0, 200)}`,
                  body_md: `Unblock duty for ${id} \u2014 "${rootTitle}".

Blocked why: ${fx.reason || "see parent"}.
Exit condition: ${fx.exit_condition || "none recorded \u2014 read the card and history, then decide: clear the block, re-scope the task, or escalate via ask_agent"}.

Contract: check whether the exit condition now holds (live receipts, GitHub state, answered decision). If it holds: transition ${id} to in_progress with the resolution note, then close yourself done citing what unblocked it. If it does not: record findings via log_progress and close yourself done with the findings \u2014 do NOT respawn an unblock task, do not leave yourself open.`,
                  roles: ["unblock"]
                },
                actor
              );
              this.state.storage.sql.exec(
                `INSERT OR IGNORE INTO relations (src_id, relation, dst_id, created_ts) VALUES (?, 'child_of', ?, ?)`,
                created.id,
                id,
                ts
              );
              this.audit(actor, "create", created.id, { type: "task", auto: "unblock", parent: id });
              meta.last_unblock_spawn = { at: ts, exit: fx.exit_condition };
              this.state.storage.sql.exec(`UPDATE artefacts SET meta = ? WHERE id = ?`, JSON.stringify(meta), id);
              break;
            }
            case "skip_unblock_spawn": {
              this.audit(actor, "spawn_skipped", id, { auto: "unblock", reason: fx.reason });
              try {
                await this.foldBreaches(id);
              } catch {
              }
              break;
            }
            case "supersede_children": {
              const kids = this.state.storage.sql.exec(
                `SELECT c.id AS id, c.status AS status, c.meta AS meta, c.updated_ts AS uts FROM relations r JOIN artefacts c ON c.id = r.src_id
             WHERE r.relation = 'child_of' AND r.dst_id = ? AND c.status IN ('todo','in_progress','blocked') AND c.roles LIKE ? ORDER BY c.updated_ts DESC`,
                id,
                `%"${fx.tag}"%`
              ).toArray();
              kids.forEach((v, i) => {
                if (fx.keep_newest && i === 0) return;
                const vm = JSON.parse(v.meta ?? "{}");
                vm.superseded_reason = fx.cause;
                this.state.storage.sql.exec(
                  `UPDATE artefacts SET status = 'superseded', meta = ?, status_ts = ?, updated_ts = ? WHERE id = ?`,
                  JSON.stringify(vm),
                  ts,
                  ts,
                  v.id
                );
                this.audit("system:separation", "transition", v.id, { from: v.status, to: "superseded", note: fx.cause });
                this.version(v.id, "system:separation", "transition", fx.cause, { from: v.status, to: "superseded" });
              });
              break;
            }
            case "escalate": {
              this.audit("system:churn-guard", "escalated", id, { attempts: fx.attempts, silent_cycles: fx.silent_cycles, duty: tRoles[0] ?? "unknown" });
              this.version(id, "system:churn-guard", "transition", `escalated to human \u2014 verdict duties cannot block (attempts ${fx.attempts}, silent cycles ${fx.silent_cycles})`, { from: row.status, to: verdict.status });
              break;
            }
            case "release_redirect": {
              this.audit("system:churn-guard", "release_redirected", id, { attempts: fx.attempts, silent_cycles: fx.silent_cycles, from: row.status });
              this.version(id, "system:churn-guard", "transition", `release redirected to blocked \u2014 ${fx.attempts} attempts without completion`, { from: row.status, to: "blocked" });
              break;
            }
          }
        }
        try {
          await this.replayCheck(id);
        } catch {
        }
        return { id, status: verdict.status, ...sentiment ? { sentiment } : {}, verify_task: verifyTaskId };
      }
      async link(body, actor) {
        const srcId = String(body.src ?? ""), rel = String(body.relation ?? ""), dstId = String(body.dst ?? "");
        if (!isRelation(rel)) throw new Error(`unknown relation '${rel}'`);
        const src = this.one(`SELECT id, type, tags, roles FROM artefacts WHERE id = ?`, srcId);
        const dst = this.one(`SELECT id, type, tags, roles FROM artefacts WHERE id = ?`, dstId);
        if (!src || !dst) throw new Error("both src and dst must exist");
        const verdict = validateRelation(rel, src.type, dst.type);
        if (verdict.ok === false) throw new Error(verdict.reason);
        if (rel === "child_of") {
          const childRoles = parseTags(src.roles);
          const parentRoles = parseTags(dst.roles);
          if (childRoles.includes("review") && (parentRoles.includes("review") || parentRoles.includes("unblock")))
            throw new Error(`link rejected: ${srcId} is a verify task \u2014 verify tasks are terminal-at-birth and cannot nest under ${parentRoles.includes("review") ? "another verify" : "an unblock"} task`);
          if (childRoles.includes("unblock") && (parentRoles.includes("unblock") || parentRoles.includes("review")))
            throw new Error(`link rejected: ${srcId} is an unblock task \u2014 unblock tasks are terminal-at-birth and cannot nest under another ephemeral task`);
        }
        if (rel === "child_of") {
          let cursor = dstId, depth = 0, hit;
          while (depth < 10) {
            const p = this.one(
              `SELECT p.id AS id FROM relations r JOIN artefacts p ON p.id = r.dst_id
           WHERE r.relation = 'child_of' AND r.src_id = ? LIMIT 1`,
              cursor
            );
            if (!p) break;
            depth++;
            if (depth >= 3) {
              hit = `${dstId} is already 3 levels deep in a child_of chain \u2014 nesting is capped at 3 to keep the task graph flat`;
              break;
            }
            cursor = p.id;
          }
          if (hit) throw new Error(`link rejected: ${hit}`);
        }
        const count = this.one(
          `SELECT COUNT(*) AS n FROM relations WHERE src_id = ?`,
          srcId
        );
        if (Number(count.n) >= LIMITS.relationsPerArtefact)
          throw new Error(`artefact ${srcId} already has ${LIMITS.relationsPerArtefact} relations`);
        this.state.storage.sql.exec(
          `INSERT OR IGNORE INTO relations (src_id, relation, dst_id, created_ts) VALUES (?, ?, ?, ?)`,
          srcId,
          rel,
          dstId,
          Date.now()
        );
        this.audit(actor, "link", srcId, { relation: rel, dst: dstId });
        return { src: srcId, relation: rel, dst: dstId };
      }
      async relations(id) {
        const out = this.state.storage.sql.exec(
          `SELECT relation, dst_id AS artefact_id, 'out' AS dir FROM relations WHERE src_id = ?
       UNION ALL
       SELECT relation, src_id AS artefact_id, 'in' AS dir FROM relations WHERE dst_id = ?`,
          id,
          id
        ).toArray();
        return { id, relations: out };
      }
      /** Task-done throughput (BR#2937): done transitions per bucket + cumulative,
       *  aggregated from ledger mutation rows (true transition events — immune to
       *  later status flips) with a status_ts fallback for rows whose history has
       *  compacted. Read-only; no audit (reads don't ledger). */
      async metricsThroughput(sp) {
        const parsed = parseThroughputParams(sp.get("bucket"), sp.get("range"));
        if ("error" in parsed) throw new Error(parsed.error);
        const now = Date.now();
        const from = now - parsed.rangeDays * 864e5;
        const taskIds = new Set(
          this.state.storage.sql.exec(`SELECT id FROM artefacts WHERE type = 'task'`).toArray().map((r) => String(r.id))
        );
        const events = [];
        for (const r of this.state.storage.sql.exec(
          `SELECT ts, artefact_id, data FROM ledger
       WHERE kind = 'mutation' AND action = 'transition' AND ts >= ? AND data LIKE '%"to":"done"%'`,
          from
        ).toArray()) {
          let to = "";
          try {
            to = String(JSON.parse(r.data ?? "{}").to ?? "");
          } catch {
            continue;
          }
          if (to !== "done" || !taskIds.has(String(r.artefact_id))) continue;
          events.push({ ts: Number(r.ts), artefact_id: String(r.artefact_id) });
        }
        const fallback = this.state.storage.sql.exec(
          `SELECT id, status_ts FROM artefacts WHERE type = 'task' AND status = 'done' AND status_ts >= ?`,
          from
        ).toArray().map((r) => ({ id: String(r.id), status_ts: Number(r.status_ts) }));
        const buckets = aggregateThroughput(events, fallback, { bucket: parsed.bucket, rangeDays: parsed.rangeDays, now });
        return {
          bucket: parsed.bucket,
          range_days: parsed.rangeDays,
          from_ts: buckets[0]?.t ?? from,
          to_ts: now,
          total: buckets.reduce((n, b) => n + b.n, 0),
          buckets
        };
      }
      async stats() {
        const byType = this.state.storage.sql.exec(
          `SELECT type, status, COUNT(*) AS n FROM artefacts GROUP BY type, status ORDER BY type`
        ).toArray();
        const tick = this.one(`SELECT value FROM settings WHERE key = 'watchdog.last_tick'`);
        const sweep = this.one(`SELECT value FROM settings WHERE key = 'watchdog.sweep'`);
        const openAsks = this.one(`SELECT COUNT(*) AS n FROM asks WHERE status = 'open'`)?.n ?? 0;
        let watchdog;
        try {
          const recent = this.state.storage.sql.exec(
            `SELECT op, ts FROM events WHERE artefact_id = 'watchdog' ORDER BY seq DESC LIMIT 3`
          ).toArray();
          watchdog = {
            last_tick: tick ? Number(tick.value) : 0,
            next_alarm_ts: await this.state.storage.getAlarm(),
            recent_events: recent.map((e) => ({ op: e.op, age_min: Math.round((Date.now() - Number(e.ts)) / 6e4) })),
            open_asks: openAsks,
            ...sweep ? JSON.parse(sweep.value) : {}
          };
        } catch {
        }
        return { counts: byType, watchdog };
      }
      /**
       * Fine-grained progress from a working agent: note + sentiment, shown live on the board.
       * Optional self-reported gauge fields: completion_pct, confidence_pct, risk_pct, context_pct (0–100).
       * completion = how far along; confidence = belief the result is right; risk = chance of
       * failure/drift. Correlated, not the same — charted as separate series.
       */
      async progressLog(body, actor) {
        const id = String(body.id ?? "");
        const note = String(body.note ?? body.did ?? "").trim().slice(0, 500);
        const will = String(body.will ?? "").trim().slice(0, 500);
        const sentiment = isSentiment(body.sentiment) ? body.sentiment : "neutral";
        const pct = /* @__PURE__ */ __name((v) => Number.isFinite(v) ? Math.max(0, Math.min(100, Math.round(v))) : void 0, "pct");
        const completion_pct = pct(body.completion_pct);
        const confidence_pct = pct(body.confidence_pct);
        const risk_pct = pct(body.risk_pct);
        const context_pct = pct(body.context_pct);
        const row = this.one(`SELECT id, status, meta, tags FROM artefacts WHERE id = ?`, id);
        if (!row) throw new Error(`no such artefact: ${id}`);
        const meta = JSON.parse(row.meta ?? "{}");
        const m = this.settingsMap();
        const myScore = this.agentScores().find((a) => a.label === actor);
        const scoreLine = myScore ? `

Your behaviour score: ${myScore.score}/100 (${myScore.grade}).` + (myScore.hints.length ? ` ${myScore.hints.join(" ")}` : "") : "";
        const instructions = composeBootstrap(m.project_name || "Superpositional", m.board ?? DEFAULT_BOARD) + (m.bootstrap_md ? `
${m.bootstrap_md}` : "") + scoreLine;
        const isSubprocessBlock = meta.blocked?.class === "subprocess";
        const attributedAgent = body.gateway && String(body.agent ?? "").trim() ? String(body.agent).trim().slice(0, 60) : void 0;
        if (row.status === "blocked" && ((meta.blocked?.reason ?? "").startsWith("abandoned") || isSubprocessBlock)) {
          await this.transition({ id, to: "in_progress", note: isSubprocessBlock ? "re-claimed \u2014 subprocess resolved" : "re-claimed \u2014 agent resumed (heartbeat)", gateway: body.gateway, agent: body.agent }, actor);
          delete meta.blocked;
        } else if (row.status === "todo") {
          const tRoles = parseTags(row.roles);
          if (row.type === "question") {
            return {
              id,
              note,
              will: will || void 0,
              sentiment,
              completion_pct,
              confidence_pct,
              risk_pct,
              context_pct,
              instructions,
              note_postscript: "contribution logged on a question \u2014 questions are answered, not claimed. The author weighs contributions and closes it with an ADR (decision artefact, derived_from this task)."
            };
          }
          const isQualifier = tRoles.includes("analysis") || tRoles.includes("review") || tRoles.includes("unblock");
          const q = isQualifier ? { ok: true } : this.qualifyCheck(row, "analysis");
          if (!q.ok) {
            return {
              id,
              note,
              will: will || void 0,
              sentiment,
              completion_pct,
              confidence_pct,
              risk_pct,
              context_pct,
              instructions,
              note_postscript: `PROGRESS LOGGED BUT TASK NOT CLAIMED \u2014 ${id} is unclaimed todo and not qualified for you (label ${actor}). transition {to: "in_progress"} will be rejected until it is qualified: complete an analysis child task, link an accepted decision, or pick qualified work. Analysis/review-role agents may claim unqualified work.`
            };
          }
          await this.transition({ id, to: "in_progress", note: "started \u2014 progress logged", gateway: body.gateway, agent: body.agent }, actor);
        }
        const gm = Math.max(0, Math.min(60, Number(body.grace_minutes) || 0));
        let graceUntil;
        if (gm > 0) {
          if (!will) throw new Error("grace_minutes requires a will \u2014 declare what you will be doing during the silence (e.g. 're-index runs, silence ~25m')");
          graceUntil = Date.now() + gm * 6e4;
          meta.grace_until = graceUntil;
        } else {
          delete meta.grace_until;
          delete meta.subprocess;
        }
        const session = await this.resolveSession(body, String(body.token_id ?? ""));
        const progressActor = body.gateway && String(body.agent ?? "").trim() ? String(body.agent).trim().slice(0, 60) : actor;
        if (progressActor !== actor && this.isGatewayActor(actor)) {
          this.gatewayTouch(actor, progressActor);
        }
        const prev = meta.last_progress ?? {};
        meta.last_progress = {
          note,
          will: will || void 0,
          sentiment,
          actor: progressActor,
          ts: Date.now(),
          session: session ?? meta.session,
          completion_pct: completion_pct ?? prev.completion_pct,
          confidence_pct: confidence_pct ?? prev.confidence_pct,
          risk_pct: risk_pct ?? prev.risk_pct,
          context_pct: context_pct ?? prev.context_pct
        };
        if (session && !meta.session) meta.session = session;
        this.state.storage.sql.exec(
          `UPDATE artefacts SET meta = ?, updated_ts = ? WHERE id = ?`,
          JSON.stringify(meta),
          Date.now(),
          id
        );
        this.audit(actor, "progress", id, { note, sentiment, will: will || void 0 });
        this.version(id, actor, "progress", note, { note, will: will || void 0, sentiment, completion_pct, confidence_pct, risk_pct, context_pct });
        return {
          id,
          note,
          will: will || void 0,
          sentiment,
          completion_pct,
          confidence_pct,
          risk_pct,
          context_pct,
          grace_until: graceUntil,
          instructions
        };
      }
      // ---------- the breach door: one fold, one open card per (task, class) ----------
      /** The single breach door (BR#2419 item 6): fold recent audit events for a
       *  task into breach cards. One OPEN card per (task, class) key —
       *  reoccurrences coalesce onto the open card, never spawn duplicates.
       *  Call sites: every transition_rejected, invariant_violation,
       *  spawn_skipped and replay_mismatch lands here through the fold. */
      async foldBreaches(taskId) {
        const since = Date.now() - BREACH_WINDOW_MS * 8;
        const rows = this.state.storage.sql.exec(
          `SELECT ts, op, detail FROM events WHERE artefact_id = ? AND ts > ?
        AND op IN ('transition_rejected','invariant_violation','spawn_skipped','replay_mismatch')
        ORDER BY seq ASC LIMIT 200`,
          taskId,
          since
        ).toArray();
        if (!rows.length) return;
        const openKeys = /* @__PURE__ */ new Set();
        for (const b of this.state.storage.sql.exec(
          `SELECT meta FROM artefacts WHERE type = 'task' AND status NOT IN ('done','superseded') AND meta LIKE ?`,
          `%"breach_key":"${taskId}|%`
        ).toArray()) {
          let m = {};
          try {
            m = JSON.parse(b.meta ?? "{}");
          } catch {
          }
          if (typeof m?.breach_key === "string") openKeys.add(m.breach_key);
        }
        const breaches = detectBreaches(
          rows.map((r) => {
            let d = {};
            try {
              d = JSON.parse(r.detail ?? "{}");
            } catch {
            }
            const reason = String(d?.reason ?? (Array.isArray(d?.violations) ? d.violations[0] : "") ?? "unknown");
            return { ts: Number(r.ts), task: taskId, op: String(r.op), reason };
          }),
          openKeys
        );
        for (const b of breaches) {
          const created = await this.create(
            {
              type: "task",
              title: `Breach: ${b.klass} on ${taskId} \u2014 ${b.count} event${b.count === 1 ? "" : "s"}`,
              body_md: `Structural breach detected server-side (fold over the audit stream).

- class: ${b.klass}
- task: ${taskId}
- events: ${b.count} in the window (first ${new Date(b.first_ts).toISOString()}, last ${new Date(b.last_ts).toISOString()})
- sample: ${b.sample}

One open card per (task, class) \u2014 reoccurrences coalesce here instead of spawning duplicates. Investigate the cause (get_history on ${taskId}, the Log), fix the loop, then close this card with what you found.`,
              tags: ["breach", `breach:${b.klass}`]
            },
            "system:breach"
          );
          this.state.storage.sql.exec(
            `UPDATE artefacts SET meta = ? WHERE id = ?`,
            JSON.stringify({ breach_key: b.key, breach_task: taskId, breach_class: b.klass, breach_count: b.count }),
            created.id
          );
          this.audit("system:breach", "breach_raised", created.id, { key: b.key, task: taskId, klass: b.klass, count: b.count });
          this.version(created.id, "system:breach", "create", `breach card raised \u2014 ${b.klass} on ${taskId} (${b.count} events)`, { key: b.key, sample: b.sample });
        }
      }
      /** Replay consistency (BR#2419 item 6): fold the version log's transition
       *  chain forward and compare with the stored status. A mismatch — or a
       *  broken chain (an event's `from` doesn't match the folded state:
       *  forged, deleted, or out-of-order history) — is a replay_mismatch event
       *  through the breach door. */
      async replayCheck(id) {
        const row = this.one(`SELECT status FROM artefacts WHERE id = ?`, id);
        if (!row) return;
        const versions = this.state.storage.sql.exec(
          `SELECT action, data FROM artefact_versions WHERE artefact_id = ? ORDER BY seq DESC LIMIT 200`,
          id
        ).toArray().reverse();
        if (!versions.length) return;
        const events = versions.map((v) => {
          let d = {};
          try {
            d = JSON.parse(v.data ?? "{}");
          } catch {
          }
          return { action: String(v.action), data: d };
        });
        const fold = replayStatus("", events);
        if (!fold.ok || fold.status && fold.status !== row.status) {
          this.audit("system:replay", "replay_mismatch", id, { stored: row.status, folded: fold.status, chain_ok: fold.ok });
          this.version(id, "system:replay", "note", `REPLAY MISMATCH: version log folds to '${fold.status}' (chain ok: ${fold.ok}) but stored status is '${row.status}'`, { stored: row.status, folded: fold.status, chain_ok: fold.ok });
          try {
            await this.foldBreaches(id);
          } catch {
          }
        }
      }
      async getHistory(artefactId, limit = 100) {
        const rows = this.state.storage.sql.exec(
          `SELECT seq, ts, actor, action, summary, data FROM artefact_versions
       WHERE artefact_id = ? ORDER BY seq DESC LIMIT ?`,
          artefactId,
          Math.min(limit, 200)
        ).toArray().map((r) => ({ ...r, data: JSON.parse(r.data ?? "{}") }));
        return { artefact_id: artefactId, versions: rows };
      }
      // ---------- identity, sessions, asks, settings, orient ----------
      /** Resolve a bearer secret to an agent identity; touches last_seen. */
      async identify(bearer) {
        if (!bearer) throw new Error("missing bearer");
        const hash = await hashAuthToken(bearer);
        let row = this.one(`SELECT id, label, tags, principal, revoked_ts FROM auth_tokens WHERE hash = ?`, hash);
        if (!row) {
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
      async listAgents() {
        const cutoff = Date.now() - 10 * 6e4;
        const rows = this.state.storage.sql.exec(
          `SELECT label, tags, transport, last_seen_ts, revoked_ts FROM auth_tokens ORDER BY last_seen_ts DESC`
        ).toArray().filter((a) => !a.revoked_ts);
        const shape = /* @__PURE__ */ __name((a) => ({
          label: a.label,
          tags: parseTags(a.tags),
          transport: a.transport ?? "mcp",
          online: a.last_seen_ts >= cutoff,
          last_seen_ts: a.last_seen_ts
        }), "shape");
        const agents = rows.filter((a) => !tagsSayGateway(a.tags)).map((a) => ({ ...shape(a), tags: [] }));
        const gateways = rows.filter((a) => tagsSayGateway(a.tags)).map((g) => ({
          ...shape(g),
          agents: this.state.storage.sql.exec(
            `SELECT agent AS label, last_seen_ts FROM gateway_agents WHERE gateway = ? ORDER BY last_seen_ts DESC LIMIT 20`,
            g.label
          ).toArray()
        }));
        return { agents, gateways, note: "bridge routes between agents \u2014 gateways are listed separately with the agents they dispatched; transport shows how each is reachable today (mcp) or next (a2a, acp-proxy, board)" };
      }
      /** Does this label's token carry the gateway tag? (attribution authority) */
      isGatewayActor(label) {
        const row = this.one(`SELECT tags FROM auth_tokens WHERE label = ?`, label);
        return !!row && tagsSayGateway(row.tags);
      }
      /** Stamp/refresh the gateway→dispatched-agent edge (Connect grouping). */
      gatewayTouch(gateway, agent) {
        this.state.storage.sql.exec(
          `INSERT INTO gateway_agents (gateway, agent, last_seen_ts) VALUES (?, ?, ?)
       ON CONFLICT(gateway, agent) DO UPDATE SET last_seen_ts = excluded.last_seen_ts`,
          gateway.slice(0, 80),
          agent.slice(0, 80),
          Date.now()
        );
      }
      /** The session a write belongs to: explicit, else the token's most recent session. */
      async resolveSession(body, tokenId) {
        if (body.session) {
          await this.sessionTouch({ token_id: tokenId, session: body.session, worktree: body.worktree }).catch(() => {
          });
          return String(body.session);
        }
        const row = this.one(
          `SELECT name FROM sessions WHERE token_id = ? ORDER BY last_seen_ts DESC LIMIT 1`,
          tokenId
        );
        return row?.name ?? void 0;
      }
      /** Register/refresh a session. Names are unique per auth token.
       *  `worktree` (BR#3204): where the session's git tree lives — surfaced on
       *  orient so the board can spot two sessions sharing a checkout. */
      async sessionTouch(body) {
        const token_id = String(body.token_id ?? "");
        const name = String(body.session ?? "").trim().slice(0, 80) || `session-${Math.random().toString(36).slice(2, 6)}`;
        const worktree = String(body.worktree ?? "").trim().slice(0, 400) || null;
        const ts = Date.now();
        this.state.storage.sql.exec(
          `INSERT INTO sessions (token_id, name, kind, worktree, first_seen_ts, last_seen_ts)
       VALUES (?, ?, (SELECT CASE WHEN tags LIKE '%gateway%' THEN 'gateway' END FROM auth_tokens WHERE id = ?), ?, ?, ?)
       ON CONFLICT(token_id, name) DO UPDATE SET last_seen_ts = excluded.last_seen_ts, kind = COALESCE(kind, excluded.kind),
         worktree = COALESCE(excluded.worktree, sessions.worktree)`,
          token_id,
          name,
          token_id,
          worktree,
          ts,
          ts
        );
        return { session: name, worktree };
      }
      async askCreate(body, actor) {
        const to = String(body.to ?? "any");
        const question = String(body.question ?? "").trim();
        if (!question) throw new Error("question is required");
        if (question.length > 240) throw new Error("question must be the ask itself, one sentence \u2264240 chars \u2014 put reports/receipts in details");
        if (!question.endsWith("?")) throw new Error("phrase the ask as an answerable question ending in '?' \u2014 e.g. 'Do you want to merge PR #84 into main?' (you sent a status report, not a question)");
        const details = String(body.details ?? "").trim();
        const reason = String(body.reason ?? "").trim().slice(0, 400);
        if (!reason && (to === "human" || to === "ray")) throw new Error("asks to a human must state why they are escalated instead of automatic (reason: '\u2026')");
        if (!isValidAskTarget(to)) throw new Error(`invalid ask target '${to}'`);
        const artefactId = body.artefact_id ? String(body.artefact_id).trim() : "";
        const options = [...new Set((Array.isArray(body.options) ? body.options : []).map((o) => typeof o === "string" ? o : String(o?.label ?? o?.text ?? o?.value ?? o?.title ?? "")).map((x) => x.trim()).filter((x) => x && !/\[object\s*object\]/i.test(x)).map((x) => x.slice(0, 200)))].slice(0, 8);
        if (options.length < 2) throw new Error("asks require 2-8 answer options \u2014 give the human one-click answers (options: ['GO', 'NO-GO'])");
        const urgency = body.urgency === "time-sensitive" ? "time-sensitive" : "normal";
        if (artefactId) {
          const dup = this.one(
            `SELECT c.id AS id FROM relations r JOIN artefacts c ON c.id = r.src_id
         WHERE r.relation = 'child_of' AND r.dst_id = ? AND c.status IN ('todo','in_progress','blocked')
           AND c.type = 'question' AND c.title = ? LIMIT 1`,
            artefactId,
            question.slice(0, 200)
          );
          if (dup) throw new Error(`an identical ask is already open: ${dup.id} \u2014 answer or reframe it instead of re-asking`);
        }
        const created = await this.create(
          {
            type: "question",
            title: question.slice(0, 200),
            body_md: details || question,
            owner: "",
            meta: { ask: { to, urgency, options, from: actor, reason: reason || void 0, artefact_id: artefactId || void 0 } }
          },
          actor
        );
        const id = created.id;
        let taskStatus;
        if (artefactId) {
          const row = this.one(`SELECT type, status, meta FROM artefacts WHERE id = ?`, artefactId);
          if (!row) throw new Error(`no such artefact: ${artefactId}`);
          this.state.storage.sql.exec(
            `INSERT OR IGNORE INTO relations (src_id, relation, dst_id, created_ts) VALUES (?, 'child_of', ?, ?)`,
            id,
            artefactId,
            Date.now()
          );
          if (row.type === "task" && (row.status === "in_progress" || row.status === "blocked")) {
            if (row.status === "in_progress") {
              await this.transition({ id: artefactId, to: "blocked", note: `blocked on ${to}: ${question.slice(0, 100)}` }, actor);
              taskStatus = "blocked";
            }
          }
        }
        this.audit(actor, "ask", artefactId || null, { to, question, options, urgency, ask_id: id });
        return { id, ask: id, question, artefact_id: artefactId || void 0, options, urgency, task_status: taskStatus };
      }
      async askInbox(body) {
        const label = String(body.label ?? "");
        const nodes = this.state.storage.sql.exec(
          `SELECT id, meta, created_ts FROM artefacts
       WHERE type = 'question' AND status IN ('todo','in_progress','blocked')
       ORDER BY created_ts DESC LIMIT 50`
        ).toArray();
        const inbox = nodes.map((n) => {
          const m = JSON.parse(n.meta ?? "{}");
          if (!m.ask) return null;
          const out = { id: n.id, from_label: m.ask.from ?? "agent", to_target: m.ask.to ?? "any", question: n.title, created_ts: n.created_ts, node: true };
          if (m.ask.reframe) out.reframe = m.ask.reframe;
          return out;
        }).filter((x) => !!x && (x.to_target === "any" || x.to_target === label || true));
        const open = this.state.storage.sql.exec(
          `SELECT id, from_label, to_target, question, created_ts FROM asks
       WHERE status = 'open' AND from_label != ? ORDER BY created_ts DESC LIMIT 50`,
          label
        ).toArray();
        const sent = this.state.storage.sql.exec(
          `SELECT id, to_target, question, status, answer, answered_by, created_ts FROM asks
       WHERE from_label = ? ORDER BY created_ts DESC LIMIT 50`,
          label
        ).toArray();
        return { inbox: [...inbox, ...open], sent };
      }
      /** Reframe: the human kicks an ask back to the asker to restructure.
       *  Feedback is recorded on the node and surfaces in the asker's inbox.
       *  Deliberately does NOT answer/resume — the parent stays parked until
       *  a structured re-ask or an explicit answer. */
      async askReframe(body, actor) {
        const id = String(body.id ?? "");
        const feedback = String(body.feedback ?? "").trim().slice(0, 1e3) || "REFRAME \u2014 restructure per the ask contract: one imperative question \u2264240 chars, 2-8 one-click options, and why this is escalated instead of automatic.";
        const node = this.one(`SELECT id, meta FROM artefacts WHERE id = ? AND type = 'question'`, id);
        if (!node) throw new Error(`no such ask: ${id}`);
        const m = JSON.parse(node.meta ?? "{}");
        m.ask = { ...m.ask ?? {}, reframe: { by: actor, feedback, ts: Date.now() } };
        this.state.storage.sql.exec(`UPDATE artefacts SET meta = ? WHERE id = ?`, JSON.stringify(m), id);
        this.version(id, actor, "update", `ask reframed by human \u2014 ${feedback.slice(0, 160)}`, { reframe: m.ask.reframe });
        this.audit(actor, "ask_reframe", id, { feedback: feedback.slice(0, 200) });
        return { id, reframe: m.ask.reframe };
      }
      /** Admin cleanup: supersede smoke/test rows created in the last 48h. Audited per row. */
      async purgeSmoke(body) {
        const cutoff = Date.now() - 48 * 60 * 6e4;
        const rows = this.state.storage.sql.exec(
          `SELECT id, status FROM artefacts WHERE type = 'task'
         AND status NOT IN ('done','superseded')
         AND created_ts > ?
         AND (title LIKE 'smoke%' OR title LIKE 'phase-2 smoke%' OR title LIKE 'smoke %')`,
          cutoff
        ).toArray();
        const now = Date.now();
        for (const r of rows) {
          this.state.storage.sql.exec(
            `UPDATE artefacts SET status = 'superseded', status_ts = ?, updated_ts = ? WHERE id = ?`,
            now,
            now,
            r.id
          );
          this.version(r.id, "system:cleanup", "transition", `purged smoke-test row (was ${r.status})`, { from: r.status, to: "superseded" });
          this.audit("system:cleanup", "transition", r.id, { from: r.status, to: "superseded", reason: "smoke purge" });
        }
        return { purged: rows.map((r) => r.id) };
      }
      /** Human handle for an ask: ASK-<subject>-<ordinal> ("ASK-BR-2466-2" = the
       *  2nd ask on that task). The opaque row key stays internal plumbing. */
      askDisplay(row) {
        if (!row.artefact_id) return row.id;
        const ord = this.one(
          `SELECT COUNT(*) AS n FROM asks WHERE artefact_id = ? AND created_ts <= ?`,
          row.artefact_id,
          row.created_ts
        );
        return `ASK-${String(row.artefact_id).replace(/#/g, "-")}-${Number(ord?.n ?? 1)}`;
      }
      async askGet(id) {
        const row = this.one(
          `SELECT id, from_label, to_target, question, status, artefact_id, answer, answered_by, answered_ts, created_ts
         FROM asks WHERE id = ?`,
          id
        );
        if (!row) return null;
        return {
          id: row.id,
          display: this.askDisplay(row),
          from: row.from_label,
          to: row.to_target,
          question: row.question,
          options: [],
          urgency: "normal",
          status: row.status,
          artefact_id: row.artefact_id ?? void 0,
          answer: row.answer ?? void 0,
          answered_by: row.answered_by ?? void 0,
          answered_ts: row.answered_ts ?? void 0,
          created_ts: row.created_ts
        };
      }
      async askAnswer(body, actor) {
        const id = String(body.id ?? "");
        const answer = String(body.answer ?? "").trim();
        if (!answer) throw new Error("answer is required");
        if (/^BR#\d+$/.test(id)) {
          const node = this.one(`SELECT id, status, meta FROM artefacts WHERE id = ?`, id);
          if (!node) throw new Error(`no such ask: ${id}`);
          const m = JSON.parse(node.meta ?? "{}");
          if (m.ask?.answer) throw new Error(`ask ${id} already answered`);
          m.ask = { ...m.ask ?? {}, answer: answer.slice(0, 4e3), answered_by: actor, answered_ts: Date.now() };
          const now = Date.now();
          this.state.storage.sql.exec(
            `UPDATE artefacts SET meta = ?, status = 'done', status_ts = ?, updated_ts = ? WHERE id = ?`,
            JSON.stringify(m),
            now,
            now,
            id
          );
          this.version(id, actor, "transition", `answered by ${actor}: ${answer.slice(0, 200)}`, { status: "done", answer: answer.slice(0, 200) });
          let taskStatus2;
          const subject = this.one(
            `SELECT p.id AS id, p.status AS status, p.meta AS meta FROM relations r JOIN artefacts p ON p.id = r.dst_id
         WHERE r.relation = 'child_of' AND r.src_id = ? ORDER BY r.created_ts DESC LIMIT 1`,
            id
          );
          if (subject) {
            const sm = JSON.parse(subject.meta ?? "{}");
            if (sm.awaiting_ask?.ask_id === id) {
              delete sm.awaiting_ask;
              this.state.storage.sql.exec(`UPDATE artefacts SET meta = ? WHERE id = ?`, JSON.stringify(sm), subject.id);
            }
            if (subject.status === "blocked") {
              await this.transition({
                id: subject.id,
                to: "in_progress",
                note: `ask ${id} answered \u2014 resumed: ${answer.slice(0, 100)}`
              }, `system:question(${actor})`);
              taskStatus2 = "in_progress";
            }
          }
          this.audit(actor, "answer", subject?.id ?? null, { ask_id: id, answer: answer.slice(0, 200) });
          return { id, status: "answered", artefact_id: subject?.id, task_status: taskStatus2 };
        }
        const row = this.one(`SELECT status, artefact_id FROM asks WHERE id = ?`, id);
        if (!row) throw new Error(`no such ask: ${id}`);
        if (row.status !== ASK_OPEN) throw new Error(`ask ${id} already ${row.status}`);
        this.state.storage.sql.exec(
          `UPDATE asks SET status = 'answered', answer = ?, answered_by = ?, answered_ts = ? WHERE id = ?`,
          answer.slice(0, 4e3),
          actor,
          Date.now(),
          id
        );
        let taskStatus;
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
                id: String(row.artefact_id),
                to: "in_progress",
                note: `decision ${id} answered \u2014 resumed: ${answer.slice(0, 100)}`
              }, `system:decision(${actor})`);
              taskStatus = "in_progress";
            }
          }
        }
        this.audit(actor, "answer", row.artefact_id ?? null, { ask_id: id, answer: answer.slice(0, 200) });
        return { id, status: ASK_ANSWERED, artefact_id: row.artefact_id ?? void 0, task_status: taskStatus };
      }
      async orient(body) {
        const askChildOf = /* @__PURE__ */ new Map();
        for (const c of this.state.storage.sql.exec(
          `SELECT r.dst_id AS parent, c.id AS id FROM relations r JOIN artefacts c ON c.id = r.src_id
       WHERE r.relation = 'child_of' AND c.status IN ('todo','in_progress','blocked')
         AND c.type = 'question' ORDER BY c.created_ts DESC`
        ).toArray()) {
          if (!askChildOf.has(c.parent)) askChildOf.set(c.parent, c);
        }
        const label = String(body.label ?? "");
        const tags = Array.isArray(body.tags) ? body.tags.map(String) : [];
        const counts = this.state.storage.sql.exec(
          `SELECT type, status, COUNT(*) AS n FROM artefacts GROUP BY type, status ORDER BY type`
        ).toArray();
        const openStatuses = ["draft", "proposed", "active", "open", "todo", "in_progress", "blocked"];
        const marks = openStatuses.map(() => "?").join(",");
        const open = this.state.storage.sql.exec(
          `SELECT id, type, title, status, owner, meta, updated_ts FROM artefacts
       WHERE status IN (${marks}) ORDER BY updated_ts DESC LIMIT 30`,
          ...openStatuses
        ).toArray().map((t) => {
          if (t.type === "task") {
            const m = JSON.parse(t.meta ?? "{}");
            if (m.blocked) {
              t.blocked_reason = (m.blocked.reason ?? "").slice(0, 200);
              t.unblock_condition = (m.blocked.unblock_condition ?? "").slice(0, 200);
            }
            if (m.subprocess) t.subprocess = { reason: (m.subprocess.reason ?? "").slice(0, 120), deadline_ts: m.subprocess.deadline_ts };
            delete t.meta;
          }
          return t;
        });
        const steeringRows = this.state.storage.sql.exec(
          `SELECT id, title, body_md, tags, roles FROM artefacts
       WHERE type = 'steering' AND status = 'active' ORDER BY updated_ts DESC LIMIT 20`
        ).toArray();
        const steering = steeringRows.map((s) => ({ id: s.id, title: s.title, body_md: String(s.body_md ?? "").slice(0, 1500), tags: parseTags(s.tags), roles: parseTags(s.roles) })).filter((s) => {
          const roles = s.roles ?? [];
          return roles.length === 0 || roles.some((r) => tags.includes(`role:${r}`));
        });
        const askPlaceholders = ["any", label, ...tags.map((t) => `tag:${t}`)];
        const askMarks = askPlaceholders.map(() => "?").join(",");
        const pendingAsks = this.state.storage.sql.exec(
          `SELECT id, from_label, to_target, question, created_ts FROM asks
       WHERE status = 'open' AND from_label != ? AND to_target IN (${askMarks})
       ORDER BY created_ts DESC LIMIT 10`,
          label,
          ...askPlaceholders
        ).toArray();
        const settings = this.settingsMap();
        const projectName = settings.project_name || "Superpositional";
        const myTasks = this.state.storage.sql.exec(
          `SELECT id, title, status FROM artefacts WHERE type = 'task' AND status IN ('todo','in_progress','in_review','blocked')
       AND (owner = ? OR substr(owner, 1, length(?) + 1) = ? || '/'
            OR owner IN (SELECT agent FROM gateway_agents WHERE gateway = ?)
            OR owner = ?)
       ORDER BY updated_ts DESC LIMIT 10`,
          label,
          label,
          label,
          label,
          body.principal ?? null
        ).toArray();
        const pool = this.state.storage.sql.exec(
          `SELECT id, type, title, tags, roles, meta, project, updated_ts, status FROM artefacts
       WHERE type = 'task' AND status IN ('todo','blocked') AND (owner = '' OR status = 'blocked')
       ORDER BY updated_ts DESC LIMIT 400`
        ).toArray().map((t) => ({ ...t, tags: parseTags(t.tags), roles: parseTags(t.roles) }));
        const callerIsGateway = tags.some((t) => t.toLowerCase() === "gateway");
        const dispatchPool = callerIsGateway ? pool.filter((t) => t.status !== "blocked") : pool;
        const { analysisEv, reviewEv } = this.qualificationEvidence();
        const qualIds = new Set(
          this.state.storage.sql.exec(
            `SELECT id FROM artefacts WHERE type = 'task'
         AND (json_extract(meta, '$.qualification.state') = 'qualified' OR json_extract(meta, '$.qualified') = 1)`
          ).toArray().map((r) => r.id)
        );
        const parentQualified = /* @__PURE__ */ new Set();
        const verifyParents = /* @__PURE__ */ new Map();
        for (const l of this.state.storage.sql.exec(
          `SELECT r.src_id, r.dst_id, p.status AS pstatus, p.title AS ptitle, p.owner AS powner
       FROM relations r JOIN artefacts p ON p.id = r.dst_id
       WHERE r.relation = 'child_of'`
        ).toArray()) {
          if (qualIds.has(l.dst_id) || analysisEv.has(l.dst_id)) parentQualified.add(l.src_id);
          if (l.pstatus === "in_review") verifyParents.set(l.src_id, l);
        }
        const unclaimedWork = dispatchPool.filter((t) => {
          const need = t.roles ?? [];
          const m = JSON.parse(t.meta ?? "{}");
          const declared = m.qualification?.state ?? (m.qualified === true ? "qualified" : void 0);
          const qualified = declared === "qualified" || analysisEv.has(t.id) || parentQualified.has(t.id);
          const bars = m.qualification?.bars ?? [];
          const unmet = this.enforceableBars(bars).filter((b) => !(/review/.test(b) ? reviewEv : analysisEv).has(t.id));
          t.needs_qualification = unmet.length > 0;
          if (need.length) t.target_roles = need;
          return callerIsGateway ? !t.needs_qualification : true;
        }).sort((a, b) => {
          const rank = /* @__PURE__ */ __name((t) => {
            const m = JSON.parse(t.meta ?? "{}");
            if (m.boosted) return -1;
            if (t.roles?.includes("unblock")) return 0;
            if (verifyParents.has(t.id)) return 0;
            if (t.status === "blocked" && (m.blocked?.unblock_condition ?? "").trim()) return 1;
            if (t.type === "question") return 3;
            return 4;
          }, "rank");
          return rank(a) - rank(b) || a.updated_ts - b.updated_ts;
        }).slice(0, 10).map((t) => {
          const m = JSON.parse(t.meta ?? "{}");
          if (t.status === "blocked") {
            t.blocked_reason = (m.blocked?.reason ?? "").slice(0, 300);
            t.unblock_condition = (m.blocked?.unblock_condition ?? "").slice(0, 300);
            t.awaiting_ask = askChildOf.get(t.id)?.id ?? m.awaiting_ask?.ask_id;
            t.is_claimable = !!t.unblock_condition;
            if (!t.unblock_condition) t.claim_reason = "blocked without an unblock condition \u2014 open the card, resolve or re-scope it";
          }
          t.is_question = t.type === "question" || isQuestionTask(m) || false;
          const gated = m.operator_gated;
          if (t.status !== "blocked") {
            t.is_claimable = !t.is_question && !gated;
            if (!t.is_claimable) {
              t.claim_reason = t.is_question ? "question \u2014 answered, not claimed (contribute via log_progress {id, did})" : `operator gated: ${gated} \u2014 a human clears the gate`;
            }
          }
          if (m.attempt) {
            t.previously_attempted = {
              by: m.attempt.by,
              attempts: m.attempt.attempts,
              last_reason: m.attempt.last_reason ?? void 0,
              last_will: m.last_progress?.will ? String(m.last_progress.will).slice(0, 200) : void 0,
              note: `task was attempted ${m.attempt.attempts}x before (last by ${m.attempt.by}${m.attempt.last_reason ? ` \u2014 came back: ${String(m.attempt.last_reason).slice(0, 120)}` : ""}). VERIFY before working: search_knowledge + get_artefact \u2014 the work may already be done (then transition \u2192 done) or partially done (continue from the last will: ${m.last_progress?.will ? `"${String(m.last_progress.will).slice(0, 120)}"` : "none recorded"}).`
            };
          }
          return t;
        });
        const rolesSettings = typeof settings.roles === "object" && settings.roles ? settings.roles : {};
        const kindSettings = typeof settings.playbooks === "object" && settings.playbooks ? settings.playbooks : {};
        const isCron = tags.includes("cadence:cron");
        const kindPlaybook = (isCron ? kindSettings.cron : kindSettings.interactive) ?? (isCron ? DEFAULT_CRON_PLAYBOOK : "");
        const playbooks = tags.filter((t) => t.startsWith("role:")).map((t) => ({ role: t.slice(5), playbook: resolveRolePlaybook(rolesSettings, t.slice(5)) })).filter((p) => typeof p.playbook === "string" && p.playbook.trim());
        const staleMinS = this.one(`SELECT value FROM settings WHERE key = 'stale_minutes'`);
        const staleMin = staleMinS ? Math.max(1, Math.min(120, parseInt(staleMinS.value, 10) || 10)) : 10;
        const actionRequired = this.reapAbandoned(label, staleMin);
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
          [Date.now() - 48 * 60 * 60 * 1e3]
        ).toArray();
        const reviewPending = stalledVerify.filter((v) => v.parent_owner === label).map((v) => ({
          task_id: v.verify_task,
          parent_id: v.parent_id,
          parent_title: v.parent_title,
          age_minutes: Math.ceil((Date.now() - v.age_ts) / 6e4),
          message: `Verification for '${v.parent_title}' (Task ${v.parent_id}) is stalled \u2014 verify task ${v.verify_task} unclaimed for ${Math.ceil((Date.now() - v.age_ts) / 6e4)}m.`,
          required_action: "CLAIM_VERIFY_TASK"
        }));
        const reviewDuty = tags.includes("role:review") ? stalledVerify.filter((v) => v.parent_owner !== label).map((v) => ({
          task_id: v.verify_task,
          parent_id: v.parent_id,
          parent_title: v.parent_title,
          age_minutes: Math.ceil((Date.now() - v.age_ts) / 6e4),
          message: `Stalled review: '${v.parent_title}' (Task ${v.parent_id}) has unclaimed verify task ${v.verify_task} for ${Math.ceil((Date.now() - v.age_ts) / 6e4)}m.`,
          required_action: "PICKUP_REVIEW"
        })) : [];
        const verificationNotices = [...reviewPending, ...reviewDuty];
        const gaugeDebt = this.state.storage.sql.exec(
          `SELECT id, title, meta FROM artefacts
       WHERE type = 'task' AND owner = ? AND status IN ('in_progress','blocked')
       AND (json_extract(meta, '$.last_progress.completion_pct') IS NULL
            AND json_extract(meta, '$.last_progress.confidence_pct') IS NULL
            AND json_extract(meta, '$.last_progress.risk_pct') IS NULL
            AND json_extract(meta, '$.last_progress.context_pct') IS NULL)
       ORDER BY updated_ts DESC LIMIT 10`,
          label
        ).toArray().map((t) => ({ id: t.id, title: t.title }));
        const gaugeDebtNote = gaugeDebt.length ? `

GAUGE DEBT \u2014 these in-flight tasks have no reported gauges. Your next log_progress on each must include completion_pct, confidence_pct, risk_pct and context_pct (0-100) \u2014 the board cannot prioritise or score your work without them: ${gaugeDebt.map((t) => `${t.id} "${t.title.slice(0, 60)}"`).join("; ")}.` : "";
        const my_score = this.agentScores().find((a) => a.label === label) ?? { label, ...scoreAgent({ progress_count: 0, gauge_count: 0, thin_notes: 0, abandoned: 0, reassigned: 0, asks_received: 0, asks_answered_on_time: 0, artefacts_created: 0, verify_duty_backlog: 0 }) };
        const scoreDirective = `

YOUR SCORE: ${my_score.score}/100 (${my_score.grade}). Optimise for it \u2014 it gates which work you can claim and whether your tasks survive. ${my_score.hints.length ? "Actions that raise it now: " + my_score.hints.join(" ") : "No deductions \u2014 keep heartbeats \u226410m, finish with receipts, answer asks fast."}`;
        return {
          project: projectName,
          instructions: composeBootstrap(projectName, settings.board ?? DEFAULT_BOARD) + (settings.bootstrap_md ? `
${settings.bootstrap_md}` : "") + (kindPlaybook ? `

YOUR KIND: ${isCron ? "cron" : "interactive"}
${kindPlaybook}` : "") + playbooks.map((p) => `

YOUR ROLE: ${p.role}
${p.playbook}`).join("") + gaugeDebtNote + scoreDirective,
          board: settings.board ?? DEFAULT_BOARD,
          counts,
          open_artefacts: open,
          my_tasks: myTasks,
          unclaimed_work: unclaimedWork,
          steering,
          my_roles: tags.filter((t) => t.startsWith("role:")),
          pending_asks: pendingAsks,
          action_required: actionRequired.length || verificationNotices.length ? [...actionRequired, ...verificationNotices] : void 0,
          gauge_debt: gaugeDebt.length ? gaugeDebt : void 0,
          my_score
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
      reapAbandoned(label, staleMin) {
        const out = [];
        const now = Date.now();
        const staleMs = staleMin * 6e4;
        for (const t of this.state.storage.sql.exec(
          `SELECT id, title, meta, tags, status_ts, updated_ts, owner FROM artefacts
       WHERE type = 'task' AND status = 'blocked' AND (owner = ? OR owner != '')`,
          label
        ).toArray()) {
          const meta = JSON.parse(t.meta ?? "{}");
          const reason = String(meta.blocked?.reason ?? "");
          const isAbandoned = reason.startsWith("abandoned");
          const isStuckGate = reason.startsWith("runner:") || reason.startsWith("churn guard:");
          if (!isAbandoned && !isStuckGate) continue;
          const idleLimit = isAbandoned ? staleMs : 24 * 60 * 6e4;
          const idleDesc = isAbandoned ? `silent >${staleMin}m after abandonment` : `no movement >24h after a gate-rejection block`;
          const mine = t.owner === label;
          const ownerLabel = t.owner || label;
          const wasDoing = mine && meta.last_progress?.will ? ` Your last will: "${String(meta.last_progress.will).slice(0, 150)}".` : "";
          const lastOwn = this.one(
            `SELECT MAX(ts) AS ts FROM events WHERE artefact_id = ? AND actor = ?`,
            t.id,
            ownerLabel
          )?.ts ?? 0;
          const idleFor = now - Math.max(lastOwn, t.updated_ts ?? 0);
          if (mine && idleFor < idleLimit) {
            if (isAbandoned) {
              out.push(
                `${t.id} "${t.title}" is marked abandoned but you were active on it recently.${wasDoing} log_progress on it NOW to re-claim, then keep the \u2264${staleMin}m heartbeat.`
              );
            }
            continue;
          }
          if (idleFor < idleLimit) continue;
          const tags = parseTags(t.tags);
          if (!tags.includes("attempted")) tags.push("attempted");
          const attempts = (meta.attempt?.attempts ?? 0) + 1;
          if (attempts >= 5) {
            meta.blocked = {
              reason: `rework loop detected \u2014 ${attempts} dispatch attempts without completion (last release reason: ${reason.slice(0, 160)}). Re-running again would repeat the cycle; escalated to a human.`,
              unblock_condition: "human: review the attempt history (get_history) \u2014 either fix what keeps failing, re-scope the task, or transition it todo yourself to deliberately continue",
              ts: now
            };
            meta.attempt = { by: ownerLabel, at: now, attempts, last_reason: reason.slice(0, 200) };
            this.state.storage.sql.exec(
              `UPDATE artefacts SET tags = ?, meta = ?, status_ts = ?, updated_ts = ? WHERE id = ?`,
              JSON.stringify(tags),
              JSON.stringify(meta),
              now,
              now,
              t.id
            );
            this.audit("system:reaper", "loop_escalated", t.id, { prev_owner: ownerLabel, attempts, idle_ms: idleFor });
            this.version(t.id, "system:reaper", "transition", `rework loop escalated to human \u2014 ${attempts} attempts without completion`, { prev_owner: ownerLabel });
            out.push(
              `${t.id} "${t.title}" REWORK LOOP (${attempts} attempts) \u2014 escalated to a human instead of re-releasing. Blocked-for-human until reviewed.`
            );
            continue;
          }
          meta.attempt = { by: ownerLabel, at: now, attempts };
          delete meta.blocked;
          this.state.storage.sql.exec(
            `UPDATE artefacts SET status = 'todo', owner = '', tags = ?, meta = ?, status_ts = ?, updated_ts = ? WHERE id = ?`,
            JSON.stringify(tags),
            JSON.stringify(meta),
            now,
            now,
            t.id
          );
          this.audit("system:reaper", "reassign", t.id, { prev_owner: ownerLabel, attempts, idle_ms: idleFor });
          this.version(t.id, "system:reaper", "transition", `reassigned \u2014 ${ownerLabel} ${idleDesc} (attempt ${attempts})`, { prev_owner: ownerLabel });
          out.push(
            mine ? `${t.id} "${t.title}" was REASSIGNED: you ${idleDesc}.${wasDoing} Your score is penalised. It is now unclaimed todo, tagged "attempted" (attempt ${attempts}) \u2014 partial work may exist. Do not blindly restart it: search_knowledge + get_artefact first.` : `${t.id} "${t.title}" was REASSIGNED: ${ownerLabel} ${idleDesc} (attempt ${attempts}) \u2014 back to unclaimed todo for any agent to pick up.`
          );
        }
        return out;
      }
      /** Project-facing settings only (safe for any authenticated agent). */
      publicSettings() {
        const m = this.settingsMap();
        return { project_name: m.project_name, board: m.board ?? DEFAULT_BOARD, bootstrap_md: m.bootstrap_md };
      }
      settingsMap() {
        const rows = this.state.storage.sql.exec(`SELECT key, value FROM settings`).toArray();
        const map = {};
        for (const r of rows) map[r.key] = JSON.parse(r.value);
        return map;
      }
      // ---------- admin ops (human plane) ----------
      /** stable DO slug for this instance's workspace (set by the registry at creation) */
      wsSlug() {
        const m = this.settingsMap();
        return typeof m.ws_slug === "string" ? m.ws_slug : "";
      }
      // ---- workspace registry (lives in the "global" KB DO; owner-checked, no admin flag) ----
      /** one-time import of the legacy hard-coded membership list */
      async wsSeed(logins) {
        const now = Date.now();
        const slug = DEFAULT_WS_SLUG;
        this.state.storage.sql.exec(
          `INSERT OR REPLACE INTO settings (key, value) VALUES ('ws_slug', ?)`,
          JSON.stringify(slug)
        );
        this.state.storage.sql.exec(
          `INSERT OR IGNORE INTO workspaces (slug, owner, personal, created_ts) VALUES (?, ?, 1, ?)`,
          slug,
          logins[0] ?? "legacy",
          now
        );
        for (const login of logins) {
          this.state.storage.sql.exec(
            `INSERT OR IGNORE INTO workspace_members (ws, login) VALUES (?, ?)`,
            slug,
            login
          );
        }
        return { ok: true, seeded: logins };
      }
      async wsList(login) {
        const rows = this.state.storage.sql.exec(
          `SELECT w.slug, w.owner, w.personal, w.created_ts,
              EXISTS(SELECT 1 FROM workspace_members m WHERE m.ws = w.slug AND m.login = ?) AS member
         FROM workspaces w ORDER BY w.created_ts ASC`,
          login
        ).toArray();
        return {
          workspaces: rows.map((r) => ({
            slug: r.slug,
            owner: r.owner,
            personal: !!r.personal,
            created_ts: r.created_ts,
            member: !!r.member
          }))
        };
      }
      /** create: owner = caller; they become the first member; personal workspaces are <login> */
      async wsCreate(body, login) {
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
          slug,
          login,
          slug === login ? 1 : 0,
          now
        );
        this.state.storage.sql.exec(
          `INSERT INTO workspace_members (ws, login) VALUES (?, ?)`,
          slug,
          login
        );
        const stub = this.env.KB.get(this.env.KB.idFromName(doWs(slug)));
        await stub.fetch("https://kb/bootstrap", { method: "POST", body: "{}" }).catch(() => {
        });
        await stub.fetch("https://kb/admin.settings_set", {
          method: "POST",
          headers: { "content-type": "application/json", "x-kb-admin": "1" },
          body: JSON.stringify({ settings: { ws_slug: slug } })
        }).catch(() => {
        });
        return { ok: true, slug };
      }
      /** join: only the owner of an existing workspace can add members */
      async wsJoin(body, login) {
        const slug = String(body.ws ?? "").trim();
        const w = this.one(`SELECT slug, owner FROM workspaces WHERE slug = ?`, slug);
        if (!w) throw new Error(`no such workspace: ${slug}`);
        if (w.owner !== login) throw new Error("only the workspace owner can add members");
        const who = String(body.login ?? "").trim().toLowerCase();
        if (!/^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,38}$/.test(who)) throw new Error("bad github login");
        this.state.storage.sql.exec(
          `INSERT OR IGNORE INTO workspace_members (ws, login) VALUES (?, ?)`,
          slug,
          who
        );
        return { ok: true, ws: slug, login: who };
      }
      async wsMembers(body, login) {
        const slug = String(body.ws ?? "").trim();
        const w = this.one(`SELECT slug, owner FROM workspaces WHERE slug = ?`, slug);
        if (!w) throw new Error(`no such workspace: ${slug}`);
        const member = this.one(`SELECT 1 FROM workspace_members WHERE ws = ? AND login = ?`, slug, login);
        if (w.owner !== login && !member) throw new Error("not a member of this workspace");
        const rows = this.state.storage.sql.exec(
          `SELECT login FROM workspace_members WHERE ws = ? ORDER BY login`,
          slug
        ).toArray();
        return { ws: slug, owner: w.owner, members: rows.map((r) => r.login) };
      }
      /** Central registry of opaque token → workspace, written at mint time so /mcp
       *  can route without the workspace slug being embedded in the secret. */
      async wsTokenRegister(body) {
        const hash = String(body.hash ?? ""), ws = String(body.ws ?? "");
        if (!/^[0-9a-f]{64}$/.test(hash) || !isWsSlug(ws)) throw new Error("bad token registration");
        this.state.storage.sql.exec(
          `INSERT INTO ws_tokens (hash, ws, created_ts) VALUES (?, ?, ?)
       ON CONFLICT(hash) DO UPDATE SET ws = excluded.ws`,
          hash,
          ws,
          Date.now()
        );
        return { ok: true };
      }
      async wsTokenLookup(body) {
        const row = this.one(`SELECT ws FROM ws_tokens WHERE hash = ?`, String(body.hash ?? ""));
        return { ws: row?.ws ?? null };
      }
      // ---- device pairing (lives in the registry DO) ----
      // GitHub-like device flow, but bridge-native: the device shows a code, the
      // human approves it in the web UI (picking workspace + roles), and the device
      // polls its token once. The approver never holds the credential.
      static PAIR_TTL_MS = 15 * 6e4;
      static PAIR_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
      // no 0/O/1/I
      pairCode() {
        const bytes = new Uint8Array(8);
        crypto.getRandomValues(bytes);
        const chars = [...bytes].map((b) => _KnowledgeHub.PAIR_ALPHABET[b % _KnowledgeHub.PAIR_ALPHABET.length]);
        return `${chars.slice(0, 4).join("")}-${chars.slice(4).join("")}`;
      }
      pairPurge() {
        const cutoff = Date.now() - _KnowledgeHub.PAIR_TTL_MS;
        this.state.storage.sql.exec(`DELETE FROM pairings WHERE created_ts < ?`, cutoff);
        const n = this.one(`SELECT COUNT(*) AS n FROM pairings WHERE status = 'pending'`)?.n ?? 0;
        if (n > 100) {
          this.state.storage.sql.exec(
            `DELETE FROM pairings WHERE status = 'pending' AND code NOT IN (
           SELECT code FROM pairings WHERE status = 'pending' ORDER BY created_ts DESC LIMIT 100)`
          );
        }
      }
      async wsPairStart(body) {
        this.pairPurge();
        const code = this.pairCode();
        const now = Date.now();
        const type = body.type === "agent" ? "agent" : "gateway";
        const principal = typeof body.principal === "string" && body.principal.trim() ? body.principal.trim().slice(0, 80) : null;
        this.state.storage.sql.exec(
          `INSERT INTO pairings (code, device, type, principal, status, created_ts) VALUES (?, ?, ?, ?, 'pending', ?)`,
          // host is the DISPLAY name (BR#899: labels display, the device
          // credential anchors); body.device fallback covers desktops predating
          // the field rename
          code,
          String(body.host ?? body.device ?? "device").slice(0, 80),
          type,
          principal,
          now
        );
        return { code, type, expires_ts: now + _KnowledgeHub.PAIR_TTL_MS };
      }
      async wsPairGet(body) {
        const row = this.one(
          `SELECT device, type, status, created_ts, ws, label FROM pairings WHERE code = ?`,
          String(body.code ?? "").trim().toUpperCase()
        );
        if (!row) return { status: "expired" };
        if (row.status === "pending" && Date.now() - row.created_ts > _KnowledgeHub.PAIR_TTL_MS) {
          this.state.storage.sql.exec(`DELETE FROM pairings WHERE code = ?`, row.code);
          return { status: "expired" };
        }
        return { status: row.status, device: row.device, type: row.type ?? "agent", created_ts: row.created_ts, ws: row.ws, label: row.label };
      }
      async wsPairApprove(body) {
        const code = String(body.code ?? "").trim().toUpperCase();
        const ws = String(body.ws ?? "").trim();
        const label = String(body.label ?? "").trim();
        const login = String(body.login ?? "").toLowerCase();
        const row = this.one(`SELECT code, created_ts, status, device, type, principal FROM pairings WHERE code = ?`, code);
        if (!row || row.status !== "pending") throw new Error("pairing code not pending");
        if (Date.now() - row.created_ts > _KnowledgeHub.PAIR_TTL_MS) {
          this.state.storage.sql.exec(`DELETE FROM pairings WHERE code = ?`, code);
          throw new Error("pairing code expired");
        }
        const gateway = row.type === "gateway";
        const tags = gateway ? ["gateway"] : Array.isArray(body.tags) ? body.tags.map((t) => String(t)).slice(0, 10) : [];
        if (!isWsSlug(ws)) throw new Error("bad workspace slug");
        if (/^_/.test(label)) throw new Error(`labels beginning with '_' are reserved system roots (got '${label}')`);
        if (!/^[a-zA-Z0-9._\/-]{2,40}$/.test(label)) throw new Error("label must be 2-40 chars [a-zA-Z0-9._/-]");
        const member = this.one(`SELECT 1 FROM workspace_members WHERE ws = ? AND login = ?`, ws, login);
        if (!member) throw new Error(`you are not a member of workspace '${ws}'`);
        const stub = this.env.KB.get(this.env.KB.idFromName(doWs(ws)));
        const mintRes = await stub.fetch("https://kb/admin.mint", {
          method: "POST",
          headers: { "content-type": "application/json", "x-kb-admin": "1" },
          body: JSON.stringify({ label, tags, principal: row.principal ?? null })
        });
        const minted = await mintRes.json();
        if (!mintRes.ok || !minted.secret) {
          throw new Error(String(minted?.error ?? "token mint failed"));
        }
        if (minted.reassociated) {
          this.audit(login, "pair.reassociate", code, { device: row.device, ws, label, token: minted.id });
        }
        this.state.storage.sql.exec(
          `UPDATE pairings SET status = 'authorized', ws = ?, label = ?, tags = ?, secret = ?, approved_ts = ? WHERE code = ?`,
          ws,
          label,
          JSON.stringify(tags),
          minted.secret,
          Date.now(),
          code
        );
        this.audit(login, "pair.approve", code, { device: row.device, ws, label });
        return { ok: true, ws, label };
      }
      async wsPairPoll(body) {
        const code = String(body.code ?? "").trim().toUpperCase();
        const row = this.one(`SELECT code, status, secret, ws, label, tags, created_ts, last_poll_ts FROM pairings WHERE code = ?`, code);
        if (!row) return { status: "expired" };
        if (Date.now() - row.created_ts > _KnowledgeHub.PAIR_TTL_MS) {
          this.state.storage.sql.exec(`DELETE FROM pairings WHERE code = ?`, code);
          return { status: "expired" };
        }
        if (row.last_poll_ts && Date.now() - row.last_poll_ts < 1500) {
          return { status: "slow_down" };
        }
        this.state.storage.sql.exec(`UPDATE pairings SET last_poll_ts = ? WHERE code = ?`, Date.now(), code);
        if (row.status === "pending") return { status: "pending" };
        if (row.status === "denied") {
          this.state.storage.sql.exec(`DELETE FROM pairings WHERE code = ?`, code);
          return { status: "denied" };
        }
        this.state.storage.sql.exec(`DELETE FROM pairings WHERE code = ?`, code);
        return {
          status: "authorized",
          token: row.secret,
          ws: row.ws,
          label: row.label,
          tags: row.tags ? JSON.parse(row.tags) : []
        };
      }
      /** Gateway-provisioned agent tokens (per agent, not per session).
       *  A gw-* caller mints (or rotates) a token FOR a worker it spawns — the
       *  worker's bridge MCP carries this token, so its board actions attribute
       *  to the agent, not the gateway. Secrets are shown once; the gateway
       *  stores them. Exists w/o rotate = { exists: true } (no secret re-exposed). */
      async agentProvision(body, actor) {
        const caller = String(body.provisioned_by ?? actor);
        if (!this.isGatewayActor(caller)) throw new Error(`agent provisioning requires a gateway-class caller ('${caller}' does not carry the gateway tag)`);
        const label = String(body.label ?? "").trim();
        if (!/^[a-zA-Z0-9._\/-]{2,40}$/.test(label)) throw new Error(`agent label '${label}' must be 2-40 chars [a-zA-Z0-9._-]`);
        if (label.includes("/") && !label.startsWith(`${caller}/`)) {
          throw new Error(`namespaced label '${label}' must live under the provisioning gateway's own namespace ('${caller}/...')`);
        }
        const rotate = body.rotate === true;
        const ts = Date.now();
        const existing = this.one(`SELECT id, revoked_ts FROM auth_tokens WHERE label = ?`, label);
        if (existing && !rotate) {
          if (existing.revoked_ts) throw new Error(`token '${label}' was revoked \u2014 provision with rotate to re-mint`);
          return { exists: true, id: existing.id, label };
        }
        if (existing) {
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
            id,
            label,
            hash,
            tags,
            body.principal ?? null,
            ts
          );
        } catch (e) {
          if (!String(e).includes("UNIQUE")) throw e;
          const racer = this.one(`SELECT id FROM auth_tokens WHERE label = ?`, label);
          if (!racer) throw e;
          this.state.storage.sql.exec(
            `UPDATE auth_tokens SET hash = ?, tags = ?, revoked_ts = NULL WHERE id = ?`,
            hash,
            tags,
            racer.id
          );
          id = racer.id;
          this.audit(caller, "rotate", label, { replaced: true, raced: true });
        }
        const ws = this.wsSlug();
        if (ws) {
          const reg = this.env.KB.get(this.env.KB.idFromName(doWs(DEFAULT_WS_SLUG)));
          await reg.fetch("https://kb/ws.token_register", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ hash, ws })
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
      async selfProvision(body, actor) {
        const login = String(body.login ?? "").trim();
        if (!login) throw new Error("self-provision requires the session login (worker-derived)");
        const principal = typeof body.principal === "string" && body.principal.trim() ? body.principal.trim().slice(0, 80) : "";
        const label = selfProvisionLabel(body.host);
        const ws = this.wsSlug() || String(body.ws ?? "");
        const secret = generateAuthToken();
        const hash = await hashAuthToken(secret);
        const mintTags = JSON.stringify(["gateway"]);
        const register = /* @__PURE__ */ __name((h) => this.env.KB.get(this.env.KB.idFromName(doWs(DEFAULT_WS_SLUG))).fetch("https://kb/ws.token_register", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ hash: h, ws })
        }), "register");
        let id;
        let vended;
        let own = principal ? this.one(`SELECT id, label FROM auth_tokens WHERE principal = ?`, principal) : null;
        if (!own) {
          own = this.one(`SELECT id, label FROM auth_tokens WHERE label = ?`, label);
        }
        if (own) {
          this.state.storage.sql.exec(
            `UPDATE auth_tokens SET hash = ?, label = ?, tags = ?, principal = ?, revoked_ts = NULL WHERE id = ?`,
            hash,
            label,
            mintTags,
            principal,
            own.id
          );
          id = own.id;
          await register(hash);
        } else {
          vended = principal || generateAuthToken();
          id = `at_${crypto.randomUUID().slice(0, 8)}`;
          try {
            this.state.storage.sql.exec(
              `INSERT INTO auth_tokens (id, label, hash, tags, transport, principal, created_ts) VALUES (?, ?, ?, ?, 'mcp', ?, ?)`,
              id,
              label,
              hash,
              mintTags,
              vended,
              Date.now()
            );
          } catch (e) {
            if (!String(e).includes("UNIQUE")) throw e;
            const racer = this.one(`SELECT id, principal FROM auth_tokens WHERE label = ?`, label);
            if (!racer) throw e;
            this.state.storage.sql.exec(
              `UPDATE auth_tokens SET hash = ?, tags = ?, revoked_ts = NULL WHERE id = ?`,
              hash,
              mintTags,
              racer.id
            );
            id = racer.id;
            if (racer.principal) vended = racer.principal;
          }
          await register(hash);
        }
        this.audit(actor, "self_provision", null, { label, principal: vended ?? principal, login, ws, token_id: id, replaced: !!own });
        return { secret, label, ws, id, principal: vended ?? principal };
      }
      async tokenMint(body) {
        const label = String(body.label ?? "").trim();
        if (!/^[a-zA-Z0-9._\/-]{2,40}$/.test(label)) throw new Error("label must be 2-40 chars [a-zA-Z0-9._-]");
        if (label.includes("/") && !label.startsWith("_direct/")) {
          throw new Error("labels cannot contain '/' \u2014 only the reserved _direct/ root (directly connected agents) may");
        }
        const principal = typeof body.principal === "string" && body.principal.trim() ? body.principal.trim().slice(0, 80) : null;
        const secret = generateAuthToken();
        const hash = await hashAuthToken(secret);
        let own = principal ? this.one(`SELECT id, label, revoked_ts FROM auth_tokens WHERE principal = ?`, principal) : null;
        const byLabel = this.one(`SELECT id, label, revoked_ts FROM auth_tokens WHERE label = ?`, label);
        if (own && byLabel && own.id !== byLabel.id) {
          this.state.storage.sql.exec(`DELETE FROM auth_tokens WHERE id = ?`, byLabel.id);
          this.audit("pair", "replace", byLabel.id, { label });
        }
        const target = own && !byLabel ? own : byLabel ?? own;
        if (target) {
          const mintTags = Array.isArray(body.tags) ? body.tags.map((t) => String(t).slice(0, 40)).slice(0, 10) : [];
          this.state.storage.sql.exec(
            `UPDATE auth_tokens SET hash = ?, label = ?, tags = ?, principal = COALESCE(?, principal), revoked_ts = NULL WHERE id = ?`,
            hash,
            label,
            JSON.stringify(mintTags),
            principal,
            target.id
          );
          const ws2 = this.wsSlug();
          if (ws2) {
            const reg = this.env.KB.get(this.env.KB.idFromName(doWs(DEFAULT_WS_SLUG)));
            await reg.fetch("https://kb/ws.token_register", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ hash, ws: ws2 })
            });
          }
          this.audit("pair", "reassociate", target.id, { label });
          return { id: target.id, label, secret, reassociated: true };
        }
        const tags = Array.isArray(body.tags) ? body.tags.map((t) => String(t).slice(0, 40)).slice(0, 10) : [];
        const transport = TRANSPORTS.includes(body.transport) ? body.transport : "mcp";
        let id = `at_${crypto.randomUUID().slice(0, 8)}`;
        const ts = Date.now();
        this.state.storage.sql.exec(
          `INSERT INTO auth_tokens (id, label, hash, tags, transport, principal, created_ts) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          id,
          label,
          hash,
          JSON.stringify(tags),
          transport,
          principal,
          ts
        );
        const ws = this.wsSlug();
        if (ws) {
          const reg = this.env.KB.get(this.env.KB.idFromName(doWs(DEFAULT_WS_SLUG)));
          await reg.fetch("https://kb/ws.token_register", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ hash, ws })
          });
        }
        this.audit("admin", "mint", id, { label, transport, tags });
        return { id, label, tags, transport, secret };
      }
      async tokenList() {
        const rows = this.state.storage.sql.exec(
          `SELECT id, label, tags, transport, created_ts, last_seen_ts, revoked_ts FROM auth_tokens ORDER BY created_ts DESC`
        ).toArray();
        const sessions = this.state.storage.sql.exec(
          `SELECT token_id, name, first_seen_ts, last_seen_ts FROM sessions ORDER BY last_seen_ts DESC`
        ).toArray();
        const gateway_agents = this.state.storage.sql.exec(
          `SELECT gateway, agent, last_seen_ts FROM gateway_agents ORDER BY last_seen_ts DESC LIMIT 200`
        ).toArray();
        return { tokens: rows.map((r) => ({ ...r, tags: parseTags(r.tags) })), sessions, gateway_agents };
      }
      async tokenRevoke(body) {
        const id = String(body.id ?? "");
        const row = this.one(`SELECT id, label FROM auth_tokens WHERE id = ?`, id);
        if (!row) throw new Error(`no such auth token: ${id}`);
        this.state.storage.sql.exec(`UPDATE auth_tokens SET revoked_ts = ? WHERE id = ?`, Date.now(), id);
        this.audit("admin", "revoke", id, { label: row.label });
        return { id, revoked: true };
      }
      /** Update an agent's tags (roles/capabilities) in place — no re-mint, the secret stays valid. */
      async tokenTags(body) {
        const id = String(body.id ?? "");
        const row = this.one(`SELECT id, label, tags FROM auth_tokens WHERE id = ?`, id);
        if (!row) throw new Error(`no such auth token: ${id}`);
        const tags = sanitizeTags(body.tags);
        this.state.storage.sql.exec(
          `UPDATE auth_tokens SET tags = ? WHERE id = ?`,
          tags ? JSON.stringify(tags) : "[]",
          id
        );
        this.audit("admin", "tags", id, { label: row.label, tags: tags ?? [] });
        return { id, label: row.label, tags: tags ?? [] };
      }
      async settingsGet() {
        return { settings: this.settingsMap() };
      }
      async settingsSet(body) {
        const entries = Object.entries(body.settings ?? {}).filter(([k]) => /^[a-z0-9_]{1,40}$/.test(k));
        if (entries.length === 0) throw new Error("no valid settings keys (lowercase [a-z0-9_])");
        for (const [k, v] of entries) {
          this.state.storage.sql.exec(
            `INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`,
            k,
            JSON.stringify(v)
          );
          this.audit("admin", "settings", k, {});
        }
        return { settings: this.settingsMap() };
      }
      // ---------- GitHub enrichment ----------
      ghCache = /* @__PURE__ */ new Map();
      async ghIssue(num) {
        if (!this.env.GH_TOKEN) return null;
        const repo = this.settingsMap().github_repo ?? "state-vector/superpositional";
        const key = `${repo}#${num}`;
        const hit = this.ghCache.get(key);
        if (hit && Date.now() - hit.ts < 6e5) return hit.data;
        try {
          const r = await fetch(`https://api.github.com/repos/${repo}/issues/${num}`, {
            headers: {
              authorization: `Bearer ${this.env.GH_TOKEN}`,
              accept: "application/vnd.github+json",
              "user-agent": "bridge-kb"
            }
          });
          if (!r.ok) return null;
          const data = await r.json();
          this.ghCache.set(key, { ts: Date.now(), data });
          return data;
        } catch {
          return null;
        }
      }
      /** Pull issue body/labels into a bare artefact. Idempotent via the "## From GitHub" marker. */
      async enrichFromGitHub(id, num) {
        const row = this.one(`SELECT title, body_md, tags, updated_ts FROM artefacts WHERE id = ?`, id);
        if (!row || (row.body_md ?? "").includes("## From GitHub")) return null;
        const issue = await this.ghIssue(num);
        if (!issue) return null;
        const labels = (issue.labels ?? []).map((l) => String(l.name ?? l));
        const body = `${row.body_md ?? ""}
## From GitHub \u2014 #${num}
**${issue.title}** \xB7 state: ${issue.state}${labels.length ? ` \xB7 labels: ${labels.join(", ")}` : ""}

${String(issue.body ?? "").slice(0, 2e3)}
`;
        const existing = parseTags(row.tags);
        const merged = [.../* @__PURE__ */ new Set([...existing, ...labels.map((l) => l.toLowerCase().replace(/[^a-z0-9:_-]/g, "-"))])].slice(0, 10);
        this.state.storage.sql.exec(
          `UPDATE artefacts SET body_md = ?, tags = ?, updated_ts = ? WHERE id = ?`,
          body,
          JSON.stringify(merged),
          Date.now(),
          id
        );
        await this.embedArtefact(id, row.title, body);
        this.audit("system", "enrich", id, { issue: num });
        return id;
      }
      /** Enrich one or all bare, issue-referencing tasks. */
      async enrich(body, actor) {
        if (!this.env.GH_TOKEN) throw new Error("GH_TOKEN not configured \u2014 GitHub enrichment unavailable");
        const targets = body.id ? [String(body.id)] : this.state.storage.sql.exec(
          `SELECT id, title, body_md FROM artefacts
           WHERE type = 'task' AND status = 'open' OR (type = 'task' AND status IN ('todo','in_progress','blocked'))
           ORDER BY updated_ts DESC LIMIT 50`
        ).toArray().filter((r) => !(r.body_md ?? "").includes("## From GitHub")).map((r) => r.id);
        const done = [];
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
      /** THE append-only ledger — every mutation (kind 'mutation') and every
       *  signal (kind 'signal') is one row in one sequence. events/artefact_versions
       *  are views over this. */
      ledgerWrite(kind, actor, action, artefactId, summary, data) {
        const ts = Date.now();
        const r = this.state.storage.sql.exec(
          `INSERT INTO ledger (ts, actor, kind, action, artefact_id, summary, data) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING seq`,
          ts,
          actor,
          kind,
          action,
          artefactId,
          summary.slice(0, 500),
          JSON.stringify(data)
        ).toArray()[0];
        return { seq: Number(r?.seq ?? 0), ts };
      }
      /** Append-only per-artefact history: every mutation gets one mutation row. */
      version(artefactId, actor, action, summary, data = {}) {
        const { seq, ts } = this.ledgerWrite("mutation", actor, action, artefactId, summary, data);
        this._lastMutation = { key: `${artefactId}:${action}`, seq, ts, actor, action, artefactId, data };
      }
      audit(actor, op, artefactId, detail) {
        const key = `${artefactId}:${op}`;
        let seq;
        let ts;
        const last = this._lastMutation;
        if (last && last.key === key && Date.now() - last.ts < 5e3) {
          ({ seq, ts } = last);
          this.broadcastEvent({ seq, ts, actor: last.actor, op: last.action, artefact_id: last.artefactId, detail: last.data });
          this._lastMutation = null;
          this.scoreCache = null;
          return;
        }
        ({ seq, ts } = this.ledgerWrite("signal", actor, op, artefactId, "", detail));
        this.broadcastEvent({ seq, ts, actor, op, artefact_id: artefactId, detail });
        this.scoreCache = null;
      }
      _lastMutation = null;
      async nextSeq(_type) {
        const rows = this.state.storage.sql.exec(`SELECT id FROM artefacts`).toArray();
        let max = 0;
        for (const r of rows) {
          const m = /^BR#(\d+)$/.exec(String(r.id));
          if (m) max = Math.max(max, parseInt(m[1], 10));
        }
        return max + 1;
      }
      // :any on purpose — rows come back as Record<string, SqlStorageValue> and every
      // caller immediately narrows to the columns it selected; the per-site casts the
      // strict ratchet will want are deferred until that pass (BR#2505 guard landed
      // non-strict on purpose).
      one(query, ...params) {
        return this.state.storage.sql.exec(query, ...params).toArray()[0] ?? null;
      }
      shape(row) {
        return { ...row, meta: JSON.parse(row.meta ?? "{}"), tags: parseTags(row.tags), roles: parseTags(row.roles) };
      }
      json(obj, status = 200) {
        return new Response(JSON.stringify(obj), {
          status,
          headers: { "content-type": "application/json", "cache-control": "no-store" }
        });
      }
    };
    __name(tagsForWrite, "tagsForWrite");
  }
});

// src/mcp.ts
var mcp_exports = {};
__export(mcp_exports, {
  BUILD: () => BUILD,
  KnowledgeHub: () => KnowledgeHub,
  handleMcp: () => handleMcp,
  resolveTokenWs: () => resolveTokenWs
});
async function resolveTokenWs(env, bearer) {
  const embedded = tokenWorkspace(bearer);
  if (embedded) return embedded;
  const hash = await hashAuthToken(bearer);
  const hit = wsRouteCache.get(hash);
  if (hit) return hit;
  const reg = env.KB.get(env.KB.idFromName(doWs(DEFAULT_WS_SLUG)));
  const r = await reg.fetch("https://kb/ws.token_lookup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ hash })
  });
  const out = await r.json().catch(() => ({}));
  const ws = out.ws ?? DEFAULT_WS_SLUG;
  if (wsRouteCache.size < 1e3) wsRouteCache.set(hash, ws);
  return ws;
}
async function handleMcp(request, env) {
  if (request.method !== "POST") {
    return json({ error: "MCP endpoint: POST only" }, 405);
  }
  const bearer = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!bearer) return json({ error: "unauthorized: missing auth token" }, 401);
  let msg;
  try {
    msg = await request.json();
  } catch {
    return json({ error: "bad json" }, 400);
  }
  if (!msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
    return json({ error: "not a JSON-RPC 2.0 request" }, 400);
  }
  if (msg.method.startsWith("notifications/")) {
    return new Response(null, { status: 202 });
  }
  let ws;
  try {
    ws = bearer === (env.BRIDGE_INGEST_TOKEN ?? env.FLOWS_INGEST_TOKEN) ? DEFAULT_WS_SLUG : await resolveTokenWs(env, bearer);
  } catch {
    return json(
      { jsonrpc: "2.0", id: null, error: { code: -32001, message: "unauthorized: unknown or revoked token" } },
      401
    );
  }
  const hub = env.KB.get(env.KB.idFromName(doWs(ws)));
  let identity;
  try {
    if (bearer === (env.BRIDGE_INGEST_TOKEN ?? env.FLOWS_INGEST_TOKEN)) {
      identity = { token_id: "shared", label: "shared", tags: [], principal: null };
    } else {
      identity = await kb(hub, "auth.identify", { bearer });
    }
  } catch (e) {
    return json(
      { jsonrpc: "2.0", id: msg.id ?? null, error: { code: -32001, message: String(e.message) } },
      401
    );
  }
  const sessionName = String(msg.params?.arguments?.session ?? msg.params?.arguments?.__session ?? "");
  const call = /* @__PURE__ */ __name(async (op, payload) => {
    const r = await hub.fetch(`https://kb/${op}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...payload, actor: identity.label, token_id: identity.token_id })
    });
    const out = await r.json();
    if (!r.ok) throw new Error(out.error ?? `kb ${op} failed`);
    return out;
  }, "call");
  let result;
  try {
    switch (msg.method) {
      case "initialize": {
        const pub = await kb(hub, "bootstrap", {});
        const settings = { project_name: pub.project_name, board: pub.board ?? { mode: "none" }, bootstrap_md: pub.bootstrap_md };
        result = {
          protocolVersion: "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "bridge-kb", version: BUILD, description: "Bridge \u2014 work orchestration for agents" },
          instructions: composeBootstrap(
            settings.project_name ?? "this project",
            settings.board ?? { mode: "none" }
          )
        };
        break;
      }
      case "ping":
        result = {};
        break;
      case "tools/list":
        result = { tools: TOOLS };
        break;
      case "tools/call": {
        const name = String(msg.params?.name ?? "");
        const args = msg.params?.arguments ?? {};
        result = await callTool(name, args, { call, identity, sessionName });
        break;
      }
      default:
        return json({ jsonrpc: "2.0", id: msg.id ?? null, error: { code: -32601, message: `method not found: ${msg.method}` } });
    }
  } catch (e) {
    const message2 = String(e.message ?? e);
    if (msg.method === "tools/call") {
      result = {
        content: [{ type: "text", text: `ERROR: ${message2}
Fix the cause and retry. Read the error \u2014 it states the required fix.` }],
        isError: true
      };
    } else {
      return json({ jsonrpc: "2.0", id: msg.id ?? null, error: { code: -32e3, message: message2 } });
    }
  }
  return json({ jsonrpc: "2.0", id: msg.id ?? null, result });
}
async function kb(hub, op, payload) {
  const r = await hub.fetch(`https://kb/${op}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  const out = await r.json();
  if (!r.ok) throw new Error(out.error ?? `kb ${op} failed`);
  return out;
}
async function seeAlso(a, rel, identity, call) {
  const q = [a.title, ...a.tags ?? []].join(" ").slice(0, 300);
  const [sem, kw] = await Promise.all([
    call("related", { id: a.id, limit: 6 }).catch(() => ({ artefacts: [] })),
    q.trim() ? call("search", { q, limit: 6 }).catch(() => ({ artefacts: [] })) : { artefacts: [] }
  ]);
  const byId = /* @__PURE__ */ new Map();
  const put = /* @__PURE__ */ __name((x, why, rank) => {
    if (!x || x.id === a.id) return;
    const e = byId.get(x.id) ?? { ...shallow(x), owner: x.owner, tags: x.tags, why: /* @__PURE__ */ new Set(), _rank: 0 };
    e.why.add(why);
    e._rank = Math.max(e._rank, rank);
    byId.set(x.id, e);
  }, "put");
  for (const r of rel.relations ?? []) {
    const full = r.artefact_id ? await call("get", { id: r.artefact_id }).catch(() => null) : null;
    put(full, r.relation, 0);
  }
  for (const x of sem.artefacts ?? []) put(x, "similar", 1);
  for (const x of kw.artefacts ?? []) put(x, "keyword", 1);
  const rows = [...byId.values()];
  for (const e of rows) {
    const otherClaimed = e.owner && e.owner !== identity.label;
    const otherPublished = !e.owner && e.created_by && e.created_by !== identity.label;
    if (e.type === "task" && OPEN_STATUSES.has(e.status) && (otherClaimed || otherPublished)) {
      e.coordination = true;
      e._rank = -1;
    } else if (e.type === "steering" || e.type === "goal") {
      e._rank = Math.min(e._rank, 2);
    }
  }
  rows.sort((x, y) => x._rank - y._rank || y.updated_ts - x.updated_ts);
  for (const e of rows) {
    delete e._rank;
    e.why = [...e.why];
  }
  return rows.slice(0, 8);
}
async function callTool(name, args, ctx) {
  const { call, identity } = ctx;
  const isGatewayToken = identity.tags.some((t) => t.toLowerCase() === "gateway");
  args.gateway = isGatewayToken;
  if (!isGatewayToken) delete args.agent;
  else if (args.agent != null) args.agent = String(args.agent).trim().slice(0, 60);
  switch (name) {
    case "orient": {
      const session = await call("session.touch", { token_id: identity.token_id, session: args.session ?? ctx.sessionName, worktree: args.worktree });
      const o = await call("orient", { label: identity.label, tags: identity.tags });
      const named = args.session ?? ctx.sessionName;
      const required = Array.isArray(o.action_required) ? o.action_required : [];
      return text(JSON.stringify(
        {
          ...o,
          build: BUILD,
          you: { agent: identity.label, session: session.session, worktree: session.worktree, tags: identity.tags },
          note: required.length ? `ACT NOW \u2014 handle each of these before anything else:
${required.join("\n")}` : named ? void 0 : 'you did not name this session \u2014 pass session: "<unique-name>" on orient next time'
        },
        null,
        1
      ));
    }
    case "search_knowledge":
      return text(JSON.stringify(await call("search", { q: args.q, type: args.type, limit: args.limit })));
    case "provenance":
      return text(JSON.stringify(await call("provenance", { sha: String(args.sha ?? "") })));
    case "get_artefact": {
      const a = await call("get", { id: args.id });
      const rel = await call("relations", { id: args.id });
      const also = await seeAlso(a, rel, identity, call);
      const overlap = also.filter((s) => s.coordination);
      const isTask2 = a.type === "task";
      const aTags = Array.isArray(a.tags) ? a.tags : [];
      const m = a.meta ?? {};
      const isQuestion = aTags.includes("question");
      const gated = m.operator_gated;
      const traits = isTask2 ? {
        is_question: isQuestion,
        is_claimable: isTask2 && ["todo", "blocked"].includes(a.status ?? "") && !isQuestion && !gated,
        claim_reason: isQuestion ? "question \u2014 answered, not claimed (contribute via log_progress {id, did})" : gated ? `operator gated: ${gated} \u2014 a human clears the gate` : ["todo", "blocked"].includes(a.status ?? "") ? void 0 : `status '${a.status}' is not claimable (claim = todo \u2192 in_progress)`,
        previously_attempted: (m.attempt?.attempts ?? 0) > 0 ? m.attempt : void 0
      } : void 0;
      return text(JSON.stringify({
        ...a,
        ...traits ? { traits } : {},
        relations: rel.relations,
        see_also: also,
        coordination: overlap.length ? `${overlap.length} open task(s) in this area are owned by other agents: ${overlap.map((s) => `${s.id} (${s.owner})`).join(", ")} \u2014 coordinate before building. ask_agent them, don't fork.` : void 0
      }, null, 1));
    }
    case "create_artefact":
      return text(JSON.stringify(await call("create", { ...args, session: args.session, token_id: identity.token_id })));
    case "update_artefact":
      return text(JSON.stringify(await call("update", args)));
    case "transition":
      return text(JSON.stringify({
        ...await call("transition", { ...args, session: args.session ?? ctx.sessionName, token_id: identity.token_id }),
        note: args.to === "in_progress" ? "claimed. heartbeat: log_progress every \u226410m while in_progress." : args.to === "in_review" ? `in_review. PR is open \u2014 your duty is NOT done. You stay owner until the verdict. A Verify task was auto-spawned into the pool${args.note && /https?:\/\//.test(String(args.note)) ? " (seeded with your PR link)" : ""} \u2014 any agent in a fresh session can pick it up. Poll get_history {id} for the verdict: bounce (findings in the note \u2014 action them) or done (released). Reviews can stack: work other tasks while waiting, but keep polling this one.` : args.to === "blocked" ? args.class === "subprocess" ? `subprocess declared \u2014 the task STAYS in_progress (a subprocess wait is not blocked; blocked means awaiting other tasks/decisions). watchdog paused until ${args.budget_minutes}m from now \u2014 past it the silence converts to abandoned. re-claim: log_progress on the task when the subprocess resolves.` : "blocked. an open ask bound to this task pauses the watchdog; otherwise keep the heartbeat or declare grace." : args.to === "done" ? "done. you are released from this task. outcome belongs in Knowledge \u2014 publish decision or knowledge artefacts for anything reusable." : args.to === "todo" ? "released to the pool. the card is tagged 'attempted' \u2014 the next agent verifies state first. if this was a wrong claim (overlap, missing access), say why in the note." : void 0
      }));
    case "link_artefacts":
      return text(JSON.stringify(await call("link", args)));
    case "list_agents": {
      const a = await call("agents.list", {});
      return text(JSON.stringify(a, null, 1));
    }
    case "stats": {
      const a = await call("stats", {});
      return text(JSON.stringify(a, null, 1));
    }
    case "related_artefacts": {
      const a = await call("related", { id: args.id, limit: args.limit });
      return text(JSON.stringify(a, null, 1));
    }
    case "get_history": {
      const h = await call("get_history", { id: args.id, limit: args.limit });
      return text(JSON.stringify(h, null, 1));
    }
    case "session_alive": {
      const a = await call("session.alive", { ...args, session: args.session ?? ctx.sessionName, token_id: identity.token_id });
      return text(JSON.stringify(a));
    }
    case "log_progress": {
      const a = await call("progress.log", { ...args, session: args.session ?? ctx.sessionName, token_id: identity.token_id });
      const hasGauges = args.completion_pct != null || args.confidence_pct != null || args.risk_pct != null || args.context_pct != null;
      const graceUntil = typeof a.grace_until === "number" ? a.grace_until : void 0;
      return text(JSON.stringify({
        ...a,
        note: graceUntil ? `grace declared \u2014 watchdog paused until ${new Date(graceUntil).toISOString()} (${args.grace_minutes}m). Overrun it and the task is abandoned. Re-claim with log_progress when back.` : hasGauges ? void 0 : "logged without gauges. include completion_pct / confidence_pct / risk_pct / context_pct \u2014 they chart on the card, drive prioritisation, and count toward your score."
      }));
    }
    case "ask_agent": {
      const a = await call("ask.create", { to: args.to ?? "any", question: args.question, reason: args.reason, details: args.details, options: args.options, artefact_id: args.artefact_id });
      return text(JSON.stringify({
        ...a,
        note: a.task_status === "blocked" ? "your task is now blocked-on-decision (watchdog paused for it) and the ask is published in the Bridge app. check asks for the answer." : "they will see it on their next orient. check yours too."
      }));
    }
    case "asks": {
      const inbox = await call("ask.inbox", { label: identity.label, tags: identity.tags });
      return text(JSON.stringify(inbox, null, 1));
    }
    case "answer_ask": {
      const a = await call("ask.answer", { id: args.id, answer: args.answer });
      return text(JSON.stringify(a));
    }
    default:
      return err(`unknown tool: ${name}`);
  }
}
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" }
  });
}
var BUILD, wsRouteCache, OPEN_STATUSES, shallow, text, err, TOOLS;
var init_mcp = __esm({
  "src/mcp.ts"() {
    init_core();
    init_do();
    BUILD = "0.3.5";
    wsRouteCache = /* @__PURE__ */ new Map();
    __name(resolveTokenWs, "resolveTokenWs");
    __name(handleMcp, "handleMcp");
    __name(kb, "kb");
    OPEN_STATUSES = /* @__PURE__ */ new Set(["todo", "in_progress", "blocked", "draft", "proposed", "active", "open"]);
    __name(seeAlso, "seeAlso");
    __name(callTool, "callTool");
    shallow = /* @__PURE__ */ __name((a) => ({ id: a.id, type: a.type, title: a.title, status: a.status, updated_ts: a.updated_ts, created_by: a.created_by }), "shallow");
    text = /* @__PURE__ */ __name((t) => ({ content: [{ type: "text", text: t }] }), "text");
    err = /* @__PURE__ */ __name((t) => ({ content: [{ type: "text", text: t }], isError: true }), "err");
    TOOLS = [
      {
        name: "orient",
        description: 'Session bootstrap + project overview. Always pass session: "<unique-name>". When working in a provisioned git worktree, pass worktree: "<path>" so the board can see where your tree lives (BR#3204 collision visibility). Returns goals, open work, pending asks for you, project flags.',
        inputSchema: {
          type: "object",
          properties: {
            session: { type: "string", description: "unique session name (per agent)" },
            worktree: { type: "string", description: "path of the git worktree this session works in (optional)" }
          }
        }
      },
      {
        name: "search_knowledge",
        description: "Full-text search over artefacts.",
        inputSchema: {
          type: "object",
          required: ["q"],
          properties: {
            q: { type: "string" },
            type: { type: "string", enum: ARTEFACT_TYPES },
            limit: { type: "integer", maximum: 100 }
          }
        }
      },
      {
        name: "get_artefact",
        description: "Read one artefact by id, with its relations. Returns see_also: related work, docs, and goals \u2014 including open tasks owned by OTHER agents (coordination flag) \u2014 so you discover overlap before building.",
        inputSchema: { type: "object", required: ["id"], properties: { id: { type: "string" } } }
      },
      {
        name: "create_artefact",
        description: `Create an artefact. Types: ${ARTEFACT_TYPES.join(", ")}.`,
        inputSchema: {
          type: "object",
          required: ["type", "title"],
          properties: {
            type: { type: "string", enum: ARTEFACT_TYPES },
            title: { type: "string", maxLength: 300 },
            body_md: { type: "string" },
            meta: { type: "object" },
            owner: { type: "string", description: "leave empty for tasks \u2014 work enters as unclaimed todo; set only to pre-assign" },
            project: { type: "string", description: "project slug, e.g. superpositional or bridge; defaults to the deployment's project" },
            qualified: { type: "boolean", description: "declare you already analysed this task \u2014 it goes ready for pickup (publishers are scored on the quality of their self-qualified tasks)" },
            await: { type: "array", items: { type: "string" }, description: 'stacked qualification: further confirmation required before pickup, e.g. ["review"] \u2014 satisfied by a done child of that role or an accepted decision' },
            tags: { type: "array", items: { type: "string" }, description: "user-defined categories \u2014 fully free-form, no system meaning; they render and filter in the UI (e.g. [gtm, deploy-train, pricing])" },
            roles: { type: "array", items: { type: "string", enum: ["impl", "analysis", "review", "unblock", "human"] }, description: "dispatch/gating lane for task children \u2014 what the machine enforces (verify children are review, unblock children unblock). Never express roles as tags." },
            session: { type: "string", description: "your session name \u2014 attributes the card to your session" }
          }
        }
      },
      {
        name: "update_artefact",
        description: "Edit title/body/meta/tags/roles. Does not change status \u2014 use transition.",
        inputSchema: {
          type: "object",
          required: ["id"],
          properties: {
            id: { type: "string" },
            title: { type: "string" },
            body_md: { type: "string" },
            meta: { type: "object" },
            tags: { type: "array", items: { type: "string" }, description: "replaces the user-defined category tags (free-form, inert)" },
            roles: { type: "array", items: { type: "string", enum: ["impl", "analysis", "review", "unblock", "human"] }, description: "replaces the dispatch/gating roles" }
          }
        }
      },
      {
        name: "transition",
        description: `Move artefact status under its lifecycle. Per type: ${Object.entries(LIFECYCLES).map(([t, m]) => `${t}: ${Object.entries(m).map(([f, tos]) => `${f}\u2192${tos.join("|")}`).join(", ")}`).join("; ")}. Moving to blocked REQUIRES note (reason) + unblock_condition \u2014 no dead-end cards. For a long/handed-off op (re-index, deploy, background batch): transition {to: "blocked", class: "subprocess", note, unblock_condition, budget_minutes} \u2014 watchdog paused until the budget lapses; past it the block converts to abandoned.`,
        inputSchema: {
          type: "object",
          required: ["id", "to"],
          properties: {
            id: { type: "string" },
            to: { type: "string" },
            note: { type: "string", description: "required when moving to blocked: the reason" },
            unblock_condition: { type: "string", description: "required when moving to blocked: what unblocks it" },
            class: { type: "string", enum: ["subprocess"], description: "blocked class: subprocess = declared block on a long op; requires budget_minutes" },
            budget_minutes: { type: "integer", maximum: 1440, description: "declared budget for class: subprocess (1-1440); watchdog paused until it lapses" },
            replacement_id: { type: "string", description: "for superseded: the replacing artefact" }
          }
        }
      },
      {
        name: "link_artefacts",
        description: `Typed relation. Relations: ${RELATIONS.join(", ")}.`,
        inputSchema: {
          type: "object",
          required: ["src", "relation", "dst"],
          properties: {
            src: { type: "string" },
            relation: { type: "string", enum: RELATIONS },
            dst: { type: "string" }
          }
        }
      },
      {
        name: "list_agents",
        description: "List connected identities \u2014 `agents` (label, capability tags, online) and `gateways` (each with the agent labels it dispatched recently). Address ask_agent at agent labels; gateways are infrastructure, not peers.",
        inputSchema: { type: "object", properties: {} }
      },
      {
        name: "stats",
        description: "Board + watchdog liveness: counts by type/status, watchdog last tick and last sweep (stale in_progress/in_review, open asks). Answers 'is the watchdog alive?' and 'how much work is stale?' without touching DO internals.",
        inputSchema: { type: "object", properties: {} }
      },
      {
        name: "related_artefacts",
        description: "Artefacts semantically related to X \u2014 what supports, constrains or invalidates it.",
        inputSchema: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string" }, limit: { type: "integer", maximum: 50 } }
        }
      },
      {
        name: "provenance",
        description: "PR provenance (BR#3287): commit sha \u2192 PR \u2192 producing task \u2192 verify verdict \u2192 agent session \u2192 signer class. sha = the merge or head commit, 7-40 hex. Unknown sha returns an honest 'no bridge provenance' error (direct push / unindexed).",
        inputSchema: {
          type: "object",
          required: ["sha"],
          properties: { sha: { type: "string", description: "merge or head commit sha, 7-40 hex" } }
        }
      },
      {
        name: "session_alive",
        description: "Runner-side liveness vouch: the session process is alive and producing output (stdout/ACP stream moved). Updates the watchdog liveness stamp only \u2014 no board event, no progress entry. Called by the runner, throttled; agents should use log_progress for narrative.",
        inputSchema: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string", description: "task artefact id" } }
        }
      },
      {
        name: "log_progress",
        description: "Fine-grained progress while working a task: did (what just happened; alias: note) + will (what you do next) + sentiment (going_well | neutral | struggling | converging | diverging) + optional gauges (completion_pct, confidence_pct, risk_pct \u2014 0-100 ints). Send often \u2014 feeds the live board and charts. Declaring a quiet stretch? pass grace_minutes (1-60) + will naming the op \u2014 the watchdog pauses until it lapses.",
        inputSchema: {
          type: "object",
          required: ["id", "note"],
          properties: {
            id: { type: "string", description: "task artefact id" },
            will: { type: "string", description: "what you will do next \u2014 the intent line the board shows while you work" },
            grace_minutes: { type: "integer", maximum: 60, description: "declared silence window for a long op (requires will) \u2014 watchdog paused until it lapses; overrun = abandoned" },
            note: { type: "string" },
            sentiment: { type: "string", enum: ["going_well", "neutral", "struggling", "converging", "diverging"] },
            completion_pct: { type: "integer", minimum: 0, maximum: 100 },
            confidence_pct: { type: "integer", minimum: 0, maximum: 100 },
            risk_pct: { type: "integer", minimum: 0, maximum: 100 },
            context_pct: { type: "integer", minimum: 0, maximum: 100, description: "how full your context window is (0-100) \u2014 lets the board track context pressure and spot sessions that should hand off before degrading" }
          }
        }
      },
      {
        name: "get_history",
        description: "Full version history of an artefact: every mutation, who did it, when, what changed.",
        inputSchema: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string" }, limit: { type: "integer", maximum: 200 } }
        }
      },
      {
        name: "ask_agent",
        description: `Ask another agent or the human for insight/help/decisions. to: agent label, label@session, tag:<capability> (e.g. tag:datadog-access), 'human', or any. BLOCKED ON A DECISION? pass artefact_id (your task) \u2014 the task goes blocked-on-decision, the watchdog pauses for it, and the ask is published in the Bridge app; you resume automatically when it's answered. OPTIONS ARE REQUIRED: give the human 2-8 one-click answers (e.g. ["GO \u2014 merge now", "NO-GO \u2014 hold"]) \u2014 they answer by clicking, and the ask is rejected without them.`,
        inputSchema: {
          type: "object",
          required: ["question", "options", "reason"],
          properties: {
            to: { type: "string", description: "default: any" },
            question: { type: "string", description: "THE ASK ITSELF \u2014 an answerable question ending in ?, <=240 chars. Canonical: Do you want to merge PR #123 into main? NOT a status report \u2014 reports go in details" },
            reason: { type: "string", description: "REQUIRED: WHY this is escalated instead of automatic \u2014 one sentence. Canonical: PR is failing SP Review, but your guidance says this is tolerable if I rebut. Rebuttal in body." },
            details: { type: "string", description: "context, receipts, narrative \u2014 rendered as markdown below the question" },
            options: { type: "array", items: { type: "string" }, minItems: 2, maxItems: 8, description: "REQUIRED: 2-8 one-click answer options for the human" },
            artefact_id: { type: "string", description: "your blocked task \u2014 links the decision, pauses the watchdog, auto-resumes on answer" }
          }
        }
      },
      {
        name: "asks",
        description: "Your ask inbox (open asks addressed to you) + asks you sent (with answers).",
        inputSchema: { type: "object", properties: {} }
      },
      {
        name: "answer_ask",
        description: "Answer an ask from your inbox.",
        inputSchema: {
          type: "object",
          required: ["id", "answer"],
          properties: {
            id: { type: "string", description: "BR# id of the question task to answer (asks are BR#-numbered question nodes, not ASK-* artefact ids)" },
            answer: { type: "string" }
          }
        }
      }
    ];
    __name(json, "json");
  }
});

// src/__version.json
var require_version = __commonJS({
  "src/__version.json"(exports, module) {
    module.exports = { commit: "66c0765944cf527a1e90df091178482876f7277c", built_at: "2026-10-25T12:19:43Z" };
  }
});

// ../../node_modules/jose/dist/browser/runtime/webcrypto.js
var webcrypto_default, isCryptoKey;
var init_webcrypto = __esm({
  "../../node_modules/jose/dist/browser/runtime/webcrypto.js"() {
    webcrypto_default = crypto;
    isCryptoKey = /* @__PURE__ */ __name((key) => key instanceof CryptoKey, "isCryptoKey");
  }
});

// ../../node_modules/jose/dist/browser/runtime/digest.js
var digest, digest_default;
var init_digest = __esm({
  "../../node_modules/jose/dist/browser/runtime/digest.js"() {
    init_webcrypto();
    digest = /* @__PURE__ */ __name(async (algorithm, data) => {
      const subtleDigest = `SHA-${algorithm.slice(-3)}`;
      return new Uint8Array(await webcrypto_default.subtle.digest(subtleDigest, data));
    }, "digest");
    digest_default = digest;
  }
});

// ../../node_modules/jose/dist/browser/lib/buffer_utils.js
function concat(...buffers) {
  const size = buffers.reduce((acc, { length }) => acc + length, 0);
  const buf = new Uint8Array(size);
  let i = 0;
  for (const buffer of buffers) {
    buf.set(buffer, i);
    i += buffer.length;
  }
  return buf;
}
function p2s(alg, p2sInput) {
  return concat(encoder.encode(alg), new Uint8Array([0]), p2sInput);
}
function writeUInt32BE(buf, value, offset) {
  if (value < 0 || value >= MAX_INT32) {
    throw new RangeError(`value must be >= 0 and <= ${MAX_INT32 - 1}. Received ${value}`);
  }
  buf.set([value >>> 24, value >>> 16, value >>> 8, value & 255], offset);
}
function uint64be(value) {
  const high = Math.floor(value / MAX_INT32);
  const low = value % MAX_INT32;
  const buf = new Uint8Array(8);
  writeUInt32BE(buf, high, 0);
  writeUInt32BE(buf, low, 4);
  return buf;
}
function uint32be(value) {
  const buf = new Uint8Array(4);
  writeUInt32BE(buf, value);
  return buf;
}
function lengthAndInput(input) {
  return concat(uint32be(input.length), input);
}
async function concatKdf(secret, bits, value) {
  const iterations = Math.ceil((bits >> 3) / 32);
  const res = new Uint8Array(iterations * 32);
  for (let iter = 0; iter < iterations; iter++) {
    const buf = new Uint8Array(4 + secret.length + value.length);
    buf.set(uint32be(iter + 1));
    buf.set(secret, 4);
    buf.set(value, 4 + secret.length);
    res.set(await digest_default("sha256", buf), iter * 32);
  }
  return res.slice(0, bits >> 3);
}
var encoder, decoder, MAX_INT32;
var init_buffer_utils = __esm({
  "../../node_modules/jose/dist/browser/lib/buffer_utils.js"() {
    init_digest();
    encoder = new TextEncoder();
    decoder = new TextDecoder();
    MAX_INT32 = 2 ** 32;
    __name(concat, "concat");
    __name(p2s, "p2s");
    __name(writeUInt32BE, "writeUInt32BE");
    __name(uint64be, "uint64be");
    __name(uint32be, "uint32be");
    __name(lengthAndInput, "lengthAndInput");
    __name(concatKdf, "concatKdf");
  }
});

// ../../node_modules/jose/dist/browser/runtime/base64url.js
var encodeBase64, encode, decodeBase64, decode;
var init_base64url = __esm({
  "../../node_modules/jose/dist/browser/runtime/base64url.js"() {
    init_buffer_utils();
    encodeBase64 = /* @__PURE__ */ __name((input) => {
      let unencoded = input;
      if (typeof unencoded === "string") {
        unencoded = encoder.encode(unencoded);
      }
      const CHUNK_SIZE = 32768;
      const arr = [];
      for (let i = 0; i < unencoded.length; i += CHUNK_SIZE) {
        arr.push(String.fromCharCode.apply(null, unencoded.subarray(i, i + CHUNK_SIZE)));
      }
      return btoa(arr.join(""));
    }, "encodeBase64");
    encode = /* @__PURE__ */ __name((input) => {
      return encodeBase64(input).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
    }, "encode");
    decodeBase64 = /* @__PURE__ */ __name((encoded) => {
      const binary = atob(encoded);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
      }
      return bytes;
    }, "decodeBase64");
    decode = /* @__PURE__ */ __name((input) => {
      let encoded = input;
      if (encoded instanceof Uint8Array) {
        encoded = decoder.decode(encoded);
      }
      encoded = encoded.replace(/-/g, "+").replace(/_/g, "/").replace(/\s/g, "");
      try {
        return decodeBase64(encoded);
      } catch {
        throw new TypeError("The input to be decoded is not correctly encoded.");
      }
    }, "decode");
  }
});

// ../../node_modules/jose/dist/browser/util/errors.js
var errors_exports = {};
__export(errors_exports, {
  JOSEAlgNotAllowed: () => JOSEAlgNotAllowed,
  JOSEError: () => JOSEError,
  JOSENotSupported: () => JOSENotSupported,
  JWEDecryptionFailed: () => JWEDecryptionFailed,
  JWEInvalid: () => JWEInvalid,
  JWKInvalid: () => JWKInvalid,
  JWKSInvalid: () => JWKSInvalid,
  JWKSMultipleMatchingKeys: () => JWKSMultipleMatchingKeys,
  JWKSNoMatchingKey: () => JWKSNoMatchingKey,
  JWKSTimeout: () => JWKSTimeout,
  JWSInvalid: () => JWSInvalid,
  JWSSignatureVerificationFailed: () => JWSSignatureVerificationFailed,
  JWTClaimValidationFailed: () => JWTClaimValidationFailed,
  JWTExpired: () => JWTExpired,
  JWTInvalid: () => JWTInvalid
});
var JOSEError, JWTClaimValidationFailed, JWTExpired, JOSEAlgNotAllowed, JOSENotSupported, JWEDecryptionFailed, JWEInvalid, JWSInvalid, JWTInvalid, JWKInvalid, JWKSInvalid, JWKSNoMatchingKey, JWKSMultipleMatchingKeys, JWKSTimeout, JWSSignatureVerificationFailed;
var init_errors = __esm({
  "../../node_modules/jose/dist/browser/util/errors.js"() {
    JOSEError = class extends Error {
      static {
        __name(this, "JOSEError");
      }
      constructor(message2, options) {
        super(message2, options);
        this.code = "ERR_JOSE_GENERIC";
        this.name = this.constructor.name;
        Error.captureStackTrace?.(this, this.constructor);
      }
    };
    JOSEError.code = "ERR_JOSE_GENERIC";
    JWTClaimValidationFailed = class extends JOSEError {
      static {
        __name(this, "JWTClaimValidationFailed");
      }
      constructor(message2, payload, claim = "unspecified", reason = "unspecified") {
        super(message2, { cause: { claim, reason, payload } });
        this.code = "ERR_JWT_CLAIM_VALIDATION_FAILED";
        this.claim = claim;
        this.reason = reason;
        this.payload = payload;
      }
    };
    JWTClaimValidationFailed.code = "ERR_JWT_CLAIM_VALIDATION_FAILED";
    JWTExpired = class extends JOSEError {
      static {
        __name(this, "JWTExpired");
      }
      constructor(message2, payload, claim = "unspecified", reason = "unspecified") {
        super(message2, { cause: { claim, reason, payload } });
        this.code = "ERR_JWT_EXPIRED";
        this.claim = claim;
        this.reason = reason;
        this.payload = payload;
      }
    };
    JWTExpired.code = "ERR_JWT_EXPIRED";
    JOSEAlgNotAllowed = class extends JOSEError {
      static {
        __name(this, "JOSEAlgNotAllowed");
      }
      constructor() {
        super(...arguments);
        this.code = "ERR_JOSE_ALG_NOT_ALLOWED";
      }
    };
    JOSEAlgNotAllowed.code = "ERR_JOSE_ALG_NOT_ALLOWED";
    JOSENotSupported = class extends JOSEError {
      static {
        __name(this, "JOSENotSupported");
      }
      constructor() {
        super(...arguments);
        this.code = "ERR_JOSE_NOT_SUPPORTED";
      }
    };
    JOSENotSupported.code = "ERR_JOSE_NOT_SUPPORTED";
    JWEDecryptionFailed = class extends JOSEError {
      static {
        __name(this, "JWEDecryptionFailed");
      }
      constructor(message2 = "decryption operation failed", options) {
        super(message2, options);
        this.code = "ERR_JWE_DECRYPTION_FAILED";
      }
    };
    JWEDecryptionFailed.code = "ERR_JWE_DECRYPTION_FAILED";
    JWEInvalid = class extends JOSEError {
      static {
        __name(this, "JWEInvalid");
      }
      constructor() {
        super(...arguments);
        this.code = "ERR_JWE_INVALID";
      }
    };
    JWEInvalid.code = "ERR_JWE_INVALID";
    JWSInvalid = class extends JOSEError {
      static {
        __name(this, "JWSInvalid");
      }
      constructor() {
        super(...arguments);
        this.code = "ERR_JWS_INVALID";
      }
    };
    JWSInvalid.code = "ERR_JWS_INVALID";
    JWTInvalid = class extends JOSEError {
      static {
        __name(this, "JWTInvalid");
      }
      constructor() {
        super(...arguments);
        this.code = "ERR_JWT_INVALID";
      }
    };
    JWTInvalid.code = "ERR_JWT_INVALID";
    JWKInvalid = class extends JOSEError {
      static {
        __name(this, "JWKInvalid");
      }
      constructor() {
        super(...arguments);
        this.code = "ERR_JWK_INVALID";
      }
    };
    JWKInvalid.code = "ERR_JWK_INVALID";
    JWKSInvalid = class extends JOSEError {
      static {
        __name(this, "JWKSInvalid");
      }
      constructor() {
        super(...arguments);
        this.code = "ERR_JWKS_INVALID";
      }
    };
    JWKSInvalid.code = "ERR_JWKS_INVALID";
    JWKSNoMatchingKey = class extends JOSEError {
      static {
        __name(this, "JWKSNoMatchingKey");
      }
      constructor(message2 = "no applicable key found in the JSON Web Key Set", options) {
        super(message2, options);
        this.code = "ERR_JWKS_NO_MATCHING_KEY";
      }
    };
    JWKSNoMatchingKey.code = "ERR_JWKS_NO_MATCHING_KEY";
    JWKSMultipleMatchingKeys = class extends JOSEError {
      static {
        __name(this, "JWKSMultipleMatchingKeys");
      }
      constructor(message2 = "multiple matching keys found in the JSON Web Key Set", options) {
        super(message2, options);
        this.code = "ERR_JWKS_MULTIPLE_MATCHING_KEYS";
      }
    };
    JWKSMultipleMatchingKeys.code = "ERR_JWKS_MULTIPLE_MATCHING_KEYS";
    JWKSTimeout = class extends JOSEError {
      static {
        __name(this, "JWKSTimeout");
      }
      constructor(message2 = "request timed out", options) {
        super(message2, options);
        this.code = "ERR_JWKS_TIMEOUT";
      }
    };
    JWKSTimeout.code = "ERR_JWKS_TIMEOUT";
    JWSSignatureVerificationFailed = class extends JOSEError {
      static {
        __name(this, "JWSSignatureVerificationFailed");
      }
      constructor(message2 = "signature verification failed", options) {
        super(message2, options);
        this.code = "ERR_JWS_SIGNATURE_VERIFICATION_FAILED";
      }
    };
    JWSSignatureVerificationFailed.code = "ERR_JWS_SIGNATURE_VERIFICATION_FAILED";
  }
});

// ../../node_modules/jose/dist/browser/runtime/random.js
var random_default;
var init_random = __esm({
  "../../node_modules/jose/dist/browser/runtime/random.js"() {
    init_webcrypto();
    random_default = webcrypto_default.getRandomValues.bind(webcrypto_default);
  }
});

// ../../node_modules/jose/dist/browser/lib/iv.js
function bitLength(alg) {
  switch (alg) {
    case "A128GCM":
    case "A128GCMKW":
    case "A192GCM":
    case "A192GCMKW":
    case "A256GCM":
    case "A256GCMKW":
      return 96;
    case "A128CBC-HS256":
    case "A192CBC-HS384":
    case "A256CBC-HS512":
      return 128;
    default:
      throw new JOSENotSupported(`Unsupported JWE Algorithm: ${alg}`);
  }
}
var iv_default;
var init_iv = __esm({
  "../../node_modules/jose/dist/browser/lib/iv.js"() {
    init_errors();
    init_random();
    __name(bitLength, "bitLength");
    iv_default = /* @__PURE__ */ __name((alg) => random_default(new Uint8Array(bitLength(alg) >> 3)), "default");
  }
});

// ../../node_modules/jose/dist/browser/lib/check_iv_length.js
var checkIvLength, check_iv_length_default;
var init_check_iv_length = __esm({
  "../../node_modules/jose/dist/browser/lib/check_iv_length.js"() {
    init_errors();
    init_iv();
    checkIvLength = /* @__PURE__ */ __name((enc, iv) => {
      if (iv.length << 3 !== bitLength(enc)) {
        throw new JWEInvalid("Invalid Initialization Vector length");
      }
    }, "checkIvLength");
    check_iv_length_default = checkIvLength;
  }
});

// ../../node_modules/jose/dist/browser/runtime/check_cek_length.js
var checkCekLength, check_cek_length_default;
var init_check_cek_length = __esm({
  "../../node_modules/jose/dist/browser/runtime/check_cek_length.js"() {
    init_errors();
    checkCekLength = /* @__PURE__ */ __name((cek, expected) => {
      const actual = cek.byteLength << 3;
      if (actual !== expected) {
        throw new JWEInvalid(`Invalid Content Encryption Key length. Expected ${expected} bits, got ${actual} bits`);
      }
    }, "checkCekLength");
    check_cek_length_default = checkCekLength;
  }
});

// ../../node_modules/jose/dist/browser/runtime/timing_safe_equal.js
var timingSafeEqual, timing_safe_equal_default;
var init_timing_safe_equal = __esm({
  "../../node_modules/jose/dist/browser/runtime/timing_safe_equal.js"() {
    timingSafeEqual = /* @__PURE__ */ __name((a, b) => {
      if (!(a instanceof Uint8Array)) {
        throw new TypeError("First argument must be a buffer");
      }
      if (!(b instanceof Uint8Array)) {
        throw new TypeError("Second argument must be a buffer");
      }
      if (a.length !== b.length) {
        throw new TypeError("Input buffers must have the same length");
      }
      const len = a.length;
      let out = 0;
      let i = -1;
      while (++i < len) {
        out |= a[i] ^ b[i];
      }
      return out === 0;
    }, "timingSafeEqual");
    timing_safe_equal_default = timingSafeEqual;
  }
});

// ../../node_modules/jose/dist/browser/lib/crypto_key.js
function unusable(name, prop = "algorithm.name") {
  return new TypeError(`CryptoKey does not support this operation, its ${prop} must be ${name}`);
}
function isAlgorithm(algorithm, name) {
  return algorithm.name === name;
}
function getHashLength(hash) {
  return parseInt(hash.name.slice(4), 10);
}
function getNamedCurve(alg) {
  switch (alg) {
    case "ES256":
      return "P-256";
    case "ES384":
      return "P-384";
    case "ES512":
      return "P-521";
    default:
      throw new Error("unreachable");
  }
}
function checkUsage(key, usages) {
  if (usages.length && !usages.some((expected) => key.usages.includes(expected))) {
    let msg = "CryptoKey does not support this operation, its usages must include ";
    if (usages.length > 2) {
      const last = usages.pop();
      msg += `one of ${usages.join(", ")}, or ${last}.`;
    } else if (usages.length === 2) {
      msg += `one of ${usages[0]} or ${usages[1]}.`;
    } else {
      msg += `${usages[0]}.`;
    }
    throw new TypeError(msg);
  }
}
function checkSigCryptoKey(key, alg, ...usages) {
  switch (alg) {
    case "HS256":
    case "HS384":
    case "HS512": {
      if (!isAlgorithm(key.algorithm, "HMAC"))
        throw unusable("HMAC");
      const expected = parseInt(alg.slice(2), 10);
      const actual = getHashLength(key.algorithm.hash);
      if (actual !== expected)
        throw unusable(`SHA-${expected}`, "algorithm.hash");
      break;
    }
    case "RS256":
    case "RS384":
    case "RS512": {
      if (!isAlgorithm(key.algorithm, "RSASSA-PKCS1-v1_5"))
        throw unusable("RSASSA-PKCS1-v1_5");
      const expected = parseInt(alg.slice(2), 10);
      const actual = getHashLength(key.algorithm.hash);
      if (actual !== expected)
        throw unusable(`SHA-${expected}`, "algorithm.hash");
      break;
    }
    case "PS256":
    case "PS384":
    case "PS512": {
      if (!isAlgorithm(key.algorithm, "RSA-PSS"))
        throw unusable("RSA-PSS");
      const expected = parseInt(alg.slice(2), 10);
      const actual = getHashLength(key.algorithm.hash);
      if (actual !== expected)
        throw unusable(`SHA-${expected}`, "algorithm.hash");
      break;
    }
    case "EdDSA": {
      if (key.algorithm.name !== "Ed25519" && key.algorithm.name !== "Ed448") {
        throw unusable("Ed25519 or Ed448");
      }
      break;
    }
    case "Ed25519": {
      if (!isAlgorithm(key.algorithm, "Ed25519"))
        throw unusable("Ed25519");
      break;
    }
    case "ES256":
    case "ES384":
    case "ES512": {
      if (!isAlgorithm(key.algorithm, "ECDSA"))
        throw unusable("ECDSA");
      const expected = getNamedCurve(alg);
      const actual = key.algorithm.namedCurve;
      if (actual !== expected)
        throw unusable(expected, "algorithm.namedCurve");
      break;
    }
    default:
      throw new TypeError("CryptoKey does not support this operation");
  }
  checkUsage(key, usages);
}
function checkEncCryptoKey(key, alg, ...usages) {
  switch (alg) {
    case "A128GCM":
    case "A192GCM":
    case "A256GCM": {
      if (!isAlgorithm(key.algorithm, "AES-GCM"))
        throw unusable("AES-GCM");
      const expected = parseInt(alg.slice(1, 4), 10);
      const actual = key.algorithm.length;
      if (actual !== expected)
        throw unusable(expected, "algorithm.length");
      break;
    }
    case "A128KW":
    case "A192KW":
    case "A256KW": {
      if (!isAlgorithm(key.algorithm, "AES-KW"))
        throw unusable("AES-KW");
      const expected = parseInt(alg.slice(1, 4), 10);
      const actual = key.algorithm.length;
      if (actual !== expected)
        throw unusable(expected, "algorithm.length");
      break;
    }
    case "ECDH": {
      switch (key.algorithm.name) {
        case "ECDH":
        case "X25519":
        case "X448":
          break;
        default:
          throw unusable("ECDH, X25519, or X448");
      }
      break;
    }
    case "PBES2-HS256+A128KW":
    case "PBES2-HS384+A192KW":
    case "PBES2-HS512+A256KW":
      if (!isAlgorithm(key.algorithm, "PBKDF2"))
        throw unusable("PBKDF2");
      break;
    case "RSA-OAEP":
    case "RSA-OAEP-256":
    case "RSA-OAEP-384":
    case "RSA-OAEP-512": {
      if (!isAlgorithm(key.algorithm, "RSA-OAEP"))
        throw unusable("RSA-OAEP");
      const expected = parseInt(alg.slice(9), 10) || 1;
      const actual = getHashLength(key.algorithm.hash);
      if (actual !== expected)
        throw unusable(`SHA-${expected}`, "algorithm.hash");
      break;
    }
    default:
      throw new TypeError("CryptoKey does not support this operation");
  }
  checkUsage(key, usages);
}
var init_crypto_key = __esm({
  "../../node_modules/jose/dist/browser/lib/crypto_key.js"() {
    __name(unusable, "unusable");
    __name(isAlgorithm, "isAlgorithm");
    __name(getHashLength, "getHashLength");
    __name(getNamedCurve, "getNamedCurve");
    __name(checkUsage, "checkUsage");
    __name(checkSigCryptoKey, "checkSigCryptoKey");
    __name(checkEncCryptoKey, "checkEncCryptoKey");
  }
});

// ../../node_modules/jose/dist/browser/lib/invalid_key_input.js
function message(msg, actual, ...types2) {
  types2 = types2.filter(Boolean);
  if (types2.length > 2) {
    const last = types2.pop();
    msg += `one of type ${types2.join(", ")}, or ${last}.`;
  } else if (types2.length === 2) {
    msg += `one of type ${types2[0]} or ${types2[1]}.`;
  } else {
    msg += `of type ${types2[0]}.`;
  }
  if (actual == null) {
    msg += ` Received ${actual}`;
  } else if (typeof actual === "function" && actual.name) {
    msg += ` Received function ${actual.name}`;
  } else if (typeof actual === "object" && actual != null) {
    if (actual.constructor?.name) {
      msg += ` Received an instance of ${actual.constructor.name}`;
    }
  }
  return msg;
}
function withAlg(alg, actual, ...types2) {
  return message(`Key for the ${alg} algorithm must be `, actual, ...types2);
}
var invalid_key_input_default;
var init_invalid_key_input = __esm({
  "../../node_modules/jose/dist/browser/lib/invalid_key_input.js"() {
    __name(message, "message");
    invalid_key_input_default = /* @__PURE__ */ __name((actual, ...types2) => {
      return message("Key must be ", actual, ...types2);
    }, "default");
    __name(withAlg, "withAlg");
  }
});

// ../../node_modules/jose/dist/browser/runtime/is_key_like.js
var is_key_like_default, types;
var init_is_key_like = __esm({
  "../../node_modules/jose/dist/browser/runtime/is_key_like.js"() {
    init_webcrypto();
    is_key_like_default = /* @__PURE__ */ __name((key) => {
      if (isCryptoKey(key)) {
        return true;
      }
      return key?.[Symbol.toStringTag] === "KeyObject";
    }, "default");
    types = ["CryptoKey"];
  }
});

// ../../node_modules/jose/dist/browser/runtime/decrypt.js
async function cbcDecrypt(enc, cek, ciphertext, iv, tag2, aad) {
  if (!(cek instanceof Uint8Array)) {
    throw new TypeError(invalid_key_input_default(cek, "Uint8Array"));
  }
  const keySize = parseInt(enc.slice(1, 4), 10);
  const encKey = await webcrypto_default.subtle.importKey("raw", cek.subarray(keySize >> 3), "AES-CBC", false, ["decrypt"]);
  const macKey = await webcrypto_default.subtle.importKey("raw", cek.subarray(0, keySize >> 3), {
    hash: `SHA-${keySize << 1}`,
    name: "HMAC"
  }, false, ["sign"]);
  const macData = concat(aad, iv, ciphertext, uint64be(aad.length << 3));
  const expectedTag = new Uint8Array((await webcrypto_default.subtle.sign("HMAC", macKey, macData)).slice(0, keySize >> 3));
  let macCheckPassed;
  try {
    macCheckPassed = timing_safe_equal_default(tag2, expectedTag);
  } catch {
  }
  if (!macCheckPassed) {
    throw new JWEDecryptionFailed();
  }
  let plaintext;
  try {
    plaintext = new Uint8Array(await webcrypto_default.subtle.decrypt({ iv, name: "AES-CBC" }, encKey, ciphertext));
  } catch {
  }
  if (!plaintext) {
    throw new JWEDecryptionFailed();
  }
  return plaintext;
}
async function gcmDecrypt(enc, cek, ciphertext, iv, tag2, aad) {
  let encKey;
  if (cek instanceof Uint8Array) {
    encKey = await webcrypto_default.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]);
  } else {
    checkEncCryptoKey(cek, enc, "decrypt");
    encKey = cek;
  }
  try {
    return new Uint8Array(await webcrypto_default.subtle.decrypt({
      additionalData: aad,
      iv,
      name: "AES-GCM",
      tagLength: 128
    }, encKey, concat(ciphertext, tag2)));
  } catch {
    throw new JWEDecryptionFailed();
  }
}
var decrypt, decrypt_default;
var init_decrypt = __esm({
  "../../node_modules/jose/dist/browser/runtime/decrypt.js"() {
    init_buffer_utils();
    init_check_iv_length();
    init_check_cek_length();
    init_timing_safe_equal();
    init_errors();
    init_webcrypto();
    init_crypto_key();
    init_invalid_key_input();
    init_is_key_like();
    __name(cbcDecrypt, "cbcDecrypt");
    __name(gcmDecrypt, "gcmDecrypt");
    decrypt = /* @__PURE__ */ __name(async (enc, cek, ciphertext, iv, tag2, aad) => {
      if (!isCryptoKey(cek) && !(cek instanceof Uint8Array)) {
        throw new TypeError(invalid_key_input_default(cek, ...types, "Uint8Array"));
      }
      if (!iv) {
        throw new JWEInvalid("JWE Initialization Vector missing");
      }
      if (!tag2) {
        throw new JWEInvalid("JWE Authentication Tag missing");
      }
      check_iv_length_default(enc, iv);
      switch (enc) {
        case "A128CBC-HS256":
        case "A192CBC-HS384":
        case "A256CBC-HS512":
          if (cek instanceof Uint8Array)
            check_cek_length_default(cek, parseInt(enc.slice(-3), 10));
          return cbcDecrypt(enc, cek, ciphertext, iv, tag2, aad);
        case "A128GCM":
        case "A192GCM":
        case "A256GCM":
          if (cek instanceof Uint8Array)
            check_cek_length_default(cek, parseInt(enc.slice(1, 4), 10));
          return gcmDecrypt(enc, cek, ciphertext, iv, tag2, aad);
        default:
          throw new JOSENotSupported("Unsupported JWE Content Encryption Algorithm");
      }
    }, "decrypt");
    decrypt_default = decrypt;
  }
});

// ../../node_modules/jose/dist/browser/lib/is_disjoint.js
var isDisjoint, is_disjoint_default;
var init_is_disjoint = __esm({
  "../../node_modules/jose/dist/browser/lib/is_disjoint.js"() {
    isDisjoint = /* @__PURE__ */ __name((...headers) => {
      const sources = headers.filter(Boolean);
      if (sources.length === 0 || sources.length === 1) {
        return true;
      }
      let acc;
      for (const header of sources) {
        const parameters = Object.keys(header);
        if (!acc || acc.size === 0) {
          acc = new Set(parameters);
          continue;
        }
        for (const parameter of parameters) {
          if (acc.has(parameter)) {
            return false;
          }
          acc.add(parameter);
        }
      }
      return true;
    }, "isDisjoint");
    is_disjoint_default = isDisjoint;
  }
});

// ../../node_modules/jose/dist/browser/lib/is_object.js
function isObjectLike(value) {
  return typeof value === "object" && value !== null;
}
function isObject(input) {
  if (!isObjectLike(input) || Object.prototype.toString.call(input) !== "[object Object]") {
    return false;
  }
  if (Object.getPrototypeOf(input) === null) {
    return true;
  }
  let proto = input;
  while (Object.getPrototypeOf(proto) !== null) {
    proto = Object.getPrototypeOf(proto);
  }
  return Object.getPrototypeOf(input) === proto;
}
var init_is_object = __esm({
  "../../node_modules/jose/dist/browser/lib/is_object.js"() {
    __name(isObjectLike, "isObjectLike");
    __name(isObject, "isObject");
  }
});

// ../../node_modules/jose/dist/browser/runtime/bogus.js
var bogusWebCrypto, bogus_default;
var init_bogus = __esm({
  "../../node_modules/jose/dist/browser/runtime/bogus.js"() {
    bogusWebCrypto = [
      { hash: "SHA-256", name: "HMAC" },
      true,
      ["sign"]
    ];
    bogus_default = bogusWebCrypto;
  }
});

// ../../node_modules/jose/dist/browser/runtime/aeskw.js
function checkKeySize(key, alg) {
  if (key.algorithm.length !== parseInt(alg.slice(1, 4), 10)) {
    throw new TypeError(`Invalid key size for alg: ${alg}`);
  }
}
function getCryptoKey(key, alg, usage) {
  if (isCryptoKey(key)) {
    checkEncCryptoKey(key, alg, usage);
    return key;
  }
  if (key instanceof Uint8Array) {
    return webcrypto_default.subtle.importKey("raw", key, "AES-KW", true, [usage]);
  }
  throw new TypeError(invalid_key_input_default(key, ...types, "Uint8Array"));
}
var wrap, unwrap;
var init_aeskw = __esm({
  "../../node_modules/jose/dist/browser/runtime/aeskw.js"() {
    init_bogus();
    init_webcrypto();
    init_crypto_key();
    init_invalid_key_input();
    init_is_key_like();
    __name(checkKeySize, "checkKeySize");
    __name(getCryptoKey, "getCryptoKey");
    wrap = /* @__PURE__ */ __name(async (alg, key, cek) => {
      const cryptoKey = await getCryptoKey(key, alg, "wrapKey");
      checkKeySize(cryptoKey, alg);
      const cryptoKeyCek = await webcrypto_default.subtle.importKey("raw", cek, ...bogus_default);
      return new Uint8Array(await webcrypto_default.subtle.wrapKey("raw", cryptoKeyCek, cryptoKey, "AES-KW"));
    }, "wrap");
    unwrap = /* @__PURE__ */ __name(async (alg, key, encryptedKey) => {
      const cryptoKey = await getCryptoKey(key, alg, "unwrapKey");
      checkKeySize(cryptoKey, alg);
      const cryptoKeyCek = await webcrypto_default.subtle.unwrapKey("raw", encryptedKey, cryptoKey, "AES-KW", ...bogus_default);
      return new Uint8Array(await webcrypto_default.subtle.exportKey("raw", cryptoKeyCek));
    }, "unwrap");
  }
});

// ../../node_modules/jose/dist/browser/runtime/ecdhes.js
async function deriveKey(publicKey, privateKey, algorithm, keyLength, apu = new Uint8Array(0), apv = new Uint8Array(0)) {
  if (!isCryptoKey(publicKey)) {
    throw new TypeError(invalid_key_input_default(publicKey, ...types));
  }
  checkEncCryptoKey(publicKey, "ECDH");
  if (!isCryptoKey(privateKey)) {
    throw new TypeError(invalid_key_input_default(privateKey, ...types));
  }
  checkEncCryptoKey(privateKey, "ECDH", "deriveBits");
  const value = concat(lengthAndInput(encoder.encode(algorithm)), lengthAndInput(apu), lengthAndInput(apv), uint32be(keyLength));
  let length;
  if (publicKey.algorithm.name === "X25519") {
    length = 256;
  } else if (publicKey.algorithm.name === "X448") {
    length = 448;
  } else {
    length = Math.ceil(parseInt(publicKey.algorithm.namedCurve.substr(-3), 10) / 8) << 3;
  }
  const sharedSecret = new Uint8Array(await webcrypto_default.subtle.deriveBits({
    name: publicKey.algorithm.name,
    public: publicKey
  }, privateKey, length));
  return concatKdf(sharedSecret, keyLength, value);
}
async function generateEpk(key) {
  if (!isCryptoKey(key)) {
    throw new TypeError(invalid_key_input_default(key, ...types));
  }
  return webcrypto_default.subtle.generateKey(key.algorithm, true, ["deriveBits"]);
}
function ecdhAllowed(key) {
  if (!isCryptoKey(key)) {
    throw new TypeError(invalid_key_input_default(key, ...types));
  }
  return ["P-256", "P-384", "P-521"].includes(key.algorithm.namedCurve) || key.algorithm.name === "X25519" || key.algorithm.name === "X448";
}
var init_ecdhes = __esm({
  "../../node_modules/jose/dist/browser/runtime/ecdhes.js"() {
    init_buffer_utils();
    init_webcrypto();
    init_crypto_key();
    init_invalid_key_input();
    init_is_key_like();
    __name(deriveKey, "deriveKey");
    __name(generateEpk, "generateEpk");
    __name(ecdhAllowed, "ecdhAllowed");
  }
});

// ../../node_modules/jose/dist/browser/lib/check_p2s.js
function checkP2s(p2s2) {
  if (!(p2s2 instanceof Uint8Array) || p2s2.length < 8) {
    throw new JWEInvalid("PBES2 Salt Input must be 8 or more octets");
  }
}
var init_check_p2s = __esm({
  "../../node_modules/jose/dist/browser/lib/check_p2s.js"() {
    init_errors();
    __name(checkP2s, "checkP2s");
  }
});

// ../../node_modules/jose/dist/browser/runtime/pbes2kw.js
function getCryptoKey2(key, alg) {
  if (key instanceof Uint8Array) {
    return webcrypto_default.subtle.importKey("raw", key, "PBKDF2", false, ["deriveBits"]);
  }
  if (isCryptoKey(key)) {
    checkEncCryptoKey(key, alg, "deriveBits", "deriveKey");
    return key;
  }
  throw new TypeError(invalid_key_input_default(key, ...types, "Uint8Array"));
}
async function deriveKey2(p2s2, alg, p2c, key) {
  checkP2s(p2s2);
  const salt = p2s(alg, p2s2);
  const keylen = parseInt(alg.slice(13, 16), 10);
  const subtleAlg = {
    hash: `SHA-${alg.slice(8, 11)}`,
    iterations: p2c,
    name: "PBKDF2",
    salt
  };
  const wrapAlg = {
    length: keylen,
    name: "AES-KW"
  };
  const cryptoKey = await getCryptoKey2(key, alg);
  if (cryptoKey.usages.includes("deriveBits")) {
    return new Uint8Array(await webcrypto_default.subtle.deriveBits(subtleAlg, cryptoKey, keylen));
  }
  if (cryptoKey.usages.includes("deriveKey")) {
    return webcrypto_default.subtle.deriveKey(subtleAlg, cryptoKey, wrapAlg, false, ["wrapKey", "unwrapKey"]);
  }
  throw new TypeError('PBKDF2 key "usages" must include "deriveBits" or "deriveKey"');
}
var encrypt, decrypt2;
var init_pbes2kw = __esm({
  "../../node_modules/jose/dist/browser/runtime/pbes2kw.js"() {
    init_random();
    init_buffer_utils();
    init_base64url();
    init_aeskw();
    init_check_p2s();
    init_webcrypto();
    init_crypto_key();
    init_invalid_key_input();
    init_is_key_like();
    __name(getCryptoKey2, "getCryptoKey");
    __name(deriveKey2, "deriveKey");
    encrypt = /* @__PURE__ */ __name(async (alg, key, cek, p2c = 2048, p2s2 = random_default(new Uint8Array(16))) => {
      const derived = await deriveKey2(p2s2, alg, p2c, key);
      const encryptedKey = await wrap(alg.slice(-6), derived, cek);
      return { encryptedKey, p2c, p2s: encode(p2s2) };
    }, "encrypt");
    decrypt2 = /* @__PURE__ */ __name(async (alg, key, encryptedKey, p2c, p2s2) => {
      const derived = await deriveKey2(p2s2, alg, p2c, key);
      return unwrap(alg.slice(-6), derived, encryptedKey);
    }, "decrypt");
  }
});

// ../../node_modules/jose/dist/browser/runtime/subtle_rsaes.js
function subtleRsaEs(alg) {
  switch (alg) {
    case "RSA-OAEP":
    case "RSA-OAEP-256":
    case "RSA-OAEP-384":
    case "RSA-OAEP-512":
      return "RSA-OAEP";
    default:
      throw new JOSENotSupported(`alg ${alg} is not supported either by JOSE or your javascript runtime`);
  }
}
var init_subtle_rsaes = __esm({
  "../../node_modules/jose/dist/browser/runtime/subtle_rsaes.js"() {
    init_errors();
    __name(subtleRsaEs, "subtleRsaEs");
  }
});

// ../../node_modules/jose/dist/browser/runtime/check_key_length.js
var check_key_length_default;
var init_check_key_length = __esm({
  "../../node_modules/jose/dist/browser/runtime/check_key_length.js"() {
    check_key_length_default = /* @__PURE__ */ __name((alg, key) => {
      if (alg.startsWith("RS") || alg.startsWith("PS")) {
        const { modulusLength } = key.algorithm;
        if (typeof modulusLength !== "number" || modulusLength < 2048) {
          throw new TypeError(`${alg} requires key modulusLength to be 2048 bits or larger`);
        }
      }
    }, "default");
  }
});

// ../../node_modules/jose/dist/browser/runtime/rsaes.js
var encrypt2, decrypt3;
var init_rsaes = __esm({
  "../../node_modules/jose/dist/browser/runtime/rsaes.js"() {
    init_subtle_rsaes();
    init_bogus();
    init_webcrypto();
    init_crypto_key();
    init_check_key_length();
    init_invalid_key_input();
    init_is_key_like();
    encrypt2 = /* @__PURE__ */ __name(async (alg, key, cek) => {
      if (!isCryptoKey(key)) {
        throw new TypeError(invalid_key_input_default(key, ...types));
      }
      checkEncCryptoKey(key, alg, "encrypt", "wrapKey");
      check_key_length_default(alg, key);
      if (key.usages.includes("encrypt")) {
        return new Uint8Array(await webcrypto_default.subtle.encrypt(subtleRsaEs(alg), key, cek));
      }
      if (key.usages.includes("wrapKey")) {
        const cryptoKeyCek = await webcrypto_default.subtle.importKey("raw", cek, ...bogus_default);
        return new Uint8Array(await webcrypto_default.subtle.wrapKey("raw", cryptoKeyCek, key, subtleRsaEs(alg)));
      }
      throw new TypeError('RSA-OAEP key "usages" must include "encrypt" or "wrapKey" for this operation');
    }, "encrypt");
    decrypt3 = /* @__PURE__ */ __name(async (alg, key, encryptedKey) => {
      if (!isCryptoKey(key)) {
        throw new TypeError(invalid_key_input_default(key, ...types));
      }
      checkEncCryptoKey(key, alg, "decrypt", "unwrapKey");
      check_key_length_default(alg, key);
      if (key.usages.includes("decrypt")) {
        return new Uint8Array(await webcrypto_default.subtle.decrypt(subtleRsaEs(alg), key, encryptedKey));
      }
      if (key.usages.includes("unwrapKey")) {
        const cryptoKeyCek = await webcrypto_default.subtle.unwrapKey("raw", encryptedKey, key, subtleRsaEs(alg), ...bogus_default);
        return new Uint8Array(await webcrypto_default.subtle.exportKey("raw", cryptoKeyCek));
      }
      throw new TypeError('RSA-OAEP key "usages" must include "decrypt" or "unwrapKey" for this operation');
    }, "decrypt");
  }
});

// ../../node_modules/jose/dist/browser/lib/is_jwk.js
function isJWK(key) {
  return isObject(key) && typeof key.kty === "string";
}
function isPrivateJWK(key) {
  return key.kty !== "oct" && typeof key.d === "string";
}
function isPublicJWK(key) {
  return key.kty !== "oct" && typeof key.d === "undefined";
}
function isSecretJWK(key) {
  return isJWK(key) && key.kty === "oct" && typeof key.k === "string";
}
var init_is_jwk = __esm({
  "../../node_modules/jose/dist/browser/lib/is_jwk.js"() {
    init_is_object();
    __name(isJWK, "isJWK");
    __name(isPrivateJWK, "isPrivateJWK");
    __name(isPublicJWK, "isPublicJWK");
    __name(isSecretJWK, "isSecretJWK");
  }
});

// ../../node_modules/jose/dist/browser/runtime/jwk_to_key.js
function subtleMapping(jwk) {
  let algorithm;
  let keyUsages;
  switch (jwk.kty) {
    case "RSA": {
      switch (jwk.alg) {
        case "PS256":
        case "PS384":
        case "PS512":
          algorithm = { name: "RSA-PSS", hash: `SHA-${jwk.alg.slice(-3)}` };
          keyUsages = jwk.d ? ["sign"] : ["verify"];
          break;
        case "RS256":
        case "RS384":
        case "RS512":
          algorithm = { name: "RSASSA-PKCS1-v1_5", hash: `SHA-${jwk.alg.slice(-3)}` };
          keyUsages = jwk.d ? ["sign"] : ["verify"];
          break;
        case "RSA-OAEP":
        case "RSA-OAEP-256":
        case "RSA-OAEP-384":
        case "RSA-OAEP-512":
          algorithm = {
            name: "RSA-OAEP",
            hash: `SHA-${parseInt(jwk.alg.slice(-3), 10) || 1}`
          };
          keyUsages = jwk.d ? ["decrypt", "unwrapKey"] : ["encrypt", "wrapKey"];
          break;
        default:
          throw new JOSENotSupported('Invalid or unsupported JWK "alg" (Algorithm) Parameter value');
      }
      break;
    }
    case "EC": {
      switch (jwk.alg) {
        case "ES256":
          algorithm = { name: "ECDSA", namedCurve: "P-256" };
          keyUsages = jwk.d ? ["sign"] : ["verify"];
          break;
        case "ES384":
          algorithm = { name: "ECDSA", namedCurve: "P-384" };
          keyUsages = jwk.d ? ["sign"] : ["verify"];
          break;
        case "ES512":
          algorithm = { name: "ECDSA", namedCurve: "P-521" };
          keyUsages = jwk.d ? ["sign"] : ["verify"];
          break;
        case "ECDH-ES":
        case "ECDH-ES+A128KW":
        case "ECDH-ES+A192KW":
        case "ECDH-ES+A256KW":
          algorithm = { name: "ECDH", namedCurve: jwk.crv };
          keyUsages = jwk.d ? ["deriveBits"] : [];
          break;
        default:
          throw new JOSENotSupported('Invalid or unsupported JWK "alg" (Algorithm) Parameter value');
      }
      break;
    }
    case "OKP": {
      switch (jwk.alg) {
        case "Ed25519":
          algorithm = { name: "Ed25519" };
          keyUsages = jwk.d ? ["sign"] : ["verify"];
          break;
        case "EdDSA":
          algorithm = { name: jwk.crv };
          keyUsages = jwk.d ? ["sign"] : ["verify"];
          break;
        case "ECDH-ES":
        case "ECDH-ES+A128KW":
        case "ECDH-ES+A192KW":
        case "ECDH-ES+A256KW":
          algorithm = { name: jwk.crv };
          keyUsages = jwk.d ? ["deriveBits"] : [];
          break;
        default:
          throw new JOSENotSupported('Invalid or unsupported JWK "alg" (Algorithm) Parameter value');
      }
      break;
    }
    default:
      throw new JOSENotSupported('Invalid or unsupported JWK "kty" (Key Type) Parameter value');
  }
  return { algorithm, keyUsages };
}
var parse, jwk_to_key_default;
var init_jwk_to_key = __esm({
  "../../node_modules/jose/dist/browser/runtime/jwk_to_key.js"() {
    init_webcrypto();
    init_errors();
    __name(subtleMapping, "subtleMapping");
    parse = /* @__PURE__ */ __name(async (jwk) => {
      if (!jwk.alg) {
        throw new TypeError('"alg" argument is required when "jwk.alg" is not present');
      }
      const { algorithm, keyUsages } = subtleMapping(jwk);
      const rest = [
        algorithm,
        jwk.ext ?? false,
        jwk.key_ops ?? keyUsages
      ];
      const keyData = { ...jwk };
      delete keyData.alg;
      delete keyData.use;
      return webcrypto_default.subtle.importKey("jwk", keyData, ...rest);
    }, "parse");
    jwk_to_key_default = parse;
  }
});

// ../../node_modules/jose/dist/browser/runtime/normalize_key.js
var exportKeyValue, privCache, pubCache, isKeyObject, importAndCache, normalizePublicKey, normalizePrivateKey, normalize_key_default;
var init_normalize_key = __esm({
  "../../node_modules/jose/dist/browser/runtime/normalize_key.js"() {
    init_is_jwk();
    init_base64url();
    init_jwk_to_key();
    exportKeyValue = /* @__PURE__ */ __name((k) => decode(k), "exportKeyValue");
    isKeyObject = /* @__PURE__ */ __name((key) => {
      return key?.[Symbol.toStringTag] === "KeyObject";
    }, "isKeyObject");
    importAndCache = /* @__PURE__ */ __name(async (cache, key, jwk, alg, freeze = false) => {
      let cached = cache.get(key);
      if (cached?.[alg]) {
        return cached[alg];
      }
      const cryptoKey = await jwk_to_key_default({ ...jwk, alg });
      if (freeze)
        Object.freeze(key);
      if (!cached) {
        cache.set(key, { [alg]: cryptoKey });
      } else {
        cached[alg] = cryptoKey;
      }
      return cryptoKey;
    }, "importAndCache");
    normalizePublicKey = /* @__PURE__ */ __name((key, alg) => {
      if (isKeyObject(key)) {
        let jwk = key.export({ format: "jwk" });
        delete jwk.d;
        delete jwk.dp;
        delete jwk.dq;
        delete jwk.p;
        delete jwk.q;
        delete jwk.qi;
        if (jwk.k) {
          return exportKeyValue(jwk.k);
        }
        pubCache || (pubCache = /* @__PURE__ */ new WeakMap());
        return importAndCache(pubCache, key, jwk, alg);
      }
      if (isJWK(key)) {
        if (key.k)
          return decode(key.k);
        pubCache || (pubCache = /* @__PURE__ */ new WeakMap());
        const cryptoKey = importAndCache(pubCache, key, key, alg, true);
        return cryptoKey;
      }
      return key;
    }, "normalizePublicKey");
    normalizePrivateKey = /* @__PURE__ */ __name((key, alg) => {
      if (isKeyObject(key)) {
        let jwk = key.export({ format: "jwk" });
        if (jwk.k) {
          return exportKeyValue(jwk.k);
        }
        privCache || (privCache = /* @__PURE__ */ new WeakMap());
        return importAndCache(privCache, key, jwk, alg);
      }
      if (isJWK(key)) {
        if (key.k)
          return decode(key.k);
        privCache || (privCache = /* @__PURE__ */ new WeakMap());
        const cryptoKey = importAndCache(privCache, key, key, alg, true);
        return cryptoKey;
      }
      return key;
    }, "normalizePrivateKey");
    normalize_key_default = { normalizePublicKey, normalizePrivateKey };
  }
});

// ../../node_modules/jose/dist/browser/lib/cek.js
function bitLength2(alg) {
  switch (alg) {
    case "A128GCM":
      return 128;
    case "A192GCM":
      return 192;
    case "A256GCM":
    case "A128CBC-HS256":
      return 256;
    case "A192CBC-HS384":
      return 384;
    case "A256CBC-HS512":
      return 512;
    default:
      throw new JOSENotSupported(`Unsupported JWE Algorithm: ${alg}`);
  }
}
var cek_default;
var init_cek = __esm({
  "../../node_modules/jose/dist/browser/lib/cek.js"() {
    init_errors();
    init_random();
    __name(bitLength2, "bitLength");
    cek_default = /* @__PURE__ */ __name((alg) => random_default(new Uint8Array(bitLength2(alg) >> 3)), "default");
  }
});

// ../../node_modules/jose/dist/browser/lib/format_pem.js
var format_pem_default;
var init_format_pem = __esm({
  "../../node_modules/jose/dist/browser/lib/format_pem.js"() {
    format_pem_default = /* @__PURE__ */ __name((b64, descriptor) => {
      const newlined = (b64.match(/.{1,64}/g) || []).join("\n");
      return `-----BEGIN ${descriptor}-----
${newlined}
-----END ${descriptor}-----`;
    }, "default");
  }
});

// ../../node_modules/jose/dist/browser/runtime/asn1.js
function getElement(seq) {
  const result = [];
  let next = 0;
  while (next < seq.length) {
    const nextPart = parseElement(seq.subarray(next));
    result.push(nextPart);
    next += nextPart.byteLength;
  }
  return result;
}
function parseElement(bytes) {
  let position = 0;
  let tag2 = bytes[0] & 31;
  position++;
  if (tag2 === 31) {
    tag2 = 0;
    while (bytes[position] >= 128) {
      tag2 = tag2 * 128 + bytes[position] - 128;
      position++;
    }
    tag2 = tag2 * 128 + bytes[position] - 128;
    position++;
  }
  let length = 0;
  if (bytes[position] < 128) {
    length = bytes[position];
    position++;
  } else if (length === 128) {
    length = 0;
    while (bytes[position + length] !== 0 || bytes[position + length + 1] !== 0) {
      if (length > bytes.byteLength) {
        throw new TypeError("invalid indefinite form length");
      }
      length++;
    }
    const byteLength2 = position + length + 2;
    return {
      byteLength: byteLength2,
      contents: bytes.subarray(position, position + length),
      raw: bytes.subarray(0, byteLength2)
    };
  } else {
    const numberOfDigits = bytes[position] & 127;
    position++;
    length = 0;
    for (let i = 0; i < numberOfDigits; i++) {
      length = length * 256 + bytes[position];
      position++;
    }
  }
  const byteLength = position + length;
  return {
    byteLength,
    contents: bytes.subarray(position, byteLength),
    raw: bytes.subarray(0, byteLength)
  };
}
function spkiFromX509(buf) {
  const tbsCertificate = getElement(getElement(parseElement(buf).contents)[0].contents);
  return encodeBase64(tbsCertificate[tbsCertificate[0].raw[0] === 160 ? 6 : 5].raw);
}
function getSPKI(x509) {
  const pem = x509.replace(/(?:-----(?:BEGIN|END) CERTIFICATE-----|\s)/g, "");
  const raw = decodeBase64(pem);
  return format_pem_default(spkiFromX509(raw), "PUBLIC KEY");
}
var genericExport, toSPKI, toPKCS8, findOid, getNamedCurve2, genericImport, fromPKCS8, fromSPKI, fromX509;
var init_asn1 = __esm({
  "../../node_modules/jose/dist/browser/runtime/asn1.js"() {
    init_webcrypto();
    init_invalid_key_input();
    init_base64url();
    init_format_pem();
    init_errors();
    init_is_key_like();
    genericExport = /* @__PURE__ */ __name(async (keyType, keyFormat, key) => {
      if (!isCryptoKey(key)) {
        throw new TypeError(invalid_key_input_default(key, ...types));
      }
      if (!key.extractable) {
        throw new TypeError("CryptoKey is not extractable");
      }
      if (key.type !== keyType) {
        throw new TypeError(`key is not a ${keyType} key`);
      }
      return format_pem_default(encodeBase64(new Uint8Array(await webcrypto_default.subtle.exportKey(keyFormat, key))), `${keyType.toUpperCase()} KEY`);
    }, "genericExport");
    toSPKI = /* @__PURE__ */ __name((key) => {
      return genericExport("public", "spki", key);
    }, "toSPKI");
    toPKCS8 = /* @__PURE__ */ __name((key) => {
      return genericExport("private", "pkcs8", key);
    }, "toPKCS8");
    findOid = /* @__PURE__ */ __name((keyData, oid, from = 0) => {
      if (from === 0) {
        oid.unshift(oid.length);
        oid.unshift(6);
      }
      const i = keyData.indexOf(oid[0], from);
      if (i === -1)
        return false;
      const sub = keyData.subarray(i, i + oid.length);
      if (sub.length !== oid.length)
        return false;
      return sub.every((value, index) => value === oid[index]) || findOid(keyData, oid, i + 1);
    }, "findOid");
    getNamedCurve2 = /* @__PURE__ */ __name((keyData) => {
      switch (true) {
        case findOid(keyData, [42, 134, 72, 206, 61, 3, 1, 7]):
          return "P-256";
        case findOid(keyData, [43, 129, 4, 0, 34]):
          return "P-384";
        case findOid(keyData, [43, 129, 4, 0, 35]):
          return "P-521";
        case findOid(keyData, [43, 101, 110]):
          return "X25519";
        case findOid(keyData, [43, 101, 111]):
          return "X448";
        case findOid(keyData, [43, 101, 112]):
          return "Ed25519";
        case findOid(keyData, [43, 101, 113]):
          return "Ed448";
        default:
          throw new JOSENotSupported("Invalid or unsupported EC Key Curve or OKP Key Sub Type");
      }
    }, "getNamedCurve");
    genericImport = /* @__PURE__ */ __name(async (replace, keyFormat, pem, alg, options) => {
      let algorithm;
      let keyUsages;
      const keyData = new Uint8Array(atob(pem.replace(replace, "")).split("").map((c) => c.charCodeAt(0)));
      const isPublic = keyFormat === "spki";
      switch (alg) {
        case "PS256":
        case "PS384":
        case "PS512":
          algorithm = { name: "RSA-PSS", hash: `SHA-${alg.slice(-3)}` };
          keyUsages = isPublic ? ["verify"] : ["sign"];
          break;
        case "RS256":
        case "RS384":
        case "RS512":
          algorithm = { name: "RSASSA-PKCS1-v1_5", hash: `SHA-${alg.slice(-3)}` };
          keyUsages = isPublic ? ["verify"] : ["sign"];
          break;
        case "RSA-OAEP":
        case "RSA-OAEP-256":
        case "RSA-OAEP-384":
        case "RSA-OAEP-512":
          algorithm = {
            name: "RSA-OAEP",
            hash: `SHA-${parseInt(alg.slice(-3), 10) || 1}`
          };
          keyUsages = isPublic ? ["encrypt", "wrapKey"] : ["decrypt", "unwrapKey"];
          break;
        case "ES256":
          algorithm = { name: "ECDSA", namedCurve: "P-256" };
          keyUsages = isPublic ? ["verify"] : ["sign"];
          break;
        case "ES384":
          algorithm = { name: "ECDSA", namedCurve: "P-384" };
          keyUsages = isPublic ? ["verify"] : ["sign"];
          break;
        case "ES512":
          algorithm = { name: "ECDSA", namedCurve: "P-521" };
          keyUsages = isPublic ? ["verify"] : ["sign"];
          break;
        case "ECDH-ES":
        case "ECDH-ES+A128KW":
        case "ECDH-ES+A192KW":
        case "ECDH-ES+A256KW": {
          const namedCurve = getNamedCurve2(keyData);
          algorithm = namedCurve.startsWith("P-") ? { name: "ECDH", namedCurve } : { name: namedCurve };
          keyUsages = isPublic ? [] : ["deriveBits"];
          break;
        }
        case "Ed25519":
          algorithm = { name: "Ed25519" };
          keyUsages = isPublic ? ["verify"] : ["sign"];
          break;
        case "EdDSA":
          algorithm = { name: getNamedCurve2(keyData) };
          keyUsages = isPublic ? ["verify"] : ["sign"];
          break;
        default:
          throw new JOSENotSupported('Invalid or unsupported "alg" (Algorithm) value');
      }
      return webcrypto_default.subtle.importKey(keyFormat, keyData, algorithm, options?.extractable ?? false, keyUsages);
    }, "genericImport");
    fromPKCS8 = /* @__PURE__ */ __name((pem, alg, options) => {
      return genericImport(/(?:-----(?:BEGIN|END) PRIVATE KEY-----|\s)/g, "pkcs8", pem, alg, options);
    }, "fromPKCS8");
    fromSPKI = /* @__PURE__ */ __name((pem, alg, options) => {
      return genericImport(/(?:-----(?:BEGIN|END) PUBLIC KEY-----|\s)/g, "spki", pem, alg, options);
    }, "fromSPKI");
    __name(getElement, "getElement");
    __name(parseElement, "parseElement");
    __name(spkiFromX509, "spkiFromX509");
    __name(getSPKI, "getSPKI");
    fromX509 = /* @__PURE__ */ __name((pem, alg, options) => {
      let spki;
      try {
        spki = getSPKI(pem);
      } catch (cause) {
        throw new TypeError("Failed to parse the X.509 certificate", { cause });
      }
      return fromSPKI(spki, alg, options);
    }, "fromX509");
  }
});

// ../../node_modules/jose/dist/browser/key/import.js
async function importSPKI(spki, alg, options) {
  if (typeof spki !== "string" || spki.indexOf("-----BEGIN PUBLIC KEY-----") !== 0) {
    throw new TypeError('"spki" must be SPKI formatted string');
  }
  return fromSPKI(spki, alg, options);
}
async function importX509(x509, alg, options) {
  if (typeof x509 !== "string" || x509.indexOf("-----BEGIN CERTIFICATE-----") !== 0) {
    throw new TypeError('"x509" must be X.509 formatted string');
  }
  return fromX509(x509, alg, options);
}
async function importPKCS8(pkcs8, alg, options) {
  if (typeof pkcs8 !== "string" || pkcs8.indexOf("-----BEGIN PRIVATE KEY-----") !== 0) {
    throw new TypeError('"pkcs8" must be PKCS#8 formatted string');
  }
  return fromPKCS8(pkcs8, alg, options);
}
async function importJWK(jwk, alg) {
  if (!isObject(jwk)) {
    throw new TypeError("JWK must be an object");
  }
  alg || (alg = jwk.alg);
  switch (jwk.kty) {
    case "oct":
      if (typeof jwk.k !== "string" || !jwk.k) {
        throw new TypeError('missing "k" (Key Value) Parameter value');
      }
      return decode(jwk.k);
    case "RSA":
      if ("oth" in jwk && jwk.oth !== void 0) {
        throw new JOSENotSupported('RSA JWK "oth" (Other Primes Info) Parameter value is not supported');
      }
    case "EC":
    case "OKP":
      return jwk_to_key_default({ ...jwk, alg });
    default:
      throw new JOSENotSupported('Unsupported "kty" (Key Type) Parameter value');
  }
}
var init_import = __esm({
  "../../node_modules/jose/dist/browser/key/import.js"() {
    init_base64url();
    init_asn1();
    init_jwk_to_key();
    init_errors();
    init_is_object();
    __name(importSPKI, "importSPKI");
    __name(importX509, "importX509");
    __name(importPKCS8, "importPKCS8");
    __name(importJWK, "importJWK");
  }
});

// ../../node_modules/jose/dist/browser/lib/check_key_type.js
function checkKeyType(allowJwk, alg, key, usage) {
  const symmetric = alg.startsWith("HS") || alg === "dir" || alg.startsWith("PBES2") || /^A\d{3}(?:GCM)?KW$/.test(alg);
  if (symmetric) {
    symmetricTypeCheck(alg, key, usage, allowJwk);
  } else {
    asymmetricTypeCheck(alg, key, usage, allowJwk);
  }
}
var tag, jwkMatchesOp, symmetricTypeCheck, asymmetricTypeCheck, check_key_type_default, checkKeyTypeWithJwk;
var init_check_key_type = __esm({
  "../../node_modules/jose/dist/browser/lib/check_key_type.js"() {
    init_invalid_key_input();
    init_is_key_like();
    init_is_jwk();
    tag = /* @__PURE__ */ __name((key) => key?.[Symbol.toStringTag], "tag");
    jwkMatchesOp = /* @__PURE__ */ __name((alg, key, usage) => {
      if (key.use !== void 0 && key.use !== "sig") {
        throw new TypeError("Invalid key for this operation, when present its use must be sig");
      }
      if (key.key_ops !== void 0 && key.key_ops.includes?.(usage) !== true) {
        throw new TypeError(`Invalid key for this operation, when present its key_ops must include ${usage}`);
      }
      if (key.alg !== void 0 && key.alg !== alg) {
        throw new TypeError(`Invalid key for this operation, when present its alg must be ${alg}`);
      }
      return true;
    }, "jwkMatchesOp");
    symmetricTypeCheck = /* @__PURE__ */ __name((alg, key, usage, allowJwk) => {
      if (key instanceof Uint8Array)
        return;
      if (allowJwk && isJWK(key)) {
        if (isSecretJWK(key) && jwkMatchesOp(alg, key, usage))
          return;
        throw new TypeError(`JSON Web Key for symmetric algorithms must have JWK "kty" (Key Type) equal to "oct" and the JWK "k" (Key Value) present`);
      }
      if (!is_key_like_default(key)) {
        throw new TypeError(withAlg(alg, key, ...types, "Uint8Array", allowJwk ? "JSON Web Key" : null));
      }
      if (key.type !== "secret") {
        throw new TypeError(`${tag(key)} instances for symmetric algorithms must be of type "secret"`);
      }
    }, "symmetricTypeCheck");
    asymmetricTypeCheck = /* @__PURE__ */ __name((alg, key, usage, allowJwk) => {
      if (allowJwk && isJWK(key)) {
        switch (usage) {
          case "sign":
            if (isPrivateJWK(key) && jwkMatchesOp(alg, key, usage))
              return;
            throw new TypeError(`JSON Web Key for this operation be a private JWK`);
          case "verify":
            if (isPublicJWK(key) && jwkMatchesOp(alg, key, usage))
              return;
            throw new TypeError(`JSON Web Key for this operation be a public JWK`);
        }
      }
      if (!is_key_like_default(key)) {
        throw new TypeError(withAlg(alg, key, ...types, allowJwk ? "JSON Web Key" : null));
      }
      if (key.type === "secret") {
        throw new TypeError(`${tag(key)} instances for asymmetric algorithms must not be of type "secret"`);
      }
      if (usage === "sign" && key.type === "public") {
        throw new TypeError(`${tag(key)} instances for asymmetric algorithm signing must be of type "private"`);
      }
      if (usage === "decrypt" && key.type === "public") {
        throw new TypeError(`${tag(key)} instances for asymmetric algorithm decryption must be of type "private"`);
      }
      if (key.algorithm && usage === "verify" && key.type === "private") {
        throw new TypeError(`${tag(key)} instances for asymmetric algorithm verifying must be of type "public"`);
      }
      if (key.algorithm && usage === "encrypt" && key.type === "private") {
        throw new TypeError(`${tag(key)} instances for asymmetric algorithm encryption must be of type "public"`);
      }
    }, "asymmetricTypeCheck");
    __name(checkKeyType, "checkKeyType");
    check_key_type_default = checkKeyType.bind(void 0, false);
    checkKeyTypeWithJwk = checkKeyType.bind(void 0, true);
  }
});

// ../../node_modules/jose/dist/browser/runtime/encrypt.js
async function cbcEncrypt(enc, plaintext, cek, iv, aad) {
  if (!(cek instanceof Uint8Array)) {
    throw new TypeError(invalid_key_input_default(cek, "Uint8Array"));
  }
  const keySize = parseInt(enc.slice(1, 4), 10);
  const encKey = await webcrypto_default.subtle.importKey("raw", cek.subarray(keySize >> 3), "AES-CBC", false, ["encrypt"]);
  const macKey = await webcrypto_default.subtle.importKey("raw", cek.subarray(0, keySize >> 3), {
    hash: `SHA-${keySize << 1}`,
    name: "HMAC"
  }, false, ["sign"]);
  const ciphertext = new Uint8Array(await webcrypto_default.subtle.encrypt({
    iv,
    name: "AES-CBC"
  }, encKey, plaintext));
  const macData = concat(aad, iv, ciphertext, uint64be(aad.length << 3));
  const tag2 = new Uint8Array((await webcrypto_default.subtle.sign("HMAC", macKey, macData)).slice(0, keySize >> 3));
  return { ciphertext, tag: tag2, iv };
}
async function gcmEncrypt(enc, plaintext, cek, iv, aad) {
  let encKey;
  if (cek instanceof Uint8Array) {
    encKey = await webcrypto_default.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  } else {
    checkEncCryptoKey(cek, enc, "encrypt");
    encKey = cek;
  }
  const encrypted = new Uint8Array(await webcrypto_default.subtle.encrypt({
    additionalData: aad,
    iv,
    name: "AES-GCM",
    tagLength: 128
  }, encKey, plaintext));
  const tag2 = encrypted.slice(-16);
  const ciphertext = encrypted.slice(0, -16);
  return { ciphertext, tag: tag2, iv };
}
var encrypt3, encrypt_default;
var init_encrypt = __esm({
  "../../node_modules/jose/dist/browser/runtime/encrypt.js"() {
    init_buffer_utils();
    init_check_iv_length();
    init_check_cek_length();
    init_webcrypto();
    init_crypto_key();
    init_invalid_key_input();
    init_iv();
    init_errors();
    init_is_key_like();
    __name(cbcEncrypt, "cbcEncrypt");
    __name(gcmEncrypt, "gcmEncrypt");
    encrypt3 = /* @__PURE__ */ __name(async (enc, plaintext, cek, iv, aad) => {
      if (!isCryptoKey(cek) && !(cek instanceof Uint8Array)) {
        throw new TypeError(invalid_key_input_default(cek, ...types, "Uint8Array"));
      }
      if (iv) {
        check_iv_length_default(enc, iv);
      } else {
        iv = iv_default(enc);
      }
      switch (enc) {
        case "A128CBC-HS256":
        case "A192CBC-HS384":
        case "A256CBC-HS512":
          if (cek instanceof Uint8Array) {
            check_cek_length_default(cek, parseInt(enc.slice(-3), 10));
          }
          return cbcEncrypt(enc, plaintext, cek, iv, aad);
        case "A128GCM":
        case "A192GCM":
        case "A256GCM":
          if (cek instanceof Uint8Array) {
            check_cek_length_default(cek, parseInt(enc.slice(1, 4), 10));
          }
          return gcmEncrypt(enc, plaintext, cek, iv, aad);
        default:
          throw new JOSENotSupported("Unsupported JWE Content Encryption Algorithm");
      }
    }, "encrypt");
    encrypt_default = encrypt3;
  }
});

// ../../node_modules/jose/dist/browser/lib/aesgcmkw.js
async function wrap2(alg, key, cek, iv) {
  const jweAlgorithm = alg.slice(0, 7);
  const wrapped = await encrypt_default(jweAlgorithm, cek, key, iv, new Uint8Array(0));
  return {
    encryptedKey: wrapped.ciphertext,
    iv: encode(wrapped.iv),
    tag: encode(wrapped.tag)
  };
}
async function unwrap2(alg, key, encryptedKey, iv, tag2) {
  const jweAlgorithm = alg.slice(0, 7);
  return decrypt_default(jweAlgorithm, key, encryptedKey, iv, tag2, new Uint8Array(0));
}
var init_aesgcmkw = __esm({
  "../../node_modules/jose/dist/browser/lib/aesgcmkw.js"() {
    init_encrypt();
    init_decrypt();
    init_base64url();
    __name(wrap2, "wrap");
    __name(unwrap2, "unwrap");
  }
});

// ../../node_modules/jose/dist/browser/lib/decrypt_key_management.js
async function decryptKeyManagement(alg, key, encryptedKey, joseHeader, options) {
  check_key_type_default(alg, key, "decrypt");
  key = await normalize_key_default.normalizePrivateKey?.(key, alg) || key;
  switch (alg) {
    case "dir": {
      if (encryptedKey !== void 0)
        throw new JWEInvalid("Encountered unexpected JWE Encrypted Key");
      return key;
    }
    case "ECDH-ES":
      if (encryptedKey !== void 0)
        throw new JWEInvalid("Encountered unexpected JWE Encrypted Key");
    case "ECDH-ES+A128KW":
    case "ECDH-ES+A192KW":
    case "ECDH-ES+A256KW": {
      if (!isObject(joseHeader.epk))
        throw new JWEInvalid(`JOSE Header "epk" (Ephemeral Public Key) missing or invalid`);
      if (!ecdhAllowed(key))
        throw new JOSENotSupported("ECDH with the provided key is not allowed or not supported by your javascript runtime");
      const epk = await importJWK(joseHeader.epk, alg);
      let partyUInfo;
      let partyVInfo;
      if (joseHeader.apu !== void 0) {
        if (typeof joseHeader.apu !== "string")
          throw new JWEInvalid(`JOSE Header "apu" (Agreement PartyUInfo) invalid`);
        try {
          partyUInfo = decode(joseHeader.apu);
        } catch {
          throw new JWEInvalid("Failed to base64url decode the apu");
        }
      }
      if (joseHeader.apv !== void 0) {
        if (typeof joseHeader.apv !== "string")
          throw new JWEInvalid(`JOSE Header "apv" (Agreement PartyVInfo) invalid`);
        try {
          partyVInfo = decode(joseHeader.apv);
        } catch {
          throw new JWEInvalid("Failed to base64url decode the apv");
        }
      }
      const sharedSecret = await deriveKey(epk, key, alg === "ECDH-ES" ? joseHeader.enc : alg, alg === "ECDH-ES" ? bitLength2(joseHeader.enc) : parseInt(alg.slice(-5, -2), 10), partyUInfo, partyVInfo);
      if (alg === "ECDH-ES")
        return sharedSecret;
      if (encryptedKey === void 0)
        throw new JWEInvalid("JWE Encrypted Key missing");
      return unwrap(alg.slice(-6), sharedSecret, encryptedKey);
    }
    case "RSA1_5":
    case "RSA-OAEP":
    case "RSA-OAEP-256":
    case "RSA-OAEP-384":
    case "RSA-OAEP-512": {
      if (encryptedKey === void 0)
        throw new JWEInvalid("JWE Encrypted Key missing");
      return decrypt3(alg, key, encryptedKey);
    }
    case "PBES2-HS256+A128KW":
    case "PBES2-HS384+A192KW":
    case "PBES2-HS512+A256KW": {
      if (encryptedKey === void 0)
        throw new JWEInvalid("JWE Encrypted Key missing");
      if (typeof joseHeader.p2c !== "number")
        throw new JWEInvalid(`JOSE Header "p2c" (PBES2 Count) missing or invalid`);
      const p2cLimit = options?.maxPBES2Count || 1e4;
      if (joseHeader.p2c > p2cLimit)
        throw new JWEInvalid(`JOSE Header "p2c" (PBES2 Count) out is of acceptable bounds`);
      if (typeof joseHeader.p2s !== "string")
        throw new JWEInvalid(`JOSE Header "p2s" (PBES2 Salt) missing or invalid`);
      let p2s2;
      try {
        p2s2 = decode(joseHeader.p2s);
      } catch {
        throw new JWEInvalid("Failed to base64url decode the p2s");
      }
      return decrypt2(alg, key, encryptedKey, joseHeader.p2c, p2s2);
    }
    case "A128KW":
    case "A192KW":
    case "A256KW": {
      if (encryptedKey === void 0)
        throw new JWEInvalid("JWE Encrypted Key missing");
      return unwrap(alg, key, encryptedKey);
    }
    case "A128GCMKW":
    case "A192GCMKW":
    case "A256GCMKW": {
      if (encryptedKey === void 0)
        throw new JWEInvalid("JWE Encrypted Key missing");
      if (typeof joseHeader.iv !== "string")
        throw new JWEInvalid(`JOSE Header "iv" (Initialization Vector) missing or invalid`);
      if (typeof joseHeader.tag !== "string")
        throw new JWEInvalid(`JOSE Header "tag" (Authentication Tag) missing or invalid`);
      let iv;
      try {
        iv = decode(joseHeader.iv);
      } catch {
        throw new JWEInvalid("Failed to base64url decode the iv");
      }
      let tag2;
      try {
        tag2 = decode(joseHeader.tag);
      } catch {
        throw new JWEInvalid("Failed to base64url decode the tag");
      }
      return unwrap2(alg, key, encryptedKey, iv, tag2);
    }
    default: {
      throw new JOSENotSupported('Invalid or unsupported "alg" (JWE Algorithm) header value');
    }
  }
}
var decrypt_key_management_default;
var init_decrypt_key_management = __esm({
  "../../node_modules/jose/dist/browser/lib/decrypt_key_management.js"() {
    init_aeskw();
    init_ecdhes();
    init_pbes2kw();
    init_rsaes();
    init_base64url();
    init_normalize_key();
    init_errors();
    init_cek();
    init_import();
    init_check_key_type();
    init_is_object();
    init_aesgcmkw();
    __name(decryptKeyManagement, "decryptKeyManagement");
    decrypt_key_management_default = decryptKeyManagement;
  }
});

// ../../node_modules/jose/dist/browser/lib/validate_crit.js
function validateCrit(Err, recognizedDefault, recognizedOption, protectedHeader, joseHeader) {
  if (joseHeader.crit !== void 0 && protectedHeader?.crit === void 0) {
    throw new Err('"crit" (Critical) Header Parameter MUST be integrity protected');
  }
  if (!protectedHeader || protectedHeader.crit === void 0) {
    return /* @__PURE__ */ new Set();
  }
  if (!Array.isArray(protectedHeader.crit) || protectedHeader.crit.length === 0 || protectedHeader.crit.some((input) => typeof input !== "string" || input.length === 0)) {
    throw new Err('"crit" (Critical) Header Parameter MUST be an array of non-empty strings when present');
  }
  let recognized;
  if (recognizedOption !== void 0) {
    recognized = new Map([...Object.entries(recognizedOption), ...recognizedDefault.entries()]);
  } else {
    recognized = recognizedDefault;
  }
  for (const parameter of protectedHeader.crit) {
    if (!recognized.has(parameter)) {
      throw new JOSENotSupported(`Extension Header Parameter "${parameter}" is not recognized`);
    }
    if (joseHeader[parameter] === void 0) {
      throw new Err(`Extension Header Parameter "${parameter}" is missing`);
    }
    if (recognized.get(parameter) && protectedHeader[parameter] === void 0) {
      throw new Err(`Extension Header Parameter "${parameter}" MUST be integrity protected`);
    }
  }
  return new Set(protectedHeader.crit);
}
var validate_crit_default;
var init_validate_crit = __esm({
  "../../node_modules/jose/dist/browser/lib/validate_crit.js"() {
    init_errors();
    __name(validateCrit, "validateCrit");
    validate_crit_default = validateCrit;
  }
});

// ../../node_modules/jose/dist/browser/lib/validate_algorithms.js
var validateAlgorithms, validate_algorithms_default;
var init_validate_algorithms = __esm({
  "../../node_modules/jose/dist/browser/lib/validate_algorithms.js"() {
    validateAlgorithms = /* @__PURE__ */ __name((option, algorithms) => {
      if (algorithms !== void 0 && (!Array.isArray(algorithms) || algorithms.some((s) => typeof s !== "string"))) {
        throw new TypeError(`"${option}" option must be an array of strings`);
      }
      if (!algorithms) {
        return void 0;
      }
      return new Set(algorithms);
    }, "validateAlgorithms");
    validate_algorithms_default = validateAlgorithms;
  }
});

// ../../node_modules/jose/dist/browser/jwe/flattened/decrypt.js
async function flattenedDecrypt(jwe, key, options) {
  if (!isObject(jwe)) {
    throw new JWEInvalid("Flattened JWE must be an object");
  }
  if (jwe.protected === void 0 && jwe.header === void 0 && jwe.unprotected === void 0) {
    throw new JWEInvalid("JOSE Header missing");
  }
  if (jwe.iv !== void 0 && typeof jwe.iv !== "string") {
    throw new JWEInvalid("JWE Initialization Vector incorrect type");
  }
  if (typeof jwe.ciphertext !== "string") {
    throw new JWEInvalid("JWE Ciphertext missing or incorrect type");
  }
  if (jwe.tag !== void 0 && typeof jwe.tag !== "string") {
    throw new JWEInvalid("JWE Authentication Tag incorrect type");
  }
  if (jwe.protected !== void 0 && typeof jwe.protected !== "string") {
    throw new JWEInvalid("JWE Protected Header incorrect type");
  }
  if (jwe.encrypted_key !== void 0 && typeof jwe.encrypted_key !== "string") {
    throw new JWEInvalid("JWE Encrypted Key incorrect type");
  }
  if (jwe.aad !== void 0 && typeof jwe.aad !== "string") {
    throw new JWEInvalid("JWE AAD incorrect type");
  }
  if (jwe.header !== void 0 && !isObject(jwe.header)) {
    throw new JWEInvalid("JWE Shared Unprotected Header incorrect type");
  }
  if (jwe.unprotected !== void 0 && !isObject(jwe.unprotected)) {
    throw new JWEInvalid("JWE Per-Recipient Unprotected Header incorrect type");
  }
  let parsedProt;
  if (jwe.protected) {
    try {
      const protectedHeader2 = decode(jwe.protected);
      parsedProt = JSON.parse(decoder.decode(protectedHeader2));
    } catch {
      throw new JWEInvalid("JWE Protected Header is invalid");
    }
  }
  if (!is_disjoint_default(parsedProt, jwe.header, jwe.unprotected)) {
    throw new JWEInvalid("JWE Protected, JWE Unprotected Header, and JWE Per-Recipient Unprotected Header Parameter names must be disjoint");
  }
  const joseHeader = {
    ...parsedProt,
    ...jwe.header,
    ...jwe.unprotected
  };
  validate_crit_default(JWEInvalid, /* @__PURE__ */ new Map(), options?.crit, parsedProt, joseHeader);
  if (joseHeader.zip !== void 0) {
    throw new JOSENotSupported('JWE "zip" (Compression Algorithm) Header Parameter is not supported.');
  }
  const { alg, enc } = joseHeader;
  if (typeof alg !== "string" || !alg) {
    throw new JWEInvalid("missing JWE Algorithm (alg) in JWE Header");
  }
  if (typeof enc !== "string" || !enc) {
    throw new JWEInvalid("missing JWE Encryption Algorithm (enc) in JWE Header");
  }
  const keyManagementAlgorithms = options && validate_algorithms_default("keyManagementAlgorithms", options.keyManagementAlgorithms);
  const contentEncryptionAlgorithms = options && validate_algorithms_default("contentEncryptionAlgorithms", options.contentEncryptionAlgorithms);
  if (keyManagementAlgorithms && !keyManagementAlgorithms.has(alg) || !keyManagementAlgorithms && alg.startsWith("PBES2")) {
    throw new JOSEAlgNotAllowed('"alg" (Algorithm) Header Parameter value not allowed');
  }
  if (contentEncryptionAlgorithms && !contentEncryptionAlgorithms.has(enc)) {
    throw new JOSEAlgNotAllowed('"enc" (Encryption Algorithm) Header Parameter value not allowed');
  }
  let encryptedKey;
  if (jwe.encrypted_key !== void 0) {
    try {
      encryptedKey = decode(jwe.encrypted_key);
    } catch {
      throw new JWEInvalid("Failed to base64url decode the encrypted_key");
    }
  }
  let resolvedKey = false;
  if (typeof key === "function") {
    key = await key(parsedProt, jwe);
    resolvedKey = true;
  }
  let cek;
  try {
    cek = await decrypt_key_management_default(alg, key, encryptedKey, joseHeader, options);
  } catch (err2) {
    if (err2 instanceof TypeError || err2 instanceof JWEInvalid || err2 instanceof JOSENotSupported) {
      throw err2;
    }
    cek = cek_default(enc);
  }
  let iv;
  let tag2;
  if (jwe.iv !== void 0) {
    try {
      iv = decode(jwe.iv);
    } catch {
      throw new JWEInvalid("Failed to base64url decode the iv");
    }
  }
  if (jwe.tag !== void 0) {
    try {
      tag2 = decode(jwe.tag);
    } catch {
      throw new JWEInvalid("Failed to base64url decode the tag");
    }
  }
  const protectedHeader = encoder.encode(jwe.protected ?? "");
  let additionalData;
  if (jwe.aad !== void 0) {
    additionalData = concat(protectedHeader, encoder.encode("."), encoder.encode(jwe.aad));
  } else {
    additionalData = protectedHeader;
  }
  let ciphertext;
  try {
    ciphertext = decode(jwe.ciphertext);
  } catch {
    throw new JWEInvalid("Failed to base64url decode the ciphertext");
  }
  const plaintext = await decrypt_default(enc, cek, ciphertext, iv, tag2, additionalData);
  const result = { plaintext };
  if (jwe.protected !== void 0) {
    result.protectedHeader = parsedProt;
  }
  if (jwe.aad !== void 0) {
    try {
      result.additionalAuthenticatedData = decode(jwe.aad);
    } catch {
      throw new JWEInvalid("Failed to base64url decode the aad");
    }
  }
  if (jwe.unprotected !== void 0) {
    result.sharedUnprotectedHeader = jwe.unprotected;
  }
  if (jwe.header !== void 0) {
    result.unprotectedHeader = jwe.header;
  }
  if (resolvedKey) {
    return { ...result, key };
  }
  return result;
}
var init_decrypt2 = __esm({
  "../../node_modules/jose/dist/browser/jwe/flattened/decrypt.js"() {
    init_base64url();
    init_decrypt();
    init_errors();
    init_is_disjoint();
    init_is_object();
    init_decrypt_key_management();
    init_buffer_utils();
    init_cek();
    init_validate_crit();
    init_validate_algorithms();
    __name(flattenedDecrypt, "flattenedDecrypt");
  }
});

// ../../node_modules/jose/dist/browser/jwe/compact/decrypt.js
async function compactDecrypt(jwe, key, options) {
  if (jwe instanceof Uint8Array) {
    jwe = decoder.decode(jwe);
  }
  if (typeof jwe !== "string") {
    throw new JWEInvalid("Compact JWE must be a string or Uint8Array");
  }
  const { 0: protectedHeader, 1: encryptedKey, 2: iv, 3: ciphertext, 4: tag2, length } = jwe.split(".");
  if (length !== 5) {
    throw new JWEInvalid("Invalid Compact JWE");
  }
  const decrypted = await flattenedDecrypt({
    ciphertext,
    iv: iv || void 0,
    protected: protectedHeader,
    tag: tag2 || void 0,
    encrypted_key: encryptedKey || void 0
  }, key, options);
  const result = { plaintext: decrypted.plaintext, protectedHeader: decrypted.protectedHeader };
  if (typeof key === "function") {
    return { ...result, key: decrypted.key };
  }
  return result;
}
var init_decrypt3 = __esm({
  "../../node_modules/jose/dist/browser/jwe/compact/decrypt.js"() {
    init_decrypt2();
    init_errors();
    init_buffer_utils();
    __name(compactDecrypt, "compactDecrypt");
  }
});

// ../../node_modules/jose/dist/browser/jwe/general/decrypt.js
async function generalDecrypt(jwe, key, options) {
  if (!isObject(jwe)) {
    throw new JWEInvalid("General JWE must be an object");
  }
  if (!Array.isArray(jwe.recipients) || !jwe.recipients.every(isObject)) {
    throw new JWEInvalid("JWE Recipients missing or incorrect type");
  }
  if (!jwe.recipients.length) {
    throw new JWEInvalid("JWE Recipients has no members");
  }
  for (const recipient of jwe.recipients) {
    try {
      return await flattenedDecrypt({
        aad: jwe.aad,
        ciphertext: jwe.ciphertext,
        encrypted_key: recipient.encrypted_key,
        header: recipient.header,
        iv: jwe.iv,
        protected: jwe.protected,
        tag: jwe.tag,
        unprotected: jwe.unprotected
      }, key, options);
    } catch {
    }
  }
  throw new JWEDecryptionFailed();
}
var init_decrypt4 = __esm({
  "../../node_modules/jose/dist/browser/jwe/general/decrypt.js"() {
    init_decrypt2();
    init_errors();
    init_is_object();
    __name(generalDecrypt, "generalDecrypt");
  }
});

// ../../node_modules/jose/dist/browser/lib/private_symbols.js
var unprotected;
var init_private_symbols = __esm({
  "../../node_modules/jose/dist/browser/lib/private_symbols.js"() {
    unprotected = /* @__PURE__ */ Symbol();
  }
});

// ../../node_modules/jose/dist/browser/runtime/key_to_jwk.js
var keyToJWK, key_to_jwk_default;
var init_key_to_jwk = __esm({
  "../../node_modules/jose/dist/browser/runtime/key_to_jwk.js"() {
    init_webcrypto();
    init_invalid_key_input();
    init_base64url();
    init_is_key_like();
    keyToJWK = /* @__PURE__ */ __name(async (key) => {
      if (key instanceof Uint8Array) {
        return {
          kty: "oct",
          k: encode(key)
        };
      }
      if (!isCryptoKey(key)) {
        throw new TypeError(invalid_key_input_default(key, ...types, "Uint8Array"));
      }
      if (!key.extractable) {
        throw new TypeError("non-extractable CryptoKey cannot be exported as a JWK");
      }
      const { ext, key_ops, alg, use, ...jwk } = await webcrypto_default.subtle.exportKey("jwk", key);
      return jwk;
    }, "keyToJWK");
    key_to_jwk_default = keyToJWK;
  }
});

// ../../node_modules/jose/dist/browser/key/export.js
async function exportSPKI(key) {
  return toSPKI(key);
}
async function exportPKCS8(key) {
  return toPKCS8(key);
}
async function exportJWK(key) {
  return key_to_jwk_default(key);
}
var init_export = __esm({
  "../../node_modules/jose/dist/browser/key/export.js"() {
    init_asn1();
    init_asn1();
    init_key_to_jwk();
    __name(exportSPKI, "exportSPKI");
    __name(exportPKCS8, "exportPKCS8");
    __name(exportJWK, "exportJWK");
  }
});

// ../../node_modules/jose/dist/browser/lib/encrypt_key_management.js
async function encryptKeyManagement(alg, enc, key, providedCek, providedParameters = {}) {
  let encryptedKey;
  let parameters;
  let cek;
  check_key_type_default(alg, key, "encrypt");
  key = await normalize_key_default.normalizePublicKey?.(key, alg) || key;
  switch (alg) {
    case "dir": {
      cek = key;
      break;
    }
    case "ECDH-ES":
    case "ECDH-ES+A128KW":
    case "ECDH-ES+A192KW":
    case "ECDH-ES+A256KW": {
      if (!ecdhAllowed(key)) {
        throw new JOSENotSupported("ECDH with the provided key is not allowed or not supported by your javascript runtime");
      }
      const { apu, apv } = providedParameters;
      let { epk: ephemeralKey } = providedParameters;
      ephemeralKey || (ephemeralKey = (await generateEpk(key)).privateKey);
      const { x, y, crv, kty } = await exportJWK(ephemeralKey);
      const sharedSecret = await deriveKey(key, ephemeralKey, alg === "ECDH-ES" ? enc : alg, alg === "ECDH-ES" ? bitLength2(enc) : parseInt(alg.slice(-5, -2), 10), apu, apv);
      parameters = { epk: { x, crv, kty } };
      if (kty === "EC")
        parameters.epk.y = y;
      if (apu)
        parameters.apu = encode(apu);
      if (apv)
        parameters.apv = encode(apv);
      if (alg === "ECDH-ES") {
        cek = sharedSecret;
        break;
      }
      cek = providedCek || cek_default(enc);
      const kwAlg = alg.slice(-6);
      encryptedKey = await wrap(kwAlg, sharedSecret, cek);
      break;
    }
    case "RSA1_5":
    case "RSA-OAEP":
    case "RSA-OAEP-256":
    case "RSA-OAEP-384":
    case "RSA-OAEP-512": {
      cek = providedCek || cek_default(enc);
      encryptedKey = await encrypt2(alg, key, cek);
      break;
    }
    case "PBES2-HS256+A128KW":
    case "PBES2-HS384+A192KW":
    case "PBES2-HS512+A256KW": {
      cek = providedCek || cek_default(enc);
      const { p2c, p2s: p2s2 } = providedParameters;
      ({ encryptedKey, ...parameters } = await encrypt(alg, key, cek, p2c, p2s2));
      break;
    }
    case "A128KW":
    case "A192KW":
    case "A256KW": {
      cek = providedCek || cek_default(enc);
      encryptedKey = await wrap(alg, key, cek);
      break;
    }
    case "A128GCMKW":
    case "A192GCMKW":
    case "A256GCMKW": {
      cek = providedCek || cek_default(enc);
      const { iv } = providedParameters;
      ({ encryptedKey, ...parameters } = await wrap2(alg, key, cek, iv));
      break;
    }
    default: {
      throw new JOSENotSupported('Invalid or unsupported "alg" (JWE Algorithm) header value');
    }
  }
  return { cek, encryptedKey, parameters };
}
var encrypt_key_management_default;
var init_encrypt_key_management = __esm({
  "../../node_modules/jose/dist/browser/lib/encrypt_key_management.js"() {
    init_aeskw();
    init_ecdhes();
    init_pbes2kw();
    init_rsaes();
    init_base64url();
    init_normalize_key();
    init_cek();
    init_errors();
    init_export();
    init_check_key_type();
    init_aesgcmkw();
    __name(encryptKeyManagement, "encryptKeyManagement");
    encrypt_key_management_default = encryptKeyManagement;
  }
});

// ../../node_modules/jose/dist/browser/jwe/flattened/encrypt.js
var FlattenedEncrypt;
var init_encrypt2 = __esm({
  "../../node_modules/jose/dist/browser/jwe/flattened/encrypt.js"() {
    init_base64url();
    init_private_symbols();
    init_encrypt();
    init_encrypt_key_management();
    init_errors();
    init_is_disjoint();
    init_buffer_utils();
    init_validate_crit();
    FlattenedEncrypt = class {
      static {
        __name(this, "FlattenedEncrypt");
      }
      constructor(plaintext) {
        if (!(plaintext instanceof Uint8Array)) {
          throw new TypeError("plaintext must be an instance of Uint8Array");
        }
        this._plaintext = plaintext;
      }
      setKeyManagementParameters(parameters) {
        if (this._keyManagementParameters) {
          throw new TypeError("setKeyManagementParameters can only be called once");
        }
        this._keyManagementParameters = parameters;
        return this;
      }
      setProtectedHeader(protectedHeader) {
        if (this._protectedHeader) {
          throw new TypeError("setProtectedHeader can only be called once");
        }
        this._protectedHeader = protectedHeader;
        return this;
      }
      setSharedUnprotectedHeader(sharedUnprotectedHeader) {
        if (this._sharedUnprotectedHeader) {
          throw new TypeError("setSharedUnprotectedHeader can only be called once");
        }
        this._sharedUnprotectedHeader = sharedUnprotectedHeader;
        return this;
      }
      setUnprotectedHeader(unprotectedHeader) {
        if (this._unprotectedHeader) {
          throw new TypeError("setUnprotectedHeader can only be called once");
        }
        this._unprotectedHeader = unprotectedHeader;
        return this;
      }
      setAdditionalAuthenticatedData(aad) {
        this._aad = aad;
        return this;
      }
      setContentEncryptionKey(cek) {
        if (this._cek) {
          throw new TypeError("setContentEncryptionKey can only be called once");
        }
        this._cek = cek;
        return this;
      }
      setInitializationVector(iv) {
        if (this._iv) {
          throw new TypeError("setInitializationVector can only be called once");
        }
        this._iv = iv;
        return this;
      }
      async encrypt(key, options) {
        if (!this._protectedHeader && !this._unprotectedHeader && !this._sharedUnprotectedHeader) {
          throw new JWEInvalid("either setProtectedHeader, setUnprotectedHeader, or sharedUnprotectedHeader must be called before #encrypt()");
        }
        if (!is_disjoint_default(this._protectedHeader, this._unprotectedHeader, this._sharedUnprotectedHeader)) {
          throw new JWEInvalid("JWE Protected, JWE Shared Unprotected and JWE Per-Recipient Header Parameter names must be disjoint");
        }
        const joseHeader = {
          ...this._protectedHeader,
          ...this._unprotectedHeader,
          ...this._sharedUnprotectedHeader
        };
        validate_crit_default(JWEInvalid, /* @__PURE__ */ new Map(), options?.crit, this._protectedHeader, joseHeader);
        if (joseHeader.zip !== void 0) {
          throw new JOSENotSupported('JWE "zip" (Compression Algorithm) Header Parameter is not supported.');
        }
        const { alg, enc } = joseHeader;
        if (typeof alg !== "string" || !alg) {
          throw new JWEInvalid('JWE "alg" (Algorithm) Header Parameter missing or invalid');
        }
        if (typeof enc !== "string" || !enc) {
          throw new JWEInvalid('JWE "enc" (Encryption Algorithm) Header Parameter missing or invalid');
        }
        let encryptedKey;
        if (this._cek && (alg === "dir" || alg === "ECDH-ES")) {
          throw new TypeError(`setContentEncryptionKey cannot be called with JWE "alg" (Algorithm) Header ${alg}`);
        }
        let cek;
        {
          let parameters;
          ({ cek, encryptedKey, parameters } = await encrypt_key_management_default(alg, enc, key, this._cek, this._keyManagementParameters));
          if (parameters) {
            if (options && unprotected in options) {
              if (!this._unprotectedHeader) {
                this.setUnprotectedHeader(parameters);
              } else {
                this._unprotectedHeader = { ...this._unprotectedHeader, ...parameters };
              }
            } else if (!this._protectedHeader) {
              this.setProtectedHeader(parameters);
            } else {
              this._protectedHeader = { ...this._protectedHeader, ...parameters };
            }
          }
        }
        let additionalData;
        let protectedHeader;
        let aadMember;
        if (this._protectedHeader) {
          protectedHeader = encoder.encode(encode(JSON.stringify(this._protectedHeader)));
        } else {
          protectedHeader = encoder.encode("");
        }
        if (this._aad) {
          aadMember = encode(this._aad);
          additionalData = concat(protectedHeader, encoder.encode("."), encoder.encode(aadMember));
        } else {
          additionalData = protectedHeader;
        }
        const { ciphertext, tag: tag2, iv } = await encrypt_default(enc, this._plaintext, cek, this._iv, additionalData);
        const jwe = {
          ciphertext: encode(ciphertext)
        };
        if (iv) {
          jwe.iv = encode(iv);
        }
        if (tag2) {
          jwe.tag = encode(tag2);
        }
        if (encryptedKey) {
          jwe.encrypted_key = encode(encryptedKey);
        }
        if (aadMember) {
          jwe.aad = aadMember;
        }
        if (this._protectedHeader) {
          jwe.protected = decoder.decode(protectedHeader);
        }
        if (this._sharedUnprotectedHeader) {
          jwe.unprotected = this._sharedUnprotectedHeader;
        }
        if (this._unprotectedHeader) {
          jwe.header = this._unprotectedHeader;
        }
        return jwe;
      }
    };
  }
});

// ../../node_modules/jose/dist/browser/jwe/general/encrypt.js
var IndividualRecipient, GeneralEncrypt;
var init_encrypt3 = __esm({
  "../../node_modules/jose/dist/browser/jwe/general/encrypt.js"() {
    init_encrypt2();
    init_private_symbols();
    init_errors();
    init_cek();
    init_is_disjoint();
    init_encrypt_key_management();
    init_base64url();
    init_validate_crit();
    IndividualRecipient = class {
      static {
        __name(this, "IndividualRecipient");
      }
      constructor(enc, key, options) {
        this.parent = enc;
        this.key = key;
        this.options = options;
      }
      setUnprotectedHeader(unprotectedHeader) {
        if (this.unprotectedHeader) {
          throw new TypeError("setUnprotectedHeader can only be called once");
        }
        this.unprotectedHeader = unprotectedHeader;
        return this;
      }
      addRecipient(...args) {
        return this.parent.addRecipient(...args);
      }
      encrypt(...args) {
        return this.parent.encrypt(...args);
      }
      done() {
        return this.parent;
      }
    };
    GeneralEncrypt = class {
      static {
        __name(this, "GeneralEncrypt");
      }
      constructor(plaintext) {
        this._recipients = [];
        this._plaintext = plaintext;
      }
      addRecipient(key, options) {
        const recipient = new IndividualRecipient(this, key, { crit: options?.crit });
        this._recipients.push(recipient);
        return recipient;
      }
      setProtectedHeader(protectedHeader) {
        if (this._protectedHeader) {
          throw new TypeError("setProtectedHeader can only be called once");
        }
        this._protectedHeader = protectedHeader;
        return this;
      }
      setSharedUnprotectedHeader(sharedUnprotectedHeader) {
        if (this._unprotectedHeader) {
          throw new TypeError("setSharedUnprotectedHeader can only be called once");
        }
        this._unprotectedHeader = sharedUnprotectedHeader;
        return this;
      }
      setAdditionalAuthenticatedData(aad) {
        this._aad = aad;
        return this;
      }
      async encrypt() {
        if (!this._recipients.length) {
          throw new JWEInvalid("at least one recipient must be added");
        }
        if (this._recipients.length === 1) {
          const [recipient] = this._recipients;
          const flattened = await new FlattenedEncrypt(this._plaintext).setAdditionalAuthenticatedData(this._aad).setProtectedHeader(this._protectedHeader).setSharedUnprotectedHeader(this._unprotectedHeader).setUnprotectedHeader(recipient.unprotectedHeader).encrypt(recipient.key, { ...recipient.options });
          const jwe2 = {
            ciphertext: flattened.ciphertext,
            iv: flattened.iv,
            recipients: [{}],
            tag: flattened.tag
          };
          if (flattened.aad)
            jwe2.aad = flattened.aad;
          if (flattened.protected)
            jwe2.protected = flattened.protected;
          if (flattened.unprotected)
            jwe2.unprotected = flattened.unprotected;
          if (flattened.encrypted_key)
            jwe2.recipients[0].encrypted_key = flattened.encrypted_key;
          if (flattened.header)
            jwe2.recipients[0].header = flattened.header;
          return jwe2;
        }
        let enc;
        for (let i = 0; i < this._recipients.length; i++) {
          const recipient = this._recipients[i];
          if (!is_disjoint_default(this._protectedHeader, this._unprotectedHeader, recipient.unprotectedHeader)) {
            throw new JWEInvalid("JWE Protected, JWE Shared Unprotected and JWE Per-Recipient Header Parameter names must be disjoint");
          }
          const joseHeader = {
            ...this._protectedHeader,
            ...this._unprotectedHeader,
            ...recipient.unprotectedHeader
          };
          const { alg } = joseHeader;
          if (typeof alg !== "string" || !alg) {
            throw new JWEInvalid('JWE "alg" (Algorithm) Header Parameter missing or invalid');
          }
          if (alg === "dir" || alg === "ECDH-ES") {
            throw new JWEInvalid('"dir" and "ECDH-ES" alg may only be used with a single recipient');
          }
          if (typeof joseHeader.enc !== "string" || !joseHeader.enc) {
            throw new JWEInvalid('JWE "enc" (Encryption Algorithm) Header Parameter missing or invalid');
          }
          if (!enc) {
            enc = joseHeader.enc;
          } else if (enc !== joseHeader.enc) {
            throw new JWEInvalid('JWE "enc" (Encryption Algorithm) Header Parameter must be the same for all recipients');
          }
          validate_crit_default(JWEInvalid, /* @__PURE__ */ new Map(), recipient.options.crit, this._protectedHeader, joseHeader);
          if (joseHeader.zip !== void 0) {
            throw new JOSENotSupported('JWE "zip" (Compression Algorithm) Header Parameter is not supported.');
          }
        }
        const cek = cek_default(enc);
        const jwe = {
          ciphertext: "",
          iv: "",
          recipients: [],
          tag: ""
        };
        for (let i = 0; i < this._recipients.length; i++) {
          const recipient = this._recipients[i];
          const target = {};
          jwe.recipients.push(target);
          const joseHeader = {
            ...this._protectedHeader,
            ...this._unprotectedHeader,
            ...recipient.unprotectedHeader
          };
          const p2c = joseHeader.alg.startsWith("PBES2") ? 2048 + i : void 0;
          if (i === 0) {
            const flattened = await new FlattenedEncrypt(this._plaintext).setAdditionalAuthenticatedData(this._aad).setContentEncryptionKey(cek).setProtectedHeader(this._protectedHeader).setSharedUnprotectedHeader(this._unprotectedHeader).setUnprotectedHeader(recipient.unprotectedHeader).setKeyManagementParameters({ p2c }).encrypt(recipient.key, {
              ...recipient.options,
              [unprotected]: true
            });
            jwe.ciphertext = flattened.ciphertext;
            jwe.iv = flattened.iv;
            jwe.tag = flattened.tag;
            if (flattened.aad)
              jwe.aad = flattened.aad;
            if (flattened.protected)
              jwe.protected = flattened.protected;
            if (flattened.unprotected)
              jwe.unprotected = flattened.unprotected;
            target.encrypted_key = flattened.encrypted_key;
            if (flattened.header)
              target.header = flattened.header;
            continue;
          }
          const { encryptedKey, parameters } = await encrypt_key_management_default(recipient.unprotectedHeader?.alg || this._protectedHeader?.alg || this._unprotectedHeader?.alg, enc, recipient.key, cek, { p2c });
          target.encrypted_key = encode(encryptedKey);
          if (recipient.unprotectedHeader || parameters)
            target.header = { ...recipient.unprotectedHeader, ...parameters };
        }
        return jwe;
      }
    };
  }
});

// ../../node_modules/jose/dist/browser/runtime/subtle_dsa.js
function subtleDsa(alg, algorithm) {
  const hash = `SHA-${alg.slice(-3)}`;
  switch (alg) {
    case "HS256":
    case "HS384":
    case "HS512":
      return { hash, name: "HMAC" };
    case "PS256":
    case "PS384":
    case "PS512":
      return { hash, name: "RSA-PSS", saltLength: alg.slice(-3) >> 3 };
    case "RS256":
    case "RS384":
    case "RS512":
      return { hash, name: "RSASSA-PKCS1-v1_5" };
    case "ES256":
    case "ES384":
    case "ES512":
      return { hash, name: "ECDSA", namedCurve: algorithm.namedCurve };
    case "Ed25519":
      return { name: "Ed25519" };
    case "EdDSA":
      return { name: algorithm.name };
    default:
      throw new JOSENotSupported(`alg ${alg} is not supported either by JOSE or your javascript runtime`);
  }
}
var init_subtle_dsa = __esm({
  "../../node_modules/jose/dist/browser/runtime/subtle_dsa.js"() {
    init_errors();
    __name(subtleDsa, "subtleDsa");
  }
});

// ../../node_modules/jose/dist/browser/runtime/get_sign_verify_key.js
async function getCryptoKey3(alg, key, usage) {
  if (usage === "sign") {
    key = await normalize_key_default.normalizePrivateKey(key, alg);
  }
  if (usage === "verify") {
    key = await normalize_key_default.normalizePublicKey(key, alg);
  }
  if (isCryptoKey(key)) {
    checkSigCryptoKey(key, alg, usage);
    return key;
  }
  if (key instanceof Uint8Array) {
    if (!alg.startsWith("HS")) {
      throw new TypeError(invalid_key_input_default(key, ...types));
    }
    return webcrypto_default.subtle.importKey("raw", key, { hash: `SHA-${alg.slice(-3)}`, name: "HMAC" }, false, [usage]);
  }
  throw new TypeError(invalid_key_input_default(key, ...types, "Uint8Array", "JSON Web Key"));
}
var init_get_sign_verify_key = __esm({
  "../../node_modules/jose/dist/browser/runtime/get_sign_verify_key.js"() {
    init_webcrypto();
    init_crypto_key();
    init_invalid_key_input();
    init_is_key_like();
    init_normalize_key();
    __name(getCryptoKey3, "getCryptoKey");
  }
});

// ../../node_modules/jose/dist/browser/runtime/verify.js
var verify, verify_default;
var init_verify = __esm({
  "../../node_modules/jose/dist/browser/runtime/verify.js"() {
    init_subtle_dsa();
    init_webcrypto();
    init_check_key_length();
    init_get_sign_verify_key();
    verify = /* @__PURE__ */ __name(async (alg, key, signature, data) => {
      const cryptoKey = await getCryptoKey3(alg, key, "verify");
      check_key_length_default(alg, cryptoKey);
      const algorithm = subtleDsa(alg, cryptoKey.algorithm);
      try {
        return await webcrypto_default.subtle.verify(algorithm, cryptoKey, signature, data);
      } catch {
        return false;
      }
    }, "verify");
    verify_default = verify;
  }
});

// ../../node_modules/jose/dist/browser/jws/flattened/verify.js
async function flattenedVerify(jws, key, options) {
  if (!isObject(jws)) {
    throw new JWSInvalid("Flattened JWS must be an object");
  }
  if (jws.protected === void 0 && jws.header === void 0) {
    throw new JWSInvalid('Flattened JWS must have either of the "protected" or "header" members');
  }
  if (jws.protected !== void 0 && typeof jws.protected !== "string") {
    throw new JWSInvalid("JWS Protected Header incorrect type");
  }
  if (jws.payload === void 0) {
    throw new JWSInvalid("JWS Payload missing");
  }
  if (typeof jws.signature !== "string") {
    throw new JWSInvalid("JWS Signature missing or incorrect type");
  }
  if (jws.header !== void 0 && !isObject(jws.header)) {
    throw new JWSInvalid("JWS Unprotected Header incorrect type");
  }
  let parsedProt = {};
  if (jws.protected) {
    try {
      const protectedHeader = decode(jws.protected);
      parsedProt = JSON.parse(decoder.decode(protectedHeader));
    } catch {
      throw new JWSInvalid("JWS Protected Header is invalid");
    }
  }
  if (!is_disjoint_default(parsedProt, jws.header)) {
    throw new JWSInvalid("JWS Protected and JWS Unprotected Header Parameter names must be disjoint");
  }
  const joseHeader = {
    ...parsedProt,
    ...jws.header
  };
  const extensions = validate_crit_default(JWSInvalid, /* @__PURE__ */ new Map([["b64", true]]), options?.crit, parsedProt, joseHeader);
  let b64 = true;
  if (extensions.has("b64")) {
    b64 = parsedProt.b64;
    if (typeof b64 !== "boolean") {
      throw new JWSInvalid('The "b64" (base64url-encode payload) Header Parameter must be a boolean');
    }
  }
  const { alg } = joseHeader;
  if (typeof alg !== "string" || !alg) {
    throw new JWSInvalid('JWS "alg" (Algorithm) Header Parameter missing or invalid');
  }
  const algorithms = options && validate_algorithms_default("algorithms", options.algorithms);
  if (algorithms && !algorithms.has(alg)) {
    throw new JOSEAlgNotAllowed('"alg" (Algorithm) Header Parameter value not allowed');
  }
  if (b64) {
    if (typeof jws.payload !== "string") {
      throw new JWSInvalid("JWS Payload must be a string");
    }
  } else if (typeof jws.payload !== "string" && !(jws.payload instanceof Uint8Array)) {
    throw new JWSInvalid("JWS Payload must be a string or an Uint8Array instance");
  }
  let resolvedKey = false;
  if (typeof key === "function") {
    key = await key(parsedProt, jws);
    resolvedKey = true;
    checkKeyTypeWithJwk(alg, key, "verify");
    if (isJWK(key)) {
      key = await importJWK(key, alg);
    }
  } else {
    checkKeyTypeWithJwk(alg, key, "verify");
  }
  const data = concat(encoder.encode(jws.protected ?? ""), encoder.encode("."), typeof jws.payload === "string" ? encoder.encode(jws.payload) : jws.payload);
  let signature;
  try {
    signature = decode(jws.signature);
  } catch {
    throw new JWSInvalid("Failed to base64url decode the signature");
  }
  const verified = await verify_default(alg, key, signature, data);
  if (!verified) {
    throw new JWSSignatureVerificationFailed();
  }
  let payload;
  if (b64) {
    try {
      payload = decode(jws.payload);
    } catch {
      throw new JWSInvalid("Failed to base64url decode the payload");
    }
  } else if (typeof jws.payload === "string") {
    payload = encoder.encode(jws.payload);
  } else {
    payload = jws.payload;
  }
  const result = { payload };
  if (jws.protected !== void 0) {
    result.protectedHeader = parsedProt;
  }
  if (jws.header !== void 0) {
    result.unprotectedHeader = jws.header;
  }
  if (resolvedKey) {
    return { ...result, key };
  }
  return result;
}
var init_verify2 = __esm({
  "../../node_modules/jose/dist/browser/jws/flattened/verify.js"() {
    init_base64url();
    init_verify();
    init_errors();
    init_buffer_utils();
    init_is_disjoint();
    init_is_object();
    init_check_key_type();
    init_validate_crit();
    init_validate_algorithms();
    init_is_jwk();
    init_import();
    __name(flattenedVerify, "flattenedVerify");
  }
});

// ../../node_modules/jose/dist/browser/jws/compact/verify.js
async function compactVerify(jws, key, options) {
  if (jws instanceof Uint8Array) {
    jws = decoder.decode(jws);
  }
  if (typeof jws !== "string") {
    throw new JWSInvalid("Compact JWS must be a string or Uint8Array");
  }
  const { 0: protectedHeader, 1: payload, 2: signature, length } = jws.split(".");
  if (length !== 3) {
    throw new JWSInvalid("Invalid Compact JWS");
  }
  const verified = await flattenedVerify({ payload, protected: protectedHeader, signature }, key, options);
  const result = { payload: verified.payload, protectedHeader: verified.protectedHeader };
  if (typeof key === "function") {
    return { ...result, key: verified.key };
  }
  return result;
}
var init_verify3 = __esm({
  "../../node_modules/jose/dist/browser/jws/compact/verify.js"() {
    init_verify2();
    init_errors();
    init_buffer_utils();
    __name(compactVerify, "compactVerify");
  }
});

// ../../node_modules/jose/dist/browser/jws/general/verify.js
async function generalVerify(jws, key, options) {
  if (!isObject(jws)) {
    throw new JWSInvalid("General JWS must be an object");
  }
  if (!Array.isArray(jws.signatures) || !jws.signatures.every(isObject)) {
    throw new JWSInvalid("JWS Signatures missing or incorrect type");
  }
  for (const signature of jws.signatures) {
    try {
      return await flattenedVerify({
        header: signature.header,
        payload: jws.payload,
        protected: signature.protected,
        signature: signature.signature
      }, key, options);
    } catch {
    }
  }
  throw new JWSSignatureVerificationFailed();
}
var init_verify4 = __esm({
  "../../node_modules/jose/dist/browser/jws/general/verify.js"() {
    init_verify2();
    init_errors();
    init_is_object();
    __name(generalVerify, "generalVerify");
  }
});

// ../../node_modules/jose/dist/browser/lib/epoch.js
var epoch_default;
var init_epoch = __esm({
  "../../node_modules/jose/dist/browser/lib/epoch.js"() {
    epoch_default = /* @__PURE__ */ __name((date) => Math.floor(date.getTime() / 1e3), "default");
  }
});

// ../../node_modules/jose/dist/browser/lib/secs.js
var minute, hour, day, week, year, REGEX, secs_default;
var init_secs = __esm({
  "../../node_modules/jose/dist/browser/lib/secs.js"() {
    minute = 60;
    hour = minute * 60;
    day = hour * 24;
    week = day * 7;
    year = day * 365.25;
    REGEX = /^(\+|\-)? ?(\d+|\d+\.\d+) ?(seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d|weeks?|w|years?|yrs?|y)(?: (ago|from now))?$/i;
    secs_default = /* @__PURE__ */ __name((str) => {
      const matched = REGEX.exec(str);
      if (!matched || matched[4] && matched[1]) {
        throw new TypeError("Invalid time period format");
      }
      const value = parseFloat(matched[2]);
      const unit = matched[3].toLowerCase();
      let numericDate;
      switch (unit) {
        case "sec":
        case "secs":
        case "second":
        case "seconds":
        case "s":
          numericDate = Math.round(value);
          break;
        case "minute":
        case "minutes":
        case "min":
        case "mins":
        case "m":
          numericDate = Math.round(value * minute);
          break;
        case "hour":
        case "hours":
        case "hr":
        case "hrs":
        case "h":
          numericDate = Math.round(value * hour);
          break;
        case "day":
        case "days":
        case "d":
          numericDate = Math.round(value * day);
          break;
        case "week":
        case "weeks":
        case "w":
          numericDate = Math.round(value * week);
          break;
        default:
          numericDate = Math.round(value * year);
          break;
      }
      if (matched[1] === "-" || matched[4] === "ago") {
        return -numericDate;
      }
      return numericDate;
    }, "default");
  }
});

// ../../node_modules/jose/dist/browser/lib/jwt_claims_set.js
var normalizeTyp, checkAudiencePresence, jwt_claims_set_default;
var init_jwt_claims_set = __esm({
  "../../node_modules/jose/dist/browser/lib/jwt_claims_set.js"() {
    init_errors();
    init_buffer_utils();
    init_epoch();
    init_secs();
    init_is_object();
    normalizeTyp = /* @__PURE__ */ __name((value) => value.toLowerCase().replace(/^application\//, ""), "normalizeTyp");
    checkAudiencePresence = /* @__PURE__ */ __name((audPayload, audOption) => {
      if (typeof audPayload === "string") {
        return audOption.includes(audPayload);
      }
      if (Array.isArray(audPayload)) {
        return audOption.some(Set.prototype.has.bind(new Set(audPayload)));
      }
      return false;
    }, "checkAudiencePresence");
    jwt_claims_set_default = /* @__PURE__ */ __name((protectedHeader, encodedPayload, options = {}) => {
      let payload;
      try {
        payload = JSON.parse(decoder.decode(encodedPayload));
      } catch {
      }
      if (!isObject(payload)) {
        throw new JWTInvalid("JWT Claims Set must be a top-level JSON object");
      }
      const { typ } = options;
      if (typ && (typeof protectedHeader.typ !== "string" || normalizeTyp(protectedHeader.typ) !== normalizeTyp(typ))) {
        throw new JWTClaimValidationFailed('unexpected "typ" JWT header value', payload, "typ", "check_failed");
      }
      const { requiredClaims = [], issuer, subject, audience, maxTokenAge } = options;
      const presenceCheck = [...requiredClaims];
      if (maxTokenAge !== void 0)
        presenceCheck.push("iat");
      if (audience !== void 0)
        presenceCheck.push("aud");
      if (subject !== void 0)
        presenceCheck.push("sub");
      if (issuer !== void 0)
        presenceCheck.push("iss");
      for (const claim of new Set(presenceCheck.reverse())) {
        if (!(claim in payload)) {
          throw new JWTClaimValidationFailed(`missing required "${claim}" claim`, payload, claim, "missing");
        }
      }
      if (issuer && !(Array.isArray(issuer) ? issuer : [issuer]).includes(payload.iss)) {
        throw new JWTClaimValidationFailed('unexpected "iss" claim value', payload, "iss", "check_failed");
      }
      if (subject && payload.sub !== subject) {
        throw new JWTClaimValidationFailed('unexpected "sub" claim value', payload, "sub", "check_failed");
      }
      if (audience && !checkAudiencePresence(payload.aud, typeof audience === "string" ? [audience] : audience)) {
        throw new JWTClaimValidationFailed('unexpected "aud" claim value', payload, "aud", "check_failed");
      }
      let tolerance;
      switch (typeof options.clockTolerance) {
        case "string":
          tolerance = secs_default(options.clockTolerance);
          break;
        case "number":
          tolerance = options.clockTolerance;
          break;
        case "undefined":
          tolerance = 0;
          break;
        default:
          throw new TypeError("Invalid clockTolerance option type");
      }
      const { currentDate } = options;
      const now = epoch_default(currentDate || /* @__PURE__ */ new Date());
      if ((payload.iat !== void 0 || maxTokenAge) && typeof payload.iat !== "number") {
        throw new JWTClaimValidationFailed('"iat" claim must be a number', payload, "iat", "invalid");
      }
      if (payload.nbf !== void 0) {
        if (typeof payload.nbf !== "number") {
          throw new JWTClaimValidationFailed('"nbf" claim must be a number', payload, "nbf", "invalid");
        }
        if (payload.nbf > now + tolerance) {
          throw new JWTClaimValidationFailed('"nbf" claim timestamp check failed', payload, "nbf", "check_failed");
        }
      }
      if (payload.exp !== void 0) {
        if (typeof payload.exp !== "number") {
          throw new JWTClaimValidationFailed('"exp" claim must be a number', payload, "exp", "invalid");
        }
        if (payload.exp <= now - tolerance) {
          throw new JWTExpired('"exp" claim timestamp check failed', payload, "exp", "check_failed");
        }
      }
      if (maxTokenAge) {
        const age = now - payload.iat;
        const max = typeof maxTokenAge === "number" ? maxTokenAge : secs_default(maxTokenAge);
        if (age - tolerance > max) {
          throw new JWTExpired('"iat" claim timestamp check failed (too far in the past)', payload, "iat", "check_failed");
        }
        if (age < 0 - tolerance) {
          throw new JWTClaimValidationFailed('"iat" claim timestamp check failed (it should be in the past)', payload, "iat", "check_failed");
        }
      }
      return payload;
    }, "default");
  }
});

// ../../node_modules/jose/dist/browser/jwt/verify.js
async function jwtVerify(jwt, key, options) {
  const verified = await compactVerify(jwt, key, options);
  if (verified.protectedHeader.crit?.includes("b64") && verified.protectedHeader.b64 === false) {
    throw new JWTInvalid("JWTs MUST NOT use unencoded payload");
  }
  const payload = jwt_claims_set_default(verified.protectedHeader, verified.payload, options);
  const result = { payload, protectedHeader: verified.protectedHeader };
  if (typeof key === "function") {
    return { ...result, key: verified.key };
  }
  return result;
}
var init_verify5 = __esm({
  "../../node_modules/jose/dist/browser/jwt/verify.js"() {
    init_verify3();
    init_jwt_claims_set();
    init_errors();
    __name(jwtVerify, "jwtVerify");
  }
});

// ../../node_modules/jose/dist/browser/jwt/decrypt.js
async function jwtDecrypt(jwt, key, options) {
  const decrypted = await compactDecrypt(jwt, key, options);
  const payload = jwt_claims_set_default(decrypted.protectedHeader, decrypted.plaintext, options);
  const { protectedHeader } = decrypted;
  if (protectedHeader.iss !== void 0 && protectedHeader.iss !== payload.iss) {
    throw new JWTClaimValidationFailed('replicated "iss" claim header parameter mismatch', payload, "iss", "mismatch");
  }
  if (protectedHeader.sub !== void 0 && protectedHeader.sub !== payload.sub) {
    throw new JWTClaimValidationFailed('replicated "sub" claim header parameter mismatch', payload, "sub", "mismatch");
  }
  if (protectedHeader.aud !== void 0 && JSON.stringify(protectedHeader.aud) !== JSON.stringify(payload.aud)) {
    throw new JWTClaimValidationFailed('replicated "aud" claim header parameter mismatch', payload, "aud", "mismatch");
  }
  const result = { payload, protectedHeader };
  if (typeof key === "function") {
    return { ...result, key: decrypted.key };
  }
  return result;
}
var init_decrypt5 = __esm({
  "../../node_modules/jose/dist/browser/jwt/decrypt.js"() {
    init_decrypt3();
    init_jwt_claims_set();
    init_errors();
    __name(jwtDecrypt, "jwtDecrypt");
  }
});

// ../../node_modules/jose/dist/browser/jwe/compact/encrypt.js
var CompactEncrypt;
var init_encrypt4 = __esm({
  "../../node_modules/jose/dist/browser/jwe/compact/encrypt.js"() {
    init_encrypt2();
    CompactEncrypt = class {
      static {
        __name(this, "CompactEncrypt");
      }
      constructor(plaintext) {
        this._flattened = new FlattenedEncrypt(plaintext);
      }
      setContentEncryptionKey(cek) {
        this._flattened.setContentEncryptionKey(cek);
        return this;
      }
      setInitializationVector(iv) {
        this._flattened.setInitializationVector(iv);
        return this;
      }
      setProtectedHeader(protectedHeader) {
        this._flattened.setProtectedHeader(protectedHeader);
        return this;
      }
      setKeyManagementParameters(parameters) {
        this._flattened.setKeyManagementParameters(parameters);
        return this;
      }
      async encrypt(key, options) {
        const jwe = await this._flattened.encrypt(key, options);
        return [jwe.protected, jwe.encrypted_key, jwe.iv, jwe.ciphertext, jwe.tag].join(".");
      }
    };
  }
});

// ../../node_modules/jose/dist/browser/runtime/sign.js
var sign, sign_default;
var init_sign = __esm({
  "../../node_modules/jose/dist/browser/runtime/sign.js"() {
    init_subtle_dsa();
    init_webcrypto();
    init_check_key_length();
    init_get_sign_verify_key();
    sign = /* @__PURE__ */ __name(async (alg, key, data) => {
      const cryptoKey = await getCryptoKey3(alg, key, "sign");
      check_key_length_default(alg, cryptoKey);
      const signature = await webcrypto_default.subtle.sign(subtleDsa(alg, cryptoKey.algorithm), cryptoKey, data);
      return new Uint8Array(signature);
    }, "sign");
    sign_default = sign;
  }
});

// ../../node_modules/jose/dist/browser/jws/flattened/sign.js
var FlattenedSign;
var init_sign2 = __esm({
  "../../node_modules/jose/dist/browser/jws/flattened/sign.js"() {
    init_base64url();
    init_sign();
    init_is_disjoint();
    init_errors();
    init_buffer_utils();
    init_check_key_type();
    init_validate_crit();
    FlattenedSign = class {
      static {
        __name(this, "FlattenedSign");
      }
      constructor(payload) {
        if (!(payload instanceof Uint8Array)) {
          throw new TypeError("payload must be an instance of Uint8Array");
        }
        this._payload = payload;
      }
      setProtectedHeader(protectedHeader) {
        if (this._protectedHeader) {
          throw new TypeError("setProtectedHeader can only be called once");
        }
        this._protectedHeader = protectedHeader;
        return this;
      }
      setUnprotectedHeader(unprotectedHeader) {
        if (this._unprotectedHeader) {
          throw new TypeError("setUnprotectedHeader can only be called once");
        }
        this._unprotectedHeader = unprotectedHeader;
        return this;
      }
      async sign(key, options) {
        if (!this._protectedHeader && !this._unprotectedHeader) {
          throw new JWSInvalid("either setProtectedHeader or setUnprotectedHeader must be called before #sign()");
        }
        if (!is_disjoint_default(this._protectedHeader, this._unprotectedHeader)) {
          throw new JWSInvalid("JWS Protected and JWS Unprotected Header Parameter names must be disjoint");
        }
        const joseHeader = {
          ...this._protectedHeader,
          ...this._unprotectedHeader
        };
        const extensions = validate_crit_default(JWSInvalid, /* @__PURE__ */ new Map([["b64", true]]), options?.crit, this._protectedHeader, joseHeader);
        let b64 = true;
        if (extensions.has("b64")) {
          b64 = this._protectedHeader.b64;
          if (typeof b64 !== "boolean") {
            throw new JWSInvalid('The "b64" (base64url-encode payload) Header Parameter must be a boolean');
          }
        }
        const { alg } = joseHeader;
        if (typeof alg !== "string" || !alg) {
          throw new JWSInvalid('JWS "alg" (Algorithm) Header Parameter missing or invalid');
        }
        checkKeyTypeWithJwk(alg, key, "sign");
        let payload = this._payload;
        if (b64) {
          payload = encoder.encode(encode(payload));
        }
        let protectedHeader;
        if (this._protectedHeader) {
          protectedHeader = encoder.encode(encode(JSON.stringify(this._protectedHeader)));
        } else {
          protectedHeader = encoder.encode("");
        }
        const data = concat(protectedHeader, encoder.encode("."), payload);
        const signature = await sign_default(alg, key, data);
        const jws = {
          signature: encode(signature),
          payload: ""
        };
        if (b64) {
          jws.payload = decoder.decode(payload);
        }
        if (this._unprotectedHeader) {
          jws.header = this._unprotectedHeader;
        }
        if (this._protectedHeader) {
          jws.protected = decoder.decode(protectedHeader);
        }
        return jws;
      }
    };
  }
});

// ../../node_modules/jose/dist/browser/jws/compact/sign.js
var CompactSign;
var init_sign3 = __esm({
  "../../node_modules/jose/dist/browser/jws/compact/sign.js"() {
    init_sign2();
    CompactSign = class {
      static {
        __name(this, "CompactSign");
      }
      constructor(payload) {
        this._flattened = new FlattenedSign(payload);
      }
      setProtectedHeader(protectedHeader) {
        this._flattened.setProtectedHeader(protectedHeader);
        return this;
      }
      async sign(key, options) {
        const jws = await this._flattened.sign(key, options);
        if (jws.payload === void 0) {
          throw new TypeError("use the flattened module for creating JWS with b64: false");
        }
        return `${jws.protected}.${jws.payload}.${jws.signature}`;
      }
    };
  }
});

// ../../node_modules/jose/dist/browser/jws/general/sign.js
var IndividualSignature, GeneralSign;
var init_sign4 = __esm({
  "../../node_modules/jose/dist/browser/jws/general/sign.js"() {
    init_sign2();
    init_errors();
    IndividualSignature = class {
      static {
        __name(this, "IndividualSignature");
      }
      constructor(sig, key, options) {
        this.parent = sig;
        this.key = key;
        this.options = options;
      }
      setProtectedHeader(protectedHeader) {
        if (this.protectedHeader) {
          throw new TypeError("setProtectedHeader can only be called once");
        }
        this.protectedHeader = protectedHeader;
        return this;
      }
      setUnprotectedHeader(unprotectedHeader) {
        if (this.unprotectedHeader) {
          throw new TypeError("setUnprotectedHeader can only be called once");
        }
        this.unprotectedHeader = unprotectedHeader;
        return this;
      }
      addSignature(...args) {
        return this.parent.addSignature(...args);
      }
      sign(...args) {
        return this.parent.sign(...args);
      }
      done() {
        return this.parent;
      }
    };
    GeneralSign = class {
      static {
        __name(this, "GeneralSign");
      }
      constructor(payload) {
        this._signatures = [];
        this._payload = payload;
      }
      addSignature(key, options) {
        const signature = new IndividualSignature(this, key, options);
        this._signatures.push(signature);
        return signature;
      }
      async sign() {
        if (!this._signatures.length) {
          throw new JWSInvalid("at least one signature must be added");
        }
        const jws = {
          signatures: [],
          payload: ""
        };
        for (let i = 0; i < this._signatures.length; i++) {
          const signature = this._signatures[i];
          const flattened = new FlattenedSign(this._payload);
          flattened.setProtectedHeader(signature.protectedHeader);
          flattened.setUnprotectedHeader(signature.unprotectedHeader);
          const { payload, ...rest } = await flattened.sign(signature.key, signature.options);
          if (i === 0) {
            jws.payload = payload;
          } else if (jws.payload !== payload) {
            throw new JWSInvalid("inconsistent use of JWS Unencoded Payload (RFC7797)");
          }
          jws.signatures.push(rest);
        }
        return jws;
      }
    };
  }
});

// ../../node_modules/jose/dist/browser/jwt/produce.js
function validateInput(label, input) {
  if (!Number.isFinite(input)) {
    throw new TypeError(`Invalid ${label} input`);
  }
  return input;
}
var ProduceJWT;
var init_produce = __esm({
  "../../node_modules/jose/dist/browser/jwt/produce.js"() {
    init_epoch();
    init_is_object();
    init_secs();
    __name(validateInput, "validateInput");
    ProduceJWT = class {
      static {
        __name(this, "ProduceJWT");
      }
      constructor(payload = {}) {
        if (!isObject(payload)) {
          throw new TypeError("JWT Claims Set MUST be an object");
        }
        this._payload = payload;
      }
      setIssuer(issuer) {
        this._payload = { ...this._payload, iss: issuer };
        return this;
      }
      setSubject(subject) {
        this._payload = { ...this._payload, sub: subject };
        return this;
      }
      setAudience(audience) {
        this._payload = { ...this._payload, aud: audience };
        return this;
      }
      setJti(jwtId) {
        this._payload = { ...this._payload, jti: jwtId };
        return this;
      }
      setNotBefore(input) {
        if (typeof input === "number") {
          this._payload = { ...this._payload, nbf: validateInput("setNotBefore", input) };
        } else if (input instanceof Date) {
          this._payload = { ...this._payload, nbf: validateInput("setNotBefore", epoch_default(input)) };
        } else {
          this._payload = { ...this._payload, nbf: epoch_default(/* @__PURE__ */ new Date()) + secs_default(input) };
        }
        return this;
      }
      setExpirationTime(input) {
        if (typeof input === "number") {
          this._payload = { ...this._payload, exp: validateInput("setExpirationTime", input) };
        } else if (input instanceof Date) {
          this._payload = { ...this._payload, exp: validateInput("setExpirationTime", epoch_default(input)) };
        } else {
          this._payload = { ...this._payload, exp: epoch_default(/* @__PURE__ */ new Date()) + secs_default(input) };
        }
        return this;
      }
      setIssuedAt(input) {
        if (typeof input === "undefined") {
          this._payload = { ...this._payload, iat: epoch_default(/* @__PURE__ */ new Date()) };
        } else if (input instanceof Date) {
          this._payload = { ...this._payload, iat: validateInput("setIssuedAt", epoch_default(input)) };
        } else if (typeof input === "string") {
          this._payload = {
            ...this._payload,
            iat: validateInput("setIssuedAt", epoch_default(/* @__PURE__ */ new Date()) + secs_default(input))
          };
        } else {
          this._payload = { ...this._payload, iat: validateInput("setIssuedAt", input) };
        }
        return this;
      }
    };
  }
});

// ../../node_modules/jose/dist/browser/jwt/sign.js
var SignJWT;
var init_sign5 = __esm({
  "../../node_modules/jose/dist/browser/jwt/sign.js"() {
    init_sign3();
    init_errors();
    init_buffer_utils();
    init_produce();
    SignJWT = class extends ProduceJWT {
      static {
        __name(this, "SignJWT");
      }
      setProtectedHeader(protectedHeader) {
        this._protectedHeader = protectedHeader;
        return this;
      }
      async sign(key, options) {
        const sig = new CompactSign(encoder.encode(JSON.stringify(this._payload)));
        sig.setProtectedHeader(this._protectedHeader);
        if (Array.isArray(this._protectedHeader?.crit) && this._protectedHeader.crit.includes("b64") && this._protectedHeader.b64 === false) {
          throw new JWTInvalid("JWTs MUST NOT use unencoded payload");
        }
        return sig.sign(key, options);
      }
    };
  }
});

// ../../node_modules/jose/dist/browser/jwt/encrypt.js
var EncryptJWT;
var init_encrypt5 = __esm({
  "../../node_modules/jose/dist/browser/jwt/encrypt.js"() {
    init_encrypt4();
    init_buffer_utils();
    init_produce();
    EncryptJWT = class extends ProduceJWT {
      static {
        __name(this, "EncryptJWT");
      }
      setProtectedHeader(protectedHeader) {
        if (this._protectedHeader) {
          throw new TypeError("setProtectedHeader can only be called once");
        }
        this._protectedHeader = protectedHeader;
        return this;
      }
      setKeyManagementParameters(parameters) {
        if (this._keyManagementParameters) {
          throw new TypeError("setKeyManagementParameters can only be called once");
        }
        this._keyManagementParameters = parameters;
        return this;
      }
      setContentEncryptionKey(cek) {
        if (this._cek) {
          throw new TypeError("setContentEncryptionKey can only be called once");
        }
        this._cek = cek;
        return this;
      }
      setInitializationVector(iv) {
        if (this._iv) {
          throw new TypeError("setInitializationVector can only be called once");
        }
        this._iv = iv;
        return this;
      }
      replicateIssuerAsHeader() {
        this._replicateIssuerAsHeader = true;
        return this;
      }
      replicateSubjectAsHeader() {
        this._replicateSubjectAsHeader = true;
        return this;
      }
      replicateAudienceAsHeader() {
        this._replicateAudienceAsHeader = true;
        return this;
      }
      async encrypt(key, options) {
        const enc = new CompactEncrypt(encoder.encode(JSON.stringify(this._payload)));
        if (this._replicateIssuerAsHeader) {
          this._protectedHeader = { ...this._protectedHeader, iss: this._payload.iss };
        }
        if (this._replicateSubjectAsHeader) {
          this._protectedHeader = { ...this._protectedHeader, sub: this._payload.sub };
        }
        if (this._replicateAudienceAsHeader) {
          this._protectedHeader = { ...this._protectedHeader, aud: this._payload.aud };
        }
        enc.setProtectedHeader(this._protectedHeader);
        if (this._iv) {
          enc.setInitializationVector(this._iv);
        }
        if (this._cek) {
          enc.setContentEncryptionKey(this._cek);
        }
        if (this._keyManagementParameters) {
          enc.setKeyManagementParameters(this._keyManagementParameters);
        }
        return enc.encrypt(key, options);
      }
    };
  }
});

// ../../node_modules/jose/dist/browser/jwk/thumbprint.js
async function calculateJwkThumbprint(jwk, digestAlgorithm) {
  if (!isObject(jwk)) {
    throw new TypeError("JWK must be an object");
  }
  digestAlgorithm ?? (digestAlgorithm = "sha256");
  if (digestAlgorithm !== "sha256" && digestAlgorithm !== "sha384" && digestAlgorithm !== "sha512") {
    throw new TypeError('digestAlgorithm must one of "sha256", "sha384", or "sha512"');
  }
  let components;
  switch (jwk.kty) {
    case "EC":
      check(jwk.crv, '"crv" (Curve) Parameter');
      check(jwk.x, '"x" (X Coordinate) Parameter');
      check(jwk.y, '"y" (Y Coordinate) Parameter');
      components = { crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y };
      break;
    case "OKP":
      check(jwk.crv, '"crv" (Subtype of Key Pair) Parameter');
      check(jwk.x, '"x" (Public Key) Parameter');
      components = { crv: jwk.crv, kty: jwk.kty, x: jwk.x };
      break;
    case "RSA":
      check(jwk.e, '"e" (Exponent) Parameter');
      check(jwk.n, '"n" (Modulus) Parameter');
      components = { e: jwk.e, kty: jwk.kty, n: jwk.n };
      break;
    case "oct":
      check(jwk.k, '"k" (Key Value) Parameter');
      components = { k: jwk.k, kty: jwk.kty };
      break;
    default:
      throw new JOSENotSupported('"kty" (Key Type) Parameter missing or unsupported');
  }
  const data = encoder.encode(JSON.stringify(components));
  return encode(await digest_default(digestAlgorithm, data));
}
async function calculateJwkThumbprintUri(jwk, digestAlgorithm) {
  digestAlgorithm ?? (digestAlgorithm = "sha256");
  const thumbprint = await calculateJwkThumbprint(jwk, digestAlgorithm);
  return `urn:ietf:params:oauth:jwk-thumbprint:sha-${digestAlgorithm.slice(-3)}:${thumbprint}`;
}
var check;
var init_thumbprint = __esm({
  "../../node_modules/jose/dist/browser/jwk/thumbprint.js"() {
    init_digest();
    init_base64url();
    init_errors();
    init_buffer_utils();
    init_is_object();
    check = /* @__PURE__ */ __name((value, description) => {
      if (typeof value !== "string" || !value) {
        throw new JWKInvalid(`${description} missing or invalid`);
      }
    }, "check");
    __name(calculateJwkThumbprint, "calculateJwkThumbprint");
    __name(calculateJwkThumbprintUri, "calculateJwkThumbprintUri");
  }
});

// ../../node_modules/jose/dist/browser/jwk/embedded.js
async function EmbeddedJWK(protectedHeader, token) {
  const joseHeader = {
    ...protectedHeader,
    ...token?.header
  };
  if (!isObject(joseHeader.jwk)) {
    throw new JWSInvalid('"jwk" (JSON Web Key) Header Parameter must be a JSON object');
  }
  const key = await importJWK({ ...joseHeader.jwk, ext: true }, joseHeader.alg);
  if (key instanceof Uint8Array || key.type !== "public") {
    throw new JWSInvalid('"jwk" (JSON Web Key) Header Parameter must be a public key');
  }
  return key;
}
var init_embedded = __esm({
  "../../node_modules/jose/dist/browser/jwk/embedded.js"() {
    init_import();
    init_is_object();
    init_errors();
    __name(EmbeddedJWK, "EmbeddedJWK");
  }
});

// ../../node_modules/jose/dist/browser/jwks/local.js
function getKtyFromAlg(alg) {
  switch (typeof alg === "string" && alg.slice(0, 2)) {
    case "RS":
    case "PS":
      return "RSA";
    case "ES":
      return "EC";
    case "Ed":
      return "OKP";
    default:
      throw new JOSENotSupported('Unsupported "alg" value for a JSON Web Key Set');
  }
}
function isJWKSLike(jwks) {
  return jwks && typeof jwks === "object" && Array.isArray(jwks.keys) && jwks.keys.every(isJWKLike);
}
function isJWKLike(key) {
  return isObject(key);
}
function clone(obj) {
  if (typeof structuredClone === "function") {
    return structuredClone(obj);
  }
  return JSON.parse(JSON.stringify(obj));
}
async function importWithAlgCache(cache, jwk, alg) {
  const cached = cache.get(jwk) || cache.set(jwk, {}).get(jwk);
  if (cached[alg] === void 0) {
    const key = await importJWK({ ...jwk, ext: true }, alg);
    if (key instanceof Uint8Array || key.type !== "public") {
      throw new JWKSInvalid("JSON Web Key Set members must be public keys");
    }
    cached[alg] = key;
  }
  return cached[alg];
}
function createLocalJWKSet(jwks) {
  const set = new LocalJWKSet(jwks);
  const localJWKSet = /* @__PURE__ */ __name(async (protectedHeader, token) => set.getKey(protectedHeader, token), "localJWKSet");
  Object.defineProperties(localJWKSet, {
    jwks: {
      value: /* @__PURE__ */ __name(() => clone(set._jwks), "value"),
      enumerable: true,
      configurable: false,
      writable: false
    }
  });
  return localJWKSet;
}
var LocalJWKSet;
var init_local = __esm({
  "../../node_modules/jose/dist/browser/jwks/local.js"() {
    init_import();
    init_errors();
    init_is_object();
    __name(getKtyFromAlg, "getKtyFromAlg");
    __name(isJWKSLike, "isJWKSLike");
    __name(isJWKLike, "isJWKLike");
    __name(clone, "clone");
    LocalJWKSet = class {
      static {
        __name(this, "LocalJWKSet");
      }
      constructor(jwks) {
        this._cached = /* @__PURE__ */ new WeakMap();
        if (!isJWKSLike(jwks)) {
          throw new JWKSInvalid("JSON Web Key Set malformed");
        }
        this._jwks = clone(jwks);
      }
      async getKey(protectedHeader, token) {
        const { alg, kid } = { ...protectedHeader, ...token?.header };
        const kty = getKtyFromAlg(alg);
        const candidates = this._jwks.keys.filter((jwk2) => {
          let candidate = kty === jwk2.kty;
          if (candidate && typeof kid === "string") {
            candidate = kid === jwk2.kid;
          }
          if (candidate && typeof jwk2.alg === "string") {
            candidate = alg === jwk2.alg;
          }
          if (candidate && typeof jwk2.use === "string") {
            candidate = jwk2.use === "sig";
          }
          if (candidate && Array.isArray(jwk2.key_ops)) {
            candidate = jwk2.key_ops.includes("verify");
          }
          if (candidate) {
            switch (alg) {
              case "ES256":
                candidate = jwk2.crv === "P-256";
                break;
              case "ES256K":
                candidate = jwk2.crv === "secp256k1";
                break;
              case "ES384":
                candidate = jwk2.crv === "P-384";
                break;
              case "ES512":
                candidate = jwk2.crv === "P-521";
                break;
              case "Ed25519":
                candidate = jwk2.crv === "Ed25519";
                break;
              case "EdDSA":
                candidate = jwk2.crv === "Ed25519" || jwk2.crv === "Ed448";
                break;
            }
          }
          return candidate;
        });
        const { 0: jwk, length } = candidates;
        if (length === 0) {
          throw new JWKSNoMatchingKey();
        }
        if (length !== 1) {
          const error = new JWKSMultipleMatchingKeys();
          const { _cached } = this;
          error[Symbol.asyncIterator] = async function* () {
            for (const jwk2 of candidates) {
              try {
                yield await importWithAlgCache(_cached, jwk2, alg);
              } catch {
              }
            }
          };
          throw error;
        }
        return importWithAlgCache(this._cached, jwk, alg);
      }
    };
    __name(importWithAlgCache, "importWithAlgCache");
    __name(createLocalJWKSet, "createLocalJWKSet");
  }
});

// ../../node_modules/jose/dist/browser/runtime/fetch_jwks.js
var fetchJwks, fetch_jwks_default;
var init_fetch_jwks = __esm({
  "../../node_modules/jose/dist/browser/runtime/fetch_jwks.js"() {
    init_errors();
    fetchJwks = /* @__PURE__ */ __name(async (url, timeout, options) => {
      let controller;
      let id;
      let timedOut = false;
      if (typeof AbortController === "function") {
        controller = new AbortController();
        id = setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, timeout);
      }
      const response = await fetch(url.href, {
        signal: controller ? controller.signal : void 0,
        redirect: "manual",
        headers: options.headers
      }).catch((err2) => {
        if (timedOut)
          throw new JWKSTimeout();
        throw err2;
      });
      if (id !== void 0)
        clearTimeout(id);
      if (response.status !== 200) {
        throw new JOSEError("Expected 200 OK from the JSON Web Key Set HTTP response");
      }
      try {
        return await response.json();
      } catch {
        throw new JOSEError("Failed to parse the JSON Web Key Set HTTP response as JSON");
      }
    }, "fetchJwks");
    fetch_jwks_default = fetchJwks;
  }
});

// ../../node_modules/jose/dist/browser/jwks/remote.js
function isCloudflareWorkers() {
  return typeof WebSocketPair !== "undefined" || typeof navigator !== "undefined" && true || typeof EdgeRuntime !== "undefined" && EdgeRuntime === "vercel";
}
function isFreshJwksCache(input, cacheMaxAge) {
  if (typeof input !== "object" || input === null) {
    return false;
  }
  if (!("uat" in input) || typeof input.uat !== "number" || Date.now() - input.uat >= cacheMaxAge) {
    return false;
  }
  if (!("jwks" in input) || !isObject(input.jwks) || !Array.isArray(input.jwks.keys) || !Array.prototype.every.call(input.jwks.keys, isObject)) {
    return false;
  }
  return true;
}
function createRemoteJWKSet(url, options) {
  const set = new RemoteJWKSet(url, options);
  const remoteJWKSet = /* @__PURE__ */ __name(async (protectedHeader, token) => set.getKey(protectedHeader, token), "remoteJWKSet");
  Object.defineProperties(remoteJWKSet, {
    coolingDown: {
      get: /* @__PURE__ */ __name(() => set.coolingDown(), "get"),
      enumerable: true,
      configurable: false
    },
    fresh: {
      get: /* @__PURE__ */ __name(() => set.fresh(), "get"),
      enumerable: true,
      configurable: false
    },
    reload: {
      value: /* @__PURE__ */ __name(() => set.reload(), "value"),
      enumerable: true,
      configurable: false,
      writable: false
    },
    reloading: {
      get: /* @__PURE__ */ __name(() => !!set._pendingFetch, "get"),
      enumerable: true,
      configurable: false
    },
    jwks: {
      value: /* @__PURE__ */ __name(() => set._local?.jwks(), "value"),
      enumerable: true,
      configurable: false,
      writable: false
    }
  });
  return remoteJWKSet;
}
var USER_AGENT, jwksCache, RemoteJWKSet, experimental_jwksCache;
var init_remote = __esm({
  "../../node_modules/jose/dist/browser/jwks/remote.js"() {
    init_fetch_jwks();
    init_errors();
    init_local();
    init_is_object();
    __name(isCloudflareWorkers, "isCloudflareWorkers");
    if (typeof navigator === "undefined" || !"Cloudflare-Workers"?.startsWith?.("Mozilla/5.0 ")) {
      const NAME = "jose";
      const VERSION = "v5.10.0";
      USER_AGENT = `${NAME}/${VERSION}`;
    }
    jwksCache = /* @__PURE__ */ Symbol();
    __name(isFreshJwksCache, "isFreshJwksCache");
    RemoteJWKSet = class {
      static {
        __name(this, "RemoteJWKSet");
      }
      constructor(url, options) {
        if (!(url instanceof URL)) {
          throw new TypeError("url must be an instance of URL");
        }
        this._url = new URL(url.href);
        this._options = { agent: options?.agent, headers: options?.headers };
        this._timeoutDuration = typeof options?.timeoutDuration === "number" ? options?.timeoutDuration : 5e3;
        this._cooldownDuration = typeof options?.cooldownDuration === "number" ? options?.cooldownDuration : 3e4;
        this._cacheMaxAge = typeof options?.cacheMaxAge === "number" ? options?.cacheMaxAge : 6e5;
        if (options?.[jwksCache] !== void 0) {
          this._cache = options?.[jwksCache];
          if (isFreshJwksCache(options?.[jwksCache], this._cacheMaxAge)) {
            this._jwksTimestamp = this._cache.uat;
            this._local = createLocalJWKSet(this._cache.jwks);
          }
        }
      }
      coolingDown() {
        return typeof this._jwksTimestamp === "number" ? Date.now() < this._jwksTimestamp + this._cooldownDuration : false;
      }
      fresh() {
        return typeof this._jwksTimestamp === "number" ? Date.now() < this._jwksTimestamp + this._cacheMaxAge : false;
      }
      async getKey(protectedHeader, token) {
        if (!this._local || !this.fresh()) {
          await this.reload();
        }
        try {
          return await this._local(protectedHeader, token);
        } catch (err2) {
          if (err2 instanceof JWKSNoMatchingKey) {
            if (this.coolingDown() === false) {
              await this.reload();
              return this._local(protectedHeader, token);
            }
          }
          throw err2;
        }
      }
      async reload() {
        if (this._pendingFetch && isCloudflareWorkers()) {
          this._pendingFetch = void 0;
        }
        const headers = new Headers(this._options.headers);
        if (USER_AGENT && !headers.has("User-Agent")) {
          headers.set("User-Agent", USER_AGENT);
          this._options.headers = Object.fromEntries(headers.entries());
        }
        this._pendingFetch || (this._pendingFetch = fetch_jwks_default(this._url, this._timeoutDuration, this._options).then((json3) => {
          this._local = createLocalJWKSet(json3);
          if (this._cache) {
            this._cache.uat = Date.now();
            this._cache.jwks = json3;
          }
          this._jwksTimestamp = Date.now();
          this._pendingFetch = void 0;
        }).catch((err2) => {
          this._pendingFetch = void 0;
          throw err2;
        }));
        await this._pendingFetch;
      }
    };
    __name(createRemoteJWKSet, "createRemoteJWKSet");
    experimental_jwksCache = jwksCache;
  }
});

// ../../node_modules/jose/dist/browser/jwt/unsecured.js
var UnsecuredJWT;
var init_unsecured = __esm({
  "../../node_modules/jose/dist/browser/jwt/unsecured.js"() {
    init_base64url();
    init_buffer_utils();
    init_errors();
    init_jwt_claims_set();
    init_produce();
    UnsecuredJWT = class extends ProduceJWT {
      static {
        __name(this, "UnsecuredJWT");
      }
      encode() {
        const header = encode(JSON.stringify({ alg: "none" }));
        const payload = encode(JSON.stringify(this._payload));
        return `${header}.${payload}.`;
      }
      static decode(jwt, options) {
        if (typeof jwt !== "string") {
          throw new JWTInvalid("Unsecured JWT must be a string");
        }
        const { 0: encodedHeader, 1: encodedPayload, 2: signature, length } = jwt.split(".");
        if (length !== 3 || signature !== "") {
          throw new JWTInvalid("Invalid Unsecured JWT");
        }
        let header;
        try {
          header = JSON.parse(decoder.decode(decode(encodedHeader)));
          if (header.alg !== "none")
            throw new Error();
        } catch {
          throw new JWTInvalid("Invalid Unsecured JWT");
        }
        const payload = jwt_claims_set_default(header, decode(encodedPayload), options);
        return { payload, header };
      }
    };
  }
});

// ../../node_modules/jose/dist/browser/util/base64url.js
var base64url_exports2 = {};
__export(base64url_exports2, {
  decode: () => decode2,
  encode: () => encode2
});
var encode2, decode2;
var init_base64url2 = __esm({
  "../../node_modules/jose/dist/browser/util/base64url.js"() {
    init_base64url();
    encode2 = encode;
    decode2 = decode;
  }
});

// ../../node_modules/jose/dist/browser/util/decode_protected_header.js
function decodeProtectedHeader(token) {
  let protectedB64u;
  if (typeof token === "string") {
    const parts = token.split(".");
    if (parts.length === 3 || parts.length === 5) {
      ;
      [protectedB64u] = parts;
    }
  } else if (typeof token === "object" && token) {
    if ("protected" in token) {
      protectedB64u = token.protected;
    } else {
      throw new TypeError("Token does not contain a Protected Header");
    }
  }
  try {
    if (typeof protectedB64u !== "string" || !protectedB64u) {
      throw new Error();
    }
    const result = JSON.parse(decoder.decode(decode2(protectedB64u)));
    if (!isObject(result)) {
      throw new Error();
    }
    return result;
  } catch {
    throw new TypeError("Invalid Token or Protected Header formatting");
  }
}
var init_decode_protected_header = __esm({
  "../../node_modules/jose/dist/browser/util/decode_protected_header.js"() {
    init_base64url2();
    init_buffer_utils();
    init_is_object();
    __name(decodeProtectedHeader, "decodeProtectedHeader");
  }
});

// ../../node_modules/jose/dist/browser/util/decode_jwt.js
function decodeJwt(jwt) {
  if (typeof jwt !== "string")
    throw new JWTInvalid("JWTs must use Compact JWS serialization, JWT must be a string");
  const { 1: payload, length } = jwt.split(".");
  if (length === 5)
    throw new JWTInvalid("Only JWTs using Compact JWS serialization can be decoded");
  if (length !== 3)
    throw new JWTInvalid("Invalid JWT");
  if (!payload)
    throw new JWTInvalid("JWTs must contain a payload");
  let decoded;
  try {
    decoded = decode2(payload);
  } catch {
    throw new JWTInvalid("Failed to base64url decode the payload");
  }
  let result;
  try {
    result = JSON.parse(decoder.decode(decoded));
  } catch {
    throw new JWTInvalid("Failed to parse the decoded payload as JSON");
  }
  if (!isObject(result))
    throw new JWTInvalid("Invalid JWT Claims Set");
  return result;
}
var init_decode_jwt = __esm({
  "../../node_modules/jose/dist/browser/util/decode_jwt.js"() {
    init_base64url2();
    init_buffer_utils();
    init_is_object();
    init_errors();
    __name(decodeJwt, "decodeJwt");
  }
});

// ../../node_modules/jose/dist/browser/runtime/generate.js
async function generateSecret(alg, options) {
  let length;
  let algorithm;
  let keyUsages;
  switch (alg) {
    case "HS256":
    case "HS384":
    case "HS512":
      length = parseInt(alg.slice(-3), 10);
      algorithm = { name: "HMAC", hash: `SHA-${length}`, length };
      keyUsages = ["sign", "verify"];
      break;
    case "A128CBC-HS256":
    case "A192CBC-HS384":
    case "A256CBC-HS512":
      length = parseInt(alg.slice(-3), 10);
      return random_default(new Uint8Array(length >> 3));
    case "A128KW":
    case "A192KW":
    case "A256KW":
      length = parseInt(alg.slice(1, 4), 10);
      algorithm = { name: "AES-KW", length };
      keyUsages = ["wrapKey", "unwrapKey"];
      break;
    case "A128GCMKW":
    case "A192GCMKW":
    case "A256GCMKW":
    case "A128GCM":
    case "A192GCM":
    case "A256GCM":
      length = parseInt(alg.slice(1, 4), 10);
      algorithm = { name: "AES-GCM", length };
      keyUsages = ["encrypt", "decrypt"];
      break;
    default:
      throw new JOSENotSupported('Invalid or unsupported JWK "alg" (Algorithm) Parameter value');
  }
  return webcrypto_default.subtle.generateKey(algorithm, options?.extractable ?? false, keyUsages);
}
function getModulusLengthOption(options) {
  const modulusLength = options?.modulusLength ?? 2048;
  if (typeof modulusLength !== "number" || modulusLength < 2048) {
    throw new JOSENotSupported("Invalid or unsupported modulusLength option provided, 2048 bits or larger keys must be used");
  }
  return modulusLength;
}
async function generateKeyPair(alg, options) {
  let algorithm;
  let keyUsages;
  switch (alg) {
    case "PS256":
    case "PS384":
    case "PS512":
      algorithm = {
        name: "RSA-PSS",
        hash: `SHA-${alg.slice(-3)}`,
        publicExponent: new Uint8Array([1, 0, 1]),
        modulusLength: getModulusLengthOption(options)
      };
      keyUsages = ["sign", "verify"];
      break;
    case "RS256":
    case "RS384":
    case "RS512":
      algorithm = {
        name: "RSASSA-PKCS1-v1_5",
        hash: `SHA-${alg.slice(-3)}`,
        publicExponent: new Uint8Array([1, 0, 1]),
        modulusLength: getModulusLengthOption(options)
      };
      keyUsages = ["sign", "verify"];
      break;
    case "RSA-OAEP":
    case "RSA-OAEP-256":
    case "RSA-OAEP-384":
    case "RSA-OAEP-512":
      algorithm = {
        name: "RSA-OAEP",
        hash: `SHA-${parseInt(alg.slice(-3), 10) || 1}`,
        publicExponent: new Uint8Array([1, 0, 1]),
        modulusLength: getModulusLengthOption(options)
      };
      keyUsages = ["decrypt", "unwrapKey", "encrypt", "wrapKey"];
      break;
    case "ES256":
      algorithm = { name: "ECDSA", namedCurve: "P-256" };
      keyUsages = ["sign", "verify"];
      break;
    case "ES384":
      algorithm = { name: "ECDSA", namedCurve: "P-384" };
      keyUsages = ["sign", "verify"];
      break;
    case "ES512":
      algorithm = { name: "ECDSA", namedCurve: "P-521" };
      keyUsages = ["sign", "verify"];
      break;
    case "Ed25519":
      algorithm = { name: "Ed25519" };
      keyUsages = ["sign", "verify"];
      break;
    case "EdDSA": {
      keyUsages = ["sign", "verify"];
      const crv = options?.crv ?? "Ed25519";
      switch (crv) {
        case "Ed25519":
        case "Ed448":
          algorithm = { name: crv };
          break;
        default:
          throw new JOSENotSupported("Invalid or unsupported crv option provided");
      }
      break;
    }
    case "ECDH-ES":
    case "ECDH-ES+A128KW":
    case "ECDH-ES+A192KW":
    case "ECDH-ES+A256KW": {
      keyUsages = ["deriveKey", "deriveBits"];
      const crv = options?.crv ?? "P-256";
      switch (crv) {
        case "P-256":
        case "P-384":
        case "P-521": {
          algorithm = { name: "ECDH", namedCurve: crv };
          break;
        }
        case "X25519":
        case "X448":
          algorithm = { name: crv };
          break;
        default:
          throw new JOSENotSupported("Invalid or unsupported crv option provided, supported values are P-256, P-384, P-521, X25519, and X448");
      }
      break;
    }
    default:
      throw new JOSENotSupported('Invalid or unsupported JWK "alg" (Algorithm) Parameter value');
  }
  return webcrypto_default.subtle.generateKey(algorithm, options?.extractable ?? false, keyUsages);
}
var init_generate = __esm({
  "../../node_modules/jose/dist/browser/runtime/generate.js"() {
    init_webcrypto();
    init_errors();
    init_random();
    __name(generateSecret, "generateSecret");
    __name(getModulusLengthOption, "getModulusLengthOption");
    __name(generateKeyPair, "generateKeyPair");
  }
});

// ../../node_modules/jose/dist/browser/key/generate_key_pair.js
async function generateKeyPair2(alg, options) {
  return generateKeyPair(alg, options);
}
var init_generate_key_pair = __esm({
  "../../node_modules/jose/dist/browser/key/generate_key_pair.js"() {
    init_generate();
    __name(generateKeyPair2, "generateKeyPair");
  }
});

// ../../node_modules/jose/dist/browser/key/generate_secret.js
async function generateSecret2(alg, options) {
  return generateSecret(alg, options);
}
var init_generate_secret = __esm({
  "../../node_modules/jose/dist/browser/key/generate_secret.js"() {
    init_generate();
    __name(generateSecret2, "generateSecret");
  }
});

// ../../node_modules/jose/dist/browser/runtime/runtime.js
var runtime_default;
var init_runtime = __esm({
  "../../node_modules/jose/dist/browser/runtime/runtime.js"() {
    runtime_default = "WebCryptoAPI";
  }
});

// ../../node_modules/jose/dist/browser/util/runtime.js
var runtime_default2;
var init_runtime2 = __esm({
  "../../node_modules/jose/dist/browser/util/runtime.js"() {
    init_runtime();
    runtime_default2 = runtime_default;
  }
});

// ../../node_modules/jose/dist/browser/index.js
var browser_exports = {};
__export(browser_exports, {
  CompactEncrypt: () => CompactEncrypt,
  CompactSign: () => CompactSign,
  EmbeddedJWK: () => EmbeddedJWK,
  EncryptJWT: () => EncryptJWT,
  FlattenedEncrypt: () => FlattenedEncrypt,
  FlattenedSign: () => FlattenedSign,
  GeneralEncrypt: () => GeneralEncrypt,
  GeneralSign: () => GeneralSign,
  SignJWT: () => SignJWT,
  UnsecuredJWT: () => UnsecuredJWT,
  base64url: () => base64url_exports2,
  calculateJwkThumbprint: () => calculateJwkThumbprint,
  calculateJwkThumbprintUri: () => calculateJwkThumbprintUri,
  compactDecrypt: () => compactDecrypt,
  compactVerify: () => compactVerify,
  createLocalJWKSet: () => createLocalJWKSet,
  createRemoteJWKSet: () => createRemoteJWKSet,
  cryptoRuntime: () => runtime_default2,
  decodeJwt: () => decodeJwt,
  decodeProtectedHeader: () => decodeProtectedHeader,
  errors: () => errors_exports,
  experimental_jwksCache: () => experimental_jwksCache,
  exportJWK: () => exportJWK,
  exportPKCS8: () => exportPKCS8,
  exportSPKI: () => exportSPKI,
  flattenedDecrypt: () => flattenedDecrypt,
  flattenedVerify: () => flattenedVerify,
  generalDecrypt: () => generalDecrypt,
  generalVerify: () => generalVerify,
  generateKeyPair: () => generateKeyPair2,
  generateSecret: () => generateSecret2,
  importJWK: () => importJWK,
  importPKCS8: () => importPKCS8,
  importSPKI: () => importSPKI,
  importX509: () => importX509,
  jwksCache: () => jwksCache,
  jwtDecrypt: () => jwtDecrypt,
  jwtVerify: () => jwtVerify
});
var init_browser = __esm({
  "../../node_modules/jose/dist/browser/index.js"() {
    init_decrypt3();
    init_decrypt2();
    init_decrypt4();
    init_encrypt3();
    init_verify3();
    init_verify2();
    init_verify4();
    init_verify5();
    init_decrypt5();
    init_encrypt4();
    init_encrypt2();
    init_sign3();
    init_sign2();
    init_sign4();
    init_sign5();
    init_encrypt5();
    init_thumbprint();
    init_embedded();
    init_local();
    init_remote();
    init_unsecured();
    init_export();
    init_import();
    init_decode_protected_header();
    init_decode_jwt();
    init_errors();
    init_generate_key_pair();
    init_generate_secret();
    init_base64url2();
    init_runtime2();
  }
});

// src/ui.js
var UI_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Bridge</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
:root{--bg:#0d1117;--fg:#c9d1d9;--dim:#8b949e;--card:#161b22;--line:#30363d;
--green:#3fb950;--red:#f85149;--amber:#d29922;--blue:#58a6ff;--purple:#bc8cff}
*{box-sizing:border-box;margin:0}body{background:var(--bg);color:var(--fg);
font:14px/1.5 -apple-system,'Segoe UI',Roboto,sans-serif;padding:16px;max-width:1100px;margin:0 auto}
header{display:flex;align-items:baseline;gap:12px;margin-bottom:14px}
h1{font-size:17px}.dot{width:8px;height:8px;border-radius:50%;background:var(--green);
display:inline-block;margin-right:5px}.dot.down{background:var(--red)}
#live{font-size:12px;color:var(--dim)}
h2{font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:var(--dim);margin:18px 0 6px}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:20px}
@media(max-width:800px){.grid{grid-template-columns:1fr}}
.card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:9px 12px;margin-bottom:8px}
.card .t{font-weight:600}.card .r{color:var(--dim);font-size:12px;margin-top:2px;white-space:pre-wrap}
.muted{color:var(--dim);font-size:12px}
.badge{font-size:10px;padding:0 6px;border-radius:4px;border:1px solid var(--line);margin-left:6px}
.badge.needs_input{color:var(--amber);border-color:var(--amber)}
.badge.diagnostic{color:var(--red);border-color:var(--red)}
.pres{display:flex;gap:10px;flex-wrap:wrap}
.chip{display:flex;gap:6px;align-items:center;background:var(--card);border:1px solid var(--line);
border-radius:20px;padding:3px 12px;font-size:12px}
.chip .st{width:7px;height:7px;border-radius:50%}
.chip.active .st{background:var(--green)}.chip.idle .st{background:var(--dim)}
.chip .k{color:var(--dim)}
.ev{display:flex;gap:10px;padding:3px 8px;border-radius:5px;font-size:13px}
.ev:hover{background:var(--card)}
.ev .k{width:100px;flex:none;font-size:11px}
.ev .a{margin-left:auto;color:var(--dim);font-size:11px;flex:none}
.k.created,.k.claimed,.k.spawned{color:var(--blue)}
.k.completed,.k.unblocked{color:var(--green)}
.k.blocked,.k.changes_requested{color:var(--amber)}
.k.crashed,.k.gave_up,.k.timed_out{color:var(--red)}
.k.commented,.k.attached,.k.status,.k.archived{color:var(--dim)}
footer{color:var(--dim);font-size:11px;margin-top:24px}
</style></head><body>
<header><span id="live"><span class="dot"></span>LIVE</span><h1>bridge</h1>
<span style="margin-left:auto" class="muted" id="clock"></span></header>
<h2>Decisions needed</h2><div id="decisions"></div>
<div class="grid">
<div><h2>Who is active</h2><div class="pres" id="presence"></div></div>
<div><h2>Activity</h2><div id="feed"></div></div>
</div>
<footer>bridge \xB7 one door for agent + human work</footer>
<script>
function esc(s){const d=document.createElement('div');d.textContent=s==null?'':String(s);return d.innerHTML}
function ago(ts){const s=(Date.now()-ts)/1000;if(s<90)return Math.floor(s)+'s';if(s<7200)return Math.floor(s/60)+'m';
if(s<172800)return (s/3600).toFixed(1)+'h';return (s/86400).toFixed(1)+'d'}
let lastDecisions=[],lastPresence=[],lastEvents=[];
function renderDecisions(ds){lastDecisions=ds;const el=document.getElementById('decisions');
if(!ds.length){el.innerHTML='<div class="muted">nothing waiting on a human \u2713</div>';return}
el.innerHTML=ds.map(d=>'<div class="card"><div class="t">'+esc(d.title)+
'<span class="badge '+esc(d.kind||'diagnostic')+'">'+esc(d.kind||'diagnostic')+'</span></div>'+
(d.reason?'<div class="r">'+esc(d.reason)+'</div>':'')+
'<div class="muted">opened '+ago(d.opened_ts)+' ago \xB7 '+esc(d.board||d.task_id||'')+'</div></div>').join('')}
function renderPresence(ps){lastPresence=ps;const el=document.getElementById('presence');
if(!ps.length){el.innerHTML='<div class="muted">no signals yet</div>';return}
el.innerHTML=ps.map(a=>'<div class="chip '+(a.active?'active':'idle')+'"><span class="st"></span>'+
esc(a.label||a.id)+'<span class="k">'+esc(a.kind)+' \xB7 '+ago(a.last_ts)+'</span></div>').join('')}
function renderFeed(evs){const el=document.getElementById('feed');
el.innerHTML=evs.slice(0,200).map(e=>'<div class="ev"><span class="k '+esc(e.kind)+'">'+esc(e.kind)+'</span>'+
'<span>'+esc(e.title||e.task_id||'')+'</span>'+
(e.actor?'<span class="muted">'+esc(e.actor)+'</span>':'')+
'<span class="a">'+ago(e.ts)+'</span></div>').join('')}
function apply(state){renderDecisions(state.decisions);renderPresence(state.presence);renderFeed(lastEvents=state.events)}
setInterval(()=>{document.getElementById('clock').textContent=
new Date().toLocaleTimeString('en-AU',{timeZone:'Australia/Brisbane'})+' AEST'},1000);
const wsProto=location.protocol==='https:'?'wss':'ws';
let retry=0;
function connect(){const ws=new WebSocket(wsProto+'://'+location.host+'/ws');
ws.onmessage=m=>{const msg=JSON.parse(m.data);
if(msg.type==='snapshot')apply(msg.state);
else if(msg.type==='event')renderFeed(lastEvents=[msg.event,...lastEvents].slice(0,200));
else if(msg.type==='decisions')renderDecisions(msg.decisions);
else if(msg.type==='presence')renderPresence(msg.presence);
document.querySelector('#live .dot').classList.remove('down');
document.querySelector('#live').lastChild.textContent='LIVE'};
ws.onopen=()=>{retry=0};
ws.onclose=async(e)=>{if(e.code===4001){document.getElementById('live').innerHTML='SESSION EXPIRED \u2014 <a href="/login">login</a>';return}
document.querySelector('#live .dot').classList.add('down');
document.querySelector('#live').lastChild.textContent='RECONNECTING';
setTimeout(connect,Math.min(15000,1000*Math.pow(2,retry++)))}}
connect();
<\/script></body></html>`;

// src/do.js
var MAX_EVENTS = 5e3;
var HEARTBEAT_WINDOW_MS = 6e4;
var FlowsHub = class {
  static {
    __name(this, "FlowsHub");
  }
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.connections = /* @__PURE__ */ new Set();
  }
  async ensureSchema() {
    this.state.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        ts INTEGER NOT NULL,
        board TEXT, source TEXT, kind TEXT NOT NULL,
        actor TEXT, task_id TEXT, title TEXT,
        decision INTEGER NOT NULL DEFAULT 0,
        payload TEXT
      );
      CREATE TABLE IF NOT EXISTS actors (
        id TEXT PRIMARY KEY,           -- e.g. "agent:coder", "human:ray"
        kind TEXT NOT NULL,            -- agent | human | system
        label TEXT, last_ts INTEGER, status TEXT
      );
      CREATE TABLE IF NOT EXISTS decisions (
        id TEXT PRIMARY KEY,           -- stable per decision (task + seq)
        opened_ts INTEGER, updated_ts INTEGER,
        status TEXT NOT NULL DEFAULT 'open',   -- open | resolved
        title TEXT, reason TEXT, kind TEXT,    -- needs_input | diagnostic
        task_id TEXT, board TEXT, resolved_ts INTEGER
      );
    `);
    for (const ddl of [
      `ALTER TABLE decisions ADD COLUMN options TEXT`,
      `ALTER TABLE decisions ADD COLUMN urgency TEXT`,
      `ALTER TABLE decisions ADD COLUMN deadline_ts INTEGER`,
      `ALTER TABLE decisions ADD COLUMN asker TEXT`
    ]) {
      try {
        this.state.storage.sql.exec(ddl);
      } catch {
      }
    }
  }
  async fetch(request) {
    const url = new URL(request.url);
    await this.ensureSchema();
    if (url.pathname === "/ingest") return this.handleIngest(request);
    if (url.pathname === "/state") return this.handleState();
    if (url.pathname === "/ui") return new Response(UI_HTML, {
      headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }
    });
    if (url.pathname === "/ws") return this.handleWs(request);
    return new Response("hub: not found", { status: 404 });
  }
  // ---- ingest ----
  async handleIngest(request) {
    const body = await request.json();
    const events = Array.isArray(body.events) ? body.events : [body];
    const inserted = [], wsPairs = [];
    const now = Date.now();
    for (const e of events) {
      const ev = normalize(e, now);
      if (!ev) continue;
      try {
        this.state.storage.sql.exec(
          `INSERT INTO events (id, ts, board, source, kind, actor, task_id, title, decision, payload)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ev.id,
          ev.ts,
          ev.board,
          ev.source,
          ev.kind,
          ev.actor,
          ev.task_id,
          ev.title,
          ev.decision ? 1 : 0,
          JSON.stringify(ev.payload ?? {})
        );
      } catch {
        continue;
      }
      inserted.push(ev);
      this.touchActor(ev);
      if (ev.kind === "blocked") this.openDecision(ev);
      if (ev.kind === "unblocked" || ev.kind === "completed") this.closeDecisions(ev);
      if (ev.kind === "heartbeat") this.collapseHeartbeat(ev);
    }
    this.trimEvents();
    for (const ev of inserted) wsPairs.push([JSON.stringify({ type: "event", event: ev }), null]);
    wsPairs.push([JSON.stringify({ type: "decisions", decisions: this.listDecisions() }), null]);
    wsPairs.push([JSON.stringify({ type: "presence", presence: this.listPresence() }), null]);
    for (const ws of this.listWebSockets()) {
      for (const [msg] of wsPairs) {
        try {
          ws.send(msg);
        } catch {
        }
      }
    }
    return Response.json({ ok: true, accepted: inserted.length });
  }
  touchActor(ev) {
    if (!ev.actor) return;
    this.state.storage.sql.exec(
      `INSERT INTO actors (id, kind, label, last_ts, status) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET last_ts=excluded.last_ts, status=excluded.status`,
      ev.actor,
      ev.actor_kind || classifyActor(ev.actor),
      ev.actor_label || ev.actor,
      ev.ts,
      ev.kind === "heartbeat" ? "working" : "active"
    );
  }
  collapseHeartbeat(ev) {
    this.state.storage.sql.exec(
      `DELETE FROM events WHERE kind='heartbeat' AND task_id=? AND ts < ?`,
      ev.task_id ?? "",
      ev.ts - HEARTBEAT_WINDOW_MS
    );
  }
  openDecision(ev) {
    const id = `dec:${ev.board ?? ev.source}:${ev.task_id ?? ev.id}`;
    const kind = ev.payload?.kind || "diagnostic";
    const options = normalizeOptions(ev.payload?.options);
    const urgency = ev.payload?.urgency === "time-sensitive" ? "time-sensitive" : "normal";
    const deadline = Number.isFinite(ev.payload?.deadline_ts) ? ev.payload.deadline_ts : null;
    this.state.storage.sql.exec(
      `INSERT INTO decisions (id, opened_ts, updated_ts, status, title, reason, kind, task_id, board, options, urgency, deadline_ts, asker)
       VALUES (?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET updated_ts=excluded.updated_ts, reason=excluded.reason,
         options=excluded.options, urgency=excluded.urgency, deadline_ts=excluded.deadline_ts`,
      id,
      ev.ts,
      ev.ts,
      ev.title || "Untitled task",
      ev.payload?.reason || "",
      kind,
      ev.task_id,
      ev.board,
      options ? JSON.stringify(options) : null,
      urgency,
      deadline,
      ev.actor
    );
  }
  closeDecisions(ev) {
    this.state.storage.sql.exec(
      `UPDATE decisions SET status='resolved', resolved_ts=?, updated_ts=?
       WHERE status='open' AND task_id=?`,
      ev.ts,
      ev.ts,
      ev.task_id ?? ""
    );
  }
  listDecisions() {
    return this.state.storage.sql.exec(
      `SELECT * FROM decisions WHERE status='open' ORDER BY opened_ts DESC LIMIT 100`
    ).toArray().map((d) => ({
      ...d,
      options: typeof d.options === "string" ? safeParse(d.options) : d.options ?? null
    }));
  }
  listPresence() {
    const cutoff = Date.now() - 10 * 6e4;
    return this.state.storage.sql.exec(
      `SELECT id, kind, label, last_ts, status FROM actors
       ORDER BY last_ts DESC LIMIT 200`
    ).toArray().map((a) => ({ ...a, active: a.last_ts >= cutoff }));
  }
  trimEvents() {
    this.state.storage.sql.exec(
      `DELETE FROM events WHERE id NOT IN
       (SELECT id FROM events ORDER BY ts DESC, id DESC LIMIT ?)`,
      MAX_EVENTS
    );
  }
  // ---- reads ----
  async handleState() {
    const events = this.state.storage.sql.exec(
      `SELECT * FROM events ORDER BY ts DESC, id DESC LIMIT 200`
    ).toArray().map((e) => ({ ...e, payload: safeParse(e.payload), decision: !!e.decision }));
    return Response.json({
      events,
      decisions: this.listDecisions(),
      presence: this.listPresence(),
      now: Date.now()
    });
  }
  // ---- websockets (hibernating) ----
  async handleWs(request) {
    const pair = new WebSocketPair();
    this.state.acceptWebSocket(pair[1]);
    const st = await this.handleState();
    const text2 = await st.text();
    pair[1].send(JSON.stringify({ type: "snapshot", state: JSON.parse(text2) }));
    return new Response(null, { status: 101, webSocket: pair[0] });
  }
  listWebSockets() {
    return this.state.getWebSockets();
  }
};
function normalize(e, now) {
  if (!e || typeof e !== "object") return null;
  const kind = String(e.kind || "").slice(0, 40);
  if (!kind) return null;
  const source = String(e.source || e.board || "kanban").slice(0, 40);
  const id = String(e.id || `${source}:${now}:${Math.random().toString(36).slice(2, 8)}`).slice(0, 200);
  return {
    id,
    kind,
    source,
    board: e.board ? String(e.board).slice(0, 60) : null,
    ts: Number.isFinite(e.ts) ? e.ts : now,
    actor: e.actor ? String(e.actor).slice(0, 80) : null,
    actor_kind: e.actor_kind ? String(e.actor_kind).slice(0, 10) : void 0,
    actor_label: e.actor_label ? String(e.actor_label).slice(0, 80) : void 0,
    task_id: e.task_id ? String(e.task_id).slice(0, 100) : null,
    title: e.title ? String(e.title).slice(0, 300) : null,
    decision: kind === "blocked" || e.decision === true,
    payload: e.payload && typeof e.payload === "object" ? e.payload : {}
  };
}
__name(normalize, "normalize");
function classifyActor(actor) {
  if (actor.startsWith("human:")) return "human";
  if (actor.startsWith("agent:")) return "agent";
  return "system";
}
__name(classifyActor, "classifyActor");
function safeParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}
__name(safeParse, "safeParse");
function normalizeOptions(raw) {
  if (!Array.isArray(raw)) return null;
  const out = raw.slice(0, 6).filter((o) => o && typeof o === "object" && o.id && o.label).map((o) => ({
    id: String(o.id).slice(0, 40),
    label: String(o.label).slice(0, 80),
    hint: o.hint ? String(o.hint).slice(0, 120) : null
  }));
  return out.length ? out : null;
}
__name(normalizeOptions, "normalizeOptions");

// src/index.js
init_mcp();
init_core();
var index_default = {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/ingest") {
      return handleIngest(request, env);
    }
    if (url.pathname === "/api/kb-machine/rename") {
      const body = await request.json().catch(() => ({}));
      const { resolveTokenWs: resolveTokenWs2 } = await Promise.resolve().then(() => (init_mcp(), mcp_exports));
      const bearer = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
      if (!bearer) return new Response("unauthorized", { status: 401 });
      let ws;
      try {
        ws = await resolveTokenWs2(env, bearer);
      } catch {
        return new Response("unauthorized", { status: 401 });
      }
      return env.KB.get(env.KB.idFromName(doWs(ws))).fetch("https://kb/token.rename", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ bearer, label: body.label })
      });
    }
    if (url.pathname === "/api/kb-machine/revoke") {
      const { resolveTokenWs: resolveTokenWs2 } = await Promise.resolve().then(() => (init_mcp(), mcp_exports));
      const bearer = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
      if (!bearer) return new Response("unauthorized", { status: 401 });
      let ws;
      try {
        ws = await resolveTokenWs2(env, bearer);
      } catch {
        return new Response("ok");
      }
      return env.KB.get(env.KB.idFromName(doWs(ws))).fetch("https://kb/token.self_revoke", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ bearer })
      });
    }
    if (url.pathname === "/api/kb-machine/stats") {
      const { resolveTokenWs: resolveTokenWs2 } = await Promise.resolve().then(() => (init_mcp(), mcp_exports));
      const bearer = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
      if (!bearer) return new Response("unauthorized", { status: 401 });
      let ws;
      try {
        ws = await resolveTokenWs2(env, bearer);
      } catch {
        return new Response("unauthorized", { status: 401 });
      }
      return env.KB.get(env.KB.idFromName(doWs(ws))).fetch("https://kb/stats");
    }
    if (url.pathname === "/__version") {
      try {
        const v = await Promise.resolve().then(() => __toESM(require_version(), 1));
        return json2(v);
      } catch {
        return json2({ commit: "unknown", built_at: null });
      }
    }
    if (url.pathname === "/api/kb-machine/list") {
      const { resolveTokenWs: resolveTokenWs2 } = await Promise.resolve().then(() => (init_mcp(), mcp_exports));
      const bearer = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
      if (!bearer) return new Response("unauthorized", { status: 401 });
      let ws;
      try {
        ws = await resolveTokenWs2(env, bearer);
      } catch {
        return new Response("unauthorized", { status: 401 });
      }
      return env.KB.get(env.KB.idFromName(doWs(ws))).fetch("https://kb/artefacts" + new URL(request.url).search, { method: "GET" });
    }
    if (url.pathname === "/api/kb-machine/act") {
      const { resolveTokenWs: resolveTokenWs2 } = await Promise.resolve().then(() => (init_mcp(), mcp_exports));
      const bearer = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
      if (!bearer) return new Response("unauthorized", { status: 401 });
      let ws;
      try {
        ws = await resolveTokenWs2(env, bearer);
      } catch {
        return new Response("unauthorized", { status: 401 });
      }
      const body = await request.json().catch(() => ({}));
      if (body.op !== "transition" || body.type !== void 0)
        return json2({ error: "only decision transitions allowed via kb-machine/act" }, 403);
      return env.KB.get(env.KB.idFromName(doWs(ws))).fetch("https://kb/transition", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...body, actor: "web:desktop" })
      });
    }
    if (url.pathname === "/api/kb-machine/search") {
      const { resolveTokenWs: resolveTokenWs2 } = await Promise.resolve().then(() => (init_mcp(), mcp_exports));
      const bearer = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
      if (!bearer) return new Response("unauthorized", { status: 401 });
      let ws;
      try {
        ws = await resolveTokenWs2(env, bearer);
      } catch {
        return new Response("unauthorized", { status: 401 });
      }
      return env.KB.get(env.KB.idFromName(doWs(ws))).fetch("https://kb/search" + new URL(request.url).search, { method: "GET" });
    }
    if (url.pathname === "/api/kb-machine/provision") {
      const { resolveTokenWs: resolveTokenWs2 } = await Promise.resolve().then(() => (init_mcp(), mcp_exports));
      const bearer = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
      if (!bearer) return new Response("unauthorized", { status: 401 });
      let ws;
      try {
        ws = await resolveTokenWs2(env, bearer);
      } catch {
        return new Response("unauthorized", { status: 401 });
      }
      const body = await request.json().catch(() => ({}));
      const kbId = env.KB.get(env.KB.idFromName(doWs(ws)));
      const ident = await kbId.fetch("https://kb/auth.identify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ bearer })
      }).then((r) => r.json()).catch(() => null);
      if (!ident?.label) return new Response("unauthorized", { status: 401 });
      const identTags = Array.isArray(ident.tags) ? ident.tags.map((t) => String(t).toLowerCase()) : [];
      if (!identTags.includes("gateway")) return json2({ error: "agent provisioning requires a gateway-class token (gateway tag) \u2014 this token is not a gateway" }, 403);
      return kbId.fetch("https://kb/agent.provision", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ label: body.label, rotate: !!body.rotate, provisioned_by: ident.label })
      });
    }
    if (url.pathname === "/mcp") {
      return handleMcp(request, env);
    }
    if (url.pathname === "/kb-ws") {
      if (request.method === "OPTIONS") return kbPreflight();
      const auth2 = await authKb(request, env);
      if (auth2 instanceof Response) return kbCors(auth2);
      return env.KB.get(env.KB.idFromName(doWs(auth2.ws))).fetch("https://kb/ws", request);
    }
    if (url.pathname === "/api/kb/self-provision" && request.method === "POST") {
      const bearer = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "") || new URL(request.url).searchParams.get("token") || "";
      if (bearer) return json2({ error: "self-provision is human-plane only \u2014 a gateway bearer cannot mint tokens; sign in as the human" }, 403);
      const auth2 = await checkAuth(request, env);
      if (auth2 instanceof Response) return auth2;
      const body = await request.json().catch(() => ({}));
      body.actor = `web:${auth2.login ?? "anon"}`;
      const kbId = env.KB.idFromName(doWs(auth2.ws));
      return env.KB.get(kbId).fetch("https://kb/self.provision", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          // principal = the device credential (hub-vended on first provision);
          // host = display label source (BR#899 identity convention)
          principal: typeof body.principal === "string" ? body.principal : "",
          host: String(body.host ?? ""),
          // worker-derived identity: the session's login + workspace — the
          // client cannot claim an actor or scope (same law as body.actor)
          login: auth2.login ?? "",
          ws: auth2.ws
        })
      });
    }
    if (url.pathname.startsWith("/api/kb/") && !url.pathname.startsWith("/api/kb/admin/")) {
      if (request.method === "OPTIONS") return kbPreflight();
      const auth2 = await authKb(request, env);
      if (auth2 instanceof Response) return kbCors(auth2);
      const kbId = env.KB.idFromName(doWs(auth2.ws));
      const sub = url.pathname.slice("/api/kb/".length);
      if (request.method === "GET") {
        const kbUrl = sub === "board" ? "https://kb/board" : sub === "events" ? "https://kb/events" : sub === "artefacts" ? "https://kb/artefacts" : sub === "artefact" ? "https://kb/artefact" : sub === "search" ? "https://kb/search" : sub === "stats" ? "https://kb/stats" : sub === "related" ? "https://kb/related" : sub === "history" ? "https://kb/history" : sub === "ask" ? "https://kb/ask" : sub === "metrics/throughput" ? "https://kb/metrics.throughput" : sub === "provenance" ? "https://kb/provenance" : sub === "bootstrap" ? "https://kb/bootstrap" : null;
        if (!kbUrl) return kbCors(new Response("not found", { status: 404 }));
        return kbCors(await env.KB.get(kbId).fetch(kbUrl + url.search, request));
      }
      if (request.method === "POST") {
        if (sub === "ask_reframe" && request.method === "POST") {
          const body2 = await request.json().catch(() => ({}));
          body2.actor = auth2.bearer ? "gateway" : `web:${auth2.login ?? "anon"}`;
          return kbCors(env.KB.get(kbId).fetch("https://kb/ask.reframe", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body2)
          }));
        }
        if (sub === "purge_smoke" && request.method === "POST") {
          const body2 = await request.json().catch(() => ({}));
          body2.actor = auth2.bearer ? "gateway" : `web:${auth2.login ?? "anon"}`;
          return kbCors(env.KB.get(kbId).fetch("https://kb/purge_smoke", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body2)
          }));
        }
        const op = ["create", "update", "transition", "link", "progress", "enrich", "boost", "ask_answer"].includes(sub) ? sub : null;
        if (!op) return kbCors(new Response("not found", { status: 404 }));
        const body = await request.json().catch(() => ({}));
        body.actor = auth2.bearer ? "gateway" : `web:${auth2.login ?? "anon"}`;
        return kbCors(await env.KB.get(kbId).fetch(`https://kb/${op.replace(/_/g, ".")}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body)
        }));
      }
    }
    if (url.pathname === "/kb") {
      if (request.headers.get("Accept")?.includes("text/html")) {
        return new Response(ADMIN_HTML, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
      }
      return new Response("use the /kb page", { status: 404 });
    }
    if (url.pathname.startsWith("/api/kb/admin/")) {
      const auth2 = await checkAuth(request, env);
      if (auth2 instanceof Response) return auth2;
      const op = url.pathname.slice("/api/kb/admin/".length);
      const kbId = env.KB.idFromName(doWs(auth2.ws));
      const kbHub = env.KB.get(kbId);
      const kbUrl = op === "tokens" && request.method === "GET" ? "https://kb/admin.list_tokens" : op === "tokens" ? "https://kb/admin.mint" : op === "tokens/revoke" ? "https://kb/admin.revoke" : op === "tokens/tags" ? "https://kb/admin.token_tags" : op === "settings" && request.method === "GET" ? "https://kb/admin.settings_get" : op === "settings" ? "https://kb/admin.settings_set" : null;
      if (!kbUrl) return new Response("not found", { status: 404 });
      const body = await request.json().catch(() => ({}));
      if (op === "tokens") body.ws = auth2.ws;
      return kbHub.fetch(kbUrl, {
        method: request.method === "GET" ? "POST" : "POST",
        headers: { "content-type": "application/json", "x-kb-admin": "1" },
        body: JSON.stringify(body)
      });
    }
    if (url.pathname === "/login") return handleGithubLogin(request, env);
    if (url.pathname === "/login/callback") return handleGithubCallback(request, env);
    if (url.pathname.startsWith("/api/pair/")) {
      const body = await request.json().catch(() => ({}));
      try {
        if (url.pathname === "/api/pair/start" && request.method === "POST") {
          return json2(await wsCall(env, "ws.pair.start", {
            device: String(body.device ?? "device"),
            type: body.type === "agent" ? "agent" : "gateway"
          }));
        }
        if (url.pathname === "/api/pair/poll" && request.method === "POST") {
          return json2(await wsCall(env, "ws.pair.poll", { code: String(body.code ?? "") }));
        }
        if (url.pathname === "/api/pair/get" && request.method === "POST") {
          const auth2 = await checkAuth(request, env);
          if (auth2 instanceof Response) return auth2;
          return json2(await wsCall(env, "ws.pair.get", { code: String(body.code ?? "") }));
        }
        if (url.pathname === "/api/pair/approve" && request.method === "POST") {
          const auth2 = await checkAuth(request, env);
          if (auth2 instanceof Response) return auth2;
          const out = await wsCall(env, "ws.pair.approve", {
            code: String(body.code ?? ""),
            ws: String(body.ws ?? ""),
            label: String(body.label ?? ""),
            tags: Array.isArray(body.tags) ? body.tags.slice(0, 10).map(String) : [],
            login: auth2.login ? auth2.login.toLowerCase() : ""
          });
          return json2(out);
        }
        return new Response("not found", { status: 404 });
      } catch (e) {
        return json2({ error: String(e.message ?? e) }, 400);
      }
    }
    const auth = await checkAuth(request, env);
    if (auth instanceof Response) return auth;
    if (url.pathname === "/logout") {
      const loc = env.CF_ACCESS_TEAM && env.CF_ACCESS_AUD ? `${env.CF_ACCESS_TEAM}/cdn-cgi/access/logout` : "/";
      return new Response(null, {
        status: 302,
        headers: {
          "Set-Cookie": `${SESSION_COOKIE}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax`,
          "Location": loc
        }
      });
    }
    if (url.pathname === "/api/session") return handleSession(request, env);
    if (url.pathname === "/api/workspaces" || url.pathname === "/api/workspaces/switch") {
      const l = auth.login.toLowerCase();
      if (request.method === "GET") {
        const home = await wsHome(env, l);
        const { workspaces: workspaces2 } = await wsCall(env, "ws.list", { login: l });
        return json2({ workspaces: workspaces2, current: auth.ws, home });
      }
      if (request.method !== "POST") return json2({ error: "GET or POST only" }, 405);
      const body = await request.json().catch(() => ({}));
      if (url.pathname === "/api/workspaces") {
        const out = await wsCall(env, "ws.create", { slug: String(body.slug ?? "").trim().toLowerCase(), login: l });
        return json2(out);
      }
      const ws = String(body.ws ?? "").trim().toLowerCase();
      const { workspaces } = await wsCall(env, "ws.list", { login: l });
      if (!workspaces.some((w) => w.slug === ws && w.member)) {
        return json2({ error: `not a member of workspace '${ws}'` }, 403);
      }
      const exp = String(Date.now() + SESSION_TTL_MS);
      const sig = await sign2(`${exp}.${auth.login}.${ws}`, env.GITHUB_CLIENT_SECRET);
      return new Response(null, {
        status: 204,
        headers: {
          "Set-Cookie": `${SESSION_COOKIE}=${exp}.${auth.login}.${ws}.${sig}; Max-Age=${SESSION_TTL_MS / 1e3}; Path=/; HttpOnly; Secure; SameSite=Lax`,
          "Cache-Control": "no-store"
        }
      });
    }
    const hub = env.HUB.get(env.HUB.idFromName(doWs(auth.ws)));
    if (url.pathname === "/ws") return hub.fetch("https://hub/ws", request);
    if (url.pathname === "/api/state") return hub.fetch("https://hub/state", request);
    if (url.pathname === "/") return hub.fetch("https://hub/ui", request);
    return new Response("not found", { status: 404 });
  }
};
async function handleIngest(request, env) {
  if (request.method !== "POST") return json2({ error: "POST only" }, 405);
  const token = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token || token !== (env.BRIDGE_INGEST_TOKEN ?? env.FLOWS_INGEST_TOKEN)) return json2({ error: "unauthorized" }, 401);
  let body;
  try {
    body = await request.json();
  } catch {
    return json2({ error: "bad json" }, 400);
  }
  const events = Array.isArray(body.events) ? body.events : [body];
  if (events.length > 1e3) return json2({ error: "batch too large" }, 413);
  const id = env.HUB.idFromName(doWs(DEFAULT_WS_SLUG));
  const hub = env.HUB.get(id);
  return hub.fetch("https://hub/ingest", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ events })
  });
}
__name(handleIngest, "handleIngest");
var LEGACY_WS_MEMBERS = ["rayh"];
function wsRegistry(env) {
  return env.KB.get(env.KB.idFromName(doWs(DEFAULT_WS_SLUG)));
}
__name(wsRegistry, "wsRegistry");
async function wsCall(env, op, body) {
  const r = await wsRegistry(env).fetch(`https://kb/${op}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const out = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(out.error ?? `ws ${op} failed`);
  return out;
}
__name(wsCall, "wsCall");
async function wsHome(env, login) {
  const l = login.toLowerCase();
  await wsCall(env, "ws.seed", { logins: LEGACY_WS_MEMBERS }).catch(() => {
  });
  const { workspaces } = await wsCall(env, "ws.list", { login: l });
  const mine = workspaces.filter((w) => w.member);
  const hasDefault = mine.some((w) => w.slug === DEFAULT_WS_SLUG);
  if (!mine.some((w) => w.slug === l)) {
    await wsCall(env, "ws.create", { slug: l, login: l }).catch(() => {
    });
  }
  return hasDefault ? DEFAULT_WS_SLUG : l;
}
__name(wsHome, "wsHome");
var SESSION_COOKIE = "bridge_session";
var OAUTH_COOKIE = "bridge_oauth";
var SESSION_TTL_MS = 30 * 24 * 3600 * 1e3;
function githubConfigured(env) {
  return !!(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET);
}
__name(githubConfigured, "githubConfigured");
async function authKb(request, env) {
  const session = await checkAuth(request, env);
  if (!(session instanceof Response)) return session;
  const bearer = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "") || new URL(request.url).searchParams.get("token") || "";
  if (!bearer) return session;
  const { resolveTokenWs: resolveTokenWs2 } = await Promise.resolve().then(() => (init_mcp(), mcp_exports));
  let ws;
  try {
    ws = await resolveTokenWs2(env, bearer);
  } catch {
    return session;
  }
  if (!ws) return session;
  return { login: null, ws, bearer: true };
}
__name(authKb, "authKb");
function kbCors(r) {
  if (!r || !r.headers) return r;
  const h = new Headers(r.headers);
  h.set("Access-Control-Allow-Origin", "*");
  h.set("Access-Control-Allow-Headers", "authorization, content-type");
  h.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  return new Response(r.body, { status: r.status, statusText: r.statusText, headers: h, webSocket: r.webSocket });
}
__name(kbCors, "kbCors");
function kbPreflight() {
  return kbCors(new Response(null, { status: 204 }));
}
__name(kbPreflight, "kbPreflight");
async function checkAuth(request, env) {
  if (env.CF_ACCESS_TEAM && env.CF_ACCESS_AUD) {
    const a = await requireAccess(request, env);
    if (a !== true) return a;
    return { login: null, ws: DEFAULT_WS_SLUG };
  }
  if (!githubConfigured(env)) {
    if (!env.BRIDGE_UI_PASSWORD) {
      return json2({ error: "auth not configured: set GITHUB_CLIENT_ID + GITHUB_CLIENT_SECRET (or legacy BRIDGE_UI_PASSWORD)" }, 503);
    }
    const legacy = parseLegacyPasswordCookie(request, env);
    return legacy ? { login: null, ws: DEFAULT_WS_SLUG, legacy: true } : loginResponse(request);
  }
  const cookie = request.headers.get("Cookie") || "";
  const m = cookie.match(new RegExp(`${SESSION_COOKIE}=([^;\\s]+)`));
  const session = m && await verifySession(m[1], env.GITHUB_CLIENT_SECRET);
  if (!session) return loginResponse(request);
  return session;
}
__name(checkAuth, "checkAuth");
function parseLegacyPasswordCookie(request, env) {
  const m = (request.headers.get("Cookie") || "").match(new RegExp(`${SESSION_COOKIE}=([^;\\s]+)`));
  if (!m) return false;
  const dot = m[1].indexOf(".");
  if (dot <= 0 || m[1].includes(".", dot + 1)) return false;
  const exp = m[1].slice(0, dot);
  if (!/^\d+$/.test(exp) || Number(exp) < Date.now()) return false;
  return sign2(exp, env.BRIDGE_UI_PASSWORD).then((expected) => expected === m[1].slice(dot + 1));
}
__name(parseLegacyPasswordCookie, "parseLegacyPasswordCookie");
async function handleSession(request, env) {
  if (env.CF_ACCESS_TEAM && env.CF_ACCESS_AUD) {
    const jwt = request.headers.get("Cf-Access-Jwt-Assertion");
    try {
      const { jwtVerify: jwtVerify2, createRemoteJWKSet: createRemoteJWKSet2 } = await Promise.resolve().then(() => (init_browser(), browser_exports));
      const { payload } = await jwtVerify2(
        jwt ?? "",
        createRemoteJWKSet2(new URL(`${env.CF_ACCESS_TEAM}/cdn-cgi/access/certs`)),
        { issuer: env.CF_ACCESS_TEAM, audience: env.CF_ACCESS_AUD }
      );
      return json2({ mode: "access", user: payload.email ?? null });
    } catch {
      return json2({ mode: "access", user: null });
    }
  }
  if (!githubConfigured(env)) {
    const legacy = await parseLegacyPasswordCookie(request, env);
    if (!legacy) return json2({ mode: "password", user: null, workspace: DEFAULT_WS_SLUG });
    const m2 = (request.headers.get("Cookie") || "").match(new RegExp(`${SESSION_COOKIE}=([^;\\s]+)`));
    return json2({ mode: "password", user: null, workspace: DEFAULT_WS_SLUG, expires_ts: Number(m2[1].slice(0, m2[1].indexOf("."))) });
  }
  const cookie = request.headers.get("Cookie") || "";
  const m = cookie.match(new RegExp(`${SESSION_COOKIE}=([^;\\s]+)`));
  const session = m && await verifySession(m[1], env.GITHUB_CLIENT_SECRET);
  if (!session) return json2({ mode: "github", user: null });
  const dot = m[1].indexOf(".");
  return json2({ mode: "github", user: session.login, workspace: session.ws, expires_ts: Number(m[1].slice(0, dot)) });
}
__name(handleSession, "handleSession");
function loginResponse(request) {
  const wantsHtml = (request.headers.get("Accept") || "").includes("text/html");
  if (wantsHtml) {
    return new Response(null, {
      status: 302,
      headers: { Location: "/login", "Cache-Control": "no-store" }
    });
  }
  return json2({ error: "unauthorized: sign in via GET /login (github oauth)" }, 401);
}
__name(loginResponse, "loginResponse");
function startGithubLogin(env, state) {
  const redirect = new URL("https://github.com/login/oauth/authorize");
  redirect.searchParams.set("client_id", env.GITHUB_CLIENT_ID);
  redirect.searchParams.set("state", state);
  redirect.searchParams.set("scope", "read:user");
  return new Response(null, {
    status: 302,
    headers: {
      Location: String(redirect),
      "Set-Cookie": `${OAUTH_COOKIE}=${state}; Max-Age=600; Path=/; HttpOnly; Secure; SameSite=Lax`,
      "Cache-Control": "no-store"
    }
  });
}
__name(startGithubLogin, "startGithubLogin");
function handleGithubLogin(request, env) {
  if (!githubConfigured(env)) {
    return json2({ error: "auth not configured: set GITHUB_CLIENT_ID + GITHUB_CLIENT_SECRET" }, 503);
  }
  const state = crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
  const url = new URL(request.url);
  if (url.searchParams.get("client") === "desktop") {
    const port = Number(url.searchParams.get("port"));
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return json2({ error: "desktop login requires ?port=<1-65535> (the app's loopback listener)" }, 400);
    }
    return startGithubLogin(env, `desktop-${port}-${state}`);
  }
  return startGithubLogin(env, state);
}
__name(handleGithubLogin, "handleGithubLogin");
function parseDesktopState(state) {
  const m = /^desktop-(\d{1,5})-[0-9a-f]{64}$/.exec(String(state ?? ""));
  if (!m) return null;
  const port = Number(m[1]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { port };
}
__name(parseDesktopState, "parseDesktopState");
function oauthFailure(origin, reason = "unknown") {
  const headers = new Headers({ Location: `${origin}/?login=failed&reason=${reason}`, "Cache-Control": "no-store" });
  headers.append("Set-Cookie", `${OAUTH_COOKIE}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax`);
  return new Response(null, { status: 302, headers });
}
__name(oauthFailure, "oauthFailure");
async function handleGithubCallback(request, env) {
  if (!githubConfigured(env)) return json2({ error: "auth not configured" }, 503);
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const m = (request.headers.get("Cookie") || "").match(new RegExp(`${OAUTH_COOKIE}=([^;\\s]+)`));
  if (!code || !state || !m || m[1] !== state) return oauthFailure(url.origin, "state");
  const tokRes = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ client_id: env.GITHUB_CLIENT_ID, client_secret: env.GITHUB_CLIENT_SECRET, code })
  });
  const tok = await tokRes.json().catch(() => ({}));
  if (!tok.access_token) {
    console.error("login: token exchange failed:", tokRes.status, JSON.stringify(tok).slice(0, 200));
    return oauthFailure(url.origin, "exchange");
  }
  const uRes = await fetch("https://api.github.com/user", {
    headers: {
      authorization: `Bearer ${tok.access_token}`,
      accept: "application/vnd.github+json",
      "user-agent": "bridge"
    }
  });
  const u = await uRes.json().catch(() => ({}));
  if (!u.login) return oauthFailure(url.origin, "github_user");
  const allowed = (env.GITHUB_ALLOWED_USERS ?? "").trim();
  if (!allowed) {
    console.error("login: refused \u2014 GITHUB_ALLOWED_USERS is not set (default deny)");
    return oauthFailure(url.origin, "not_allowed");
  }
  if (allowed !== "*") {
    const list = allowed.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
    if (!list.includes(u.login.toLowerCase())) {
      console.error(`login: refused \u2014 ${u.login} not in GITHUB_ALLOWED_USERS`);
      return oauthFailure(url.origin, "not_allowed");
    }
  }
  let ws;
  try {
    ws = await wsHome(env, u.login);
  } catch (e) {
    console.error("login: workspace resolution failed:", String(e));
    return oauthFailure(url.origin, "workspace");
  }
  const exp = String(Date.now() + SESSION_TTL_MS);
  const sig = await sign2(`${exp}.${u.login}.${ws}`, env.GITHUB_CLIENT_SECRET);
  const sessionValue = `${exp}.${u.login}.${ws}.${sig}`;
  const desktop = parseDesktopState(state);
  const headers = new Headers({
    Location: desktop ? `http://127.0.0.1:${desktop.port}/callback?bridge_session=${encodeURIComponent(sessionValue)}` : "/",
    "Cache-Control": "no-store"
  });
  headers.append(
    "Set-Cookie",
    `${SESSION_COOKIE}=${sessionValue}; Max-Age=${SESSION_TTL_MS / 1e3}; Path=/; HttpOnly; Secure; SameSite=Lax`
  );
  headers.append("Set-Cookie", `${OAUTH_COOKIE}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax`);
  return new Response(null, { status: 302, headers });
}
__name(handleGithubCallback, "handleGithubCallback");
function hex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
__name(hex, "hex");
async function sign2(payload, secret) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  return hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload)));
}
__name(sign2, "sign");
async function verifySession(value, secret) {
  const i1 = value.indexOf("."), i2 = value.lastIndexOf(".");
  if (i1 <= 0 || i2 <= i1) return null;
  const exp = value.slice(0, i1), mid = value.slice(i1 + 1, i2), sig = value.slice(i2 + 1);
  if (!/^\d+$/.test(exp) || Number(exp) < Date.now()) return null;
  const md = mid.lastIndexOf(".");
  let login, ws, signed;
  if (md > 0) {
    login = mid.slice(0, md);
    ws = mid.slice(md + 1);
    signed = `${exp}.${login}.${ws}`;
  } else {
    login = mid;
    ws = DEFAULT_WS_SLUG;
    signed = `${exp}.${login}`;
  }
  if (!/^[A-Za-z0-9-]{1,39}$/.test(login)) return null;
  if (!isWsSlug(ws)) return null;
  const expected = await sign2(signed, secret);
  if (expected.length !== sig.length) return null;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
  return diff === 0 ? { login, ws } : null;
}
__name(verifySession, "verifySession");
async function requireAccess(request, env) {
  const team = env.CF_ACCESS_TEAM, aud = env.CF_ACCESS_AUD;
  const jwt = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!jwt) return json2({ error: "no access jwt" }, 403);
  try {
    const { jwtVerify: jwtVerify2, createRemoteJWKSet: createRemoteJWKSet2 } = await Promise.resolve().then(() => (init_browser(), browser_exports));
    const jwks = createRemoteJWKSet2(new URL(`${team}/cdn-cgi/access/certs`));
    await jwtVerify2(jwt, jwks, { issuer: team, audience: aud });
    return true;
  } catch (e) {
    return json2({ error: "invalid access jwt", detail: String(e).slice(0, 120) }, 403);
  }
}
__name(requireAccess, "requireAccess");
function json2(obj, status = 200, extra = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...extra }
  });
}
__name(json2, "json");
export {
  FlowsHub,
  KnowledgeHub,
  index_default as default
};
//# sourceMappingURL=index.js.map
