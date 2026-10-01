import type { ReactNode } from "react";
import { cx, Logo } from "./ui";

const I = (d: ReactNode) => (
  <svg viewBox="0 0 24 24" className="w-[18px] h-[18px]" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{d}</svg>
);

export type Section = "inbox" | "status" | "context" | "trace" | "connections" | "skills" | "agents";

const ITEMS: { id: Section; label: string; icon: ReactNode; gapBefore?: boolean }[] = [
  { id: "inbox", label: "Inbox", icon: I(<path d="M4 13l3-8h10l3 8v6H4zM4 13h5l1 3h4l1-3h5" />) },
  { id: "status", label: "Status", icon: I(<path d="M4 12h4l2-6 4 12 2-6h4" />) },
  { id: "context", label: "Context", icon: I(<><rect x="5" y="4" width="14" height="16" rx="2" /><path d="M9 8h6M9 12h6M9 16h3" /></>) },
  { id: "trace", label: "Trace", icon: I(<><circle cx="6" cy="6" r="2" /><circle cx="18" cy="18" r="2" /><path d="M6 8v4a4 4 0 004 4h6" /></>) },
  { id: "connections", label: "Connect", icon: I(<path d="M9 3v5M15 3v5M6 8h12v3a6 6 0 01-12 0zM12 17v4" />), gapBefore: true },
  { id: "skills", label: "Skills", icon: I(<path d="M12 3l2.4 5.6L20 9.3l-4.2 3.9 1.1 5.8L12 16.2 7.1 19l1.1-5.8L4 9.3l5.6-.7z" />) },
  { id: "agents", label: "Agents", icon: I(<><circle cx="8" cy="14" r="4" /><path d="M11 11l8-8M16 6l2 2" /></>) },
];

const tile = "relative flex flex-col items-center justify-center gap-[5px] rounded-[12px] text-[10.5px] font-medium leading-none text-ink-3 hover:text-ink-2";

/** The labelled icon rail; becomes a bottom bar on a phone. Only a real inbox count lights the orange dot. */
export function Rail({ active, inbox, up, onAdd }: { active: Section | null; inbox: number | null; up: boolean; onAdd: () => void }) {
  return (
    <nav aria-label="Main"
      className="flex-none bg-ground z-20 border-line
        fixed bottom-0 inset-x-0 h-[64px] border-t flex flex-row items-center justify-around px-1 pb-[env(safe-area-inset-bottom)]
        wide:static wide:w-[76px] wide:h-full wide:border-t-0 wide:border-r wide:flex-col wide:justify-start wide:gap-[2px] wide:py-[18px] wide:px-0">
      <a href="#/status" aria-label="Engram status"
        className="max-wide:hidden w-[44px] flex justify-center pb-4 mb-3 border-b border-line text-ink">
        <Logo size={22} mono />
      </a>
      {ITEMS.map((it) => {
        const on = it.id === active;
        const showDot = it.id === "inbox" && !!inbox;
        return (
          <a key={it.id} href={`#/${it.id}`} aria-current={on ? "page" : undefined}
            className={cx(tile, "w-[48px] h-[52px] wide:w-[62px] wide:h-[54px]", it.gapBefore && "wide:mt-[14px]", it.id === "trace" && "max-wide:hidden", on && "bg-surface-2 text-ink hover:text-ink")}>
            {it.icon}
            {it.label}
            {showDot && <i className="absolute top-[7px] right-[12px] wide:right-[15px] w-[7px] h-[7px] rounded-full bg-signal" />}
            {showDot && <span className="sr-only">, {inbox} waiting</span>}
          </a>
        );
      })}
      <button type="button" onClick={onAdd} className={cx(tile, "w-[48px] h-[52px] wide:w-[62px] wide:h-[54px] wide:mt-[14px]")}>
        {I(<path d="M12 5v14M5 12h14" />)}
        Add
      </button>
      <span className="max-wide:hidden mt-auto w-[8px] h-[8px] rounded-full" style={{ background: up ? "var(--in)" : "var(--ink-3)" }}
        role="img" aria-label={up ? "Engram is up" : "Engram isn’t answering"} title={up ? "Engram is up" : "Engram isn’t answering"} />
    </nav>
  );
}
