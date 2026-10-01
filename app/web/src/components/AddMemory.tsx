import { useEffect, useRef, useState, type FormEvent } from "react";
import { SCOPES, type Scope } from "../../../shared/types";
import { api } from "../lib/api";
import { invalidateAreas, useAreaList } from "../lib/directory";
import { SCOPE_LABEL } from "../lib/labels";
import { Btn } from "./ui";

/** "Add to Engram": a memory you write yourself is accepted directly (source kind `you`). */
export function AddMemory({ open, area, onClose, onAdded }: {
  open: boolean; area?: string; onClose: () => void; onAdded: (areaName: string) => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const areas = useAreaList();
  const [text, setText] = useState("");
  const [slug, setSlug] = useState(area ?? "");
  const [scope, setScope] = useState<Scope>("personal");
  const [until, setUntil] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      setText(""); setUntil(""); setError(null); setScope("personal");
      setSlug(area ?? "");
      d.showModal();
    } else if (!open && d.open) d.close();
  }, [open, area]);

  useEffect(() => { if (!slug && areas.length) setSlug(areas[0].slug); }, [areas, slug]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!text.trim() || !slug) return;
    setBusy(true); setError(null);
    try {
      await api.addMemory({ text: text.trim(), area: slug, scope, valid_until: until || null });
      invalidateAreas();
      onAdded(areas.find((a) => a.slug === slug)?.name ?? slug);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <dialog ref={ref} onClose={onClose} aria-labelledby="add-title"
      className="m-auto w-[min(520px,calc(100vw-32px))] rounded-[14px] bg-surface border border-line text-ink p-0 backdrop:bg-black/50">
      <form onSubmit={submit} className="p-6 flex flex-col gap-4">
        <div>
          <h2 id="add-title" className="text-[20px] font-semibold tracking-[-0.015em]">Add to Engram</h2>
          <p className="text-[13px] text-ink-3 mt-1">Write one thing that’s true. It’s saved as yours, and agents with a grant for its scope can read it.</p>
        </div>
        <label className="flex flex-col gap-1.5 text-[13px] text-ink-3">
          What’s true
          <textarea required autoFocus rows={3} value={text} onChange={(e) => setText(e.target.value)} className="field"
            placeholder="e.g. Rent is due by the 5th of each month" />
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className="flex flex-col gap-1.5 text-[13px] text-ink-3">
            Area
            <select required value={slug} onChange={(e) => setSlug(e.target.value)} className="field">
              {areas.length === 0 && <option value="">No areas yet</option>}
              {areas.map((a) => <option key={a.slug} value={a.slug}>{a.name}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-1.5 text-[13px] text-ink-3">
            Scope
            <select value={scope} onChange={(e) => setScope(e.target.value as Scope)} className="field">
              {SCOPES.map((s) => <option key={s} value={s}>{SCOPE_LABEL[s]}{s === "private" ? " · only you" : ""}</option>)}
            </select>
          </label>
        </div>
        <label className="flex flex-col gap-1.5 text-[13px] text-ink-3">
          Good until (optional)
          <input type="date" value={until} onChange={(e) => setUntil(e.target.value)} className="field" />
        </label>
        {error && <p role="alert" className="text-[13px] text-bad">{error}</p>}
        <div className="flex items-center gap-2 justify-end">
          <Btn kind="quiet" onClick={onClose}>Cancel</Btn>
          <button type="submit" disabled={busy || !text.trim() || !slug} className="bt bt-lg bt-primary">{busy ? "Adding…" : "Add"}</button>
        </div>
      </form>
    </dialog>
  );
}
