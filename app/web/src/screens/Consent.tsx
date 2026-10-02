import { useEffect, useState } from "react";
import type { Grant, ProfileTarget } from "../../../shared/types";
import { api } from "../lib/api";
import { TARGET_LABEL, TARGETS } from "../lib/labels";
import { useLoad } from "../lib/useLoad";
import { Btn, Card, ErrorNote, Loading, Logo } from "../components/ui";
import { GrantTable, normalise } from "./Agents";

/** The OAuth consent step: who is asking, where the answer goes, and what it may see. Private is never offered. */
export function Consent({ id }: { id: string }) {
  const load = useLoad(() => api.consent(id), [id]);
  const [grants, setGrants] = useState<Grant[]>(() => normalise([{ scope: "personal", read: true, write: "propose" }]));
  const [profile, setProfile] = useState<ProfileTarget>("claude-code");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const r = load.data;
  useEffect(() => { if (r?.agent) { setGrants(normalise(r.agent.grants)); setProfile(r.agent.profile); } }, [r]);

  async function answer(allow: boolean) {
    setBusy(true); setError(null);
    try {
      const { redirect } = allow ? await api.approveConsent(id, { grants: grants.filter((g) => g.scope !== "private"), profile }) : await api.denyConsent(id);
      window.location.assign(redirect);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); setBusy(false); }
  }

  return (
    <main className="min-h-full flex justify-center px-4 py-12">
      <div className="w-full max-w-[640px]">
        <Logo size={30} wordmark mono />
        {!r ? <div className="mt-8">{load.error ? <ErrorNote error={load.error} /> : <Loading />}</div> : (
          <>
            <h1 className="text-[28px] font-semibold tracking-[-0.025em] mt-8 leading-tight">Connect {r.name} to Engram?</h1>
            <p className="text-[14px] text-ink-2 mt-2 leading-relaxed">
              It asked to use Engram over MCP. Allowing sends you back to <span className="font-semibold text-ink">{r.redirect_host}</span>.
              If you didn’t start this from {r.name}, deny it.
            </p>
            <p className="font-mono text-[12px] text-ink-3 mt-2 break-all">{r.redirect_uri}</p>
            {r.agent && <p className="text-[13.5px] text-ink-2 mt-4">It’s already connected as {r.agent.name}; allowing replaces what it can see.</p>}
            <Card className="mt-6 p-5">
              <label className="flex flex-col gap-1.5 text-[13px] text-ink-3 max-w-[280px]">
                Profile it gets
                <select value={profile} disabled={busy} onChange={(e) => setProfile(e.target.value as ProfileTarget)} className="field">
                  {TARGETS.map((t) => <option key={t} value={t}>{TARGET_LABEL[t]}</option>)}
                </select>
              </label>
            </Card>
            <p className="text-[13px] text-ink-3 mt-6 mb-2 px-1">What it can see</p>
            <GrantTable grants={grants} onChange={setGrants} disabled={busy} />
            <p className="text-[12.5px] text-ink-3 mt-3 px-1">Tools from your connections can be granted later in Agents. You can revoke it there at any time.</p>
            {error && <p role="alert" className="text-[13px] text-bad mt-4">{error}</p>}
            <div className="mt-6 flex items-center gap-2">
              <Btn kind="primary" lg disabled={busy} onClick={() => answer(true)}>{busy ? "Connecting…" : `Allow ${r.name}`}</Btn>
              <Btn lg disabled={busy} onClick={() => answer(false)}>Deny</Btn>
            </div>
          </>
        )}
      </div>
    </main>
  );
}
