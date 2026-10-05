// The nightly dream pass: proposes merges, supersedes and retirements into the inbox, never applies them. Needs the model.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";

process.env.ENGRAM_MODEL_DIR ??= join(new URL("..", import.meta.url).pathname, ".model");
const present = existsSync(join(process.env.ENGRAM_MODEL_DIR, "model.safetensors"));
const { req, close, signIn, gitLog } = await import("./_env.mjs");
const { writeDoc } = await import("../dist/src/vault.js");
const { indexPaths } = await import("../dist/src/index.js");
const { dream, judge } = await import("../dist/src/dream.js");
const skip = !present && "no model (scripts/fetch-model.sh)";

let cookie;
before(async () => { cookie = await signIn(); });
after(close);

const DAY = 86400000, T0 = Date.now();
const AGENT = { kind: "agent", label: "Test agent", agent: null, ref: null, at: null }, YOU = { kind: "you", label: "Added in Engram", agent: null, ref: null, at: null };
let n = 0;
// Zero-padded ids: the watermark breaks mtime ties by id.
function mem(text, { scope = "personal", area = "home", at = T0, valid_until = null, source = AGENT } = {}) {
  const id = `m_t${String(++n).padStart(4, "0")}`, rel = `memories/2026/01/${id}.md`;
  writeDoc(rel, { fm: { id, area, project: null, entities: [], scope, source, status: "active", observed_at: at, valid_from: null, valid_until, supersedes: null, superseded_by: null, created_at: at, accepted_at: at }, body: text });
  indexPaths([rel]);
  return id;
}
const tidy = async () => (await req("GET", "/api/inbox", undefined, { cookie })).json.filter((p) => p.kind === "dream");
const about = (list, ids) => list.filter((p) => ids.includes(p.data.drop) || ids.includes(p.data.keep));
const memory = async (id) => (await req("GET", `/api/memories/${id}`, undefined, { cookie })).json;

test("a duplicate pair gets one merge proposal, keeping yours; accepting supersedes the other", { skip }, async () => {
  const mine = mem("Dentist is Dr Rao in Indiranagar", { source: YOU }), theirs = mem("My dentist is Dr Rao, Indiranagar");
  const r = dream();
  assert.equal(r.skipped, null);
  const ps = about(await tidy(), [mine, theirs]);
  assert.equal(ps.length, 1, "one proposal for the pair, not one from each side");
  const p = ps[0];
  assert.equal(p.data.action, "merge");
  assert.equal(p.data.keep, mine);
  assert.equal(p.replaces.id, theirs);
  assert.equal(p.held, false);
  assert.equal(p.scope, "personal");
  assert.equal((await memory(theirs)).status, "active", "nothing applied before you decide");

  const d = await req("POST", `/api/inbox/${p.id}`, { decision: "accept" }, { cookie });
  assert.equal(d.status, 200);
  const gone = await memory(theirs);
  assert.equal(gone.status, "superseded");
  assert.equal(gone.superseded_by, mine);
  assert.equal((await memory(mine)).status, "active");
  assert.match(gitLog()[0], /^tidy: merged My dentist is Dr Rao/);
});

test("a newer value contradicting an older one proposes the edit", { skip }, async () => {
  const old = mem("The building gate code is 4512", { area: "building", at: T0 - 30 * DAY }), fresh = mem("The building gate code is 9031", { area: "building" });
  dream();
  const ps = about(await tidy(), [old, fresh]);
  assert.equal(ps.length, 1);
  assert.equal(ps[0].data.action, "supersede");
  assert.equal(ps[0].data.drop, old);
  assert.equal(ps[0].data.keep, fresh);
  assert.equal(ps[0].data.text, "The building gate code is 9031");
  assert.equal(ps[0].replaces.text, "The building gate code is 4512");
});

