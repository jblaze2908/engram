import { useEffect, useState, type AnchorHTMLAttributes, type ButtonHTMLAttributes, type ReactNode } from "react";

export function cx(...c: (string | false | null | undefined)[]): string {
  return c.filter(Boolean).join(" ");
}

/** The Engram mark. `mono` makes the dot take the stroke colour, so orange in the app only ever means "needs you". */
export function Logo({ size = 22, wordmark = false, mono = false }: { size?: number; wordmark?: boolean; mono?: boolean }) {
  return (
    <span className="inline-flex items-center gap-[5px] text-ink">
      <svg viewBox="0 0 64 64" width={size} height={size} aria-hidden="true" className="flex-none">
        <path d="M13 32H51A19 19 0 1 0 41.5 48.5" fill="none" stroke="currentColor" strokeWidth={6} strokeLinecap="round" strokeLinejoin="round" />
        <circle cx={48.5} cy={41.5} r={3.6} fill={mono ? "currentColor" : "var(--signal)"} />
      </svg>
      {wordmark && <b className="font-semibold tracking-[-0.035em]" style={{ fontSize: size * 0.73 }}>engram</b>}
    </span>
  );
}

export function Dot({ color, className }: { color: string; className?: string }) {
  return <span className={cx("dot", className)} style={{ background: color }} aria-hidden="true" />;
}

export function Card({ children, className, hot }: { children: ReactNode; className?: string; hot?: boolean }) {
  return <div className={cx("cd", hot && "cd-hot", className)}>{children}</div>;
}

export function CardHead({ left, right }: { left: ReactNode; right?: ReactNode }) {
  return <div className="hd"><span>{left}</span>{right !== undefined && <span>{right}</span>}</div>;
}

type BtnKind = "primary" | "ghost" | "quiet" | "danger";
const BTN: Record<BtnKind, string> = {
  primary: "bt-primary",
  ghost: "bt-ghost",
  quiet: "bt-quiet",
  danger: "text-bad shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--bad)_50%,transparent)] hover:bg-surface-2",
};

export function Btn({ kind = "ghost", lg, className, ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { kind?: BtnKind; lg?: boolean }) {
  return <button type="button" {...p} className={cx("bt", lg && "bt-lg", BTN[kind], className)} />;
}

export function LinkBtn({ kind = "ghost", lg, className, ...p }: AnchorHTMLAttributes<HTMLAnchorElement> & { kind?: BtnKind; lg?: boolean }) {
  return <a {...p} className={cx("bt", lg && "bt-lg", BTN[kind], className)} />;
}

/** A plain-sentence empty state. */
export function Empty({ title, children, className }: { title?: string; children?: ReactNode; className?: string }) {
  return (
    <div className={cx("px-5 py-6 text-[13.5px] text-ink-2 leading-relaxed", className)}>
      {title && <p className="text-ink text-[15px] font-medium mb-1">{title}</p>}
      {children}
    </div>
  );
}

/** Shown only after a short delay, so fast loads don't flash. */
export function Loading({ label = "Loading" }: { label?: string }) {
  const [show, setShow] = useState(false);
  useEffect(() => { const t = setTimeout(() => setShow(true), 250); return () => clearTimeout(t); }, []);
  return <p role="status" className={cx("px-5 py-6 text-[13px] text-ink-3", !show && "invisible")}>{label}…</p>;
}

export function ErrorNote({ error, onRetry }: { error: string; onRetry?: () => void }) {
  return (
    <div role="alert" className="px-5 py-5 text-[13.5px] text-ink-2 flex items-center gap-3 flex-wrap">
      <Dot color="var(--bad)" />
      <span className="flex-1 min-w-0">{error}</span>
      {onRetry && <Btn onClick={onRetry}>Try again</Btn>}
    </div>
  );
}

export interface Crumb { label: string; href?: string }
export function Breadcrumb({ items }: { items: Crumb[] }) {
  return (
    <nav aria-label="Breadcrumb" className="text-[13px] text-ink-3 min-w-0 truncate">
      {items.map((c, i) => {
        const last = i === items.length - 1;
        return (
          <span key={i}>
            {i > 0 && <span className="mx-1.5" aria-hidden="true">/</span>}
            {c.href && !last ? <a href={c.href} className="hover:text-ink-2">{c.label}</a> : <span className={last ? "text-ink-2" : ""} aria-current={last ? "page" : undefined}>{c.label}</span>}
          </span>
        );
      })}
    </nav>
  );
}

export function SearchIcon() {
  return (
    <svg viewBox="0 0 24 24" className="w-[16px] h-[16px] flex-none" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" aria-hidden="true">
      <circle cx="11" cy="11" r="6.5" /><path d="M16 16l4 4" />
    </svg>
  );
}

/** Search box; submits on Enter, and "/" focuses it from anywhere on the page. */
export function SearchField({ value, placeholder, onSubmit, onChange, className, label }: {
  value?: string; placeholder: string; label: string; className?: string;
  onSubmit?: (q: string) => void; onChange?: (q: string) => void;
}) {
  const [q, setQ] = useState(value ?? "");
  useEffect(() => { setQ(value ?? ""); }, [value]);
  const [el, setEl] = useState<HTMLInputElement | null>(null);
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (e.key !== "/" || !el || t?.closest("input,textarea,select,[contenteditable]")) return;
      e.preventDefault();
      el.focus();
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, [el]);
  return (
    <form role="search" className={cx("h-[40px] rounded-[10px] bg-surface border border-line flex items-center gap-2 px-3 text-[13.5px] text-ink-3 focus-within:border-line-2", className)}
      onSubmit={(e) => { e.preventDefault(); onSubmit?.(q.trim()); }}>
      <SearchIcon />
      <input ref={setEl} type="search" aria-label={label} value={q} placeholder={placeholder}
        onChange={(e) => { setQ(e.target.value); onChange?.(e.target.value); }}
        className="flex-1 min-w-0 bg-transparent text-ink placeholder:text-ink-3 outline-none focus-visible:outline-none" />
      <span className="font-mono text-[11px]" aria-hidden="true">/</span>
    </form>
  );
}

