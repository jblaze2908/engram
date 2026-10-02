// Search eval: recall@5 and MRR for BM25 alone vs hybrid over a seeded vault. Needs the model (scripts/fetch-model.sh);
// skips without it locally, but fails when ENGRAM_MODEL_DIR is set and empty (the Docker build sets it).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { stringify } from "yaml";

const APP = new URL("..", import.meta.url).pathname, explicit = process.env.ENGRAM_MODEL_DIR;
process.env.ENGRAM_MODEL_DIR ??= join(APP, ".model");
const present = existsSync(join(process.env.ENGRAM_MODEL_DIR, "model.safetensors"));
if (explicit && !present) throw new Error(`ENGRAM_MODEL_DIR=${explicit} has no model.safetensors`);
const { ROOT, close } = await import("./_env.mjs");
const { scan } = await import("../dist/src/index.js");
const { search } = await import("../dist/src/search.js");
after(close);

const CASES = JSON.parse(readFileSync(join(APP, "tests/search-eval.json"), "utf8"));
const SCOPES = ["personal", "finance", "health"];

const mem = (id, area, scope, text) => [`memories/2026/09/${id}.md`, { id, area, scope, source: { kind: "you" } }, text];
const ent = (kind, slug, name, summary, scope = "personal") => [`entities/${kind}/${slug}.md`, { name, summary, scope }, ""];
const skill = (name, description, body) => [`skills/${name}/SKILL.md`, { description, scope: "personal" }, body];
const ep = (id, day, text) => [`journal/2026/09/${day}/${id}.md`, { id, who: "you", at: Date.parse(`2026-09-${day}T10:00:00Z`) }, text];
const FIXTURE = [
  mem("m_airtel", "money", "finance", "Airtel Xstream fiber broadband costs ₹1,178 a month, billed on the 5th from the HDFC card"),
  mem("m_dentist", "health", "health", "Dentist is Dr Rao in Indiranagar; cleaning every six months"),
  mem("m_allergy", "health", "health", "Allergic to penicillin; reacted badly as a child"),
  mem("m_blood", "health", "health", "Blood group is O positive"),
  mem("m_sip", "money", "finance", "SIP of ₹25,000 goes into Parag Parikh Flexi Cap on the 10th"),
  mem("m_gym", "health", "personal", "Gym membership at Cult Indiranagar renews in June"),
  mem("m_passport", "home", "personal", "Passport expires in March 2029; kept in the bedroom safe"),
  mem("m_parking", "home", "personal", "Parking spot at the apartment is B2-114"),
  mem("m_cat", "home", "personal", "Cat named Biscuit; vet is Cessna Lifeline in Domlur, vaccinations due in April"),
  mem("m_mom", "family", "personal", "Mom's birthday is 14 August"),
  mem("m_coffee", "food", "personal", "Black coffee, no sugar; oat milk if it has to be a latte"),
  mem("m_diet", "food", "personal", "Vegetarian on Tuesdays; otherwise eats everything except mushrooms"),
  mem("m_flight", "travel", "personal", "Window seat on flights, IndiGo or Air India; aisle on overnight ones"),
  mem("m_insurance", "health", "finance", "Health insurance is a Niva Bupa family floater, renews in November"),
  mem("m_language", "personal", "personal", "Speaks English, Hindi and basic Kannada"),
  mem("m_focus", "work", "personal", "No meetings before 10 am; deep work from 10 to 1"),
  mem("m_subs", "money", "finance", "Subscriptions: Netflix, Spotify family, YouTube Premium, iCloud 200 GB"),
  mem("m_bescom", "money", "finance", "BESCOM electricity bill is auto-debited from the HDFC account"),
  mem("m_rent", "money", "finance", "Rent is ₹42,000 to landlord Mr Kulkarni on the 1st by NEFT"),
  mem("m_salary", "money", "finance", "Salary lands in the HDFC savings account on the last working day"),
  mem("m_tax", "money", "finance", "Files income tax returns through ClearTax every July"),
  mem("m_car", "home", "personal", "Car is a 2021 Hyundai Creta, service every 10,000 km at Advaith Hyundai"),
  mem("m_ac", "home", "personal", "AC service contract with Daikin, next visit in May"),
  mem("m_wifi", "home", "personal", "Home Wi-Fi router sits in the living room cabinet"),
  mem("m_anniv", "family", "personal", "Wedding anniversary is 2 December"),
  mem("m_slack", "work", "personal", "Slack replies are short and lowercase, no emojis"),
  mem("m_laptop", "work", "personal", "Work laptop is a MacBook Pro M3; personal one is a MacBook Air"),
  mem("m_plants", "home", "personal", "Waters the balcony plants every Sunday evening"),
  mem("m_help", "home", "finance", "House help Lakshmi comes 8 to 10 am, paid ₹9,000 monthly on the 1st"),
  mem("m_run", "health", "health", "Runs 5 km at Cubbon Park on Tuesday and Saturday mornings"),
  mem("m_docs", "home", "personal", "PAN card and Aadhaar copies are in the Documents folder on Drive"),
  ent("person", "dr-rao", "Dr Rao", "Dentist in Indiranagar", "health"),
  ent("person", "mehta", "Rakesh Mehta", "Chartered accountant; prepares and files the yearly tax returns", "finance"),
  ent("person", "kulkarni", "Mr Kulkarni", "Landlord of the apartment"),
  ent("person", "lakshmi", "Lakshmi", "House help"),
  ent("person", "priya", "Priya", "Manager at work; 1:1 on Thursdays"),
  ent("person", "arjun", "Arjun", "Brother, lives in Pune"),
  ent("account", "hdfc-savings", "HDFC savings account", "Primary bank account; salary and auto-debits", "finance"),
  ent("account", "airtel", "Airtel Xstream", "Fiber broadband account", "finance"),
  ent("thing", "creta", "Hyundai Creta", "The car"),
  ent("thing", "biscuit", "Biscuit", "The cat, an indie tabby"),
  ent("place", "cubbon-park", "Cubbon Park", "Park for morning runs"),
  skill("write-like-jai", "Write Slack messages, emails and updates in Jai's voice", "Short sentences. Lowercase on Slack. No exclamation marks, no filler, sign off with just the name."),
  skill("file-a-receipt", "Where receipts and bills go in the vault", "Save the PDF as an artifact under Money, name it vendor and month, then log an episode."),
  skill("weekly-review", "Friday weekly review: close open loops and plan next week", "Inbox to zero, review the calendar, pick three priorities."),
  skill("book-travel", "Booking flights and hotels with Jai's preferences", "Window seat, IndiGo first, hotels near the venue, refundable fares."),
  skill("expense-report", "Submit work expenses to Zoho Expense for reimbursement", "Attach the receipt, pick the cost centre, add the purpose."),
  skill("meeting-notes", "Turn a call transcript into notes with decisions and action items", "Lead with decisions, then owners and dates. Keep it under a page."),
  skill("code-review", "Review a pull request for correctness, tests and style", "Read the diff, run the tests, comment on bugs before nits."),
  skill("grocery-order", "Order groceries on Zepto or Blinkit from the usual list", "Usual list: atta, dal, rice, eggs, curd, fruit, coffee beans."),
  skill("debug-prod", "Investigate a production incident: logs, metrics, recent deploys", "Check error rates first, then the last deploy, then roll back if unsure."),
  skill("pay-bills", "Pay monthly utility bills and log each payment", "Electricity, water, gas and broadband; mark each one paid in the journal."),
  skill("interview-prep", "Prep a dossier before interviewing a candidate", "Verify every resume claim, read their code, write a question ladder."),
  skill("linkedin-post", "Draft a LinkedIn post in Jai's voice", "One idea, short lines, no hashtags."),
  ep("j_carins", "03", "Renewed the car insurance with ACKO for ₹18,400"),
  ep("j_goa", "05", "Booked the Goa trip: IndiGo flights 12 to 15 October"),
  ep("j_bescom", "08", "Paid the BESCOM bill, ₹2,310 for September"),
  ep("j_vet", "09", "Took Biscuit for deworming"),
  ep("j_ship", "11", "Shipped hybrid search to Engram"),
  ep("j_dinner", "12", "Dinner with Arjun at Toit"),
  ep("j_rao", "14", "Called Dr Rao to move the cleaning to 20 October"),
  ep("j_desk", "16", "Ordered a standing desk from Featherlite"),
  ep("j_tap", "18", "Fixed the leaking kitchen tap; plumber charged ₹600"),
  ep("j_marathon", "20", "Ran a half marathon in 2:05"),
];

