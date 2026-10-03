import { useRef, useState } from "react";
import { SCOPES, type Artifact, type ArtifactFilter, type ArtifactKind, type ArtifactType } from "../../../shared/types";
import { api } from "../lib/api";
import { useApp } from "../lib/app";
import { obsidianUrl } from "../lib/obsidian";
import { useAgentList, useAreaList, useAreaName, useWho } from "../lib/directory";
import { bytes, clock, shortDate } from "../lib/format";
import { ARTIFACT_KIND_LABEL, fileTag, fromLabel, SCOPE_LABEL } from "../lib/labels";
import { href, navigate, replace } from "../lib/router";
import { useLoad } from "../lib/useLoad";
import { BackLink, Breadcrumb, Btn, Card, CardHead, cx, Dot, Empty, ErrorNote, H1, Lede, LinkBtn, ListPane, Loading, Main, SearchField, Split } from "../components/ui";
import { memoryDot } from "./Memories";

const KINDS = Object.keys(ARTIFACT_KIND_LABEL) as ArtifactKind[];
// The detail page shows the memories a file produced, read in one batch call.
const MAX_MEMORIES = 8;

const MAX_FILE = 10 << 20;
// The file's bytes as base64, for the JSON upload (10 MB at most, so this stays in memory comfortably).
const base64Of = (f: File) => new Promise<string>((ok, fail) => {
  const r = new FileReader();
  r.onload = () => ok(String(r.result).split(",")[1] ?? "");
  r.onerror = () => fail(r.error);
  r.readAsDataURL(f);
});

const TYPES: [ArtifactType, string][] = [["page", "Pages"], ["pdf", "PDFs"], ["image", "Images"], ["other", "Other files"]];
const STATUS: [NonNullable<ArtifactFilter["status"]>, string][] = [["public", "Anyone with the link"], ["private", "Only you"], ["waiting", "Waiting for you to share"]];
const FILTERS = ["q", "by", "status", "kind", "type", "scope", "area"] as const;
type Filters = Partial<Record<(typeof FILTERS)[number], string>>;

/** A filter pill that names what it filters ("Kind  Any"). The pill is drawn here and sized to its text; a transparent
 * native select on top keeps the browser's own menu and keyboard handling. */
