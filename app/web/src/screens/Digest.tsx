import type { Digest } from "../../../shared/types";
import { api } from "../lib/api";
import { useAreaName } from "../lib/directory";
import { clock, plural, shortDate, untilLabel } from "../lib/format";
import { href } from "../lib/router";
import { useLoad } from "../lib/useLoad";
import { BackLink, Card, CardHead, Dot, ErrorNote, H1, Lede, LinkBtn, ListPane, Loading, Main, Split } from "../components/ui";

const noon = (iso: string) => `${iso}T12:00:00`;
const weekLabel = (w: string, current?: string) => (w === current ? "This week" : `Week ${Number(w.slice(6))}, ${w.slice(0, 4)}`);
const dayLabel = (iso: string) => new Date(noon(iso)).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "short" });

function summary(d: Digest): string {
  const waiting = d.waiting.open + d.waiting.held;
  const parts = [
    waiting ? `${plural(waiting, "thing is", "things are")} waiting for you${d.waiting.held ? `, ${d.waiting.held} held for review` : ""}.` : "Nothing is waiting for you.",
    d.runningOut.length ? `${plural(d.runningOut.length, "memory runs", "memories run")} out in the next 30 days.` : "Nothing runs out in the next 30 days.",
    d.openLoops.length ? `${plural(d.openLoops.length, "loop is", "loops are")} still open.` : "",
  ];
  return parts.filter(Boolean).join(" ");
}

export function DigestPage({ week }: { week?: string }) {
  const weeks = useLoad(() => api.digestWeeks(), []);
  const load = useLoad(() => api.digest(week), [week]);
  const current = weeks.data?.[0];
  const d = load.data;
  return (
    <Split picked={!!week}
      list={
        <ListPane title="Digest" sub="Your week, written every Sunday at 19:00."
          foot="Private memories never appear here, because Pitcrew shows the digest too.">
          {!weeks.data && (weeks.error ? <ErrorNote error={weeks.error} onRetry={weeks.reload} /> : <Loading />)}
          {weeks.data?.map((w) => (
            <a key={w} href={href(["digest"], { week: w === current ? null : w })} className="it" aria-current={w === (d?.week ?? current) ? "true" : undefined}>
              <span>{weekLabel(w, current)}</span>
            </a>
          ))}
        </ListPane>
      }
      detail={
        <Main>
          {!d ? (load.error ? <ErrorNote error={load.error} onRetry={load.reload} /> : <Loading />) : <Week d={d} current={d.week === current} />}
        </Main>
      } />
  );
}

function Week({ d, current }: { d: Digest; current: boolean }) {
  const areaName = useAreaName();
  return (
    <>
      <BackLink href="#/digest" label="Digest" />
      <p className="text-[13px] text-ink-3">
        {shortDate(noon(d.from))} to {shortDate(noon(d.to))} · {current ? `as of ${clock(d.built_at)}` : `written ${shortDate(d.built_at)}`}
      </p>
      <H1 className="mt-2">{current ? "This week" : weekLabel(d.week)}</H1>
      <Lede>{summary(d)}</Lede>
      <div className="grid grid-cols-1 wide:grid-cols-[1fr_360px] gap-3 mt-7">
        <div className="flex flex-col gap-3">
          <Card>
            <CardHead left="What changed" right={d.changed.length || undefined} />
            {d.changed.length === 0 && <p className="rw text-ink-2">No memories were added or forgotten this week.</p>}
            {d.changed.map((c, i) => (
              <div key={i} className="rw items-start">
                <Dot color={c.tone === "bad" ? "var(--bad)" : "var(--ink-2)"} className="mt-[7px]" />
                <div className="flex-1 min-w-0"><p>{c.text}</p><p className="text-[12.5px] text-ink-3 mt-0.5">{c.detail}</p></div>
              </div>
            ))}
          </Card>
          <Card>
            <CardHead left="Journal" right={d.journal.reduce((n, j) => n + j.lines.length, 0) || undefined} />
            {d.journal.length === 0 && <p className="rw text-ink-2">Nothing in the journal this week.</p>}
            {d.journal.map((j) => (
              <div key={j.day} className="px-[18px] py-3 border-t border-line">
                <a href={href(["context", "journal"], { day: j.day })} className="text-[12.5px] text-ink-3 hover:text-ink-2">{dayLabel(j.day)}</a>
                {j.lines.map((l, i) => <p key={i} className="mt-1.5 text-[13.5px]">{l}</p>)}
              </div>
            ))}
          </Card>
        </div>
        <div className="flex flex-col gap-3">
          <Card className="p-5 flex items-center justify-between gap-3">
            <div>
              <p className="text-[15px] font-medium">{d.waiting.open + d.waiting.held ? `${d.waiting.open + d.waiting.held} waiting` : "Nothing waiting"}</p>
              <p className="text-[12.5px] text-ink-3 mt-0.5">{d.waiting.held ? `${d.waiting.held} held for review` : "Your inbox, when this was written."}</p>
            </div>
            <LinkBtn href="#/inbox">Open inbox</LinkBtn>
          </Card>
          <Card>
            <CardHead left="Running out" right={d.runningOut.length || undefined} />
            {d.runningOut.length === 0 && <p className="rw text-ink-2">Nothing runs out in the next 30 days.</p>}
            {d.runningOut.map((r, i) => (
              <div key={i} className="rw items-start">
                <Dot color="var(--warn)" className="mt-[7px]" />
                <div className="flex-1 min-w-0"><p>{r.text}</p><p className="text-[12.5px] text-ink-3 mt-0.5">{areaName(r.area)} · {untilLabel(r.date)}</p></div>
              </div>
            ))}
          </Card>
          <Card>
            <CardHead left="Open loops" right={d.openLoops.length || undefined} />
            {d.openLoops.length === 0 && <p className="rw text-ink-2">No open loops. Open projects and memories tagged #loop show up here.</p>}
            {d.openLoops.map((l, i) => (
              <div key={i} className="rw items-start">
                <Dot color="var(--ink-2)" className="mt-[7px]" />
                <div className="flex-1 min-w-0"><p>{l.text}</p><p className="text-[12.5px] text-ink-3 mt-0.5">{areaName(l.area)}</p></div>
              </div>
            ))}
          </Card>
        </div>
      </div>
    </>
  );
}
