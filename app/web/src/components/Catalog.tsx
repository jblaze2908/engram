import { useEffect, useRef, useState, type FormEvent } from "react";
import type { CatalogEntry, ConnectionAuth, ConnectResult } from "../../../shared/types";
import { api } from "../lib/api";
import { Btn, cx, Toggle } from "./ui";

/** Mirrors the server's id for a manual add: slugify(name), cut to 12 (routes/gateway.ts). */
const slugId = (n: string) => (n.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "untitled").slice(0, 12).replace(/-+$/, "");

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const HOW: Record<ConnectionAuth, string> = { oauth: "Sign in", bearer: "Token", none: "No sign-in" };

/** "Add from catalog": hand-picked servers; the MCP Registry (thousands, unreviewed) only when you ask. Typing is debounced; search runs on Engram's daily copy. */
export function AddFromCatalog({ open, onClose, onAdded }: { open: boolean; onClose: () => void; onAdded: (r: ConnectResult) => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [q, setQ] = useState("");
  const [list, setList] = useState<CatalogEntry[] | null>(null);
  const [picked, setPicked] = useState<CatalogEntry | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [community, setCommunity] = useState(false);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) { setQ(""); setPicked(null); setError(null); setCommunity(false); d.showModal(); }
    else if (!open && d.open) d.close();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    let live = true;
    const t = setTimeout(() => api.catalog(q.trim(), community).then((r) => { if (live) { setList(r); setError(null); } }, (e) => { if (live) setError(errText(e)); }), q.trim() ? 400 : 0);
    return () => { live = false; clearTimeout(t); };
  }, [q, open, community]);

  const curated = (list ?? []).filter((e) => e.source === "curated"), registry = (list ?? []).filter((e) => e.source === "registry");
  return (
    <dialog ref={ref} onClose={onClose} aria-labelledby="cat-title"
      className="m-auto w-[min(620px,calc(100vw-32px))] max-h-[min(720px,calc(100vh-48px))] rounded-[14px] bg-surface border border-line text-ink p-0 backdrop:bg-black/50">
      {picked ? <Connect e={picked} onBack={() => setPicked(null)} onAdded={onAdded} /> : (
        <div className="p-6 flex flex-col gap-4">
          <div>
            <h2 id="cat-title" className="text-[20px] font-semibold tracking-[-0.015em]">Add from catalog</h2>
            <p className="text-[13px] text-ink-3 mt-1">Hand-picked servers, checked against each vendor's docs.</p>
          </div>
          <input autoFocus type="search" value={q} onChange={(e) => setQ(e.target.value)} className="field" placeholder="Search: notion, calendar, github…" aria-label="Search the catalog" maxLength={60} />
          <label className="flex items-start gap-2 text-[13px] text-ink-2">
            <input type="checkbox" checked={community} onChange={(e) => setCommunity(e.target.checked)} className="mt-[3px]" />
            <span>Also search community servers from the public MCP Registry. Anyone can publish there and nobody reviews them; they connect as untrusted, with every write tool asking you first.</span>
          </label>
          {error && <p role="alert" className="text-[13px] text-bad">{error}</p>}
          <div className="flex flex-col -mx-2 overflow-y-auto max-h-[480px]">
            {list && !list.length && <p className="px-2 text-[13px] text-ink-3">{community ? "Nothing matches. Try another word, or add it by URL. (Engram copies the registry once a day; just after a restart the copy can take a couple of minutes.)" : !q.trim() ? "Nothing matches. Try another word, or add it by URL." : "No hand-picked server matches. Tick community servers to search the registry, or add it by URL."}</p>}
            {curated.map((e) => <Row key={e.url} e={e} onPick={setPicked} />)}
            {registry.length > 0 && <p className="px-2 pt-4 pb-1 text-[12px] text-ink-3">Community · unreviewed · from the MCP Registry</p>}
            {registry.map((e) => <Row key={e.url} e={e} onPick={setPicked} />)}
          </div>
          <div className="flex justify-end"><Btn kind="quiet" onClick={onClose}>Close</Btn></div>
        </div>
      )}
    </dialog>
  );
}

const host = (u: string) => { try { return new URL(u).hostname; } catch { return u; } };

function Row({ e, onPick }: { e: CatalogEntry; onPick: (e: CatalogEntry) => void }) {
  return (
    <button type="button" disabled={e.connected} onClick={() => onPick(e)}
      className={cx("text-left rounded-[10px] px-2 py-2.5 flex items-start gap-3", e.connected ? "opacity-60 cursor-default" : "hover:bg-surface-2")}>
      <span className="flex-1 min-w-0">
        <span className="block text-[14px] truncate">{e.name}{e.source === "registry" && <span className="text-[12px] text-ink-3"> · on {host(e.url)}{e.verified ? ", the publisher's own domain" : ", publisher not verified"}</span>}</span>
        <span className="block text-[12.5px] text-ink-3 mt-0.5 line-clamp-2">{e.description}</span>
      </span>
      <span className="flex-none text-[12px] text-ink-3 pt-0.5">
        {e.connected ? "Connected" : `${HOW[e.auth]}${e.source === "registry" ? "?" : ""}${e.untrusted ? " · untrusted" : ""}`}
      </span>
    </button>
  );
}

