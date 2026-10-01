import { useState } from "react";
import type { ArtifactKind } from "../../../shared/types";
import { api } from "../lib/api";
import { useApp } from "../lib/app";
import { obsidianUrl } from "../lib/obsidian";
import { useAgentList, useAreaName, useWho } from "../lib/directory";
import { bytes, clock, shortDate } from "../lib/format";
import { ARTIFACT_KIND_LABEL, fileTag, fromLabel, SCOPE_LABEL } from "../lib/labels";
import { href, navigate } from "../lib/router";
import { useLoad } from "../lib/useLoad";
import { BackLink, Breadcrumb, Btn, Card, CardHead, Dot, Empty, ErrorNote, H1, Lede, LinkBtn, ListPane, Loading, Main, Split } from "../components/ui";
import { memoryDot } from "./Memories";

const KINDS = Object.keys(ARTIFACT_KIND_LABEL) as ArtifactKind[];
// The detail page shows the memories a file produced, read in one batch call.
const MAX_MEMORIES = 8;

export function Artifacts({ id, query }: { id?: string; query: URLSearchParams }) {
  const k = query.get("kind") as ArtifactKind | null;
  const kind = k && KINDS.includes(k) ? k : undefined;
  const list = useLoad(() => api.artifacts(kind), [kind]);
  const to = (p: { id?: string; kind?: ArtifactKind | null }) =>
    href(["context", "artifacts", p.id], { kind: p.kind === undefined ? kind : p.kind });

  return (
    <Split picked={!!id}
      list={
        <ListPane width={380} title="Artifacts" sub="Receipts, statements, reports and files agents saved."
          top={
            <div className="flex flex-wrap gap-1.5 mt-4 px-1" role="group" aria-label="Filter by kind">
              <a href={to({ kind: null })} className="fl" aria-pressed={!kind}>All</a>
              {KINDS.map((x) => <a key={x} href={to({ kind: x })} className="fl" aria-pressed={kind === x}>{ARTIFACT_KIND_LABEL[x][1]}</a>)}
            </div>
          }>
          {list.loading && !list.data && <Loading />}
          {list.error && <ErrorNote error={list.error} onRetry={list.reload} />}
          {list.data?.length === 0 && (
            <p className="px-3 text-[13px] text-ink-3 leading-relaxed">
              {kind ? `No ${ARTIFACT_KIND_LABEL[kind][1].toLowerCase()} yet.` : "No files yet. When an agent saves a bill, a statement or a report, Engram keeps a copy that can’t be changed, and it shows up here."}
            </p>
          )}
          {list.data?.map((a) => (
            <a key={a.id} href={to({ id: a.id })} className="it items-center py-2.5" aria-current={a.id === id ? "true" : undefined}>
              <span className="w-[34px] h-[40px] rounded-[7px] flex-none grid place-items-center bg-surface-2 font-mono text-[9.5px] font-medium text-ink-2">{fileTag(a.mime, a.title)}</span>
              <span className="min-w-0">
                <span className="block truncate">{a.title}</span>
                <span className="block text-[12.5px] text-ink-3 mt-0.5 truncate">
                  {[ARTIFACT_KIND_LABEL[a.kind]?.[0], a.source.label, shortDate(a.created_at), a.memories.length ? `${a.memories.length} memories` : ""].filter(Boolean).join(" · ")}
                </span>
              </span>
            </a>
          ))}
        </ListPane>
      }
      detail={
        <Main>
          {id ? <ArtifactDetail id={id} back={to({})} onForgotten={() => { list.reload(); navigate(to({})); }} /> : (
            <Empty title="Pick a file to see it and what came from it.">Each file links to the memories it produced, so you can forget a bad source in one go.</Empty>
          )}
        </Main>
      } />
  );
}

