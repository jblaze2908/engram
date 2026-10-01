import { useState, type FormEvent, type InputHTMLAttributes, type ReactNode } from "react";
import { api } from "../lib/api";
import { Logo } from "../components/ui";

function Frame({ title, lede, children }: { title: string; lede: ReactNode; children: ReactNode }) {
  return (
    <main className="min-h-full flex items-center justify-center px-4 py-12">
      <div className="w-full max-w-[400px]">
        <Logo size={30} wordmark mono />
        <h1 className="text-[28px] font-semibold tracking-[-0.025em] mt-8 leading-tight">{title}</h1>
        <p className="text-[14px] text-ink-2 mt-2 leading-relaxed">{lede}</p>
        <div className="cd p-5 mt-6">{children}</div>
      </div>
    </main>
  );
}

function Field({ label, hint, ...p }: InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: string }) {
  return (
    <label className="flex flex-col gap-1.5 text-[13px] text-ink-3">
      {label}
      <input {...p} className="field" />
      {hint && <span className="text-[12px]">{hint}</span>}
    </label>
  );
}

export function Setup({ onDone }: { onDone: () => void }) {
  const [token, setToken] = useState("");
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (pw.length < 12) { setError("Use at least 12 characters."); return; }
    if (pw !== pw2) { setError("The two passwords don’t match."); return; }
    setBusy(true); setError(null);
    try {
      await api.setup(token.trim(), pw);
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally { setBusy(false); }
  }

  return (
    <Frame title="Set up Engram" lede={<>This is the first run. Paste the setup token from <span className="font-mono text-[13px]">setup-token</span> in Engram’s data folder, then choose the password you’ll sign in with.</>}>
      <form onSubmit={submit} className="flex flex-col gap-4">
        <Field label="Setup token" name="token" autoComplete="off" spellCheck={false} required value={token} onChange={(e) => setToken(e.target.value)} />
        <Field label="Password" hint="At least 12 characters." minLength={12} type="password" name="new-password" autoComplete="new-password" required value={pw} onChange={(e) => setPw(e.target.value)} />
        <Field label="Password again" minLength={12} type="password" name="confirm-password" autoComplete="new-password" required value={pw2} onChange={(e) => setPw2(e.target.value)} />
        {error && <p role="alert" className="text-[13px] text-bad">{error}</p>}
        <button type="submit" disabled={busy || !token || !pw} className="bt bt-lg bt-primary w-full">{busy ? "Setting up…" : "Set password and continue"}</button>
      </form>
    </Frame>
  );
}

export function Login({ onDone }: { onDone: () => void }) {
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      await api.login(pw);
      setPw("");
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally { setBusy(false); }
  }

  return (
    <Frame title="Sign in" lede="Engram holds what your agents know about you. Sign in to see it and decide what waits.">
      <form onSubmit={submit} className="flex flex-col gap-4">
        <input type="text" name="username" autoComplete="username" value="engram" readOnly hidden />
        <Field label="Password" type="password" name="password" autoComplete="current-password" autoFocus required value={pw} onChange={(e) => setPw(e.target.value)} />
        {error && <p role="alert" className="text-[13px] text-bad">{error}</p>}
        <button type="submit" disabled={busy || !pw} className="bt bt-lg bt-primary w-full">{busy ? "Signing in…" : "Sign in"}</button>
      </form>
    </Frame>
  );
}

export function Unreachable({ error, onRetry }: { error: string; onRetry: () => void }) {
  return (
    <Frame title="Engram isn’t answering" lede={error}>
      <button type="button" onClick={onRetry} className="bt bt-lg bt-primary w-full">Try again</button>
    </Frame>
  );
}