export function Toggle({ on, onChange, label, disabled }: { on: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} disabled={disabled} onClick={() => onChange(!on)}
      className={cx("relative inline-block w-[34px] h-[20px] rounded-full align-middle transition-colors", on ? "bg-ink" : "bg-surface-3")}>
      <span className={cx("absolute top-[3px] w-[14px] h-[14px] rounded-full transition-[left]", on ? "left-[17px] bg-ground" : "left-[3px] bg-ink-3")} />
    </button>
  );
}

/** Numbered lines, for SKILL.md and compiled profiles. */
export function Lines({ text, mark }: { text: string; mark?: Set<number> }) {
  const lines = text.replace(/\n$/, "").split("\n");
  return (
    <div className="px-2 pb-4">
      {lines.map((l, i) => (
        <div key={i} className="ln" style={mark?.has(i + 1) ? { background: "color-mix(in srgb,var(--warn) 10%,transparent)", borderRadius: 6 } : undefined}>
          <span>{i + 1}</span>
          <span className={/^#{1,6}\s/.test(l) ? "text-ink" : /^(---|<!--)/.test(l) ? "text-ink-3" : ""}>{l || " "}</span>
        </div>
      ))}
    </div>
  );
}

/** Left list pane of a list + detail screen. */
export function ListPane({ title, sub, top, children, foot, width = 340 }: {
  title: ReactNode; sub?: ReactNode; top?: ReactNode; children: ReactNode; foot?: ReactNode; width?: number;
}) {
  return (
    <section className="w-full wide:w-[var(--w)] wide:shrink-0 wide:border-r border-line px-4 pt-8 pb-6 flex flex-col min-h-0 wide:h-full" style={{ ["--w" as string]: `${width}px` }}>
      <h1 className="text-[22px] font-semibold tracking-[-0.02em] px-3">{title}</h1>
      {sub && <p className="text-[13px] text-ink-3 px-3 mt-1">{sub}</p>}
      {top}
      <div className="mt-4 flex flex-col gap-0.5 wide:overflow-y-auto wide:flex-1 min-h-0 -mx-1 px-1">{children}</div>
      {foot && <div className="mt-4 px-3 text-[12.5px] text-ink-3">{foot}</div>}
    </section>
  );
}

/** Main detail column. */
export function Main({ children, className }: { children: ReactNode; className?: string }) {
  return <main className={cx("flex-1 min-w-0 px-4 wide:px-12 pt-6 wide:pt-9 pb-8 flex flex-col wide:h-full wide:overflow-y-auto", className)}>{children}</main>;
}

/** List + detail. On a phone only one pane shows: the list until something is picked. */
export function Split({ list, detail, picked }: { list: ReactNode; detail: ReactNode; picked: boolean }) {
  return (
    <div className="flex flex-1 min-w-0 min-h-0 wide:h-full">
      <div className={cx("contents", picked && "max-wide:hidden")}>{list}</div>
      <div className={cx("contents", !picked && "max-wide:hidden")}>{detail}</div>
    </div>
  );
}

export function BackLink({ href, label }: { href: string; label: string }) {
  return <a href={href} className="wide:hidden text-[13px] text-ink-3 mb-3 inline-flex items-center gap-1.5 hover:text-ink-2">← {label}</a>;
}

export function H1({ children, className }: { children: ReactNode; className?: string }) {
  return <h1 className={cx("text-[26px] wide:text-[34px] font-semibold tracking-[-0.025em] leading-tight", className)}>{children}</h1>;
}

export function Lede({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={cx("text-[15px] text-ink-2 mt-1.5 leading-relaxed max-w-[720px]", className)}>{children}</p>;
}
