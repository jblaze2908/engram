import { useState } from "react";
import type { EntityKind, EntityView, Memory } from "../../../shared/types";
import { api } from "../lib/api";
import { useAreaName, useWho } from "../lib/directory";
import { daysUntil, plural } from "../lib/format";
import { ENTITY_KIND_LABEL, SCOPE_LABEL, titleCase } from "../lib/labels";
import { href } from "../lib/router";
import { useLoad } from "../lib/useLoad";
import { BackLink, Breadcrumb, Card, CardHead, Dot, Empty, ErrorNote, H1, Lede, ListPane, Loading, Main, SearchField, Split } from "../components/ui";
import { sourceShort } from "./Area";

const KINDS = Object.keys(ENTITY_KIND_LABEL) as EntityKind[];

export function People({ id, query }: { id?: string; query: URLSearchParams }) {
  const kindParam = query.get("kind") as EntityKind | null;
  const kind: EntityKind = kindParam && KINDS.includes(kindParam) ? kindParam : "person";
  const [filter, setFilter] = useState("");
  const list = useLoad(() => api.entities(kind), [kind]);
  const plural_ = ENTITY_KIND_LABEL[kind][1];
  const shown = (list.data ?? []).filter((e) => !filter || e.name.toLowerCase().includes(filter.toLowerCase()));
  const listHref = (eid?: string) => href(["context", "people", eid], { kind: kind === "person" ? null : kind });

  return (
    <Split picked={!!id}
      list={
        <ListPane title={plural_}
          top={<SearchField className="mx-1 mt-4" label={`Find ${plural_.toLowerCase()}`} placeholder={`Find ${kind === "person" ? "a person" : `a ${kind}`}`} onChange={setFilter} />}
          foot="Read-only here. Edit the files in the vault.">
          {list.loading && !list.data && <Loading />}
          {list.error && <ErrorNote error={list.error} onRetry={list.reload} />}
          {list.data && list.data.length === 0 && (
            <p className="px-3 text-[13px] text-ink-3 leading-relaxed">No {plural_.toLowerCase()} yet. When a memory names someone, an agent proposes them and they show up here once you accept.</p>
          )}
          {shown.map((e) => (
            <a key={e.id} href={listHref(e.id)} className="it" aria-current={e.id === id ? "true" : undefined}>
              <span className="min-w-0">
                <span className="block">{e.name}</span>
                <span className="block text-[12.5px] text-ink-3 mt-0.5">
                  {[e.summary, plural(e.memories, "memory", "memories"), e.held ? `${e.held} held` : "", e.scope !== "personal" ? e.scope : ""].filter(Boolean).join(" · ")}
                </span>
              </span>
            </a>
          ))}
        </ListPane>
      }
      detail={
        <Main>
          {id ? <EntityDetail id={id} back={listHref()} /> : (
            <Empty title={list.data?.length ? `Pick someone on the left.` : `No ${plural_.toLowerCase()} yet.`}>
              Each one gets a page with what Engram knows about them, where it came from and which agents have read it.
            </Empty>
          )}
        </Main>
      } />
  );
}

function EntityDetail({ id, back }: { id: string; back: string }) {
  const load = useLoad(() => api.entity(id), [id]);
  const areaName = useAreaName();
  if (!load.data) return load.error ? <ErrorNote error={load.error} onRetry={load.reload} /> : <Loading />;
  const v: EntityView = load.data;
  const e = v.entity;
  return (
    <>
      <BackLink href={back} label={ENTITY_KIND_LABEL[e.kind]?.[1] ?? "Back"} />
      <div className="flex items-center justify-between gap-3">
        <Breadcrumb items={[{ label: "Context", href: "#/context" }, { label: areaName(e.area), href: href(["context", "areas", e.area]) }, { label: e.name }]} />
        <span className="text-[13px] text-ink-3">{ENTITY_KIND_LABEL[e.kind]?.[0]} · {SCOPE_LABEL[e.scope].toLowerCase()}</span>
      </div>
      <H1 className="mt-3">{e.name}</H1>
      {e.summary && <Lede>{e.summary}</Lede>}
      {e.held > 0 && (
        <Card hot className="mt-6 px-5 py-3.5 flex items-center gap-3">
          <Dot color="var(--signal)" />
          <p className="flex-1 text-[13.5px]">{e.held === 1 ? "One held proposal is" : `${e.held} held proposals are`} about {e.name}. Nothing here uses {e.held === 1 ? "it" : "them"} until you decide.</p>
          <a className="bt bt-ghost" href="#/inbox">Review</a>
        </Card>
      )}
      <div className="grid grid-cols-1 wide:grid-cols-[1fr_300px] gap-3 mt-3 flex-1 min-h-0">
        <Card className="min-w-0"><Timeline memories={v.memories} /></Card>
        <div className="flex flex-col gap-3">
          <Card>
            <CardHead left="Linked" right={v.linked.length || undefined} />
            {v.linked.length === 0 && <p className="kv"><span>Nothing linked yet.</span><span /></p>}
            {v.linked.map((l) => (
              <a key={`${l.kind}:${l.id}`} href={linkedHref(l.kind, l.id)} className="kv hover:bg-surface-2">
                <span>{titleCase(l.kind)}</span><span>{l.label}</span>
              </a>
            ))}
          </Card>
          <Card>
            <CardHead left="Read this month" right={plural(v.readers.reduce((n, r) => n + r.count, 0), "time")} />
            <Readers readers={v.readers} />
          </Card>
        </div>
      </div>
    </>
  );
}

