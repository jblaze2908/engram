import { useEffect, useRef, useState, type FormEvent } from "react";
import type { Connection, ConnectionAuth, ConnectionDetail, ConnectResult, ToolPolicy } from "../../../shared/types";
import { api } from "../lib/api";
import { useApp } from "../lib/app";
import { useWho } from "../lib/directory";
import { ago, shortDate } from "../lib/format";
import { href, navigate } from "../lib/router";
import { useLoad } from "../lib/useLoad";
import { AddFromCatalog } from "../components/Catalog";
import { BackLink, Btn, Card, CardHead, cx, Dot, Empty, ErrorNote, H1, Lede, ListPane, Loading, Main, Split, Toggle } from "../components/ui";

const statusColor = (s: Connection["status"]) => (s === "signal" ? "var(--signal)" : s === "warn" ? "var(--warn)" : "var(--in)");
const AUTH_LABEL: Record<ConnectionAuth, string> = { oauth: "Sign in (OAuth)", bearer: "Token or API key", none: "No sign-in" };
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const POLICY: [ToolPolicy, string][] = [["allow", "run"], ["ask", "ask me"], ["block", "block"]];

// Paste-back sign-in pages, by connection: kept outside Detail so the link survives navigating to it after Add.
const signIns = new Map<string, string>();

/** An OAuth connection that needs you: the authorization page replaces this tab, and its callback brings you back.
 *  A paste-back one stays here instead, with a link to open and a box for the address it ends on. */
