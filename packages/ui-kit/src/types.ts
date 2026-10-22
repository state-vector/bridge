/** Wire-shapes shared by every shell that renders board views. */

export interface BoardTask {
  id: string;
  title: string;
  status: string;
  tags?: string[] | null;
  owner?: string;
  created_ts?: number;
  updated_ts?: number;
  status_ts?: number;
  meta?: {
    last_progress?: {
      note?: string;
      will?: string;
      sentiment?: string;
      actor?: string;
      ts?: number;
      completion_pct?: number;
      confidence_pct?: number;
      risk_pct?: number;
      context_pct?: number;
    };
    attempt?: { by?: string; attempts?: number; last_reason?: string };
    blocked?: { reason?: string; unblock_condition?: string };
    awaiting_ask?: { ask_id?: string };
    boosted?: boolean;
    kind?: string;
    session?: string;
    [k: string]: unknown;
  };
  part_of?: string;
}

export interface VerdictDecision {
  id: string;
  title: string;
  status: string;
  created_ts: number;
  updated_ts: number;
  meta?: {
    decision_class?: string;
    verdict?: string;
    task?: string;
    verify_target?: string;
    round?: number;
    [k: string]: unknown;
  };
}

/** One KB event frame forwarded from the hub stream. */
export interface KbEventFrame {
  type: string;
  events?: Array<{ seq: number; ts: number; actor: string; op: string; artefact_id?: string; detail?: unknown }>;
  event?: Record<string, unknown>;
}
