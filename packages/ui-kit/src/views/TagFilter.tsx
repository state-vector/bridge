import { useMemo, useState } from "react";
import { Chip } from "./index-kit";

/** Tag themes (BR#2983): tags are 100% user/agent-defined labels — this is
 *  the ONLY thing the UI does with them beyond rendering. A chip cloud with
 *  live counts (the "general themes" view: gtm ×7, deploy-train ×5, …) where
 *  clicking toggles an AND filter over the calling view's rows. */

export interface TagTheme {
  /** tag → count over the counted task set */
  cloud: Array<[string, number]>;
  selected: string[];
  toggle: (tag: string) => void;
  clear: () => void;
  /** row predicate for the calling view */
  passes: (t: any) => boolean;
}

export function useTagTheme(countsFrom: any[]): TagTheme {
  const [selected, setSelected] = useState<string[]>([]);
  const cloud = useMemo(() => {
    const counts = new Map<string, number>();
    for (const t of countsFrom) {
      for (const tag of t.tags ?? []) counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 24);
  }, [countsFrom]);
  const selectedSet = useMemo(() => new Set(selected), [selected]);
  return {
    cloud,
    selected,
    toggle: (tag) =>
      setSelected((cur) => (cur.includes(tag) ? cur.filter((x) => x !== tag) : [...cur, tag])),
    clear: () => setSelected([]),
    passes: (t) => {
      if (!selectedSet.size) return true;
      const tags = t.tags ?? [];
      for (const s of selectedSet) if (!tags.includes(s)) return false;
      return true;
    },
  };
}

export function TagThemeBar({ theme, label = "themes" }: { theme: TagTheme; label?: string }) {
  if (!theme.cloud.length) return null;
  const open = theme.selected.length > 0;
  return (
    <div className={`tag-theme-bar${open ? " tag-theme-open" : ""}`} title="user/agent-defined tag categories — click to filter this view (AND)">
      <span className="tag-theme-label muted-note">{label}</span>
      {theme.cloud.map(([tag, n]) => (
        <Chip
          key={tag}
          tone={theme.selected.includes(tag) ? "live" : "muted"}
          className="tag-theme-chip"
          onClick={(e) => { e.stopPropagation(); theme.toggle(tag); }}
        >
          {tag}<span className="tag-theme-n"> ×{n}</span>
        </Chip>
      ))}
      {open && (
        <button className="tag-theme-clear" onClick={(e) => { e.stopPropagation(); theme.clear(); }}>
          clear
        </button>
      )}
    </div>
  );
}

/** Row chips: a task's own tags, capped for density. */
export function TagChips({ tags, max = 3 }: { tags?: string[] | null; max?: number }) {
  const list = (tags ?? []).filter(Boolean);
  if (!list.length) return null;
  const shown = list.slice(0, max);
  const rest = list.length - shown.length;
  return (
    <span className="tag-chips">
      {shown.map((t) => (
        <Chip key={t} tone="scope" className="tag-chip" title={`tag: ${t}`}>{t}</Chip>
      ))}
      {rest > 0 && <span className="tag-chip-more muted-note" title={list.slice(max).join(", ")}>+{rest}</span>}
    </span>
  );
}
