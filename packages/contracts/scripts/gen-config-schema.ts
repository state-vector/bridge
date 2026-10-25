// Regenerates packages/contracts/config.schema.json from the zod config
// contract. Run: node --experimental-strip-types scripts/gen-config-schema.ts
// CI diffs the regenerated projection against the checked-in file — edit the
// schema, re-run this, commit both together.
import { writeFileSync } from "node:fs";
import { configJsonSchema } from "../src/config.ts";

const out = JSON.stringify(configJsonSchema(), null, 2) + "\n";
const target = new URL("../config.schema.json", import.meta.url);
writeFileSync(target, out);
console.log(`wrote ${target.pathname} (${out.length} bytes)`);
