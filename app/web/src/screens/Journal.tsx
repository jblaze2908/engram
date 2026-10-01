import { api } from "../lib/api";
import { useWho } from "../lib/directory";
import { clock, longDate, todayIso } from "../lib/format";
import { href } from "../lib/router";
import { useLoad } from "../lib/useLoad";
import { BackLink, Breadcrumb, Card, CardHead, Dot, Empty, ErrorNote, H1, ListPane, Loading, Main, Split } from "../components/ui";

const dayLabel = (iso: string) => {
  const d = new Date(`${iso}T12:00:00`);
  const s = d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
  return iso === todayIso() ? `Today, ${s}` : s;
};

export function Journal({ day }: { day?: string }) {
  const load = useLoad(() => api.journal(day), [day]);
  const who = useWho();
  const v = load.data;

  return (
    <Split picked={!!day}
      list={
        <ListPane title="Journal" sub="What you and your agents did, day by day."
          foot="Entries only describe. Nothing here becomes a memory unless it’s proposed as one.">
          {!v && (load.error ? <ErrorNote error={load.error} onRetry={load.reload} /> : <Loading />)}
          {v && v.days.length === 0 && <p className="px-3 text-[13px] text-ink-3 leading-relaxed">No days yet. The first entry appears when an agent reports what it did.</p>}
          {v?.days.map((d) => (
            <a key={d.day} href={href(["context", "journal"], { day: d.day })} className="it justify-between items-center" aria-current={d.day === v.day ? "true" : undefined}>
              <span>{dayLabel(d.day)}</span><span className="font-mono text-[12px] text-ink-3">{d.count}</span>
            </a>
          ))}
        </ListPane>
      }
      detail={
        <Main>
          {!v ? (load.error ? <ErrorNote error={load.error} onRetry={load.reload} /> : <Loading />) : (
            <>
              <BackLink href="#/context/journal" label="Journal" />
              <div className="flex items-center justify-between gap-3">
                <Breadcrumb items={[{ label: "Context", href: "#/context" }, { label: "Journal", href: "#/context/journal" }, { label: dayLabel(v.day) }]} />
                <span className="text-[13px] text-ink-3">{v.entries.length} {v.entries.length === 1 ? "entry" : "entries"}</span>
              </div>
              <H1 className="mt-3">{longDate(`${v.day}T12:00:00`)}</H1>
              <div className="grid grid-cols-1 wide:grid-cols-[1fr_320px] gap-3 mt-7 flex-1 min-h-0">
                <Card className="overflow-hidden self-start w-full">
                  {v.entries.length === 0 && <Empty>Nothing written on this day. When you or an agent does something, a line lands here, like “Bills filed the Airtel bill”.</Empty>}
                  {v.entries.map((e, i) => {
                    const w = who(e.who);
                    return (
                      <div key={e.id} className={`grid grid-cols-[52px_16px_1fr] gap-3 px-[18px] py-[13px] ${i ? "border-t border-line" : ""}`}>
                        <span className="font-mono text-[12px] text-ink-3 pt-[2px]">{clock(e.at)}</span>
                        <Dot color={w.color} className="mt-[7px]" />
                        <div>
                          <p><span className="text-ink-3">{w.name}</span> {e.text}</p>
                          {e.outputs.map((o, j) => <a key={j} href={outHref(o.kind, o.ref)} className="out hover:text-ink"><b>{o.kind}</b>{o.label}</a>)}
                        </div>
                      </div>
                    );
                  })}
                </Card>
                <div className="flex flex-col gap-3">
                  <Card>
                    <CardHead left="This week" right={v.week.length || undefined} />
                    {v.week.length === 0 && <p className="rw text-ink-2">The week’s summary is written as days fill in.</p>}
                    {v.week.map((s, i) => <div key={i} className="rw items-start"><Dot color="var(--ink-2)" className="mt-[7px]" /><span>{s}</span></div>)}
                  </Card>
                  <Card className="p-5">
                    <p className="text-[13px] text-ink-3">How agents use this</p>
                    <p className="text-[13.5px] text-ink-2 mt-2 leading-relaxed">“What did I do last week?” searches the journal. Entries only describe; nothing here becomes a memory unless it’s proposed as one.</p>
                  </Card>
                </div>
              </div>
            </>
          )}
        </Main>
      } />
  );
}

function outHref(kind: string, ref: string): string {
  if (kind === "artifact") return href(["context", "artifacts", ref]);
  if (kind === "memory") return href(["context", "memories", ref]);
  if (kind === "skill") return href(["skills", ref]);
  return href(["trace"], { q: ref });
}
