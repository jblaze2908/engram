import type { ProfileTarget } from "../../../shared/types";
import { api } from "../lib/api";
import { num } from "../lib/format";
import { SCOPE_LABEL, TARGET_LABEL, TARGETS } from "../lib/labels";
import { href } from "../lib/router";
import { useLoad } from "../lib/useLoad";
import { BackLink, Breadcrumb, Card, CardHead, cx, Dot, Empty, ErrorNote, H1, Lede, Lines, ListPane, Loading, Main, Split } from "../components/ui";
import { obsidianUrl } from "../lib/obsidian";

export function Profile({ query }: { query: URLSearchParams }) {
  const load = useLoad(() => api.profile(), []);
  const fileName = query.get("file");
  const t = query.get("target") as ProfileTarget | null;
  const v = load.data;
  const compiled = v?.compiled ?? [];
  const target = compiled.find((c) => c.target === t) ?? compiled[0];
  const file = fileName ? v?.files.find((f) => f.name === fileName) : undefined;

  return (
    <Split picked={!!fileName || !!t}
      list={
        <ListPane width={300} title="Profile" sub={v ? `How you work, in ${v.files.length} files` : "How you work"}
          foot="Edit these in the vault. Engram recompiles when they change.">
          {!v && (load.error ? <ErrorNote error={load.error} onRetry={load.reload} /> : <Loading />)}
          {v && v.files.length === 0 && <p className="px-3 text-[13px] text-ink-3">No profile files yet.</p>}
          {v?.files.map((f) => (
            <a key={f.name} href={href(["context", "profile"], { file: f.name })} className="it justify-between" aria-current={f.name === fileName ? "true" : undefined}>
              <span>{f.name}{f.scope !== "personal" && <span className="text-[12px] text-ink-3"> · {f.scope}</span>}</span>
              <span className="font-mono text-[12px] text-ink-3">{f.lines}</span>
            </a>
          ))}
        </ListPane>
      }
      detail={
        <Main>
          {!v ? (load.error ? <ErrorNote error={load.error} onRetry={load.reload} /> : <Loading />) : (
            <>
              <BackLink href="#/context/profile" label="Profile" />
              <Breadcrumb items={[{ label: "Context", href: "#/context" }, { label: "Profile", href: "#/context/profile" }, ...(file ? [{ label: file.name }] : target ? [{ label: TARGET_LABEL[target.target] }] : [])]} />
              <div className="flex items-center gap-3 mt-4 flex-wrap">
                <div role="tablist" aria-label="Agent target" className="inline-flex p-[3px] rounded-[11px] bg-surface flex-wrap">
                  {TARGETS.map((x) => {
                    const on = !file && target?.target === x;
                    const has = compiled.some((c) => c.target === x);
                    return (
                      <a key={x} role="tab" aria-selected={on} href={href(["context", "profile"], { target: x })}
                        className={cx("h-[32px] px-[14px] flex items-center rounded-[8px] text-[13px]", on ? "bg-surface-3 text-ink" : "text-ink-3 hover:text-ink-2", !has && "opacity-60")}>
                        {TARGET_LABEL[x]}
                      </a>
                    );
                  })}
                </div>
              </div>
              {file ? (
                <>
                  <H1 className="mt-6">{file.name}</H1>
                  <Lede>{SCOPE_LABEL[file.scope]} scope · {num(file.lines)} lines. Only agents with a {file.scope} read grant get this part.</Lede>
                  <Card className="mt-6 overflow-hidden">
                    <CardHead left={file.name} right={<span className="flex gap-3"><a className="hover:text-ink-2" href={obsidianUrl(`profile/${file.name}.md`)}>Open in Obsidian</a><span className="font-mono text-[11.5px]">{file.lines} lines</span></span>} />
                    {file.body.trim() ? <Lines text={file.body} /> : <Empty>This file is empty. Write in it from the vault and Engram picks it up.</Empty>}
                  </Card>
                </>
              ) : !target ? (
                <Empty title="Nothing compiled yet." className="mt-6">Once your profile files have something in them, Engram compiles one copy per agent target, within that agent’s grants.</Empty>
              ) : (
                <>
                  <h2 className="text-[26px] wide:text-[30px] font-semibold tracking-[-0.025em] mt-6 leading-tight">What {TARGET_LABEL[target.target]} gets</h2>
                  <Lede>Compiled from your profile files, leaving out any scope this target has no grant for.</Lede>
                  <div className="grid grid-cols-1 wide:grid-cols-[1fr_340px] gap-3 mt-6 flex-1 min-h-0">
                    <Card className="flex flex-col min-h-0 overflow-hidden">
                      <CardHead left="Compiled" right={<span className="font-mono text-[11.5px]">{target.lines} lines</span>} />
                      <div className="overflow-y-auto min-h-0">
                        {target.text.trim() ? <Lines text={target.text} /> : <Empty>Empty for now: there’s nothing in the files this target can read.</Empty>}
                      </div>
                    </Card>
                    <div className="flex flex-col gap-3">
                      <Size lines={target.lines} budget={target.budget} />
                      <Card>
                        <CardHead left="Lint" right={target.lint.length || undefined} />
                        {target.lint.length === 0 && <p className="rw text-ink-2">Nothing to tidy.</p>}
                        {target.lint.map((l, i) => (
                          <a key={i} href={href(["context", "profile"], { file: l.file })} className="rw items-start hover:bg-surface-2">
                            <Dot color="var(--warn)" className="mt-[7px]" />
                            <div><p>{l.message}</p><p className="text-[12.5px] text-ink-3 mt-0.5 font-mono">{l.file}:{l.line}</p></div>
                          </a>
                        ))}
                      </Card>
                      {compiled.length > 1 && (
                        <Card className="p-5">
                          <p className="text-[13px] text-ink-3">Other targets</p>
                          <div className="flex flex-col gap-2 mt-3 text-[13.5px]">
                            {compiled.filter((c) => c.target !== target.target).map((c) => (
                              <a key={c.target} href={href(["context", "profile"], { target: c.target })} className="flex justify-between hover:text-ink-2">
                                <span>{TARGET_LABEL[c.target]}</span><span className="font-mono text-[12.5px] text-ink-2">{c.lines} lines</span>
                              </a>
                            ))}
                          </div>
                        </Card>
                      )}
                    </div>
                  </div>
                </>
              )}
            </>
          )}
        </Main>
      } />
  );
}

function Size({ lines, budget }: { lines: number; budget: number }) {
  const over = lines - budget;
  const pct = budget ? Math.min(100, (lines / budget) * 100) : 0;
  return (
    <Card className="p-5">
      <p className="text-[13px] text-ink-3">Size</p>
      <p className="text-[26px] font-semibold mt-1">{num(lines)} <span className="text-[15px] text-ink-3 font-normal">of {num(budget)} lines</span></p>
      <div className="h-[6px] rounded-full bg-surface-3 mt-3 overflow-hidden" role="meter" aria-valuemin={0} aria-valuemax={budget} aria-valuenow={lines} aria-label="Lines used">
        <div className="h-full rounded-full" style={{ width: `${pct}%`, background: over > 0 ? "var(--warn)" : "var(--ink-2)" }} />
      </div>
      <p className="text-[12.5px] text-ink-3 mt-2">{over > 0 ? `${num(over)} over. The lint list shows what to trim.` : `${num(budget - lines)} lines to spare.`}</p>
    </Card>
  );
}
