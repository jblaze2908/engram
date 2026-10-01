import type { Status as S } from "../../../shared/types";
import { api } from "../lib/api";
import { ago, clock, longDate, num, plural, shortDate, span } from "../lib/format";
import { hueColor } from "../lib/labels";
import { useLoad } from "../lib/useLoad";
import { Btn, Card, CardHead, Dot, Empty, ErrorNote, H1, LinkBtn, Loading, Main } from "../components/ui";

function headline(s: S): string {
  const n = s.attention.length;
  if (n === 0) return "Engram is up. Nothing needs you.";
  const words = ["", "One thing needs", "Two things need", "Three things need"];
  return `Engram is up. ${words[n] ?? `${n} things need`} a look.`;
}

function when(ms: number | null): string {
  if (!ms) return "Not yet";
  const today = new Date().toDateString() === new Date(ms).toDateString();
  return today ? `Today, ${clock(ms)}` : `${shortDate(ms)}, ${clock(ms)}`;
}

export function Status() {
  const load = useLoad(() => api.status(), []);
  const s = load.data;
  const now = new Date();
  return (
    <Main>
      <div className="flex items-start justify-between gap-4">
        <p className="text-[13px] text-ink-3">{longDate(now.getTime())} · {clock(now.getTime())}</p>
        <SignOut />
      </div>
      {!s ? (load.error ? <ErrorNote error={load.error} onRetry={load.reload} /> : <Loading />) : (
        <>
          <H1 className="mt-2">{headline(s)}</H1>
          <p className="text-[15px] text-ink-2 mt-2">
            {s.calls_today ? `${plural(s.calls_today, "call")} from agents today${s.refused_today ? `, ${s.refused_today} refused` : ""}.` : "No agent has called yet today."}
          </p>

          <div className="grid grid-cols-2 wide:grid-cols-4 gap-3 mt-7">
            <Stat ok label="Endpoint" big={`Up ${span(s.up_since)}`} small={`${plural(s.calls_today, "call")} today`} />
            <Stat ok={s.last_index !== null} label="Index" big={plural(s.memories, "memory", "memories")}
              small={s.last_index ? `Rebuilt ${clock(s.last_index)} · ${num(s.new_this_week)} new this week` : "Not built yet"} />
            <Stat ok={s.last_backup !== null} warn={s.last_backup === null} label="Backup" big={when(s.last_backup)}
              small={s.last_backup ? "Encrypted copy of the vault" : "Backups start once the vault has something in it"} />
            <Stat ok={s.pitcrew_linked} label="Pitcrew" big={s.pitcrew_linked ? "Linked" : "Not linked"}
              small={s.pitcrew_linked ? "Inbox and digest mirrored" : "Link it in Agents"} />
          </div>

          <div className="grid grid-cols-1 wide:grid-cols-[1fr_400px] gap-3 mt-3 flex-1 min-h-0">
            <div className="flex flex-col gap-3 min-h-0">
              <Card>
                <CardHead left="Needs a look" right={s.attention.length || undefined} />
                {s.attention.length === 0 && <p className="rw text-ink-2">Nothing. When a sign-in runs out or a tool changes, it shows up here.</p>}
                {s.attention.map((a, i) => (
                  <div key={i} className="rw">
                    <Dot color={a.level === "signal" ? "var(--signal)" : "var(--warn)"} />
                    <div className="flex-1 min-w-0"><p>{a.title}</p><p className="text-[12.5px] text-ink-3 mt-0.5">{a.detail}</p></div>
                    <LinkBtn href={a.href.startsWith("/") ? `#${a.href}` : a.href}>{a.action}</LinkBtn>
                  </div>
                ))}
              </Card>
              <Card className="flex-1 flex flex-col min-h-[220px]">
                <CardHead left="Calls today" right={<span className="text-ink-2">{num(s.calls_today)} so far{s.refused_today ? ` · ${s.refused_today} refused` : ""}</span>} />
                <Hours hours={s.calls_by_hour} />
              </Card>
            </div>
            <div className="flex flex-col gap-3 min-h-0">
              <Card>
                <CardHead left="Agents" right="calls today" />
                {s.agents.length === 0 && (
                  <Empty className="border-t border-line">No agents yet. <a className="text-data hover:underline" href="#/agents/new">Add one</a> to give it a token for the MCP endpoint.</Empty>
                )}
                {s.agents.map((a) => (
                  <a key={a.id} href={`#/agents/${encodeURIComponent(a.id)}`} className="rw hover:bg-surface-2">
                    <Dot color={hueColor(a.hue)} />
                    <span className={a.calls_today ? "flex-1" : "flex-1 text-ink-2"}>{a.name}</span>
                    <span className="text-[12.5px] text-ink-3 w-[90px]">{ago(a.last_used_at)}</span>
                    <span className={`font-mono text-[12.5px] w-[28px] text-right ${a.calls_today ? "" : "text-ink-3"}`}>{a.calls_today}</span>
                  </a>
                ))}
                {s.refused_today > 0 && (
                  <a href="#/trace?result=refused" className="rw text-[12.5px] text-ink-3 hover:bg-surface-2">
                    <Dot color="var(--signal)" /><span className="flex-1">{plural(s.refused_today, "call was", "calls were")} refused today</span><span className="text-ink-2">Trace</span>
                  </a>
                )}
              </Card>
              <Card className="p-5 flex items-center justify-between gap-3 wide:mt-auto">
                <div>
                  <p className="text-[15px] font-medium">Your week</p>
                  <p className="text-[12.5px] text-ink-3 mt-0.5">What’s waiting, what runs out, and open loops. Written Sundays at 19:00.</p>
                </div>
                <LinkBtn href="#/digest">Digest</LinkBtn>
              </Card>
              <Card className="p-5 flex items-center justify-between gap-3">
                <div>
                  <p className="text-[15px] font-medium">{s.inbox.open + s.inbox.held ? `${num(s.inbox.open + s.inbox.held)} waiting in your inbox` : "Your inbox is empty"}</p>
                  <p className="text-[12.5px] text-ink-3 mt-0.5">{s.inbox.held ? `${num(s.inbox.held)} held from untrusted content` : "Agents’ proposals land there."}</p>
                </div>
                <LinkBtn kind="primary" href="#/inbox">Open inbox</LinkBtn>
              </Card>
            </div>
          </div>
        </>
      )}
    </Main>
  );
}