function follow(r: ConnectResult) {
  if (!r.authorize_url || !/^https?:\/\//.test(r.authorize_url)) return false;
  if (r.connection.paste_back) { signIns.set(r.connection.id, r.authorize_url); return false; }
  window.location.assign(r.authorize_url);
  return true;
}

export function Connections({ id, query }: { id?: string; query?: URLSearchParams }) {
  const load = useLoad(() => api.connections(), []);
  const [adding, setAdding] = useState(false);
  const [browsing, setBrowsing] = useState(false);
  const added = (r: ConnectResult) => { setAdding(false); setBrowsing(false); load.reload(); if (!follow(r)) navigate(href(["connections", r.connection.id])); };
  const list = load.data ?? [];
  const picked = list.find((c) => c.id === id) ?? (id ? undefined : list[0]);
  useOAuthReturn(query, load.reload);
  return (
    <>
    <Split picked={!!id}
      list={
        <ListPane title="Connections" sub="Engram holds the sign-ins. Agents never see them.">
          {!load.data && (load.error ? <ErrorNote error={load.error} onRetry={load.reload} /> : <Loading />)}
          {list.map((c) => (
            <a key={c.id} href={href(["connections", c.id])} className="it" aria-current={c.id === picked?.id ? "true" : undefined}>
              <Dot color={statusColor(c.status)} className="mt-[7px]" />
              <span><span className="block">{c.name}</span><span className="block text-[12.5px] text-ink-3 mt-0.5">{c.detail} · {c.tools.length} {c.tools.length === 1 ? "tool" : "tools"}</span></span>
            </a>
          ))}
          <Btn kind="primary" className="mt-3 mx-1" onClick={() => setBrowsing(true)}>Add from catalog</Btn>
          <Btn className="mt-2 mx-1" onClick={() => setAdding(true)}>Add by URL</Btn>
        </ListPane>
      }
      detail={
        <Main>
          {picked ? <Detail key={picked.id} id={picked.id} onChanged={load.reload} /> : load.data ? (
            <>
              <H1>Connections</H1>
              <Card className="mt-6 max-w-[680px]">
                <Empty title={id ? "That connection isn’t here." : "Nothing connected yet."}>
                  Connect GitHub, Gmail or any remote MCP server once. Engram keeps the sign-in, and you choose which tools each agent may call.
                </Empty>
              </Card>
            </>
          ) : null}
        </Main>
      } />
      <AddConnection open={adding} onClose={() => setAdding(false)} onAdded={added} />
      <AddFromCatalog open={browsing} onClose={() => setBrowsing(false)} onAdded={added} />
    </>
  );
}

/** Back from the authorization server without the session cookie (it is SameSite=Strict): finish with a same-origin POST. */
function useOAuthReturn(query: URLSearchParams | undefined, reload: () => void) {
  const { notify } = useApp();
  const done = useRef(false);
  const mode = query?.get("oauth"), state = query?.get("state"), code = query?.get("code"), iss = query?.get("iss");
  useEffect(() => {
    if (done.current || !mode) return;
    done.current = true;
    if (mode === "failed" || !state || !code) { notify("Sign-in didn’t finish. Press Connect to try again."); navigate("#/connections"); return; }
    api.finishOAuth({ state, code, ...(iss ? { iss } : {}) }).then(
      (r) => { notify(`${r.connection.name} is connected.`); reload(); navigate(href(["connections", r.connection.id])); },
      (e) => { notify(errText(e)); navigate("#/connections"); },
    );
  }, [mode, state, code, iss]);
}

function Detail({ id, onChanged }: { id: string; onChanged: () => void }) {
  const { notify, refreshInbox } = useApp();
  const who = useWho();
  const load = useLoad(() => api.connection(id), [id]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [at, setAt] = useState(0);
  const [token, setToken] = useState("");
  if (!load.data) return load.error ? <ErrorNote error={load.error} onRetry={load.reload} /> : <Loading />;
  const c = load.data;

  async function run(fn: () => Promise<ConnectResult | unknown>, after?: string) {
    setBusy(true); setError(null);
    try {
      const r = await fn();
      if (r && typeof r === "object" && "connection" in r) {
        if (follow(r as ConnectResult)) return;
        load.setData((r as ConnectResult).connection);
      }
      if (after) notify(after);
      onChanged(); refreshInbox();
    } catch (e) { setError(errText(e)); } finally { setBusy(false); }
  }

  async function disconnect() {
    if (!window.confirm(`Disconnect ${c.name}? Engram forgets its sign-in and every agent loses its tools.`)) return;
    // A second, separate question: forgetting is reversible, but it shouldn't ride along unnoticed.
    const forget = c.memories > 0 && window.confirm(`Also forget the ${c.memories} ${c.memories === 1 ? "memory" : "memories"} agents saved from ${c.name}? OK forgets them; Cancel keeps them.`);
    setBusy(true);
    try {
      const r = await api.disconnect(c.id, forget);
      notify(`${c.name} is disconnected${r.forgotten ? ` and ${r.forgotten} ${r.forgotten === 1 ? "memory" : "memories"} forgotten` : ""}.`);
      onChanged(); navigate("#/connections");
    } catch (e) { setError(errText(e)); setBusy(false); }
  }

  const change = c.changes[Math.min(at, c.changes.length - 1)];
  const broken = c.status === "signal" && c.changes.length === 0;
  return (
    <>
      <BackLink href="#/connections" label="Connections" />
      <div className="flex items-center justify-between gap-3 flex-wrap text-[13px] text-ink-3">
        <span>
          {c.connected_at ? `Connected ${shortDate(c.connected_at)}` : "Not connected yet"}
          {c.auth !== "none" ? " · sign-in stored encrypted" : ""}
          {c.refreshed_at ? ` · refreshed ${ago(c.refreshed_at)}` : ""}
        </span>
        <span className="flex gap-2">
          <Btn disabled={busy} onClick={() => run(() => api.refreshConnection(c.id), "Tools listed again.")}>Refresh</Btn>
          <Btn disabled={busy} onClick={disconnect}>Disconnect</Btn>
        </span>
      </div>
      <H1 className="mt-3">{c.name}</H1>
      {error && <p role="alert" className="text-[13px] text-bad mt-3">{error}</p>}

      {broken && (
        <Card hot className="mt-5 px-5 py-4 flex flex-col gap-3">
          <p className="flex items-center gap-3"><Dot color="var(--signal)" /><span className="flex-1">{c.detail}.</span></p>
          {c.auth === "bearer" ? (
            <form className="flex gap-2 flex-wrap" onSubmit={(e) => { e.preventDefault(); if (token.trim()) run(() => api.updateConnection(c.id, { token: token.trim() }), "Token saved.").then(() => setToken("")); }}>
              <input type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} placeholder="Paste a new token" aria-label="New token" className="field flex-1 min-w-[220px]" />
              <button type="submit" disabled={busy || !token.trim()} className="bt bt-primary">Save and connect</button>
            </form>
          ) : c.auth === "oauth" && c.paste_back ? (
            <PasteBack c={c} busy={busy} onStart={() => run(() => api.connect(c.id))}
              onDone={(r) => { signIns.delete(c.id); load.setData(r.connection); notify(`${c.name} is connected.`); onChanged(); refreshInbox(); }} />
          ) : (
            <div><Btn kind="primary" disabled={busy} onClick={() => run(() => api.connect(c.id))}>{c.auth === "oauth" ? "Connect" : "Try again"}</Btn></div>
          )}
        </Card>
      )}

      {change && (
        <Card hot className="mt-5 px-5 py-4">
          <p className="flex items-center gap-3">
            <Dot color="var(--signal)" />
            {c.changes.length === 1 ? "One tool description changed since you approved it. It is blocked for every agent until you look."
              : `${c.changes.length} tool descriptions changed since you approved them. All are blocked for every agent until you look.`}
          </p>
          <p className="mt-4 text-[12.5px] text-ink-3"><span className="font-mono text-ink-2">{change.tool}</span>{c.changes.length > 1 ? ` · ${Math.min(at, c.changes.length - 1) + 1} of ${c.changes.length}` : ""}</p>
          <div className="grid grid-cols-1 wide:grid-cols-2 gap-3 mt-2">
            <div className="rounded-[10px] bg-surface-2 p-4">
              <p className="text-[12px] text-ink-3">You approved</p>
              <p className="mt-1.5 text-[13.5px] whitespace-pre-wrap break-words">{change.approved || "(no description)"}</p>
            </div>
            <div className="rounded-[10px] p-4" style={{ background: "color-mix(in srgb,var(--signal) 12%,var(--surface))" }}>
              <p className="text-[12px]" style={{ color: "var(--signal)" }}>Now says</p>
              <p className="mt-1.5 text-[13.5px] whitespace-pre-wrap break-words">{change.now || "(no description)"}</p>
            </div>
          </div>
          <p className="mt-3 text-[12.5px] text-ink-3">Approve only if the new text is what the tool should say. Words that tell an agent to read, send or include other things are an injection, not an update.</p>
          <div className="mt-4 flex items-center gap-2 flex-wrap">
            <Btn kind="primary" disabled={busy} onClick={() => run(() => api.keepBlocked(c.id, change.tool), "Kept blocked.")}>Keep blocked</Btn>
            <Btn disabled={busy} onClick={() => run(() => api.approveTool(c.id, change.tool), "Approved; agents can use it again.")}>Approve new text</Btn>
            {c.changes.length > 1 && <Btn kind="quiet" onClick={() => setAt((at + 1) % c.changes.length)}>Next change</Btn>}
          </div>
        </Card>
      )}

      <Card className="mt-3">
        <CardHead left="Tools" right="writes ask you first unless you say so" />
        {c.tools.length === 0 && <Lede className="px-5 pb-4">No tools reported yet.</Lede>}
        {c.tools.length > 0 && (
          <div className="grid grid-cols-[1fr_auto] wide:grid-cols-[minmax(160px,1fr)_90px_90px_1fr_130px] gap-3 px-[18px] py-2.5 text-[12px] text-ink-3 border-t border-line max-wide:hidden">
            <span>Tool</span><span>Kind</span><span>Calls</span><span>Agents allowed</span><span className="text-right">Description</span>
          </div>
        )}
        {c.tools.map((t) => (
          <div key={t.name} className="grid grid-cols-[1fr_auto] wide:grid-cols-[minmax(160px,1fr)_90px_90px_1fr_130px] gap-3 items-center px-[18px] py-[11px] border-t border-line text-[13px]">
            <span className="min-w-0"><span className="block font-mono text-[12.5px] truncate">{t.name}</span><span className="block text-[12px] text-ink-3 truncate wide:hidden">{t.kind}</span></span>
            <span className="max-wide:hidden">
              <label className="sr-only" htmlFor={`k-${t.name}`}>Kind of {t.name}</label>
              <select id={`k-${t.name}`} value={t.kind} disabled={busy} onChange={(e) => run(() => api.setToolKind(c.id, t.name, e.target.value as "read" | "write"))}
                className="h-[28px] rounded-[8px] bg-transparent border border-line px-1.5 text-[12.5px] text-ink-2">
                <option value="read">read</option>
                <option value="write">write</option>
              </select>
            </span>
            <span className="max-wide:hidden">
              <label className="sr-only" htmlFor={`p-${t.name}`}>Calls to {t.name}</label>
              <select id={`p-${t.name}`} value={t.policy} disabled={busy} onChange={(e) => run(() => api.setToolPolicy(c.id, t.name, e.target.value as ToolPolicy))}
                className="h-[28px] rounded-[8px] bg-transparent border border-line px-1.5 text-[12.5px]" style={{ color: t.policy === "block" ? "var(--bad)" : t.policy === "ask" ? "var(--warn)" : "var(--ink-2)" }}>
                {POLICY.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </span>
            <span className="text-ink-2 max-wide:hidden truncate">{t.agents.length ? t.agents.map((a) => who(a).name).join(", ") : "nobody"}</span>
            <span className="text-right" style={{ color: t.changed ? "var(--signal)" : "var(--ink-3)" }}>{t.changed ? "changed · blocked" : "pinned"}</span>
          </div>
        ))}
      </Card>

      <Card className="mt-3">
        <CardHead left="Settings" />
        <div className="kv"><span>Server</span><span className="font-mono text-[12px] break-all">{c.url}</span></div>
        <div className="kv"><span>Sign-in</span><span>{AUTH_LABEL[c.auth]}</span></div>
        <div className="kv">
          <span>Untrusted content <span className="block text-[12px] text-ink-3">Results are marked for agents, like email or a web page</span></span>
          <Toggle on={c.untrusted} disabled={busy} label="Untrusted content" onChange={(v) => run(() => api.updateConnection(c.id, { untrusted: v }))} />
        </div>
        <div className="kv">
          <span>Memories made from it <span className="block text-[12px] text-ink-3">Saved by an agent within 10 minutes of calling {c.name}</span></span>
          <span className="flex items-center gap-3">
            <span>{c.memories}</span>
            {c.memories > 0 && <Btn disabled={busy} onClick={() => window.confirm(`Forget the ${c.memories} memories made from ${c.name}?`) && run(async () => { await api.forgetConnectionMemories(c.id); load.setData({ ...c, memories: 0 }); }, "Forgotten.")}>Forget them</Btn>}
          </span>
        </div>
        <p className="px-[18px] py-3 border-t border-line text-[12.5px] text-ink-3">Grant tools per agent on the <a className="text-data hover:underline" href="#/agents">Agents</a> screen. Write tools are never granted on their own. Grant changes reach an agent in its next session; one already running keeps the tools it started with.</p>
      </Card>
    </>
  );
}

/** Sign-in for a server that only returns to apps on your computer: the page it ends on won't load, and its address
 *  carries the code. Engram checks the state is one it issued to this browser session. */
function PasteBack({ c, busy, onStart, onDone }: { c: ConnectionDetail; busy: boolean; onStart: () => void; onDone: (r: ConnectResult) => void }) {
  const [pasted, setPasted] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const url = signIns.get(c.id);

  async function finish(e: FormEvent) {
    e.preventDefault();
    setError(null);
    let q: URLSearchParams;
    try { q = new URL(pasted.trim()).searchParams; } catch { setError("That isn’t an address. Copy the whole thing from the address bar."); return; }
    const state = q.get("state"), code = q.get("code"), iss = q.get("iss");
    if (q.get("error")) { setError(`${c.name} didn’t approve the sign-in. Open it again to retry.`); return; }
    if (!state || !code) { setError("That address has no sign-in code in it. Paste the one the sign-in ended on."); return; }
    setSending(true);
    try { onDone(await api.finishOAuth({ state, code, ...(iss ? { iss } : {}) })); } catch (err) { setError(errText(err)); } finally { setSending(false); }
  }

  return (
    <div className="flex flex-col gap-3 text-[13px]">
      <p className="text-ink-2">{c.name} won’t send sign-ins back to Engram, so this one ends on another page, which may not load. That’s expected: copy that page’s address and paste it here.</p>
      <div className="flex gap-2 flex-wrap">
        {url
          ? <><a className="bt bt-primary" href={url} target="_blank" rel="noopener noreferrer">Open {c.name} sign-in</a><Btn kind="quiet" disabled={busy} onClick={onStart}>New link</Btn></>
          : <Btn kind="primary" disabled={busy} onClick={onStart}>Start sign-in</Btn>}
      </div>
      <form className="flex gap-2 flex-wrap" onSubmit={finish}>
        <input value={pasted} onChange={(e) => setPasted(e.target.value)} placeholder="Address the sign-in ended on (…?code=…)" aria-label="Address the sign-in ended on"
          autoComplete="off" spellCheck={false} className="field flex-1 min-w-[220px] font-mono text-[12.5px]" />
        <button type="submit" disabled={sending || !pasted.trim()} className="bt">{sending ? "Finishing…" : "Finish sign-in"}</button>
      </form>
      {error && <p role="alert" className="text-bad">{error}</p>}
    </div>
  );
}

function AddConnection({ open, onClose, onAdded }: { open: boolean; onClose: () => void; onAdded: (r: ConnectResult) => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [auth, setAuth] = useState<ConnectionAuth>("oauth");
  const [token, setToken] = useState("");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [untrusted, setUntrusted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      setName(""); setUrl(""); setAuth("oauth"); setToken(""); setClientId(""); setClientSecret(""); setUntrusted(false); setError(null);
      d.showModal();
    } else if (!open && d.open) d.close();
  }, [open]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      onAdded(await api.addConnection({
        name: name.trim(), url: url.trim(), auth, untrusted,
        ...(auth === "bearer" ? { token: token.trim() } : {}),
        ...(auth === "oauth" && clientId.trim() ? { client_id: clientId.trim(), ...(clientSecret.trim() ? { client_secret: clientSecret.trim() } : {}) } : {}),
      }));
    } catch (err) { setError(errText(err)); } finally { setBusy(false); }
  }

  return (
    <dialog ref={ref} onClose={onClose} aria-labelledby="conn-title"
      className="m-auto w-[min(560px,calc(100vw-32px))] rounded-[14px] bg-surface border border-line text-ink p-0 backdrop:bg-black/50">
      <form onSubmit={submit} className="p-6 flex flex-col gap-4">
        <div>
          <h2 id="conn-title" className="text-[20px] font-semibold tracking-[-0.015em]">Add a connection</h2>
          <p className="text-[13px] text-ink-3 mt-1">A remote MCP server over https. Engram signs in once and calls it for the agents you allow.</p>
        </div>
        <div className="grid grid-cols-1 wide:grid-cols-[160px_1fr] gap-3">
          <label className="flex flex-col gap-1.5 text-[13px] text-ink-3">
            Name
            <input required autoFocus value={name} onChange={(e) => setName(e.target.value)} className="field" placeholder="GitHub" maxLength={40} />
          </label>
          <label className="flex flex-col gap-1.5 text-[13px] text-ink-3">
            Server URL
            <input required type="url" value={url} onChange={(e) => setUrl(e.target.value)} className="field font-mono text-[12.5px]" placeholder="https://api.githubcopilot.com/mcp/" />
          </label>
        </div>
        <label className="flex flex-col gap-1.5 text-[13px] text-ink-3">
          How Engram signs in
          <select value={auth} onChange={(e) => setAuth(e.target.value as ConnectionAuth)} className="field">
            {(Object.keys(AUTH_LABEL) as ConnectionAuth[]).map((k) => <option key={k} value={k}>{AUTH_LABEL[k]}</option>)}
          </select>
        </label>
        {auth === "bearer" && (
          <label className="flex flex-col gap-1.5 text-[13px] text-ink-3">
            Token
            <input required type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} className="field font-mono text-[12.5px]" placeholder="Paste a personal access token or API key" />
            <span className="text-[12px]">Stored encrypted. It never leaves Engram and is never shown again.</span>
          </label>
        )}
        {auth === "oauth" && (
          <details className="text-[13px] text-ink-3">
            <summary className="cursor-pointer select-none">The server doesn’t offer registration? Paste a client id</summary>
            <div className="grid grid-cols-1 wide:grid-cols-2 gap-3 mt-3">
              <input value={clientId} onChange={(e) => setClientId(e.target.value)} className="field font-mono text-[12.5px]" placeholder="Client id" aria-label="Client id" />
              <input type="password" autoComplete="off" value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} className="field font-mono text-[12.5px]" placeholder="Client secret (optional)" aria-label="Client secret" />
            </div>
          </details>
        )}
        <div className={cx("flex items-start gap-3 rounded-[10px] bg-surface-2 px-4 py-3")}>
          <div className="flex-1">
            <p className="text-[13.5px]">Untrusted content</p>
            <p className="text-[12.5px] text-ink-3 mt-0.5">For email and the web: every result is marked untrusted, and anything an agent proposes from it is held.</p>
          </div>
          <Toggle on={untrusted} label="Untrusted content" onChange={setUntrusted} />
        </div>
        {error && <p role="alert" className="text-[13px] text-bad">{error}</p>}
        <div className="flex items-center gap-2 justify-end">
          <Btn kind="quiet" onClick={onClose}>Cancel</Btn>
          <button type="submit" disabled={busy || !name.trim() || !url.trim() || (auth === "bearer" && !token.trim())} className="bt bt-lg bt-primary">
            {busy ? "Connecting…" : auth === "oauth" ? "Add and sign in" : "Add and connect"}
          </button>
        </div>
      </form>
    </dialog>
  );
}