function write([rel, fm, body]) {
  const p = join(ROOT, "vault", rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, `---\n${stringify(fm)}---\n${body}\n`);
}
const STOP = new Set("a an and are at be can do does for from how i in is it me my of on or s should the to what when where which who with".split(" "));
const words = (s) => (s.normalize("NFD").replace(/\p{Mn}/gu, "").toLowerCase().match(/[\p{L}\p{N}]+/gu) || []);
const pct = (xs, p) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(p * xs.length))];

function evaluate(lexical) {
  let hit5 = 0, rr = 0;
  const ms = [], missed = [];
  for (const c of CASES) {
    const t0 = performance.now(), ids = search({ query: c.query, scopes: SCOPES, limit: 10, lexical }).hits.map((h) => h.id);
    ms.push(performance.now() - t0);
    const rank = ids.indexOf(c.expected_id) + 1;
    if (rank && rank <= 5) hit5++; else missed.push(c.query);
    if (rank) rr += 1 / rank;
  }
  return { recall5: hit5 / CASES.length, mrr: rr / CASES.length, p50: pct(ms, 0.5), p95: pct(ms, 0.95), missed };
}

test("eval set: ≥ 40 cases, ≥ 15 paraphrases sharing no content word with their target", { skip: !present && "no model (scripts/fetch-model.sh)" }, () => {
  for (const f of FIXTURE) write(f);
  scan();
  assert.ok(CASES.length >= 40);
  const para = CASES.filter((c) => c.type === "paraphrase");
  assert.ok(para.length >= 15);
  for (const c of para) {
    const [rel, fm, body] = FIXTURE.find(([rel, fm]) => fm.id === c.expected_id || c.expected_id === `skill:${rel.split("/")[1]}` || c.expected_id === `ent_${rel.split("/")[1]}_${rel.split("/")[2].slice(0, -3)}`);
    const doc = words(`${rel.split("/").slice(1).join(" ")} ${fm.name ?? ""} ${fm.summary ?? ""} ${fm.description ?? ""} ${body}`);
    const shared = words(c.query).filter((q) => !STOP.has(q) && doc.some((d) => d.startsWith(q)));
    assert.deepEqual(shared, [], `"${c.query}" overlaps ${c.expected_id}`);
  }
});

test("hybrid beats BM25 alone on recall@5 and MRR", { skip: !present && "no model (scripts/fetch-model.sh)" }, () => {
  const bm25 = evaluate(true), hybrid = evaluate(false);
  const show = (n, r) => `${n}: recall@5 ${r.recall5.toFixed(3)}  MRR ${r.mrr.toFixed(3)}  p50 ${r.p50.toFixed(2)} ms  p95 ${r.p95.toFixed(2)} ms  (${CASES.length} queries)`;
  console.log(show("bm25  ", bm25));
  console.log(show("hybrid", hybrid));
  console.log("hybrid misses:", hybrid.missed);
  assert.ok(hybrid.recall5 >= bm25.recall5, "recall@5");
  assert.ok(hybrid.mrr >= bm25.mrr, "MRR");
});
