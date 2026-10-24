/**
 * Token provisioning contract — BR#2844.
 *
 * agent.provision: a gateway mints (or rotates) a per-agent token. The
 * `{exists: true}` response WITHOUT a secret is the churn-engine incident
 * (BR#2878): the hub vends a secret exactly once, so an exists-without-
 * secret response is only recoverable by a rotate re-vend — the union below
 * makes "exists" and "vended" distinct shapes the runner can discriminate.
 * self.provision: the human session mints the device's own gateway token.
 */
import { z } from "zod";

export const AgentProvisionRequestSchema = z.looseObject({
  label: z.string(),
  rotate: z.boolean().optional(),
  device_id: z.string().nullable().optional(),
  principal: z.string().nullable().optional(),
  provisioned_by: z.string().optional(),
});
export type AgentProvisionRequest = z.infer<typeof AgentProvisionRequestSchema>;

/** Either "already exists (no secret re-exposed)" or a fresh vending. */
export const AgentProvisionResponseSchema = z.union([
  z.object({
    exists: z.literal(true),
    id: z.string(),
    label: z.string(),
  }),
  z.object({
    id: z.string(),
    label: z.string(),
    secret: z.string().min(1),
    provisioned_by: z.string(),
  }),
]);
export type AgentProvisionResponse = z.infer<typeof AgentProvisionResponseSchema>;

export const SelfProvisionRequestSchema = z.looseObject({
  host: z.string().optional(),
  principal: z.string().optional(),
  ws: z.string().optional(),
});
export type SelfProvisionRequest = z.infer<typeof SelfProvisionRequestSchema>;
