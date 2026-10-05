// Without the embedding model the dream pass does nothing and says so.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.ENGRAM_MODEL_DIR = mkdtempSync(join(tmpdir(), "engram-nomodel-"));
const { close } = await import("./_env.mjs");
const { writeDoc } = await import("../dist/src/vault.js");
const { indexPaths } = await import("../dist/src/index.js");
const { dream } = await import("../dist/src/dream.js");
const { all } = await import("../dist/src/db.js");
after(close);

test("no model: a logged no-op that proposes nothing", (t) => {
  for (const [id, text] of [["m_a", "Dentist is Dr Rao in Indiranagar"], ["m_b", "My dentist is Dr Rao, Indiranagar"]]) {
    writeDoc(`memories/2026/01/${id}.md`, { fm: { id, area: "home", scope: "personal", status: "active", valid_until: "2020-01-01" }, body: text });
    indexPaths([`memories/2026/01/${id}.md`]);
  }
  const log = t.mock.method(console, "log", () => {});
  const r = dream();
  assert.equal(r.skipped, "no embedding model");
  assert.equal(r.proposed, 0);
  assert.ok(log.mock.calls.some((c) => /^dream: no embedding model/.test(c.arguments[0])));
  assert.equal(all("SELECT 1 FROM proposals WHERE kind='dream'").length, 0);
});