function ArtifactDetail({ id, back, onForgotten }: { id: string; back: string; onForgotten: () => void }) {
  const { notify } = useApp();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const who = useWho();
  const areaName = useAreaName();
  const agents = useAgentList();
  const load = useLoad(async () => {
    const a = await api.artifact(id);
    const memories = a.memories.length ? await api.memoriesByIds(a.memories.slice(0, MAX_MEMORIES)) : [];
    return { a, memories };
  }, [id]);
  if (!load.data) return load.error ? <ErrorNote error={load.error} onRetry={load.reload} /> : <Loading />;
  const { a, memories } = load.data;
  const file = api.artifactFileUrl(a.id);
  const isImage = (a.mime ?? "").startsWith("image/");
  const readers = agents.filter((x) => !x.revoked && x.grants.some((g) => g.scope === a.scope && g.read)).map((x) => x.name);
  const by = a.source.agent ? who(a.source.agent).name : "You";

  async function forget() {
    const n = a.memories.length;
    if (!window.confirm(`Forget this file${n ? ` and the ${n === 1 ? "memory" : `${n} memories`} taken from it` : ""}? Agents stop seeing them. The vault’s git history keeps the copy.`)) return;
    setBusy(true); setError(null);
    try { const r = await api.forgetArtifact(a.id); notify(`Forgot the file${r.memories ? ` and ${r.memories} ${r.memories === 1 ? "memory" : "memories"}` : ""}.`); onForgotten(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); setBusy(false); }
  }

  return (
    <>
      <BackLink href={back} label="Artifacts" />
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <Breadcrumb items={[{ label: "Context", href: "#/context" }, { label: areaName(a.area), href: href(["context", "areas", a.area]) }, { label: a.title }]} />
        <span className="flex gap-2">
          {a.url && /^https?:\/\//.test(a.url) && <LinkBtn href={a.url} target="_blank" rel="noopener noreferrer">Open original</LinkBtn>}
          {a.kept && <LinkBtn href={file} download>Download</LinkBtn>}
        </span>
      </div>
      <H1 className="mt-3">{a.title}</H1>
      <Lede>
        {by} saved it{a.source.kind === "you" ? "" : ` ${fromLabel(a.source).toLowerCase()}`} on {shortDate(a.created_at)}.
        {a.kept ? " Engram keeps a copy that can’t be changed." : " Engram keeps only the reference, not a copy."}
      </Lede>

      <div className="grid grid-cols-1 wide:grid-cols-[300px_1fr] gap-3 mt-7 flex-1 min-h-0">
        <Card className="p-4 flex flex-col min-h-[280px]">
          {a.kept && isImage ? (
            <img src={file} alt={a.title} className="rounded-[6px] w-full h-auto object-contain flex-1 min-h-0" />
          ) : (
            <div className="flex-1 rounded-[6px] bg-surface-2 grid place-items-center text-center p-6">
              <div>
                <p className="font-mono text-[22px] text-ink-2">{fileTag(a.mime, a.title)}</p>
                <p className="text-[12.5px] text-ink-3 mt-2">{a.kept ? <a href={file} target="_blank" rel="noopener" className="text-data hover:underline">Open the file</a> : "No copy kept"}{a.size ? ` · ${bytes(a.size)}` : ""}</p>
              </div>
            </div>
          )}
        </Card>
        <div className="flex flex-col gap-3 min-h-0">
          <Card>
            <CardHead left="Memories from this file" right={a.memories.length || undefined} />
            {memories.length === 0 && <p className="rw text-ink-2">None yet. Memories an agent takes from this file link back to it.</p>}
            {memories.map((m) => (
              <a key={m.id} href={href(["context", "memories", m.id])} className="rw items-start hover:bg-surface-2">
                <Dot color={memoryDot(m, who(m.source.agent).color)} className="mt-[7px]" />
                <div className="flex-1"><p>{m.text}</p><p className="text-[12.5px] text-ink-3 mt-0.5">{m.status === "active" ? (m.accepted_at ? `Accepted ${shortDate(m.accepted_at)}` : "Active") : m.status}</p></div>
              </a>
            ))}
            {a.memories.length > memories.length && <p className="rw text-[12.5px] text-ink-3">and {a.memories.length - memories.length} more</p>}
          </Card>
          <Card>
            <CardHead left="About this file" />
            <div className="kv"><span>From</span><span>{a.source.label}{a.source.at ? ` · ${shortDate(a.source.at)} ${clock(a.source.at)}` : ""}</span></div>
            <div className="kv"><span>Saved by</span><span>{by}</span></div>
            <div className="kv"><span>Kept copy</span><span>{a.kept ? "Yes · can’t be changed" : "No"}</span></div>
            {a.sha256 && <div className="kv"><span>Fingerprint</span><span className="font-mono text-[12px] text-ink-2">sha256 {a.sha256.slice(0, 4)}…{a.sha256.slice(-4)}</span></div>}
            <div className="kv"><span>Scope</span><span>{SCOPE_LABEL[a.scope]}</span></div>
            <div className="kv"><span>Who can see it</span><span>{a.scope === "private" ? "Only you" : readers.length ? readers.join(", ") : "No agent yet"}</span></div>
          </Card>
          {error && <p role="alert" className="text-[13px] text-bad">{error}</p>}
          <div className="wide:mt-auto flex items-center gap-2 flex-wrap">
            <LinkBtn href={href(["trace"], { q: a.id })}>See trace</LinkBtn>
            {a.path && <LinkBtn kind="quiet" href={obsidianUrl(a.path)}>Open in Obsidian</LinkBtn>}
            <Btn kind="quiet" className="ml-auto" disabled={busy} onClick={forget}>Forget this file and its memories</Btn>
          </div>
        </div>
      </div>
    </>
  );
}
