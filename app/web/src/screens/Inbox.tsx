import { useState } from "react";
import type { Decision, Proposal } from "../../../shared/types";
import { api, ApiError } from "../lib/api";
import { useApp } from "../lib/app";
import { useAreaName, useWho } from "../lib/directory";
import { ago, clock, shortDate } from "../lib/format";
import { fromLabel, SCOPE_LABEL } from "../lib/labels";
import { href, navigate } from "../lib/router";
import { useLoad } from "../lib/useLoad";
import { usePhone } from "../lib/useMedia";
import { BackLink, Btn, Card, cx, Dot, Empty, ErrorNote, H1, ListPane, Loading, Logo, Main, Split } from "../components/ui";
import { LinkToProfile, ToolCallDetail, ToolChangeDetail } from "../components/InboxExtras";

const EMPTY_TITLE = "Nothing waiting. Agents’ proposals land here.";
const EMPTY_BODY = "When an agent wants to add or change a memory, a person, a file or a skill, it waits here until you decide. Anything read from an email or a web page is held, with the reasons spelled out.";

/** The value the proposal would store, in one line. */
function proposedText(p: Proposal): string {
  const d = p.data;
  for (const k of ["text", "name", "title", "description"]) if (typeof d[k] === "string" && d[k]) return d[k] as string;
  return p.title;
}

/** Short scalar fields of the proposed record, for the "what would be stored" list. */
function storedFields(p: Proposal): [string, string][] {
  const skip = new Set(["text", "name", "title", "id", "source", "scope", "area", "status", "trust"]);
  const out: [string, string][] = [];
  for (const [k, v] of Object.entries(p.data)) {
    if (skip.has(k) || v === null || v === undefined || v === "") continue;
    let s: string;
    if (typeof v === "string") s = v;
    else if (typeof v === "number" || typeof v === "boolean") s = String(v);
    else if (Array.isArray(v) && v.every((x) => typeof x === "string")) s = v.join(", ");
    else continue;
    out.push([k.replace(/_/g, " "), s.length > 140 ? `${s.slice(0, 140)}…` : s]);
    if (out.length >= 6) break;
  }
  return out;
}

function forgetLabel(p: Proposal, short = false): string {
  const what = p.source.kind === "email" ? "email" : p.source.kind === "web" ? "page" : "source";
  return short ? "Reject + forget" : `Reject and forget this ${what}`;
}

const DONE: Record<Decision, string> = {
  accept: "Accepted.", keep: "Kept the current one.", reject: "Rejected.", reject_and_forget_source: "Rejected, and forgot everything from that source.",
};

function useDecide(list: Proposal[], reload: () => void) {
  const { refreshInbox, notify } = useApp();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  function done(p: Proposal, msg: string) {
    notify(msg);
    const i = list.findIndex((x) => x.id === p.id);
    const next = list[i + 1] ?? list[i - 1];
    navigate(next ? href(["inbox", next.id]) : href(["inbox"]));
    reload();
    refreshInbox();
  }
  async function decide(p: Proposal, d: Decision) {
    setBusy(p.id); setError(null);
    try {
      await api.decide(p.id, d);
      done(p, p.kind === "tool_change" ? (d === "accept" ? "Approved; agents can use it again." : "Kept blocked.")
        : p.kind === "tool_call" ? (d === "accept" ? "Approved; it ran." : "Rejected; nothing ran.") : DONE[d]);
    } catch (e) {
      // 409: already decided elsewhere (e.g. in Pitcrew); refresh so it drops out of the list.
      if (e instanceof ApiError && e.status === 409) { notify("Already decided elsewhere."); reload(); refreshInbox(); }
      else setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(null); }
  }
  return { decide, done, busy, error };
}

export function Inbox({ id }: { id?: string }) {
  const phone = usePhone();
  const load = useLoad(() => api.inbox(), []);
  const list = (load.data ?? []).filter((p) => p.status === "open");
  const dec = useDecide(list, load.reload);

  if (load.loading && !load.data) return <Main><Loading /></Main>;
  if (load.error && !load.data) return <Main><ErrorNote error={load.error} onRetry={load.reload} /></Main>;

  if (phone) return <PhoneInbox list={list} id={id} dec={dec} />;

  const picked = list.find((p) => p.id === id) ?? list[0];
  return (
    <Split picked={!!id}
      list={<InboxList list={list} picked={picked?.id} />}
      detail={
        <Main>
          {picked ? <ProposalDetail p={picked} dec={dec} /> : <Empty title={EMPTY_TITLE}>{EMPTY_BODY}</Empty>}
        </Main>
      } />
  );
}

