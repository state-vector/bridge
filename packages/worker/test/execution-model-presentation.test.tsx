import { expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ExecutionModelViewSchema } from "@bridge/contracts";
import { ExecutionModel, ExecutionStatus } from "../../ui-kit/src/views/ExecutionModel.tsx";
import { TaskHistoryLine } from "../../ui-kit/src/views/TaskDetail.tsx";
import { TopView } from "../../ui-kit/src/views/TopView.tsx";
import { useKb } from "../../ui-kit/src/server/kbStore.ts";
import { readFileSync } from "node:fs";

// Zustand SSR normally reads its empty initial snapshot. Select the seeded
// live snapshot while rendering the actual Top component and its children.
vi.mock("../../ui-kit/src/server/kbStore.ts", async importOriginal => {
  const original = await importOriginal<typeof import("../../ui-kit/src/server/kbStore.ts")>();
  return { ...original, useKb: Object.assign(<T,>(select: (state: ReturnType<typeof original.useKb.getState>) => T) => select(original.useKb.getState()), original.useKb) };
});

const view = ExecutionModelViewSchema.parse({ minimum_tier: "large", current: { kind: "managed", tier: "medium", model: "provider/glm-5.3", backend: "opencode", host: "gateway", session: "working", generation: 1, lease_until: Date.now() + 60_000, phase: "stopping" } });
it("gives actual size its own Top column with matching header, parent and child cells", () => {
  const previous = useKb.getState();
  const task = { id: "BR#100", type: "task", title: "Cross-system repair", status: "in_progress", owner: "gateway/worker", created_ts: Date.now(), updated_ts: Date.now(), meta: { session: "working" }, execution: view };
  useKb.setState({ tasks: [task, { ...task, id: "BR#101", title: "Verify repair", part_of: task.id }], sessions: [], agents: [], events: [] });
  try {
    const html = renderToStaticMarkup(<TopView />);
    expect(html).toContain("gateway/worker");
    expect(html).toContain("medium =&gt; large");
    expect(html).toContain('aria-label="Execution state"');
    expect(html).toContain("provider/glm-5.3");
    expect(html).toContain('class="topc-model" title=');
    expect(html).toContain("model size");
    // Extract the real header and task rows, not a hand-built approximation.
    const header = /class="ktable-head top-head">([\s\S]*?)<\/div>/.exec(html)![1];
    const rows = [...html.matchAll(/class="ktable-row top-row[^\"]*"[^>]*>([\s\S]*?)<\/div>/g)];
    const columns = (markup: string) => [...markup.matchAll(/class="(topc-(?:task|agent|model|session|goal|status|score|gauge|bar|age))(?:\s[^\"]*)?"/g)].map(m => m[1]);
    expect(columns(header)).toHaveLength(13);
    const css = readFileSync(new URL("../../ui-kit/src/views/views.css", import.meta.url), "utf8");
    const templates = [...css.matchAll(/\.top-head, \.top-row \{ --cols: ([^;]+);/g)];
    const trackCount = (template: string) => template.match(/minmax\([^)]+\)|[^\s]+/g)!.length;
    expect(templates.map(([, template]) => trackCount(template))).toEqual([13, 9]);
    expect(columns(header).filter(column => !["topc-session", "topc-gauge"].includes(column))).toHaveLength(9);
    expect(rows).toHaveLength(2);
    for (const [, row] of rows) {
      expect(columns(row)).toEqual(columns(header));
      expect(row).toMatch(/class="topc-agent"[^>]*><span class="top-agent-name">gateway\/worker<\/span><\/span><span class="topc-model"><span class="execution-model"/);
      const modelCell = /class="topc-model">([\s\S]*?)<\/span><\/span><\/span>/.exec(row)![1];
      expect(modelCell).not.toMatch(/stopping|expired|last run|Execution state/);
      expect(row).toMatch(/class="topc-status">[\s\S]*?stopping/);
    }
  } finally { useKb.setState(previous); }
});
it("renders missing/expired receipts honestly instead of claiming large is running", () => {
  const unknown = renderToStaticMarkup(<ExecutionModel value={{ minimum_tier: "large", current: { kind: "unreported" } }} now={1} />);
  expect(unknown).toContain(">unknown<"); expect(unknown).not.toContain("=&gt;");
  const expired = ExecutionModelViewSchema.parse({ ...view, current: { ...view.current, phase: "running", lease_until: 10 } });
  const size = renderToStaticMarkup(<ExecutionModel value={expired} now={20} />);
  expect(size).toContain("medium =&gt; large"); expect(size).not.toContain("expired");
  expect(renderToStaticMarkup(<ExecutionStatus value={expired} now={20} />)).toContain("lease expired");
});
it("shows interactive sessions as custom without a gateway tier or upgrade comparison", () => {
  const interactive = ExecutionModelViewSchema.parse({ minimum_tier: "large", current: { kind: "interactive", session: "human-session", phase: "active" } });
  const html = renderToStaticMarkup(<ExecutionModel value={interactive} now={1} />);
  expect(html).toContain(">custom<"); expect(html).not.toContain("=&gt;"); expect(html).not.toContain(">large<");
  expect(renderToStaticMarkup(<ExecutionStatus value={interactive} now={1} />)).toContain(">interactive<");
});
it("renders structured escalation history with the complete reason, actor, and source", () => {
  const reason = "This needs a larger reasoning model. ".repeat(30);
  const html = renderToStaticMarkup(<TaskHistoryLine version={{ seq: 1, ts: Date.now(), actor: "reviewer", action: "execution", summary: "bounded ledger summary",
    data: { kind: "model_escalated", from_tier: "medium", to_tier: "large", reason, source: "review", review_id: "BR#101", generation: 1 } }} />);
  expect(html).toContain("escalation"); expect(html).toContain("medium → large"); expect(html).toContain("review BR#101");
  expect(html).toContain(reason.trim()); expect(html).toContain("reviewer"); expect(html).not.toContain("bounded ledger summary");
});
