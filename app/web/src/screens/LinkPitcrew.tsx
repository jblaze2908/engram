import { useState } from "react";
import type { NewToken } from "../../../shared/types";
import { api } from "../lib/api";
import { BackLink, Btn, Card, Dot, H1, Lede, LinkBtn } from "../components/ui";

const LINK_CAN = [
  "See what’s waiting in your inbox, except anything private, and send your decisions back.",
  "Read the weekly digest for the Pit wall.",
  "Make an Engram agent for each crew member. Each starts with personal read and propose, and you can change that here.",
  "Move Pitcrew’s memories and Library receipts into Engram.",
];

/** "Link Pitcrew": makes the one link agent. Its token is shown once, like any other. */
export function LinkPitcrew({ onCreated }: { onCreated: (t: NewToken) => void }) {
  const [t, setT] = useState<NewToken | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function link() {
    setBusy(true); setError(null);
    try { const n = await api.linkPitcrew(); setT(n); onCreated(n); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  }

  if (t) return <LinkReveal t={t} onDone={() => { window.location.hash = `#/agents/${encodeURIComponent(t.agent.id)}`; }} />;
  return (
    <div className="max-w-[760px]">
      <BackLink href="#/agents" label="Agents" />
      <H1>Link Pitcrew</H1>
      <Lede>Pitcrew shows your inbox as pit stops and the digest on the Pit wall. A decision in either closes both.</Lede>
      <Card className="mt-6">
        <p className="hd">With the link token, Pitcrew can</p>
        {LINK_CAN.map((s) => <div key={s} className="rw items-start"><Dot color="var(--ink-2)" className="mt-[7px]" /><span>{s}</span></div>)}
        <p className="rw text-ink-3">It can’t read your memories itself. Crew members read only through their own tokens and grants.</p>
      </Card>
      {error && <p role="alert" className="text-[13px] text-bad mt-4">{error}</p>}
      <div className="mt-6 flex items-center gap-2">
        <Btn lg kind="primary" disabled={busy} onClick={link}>{busy ? "Making the token…" : "Link Pitcrew and make its token"}</Btn>
        <LinkBtn lg kind="quiet" href="#/agents">Cancel</LinkBtn>
      </div>
    </div>
  );
}

/** The raw link token lives only here; Engram keeps a fingerprint. */
export function LinkReveal({ t, onDone }: { t: NewToken; onDone: () => void }) {
  const [copied, setCopied] = useState<string | null>(null);
  const url = window.location.origin;
  async function copy(what: string, text: string) {
    try { await navigator.clipboard.writeText(text); setCopied(what); } catch { setCopied(null); }
  }
  return (
    <Card hot className="mb-6 p-5 max-w-[760px]">
      <p className="flex items-center gap-2 text-[13.5px]"><Dot color="var(--signal)" />
        In Pitcrew, open Settings, then Engram, and paste these two. Engram shows the token once.
      </p>
      <div className="mt-4 flex flex-col gap-3">
        {([["Engram address", "url", url], ["Link token", "token", t.token]] as const).map(([label, key, value]) => (
          <div key={key}>
            <p className="text-[12.5px] text-ink-3 mb-1.5">{label}</p>
            <div className="flex items-center gap-2">
              <code className="flex-1 min-w-0 rounded-[10px] bg-surface-2 px-3 py-2.5 font-mono text-[12.5px] break-all select-all">{value}</code>
              <Btn kind={key === "token" ? "primary" : "ghost"} onClick={() => copy(key, value)}>{copied === key ? "Copied" : "Copy"}</Btn>
            </div>
          </div>
        ))}
      </div>
      <div className="mt-5 flex items-center gap-3">
        <Btn kind="primary" lg onClick={onDone}>I’ve saved it</Btn>
        <span className="text-[12.5px] text-ink-3">Lost it later? Make a new token here; the old one stops working.</span>
      </div>
    </Card>
  );
}
