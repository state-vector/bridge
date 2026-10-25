/**
 * Device pairing contract (start + poll) — BR#2844.
 *
 * Consumed by the runner's Rust pairing flow (dispatch.rs pair_start /
 * pair_poll parse these payloads today) and served by the hub's
 * /api/pair/start + /api/pair/poll routes (kb/do.ts wsPairStart /
 * wsPairPoll). The fixture (`fixtures/pairing-poll.json`) records one good
 * exemplar per poll status; the fixture test parses each against the
 * discriminated union below.
 */
import { z } from "zod";

export const PairStartRequestSchema = z.looseObject({
  device: z.string().optional(),
  /** The DEVICE declares its class at start; the approver never chooses. */
  type: z.enum(["agent", "gateway"]).optional(),
  device_id: z.string().nullable().optional(),
  principal: z.string().nullable().optional(),
});
export type PairStartRequest = z.infer<typeof PairStartRequestSchema>;

export const PairStartResponseSchema = z.object({
  code: z.string(),
  type: z.enum(["gateway", "agent"]),
  expires_ts: z.number(),
});
export type PairStartResponse = z.infer<typeof PairStartResponseSchema>;

export const PairPollRequestSchema = z.object({ code: z.string() });
export type PairPollRequest = z.infer<typeof PairPollRequestSchema>;

/**
 * One pairing poll response. `authorized` carries the vended token — the
 * token leaves the registry exactly once; fixtures record it redacted.
 */
export const PairPollResponseSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("authorized"),
    token: z.string().min(1),
    ws: z.string(),
    label: z.string(),
    tags: z.array(z.string()),
  }),
  z.object({ status: z.literal("pending") }),
  z.object({ status: z.literal("denied") }),
  z.object({ status: z.literal("expired") }),
  z.object({ status: z.literal("slow_down") }),
]);
export type PairPollResponse = z.infer<typeof PairPollResponseSchema>;
