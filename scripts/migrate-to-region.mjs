/**
 * Copy this application's data into a new Supabase project.
 *
 * Supabase binds a project to its region at the infrastructure level, so moving
 * the database from Seoul to Mumbai means a new project and a data migration —
 * there is no in-place region change. Cloud Run runs in asia-south1, and every
 * cross-region round trip was costing ~110ms on the critical path of every turn.
 *
 * Only Prisma-owned tables are copied. The source project also hosts an
 * unrelated `intern_portal` schema plus Supabase's own auth/storage/realtime
 * schemas; those belong to a different application and are deliberately left
 * where they are.
 *
 * pg_dump is not used: Prisma owns this schema, so `prisma db push` recreates it
 * exactly on the target and the rows are copied through the same client that
 * writes them normally. That also means the target comes up with any pending
 * schema change already applied.
 *
 * Usage:
 *   SOURCE_URL=<old project> TARGET_URL=<new project> node scripts/migrate-to-region.mjs --dry-run
 *   SOURCE_URL=<old project> TARGET_URL=<new project> node scripts/migrate-to-region.mjs
 *
 * Run `npx prisma db push` against TARGET_URL first — this script copies rows,
 * it does not create tables.
 */
import { PrismaClient } from "@prisma/client";
import { readFileSync } from "node:fs";

const SOURCE_URL = process.env.SOURCE_URL;
const TARGET_URL = process.env.TARGET_URL;
const dryRun = process.argv.includes("--dry-run");
const BATCH = 500;

if (!SOURCE_URL || !TARGET_URL) {
  console.error("SOURCE_URL and TARGET_URL are both required.");
  process.exit(1);
}
if (SOURCE_URL === TARGET_URL) {
  console.error("SOURCE_URL and TARGET_URL are the same database. Refusing.");
  process.exit(1);
}

const source = new PrismaClient({ datasourceUrl: SOURCE_URL });
const target = new PrismaClient({ datasourceUrl: TARGET_URL });

// Model names come from the schema itself, so a model added later is copied
// without anyone remembering to add it here.
const schema = readFileSync(new URL("../prisma/schema.prisma", import.meta.url), "utf8");
const models = [...schema.matchAll(/^model\s+(\w+)\s*\{/gm)].map((m) => m[1]);
const delegateOf = (model) => model[0].toLowerCase() + model.slice(1);

console.log(`${models.length} models in schema.prisma\n`);

// ── Safety: the target must be reachable, and it must be empty ──────────────
// Reachability is checked separately and first. The emptiness check below reads
// a failed count as zero, so an unreachable target would otherwise look like a
// pristine one and pass the guard for the wrong reason.
try {
  await target.$queryRawUnsafe("SELECT 1");
} catch (e) {
  console.error(`Target is not reachable: ${e.message.split("\n").slice(-1)[0].trim()}`);
  console.error("Check TARGET_URL, and run `npx prisma db push` against it first.");
  process.exit(1);
}

let occupied = [];
for (const m of models) {
  const n = await target[delegateOf(m)].count().catch(() => 0);
  if (n > 0) occupied.push(`${m}(${n})`);
}
if (occupied.length) {
  console.error("Target is not empty — refusing to copy into it:");
  console.error("  " + occupied.join(", "));
  console.error("\nThis script only ever populates a fresh project. Reset the target and retry.");
  process.exit(1);
}

// ── Read everything from the source ─────────────────────────────────────────
const data = {};
let totalRows = 0;
for (const m of models) {
  const rows = await source[delegateOf(m)].findMany().catch((e) => {
    console.error(`  ${m}: could not read — ${e.message.split("\n")[0]}`);
    return null;
  });
  if (rows === null) continue;
  data[m] = rows;
  totalRows += rows.length;
  if (rows.length) console.log(`  read ${String(rows.length).padStart(5)}  ${m}`);
}
console.log(`\n${totalRows} rows to copy`);

if (dryRun) {
  console.log("\n--dry-run: nothing written.");
  await source.$disconnect();
  await target.$disconnect();
  process.exit(0);
}

// ── Write, resolving foreign-key order by making progress ───────────────────
// Rather than hardcoding a dependency order that drifts as relations change,
// retry the tables that fail on a foreign key until a full pass writes nothing
// new. A genuine error therefore surfaces as "no progress" rather than being
// silently skipped.
let pending = models.filter((m) => (data[m]?.length ?? 0) > 0);
const written = {};

while (pending.length) {
  const failed = [];
  let progressed = false;

  for (const m of pending) {
    try {
      const rows = data[m];
      for (let i = 0; i < rows.length; i += BATCH) {
        await target[delegateOf(m)].createMany({
          data: rows.slice(i, i + BATCH),
          skipDuplicates: true,
        });
      }
      written[m] = rows.length;
      console.log(`  wrote ${String(rows.length).padStart(5)}  ${m}`);
      progressed = true;
    } catch (e) {
      failed.push({ model: m, error: e.message.split("\n").slice(-1)[0].trim() });
    }
  }

  if (!progressed) {
    console.error("\nStuck — these tables could not be written:");
    for (const f of failed) console.error(`  ${f.model}: ${f.error}`);
    process.exit(1);
  }
  pending = failed.map((f) => f.model);
}

// ── Sequences ───────────────────────────────────────────────────────────────
// createMany preserves the ids it was given without advancing the identity
// sequence, so the next insert on the new project would collide with row 1.
console.log("\nresetting id sequences");
for (const m of models) {
  if (!written[m]) continue;
  try {
    await target.$executeRawUnsafe(
      `SELECT setval(pg_get_serial_sequence('"${m}"', 'id'), COALESCE((SELECT MAX(id) FROM "${m}"), 1), true)`,
    );
  } catch {
    // Models keyed by something other than an autoincrementing id.
  }
}

// ── Verify ──────────────────────────────────────────────────────────────────
console.log("\nverifying row counts");
let mismatch = 0;
for (const m of models) {
  const [a, b] = await Promise.all([
    source[delegateOf(m)].count().catch(() => -1),
    target[delegateOf(m)].count().catch(() => -1),
  ]);
  if (a !== b) {
    console.error(`  MISMATCH  ${m}: source ${a}, target ${b}`);
    mismatch++;
  }
}

console.log(
  mismatch === 0
    ? `\nAll ${models.length} tables match. ${totalRows} rows copied.`
    : `\n${mismatch} table(s) do not match — do NOT cut over.`,
);

await source.$disconnect();
await target.$disconnect();
process.exit(mismatch === 0 ? 0 : 1);