/** One click for OAuth with registration or no sign-in; a token field (with where to make one) otherwise. Registry entries are probed first. */
function Connect({ e, onBack, onAdded }: { e: CatalogEntry; onBack: () => void; onAdded: (r: ConnectResult) => void }) {
  const [auth, setAuth] = useState<ConnectionAuth>(e.auth);
  const [dcr, setDcr] = useState(e.dcr ?? null);
  const [probing, setProbing] = useState(e.source === "registry");
  const [token, setToken] = useState("");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [untrusted, setUntrusted] = useState(e.untrusted);
  const [name, setName] = useState(e.name.slice(0, 40));
  // An edited name makes the id, as the server does for a manual add; untouched, the catalog's id stands.
  const edited = name.trim() !== e.name.slice(0, 40);
  const id = edited ? slugId(name) : e.id || slugId(name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (e.source !== "registry") return;
    let live = true;
    api.probe(e.url).then((r) => { if (live) { setAuth(r.auth); setDcr(r.dcr); } }, (err) => { if (live) setError(errText(err)); }).finally(() => { if (live) setProbing(false); });
    return () => { live = false; };
  }, [e.url]);

  const needsClient = auth === "oauth" && dcr === false;
  async function submit(ev: FormEvent) {
    ev.preventDefault();
    setBusy(true); setError(null);
    try {
      onAdded(await api.addConnection({
        name: name.trim(), id: edited ? undefined : e.id || undefined, url: e.url, auth, untrusted,
        ...(auth === "bearer" ? { token: token.trim() } : {}),
        ...(auth === "oauth" && clientId.trim() ? { client_id: clientId.trim(), ...(clientSecret.trim() ? { client_secret: clientSecret.trim() } : {}) } : {}),
      }));
    } catch (err) { setError(errText(err)); } finally { setBusy(false); }
  }

  return (
    <form onSubmit={submit} className="p-6 flex flex-col gap-4">
      <div>
        <button type="button" onClick={onBack} className="text-[12.5px] text-ink-3 hover:text-ink-2">← Catalog</button>
        <h2 id="cat-title" className="text-[20px] font-semibold tracking-[-0.015em] mt-2">{e.name}</h2>
        <p className="text-[13px] text-ink-3 mt-1">{e.description}</p>
        <p className="text-[12px] text-ink-3 mt-2 font-mono break-all">{e.url}</p>
        {e.docs && <a className="text-[12.5px] text-data hover:underline" href={e.docs} target="_blank" rel="noopener noreferrer">{e.source === "registry" ? "Website" : "Vendor docs"}</a>}
      </div>
      <label className="flex flex-col gap-1.5 text-[13px] text-ink-3">
        Name
        <input required value={name} onChange={(ev) => setName(ev.target.value)} maxLength={40} className="field" />
        <span className="text-[12px]">Agents see its tools as <span className="font-mono text-ink-2">{id}__…</span>. The name can change later; this part can’t.</span>
      </label>
      {probing ? <p className="text-[13px] text-ink-3">Checking how it signs in…</p> : (
        <>
          {auth === "bearer" && (
            <label className="flex flex-col gap-1.5 text-[13px] text-ink-3">
              Token
              <input required type="password" autoComplete="off" value={token} onChange={(ev) => setToken(ev.target.value)} className="field font-mono text-[12.5px]" placeholder="Paste a personal access token or API key" />
              <span className="text-[12px]">
                Stored encrypted; never shown again.{e.tokenHelp && <> <a className="text-data hover:underline" href={e.tokenHelp} target="_blank" rel="noopener noreferrer">Make a token</a></>}
              </span>
            </label>
          )}
          {needsClient && (
            <div className="text-[13px] text-ink-3">
              <p>It doesn’t offer registration: create an OAuth client with the vendor (redirect URI <span className="font-mono text-[12px]">{location.origin}/api/connections/oauth/callback</span>) and paste it.</p>
              <div className="grid grid-cols-1 wide:grid-cols-2 gap-3 mt-3">
                <input required value={clientId} onChange={(ev) => setClientId(ev.target.value)} className="field font-mono text-[12.5px]" placeholder="Client id" aria-label="Client id" />
                <input type="password" autoComplete="off" value={clientSecret} onChange={(ev) => setClientSecret(ev.target.value)} className="field font-mono text-[12.5px]" placeholder="Client secret (optional)" aria-label="Client secret" />
              </div>
            </div>
          )}
          <div className="flex items-start gap-3 rounded-[10px] bg-surface-2 px-4 py-3">
            <div className="flex-1">
              <p className="text-[13.5px]">Untrusted content</p>
              <p className="text-[12.5px] text-ink-3 mt-0.5">Mail, web pages, other people’s text: results are marked, and an agent that reads them has its write tools ask you first for 10 minutes.</p>
            </div>
            <Toggle on={untrusted} label="Untrusted content" onChange={setUntrusted} />
          </div>
        </>
      )}
      {error && <p role="alert" className="text-[13px] text-bad">{error}</p>}
      <div className="flex items-center gap-2 justify-end">
        <Btn kind="quiet" onClick={onBack}>Back</Btn>
        <button type="submit" disabled={busy || probing || (auth === "bearer" && !token.trim()) || (needsClient && !clientId.trim())} className="bt bt-lg bt-primary">
          {busy ? "Connecting…" : auth === "oauth" ? "Connect and sign in" : "Connect"}
        </button>
      </div>
    </form>
  );
}
