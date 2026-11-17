import { memo, useEffect, useMemo, useRef, useState } from "react";
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

function placeGroup(nodes: Node[], edges: Edge[]) {
  const incoming = new Map(nodes.map(node => [node.id, 0]));
  const outgoing = new Map(nodes.map(node => [node.id, [] as Edge[]]));
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
    points,
    width: Math.max(...rows.keys()) * (width + columnGap) + width + 16,
    height: Math.max(...rows.values()) * (height + rowGap) - rowGap,
  };
}

function layoutGraph(graph: ReturnType<typeof makeGraph>, term: string) {
  const matches = (node: Node) => `${node.label} ${node.title}`.toLowerCase().includes(term);
  const groups = graph.groups.filter(group => group.nodes.some(matches));
  const standalone = graph.standalone.filter(matches);
  const groupGap = 52;
  const rowWidth = 1800;
  const points = new Map<string, { x: number; y: number }>();
  let x = 0, y = 0, rowHeight = 0, totalWidth = 0;
  const place = (groupWidth: number, groupHeight: number, addPoints: () => void) => {
    if (x && x + groupWidth > rowWidth) {
      y += rowHeight + groupGap;
      x = 0;
      rowHeight = 0;
    }
    addPoints();
    totalWidth = Math.max(totalWidth, x + groupWidth);
    rowHeight = Math.max(rowHeight, groupHeight);
    x += groupWidth + groupGap;
  };
  for (const group of groups) {
    const layout = placeGroup(group.nodes, group.edges);
    place(layout.width, layout.height, () => {
      for (const [id, point] of layout.points) points.set(id, { x: x + point.x, y: y + point.y });
    });
  }
  for (const node of standalone) place(width, height, () => points.set(node.id, { x, y }));
  const nodes = [...groups.flatMap(group => group.nodes), ...standalone];
  const edges = groups.flatMap(group => group.edges);
  const outgoing = new Map(nodes.map(node => [node.id, [] as Edge[]]));
  for (const edge of edges) outgoing.get(edge.from)!.push(edge);
  return {
    points, nodes, edges, outgoing,
    titles: new Map(nodes.map(node => [node.id, node.title])),
    width: totalWidth, height: y + rowHeight,
  };
}

type GraphLayout = ReturnType<typeof layoutGraph>;

const GraphDiagram = memo(function GraphDiagram({ layout, openCard }: {
  layout: GraphLayout; openCard: (id: string) => void;
}) {
  return <>
    <svg width={layout.width} height={layout.height} aria-hidden="true">
      {layout.edges.map(edge => {
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
    {layout.nodes.map(node => {
      const { x, y } = layout.points.get(node.id)!;
      const connections = layout.outgoing.get(node.id)!;
      return <div key={node.id} className="work-graph-position" style={{ left: x, top: y, width, height }}>
        <NodeButton node={node} openCard={openCard} />
        {!!connections.length && <ul className="work-graph-sr">
          {connections.map(edge => <li key={JSON.stringify(edge)}>{edge.label} {layout.titles.get(edge.to)}</li>)}
        </ul>}
      </div>;
    })}
  </>;
});

const initialCamera = { x: 24, y: 24, scale: 1 };

function GraphCanvas({ layout, openCard }: { layout: GraphLayout; openCard: (id: string) => void }) {
  const viewport = useRef<HTMLDivElement>(null);
  const drag = useRef<{ pointer: number; x: number; y: number } | null>(null);
  const [camera, setCamera] = useState(initialCamera);
  const [dragging, setDragging] = useState(false);

  const zoomAt = (factor: number, x: number, y: number) => {
    setCamera(previous => {
      const scale = Math.min(2, Math.max(0.03, previous.scale * factor));
      const ratio = scale / previous.scale;
      return { x: x - (x - previous.x) * ratio, y: y - (y - previous.y) * ratio, scale };
    });
  };
  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const zoom = (event: WheelEvent) => {
      event.preventDefault();
      const origin = element.getBoundingClientRect();
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? element.clientHeight : 1);
      zoomAt(Math.exp(-0.002 * delta), event.clientX - origin.left, event.clientY - origin.top);
    };
    element.addEventListener("wheel", zoom, { passive: false });
    return () => element.removeEventListener("wheel", zoom);
  }, []);

  const panBy = (x: number, y: number) => setCamera(previous => ({ ...previous, x: previous.x + x, y: previous.y + y }));
  const zoom = (factor: number) => {
    const element = viewport.current;
    if (element) zoomAt(factor, element.clientWidth / 2, element.clientHeight / 2);
  };
  const fit = () => {
    const element = viewport.current;
    if (!element || !layout.nodes.length) return;
    const usableHeight = element.clientHeight - 48;
    const scale = Math.max(0.03, Math.min(1, (element.clientWidth - 48) / layout.width, (usableHeight - 48) / layout.height));
    setCamera({ scale, x: (element.clientWidth - layout.width * scale) / 2, y: (usableHeight - layout.height * scale) / 2 });
  };

  return <div className="work-graph-canvas">
    <div
      ref={viewport}
      className="work-graph-viewport"
      data-dragging={dragging || undefined}
      tabIndex={0}
      role="region"
      aria-label="Graph canvas. Drag or use arrow keys to pan. Scroll or use plus and minus to zoom."
      onPointerDown={event => {
        if (drag.current || event.button !== 0 || (event.target as Element).closest("button")) return;
        drag.current = { pointer: event.pointerId, x: event.clientX, y: event.clientY };
        event.currentTarget.setPointerCapture(event.pointerId);
        setDragging(true);
      }}
      onPointerMove={event => {
        const previous = drag.current;
        if (previous?.pointer !== event.pointerId) return;
        panBy(event.clientX - previous.x, event.clientY - previous.y);
        drag.current = { pointer: event.pointerId, x: event.clientX, y: event.clientY };
      }}
      onLostPointerCapture={event => {
        if (drag.current?.pointer !== event.pointerId) return;
        drag.current = null;
        setDragging(false);
      }}
      onFocusCapture={event => {
        if (event.currentTarget === event.target || !event.target.matches(":focus-visible")) return;
        const frame = event.currentTarget.getBoundingClientRect();
        const node = event.target.getBoundingClientRect();
        const offset = (start: number, end: number, min: number, max: number) =>
          start < min + 12 ? min + 12 - start : end > max - 12 ? max - 12 - end : 0;
        panBy(offset(node.left, node.right, frame.left, frame.right), offset(node.top, node.bottom, frame.top, frame.bottom));
      }}
      onKeyDown={event => {
        if (event.target !== event.currentTarget) return;
        switch (event.key) {
          case "ArrowLeft": panBy(64, 0); break;
          case "ArrowRight": panBy(-64, 0); break;
          case "ArrowUp": panBy(0, 64); break;
          case "ArrowDown": panBy(0, -64); break;
          case "+": case "=": zoom(1.25); break;
          case "-": zoom(0.8); break;
          case "0": fit(); break;
          default: return;
        }
        event.preventDefault();
      }}
    >
      <div className="work-graph-world" style={{
        width: layout.width, height: layout.height,
        transform: `translate(${camera.x}px, ${camera.y}px) scale(${camera.scale})`,
      }}>
        <GraphDiagram layout={layout} openCard={openCard} />
      </div>
    </div>
    <div className="work-graph-controls" role="group" aria-label="Graph zoom">
      <button type="button" onClick={() => zoom(0.8)} aria-label="Zoom out" disabled={camera.scale <= 0.03}>−</button>
      <output aria-label="Zoom level">{Math.round(camera.scale * 100)}%</output>
      <button type="button" onClick={() => zoom(1.25)} aria-label="Zoom in" disabled={camera.scale >= 2}>+</button>
      <button type="button" onClick={fit}>Fit</button>
    </div>
  </div>;
}

