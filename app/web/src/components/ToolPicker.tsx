import { useState } from "react";
import type { Agent } from "../../../shared/types";
import { api } from "../lib/api";
import { useLoad } from "../lib/useLoad";
import { Btn, Card, CardHead, cx } from "./ui";

/** Which upstream tools an agent may call, per connection. Write tools are only ever ticked one by one. */
export function ToolPicker({ a, onChanged }: { a: Agent; onChanged: (a: Agent) => void }) {
  const conns = useLoad(() => api.connections(), []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const granted = new Set(a.tools ?? []);

  async function save(next: Set<string>) {
    setBusy(true); setError(null);
    try { onChanged(await api.setAgentTools(a.id, [...next])); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  }
  const toggle = (g: string, on: boolean) => { const n = new Set(granted); if (on) n.add(g); else n.delete(g); save(n); };

  const list = conns.data ?? [];
  return (
    <Card>
      <CardHead left="Upstream tools" right={granted.size ? `${granted.size} granted` : "none"} />
      {conns.data && list.length === 0 && (
        <p className="px-[18px] pb-4 text-[13px] text-ink-2 leading-relaxed">Nothing connected yet. <a className="text-data hover:underline" href="#/connections">Add a connection</a>, then choose which of its tools {a.name} may call.</p>
      )}
      {list.map((c) => {
        const reads = c.tools.filter((t) => t.kind === "read").map((t) => `${c.id}/${t.name}`);
        const allReads = reads.length > 0 && reads.every((g) => granted.has(g));
        return (
          <div key={c.id} className="border-t border-line">
            <div className="flex items-center gap-2 px-[18px] pt-3 pb-1.5">
              <span className="flex-1 text-[13.5px]">{c.name}</span>
              {reads.length > 0 && (
                <Btn kind="quiet" className="h-[26px] px-2 text-[12px]" disabled={busy || a.revoked}
                  onClick={() => { const n = new Set(granted); for (const g of reads) allReads ? n.delete(g) : n.add(g); save(n); }}>
                  {allReads ? "No read tools" : "All read tools"}
                </Btn>
              )}
            </div>
            {c.tools.map((t) => {
              const g = `${c.id}/${t.name}`;
              return (
                <label key={t.name} className={cx("flex items-center gap-2.5 px-[18px] py-1.5 text-[12.5px] cursor-pointer hover:bg-surface-2", t.changed && "opacity-60")}>
                  <input type="checkbox" className="accent-[var(--ink)]" checked={granted.has(g)} disabled={busy || a.revoked} onChange={(e) => toggle(g, e.target.checked)} />
                  <span className="flex-1 font-mono truncate">{t.name}</span>
                  <span className="text-ink-3" style={t.changed ? { color: "var(--signal)" } : t.kind === "write" ? { color: "var(--warn)" } : undefined}>{t.changed ? "blocked" : t.kind}</span>
                </label>
              );
            })}
            <div className="h-2" />
          </div>
        );
      })}
      {list.length > 0 && <p className="px-[18px] pb-3 text-[12.5px] text-ink-3">Changes apply when {a.name} starts a new session.</p>}
      {error && <p role="alert" className="px-[18px] pb-3 text-[13px] text-bad">{error}</p>}
    </Card>
  );
}