test("when unsure it proposes nothing", { skip }, async () => {
  const ids = [
    mem("Jai prefers window seats on flights", { area: "travel" }), mem("Jai likes a window seat when flying", { area: "travel" }),
    mem("Jai prefers aisle seats on trains", { area: "travel" }),
    mem("Monthly rent is 45000 rupees", { at: T0 - DAY }), mem("Monthly maintenance is 3000 rupees"),
    mem("Family doctor is Dr Iyer in Jayanagar", { area: "health", at: T0 - DAY }), mem("Family doctor is Dr Mehta in Koramangala", { area: "health" }),
  ];
  const before = (await tidy()).length, r = dream();
  assert.equal(r.scanned, ids.length);
  assert.equal(r.proposed, 0);
  assert.equal((await tidy()).length, before);
});

test("the watermark skips memories unchanged since the last pass", { skip }, async () => {
  const again = dream();
  assert.equal(again.scanned, 0, "nothing new or changed");
  assert.equal(again.proposed, 0);
  // One new memory: only it is examined, and the unchanged one it repeats is still found.
  const dup = mem("The monthly maintenance is 3000 rupees");
  const r = dream();
  assert.equal(r.scanned, 1);
  assert.equal(r.proposed, 1);
  const p = about(await tidy(), [dup]);
  assert.equal(p.length, 1);
  assert.equal(p[0].data.action, "merge");
  assert.equal(dream().scanned, 0);
});

test("scopes are never crossed", { skip }, async () => {
  const ids = [
    mem("Car insurance is with Acko on the Gold plan", { area: "car" }), mem("Car insurance is with Acko on the Gold plan", { scope: "finance", area: "money" }),
    mem("Gym fee is 2000 rupees a month", { at: T0 - DAY }), mem("Gym fee is 2500 rupees a month", { scope: "health", area: "health" }),
    mem("Blood group is O positive", { scope: "health", area: "health" }), mem("Blood group is O positive", { scope: "household" }),
  ];
  const r = dream();
  assert.equal(r.scanned, ids.length);
  assert.equal(r.proposed, 0);
  assert.equal(about(await tidy(), ids).length, 0);
  const m = (text, scope) => ({ id: text, path: "", text, scope, area: "home", source: AGENT, trust: "trusted", observed_at: 1, valid_until: null, mtime: 0 });
  assert.equal(judge(m("Gate code is 1", "personal"), { ...m("Gate code is 1", "finance"), observed_at: 2 }, 1), null);
});

test("a memory past its valid-until date gets a retire proposal; accepting forgets it", { skip }, async () => {
  const id = mem("The passport renewal appointment is at the Koramangala office", { area: "travel", valid_until: "2020-01-31" });
  dream();
  const ps = about(await tidy(), [id]);
  assert.equal(ps.length, 1);
  assert.equal(ps[0].data.action, "retire");
  assert.equal(ps[0].data.keep, null);
  assert.equal((await req("POST", `/api/inbox/${ps[0].id}`, { decision: "accept" }, { cookie })).status, 200);
  assert.equal((await memory(id)).status, "forgotten");
});

test("a rejected proposal never comes back, and the nightly cap leaves the rest for tomorrow", { skip }, async () => {
  const a = [mem("The water purifier filter is a Kent Grand"), mem("Water purifier filter is the Kent Grand")];
  const b = [mem("Spare house keys are with the neighbour in 4B"), mem("The spare house keys are with the neighbour in 4B")];
  const first = dream({ max: 1 });
  assert.equal(first.proposed, 1);
  assert.equal(first.more, true);
  const second = dream({ max: 1 });
  assert.equal(second.proposed, 1);
  const ps = about(await tidy(), [...a, ...b]);
  assert.equal(ps.length, 2, "one for each pair over two nights");
  for (const p of ps) assert.equal((await req("POST", `/api/inbox/${p.id}`, { decision: "reject" }, { cookie })).status, 200);
  // Rewrite one of each pair so the pass looks at them again: the rejected pairs stay rejected.
  for (const [id, text] of [[a[0], "The water purifier filter is a Kent Grand"], [b[0], "Spare house keys are with the neighbour in 4B"]]) {
    writeDoc(`memories/2026/01/${id}.md`, { fm: { id, area: "home", scope: "personal", source: AGENT, status: "active", observed_at: T0, created_at: T0 }, body: text });
    indexPaths([`memories/2026/01/${id}.md`]);
  }
  const after = dream();
  assert.ok(after.scanned >= 2);
  assert.equal(after.proposed, 0);
});