function InboxList({ list, picked }: { list: Proposal[]; picked?: string }) {
  const areaName = useAreaName();
  const held = list.filter((p) => p.held).length;
  return (
    <ListPane width={360} title="Inbox"
      sub={list.length ? `${list.length} waiting${held ? ` · ${held} held` : ""}` : "Nothing waiting"}>
      {list.length === 0 && <p className="px-3 text-[13px] text-ink-3">Proposals from your agents show up here.</p>}
      {list.map((p) => (
        <a key={p.id} href={href(["inbox", p.id])} className="it" aria-current={p.id === picked ? "true" : undefined}>
          <Dot color={p.held ? "var(--signal)" : "var(--ink-3)"} className="mt-[7px]" />
          <span className="min-w-0">
            <span className="block">{p.title}</span>
            <span className="block text-[12.5px] text-ink-3 mt-0.5">
              {p.held ? `${fromLabel(p.source)} · held · ${ago(p.created_at)}` : `${areaName(p.area)} · ${p.source.label} · ${ago(p.created_at)}`}
            </span>
          </span>
        </a>
      ))}
    </ListPane>
  );
}

type Dec = ReturnType<typeof useDecide>;

function Actions({ p, dec, phone }: { p: Proposal; dec: Dec; phone?: boolean }) {
  const busy = dec.busy === p.id;
  const safe: Decision = p.replaces ? "keep" : "reject";
  const safeLabel = p.replaces ? "Keep current" : "Reject";
  // Held items lead with the safe choice; everything else leads with Accept.
  const first: [Decision, string] = p.held ? [safe, safeLabel] : ["accept", "Accept"];
  const second: [Decision, string] = p.held ? ["accept", "Accept"] : [safe, safeLabel];
  const forget = !!p.source.ref;
  if (phone) {
    return (
      <div className="flex flex-col gap-2">
        <button type="button" disabled={busy} onClick={() => dec.decide(p, first[0])} className="bt bt-primary h-[50px] rounded-[14px] text-[15px]">{first[1]}</button>
        <div className={cx("grid gap-2", forget ? "grid-cols-2" : "grid-cols-1")}>
          <button type="button" disabled={busy} onClick={() => dec.decide(p, second[0])} className="bt bt-ghost h-[50px] rounded-[14px] text-[15px]">{second[1]}</button>
          {forget && <button type="button" disabled={busy} onClick={() => dec.decide(p, "reject_and_forget_source")} className="bt h-[50px] rounded-[14px] text-[15px] border border-line text-ink-3">{forgetLabel(p, true)}</button>}
        </div>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-2 flex-wrap">
      <Btn lg kind="primary" disabled={busy} onClick={() => dec.decide(p, first[0])}>{first[1]}</Btn>
      <Btn lg disabled={busy} onClick={() => dec.decide(p, second[0])}>{second[1]}</Btn>
      {p.replaces && !p.held && <Btn lg kind="quiet" disabled={busy} onClick={() => dec.decide(p, "reject")}>Reject</Btn>}
      {forget && <Btn lg kind="quiet" disabled={busy} onClick={() => dec.decide(p, "reject_and_forget_source")}>{forgetLabel(p)}</Btn>}
    </div>
  );
}

function ProposalDetail({ p, dec }: { p: Proposal; dec: Dec }) {
  if (p.kind === "tool_change") return <><BackLink href={href(["inbox"])} label="Inbox" /><ToolChangeDetail p={p} busy={dec.busy === p.id} error={dec.error} decide={(d) => dec.decide(p, d)} /></>;
  if (p.kind === "tool_call") return <ToolCall p={p} dec={dec} />;
  return <RecordProposal p={p} dec={dec} />;
}

function ToolCall({ p, dec }: { p: Proposal; dec: Dec }) {
  const who = useWho();
  return <><BackLink href={href(["inbox"])} label="Inbox" /><ToolCallDetail p={p} by={who(p.agent).name} busy={dec.busy === p.id} error={dec.error} decide={(d) => dec.decide(p, d)} /></>;
}

function RecordProposal({ p, dec }: { p: Proposal; dec: Dec }) {
  const who = useWho();
  const areaName = useAreaName();
  const by = p.agent ? who(p.agent).name : p.source.kind === "you" ? "You" : "An agent";
  const at = p.source.at ?? p.created_at;
  const fields = storedFields(p);
  return (
    <>
      <BackLink href={href(["inbox"])} label="Inbox" />
      <div className="flex items-center justify-between gap-4 text-[13px] text-ink-3 flex-wrap">
        <span>{titleKind(p)} · {areaName(p.area)} · {SCOPE_LABEL[p.scope]}</span>
        <span className="flex items-center gap-2">
          <Dot color={p.held ? "var(--signal)" : "var(--ink-3)"} />{p.held ? "Held" : "Waiting for you"}
        </span>
      </div>
      <H1 className="mt-4">{p.title}</H1>
      <p className="text-[15px] text-ink-2 mt-2 leading-relaxed max-w-[680px]">
        {by} proposed this {fromLabel(p.source).toLowerCase().replace(/^you$/, "yourself")} on {shortDate(at)} at {clock(at)}.
        {p.replaces ? " It would replace something already in Engram." : ""}
      </p>

      {p.replaces ? (
        <Card className="grid grid-cols-1 wide:grid-cols-2 mt-7">
          <div className="p-6">
            <p className="text-[12.5px] text-ink-3">Today</p>
            <p className="text-[20px] font-semibold mt-2 leading-snug">{p.replaces.text}</p>
            <p className="text-[13px] text-ink-3 mt-2">{p.replaces.source.label}{p.replaces.source.at ? ` · ${shortDate(p.replaces.source.at)}` : ""}</p>
          </div>
          <div className="p-6 border-t wide:border-t-0 wide:border-l border-line rounded-b-[14px] wide:rounded-bl-none wide:rounded-r-[14px]"
            style={{ background: p.held ? "color-mix(in srgb,var(--signal) 6%,var(--surface))" : undefined }}>
            <p className="text-[12.5px]" style={{ color: p.held ? "var(--signal)" : "var(--ink-3)" }}>Proposed</p>
            <p className="text-[20px] font-semibold mt-2 leading-snug">{proposedText(p)}</p>
            <p className="text-[13px] text-ink-3 mt-2">{p.source.label} · {shortDate(at)} at {clock(at)}</p>
          </div>
        </Card>
      ) : (
        <Card className="mt-7 p-6" hot={p.held}>
          <p className="text-[12.5px]" style={{ color: p.held ? "var(--signal)" : "var(--ink-3)" }}>Proposed</p>
          <p className="text-[20px] font-semibold mt-2 leading-snug">{proposedText(p)}</p>
          <p className="text-[13px] text-ink-3 mt-2">{p.source.label} · {shortDate(at)} at {clock(at)}</p>
        </Card>
      )}

      <div className="grid grid-cols-1 wide:grid-cols-[1fr_300px] gap-4 mt-4">
        <Card>
          {p.reasons.length > 0 ? (
            <>
              <p className="text-[13px] text-ink-3 px-5 pt-4 pb-1">{p.held ? "Why it’s held" : "Worth a look"}</p>
              {p.reasons.map((r, i) => (
                <div key={i} className={cx("flex gap-[14px] items-start px-5 py-[14px]", i > 0 && "border-t border-line")}>
                  <span className="w-[22px] h-[22px] rounded-full grid place-items-center flex-none bg-surface-2 font-mono text-[11px] text-ink-2">{i + 1}</span>
                  <p>{r}</p>
                </div>
              ))}
            </>
          ) : (
            <>
              <p className="text-[13px] text-ink-3 px-5 pt-4 pb-1">What would be stored</p>
              {fields.length ? fields.map(([k, v]) => <div key={k} className="kv"><span className="capitalize">{k}</span><span>{v}</span></div>)
                : <p className="px-5 pb-4 pt-1 text-[13.5px] text-ink-2">Nothing flagged it. It’s waiting only because agents propose and you decide.</p>}
            </>
          )}
        </Card>
        <Card className="px-5 py-4">
          <p className="text-[13px] text-ink-3 mb-1">Source</p>
          <div className="kv px-0"><span>{fromLabel(p.source).replace(/^From (an? )?/, "").replace(/^\w/, (c) => c.toUpperCase())}</span><span>{p.source.label}</span></div>
          <div className="kv px-0"><span>Proposed by</span><span>{by}</span></div>
          <div className="kv px-0"><span>If accepted</span><span>{areaName(p.area)}, {SCOPE_LABEL[p.scope].toLowerCase()}</span></div>
        </Card>
      </div>

      {dec.error && <p role="alert" className="text-[13px] text-bad mt-5">{dec.error}</p>}
      <div className="mt-7 flex items-center gap-4 flex-wrap">
        <Actions p={p} dec={dec} />
        <span className="ml-auto text-[12.5px] text-ink-3">Everything you decide is in the trace.</span>
      </div>
      {p.kind === "skill" && <LinkToProfile p={p} onDone={(msg) => dec.done(p, msg)} />}
    </>
  );
}

function titleKind(p: Proposal): string {
  return { memory: "Memory", entity: "Person or thing", artifact: "File", skill: "Skill change", tool_change: "Tool description changed", vault_conflict: "Edit conflict", tool_call: "Tool call waiting for approval" }[p.kind] ?? "Proposal";
}

/** Phone: one proposal at a time, decisions at thumb height. */
function PhoneInbox({ list, id, dec }: { list: Proposal[]; id?: string; dec: Dec }) {
  const areaName = useAreaName();
  const i = Math.max(0, list.findIndex((p) => p.id === id));
  const p = list[i];
  const next = list[i + 1];
  return (
    <div className="flex-1 min-h-full flex flex-col px-4 pt-6 pb-6">
      <div className="flex items-center justify-between px-1">
        <Logo size={22} wordmark mono />
        <span className="text-[13px] text-ink-3">{list.length ? `${i + 1} of ${list.length}` : "Inbox"}</span>
      </div>
      {list.length > 0 && (
        <div className="flex gap-1.5 mt-4 mb-4 px-1" aria-hidden="true">
          {list.slice(0, 12).map((x, j) => <span key={x.id} className="h-[4px] rounded-full flex-1" style={{ background: j === i ? "var(--signal)" : "var(--surface-3)" }} />)}
        </div>
      )}
      {!p ? (
        <div className="cd mt-4"><Empty title={EMPTY_TITLE}>{EMPTY_BODY}</Empty></div>
      ) : (
        <>
          <div className="cd rounded-[20px] p-5 flex flex-col">
            <p className="text-[12.5px] text-ink-3 flex items-center gap-2">
              <Dot color={p.held ? "var(--signal)" : "var(--ink-3)"} />
              {p.held ? "Held · " : ""}{fromLabel(p.source).toLowerCase().replace(/^you$/, "from you")} · {SCOPE_LABEL[p.scope]}
            </p>
            <h1 className="text-[24px] font-semibold tracking-[-0.025em] mt-2.5 leading-tight">{p.title}</h1>
            <p className="text-[14px] text-ink-2 mt-2 leading-relaxed">{p.source.label} · {areaName(p.area)} · {ago(p.created_at)}</p>
            <div className="flex flex-col gap-2 mt-4">
              {p.replaces && (
                <div className="rounded-[12px] bg-surface-2 px-4 py-3.5">
                  <p className="text-[12px] text-ink-3">Today</p>
                  <p className="text-[17px] font-semibold mt-1 leading-snug">{p.replaces.text}</p>
                  <p className="text-[12px] text-ink-3 mt-1">{p.replaces.source.label}</p>
                </div>
              )}
              <div className="rounded-[12px] bg-surface-2 px-4 py-3.5"
                style={p.held ? { boxShadow: "inset 0 0 0 1px color-mix(in srgb,var(--signal) 50%,transparent)" } : undefined}>
                <p className="text-[12px]" style={{ color: p.held ? "var(--signal)" : "var(--ink-3)" }}>Proposed</p>
                <p className="text-[17px] font-semibold mt-1 leading-snug">{proposedText(p)}</p>
                <p className="text-[12px] text-ink-3 mt-1">{p.source.label}</p>
              </div>
            </div>
            {p.reasons.length > 0 && (
              <div className="mt-4">
                <p className="text-[12px] text-ink-3 mb-1">{p.held ? "Why it’s held" : "Worth a look"}</p>
                {p.reasons.map((r, j) => (
                  <div key={j} className="flex gap-2.5 py-[9px] border-t border-line text-[13.5px]">
                    <span className="font-mono text-[11px] text-ink-3 pt-[3px]">{j + 1}</span>{r}
                  </div>
                ))}
              </div>
            )}
          </div>
          <div className="mt-auto pt-6 flex flex-col gap-2">
            {dec.error && <p role="alert" className="text-[13px] text-bad">{dec.error}</p>}
            <Actions p={p} dec={dec} phone />
            <p className="text-[12px] text-ink-3 text-center mt-2">{next ? <a href={href(["inbox", next.id])}>Next: {next.title}</a> : "This is the last one."}</p>
          </div>
        </>
      )}
    </div>
  );
}
