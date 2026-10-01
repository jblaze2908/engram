import { useEffect, useState, type FormEvent } from "react";
import { SCOPES, type Agent, type Grant, type NewToken, type ProfileTarget, type Scope } from "../../../shared/types";
import { api } from "../lib/api";
import { useApp } from "../lib/app";
import { invalidateAgents } from "../lib/directory";
import { ago, shortDate } from "../lib/format";
import { AGENT_KIND_LABEL, hueColor, SCOPE_LABEL, TARGET_LABEL, TARGETS } from "../lib/labels";
import { href, navigate } from "../lib/router";
import { useLoad } from "../lib/useLoad";
import { ToolPicker } from "../components/ToolPicker";
import { BackLink, Btn, Card, CardHead, cx, Dot, Empty, ErrorNote, H1, Lede, LinkBtn, ListPane, Loading, Main, Split, Toggle } from "../components/ui";

export const MCP_URL = "https://engram.example.com/mcp";

const SCOPE_HINT: Record<Scope, string> = {
  personal: "Home, travel, preferences, people",
  finance: "Accounts, bills, payments",
  health: "Appointments, insurance, records",
  private: "Only you, ever",
};

/** Every scope present once, private always closed: the server enforces it, the UI just never offers it. */
function normalise(grants: Grant[]): Grant[] {
  return SCOPES.map((scope) => {
    if (scope === "private") return { scope, read: false, write: "none" };
    return grants.find((g) => g.scope === scope) ?? { scope, read: false, write: "none" };
  });
}

function grantSummary(a: Agent): string {
  const read = a.grants.filter((g) => g.read && g.scope !== "private").map((g) => g.scope);
  if (a.revoked) return "revoked";
  const conns = [...new Set((a.tools ?? []).map((t) => t.split("/")[0]))];
  if (read.length === 0) return conns.length ? conns.join(", ") : "no grants yet";
  return (read.length === 1 && !conns.length ? `${read[0]} only` : read.join(", ")) + (conns.length ? ` · ${conns.join(", ")}` : "");
}

export function Agents({ id }: { id?: string }) {
  const load = useLoad(() => api.agents(), []);
  const [reveal, setReveal] = useState<NewToken | null>(null);
  useEffect(() => { if (reveal && reveal.agent.id !== id) setReveal(null); }, [id]);
  const list = load.data ?? [];
  const adding = id === "new";
  const picked = adding ? undefined : list.find((a) => a.id === id) ?? (id ? undefined : list[0]);

  const changed = (a?: Agent) => {
    invalidateAgents();
    if (a) load.setData(list.some((x) => x.id === a.id) ? list.map((x) => (x.id === a.id ? a : x)) : [...list, a]);
    else load.reload();
  };

  const groups: [string, Agent[]][] = [
    ["Pitcrew", list.filter((a) => a.kind === "pitcrew")],
    ["On the Mac", list.filter((a) => a.kind === "mac")],
    ["Other", list.filter((a) => a.kind === "other")],
  ];

  return (
    <Split picked={!!id}
      list={
        <ListPane title="Agents" sub="Each has its own token and sees only what you grant."
          foot={<LinkBtn href="#/agents/new" className="w-full" aria-current={adding ? "page" : undefined}>Add an agent</LinkBtn>}>
          {!load.data && (load.error ? <ErrorNote error={load.error} onRetry={load.reload} /> : <Loading />)}
          {load.data && list.length === 0 && (
            <p className="px-3 text-[13px] text-ink-3 leading-relaxed">No agents yet. Add one to give it a token for the MCP endpoint; it sees nothing until you grant it a scope.</p>
          )}
          {groups.filter(([, as]) => as.length).map(([label, as]) => (
            <div key={label} className="mb-2">
              <p className="text-[12px] text-ink-3 px-3 mb-1 mt-1">{label}</p>
              {as.map((a) => (
                <a key={a.id} href={href(["agents", a.id])} className={cx("it", a.revoked && "opacity-60")} aria-current={a.id === picked?.id ? "true" : undefined}>
                  <Dot color={hueColor(a.hue)} className="mt-[7px]" />
                  <span><span className="block">{a.name}</span><span className="block text-[12.5px] text-ink-3 mt-0.5">{grantSummary(a)}</span></span>
                </a>
              ))}
            </div>
          ))}
        </ListPane>
      }
      detail={
        <Main>
          {adding ? (
            reveal ? <TokenReveal t={reveal} fresh onDone={() => { setReveal(null); navigate(href(["agents", reveal.agent.id])); }} />
              : <NewAgentForm onCreated={(t) => { changed(t.agent); setReveal(t); }} />
          ) : picked ? (
            <>
              {reveal && reveal.agent.id === picked.id && <TokenReveal t={reveal} onDone={() => setReveal(null)} />}
              <AgentDetail a={picked} onChanged={changed} onToken={(t) => { changed(t.agent); setReveal(t); }} />
            </>
          ) : load.data ? (
            <Empty title={id ? "That agent isn’t here." : "No agents yet."}>
              An agent is anything that talks to Engram over MCP: a Pitcrew member, Claude Code or Codex on the Mac. <a className="text-data hover:underline" href="#/agents/new">Add an agent</a>.
            </Empty>
          ) : null}
        </Main>
      } />
  );
}

