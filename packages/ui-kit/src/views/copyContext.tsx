import { useState } from "react";
import { Btn } from "./index-kit";
import type { KbArtefact, KbVersion } from "../server/kb";
import { buildPromptContext } from "./promptContext";
import { copyText } from "./claimLocally";

/** "Copy prompt context" (BR#4015, Ray 2026-10-28): one click puts a
 *  paste-ready context block for THIS card on the clipboard — permalink,
 *  state, blocked reason, resume conditions, last progress, provenance,
 *  description, recent history — so any agent (local session, chat, ticket)
 *  can look at the right thing without Ray copy-pasting card fields.
 *
 *  Generic: every artefact type gets the same treatment. Prompt producer
 *  only — no state mutation. Failure opens the block in a window (the
 *  ClaimLocallyBtn fallback). */
export function CopyContextBtn({ task, versions, size = "sm" }: {
  task: KbArtefact & { meta?: any };
  versions?: KbVersion[];
  size?: "sm" | "md";
}) {
  const [copied, setCopied] = useState(false);
  const onClick = async () => {
    const block = buildPromptContext(task, {
      versions,
      // BR#4695: prefer the hub-stamped canonical permalink — the copy never
      // carries the workers.dev fallback host, even when browsed via it.
      permalink: typeof task.url === "string" ? task.url : undefined,
      origin: typeof window !== "undefined" ? window.location.origin : undefined,
    });
    const ok = await copyText(block);
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } else {
      const w = window.open("", "_blank", "noopener,width=760,height=640");
      if (w) { w.document.body.textContent = block; }
    }
  };
  return (
    <Btn size={size} quiet className="copy-ctx-btn" disabled={copied}
      title="Copy prompt context: a paste-ready summary of this card (link, state, blocked why/resume, progress, provenance, description, history) for an agent to look at"
      onClick={() => void onClick()}>
      {copied ? "Copied ✓" : "Copy prompt context"}
    </Btn>
  );
}
