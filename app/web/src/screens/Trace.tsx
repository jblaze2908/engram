import type { Provenance, TraceRow } from "../../../shared/types";
import { useState } from "react";
import { api, ApiError } from "../lib/api";
import { useApp } from "../lib/app";
import { useAgentList, useWho } from "../lib/directory";
import { clock, shortDate, todayIso } from "../lib/format";
import { href, navigate } from "../lib/router";
import { useLoad } from "../lib/useLoad";
import { Btn, Card, cx, Dot, Empty, ErrorNote, Lede, LinkBtn, Loading, Main, SearchField } from "../components/ui";

const RESULTS: TraceRow["result"][] = ["ok", "refused", "held", "blocked", "error"];
const resultColor = (r: TraceRow["result"]) => (r === "refused" || r === "blocked" ? "var(--signal)" : r === "error" ? "var(--bad)" : "var(--ink-2)");

export function Trace({ query }: { query: URLSearchParams }) {
  const who = useWho();
  const agents = useAgentList();
  const dayParam = query.get("day");
  const day = dayParam === "all" ? undefined : dayParam ?? todayIso();
  const whoF = query.get("who") ?? undefined;
  const result = (query.get("result") as TraceRow["result"] | null) ?? undefined;
  const q = query.get("q") ?? "";
  const rowId = query.get("row");
  const factId = query.get("id");

  const rows = useLoad(() => api.trace({ who: whoF, result, day }), [whoF, result, day]);
  const shown = (rows.data ?? []).filter((r) => !q || `${r.action} ${r.target} ${r.detail ?? ""}`.toLowerCase().includes(q.toLowerCase()));
  const picked = shown.find((r) => String(r.id) === rowId);
  const pid = factId ?? picked?.target ?? (q || null);
  const prov = useLoad<Provenance | null>(
    () => (pid ? api.provenance(pid).catch((e: unknown) => { if (e instanceof ApiError && e.status !== 0 && e.status < 500) return null; throw e; }) : Promise.resolve(null)),
    [pid],
  );

  const to = (p: Record<string, string | null | undefined>) => {
    const cur: Record<string, string | null | undefined> = { day: dayParam, who: whoF, result, q, row: rowId, id: factId };
    return href(["trace"], { ...cur, ...p });
  };

  return (
    <Main>
      <h1 className="text-[30px] font-semibold tracking-[-0.025em] leading-tight">Trace</h1>
      <Lede>Every read, write and upstream call, and where each fact came from.</Lede>
      <div className="flex items-center gap-2 mt-5 flex-wrap">
        <a href={to({ day: dayParam === "all" ? null : "all", row: null })} aria-pressed={day !== undefined}
          className={cx("inline-flex items-center h-[30px] px-3 rounded-full text-[12.5px] border", day ? "bg-surface-2 text-ink border-transparent" : "text-ink-3 border-line")}>
          {day ? (day === todayIso() ? "Today" : shortDate(day)) : "Any day"}
        </a>
        <label className="sr-only" htmlFor="trace-who">Agent</label>
        <select id="trace-who" value={whoF ?? ""} onChange={(e) => navigate(to({ who: e.target.value || null, row: null }))}
          className="h-[30px] px-3 rounded-full text-[12.5px] bg-transparent border border-line text-ink-2">
          <option value="">All agents</option>
          <option value="you">You</option>
          {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
        <label className="sr-only" htmlFor="trace-result">Result</label>
        <select id="trace-result" value={result ?? ""} onChange={(e) => navigate(to({ result: e.target.value || null, row: null }))}
          className="h-[30px] px-3 rounded-full text-[12.5px] bg-transparent border border-line text-ink-2">
          <option value="">All results</option>
          {RESULTS.map((r) => <option key={r} value={r}>{r === "ok" ? "OK only" : `${r[0].toUpperCase()}${r.slice(1)} only`}</option>)}
        </select>
        <SearchField className="wide:ml-auto w-full wide:w-[300px] h-[36px]" label="Search calls, or paste a fact id" placeholder="Search calls, or paste a fact id"
          value={q} onSubmit={(nq) => navigate(to({ q: nq || null, id: null, row: null }))} />
      </div>

      <div className="grid grid-cols-1 wide:grid-cols-[1fr_440px] gap-3 mt-4 flex-1 min-h-0">
        <Card className="overflow-hidden min-h-0 flex flex-col">
          <div className="grid grid-cols-[48px_130px_1fr_92px] gap-3 items-center px-[18px] py-2.5 text-[12px] text-ink-3 max-wide:hidden">
            <span>Time</span><span>Who</span><span>What</span><span className="text-right">Result</span>
          </div>
          <div className="overflow-y-auto min-h-0">
            {rows.loading && !rows.data && <Loading />}
            {rows.error && <ErrorNote error={rows.error} onRetry={rows.reload} />}
            {rows.data && shown.length === 0 && (
              <Empty className="border-t border-line">
                {q ? `No calls match “${q}”.` : day ? "No calls yet today. Each agent call, refusal and decision is written here as it happens." : "No calls recorded yet. Each agent call, refusal and decision is written here as it happens."}
              </Empty>
            )}
            {shown.map((r) => {
              const w = who(r.who);
              const on = picked?.id === r.id;
              return (
                <a key={r.id} href={to({ row: on ? null : String(r.id), id: null })} aria-current={on ? "true" : undefined}
                  className={cx("grid grid-cols-[48px_1fr_72px] wide:grid-cols-[48px_130px_1fr_92px] gap-3 items-center px-[18px] py-2.5 border-t border-line text-[13px] hover:bg-surface-2", on && "bg-surface-2")}>
                  <span className="font-mono text-[12px] text-ink-3">{clock(r.at)}</span>
                  <span className="flex items-center gap-2 min-w-0 max-wide:hidden"><Dot color={w.color} /><span className="truncate">{w.name}</span></span>
                  <span className="truncate"><span className="wide:hidden text-ink-3">{w.name} · </span>{r.action} · {r.target}</span>
                  <span className="text-[12px] text-right" style={{ color: resultColor(r.result) }}>{r.detail && r.result === "ok" ? r.detail : r.result}</span>
                </a>
              );
            })}
          </div>
        </Card>

        <Card className="p-6 flex flex-col">
          {prov.data ? <Steps p={prov.data} /> : picked ? <RowDetail r={picked} onUndone={rows.reload} /> : prov.loading && pid ? <Loading /> : (
            <>
              <p className="text-[13px] text-ink-3">Where this came from</p>
              <p className="text-[13.5px] text-ink-2 mt-2 leading-relaxed">
                {pid ? `No memory has the id “${pid}”.` : "Pick a call to see it in full. Paste a memory’s id in the search box, or open “Where it came from” on a memory, to follow it back to its source."}
              </p>
            </>
          )}
        </Card>
      </div>
    </Main>
  );
}

function RowDetail({ r, onUndone }: { r: TraceRow; onUndone: () => void }) {
  const who = useWho();
  const { notify } = useApp();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Only your accepts of a proposal can be undone; the server refuses anything that isn't an accepted memory.
  const undoable = r.action === "accept" && r.who === "you" && r.target.startsWith("p_");
  async function undo() {
    if (!window.confirm("Undo this accept? The memory it added is forgotten, and the one it replaced comes back.")) return;
    setBusy(true); setError(null);
    try { const u = await api.undoAccept(r.target); notify(u.restored ? "Undone. The earlier memory is back." : "Undone."); onUndone(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  }
  return (
    <>
      <p className="text-[13px] text-ink-3">Call</p>
      <p className="text-[20px] font-semibold tracking-[-0.015em] mt-1.5">{r.action}</p>
      <p className="text-[12.5px] text-ink-3 mt-1">{shortDate(r.at)} {clock(r.at)}</p>
      <div className="mt-5 -mx-[18px]">
        <div className="kv"><span>Who</span><span>{who(r.who).name}</span></div>
        <div className="kv"><span>Target</span><span className="font-mono text-[12px]">{r.target}</span></div>
        {r.scope && <div className="kv"><span>Scope</span><span>{r.scope}</span></div>}
        <div className="kv"><span>Result</span><span style={{ color: resultColor(r.result) }}>{r.result}</span></div>
        {r.detail && <div className="kv"><span>Detail</span><span>{r.detail}</span></div>}
      </div>
      {error && <p role="alert" className="text-[13px] text-bad mt-4">{error}</p>}
      {undoable && <div className="mt-auto pt-4"><Btn disabled={busy} onClick={undo}>Undo accept</Btn></div>}
    </>
  );
}

function Steps({ p }: { p: Provenance }) {
  const m = p.memory;
  return (
    <>
      <p className="text-[13px] text-ink-3">Where this came from</p>
      <p className="text-[20px] font-semibold tracking-[-0.015em] mt-1.5">{m.text}</p>
      <p className="text-[12.5px] text-ink-3 mt-1">{m.scope} · {m.status}{m.supersedes ? " · replaced an earlier one" : ""}</p>
      <ol className="mt-6">
        {p.steps.map((s, i) => (
          <li key={i} className="grid grid-cols-[28px_1fr] gap-[14px] relative pb-5">
            {i < p.steps.length - 1 && <span className="absolute left-[13px] top-[28px] bottom-[2px] w-px bg-line-2" aria-hidden="true" />}
            <span className="w-[28px] h-[28px] rounded-full grid place-items-center bg-surface-2 font-mono text-[11px] text-ink-2">{i + 1}</span>
            <div>
              <p>{s.text}</p>
              <p className="text-[12.5px] text-ink-3 mt-0.5">{[s.at ? `${shortDate(s.at)} ${clock(s.at)}` : "", s.detail].filter(Boolean).join(" · ")}</p>
            </div>
          </li>
        ))}
      </ol>
      <div className="mt-auto flex items-center gap-2 pt-2">
        <LinkBtn href={href(["context", "memories", m.id])}>Open memory</LinkBtn>
      </div>
    </>
  );
}