function GrantTable({ grants, onChange, disabled }: { grants: Grant[]; onChange: (g: Grant[]) => void; disabled?: boolean }) {
  const set = (scope: Scope, patch: Partial<Grant>) =>
    onChange(grants.map((g) => {
      if (g.scope !== scope) return g;
      const next = { ...g, ...patch };
      // Proposing into a scope you can't read makes no sense; switching read off closes write too.
      if (!next.read) next.write = "none";
      return next;
    }));
  return (
    <Card>
      <div className="grid grid-cols-[1fr_70px_130px] wide:grid-cols-[1fr_120px_150px] gap-3 items-center px-[18px] py-3 text-[12px] text-ink-3">
        <span>Scope</span><span>Read</span><span>Write</span>
      </div>
      {grants.map((g) => (
        <div key={g.scope} className="grid grid-cols-[1fr_70px_130px] wide:grid-cols-[1fr_120px_150px] gap-3 items-center px-[18px] py-3 border-t border-line">
          <div><p>{SCOPE_LABEL[g.scope]}</p><p className="text-[12.5px] text-ink-3 mt-0.5">{SCOPE_HINT[g.scope]}</p></div>
          {g.scope === "private" ? (
            <><span className="text-[13px] text-ink-3">locked</span><span className="text-[13px] text-ink-3">—</span></>
          ) : (
            <>
              <span><Toggle on={g.read} disabled={disabled} label={`Read ${g.scope}`} onChange={(read) => set(g.scope, { read })} /></span>
              <span>
                <label className="sr-only" htmlFor={`w-${g.scope}`}>Write {g.scope}</label>
                <select id={`w-${g.scope}`} value={g.write} disabled={disabled || !g.read} onChange={(e) => set(g.scope, { write: e.target.value as Grant["write"] })}
                  className="h-[30px] rounded-[8px] bg-transparent border border-line px-2 text-[13px] text-ink-2 disabled:opacity-50">
                  <option value="none">No writes</option>
                  <option value="propose">Propose only</option>
                </select>
              </span>
            </>
          )}
        </div>
      ))}
    </Card>
  );
}