export function WorkGraph({ active, openCard }: { active: boolean; openCard: (id: string) => void }) {
  const [tasks, setTasks] = useState<KbGraphTask[] | null>(null);
  const [error, setError] = useState(false);
  const [query, setQuery] = useState("");
  const snapshot = useRef({
    cards: new Map<string, KbGraphTask>(),
    after: null as string | null,
    revision: null as number | null,
    hydrated: false,
  });

  useEffect(() => {
    if (!active) return;
    const lifetime = new AbortController();
    const { signal } = lifetime;
    const current = snapshot.current;
    let loading = false;

    const refresh = async () => {
      if (loading || document.visibilityState === "hidden") return;
      loading = true;
      try {
        while (!current.hydrated) {
          const page = await kbApi.workGraph(current.after, signal);
          if (signal.aborted) return;
          current.revision ??= page.revision;
          for (const task of page.tasks) current.cards.set(task.id, task);
          current.after = page.next_cursor;
          current.hydrated = page.next_cursor === null;
          setTasks([...current.cards.values()]);
        }

        let hasMore: boolean;
        do {
          const delta = await kbApi.workGraphDelta(current.revision!, signal);
          if (signal.aborted) return;
          let changed = false;
          for (const id of delta.removed_ids) changed = current.cards.delete(id) || changed;
          for (const task of delta.tasks) {
            if (JSON.stringify(task) === JSON.stringify(current.cards.get(task.id))) continue;
            current.cards.set(task.id, task);
            changed = true;
          }
          current.revision = delta.revision;
          hasMore = delta.has_more;
          if (changed) setTasks([...current.cards.values()]);
        } while (hasMore);
        setError(false);
      } catch {
        if (!signal.aborted) setError(true);
      } finally {
        loading = false;
      }
    };

    void refresh();
    const timer = window.setInterval(refresh, 10_000);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      lifetime.abort();
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [active]);

  const graph = useMemo(() => makeGraph(tasks ?? []), [tasks]);
  const term = query.trim().toLowerCase();
  const layout = useMemo(() => layoutGraph(graph, term), [graph, term]);
  if (!active) return null;
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
    {tasks && tasks.length > 0 && !layout.nodes.length && <p>No matching cards or conditions.</p>}
    {!!layout.nodes.length && <>
      {!!layout.edges.length && <div className="work-graph-legend"><span>Waits for →</span><span>Contains child work ⇢</span></div>}
      <GraphCanvas key={term} layout={layout} openCard={openCard} />
    </>}
  </section>;
}
