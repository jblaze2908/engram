import { useState } from "react";
import type { Memory, MemoryStatus } from "../../../shared/types";
import { api } from "../lib/api";
import { useApp } from "../lib/app";
import { useAgentList, useAreaName, useWho } from "../lib/directory";
import { clock, daysUntil, shortDate, untilLabel } from "../lib/format";
import { fromLabel, SCOPE_LABEL } from "../lib/labels";
import { href, navigate } from "../lib/router";
import { useLoad } from "../lib/useLoad";
import { BackLink, Breadcrumb, Btn, Card, CardHead, Dot, Empty, ErrorNote, H1, Lede, LinkBtn, ListPane, Loading, Main, SearchField, Split } from "../components/ui";

type Filter = "all" | "held" | "soon" | "superseded" | "forgotten";
const FILTERS: [Filter, string][] = [["all", "All"], ["held", "Held"], ["soon", "Running out"], ["superseded", "Replaced"], ["forgotten", "Forgotten"]];
const SOON_DAYS = 30;

const runningOut = (m: Memory) => m.status === "active" && !!m.valid_until && daysUntil(m.valid_until) <= SOON_DAYS;

export function memoryDot(m: Memory, hue: string): string {
  if (m.status === "held") return "var(--signal)";
  if (runningOut(m)) return "var(--warn)";
  if (m.status !== "active") return "var(--ink-3)";
  return hue;
}

export function Memories({ id, query }: { id?: string; query: URLSearchParams }) {
  const q = query.get("q") ?? "";
  const area = query.get("area") ?? "";
  const f = (query.get("f") as Filter | null) ?? "all";
  const status: MemoryStatus | undefined = f === "held" || f === "superseded" || f === "forgotten" ? f : f === "soon" ? "active" : undefined;
  const list = useLoad(() => api.memories({ status, area: area || undefined, q: q || undefined }), [status, area, q]);
  const who = useWho();
  const areaName = useAreaName();
  const shown = (list.data ?? []).filter((m) => f !== "soon" || runningOut(m));
  const to = (p: { id?: string; q?: string; f?: Filter; area?: string }) =>
    href(["context", "memories", p.id], { q: p.q ?? q, f: (p.f ?? f) === "all" ? null : p.f ?? f, area: p.area ?? area });

  return (
    <Split picked={!!id}
      list={
        <ListPane width={380} title="Memories" sub={area ? <>In {areaName(area)} · <a className="hover:text-ink-2 underline" href={to({ area: "" })}>show all areas</a></> : undefined}
          top={<>
            <SearchField className="mx-1 mt-4" label="Find a memory" placeholder="Find a memory" value={q} onSubmit={(nq) => navigate(to({ q: nq, id: undefined }))} />
            <div className="flex flex-wrap gap-1.5 mt-3 px-1" role="group" aria-label="Filter">
              {FILTERS.map(([k, label]) => (
                <a key={k} href={to({ f: k, id: undefined })} className="fl" aria-pressed={f === k}>{label}</a>
              ))}
            </div>
          </>}>
          {list.loading && !list.data && <Loading />}
          {list.error && <ErrorNote error={list.error} onRetry={list.reload} />}
          {list.data && shown.length === 0 && (
            <p className="px-3 text-[13px] text-ink-3 leading-relaxed">
              {q ? `Nothing matches “${q}”.` : f === "all" ? "No memories yet. Add one yourself, or accept what an agent proposes, and it shows up here." : "None right now."}
            </p>
          )}
          {shown.map((m) => {
            const w = who(m.source.agent ?? (m.source.kind === "you" ? "you" : null));
            return (
              <a key={m.id} href={to({ id: m.id })} className="it" aria-current={m.id === id ? "true" : undefined}>
                <Dot color={memoryDot(m, w.color)} className="mt-[7px]" />
                <span className="min-w-0">
                  <span className={`block truncate ${m.status === "active" || m.status === "held" ? "" : "text-ink-3"}`}>{m.text}</span>
                  <span className="block text-[12.5px] text-ink-3 mt-0.5 truncate">
                    {m.status === "held" ? `Held · ${fromLabel(m.source).toLowerCase()}`
                      : m.status === "superseded" ? `Replaced · ${m.source.label}`
                      : m.status === "forgotten" ? "Forgotten"
                      : `${m.source.label} · ${m.valid_until ? untilLabel(m.valid_until) : shortDate(m.observed_at)}`}
                  </span>
                </span>
              </a>
            );
          })}
        </ListPane>
      }
      detail={
        <Main>
          {id ? <MemoryDetail id={id} back={to({ id: undefined })} onChanged={list.reload} /> : (
            <Empty title="Pick a memory to see where it came from.">
              Every memory is one claim, with a source and a window when it holds. Corrections replace; nothing is silently deleted.
            </Empty>
          )}
        </Main>
      } />
  );
}

