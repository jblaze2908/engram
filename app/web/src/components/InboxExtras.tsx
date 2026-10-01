import { useState } from "react";
import type { Decision, Proposal } from "../../../shared/types";
import { api } from "../lib/api";
import { useLoad } from "../lib/useLoad";
import { shortDate, clock } from "../lib/format";
import { Btn, Card, cx, Dot } from "./ui";

type ToolChange = { connection: string; connection_name: string; tool: string; approved: string; now: string };

/** A tool_change proposal: the text you approved next to what the server says now. Keep blocked leads; it is the safe choice. */
export function ToolChangeDetail({ p, busy, error, decide }: { p: Proposal; busy: boolean; error: string | null; decide: (d: Decision) => void }) {
  const d = p.data as ToolChange;
  return (
    <>
      <div className="flex items-center justify-between gap-4 text-[13px] text-ink-3 flex-wrap">
        <span>Tool description changed · {d.connection_name}</span>
        <span className="flex items-center gap-2"><Dot color="var(--signal)" />Blocked for every agent</span>
      </div>
      <h1 className="text-[26px] wide:text-[34px] font-semibold tracking-[-0.025em] leading-tight mt-4">
        <span className="font-mono text-[0.8em]">{d.tool}</span> changed what it says
      </h1>
      <p className="text-[15px] text-ink-2 mt-2 leading-relaxed max-w-[680px]">
        Engram saw new text when it listed {d.connection_name}’s tools on {shortDate(p.created_at)} at {clock(p.created_at)}. No agent can call it until you decide.
      </p>
      <Card className="grid grid-cols-1 wide:grid-cols-2 mt-7">
        <div className="p-6">
          <p className="text-[12.5px] text-ink-3">You approved</p>
          <p className="text-[15px] mt-2 leading-relaxed whitespace-pre-wrap break-words">{d.approved || "(no description)"}</p>
        </div>
        <div className="p-6 border-t wide:border-t-0 wide:border-l border-line" style={{ background: "color-mix(in srgb,var(--signal) 6%,var(--surface))" }}>
          <p className="text-[12.5px]" style={{ color: "var(--signal)" }}>Now says</p>
          <p className="text-[15px] mt-2 leading-relaxed whitespace-pre-wrap break-words">{d.now || "(no description)"}</p>
        </div>
      </Card>
      <p className="text-[13px] text-ink-3 mt-4 max-w-[680px]">New words that tell an agent to read, send or include other things look like an injection, not an update. Approve only text you’d be glad every agent follows.</p>
      {error && <p role="alert" className="text-[13px] text-bad mt-5">{error}</p>}
      <div className="mt-7 flex items-center gap-2 flex-wrap">
        <Btn lg kind="primary" disabled={busy} onClick={() => decide("keep")}>Keep blocked</Btn>
        <Btn lg disabled={busy} onClick={() => decide("accept")}>Approve new text</Btn>
        <a className="ml-auto text-[12.5px] text-ink-3 hover:text-ink-2" href={`#/connections/${encodeURIComponent(d.connection)}`}>Open {d.connection_name}</a>
      </div>
    </>
  );
}

/** For a skill edit that really belongs in the profile: reject it and leave a `see: profile/<file>` line in the skill. */
export function LinkToProfile({ p, onDone }: { p: Proposal; onDone: (msg: string) => void }) {
  const files = useLoad(() => api.profile().then((r) => r.files), []);
  const [file, setFile] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pick = file || files.data?.[0]?.name || "";
  async function link() {
    setBusy(true); setError(null);
    try { await api.linkToProfile(p.id, pick); onDone(`Linked the skill to profile/${pick}.`); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  }
  if (!files.data?.length) return null;
  return (
    <div className={cx("mt-4 flex items-center gap-2 flex-wrap text-[13px] text-ink-3")}>
      <span>Already in your profile?</span>
      <label className="sr-only" htmlFor="link-file">Profile file</label>
      <select id="link-file" value={pick} onChange={(e) => setFile(e.target.value)} className="h-[30px] rounded-[8px] bg-transparent border border-line px-2 text-[13px] text-ink-2">
        {files.data.map((f) => <option key={f.name} value={f.name}>profile/{f.name}</option>)}
      </select>
      <Btn kind="quiet" disabled={busy || !pick} onClick={link}>Link to profile instead</Btn>
      {error && <span role="alert" className="text-bad">{error}</span>}
    </div>
  );
}
