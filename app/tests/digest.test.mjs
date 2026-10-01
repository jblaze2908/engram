import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { ROOT, req, close, signIn, gitLog, vaultFile } from "./_env.mjs";

const { scan } = await import("../dist/src/index.js");
const D = await import("../dist/src/digest.js");
const { setSetting } = await import("../dist/src/db.js");

const IST = (s) => Date.parse(`${s}+05:30`);
const put = (rel, s) => { const p = join(ROOT, "vault", rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, s); };
const memory = (id, text, { at, scope = "personal", area = "home", status = "active", valid_until = null, label = "Bills" }) =>
  put(`memories/2026/09/${id}.md`, `---\nid: ${id}\narea: ${area}\nscope: ${scope}\nstatus: ${status}\nsource: { kind: agent, label: ${label} }\ncreated_at: ${at}\nvalid_until: ${valid_until ?? "null"}\n---\n${text}\n`);

let cookie;
before(async () => {
  cookie = await signIn();
  // Week 38 of 2026 is Mon 14 Sep to Sun 20 Sep.
  memory("m_new", "The plumber comes on Thursdays", { at: IST("2026-09-15T10:00:00") });
  memory("m_gone", "The old gate code is 4411", { at: IST("2026-09-16T10:00:00"), status: "forgotten" });
  memory("m_secret", "A private thing from this week", { at: IST("2026-09-16T11:00:00"), scope: "private" });
  memory("m_earlier", "Car insurance renews soon", { at: IST("2026-08-01T10:00:00"), area: "car", valid_until: "2026-10-05" });
  memory("m_far", "Passport renews in 2030", { at: IST("2026-08-01T10:00:00"), area: "travel", valid_until: "2030-01-01" });
  memory("m_loop", "Call the society about the leak #loop", { at: IST("2026-08-02T10:00:00"), area: "building" });
  put("projects/kitchen.md", "---\nname: Kitchen redo\narea: home\nstatus: open\nends: 2026-11-30\n---\n");
  put("projects/done.md", "---\nname: Finished thing\narea: home\nstatus: done\n---\n");
  put("journal/2026/09/14/j_1.md", `---\nid: j_1\nat: ${IST("2026-09-14T09:00:00")}\nwho: Bills\narea: home\n---\nFiled the electricity bill\n`);
  put("journal/2026/09/14/j_2.md", `---\nid: j_2\nat: ${IST("2026-09-14T18:00:00")}\nwho: you\narea: home\n---\nPaid the maid\n`);
  put("journal/2026/09/19/j_3.md", `---\nid: j_3\nat: ${IST("2026-09-19T12:00:00")}\nwho: Travel\narea: travel\n---\nBooked the Goa trip\n`);
  put("journal/2026/09/21/j_4.md", `---\nid: j_4\nat: ${IST("2026-09-21T12:00:00")}\nwho: Travel\narea: travel\n---\nNext week, not this one\n`);
  scan();
});
after(close);

test("ISO weeks and the Sunday 19:00 IST due time", () => {
  assert.equal(D.isoWeek(IST("2026-09-14T00:00:00")), "2026-W38");
  assert.equal(D.isoWeek(IST("2026-09-20T23:59:00")), "2026-W38");
  assert.equal(D.isoWeek(IST("2027-01-01T10:00:00")), "2026-W53");
  assert.deepEqual([D.weekRange("2026-W38").from, D.weekRange("2026-W38").to], ["2026-09-14", "2026-09-20"]);
  assert.equal(D.dueWeek(IST("2026-09-20T18:59:00")), "2026-W37");
  assert.equal(D.dueWeek(IST("2026-09-20T19:00:00")), "2026-W38");
});

test("digest for a seeded week: waiting, running out, changed, open loops, journal; never private", async () => {
  const r = await req("GET", "/api/digest?week=2026-W38", undefined, { cookie });
  assert.equal(r.status, 200);
  const d = r.json;
  assert.deepEqual([d.week, d.from, d.to], ["2026-W38", "2026-09-14", "2026-09-20"]);
  assert.deepEqual(d.waiting, { open: 0, held: 0 });
  assert.deepEqual(d.runningOut, [{ date: "2026-10-05", text: "Car insurance renews soon", area: "car" }]);
  assert.deepEqual(d.changed.map((c) => [c.text, c.tone]), [["Forgot: The old gate code is 4411", "bad"], ["The plumber comes on Thursdays", "normal"]]);
  assert.match(d.changed[1].detail, /^Bills · Tue 15 Sept? · Home$/);
  assert.deepEqual(d.openLoops, [{ text: "Kitchen redo, ends 2026-11-30", area: "home" }, { text: "Call the society about the leak", area: "building" }]);
  assert.deepEqual(d.journal, [
    { day: "2026-09-14", lines: ["Bills: Filed the electricity bill", "You: Paid the maid"] },
    { day: "2026-09-19", lines: ["Travel: Booked the Goa trip"] },
  ]);
  assert.doesNotMatch(JSON.stringify(d), /private thing/);
  assert.equal((await req("GET", "/api/digest?week=2999-W01", undefined, { cookie })).status, 404);
  assert.equal((await req("GET", "/api/digest?week=nope", undefined, { cookie })).status, 400);
  assert.equal((await req("GET", "/api/digest")).status, 401);
});

test("stored as vault/digests/YYYY-Www.md with one commit; the stored copy is served and listed", async () => {
  const d = await D.storeDigest("2026-W38", IST("2026-09-20T19:00:00"));
  assert.equal(gitLog()[0], "digest: 2026-W38");
  const md = vaultFile("digests/2026-W38.md");
  assert.match(md, /^---\nkind: digest\nweek: 2026-W38\n/);
  assert.match(md, /# The week of 2026-09-14 to 2026-09-20/);
  assert.match(md, /- 2026-10-05: Car insurance renews soon \(Car\)/);
  assert.match(md, /### Mon 14 Sept?\n- Bills: Filed the electricity bill/);
  const r = (await req("GET", "/api/digest?week=2026-W38", undefined, { cookie })).json;
  assert.equal(r.built_at, d.built_at);
  const weeks = (await req("GET", "/api/digest/weeks", undefined, { cookie })).json;
  assert.equal(weeks[0], D.isoWeek(Date.now()));
  assert.ok(weeks.includes("2026-W38"));
});

test("the scheduler writes the due week once, and never for weeks before Engram was installed", async () => {
  const sunday = IST("2026-09-27T19:30:00");
  setSetting("installed_at", IST("2026-10-01T00:00:00"));
  assert.equal(await D.digestDue(sunday), null);
  setSetting("installed_at", IST("2026-09-01T00:00:00"));
  const d = await D.digestDue(sunday);
  assert.equal(d.week, "2026-W39");
  assert.deepEqual(d.journal, [{ day: "2026-09-21", lines: ["Travel: Next week, not this one"] }]);
  assert.ok(existsSync(join(ROOT, "vault/digests/2026-W39.md")));
  assert.equal(await D.digestDue(sunday + 3600000), null, "already written");
});
