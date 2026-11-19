import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { backfillDutyLookup, DUTY_LOOKUP_SCHEMA } from "../src/kb/duty-lookup";

describe("durable recovery duty lookup", () => {
  it("retains historical attempts, resumes a backfill, and follows concurrent edits and deletes", async () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(`CREATE TABLE artefacts(id TEXT PRIMARY KEY,type TEXT,status TEXT,meta TEXT);
        CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT);`);
      const insert = db.prepare(`INSERT INTO artefacts VALUES(?,'task',?,?)`);
      for (let i = 0; i < 70; i++) insert.run(String(i).padStart(3, "0"), i % 2 ? "done" : "todo",
        JSON.stringify({ machine_duty: { subject: "lane", episode: "same-head" } }));
      db.exec(DUTY_LOOKUP_SCHEMA);
      // Model a previously committed page; the cursor survives an isolate reset.
      db.exec(`INSERT INTO machine_duty_subjects SELECT id,'lane' FROM artefacts WHERE id<='015';
        INSERT INTO settings VALUES('machine_duty_subject_cursor_v1','"015"');`);
      const sql = { exec(query: string, ...args: (string | number | null)[]) {
        const rows = db.prepare(query).all(...args);
        return { toArray: () => rows };
      } } as unknown as SqlStorage;
      const pending = backfillDutyLookup(sql);
      // Writes during the yielding backfill must win over historical snapshots.
      db.prepare(`UPDATE artefacts SET meta=? WHERE id='001'`).run(JSON.stringify({ machine_duty: { subject: "other" } }));
      db.exec(`DELETE FROM artefacts WHERE id='069'`);
      await pending;
      expect(db.prepare(`SELECT count(*) AS n FROM machine_duty_subjects WHERE subject='lane'`).get()?.n).toBe(68);
      expect(db.prepare(`SELECT subject FROM machine_duty_subjects WHERE task_id='001'`).get()?.subject).toBe("other");
      expect(db.prepare(`SELECT task_id FROM machine_duty_subjects WHERE task_id='069'`).get()).toBeUndefined();
      db.exec(`UPDATE artefacts SET meta='{}' WHERE id='002'`);
      expect(db.prepare(`SELECT task_id FROM machine_duty_subjects WHERE task_id='002'`).get()).toBeUndefined();
      insert.run("999", "blocked", JSON.stringify({ machine_duty: { subject: "new" } }));
      await backfillDutyLookup(sql);
      expect(db.prepare(`SELECT subject FROM machine_duty_subjects WHERE task_id='999'`).get()?.subject).toBe("new");
    } finally { db.close(); }
  });
});