function AgentDetail({ a, onChanged, onToken }: { a: Agent; onChanged: (a?: Agent) => void; onToken: (t: NewToken) => void }) {
  const { notify } = useApp();
  const [grants, setGrants] = useState(() => normalise(a.grants));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { setGrants(normalise(a.grants)); setError(null); }, [a]);
  const skills = useLoad(() => api.skills(), []);

  async function save(next: Grant[]) {
    const prev = grants;
    setGrants(next); setBusy(true); setError(null);
    try {
      const updated = await api.updateAgent(a.id, { grants: next.filter((g) => g.scope !== "private") });
      onChanged(updated && typeof updated === "object" && "id" in updated ? updated : { ...a, grants: next });
    } catch (e) {
      setGrants(prev);
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  }

  async function toggleSkill(name: string, on: boolean) {
    setBusy(true); setError(null);
    try {
      const next = on ? [...a.skills, name] : a.skills.filter((s) => s !== name);
      const updated = await api.updateAgent(a.id, { skills: next });
      onChanged(updated && typeof updated === "object" && "id" in updated ? updated : { ...a, skills: next });
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  }

  async function rotate() {
    if (!window.confirm(`Make a new token for ${a.name}? The current one stops working straight away.`)) return;
    setBusy(true); setError(null);
    try { onToken(await api.newToken(a.id)); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  }

  async function revoke() {
    if (!window.confirm(`Revoke ${a.name}? Its token stops working and it can’t read or propose anything. You can make it a new token later.`)) return;
    setBusy(true); setError(null);
    try { await api.revoke(a.id); notify(`${a.name} is revoked.`); onChanged(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  }

  return (
    <>
      <BackLink href="#/agents" label="Agents" />
      <div className="flex items-center justify-between gap-3 flex-wrap text-[13px] text-ink-3">
        <span>{AGENT_KIND_LABEL[a.kind]} · token made {shortDate(a.created_at)} · {a.revoked ? "revoked" : `last used ${ago(a.last_used_at)}`}</span>
        <span className="flex gap-2">
          <Btn disabled={busy} onClick={rotate}>New token</Btn>
          {!a.revoked && <Btn kind="danger" disabled={busy} onClick={revoke}>Revoke</Btn>}
        </span>
      </div>
      <H1 className="mt-3">What {a.name} can see</H1>
      <Lede>
        {a.revoked ? `${a.name} is revoked. Its token no longer works; make a new one to bring it back.`
          : `It reads only the scopes switched on below, and can at most propose changes; you decide in the inbox.`}
      </Lede>
      {error && <p role="alert" className="text-[13px] text-bad mt-4">{error}</p>}
      <div className="grid grid-cols-1 wide:grid-cols-[1fr_340px] gap-3 mt-6">
        <div className="flex flex-col gap-3">
          <GrantTable grants={grants} disabled={busy || a.revoked} onChange={save} />
          <Card>
            <CardHead left="Skills it gets" right={a.skills.length || undefined} />
            {skills.data?.length === 0 && <p className="rw text-ink-2">No skills in the vault yet.</p>}
            {skills.data?.map((s) => (
              <label key={s.name} className="rw cursor-pointer hover:bg-surface-2">
                <input type="checkbox" className="accent-[var(--ink)]" checked={a.skills.includes(s.name)} disabled={busy || a.revoked}
                  onChange={(e) => toggleSkill(s.name, e.target.checked)} />
                <span className="flex-1">{s.name}</span>
                <span className="text-[12.5px] text-ink-3 truncate max-w-[50%]">{s.description}</span>
              </label>
            ))}
          </Card>
        </div>
        <div className="flex flex-col gap-3">
          <Card>
            <CardHead left="Connection" />
            <div className="kv"><span>Endpoint</span><span className="font-mono text-[12px]">{MCP_URL}</span></div>
            <div className="kv"><span>Token</span><span className="font-mono text-[12px]">{a.token_prefix}…</span></div>
            <div className="kv"><span>Profile it gets</span><a className="hover:text-ink-2" href={href(["context", "profile"], { target: a.profile })}>{TARGET_LABEL[a.profile]}</a></div>
          </Card>
          <ToolPicker a={a} onChanged={onChanged} />
        </div>
      </div>
    </>
  );
}

function NewAgentForm({ onCreated }: { onCreated: (t: NewToken) => void }) {
  const [name, setName] = useState("");
  const [kind, setKind] = useState<Agent["kind"]>("mac");
  const [profile, setProfile] = useState<ProfileTarget>("claude-code");
  const [grants, setGrants] = useState<Grant[]>(() => normalise([{ scope: "personal", read: true, write: "propose" }]));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      onCreated(await api.createAgent({ name: name.trim(), kind, profile, grants: grants.filter((g) => g.scope !== "private") }));
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); } finally { setBusy(false); }
  }

  return (
    <form onSubmit={submit} className="max-w-[760px]">
      <BackLink href="#/agents" label="Agents" />
      <H1>Add an agent</H1>
      <Lede>It gets its own token for the MCP endpoint. It sees only the scopes you switch on, and private is never offered.</Lede>
      <Card className="mt-6 p-5 grid grid-cols-1 wide:grid-cols-3 gap-4">
        <label className="flex flex-col gap-1.5 text-[13px] text-ink-3">
          Name
          <input required autoFocus value={name} onChange={(e) => setName(e.target.value)} className="field" placeholder="e.g. Claude Code" maxLength={60} />
        </label>
        <label className="flex flex-col gap-1.5 text-[13px] text-ink-3">
          Kind
          <select value={kind} onChange={(e) => {
            const k = e.target.value as Agent["kind"];
            setKind(k);
            if (k === "pitcrew") setProfile("pitcrew-member");
          }} className="field">
            <option value="pitcrew">Pitcrew member</option>
            <option value="mac">On the Mac</option>
            <option value="other">Other</option>
          </select>
        </label>
        <label className="flex flex-col gap-1.5 text-[13px] text-ink-3">
          Profile it gets
          <select value={profile} onChange={(e) => setProfile(e.target.value as ProfileTarget)} className="field">
            {TARGETS.map((t) => <option key={t} value={t}>{TARGET_LABEL[t]}</option>)}
          </select>
        </label>
      </Card>
      <p className="text-[13px] text-ink-3 mt-6 mb-2 px-1">What it can see</p>
      <GrantTable grants={grants} onChange={setGrants} disabled={busy} />
      {error && <p role="alert" className="text-[13px] text-bad mt-4">{error}</p>}
      <div className="mt-6 flex items-center gap-2">
        <button type="submit" disabled={busy || !name.trim()} className="bt bt-lg bt-primary">{busy ? "Making the token…" : "Add agent and make its token"}</button>
        <LinkBtn lg kind="quiet" href="#/agents">Cancel</LinkBtn>
      </div>
    </form>
  );
}

/** The raw token exists only in this component's props; the server keeps a hash, so this is the one chance to copy it. */
function TokenReveal({ t, fresh, onDone }: { t: NewToken; fresh?: boolean; onDone: () => void }) {
  const [copied, setCopied] = useState<string | null>(null);
  async function copy(what: string, text: string) {
    try { await navigator.clipboard.writeText(text); setCopied(what); } catch { setCopied(null); }
  }
  const cmd = `claude mcp add --transport http engram ${MCP_URL} --header "Authorization: Bearer ${t.token}"`;
  return (
    <Card hot className="mb-6 p-5">
      <p className="flex items-center gap-2 text-[13.5px]"><Dot color="var(--signal)" />
        {fresh ? `${t.agent.name} is added.` : `New token for ${t.agent.name}.`} Copy the token now: Engram shows it once and keeps only a fingerprint.
      </p>
      <div className="mt-4 flex flex-col gap-3">
        <div>
          <p className="text-[12.5px] text-ink-3 mb-1.5">Token</p>
          <div className="flex items-center gap-2">
            <code className="flex-1 min-w-0 rounded-[10px] bg-surface-2 px-3 py-2.5 font-mono text-[12.5px] break-all select-all">{t.token}</code>
            <Btn kind="primary" onClick={() => copy("token", t.token)}>{copied === "token" ? "Copied" : "Copy"}</Btn>
          </div>
        </div>
        <div>
          <p className="text-[12.5px] text-ink-3 mb-1.5">MCP endpoint</p>
          <div className="flex items-center gap-2">
            <code className="flex-1 min-w-0 rounded-[10px] bg-surface-2 px-3 py-2.5 font-mono text-[12.5px] break-all">{MCP_URL}</code>
            <Btn onClick={() => copy("url", MCP_URL)}>{copied === "url" ? "Copied" : "Copy"}</Btn>
          </div>
        </div>
        {t.agent.kind === "mac" && (
          <div>
            <p className="text-[12.5px] text-ink-3 mb-1.5">For Claude Code, run this once on the Mac</p>
            <div className="flex items-start gap-2">
              <code className="flex-1 min-w-0 rounded-[10px] bg-surface-2 px-3 py-2.5 font-mono text-[12px] break-all">{cmd}</code>
              <Btn onClick={() => copy("cmd", cmd)}>{copied === "cmd" ? "Copied" : "Copy"}</Btn>
            </div>
          </div>
        )}
      </div>
      <div className="mt-5 flex items-center gap-3">
        <Btn kind="primary" lg onClick={onDone}>I’ve saved it</Btn>
        <span className="text-[12.5px] text-ink-3">Lost it later? Make a new token; the old one stops working.</span>
      </div>
    </Card>
  );
}