function Stat({ label, big, small, ok, warn }: { label: string; big: string; small: string; ok: boolean; warn?: boolean }) {
  return (
    <Card className="p-5">
      <p className="text-[13px] text-ink-3 flex items-center gap-2"><Dot color={ok ? "var(--in)" : warn ? "var(--warn)" : "var(--ink-3)"} />{label}</p>
      <p className="text-[20px] wide:text-[22px] font-semibold mt-2">{big}</p>
      <p className="text-[12.5px] text-ink-3 mt-1">{small}</p>
    </Card>
  );
}

function Hours({ hours }: { hours: number[] }) {
  const h = Array.from({ length: 24 }, (_, i) => hours[i] ?? 0);
  const max = Math.max(1, ...h);
  const cur = new Date().getHours();
  return (
    <div className="px-5 pb-4 pt-4 flex-1 flex flex-col min-h-0">
      <div className="flex items-end gap-[5px] flex-1 min-h-[120px]" role="img"
        aria-label={`Calls per hour today, most at ${h.indexOf(Math.max(...h))}:00`}>
        {h.map((v, i) => (
          <i key={i} className="flex-1 rounded-t-[4px] min-h-[2px]"
            style={{ height: v ? `${Math.max(2, (v / max) * 100)}%` : 2, background: i > cur ? "var(--surface-3)" : i === cur ? "var(--ink)" : "var(--ink-2)" }} />
        ))}
      </div>
      <div className="flex justify-between font-mono text-[11px] text-ink-3 mt-2" aria-hidden="true">
        <span>00</span><span>06</span><span>12</span><span>18</span><span>24</span>
      </div>
    </div>
  );
}

function SignOut() {
  return (
    <Btn kind="quiet" onClick={() => { api.logout().finally(() => window.location.reload()); }}>Sign out</Btn>
  );
}