export function linkedHref(kind: string, id: string): string {
  if (kind === "artifact") return href(["context", "artifacts", id]);
  if (kind === "memory") return href(["context", "memories", id]);
  if (kind === "skill") return href(["skills", id]);
  return href(["context", "people", id]);
}

export function Readers({ readers }: { readers: { agent: string; count: number }[] }) {
  const who = useWho();
  if (readers.length === 0) return <p className="kv"><span>No agent has read this yet.</span><span /></p>;
  return (
    <>
      {readers.map((r) => {
        const w = who(r.agent);
        return (
          <div key={r.agent} className="kv">
            <span className="flex items-center gap-2"><Dot color={w.color} />{w.name}</span>
            <span className="font-mono text-[12.5px]">{r.count}</span>
          </div>
        );
      })}
    </>
  );
}

/** Each memory with a bar for when it holds, on a shared year axis. */
function Timeline({ memories }: { memories: Memory[] }) {
  if (memories.length === 0) return <Empty>No memories about them yet.</Empty>;
  const t = (s: string | null | undefined, fb: number) => (s ? new Date(s).getTime() : fb);
  const spans = memories.map((m) => {
    const from = t(m.valid_from, m.observed_at);
    const to = m.valid_until ? t(m.valid_until, from) : Date.now();
    return { m, from, to: Math.max(to, from) };
  });
  const y0 = new Date(Math.min(...spans.map((s) => s.from))).getFullYear();
  const y1 = Math.max(new Date(Math.max(...spans.map((s) => s.to))).getFullYear(), new Date().getFullYear()) + 1;
  const lo = new Date(y0, 0, 1).getTime();
  const hi = new Date(y1, 0, 1).getTime();
  const years = Array.from({ length: y1 - y0 + 1 }, (_, i) => y0 + i);
  const pct = (x: number) => ((x - lo) / (hi - lo)) * 100;
  return (
    <>
      <div className="grid grid-cols-[1fr_190px] gap-5 items-center px-[18px] pt-[14px] pb-2 max-wide:grid-cols-1">
        <span className="text-[13px] text-ink-3">Memories</span>
        <div className="flex justify-between font-mono text-[10.5px] text-ink-3 max-wide:hidden" aria-hidden="true">{years.map((y) => <span key={y}>{y}</span>)}</div>
      </div>
      {spans.map(({ m, from, to }) => {
        const old = m.status === "superseded" || m.status === "forgotten";
        const soon = m.valid_until && daysUntil(m.valid_until) <= 60 && daysUntil(m.valid_until) >= 0;
        const color = old ? "var(--surface-3)" : soon ? "var(--warn)" : m.status === "held" ? "var(--signal)" : "var(--ink-2)";
        return (
          <a key={m.id} href={href(["context", "memories", m.id])} className="grid grid-cols-1 wide:grid-cols-[1fr_190px] gap-2 wide:gap-5 items-center px-[18px] py-3 border-t border-line hover:bg-surface-2">
            <div className="min-w-0">
              <p className={old ? "text-ink-3 line-through" : ""}>{m.text}</p>
              <p className="text-[12.5px] text-ink-3 mt-0.5">{sourceShort(m)}{m.scope !== "personal" ? ` · ${m.scope}` : ""}</p>
            </div>
            <div className="relative h-[8px] rounded-full bg-surface-2" aria-hidden="true">
              <b className="absolute top-0 h-[8px] rounded-full" style={{ left: `${pct(from)}%`, width: `${Math.max(2, pct(to) - pct(from))}%`, background: color }} />
            </div>
          </a>
        );
      })}
    </>
  );
}