function MemoryDetail({ id, back, onChanged }: { id: string; back: string; onChanged: () => void }) {
  const { notify } = useApp();
  const who = useWho();
  const areaName = useAreaName();
  const agents = useAgentList();
  const load = useLoad(async () => {
    const m = await api.memory(id);
    const before = m.supersedes ? await api.memory(m.supersedes).catch(() => null) : null;
    return { m, before };
  }, [id]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!load.data) return load.error ? <ErrorNote error={load.error} onRetry={load.reload} /> : <Loading />;
  const { m, before } = load.data;
  const readers = agents.filter((a) => !a.revoked && a.grants.some((g) => g.scope === m.scope && g.read));
  const blind = agents.filter((a) => !a.revoked && !readers.includes(a));

  async function forget() {
    if (!window.confirm("Forget this memory? Agents stop seeing it. The file stays in the vault marked forgotten, and the trace keeps a record.")) return;
    setBusy(true); setError(null);
    try {
      await api.forgetMemory(m.id);
      notify("Forgotten.");
      load.reload();
      onChanged();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  }

  const status = { active: "active", superseded: "replaced", held: "held", forgotten: "forgotten" }[m.status];
  return (
    <>
      <BackLink href={back} label="Memories" />
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <Breadcrumb items={[{ label: "Context", href: "#/context" }, { label: areaName(m.area), href: href(["context", "areas", m.area]) }, { label: "Memory" }]} />
        <span className="text-[13px] text-ink-3">{SCOPE_LABEL[m.scope]} · {status}</span>
      </div>
      <H1 className={`mt-3 ${m.status === "active" || m.status === "held" ? "" : "text-ink-2"}`}>{m.text}</H1>
      <Lede>
        {m.valid_until ? `Good until ${shortDate(m.valid_until)}${daysUntil(m.valid_until) >= 0 ? ` (${untilLabel(m.valid_until)})` : ""}.` : "No end date; it holds until something replaces it."}
        {m.superseded_by ? " A newer memory has replaced it." : ""}
      </Lede>

      {before && (
        <Card className="grid grid-cols-2 mt-7">
          <div className="p-6">
            <p className="text-[12.5px] text-ink-3">Before</p>
            <p className="text-[20px] font-semibold mt-2 text-ink-2 leading-snug">{before.text}</p>
            <p className="text-[13px] text-ink-3 mt-2">{before.source.label}</p>
          </div>
          <div className="p-6 border-l border-line">
            <p className="text-[12.5px] text-ink-3">Now</p>
            <p className="text-[20px] font-semibold mt-2 leading-snug">{m.text}</p>
            <p className="text-[13px] text-ink-3 mt-2">{m.source.label}</p>
          </div>
        </Card>
      )}

      <div className="grid grid-cols-1 wide:grid-cols-[1fr_320px] gap-3 mt-3">
        <Card>
          <CardHead left="Came from" right={<a className="hover:text-ink-2" href={href(["trace"], { id: m.id })}>See trace</a>} />
          <div className="kv"><span>Source</span><span>{m.source.label}</span></div>
          <div className="kv"><span>Kind</span><span>{fromLabel(m.source)}{m.trust === "untrusted" ? " · untrusted" : ""}</span></div>
          {m.source.agent && <div className="kv"><span>Proposed by</span><span>{who(m.source.agent).name}</span></div>}
          {m.source.ref && <div className="kv"><span>Reference</span><span className="font-mono text-[12px] text-ink-2">{m.source.ref}</span></div>}
          <div className="kv"><span>Observed</span><span>{shortDate(m.observed_at)} {clock(m.observed_at)}</span></div>
          {m.accepted_at && <div className="kv"><span>Accepted</span><span>{shortDate(m.accepted_at)} {clock(m.accepted_at)}</span></div>}
        </Card>
        <Card>
          <CardHead left="Who can see it" right={m.scope} />
          {m.scope === "private" ? <div className="kv"><span>Only you</span><span>private is never granted</span></div> : <>
            {readers.length === 0 && <div className="kv"><span>No agent has a {m.scope} grant</span><span /></div>}
            {readers.map((a) => (
              <div key={a.id} className="kv"><span className="flex items-center gap-2"><Dot color={who(a.id).color} />{a.name}</span><span>can read</span></div>
            ))}
            {blind.length > 0 && <div className="kv"><span>{blind.map((a) => a.name).join(", ")}</span><span className="text-ink-3">no grant</span></div>}
          </>}
          <div className="kv"><span>Read</span><span>{m.reads} {m.reads === 1 ? "time" : "times"}</span></div>
        </Card>
      </div>

      {error && <p role="alert" className="text-[13px] text-bad mt-5">{error}</p>}
      <div className="mt-7 flex items-center gap-2 flex-wrap">
        <LinkBtn href={href(["trace"], { id: m.id })}>Where it came from</LinkBtn>
        {m.status !== "forgotten" && <Btn kind="quiet" disabled={busy} onClick={forget}>Forget</Btn>}
        <span className="ml-auto text-[12.5px] text-ink-3">Forgetting keeps a record in the trace; nothing is silently deleted.</span>
      </div>
    </>
  );
}
