import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { WriterReceiptSchema, ExecutionCommandSchema } from "../src/index.ts";

it("shares exact stopped-owner receipt shapes with the native runner", () => {
  const cases: unknown[] = JSON.parse(readFileSync(new URL("../fixtures/writer-receipts.json", import.meta.url), "utf8"));
  for (const value of cases) expect(WriterReceiptSchema.parse(value)).toEqual(value);
  expect(ExecutionCommandSchema.parse({ kind: "writer_receipt", generation: 1, attempt_id: "old-attempt" })).toEqual({ kind: "writer_receipt", generation: 1, attempt_id: "old-attempt" });
  expect(WriterReceiptSchema.safeParse({ kind: "writer_receipt_found", task_id: "old-task", command_id: "proof", source: "quiesce" }).success).toBe(false);
});
