import { useEffect, useMemo, useState } from "react";
import { kbApi, type KbGraphTask } from "@bridge/ui-kit";
import "./WorkGraph.css";

type Exit = KbGraphTask["work_waits"][number]["exit"];
type Node = { id: string; title: string; label: string; card?: KbGraphTask };
type Edge = { from: string; to: string; label: string };
const width = 248;
const height = 76;
const columnGap = 76;
const rowGap = 18;

function words(value: string) { return value.replaceAll("_", " "); }

function describe(exit: Exit): [string, string?] {
  switch (exit.event) {
    case "ask": case "ask_answered": return [`${exit.ask_id} answered`, exit.ask_id];
    case "br_answered": return [`${exit.id} answered`, exit.id];
    case "br_done": return [`${exit.id} completed`, exit.id];
    case "br_pr_merged": return [`${exit.id} PR merged`, exit.id];
    case "reviewed_wait_replacement": return [`Replacement wait reviewed by ${exit.duty_id}`, exit.duty_id];
    case "reviewed_execution_repair": return ["Execution repair reviewed", exit.duty_id];
    case "review_recorded": return ["Review recorded"];
    case "train_advanced": return [`Merge train advances from ${words(exit.phase)}`];
    case "pr_merged": return [`${exit.repo}#${exit.n} merged`];
    case "pr_checks_green": return [`${exit.repo}#${exit.n} checks green`];
    case "issue_closed": return [`${exit.repo}#${exit.n} closed`];
    case "time": return [`After ${new Date(exit.until_ts).toLocaleString()}`];
    case "lane_health": return [`${exit.repo}@${exit.base} healthy${exit.head ? ` at ${exit.head}` : ""}`];
    case "local_handoff": return [`Handoff ${exit.handoff_id} v${exit.version} accepted`];
    case "run_success": return [[exit.repo, exit.run_id && `run ${exit.run_id}`, exit.head && `at ${exit.head}`,
      exit.newer_than && `after ${exit.newer_than}`, "succeeds"].filter(Boolean).join(" ")];
    case "deployed": return [`${exit.commit} deployed`];
    case "startup_ready": return [`${exit.previous.host} ready: ${exit.previous.reason}`];
    case "compatible_executor_ready": return ["Compatible executor ready"];
    case "admission_satisfied": case "execution_admitted": return [words(exit.reason)];
    case "attempt_reconciled": return [[`Attempt ${exit.generation} reconciled`, exit.writer_pending && "writer stopped",
      exit.operations.length && exit.operations.join(", ")].filter(Boolean).join(" · ")];
  }
}

function makeGraph(tasks: KbGraphTask[]) {
  const nodes = new Map<string, Node>();
  const edges = new Map<string, Edge>();
  const neighbors = new Map<string, Set<string>>();
  const addEdge = (from: string, to: string, label: string) => {
    if (from === to || !nodes.has(from) || !nodes.has(to)) return;
    neighbors.get(from)?.add(to);
    neighbors.get(to)?.add(from);
    edges.set(JSON.stringify([from, to, label]), { from, to, label });
  };
  const addNode = (node: Node) => {
    if (nodes.has(node.id)) return;
    nodes.set(node.id, node);
    neighbors.set(node.id, new Set());
  };
  const ordered = [...tasks].sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
  for (const card of ordered) addNode({ id: card.id, title: card.title, label: `${card.id} · ${words(card.status)}`, card });
  for (const card of ordered) {
    if (card.part_of) addEdge(card.part_of, card.id, "Contains child work");
    for (const { exit } of card.work_waits) {
      const [title, target] = describe(exit);
      const id = `event:${JSON.stringify(exit)}`;
      addNode({ id, title, label: "Event" });
      addEdge(card.id, id, "Waits for");
      if (target) addEdge(id, target, "Depends on card");
    }
    if (card.condition) {
      const id = `condition:${card.id}`;
      addNode({ id, title: card.condition, label: "Condition" });
      addEdge(card.id, id, "Waits for");
    }
  }
  const groups: Node[][] = [];
  const standalone: Node[] = [];
  const seen = new Set<string>();
  for (const node of nodes.values()) {
    if (seen.has(node.id)) continue;
    seen.add(node.id);
    if (!neighbors.get(node.id)?.size) { standalone.push(node); continue; }
    const group = [node];
    for (const current of group) for (const neighbor of neighbors.get(current.id) ?? []) {
      if (seen.has(neighbor)) continue;
      seen.add(neighbor);
      group.push(nodes.get(neighbor)!);
    }
    groups.push(group);
  }
  const groupByNode = new Map(groups.flatMap((group, index) => group.map(node => [node.id, index] as const)));
  const groupEdges = groups.map(() => [] as Edge[]);
  for (const edge of edges.values()) groupEdges[groupByNode.get(edge.from)!].push(edge);
  return { groups: groups.map((nodes, index) => ({ nodes, edges: groupEdges[index] })), standalone };
}

function NodeButton({ node, openCard }: { node: Node; openCard: (id: string) => void }) {
  const content = <><span>{node.label}</span><strong>{node.title}</strong></>;
  return node.card
    ? <button type="button" className="work-graph-node" data-status={node.card.status} title={node.title} onClick={() => openCard(node.id)}>{content}</button>
    : <div className="work-graph-node work-graph-condition" title={node.title}>{content}</div>;
}

