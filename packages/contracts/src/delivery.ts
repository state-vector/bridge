/** Delivery lifecycles are independent of the historical card's status. */
export type AcceptedPrLeg = { repo: string; number: number; head_sha_at_acceptance: string };

export type AdmissionState =
  | { phase: "pending" }
  | { phase: "held"; reason: string }
  | { phase: "admitted"; task_id: string; subject_revision: string }
  | { phase: "replaced"; review_id: string };

export interface DeliveryAdmission {
  review_id: string;
  task_id: string;
  delivery_owner: string;
  actor: string;
  accepted_at: number;
  subject_revision: string;
  legs: AcceptedPrLeg[];
  state: AdmissionState;
}

export type DeliveryDisposition =
  | { kind: "replace"; successor: string; reason: string }
  | { kind: "abandon"; authorised_by: string; reason: string;
      closure: { phase: "pending"; duty_id: string } | { phase: "closed"; receipts: string[] } }
  | { kind: "hold"; owner: string; reason: string; next: string; deadline: number };
