import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";

// A fake ntfy server, up before Engram boots so the module reads its URL.
const got = [];
const ntfy = createServer((rq, rs) => { let body = ""; rq.on("data", (c) => (body += c)); rq.on("end", () => { got.push({ path: rq.url, headers: rq.headers, body }); rs.end("{}"); }); });
await new Promise((ok) => ntfy.listen(0, "127.0.0.1", ok));
process.env.ENGRAM_NTFY_URL = `http://127.0.0.1:${ntfy.address().port}/engram-test`;
process.env.ENGRAM_NTFY_TOKEN = "tk_fake_ntfy_token";
process.env.ENGRAM_PUBLIC_URL = "https://engram.example";
const { req, close, signIn, makeAgent, g, call } = await import("./_env.mjs");
const N = await import("../dist/src/notify.js");
const D = await import("../dist/src/digest.js");
const { run } = await import("../dist/src/db.js");

const arrived = async (n) => { for (let i = 0; i < 100 && got.length < n; i++) await new Promise((r) => setTimeout(r, 20)); return got.length; };
const quiet = () => new Promise((r) => setTimeout(r, 150));

let cookie, token;
before(async () => {
  cookie = await signIn();
  ({ token } = await makeAgent(cookie, "Mail reader", [g("personal", true, "propose"), g("finance", true, "propose")]));
});
after(async () => { ntfy.close(); await close(); });

test("the first held proposal notifies at once, by kind only outside personal scope", async () => {
  const p = await call(token, "propose", { kind: "memory", text: "Salary account number is 1234 5678", area: "money", scope: "finance", source: { kind: "email", label: "HR mail", ref: "m1" } });
  assert.equal(p.data.status, "held");
  assert.equal(await arrived(1), 1);
  const n = got[0];
  assert.equal(n.path, "/engram-test");
  assert.equal(n.body, "Held for review: a finance memory");
  assert.equal(n.headers.title, "Engram");
  assert.equal(n.headers.click, `https://engram.example/#/inbox/${p.data.id}`);
  assert.equal(n.headers.authorization, "Bearer tk_fake_ntfy_token");
});

test("more held proposals within 10 minutes are batched into one; open ones don't notify", async () => {
  await call(token, "propose", { kind: "memory", text: "Rent is due on the 5th", area: "home", source: { kind: "email", label: "Re: rent", ref: "m2" } });
  await call(token, "propose", { kind: "memory", text: "The society meeting is Sunday", area: "building", source: { kind: "web", label: "notice board" } });
  await call(token, "propose", { kind: "memory", text: "Car insurance renews in March", area: "car" });
  await quiet();
  assert.equal(got.length, 1, "still batching");
  await N.flushHeld();
  assert.equal(await arrived(2), 2);
  assert.equal(got[1].body, "2 proposals are held for review");
  assert.equal(got[1].headers.click, "https://engram.example/#/inbox");
  await N.flushHeld();
  await quiet();
  assert.equal(got.length, 2, "nothing left to send");
});

test("a tool_change proposal from any path notifies at once", async () => {
  run("INSERT INTO proposals(id,kind,agent,title,scope,area,data,source,reasons,held,status,created_at) VALUES('p_tool','tool_change',NULL,'gmail/send_message','personal','home','{}','{}','[]',1,'open',?)", Date.now());
  await N.sweepProposals();
  assert.equal(await arrived(3), 3);
  assert.equal(got[2].body, "A tool changed its description and is blocked: gmail/send_message");
  assert.equal(got[2].headers.priority, "4");
  await N.sweepProposals();
  await quiet();
  assert.equal(got.length, 3, "each proposal is seen once");
});

test("weekly digest and running-out notifications carry counts and personal titles only", async () => {
  await N.notifyDigest(D.buildDigest(D.isoWeek(Date.now())));
  assert.equal(await arrived(4), 4);
  assert.match(got[3].body, /^Your week in Engram: \d+ waiting, \d+ running out, \d+ open loops$/);
  assert.match(got[3].headers.click, /^https:\/\/engram\.example\/#\/digest\?week=\d{4}-W\d{2}$/);

  const soon = D.istDay(Date.now() + 3 * 86400000);
  await req("POST", "/api/memories", { text: "Passport photo appointment", area: "travel", scope: "personal", valid_until: soon }, { cookie });
  await N.runningOutCheck();
  assert.equal(await arrived(5), 5);
  assert.equal(got[4].body, "Runs out in 3 days: Passport photo appointment");
  await N.runningOutCheck();
  await quiet();
  assert.equal(got.length, 5, "once a day");
  for (const n of got) {
    assert.doesNotMatch(n.body, /1234 5678|Salary|tk_fake/);
  }
});