function GraphGroup({ nodes, edges, openCard }: {
  nodes: Node[]; edges: Edge[]; openCard: (id: string) => void;
}) {
  const layout = useMemo(() => {
    const incoming = new Map(nodes.map(node => [node.id, 0]));
    const outgoing = new Map(nodes.map(node => [node.id, [] as Edge[]]));
    const titles = new Map(nodes.map(node => [node.id, node.title]));
    for (const edge of edges) {
      incoming.set(edge.to, incoming.get(edge.to)! + 1);
      outgoing.get(edge.from)!.push(edge);
    }
    const columns = new Map<string, number>();
    const queue = nodes.filter(node => !incoming.get(node.id)).map(node => node.id);
    for (const id of queue) {
      for (const { to: next } of outgoing.get(id)!) {
        columns.set(next, Math.max(columns.get(next) ?? 0, (columns.get(id) ?? 0) + 1));
        const remaining = incoming.get(next)! - 1;
        incoming.set(next, remaining);
        if (remaining === 0) queue.push(next);
      }
    }
    // Keep cycles visible and spread unresolved condition nodes away from cards.
    const rows = new Map<number, number>();
    const points = new Map(nodes.map(node => {
      const column = columns.get(node.id) ?? (incoming.get(node.id) && !node.card ? 1 : 0);
      const row = rows.get(column) ?? 0;
      rows.set(column, row + 1);
      return [node.id, { x: column * (width + columnGap), y: row * (height + rowGap) }];
    }));
    return {
      points, outgoing, titles,
      width: Math.max(...rows.keys()) * (width + columnGap) + width + 16,
      height: Math.max(...rows.values()) * (height + rowGap) - rowGap,
    };
  }, [nodes, edges]);

  return <div className="work-graph-group">
    <div className="work-graph-component" style={{ width: layout.width, height: layout.height }}>
      <svg width={layout.width} height={layout.height} aria-hidden="true">
        {edges.map(edge => {
          const source = layout.points.get(edge.from)!;
          const target = layout.points.get(edge.to)!;
          const forward = source.x < target.x;
          const x = source.x + (forward ? width : width - 12);
          const end = target.x + (forward ? 0 : width);
          const y = source.y + height / 2;
          const endY = target.y + height / 2;
          const elbow = forward ? (x + end) / 2 : Math.max(x, end) + 14;
          const d = `M ${x},${y} C ${elbow},${y} ${elbow},${endY} ${end},${endY}`;
          const arrow = end + (forward ? -6 : 6);
          return <g key={JSON.stringify(edge)} className={edge.label === "Contains child work" ? "work-graph-containment" : "work-graph-dependency"}>
            <title>{edge.label}</title>
            <path d={d} />
            <path d={`M ${arrow},${endY - 4} L ${end},${endY} L ${arrow},${endY + 4}`} />
          </g>;
        })}
      </svg>
      {nodes.map(node => {
        const { x, y } = layout.points.get(node.id)!;
        const connections = layout.outgoing.get(node.id)!;
        return <div key={node.id} className="work-graph-position" style={{ left: x, top: y, width, height }}>
          <NodeButton node={node} openCard={openCard} />
          {!!connections.length && <ul className="work-graph-sr">
            {connections.map(edge => <li key={JSON.stringify(edge)}>{edge.label} {layout.titles.get(edge.to)}</li>)}
          </ul>}
        </div>;
      })}
    </div>
  </div>;
}

export function WorkGraph({ openCard }: { openCard: (id: string) => void }) {
  const [tasks, setTasks] = useState<KbGraphTask[] | null>(null);
  const [error, setError] = useState(false);
  const [query, setQuery] = useState("");
  useEffect(() => {
    const lifetime = new AbortController();
    let loading = false;
    const refresh = async () => {
      if (loading || document.visibilityState === "hidden") return;
      loading = true;
      try {
        const next: KbGraphTask[] = [];
        let cursor: string | null = null;
        do {
          const page: Awaited<ReturnType<typeof kbApi.workGraph>> = await kbApi.workGraph(cursor, lifetime.signal);
          next.push(...page.tasks);
          cursor = page.next_cursor;
        } while (cursor !== null && !lifetime.signal.aborted);
        if (!lifetime.signal.aborted) { setTasks(next); setError(false); }
      } catch {
        if (!lifetime.signal.aborted) setError(true);
      } finally {
        loading = false;
      }
    };
    void refresh();
    const timer = window.setInterval(refresh, 30_000);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      lifetime.abort();
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, []);

  const graph = useMemo(() => makeGraph(tasks ?? []), [tasks]);
  const term = query.trim().toLowerCase();
  const matches = (node: Node) => `${node.label} ${node.title}`.toLowerCase().includes(term);
  const groups = graph.groups.filter(group => group.nodes.some(matches));
  const standalone = graph.standalone.filter(matches);
  return <section className="work-graph" aria-label="Work dependency graph">
    <header className="work-graph-header">
      <div>
        <h1>Work graph</h1>
        <p>{tasks ? `${tasks.length} open cards` : "Open work and dependencies"}</p>
      </div>
      <input type="search" placeholder="Find a card or condition" aria-label="Find a card or condition" value={query} onChange={event => setQuery(event.target.value)} />
    </header>
    {error && <p role="status">{tasks ? "Refresh failed. Showing the last available graph." : "Could not load the graph. Retrying automatically."}</p>}
    {!tasks && !error && <p role="status">Loading open work…</p>}
    {tasks && !tasks.length && <p>No open work.</p>}
    {tasks && tasks.length > 0 && !groups.length && !standalone.length && <p>No matching cards or conditions.</p>}
    {!!groups.length && <>
      <div className="work-graph-legend"><span>Waits for →</span><span>Contains child work ⇢</span></div>
      {groups.map(group => <GraphGroup key={group.nodes[0].id} {...group} openCard={openCard} />)}
    </>}
    {!!standalone.length && <>
      <h2>Work without links</h2>
      <div className="work-graph-standalone">
        {standalone.map(node => <NodeButton key={node.id} node={node} openCard={openCard} />)}
      </div>
    </>}
  </section>;
}
