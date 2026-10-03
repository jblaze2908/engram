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
const STATUS: [NonNullable<ArtifactFilter["status"]>, string][] = [["public", "Public link"], ["waiting", "Link waiting for you"], ["private", "Private only"]];
const FILTERS = ["q", "by", "status", "kind", "type", "scope", "area"] as const;
type Filters = Partial<Record<(typeof FILTERS)[number], string>>;

/** A filter select sized to its content, styled like Trace's. */
function Pick({ label, value, onChange, all, options }: { label: string; value?: string; onChange: (v: string | null) => void; all: string; options: [string, string][] }) {
  return (
    <label className="contents">
      <span className="sr-only">{label}</span>
      <select value={value ?? ""} onChange={(e) => onChange(e.target.value || null)} aria-label={label}
        className={cx("h-[30px] px-3 rounded-full text-[12.5px] bg-transparent border max-w-full", value ? "border-ink-3 text-ink" : "border-line text-ink-2")}>
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
          sub={d ? `${d.counts.all} files · ${d.counts.public} with a public link${d.counts.waiting ? ` · ${d.counts.waiting} waiting for you` : ""}` : "Files you and your agents published. Private until you make a link."}
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
                <Pick label="Link" all="Any link" value={f.status} onChange={(v) => set("status", v)} options={STATUS} />
                <Pick label="Kind" all="Any kind" value={f.kind} onChange={(v) => set("kind", v)} options={KINDS.map((k) => [k, ARTIFACT_KIND_LABEL[k][1]])} />
                <Pick label="File type" all="Any type" value={f.type} onChange={(v) => set("type", v)} options={TYPES} />
                <Pick label="Scope" all="Any scope" value={f.scope} onChange={(v) => set("scope", v)} options={SCOPES.map((s) => [s, SCOPE_LABEL[s]])} />
                <Pick label="Area" all="Any area" value={f.area} onChange={(v) => set("area", v)} options={areas.map((a) => [a.slug, a.name])} />
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
              {filtering ? "Nothing matches. Try fewer filters or other words." : "Nothing published yet. When you or an agent publishes a page, a document or a receipt, it shows up here with its own private link."}
            </p>
          )}
          <div className={cx("flex flex-col gap-0.5 transition-opacity", list.loading && d && "opacity-60")}>
            {items.map((a) => (
              <a key={a.id} href={to({ id: a.id })} className="it items-center py-2.5" aria-current={a.id === id ? "true" : undefined}>
                <span className="w-[34px] h-[40px] rounded-[7px] flex-none grid place-items-center bg-surface-2 font-mono text-[9.5px] font-medium text-ink-2">{fileTag(a.mime ?? a.versions?.at(-1)?.mime, a.title)}</span>
                <span className="min-w-0">
                  <span className="block truncate">{a.title}</span>
                  <span className="block text-[12.5px] text-ink-3 mt-0.5 truncate">
                    {[a.public_url ? "Public link" : "", ARTIFACT_KIND_LABEL[a.kind as ArtifactKind]?.[0] ?? a.kind, a.source.label, shortDate(a.updated_at ?? a.created_at), a.version > 1 ? `v${a.version}` : "", a.memories.length ? `${a.memories.length} memories` : ""].filter(Boolean).join(" · ")}
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
            <Empty title="Pick a file to open it, share it or see its versions.">Every artifact is private: only you can open it, until you make a public link.</Empty>
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
  async function makePublic() {
    if (!window.confirm("Make a public link? Anyone who has it can open this file, without signing in. You can turn it off any time.")) return;
    setBusy(true); setError(null);
    try { const r = await api.shareArtifact(a.id); await copy(r.public_url, "public link"); load.reload(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }
  async function makePrivate() {
    setBusy(true); setError(null);
    try { await api.unshareArtifact(a.id); notify("The public link is off. Making a new one gives a different link."); load.reload(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
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
          <Btn onClick={() => copy(a.url, "private link")}>Copy link</Btn>
          {a.kept && <LinkBtn href={api.artifactFileUrl(a.id)} download>Download</LinkBtn>}
        </span>
      </div>
      <H1 className="mt-3">{a.title}</H1>
      <Lede>
        {by} published it{a.source.kind === "you" || a.source.kind === "agent" ? "" : ` ${fromLabel(a.source).toLowerCase()}`} on {shortDate(a.created_at)}{a.version > 1 ? `; this is version ${a.version}` : ""}.
        {a.public_url ? " Anyone with the public link can open it." : " Only you can open it."}
      </Lede>

      <div className="grid grid-cols-1 wide:grid-cols-[300px_1fr] gap-3 mt-7 flex-1 min-h-0">
        <div className="flex flex-col gap-3">
          <Card className="p-4 flex flex-col min-h-[200px]">
            <div className="flex-1 rounded-[6px] bg-surface-2 grid place-items-center text-center p-6">
              <div>
                <p className="font-mono text-[22px] text-ink-2">{fileTag(a.mime, a.title)}</p>
                <p className="text-[12.5px] text-ink-3 mt-2">{a.kept ? <a href={api.artifactOpenUrl(a.id)} target="_blank" rel="noopener" className="text-data hover:underline">Open it</a> : "The file is missing"}{a.size ? ` · ${bytes(a.size)}` : ""}</p>
              </div>
            </div>
          </Card>
          <Card>
            <CardHead left="Public link" right={a.public_url ? "On" : "Off"} />
            {a.public_url ? (
              <>
                <p className="rw font-mono text-[12px] text-ink-2 break-all">{a.public_url}</p>
                <div className="rw flex gap-2 flex-wrap">
                  <Btn onClick={() => copy(a.public_url!, "public link")}>Copy</Btn>
                  <Btn kind="quiet" disabled={busy} onClick={makePrivate}>Turn off</Btn>
                </div>
              </>
            ) : (
              <div className="rw flex items-center justify-between gap-3 flex-wrap">
                <span className="text-ink-2">Private. Only you can open it.</span>
                <Btn disabled={busy || !a.kept} onClick={makePublic}>Make a public link</Btn>
              </div>
            )}
          </Card>
          <Card>
            <CardHead left="Versions" right={a.versions.length || undefined} />
            {[...a.versions].reverse().map((v) => (
              <div key={v.v} className="rw items-center">
                <span className="font-mono text-[12px] text-ink-3 w-8">v{v.v}</span>
                <span className="flex-1 text-[13px]">{shortDate(v.at)} {clock(v.at)} · {v.by}{v.size ? ` · ${bytes(v.size)}` : ""}</span>
                <a className="text-data text-[13px] hover:underline" href={api.artifactOpenUrl(a.id, v.v)} target="_blank" rel="noopener">Open</a>
              </div>
            ))}
          </Card>
        </div>
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
            <div className="kv"><span>Version</span><span>{a.version || "none"}{a.mime ? ` · ${a.mime}` : ""}</span></div>
            {a.sha256 && <div className="kv"><span>Fingerprint</span><span className="font-mono text-[12px] text-ink-2">sha256 {a.sha256.slice(0, 4)}…{a.sha256.slice(-4)}</span></div>}
            <div className="kv"><span>Scope</span><span>{SCOPE_LABEL[a.scope]}</span></div>
            <div className="kv"><span>Agents who can find it</span><span>{a.scope === "private" ? "None" : readers.length ? readers.join(", ") : "No agent yet"}</span></div>
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