function Pick({ label, value, onChange, all, options }: { label: string; value?: string; onChange: (v: string | null) => void; all: string; options: [string, string][] }) {
  const shown = options.find(([v]) => v === value)?.[1] ?? all;
  return (
    <label className={cx("relative inline-flex items-center gap-1.5 h-[30px] pl-3 pr-2.5 rounded-full text-[12.5px] border max-w-full focus-within:border-ink-2",
      value ? "border-ink-3 text-ink" : "border-line text-ink-2")}>
      <span className="text-ink-3 flex-none">{label}</span>
      <span className="truncate">{shown}</span>
      <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" className="flex-none text-ink-3"><path d="M2.5 4.5 6 8l3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
      <select value={value ?? ""} onChange={(e) => onChange(e.target.value || null)} aria-label={label}
        className="absolute inset-0 w-full h-full opacity-0 cursor-pointer">
        <option value="">{all}</option>
        {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
    </label>
  );
}

export function Artifacts({ id, query }: { id?: string; query: URLSearchParams }) {
  const f: Filters = Object.fromEntries(FILTERS.map((k) => [k, query.get(k) || undefined]).filter(([, v]) => v));
  const key = JSON.stringify(f);
  // The first page follows the filters; "Show more" appends pages until the filters change. The old list stays up while
  // a new one loads (useLoad keeps data), so typing never blanks or jumps it.
  const list = useLoad(() => api.artifacts(f), [key]);
  const [more, setMore] = useState<{ key: string; items: Artifact[]; next: string | null }>({ key: "", items: [], next: null });
  const [loadingMore, setLoadingMore] = useState(false);
  const extra = more.key === key ? more : { key, items: [], next: list.data?.next ?? null };
  const first = list.data?.artifacts ?? [], seen = new Set(first.map((a) => a.id));
  const items = [...first, ...extra.items.filter((a) => !seen.has(a.id))];
  const next = extra.items.length ? extra.next : list.data?.next ?? null;
  const areas = useAreaList();
  const { notify } = useApp();
  const pick = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  const to = (p: { id?: string | null } & Filters = {}) => {
    const q: Record<string, string | undefined> = { ...f };
    for (const k of FILTERS) if (k in p) q[k] = (p as Filters)[k] || undefined;
    return href(["context", "artifacts", p.id === undefined ? id : p.id ?? undefined], q);
  };
  const set = (k: (typeof FILTERS)[number], v: string | null) => navigate(to({ [k]: v ?? undefined }));
  const typing = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  async function showMore() {
    if (!next) return;
    setLoadingMore(true);
    try {
      const r = await api.artifacts({ ...f, cursor: next });
      setMore({ key, items: [...extra.items, ...r.artifacts], next: r.next });
    } catch (e) { notify(e instanceof Error ? e.message : String(e)); } finally { setLoadingMore(false); }
  }

  async function upload(file: File | undefined) {
    if (!file) return;
    if (file.size > MAX_FILE) return notify("Files must be under 10 MB.");
    setUploading(true);
    try {
      const r = await api.publishArtifact({ title: file.name.replace(/\.[^.]+$/, "") || file.name, filename: file.name, content_base64: await base64Of(file) });
      notify("Published. Only you can open it until you make a link.");
      list.reload(); navigate(to({ id: r.id }));
    } catch (e) { notify(e instanceof Error ? e.message : String(e)); }
    finally { setUploading(false); if (pick.current) pick.current.value = ""; }
  }

  const d = list.data, filtering = FILTERS.some((k) => f[k]);
  const pubs = d?.publishers ?? [];
  return (
    <Split picked={!!id}
      list={
        <ListPane width={400} title="Artifacts"
          sub={d ? `${d.counts.all} files · ${d.counts.public} open to anyone with the link${d.counts.waiting ? ` · ${d.counts.waiting} waiting for you` : ""}` : "Files you and your agents published. Only you can open them until you share the link."}
          top={
            <>
              <div className="flex gap-2 mt-4 px-1">
                <SearchField className="flex-1 h-[36px]" label="Search titles and file contents" placeholder="Search titles and contents"
                  value={f.q ?? ""} onSubmit={(q) => replace(to({ q }))}
                  onChange={(q) => { clearTimeout(typing.current); typing.current = setTimeout(() => replace(to({ q })), 250); }} />
                <input ref={pick} type="file" className="hidden" onChange={(e) => upload(e.target.files?.[0])} />
                <Btn disabled={uploading} onClick={() => pick.current?.click()}>{uploading ? "Publishing…" : "Publish"}</Btn>
              </div>
              <div className="flex flex-wrap gap-1.5 mt-3 px-1" role="group" aria-label="Filters">
                <Pick label="Published by" all="Anyone" value={f.by} onChange={(v) => set("by", v)} options={pubs.map((p) => [p.key, `${p.label} (${p.n})`])} />
                <Pick label="Who can open" all="Any" value={f.status} onChange={(v) => set("status", v)} options={STATUS} />
                <Pick label="Kind" all="Any" value={f.kind} onChange={(v) => set("kind", v)} options={KINDS.map((k) => [k, ARTIFACT_KIND_LABEL[k][1]])} />
                <Pick label="File type" all="Any" value={f.type} onChange={(v) => set("type", v)} options={TYPES} />
                <Pick label="Scope" all="Any" value={f.scope} onChange={(v) => set("scope", v)} options={SCOPES.map((s) => [s, SCOPE_LABEL[s]])} />
                <Pick label="Area" all="Any" value={f.area} onChange={(v) => set("area", v)} options={areas.map((a) => [a.slug, a.name])} />
              </div>
              {d && filtering && (
                <p className="mt-3 px-3 text-[12.5px] text-ink-3 flex items-center gap-2" aria-live="polite">
                  {d.total} {d.total === 1 ? "match" : "matches"}{list.loading ? " · searching…" : ""}
                  <a href={href(["context", "artifacts", id])} className="ml-auto text-data hover:underline">Clear filters</a>
                </p>
              )}
            </>
          }>
          {list.loading && !d && <Loading />}
          {list.error && <ErrorNote error={list.error} onRetry={list.reload} />}
          {d && items.length === 0 && (
            <p className="px-3 text-[13px] text-ink-3 leading-relaxed">
              {filtering ? "Nothing matches. Try fewer filters or other words." : "Nothing published yet. When you or an agent publishes a page, a document or a receipt, it shows up here with its own link."}
            </p>
          )}
          <div className={cx("flex flex-col gap-0.5 transition-opacity", list.loading && d && "opacity-60")}>
            {items.map((a) => (
              <a key={a.id} href={to({ id: a.id })} className="it items-center py-2.5" aria-current={a.id === id ? "true" : undefined}>
                <span className="w-[34px] h-[40px] rounded-[7px] flex-none grid place-items-center bg-surface-2 font-mono text-[9.5px] font-medium text-ink-2">{fileTag(a.mime ?? a.versions?.at(-1)?.mime, a.title)}</span>
                <span className="min-w-0">
                  <span className="block truncate">{a.title}</span>
                  <span className="block text-[12.5px] text-ink-3 mt-0.5 truncate">
                    {[a.public_url ? "Anyone with link" : "", ARTIFACT_KIND_LABEL[a.kind as ArtifactKind]?.[0] ?? a.kind, a.source.label, shortDate(a.updated_at ?? a.created_at), a.version > 1 ? `v${a.version}` : "", a.memories.length ? `${a.memories.length} memories` : ""].filter(Boolean).join(" · ")}
                  </span>
                </span>
              </a>
            ))}
            {next && <Btn className="mt-2 self-start ml-2" disabled={loadingMore} onClick={showMore}>{loadingMore ? "Loading…" : "Show more"}</Btn>}
          </div>
        </ListPane>
      }
      detail={
        <Main>
          {id ? <ArtifactDetail id={id} back={to({ id: null })} onForgotten={() => { list.reload(); navigate(to({ id: null })); }} /> : (
            <Empty title="Pick a file to open it, share it or see its versions.">Every artifact has one link. Only you can open it, until you let anyone with the link.</Empty>
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
  const readers = agents.filter((x) => !x.revoked && x.grants.some((g) => g.scope === a.scope && g.read)).map((x) => x.name);
  const by = a.source.agent ? who(a.source.agent).name : "You";

  async function copy(url: string, what: string) {
    try { await navigator.clipboard.writeText(url); notify(`Copied the ${what}.`); } catch { notify(url); }
  }
  async function act(fn: () => Promise<unknown>, done: string) {
    setBusy(true); setError(null);
    try { await fn(); notify(done); load.reload(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }
  function setAccess(anyone: boolean) {
    if (anyone === !!a.public_url) return;
    if (anyone && !window.confirm("Let anyone with the link open this file, without signing in? The link stays the same, so anyone you already sent it to can open it now.")) return;
    void act(() => anyone ? api.shareArtifact(a.id) : api.unshareArtifact(a.id), anyone ? "Anyone with the link can open it." : "Only you can open it now. The link is the same.");
  }
  function reset() {
    if (!window.confirm("Make a new link? The current one stops working for everyone, straight away. Who can open it stays as it is.")) return;
    void act(async () => { const r = await api.resetArtifactLink(a.id); await navigator.clipboard?.writeText(r.url).catch(() => {}); }, "New link made and copied. The old one no longer works.");
  }

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
        <span className="flex gap-2 flex-wrap">
          {a.kept && <LinkBtn kind="primary" href={api.artifactOpenUrl(a.id)} target="_blank" rel="noopener">Open</LinkBtn>}
          <Btn onClick={() => copy(a.url, "link")}>Copy link</Btn>
          {a.kept && <LinkBtn href={api.artifactFileUrl(a.id)} download>Download</LinkBtn>}
        </span>
      </div>
      <H1 className="mt-3">{a.title}</H1>
      <Lede>
        {by} published it{a.source.kind === "you" || a.source.kind === "agent" ? "" : ` ${fromLabel(a.source).toLowerCase()}`} on {shortDate(a.created_at)}{a.version > 1 ? `; this is version ${a.version}` : ""}.
        {a.public_url ? " Anyone with its link can open it." : " Only you can open it."}
      </Lede>

      <div className="grid grid-cols-1 wide:grid-cols-[minmax(0,1fr)_320px] gap-3 mt-7 items-start">
        <div className="flex flex-col gap-3 min-w-0">
          <Card>
            <CardHead left="Link" right={a.public_url ? "Anyone with it" : "Only you"} />
            <div className="rw">
              <span className="flex-1 min-w-0 truncate font-mono text-[12.5px] text-ink-2" title={a.url}>{a.url}</span>
              <Btn onClick={() => copy(a.url, "link")}>Copy</Btn>
            </div>
            <div className="rw !items-stretch flex-col !gap-3" role="radiogroup" aria-label="Who can open it">
              {([[false, "Only you", "Opens after you sign in to Engram"], [true, "Anyone with the link", "No sign-in. Turn it off any time; the link stays the same"]] as const).map(([anyone, label, hint]) => (
                <label key={label} className="flex items-start gap-3 cursor-pointer">
                  <input type="radio" name={`access-${a.id}`} className="accent-[var(--ink)] mt-[4px] flex-none" checked={!!a.public_url === anyone} disabled={busy || (anyone && !a.kept)} onChange={() => setAccess(anyone)} />
                  <span className="min-w-0"><span className="block">{label}</span><span className="block text-[12.5px] text-ink-3">{hint}</span></span>
                </label>
              ))}
            </div>
            <div className="rw justify-between">
              <span className="text-[12.5px] text-ink-3">Sent it somewhere it shouldn't be?</span>
              <Btn kind="quiet" disabled={busy} onClick={reset}>Reset link</Btn>
            </div>
          </Card>
          <Card>
            <CardHead left="Versions" right={a.versions.length || undefined} />
            {[...a.versions].reverse().map((v) => (
              <div key={v.v} className="rw">
                <span className="font-mono text-[12px] text-ink-3 w-8 flex-none">v{v.v}</span>
                <span className="flex-1 min-w-0 truncate text-[13px]">{shortDate(v.at)} {clock(v.at)} · {v.by}{v.size ? ` · ${bytes(v.size)}` : ""}</span>
                <a className="text-data text-[13px] hover:underline flex-none" href={api.artifactOpenUrl(a.id, v.v)} target="_blank" rel="noopener">Open</a>
              </div>
            ))}
          </Card>
          <Card>
            <CardHead left="Memories from this file" right={a.memories.length || undefined} />
            {memories.length === 0 && <p className="rw text-ink-2">None yet. Memories an agent takes from this file link back to it.</p>}
            {memories.map((m) => (
              <a key={m.id} href={href(["context", "memories", m.id])} className="rw !items-start hover:bg-surface-2">
                <Dot color={memoryDot(m, who(m.source.agent).color)} className="mt-[7px]" />
                <div className="flex-1"><p>{m.text}</p><p className="text-[12.5px] text-ink-3 mt-0.5">{m.status === "active" ? (m.accepted_at ? `Accepted ${shortDate(m.accepted_at)}` : "Active") : m.status}</p></div>
              </a>
            ))}
            {a.memories.length > memories.length && <p className="rw text-[12.5px] text-ink-3">and {a.memories.length - memories.length} more</p>}
          </Card>
        </div>
        <div className="flex flex-col gap-3 min-w-0">
          <Card>
            <CardHead left="About this file" />
            <div className="kv"><span>File</span><span>{fileTag(a.mime, a.title)}{a.size ? ` · ${bytes(a.size)}` : ""}{a.kept ? "" : " · missing"}</span></div>
            <div className="kv"><span>From</span><span>{a.source.label}{a.source.at ? ` · ${shortDate(a.source.at)} ${clock(a.source.at)}` : ""}</span></div>
            <div className="kv"><span>Saved by</span><span>{by}</span></div>
            <div className="kv"><span>Version</span><span>{a.version || "none"}{a.mime ? ` · ${a.mime}` : ""}</span></div>
            {a.sha256 && <div className="kv"><span>Fingerprint</span><span className="font-mono text-[12px] text-ink-2">{a.sha256.slice(0, 4)}…{a.sha256.slice(-4)}</span></div>}
            <div className="kv"><span>Scope</span><span>{SCOPE_LABEL[a.scope]}</span></div>
            <div className="kv"><span>Agents who can find it</span><span>{a.scope === "private" ? "None" : readers.length ? readers.join(", ") : "No agent yet"}</span></div>
          </Card>
          {error && <p role="alert" className="text-[13px] text-bad">{error}</p>}
          <Card>
            <a className="rw border-t-0 hover:bg-surface-2" href={href(["trace"], { q: a.id })}>See its trace</a>
            {a.path && <a className="rw hover:bg-surface-2" href={obsidianUrl(a.path)}>Open in Obsidian</a>}
            <button type="button" className="rw w-full text-left text-bad hover:bg-surface-2 disabled:opacity-50" disabled={busy} onClick={forget}>Forget this file and its memories</button>
          </Card>
        </div>
      </div>
    </>
  );
}
