import { createContext, useContext, useEffect, useId, useState } from "react";
import {
  api,
  formatPaise,
  SCENARIO_LABELS,
  type EvaluatedSignal,
  type GuardrailDetail,
  type ReplayTrace,
  type TraceArm,
  type TraceStep,
  type TracedDecisionShape,
} from "../api";
import { SendPaymentLinkButton } from "./SendPaymentLinkButton";

// LIVE DECISION TRACE — one real event walked through the six stages it
// actually passes through, in both arms.
//
// EVERY VALUE ON THIS PAGE COMES FROM THE TRACE RESPONSE. Nothing is defaulted,
// inferred, or carried over from a design mock. Where a step did not capture
// what a panel needs, the panel says so and renders empty — see <Missing />.
// A plausible-looking invented number is indistinguishable from a real one on
// screen, and the whole point of this page is that a viewer can trust what it
// shows.

const STEP_NAMES = ["Event", "Memory", "Signals", "Decision", "Guardrails", "Execution"] as const;

// Which captured step backs each stage. The memory arm produces all of them;
// the baseline arm genuinely has no memory read and no signal evaluation, which
// is the control working rather than a capture gap.
const STEP_SOURCE: Record<number, string | null> = {
  0: null, // the event row itself, not a trace step
  1: "read_memory_profile",
  2: "evaluate_policy_signals",
  3: "agent_reasoning",
  4: "policy_override",
  5: null, // the final decision row
};

function stepOf(arm: TraceArm | null, name: string): TraceStep | null {
  return arm?.steps.find((s) => s.step_name === name) ?? null;
}

// The one place a missing value is rendered. Deliberately loud: a gap in the
// trace should look like a defect, not like a tasteful blank.
function Missing({ what }: { what: string }) {
  return <span className="rp-missing">not captured — {what}</span>;
}

function MissingBlock({ what }: { what: string }) {
  return (
    <div className="rp-missing-block">
      <strong>Nothing to show here.</strong>
      <span>{what}</span>
    </div>
  );
}

// ACCORDION, one open row per group.
//
// Rows used to open independently, which looked harmless and was not: opening
// one pushes every row below it down, so a second click lands on whatever row
// slid into that spot instead of closing the first. The reported symptom was
// "clicking the middle doesn't collapse it" — the click was landing on a
// different row. One-at-a-time keeps positions stable and the panel readable.
const AccordionContext = createContext<{
  openId: string | null;
  setOpenId: (id: string | null) => void;
} | null>(null);

function Accordion({ children }: { children: React.ReactNode }) {
  const [openId, setOpenId] = useState<string | null>(null);
  return <AccordionContext.Provider value={{ openId, setOpenId }}>{children}</AccordionContext.Provider>;
}

// A row that expands to explain itself. Falls back to independent local state
// when it is not inside an <Accordion>, so a lone row still works.
function ExpandableRow({
  label,
  value,
  children,
  rowClass = "",
}: {
  label: React.ReactNode;
  value: React.ReactNode;
  children: React.ReactNode;
  rowClass?: string;
}) {
  const id = useId();
  const group = useContext(AccordionContext);
  const [localOpen, setLocalOpen] = useState(false);
  const open = group ? group.openId === id : localOpen;
  const toggle = () => (group ? group.setOpenId(open ? null : id) : setLocalOpen(!open));

  return (
    <div className={`rp-xrow ${rowClass} ${open ? "open" : ""}`}>
      <button type="button" className="rp-xrow-main" onClick={toggle} aria-expanded={open}>
        <span className="rp-k">{label}</span>
        <span className="rp-vgroup">
          <span className="rp-v">{value}</span>
          <span className="rp-chev" aria-hidden="true">
            ⌄
          </span>
        </span>
      </button>
      {open && <div className="rp-xpanel">{children}</div>}
    </div>
  );
}

function money(paise: number | null | undefined): string {
  return paise == null ? "null" : formatPaise(paise);
}

// Readable local time, with the raw ISO string kept on the element's title.
function formatWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

// Compact by necessity: the rail is a fixed 310px and the event name has to
// win the space, so "merchant won" is not truncated to "merchan…". The full
// phrase is kept on the element's title.
function relativeDays(from: string, to: string): { short: string; full: string } {
  const days = Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);
  if (days === 0) return { short: "same day", full: "same day as this event" };
  return days > 0
    ? { short: `\u2212${days}d`, full: `${days} days before this event` }
    : { short: `+${-days}d`, full: `${-days} days after this event` };
}

const DOMAIN_LABEL: Record<string, string> = {
  cart_abandonment: "Cart",
  subscription_recovery: "Sub",
  dispute_responder: "Dispute",
};

const AGENT_LABEL: Record<string, string> = {
  cart_abandonment: "Cart Abandonment",
  subscription_recovery: "Subscription Recovery",
  dispute_responder: "Dispute Responder",
};

// RAZORPAY DISPUTE STATUSES ARE MERCHANT-SIDE, and that is the single most
// misread thing in this domain: a dispute belongs to the merchant, so "won"
// means the MERCHANT won and the customer's complaint did not hold up. Shown
// raw, "Dispute · ₹600 · won" reads to almost everyone as the customer winning
// — the exact inversion the profile's field names were renamed to avoid. Every
// status is therefore rendered with its subject named.
const DISPUTE_STATUS_LABEL: Record<string, string> = {
  won: "merchant won",
  lost: "merchant conceded",
  closed: "closed, no ruling",
  open: "unresolved",
  under_review: "unresolved",
};

// Paise are what the database stores and what the event row must show, but a
// bare 500000 next to a ₹5,000 in the rail invites a mental unit conversion on
// every read. Amount columns get both.
const PAISE_COLUMNS = new Set(["amount", "amount_paid", "amount_due", "plan_amount"]);

// "null" is the honest value for committed_spend_paise and it is information
// rather than an absence — but only where the schema itself is on display.
// In a SUMMARY it reads as missing data, so summaries say it in words.
function spendPhrase(paise: number | null | undefined): string {
  return paise == null ? "no spend" : formatPaise(paise);
}

export function ReplayView({ customerId }: { customerId: string }) {
  const [trace, setTrace] = useState<ReplayTrace | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [current, setCurrent] = useState(0);

  useEffect(() => {
    setTrace(null);
    setError(null);
    api
      .trace(customerId)
      .then(setTrace)
      .catch((e) => setError(String(e)));
  }, [customerId]);

  if (error) {
    return (
      <div className="rp-shell-error">
        <h2>Could not load the trace</h2>
        <p className="rp-missing">{error}</p>
        <p className="muted">
          The API must be running (<code>npm run server:dev</code>), and this customer's event must
          have been decided by <code>npm run agents:baseline</code> and <code>npm run agents:memory</code>.
        </p>
      </div>
    );
  }
  if (!trace) return <p className="muted">Loading trace…</p>;

  if (!trace.event || !trace.arms) {
    return (
      <div className="rp-shell-error">
        <h2>{trace.customer.name} has no replayable event</h2>
        <p className="muted">
          A replayable event needs an open recovery question and at least one captured trace row.
          This customer has {trace.timeline.length} event(s) and none qualify.
        </p>
      </div>
    );
  }

  return <ReplayBody trace={trace} current={current} setCurrent={setCurrent} />;
}

function ReplayBody({
  trace,
  current,
  setCurrent,
}: {
  trace: ReplayTrace;
  current: number;
  setCurrent: (n: number) => void;
}) {
  // Which way the viewer moved, so the card enters from the side they came
  // from. Tracked rather than derived because clicking a distant node is still
  // a forward or backward move.
  const [dir, setDir] = useState<"fwd" | "back">("fwd");
  const goTo = (next: number) => {
    if (next < 0 || next > STEP_NAMES.length - 1 || next === current) return;
    setDir(next > current ? "fwd" : "back");
    setCurrent(next);
  };
  const event = trace.event!;
  const arms = trace.arms!;
  const memory = arms.memory;
  const baseline = arms.baseline;

  const profileStep = stepOf(memory, "read_memory_profile");
  const profile = (profileStep?.detail.profile ?? null) as Record<string, unknown> | null;

  const signalsStep = stepOf(memory, "evaluate_policy_signals");
  const evaluated = (signalsStep?.detail.evaluated ?? null) as EvaluatedSignal[] | null;

  const memoryGuard = (stepOf(memory, "policy_override")?.detail ?? null) as GuardrailDetail | null;
  const baselineGuard = (stepOf(baseline, "policy_override")?.detail ?? null) as GuardrailDetail | null;

  const eventAmount = (event.detail.amount ?? event.detail.plan_amount) as number | undefined;

  // Only the memory step has an aside today; the slot is generic so another
  // step can fill it without changing the card.
  const aside = current === 1 ? <SourcesPanel profile={profile} timeline={trace.timeline} /> : null;

  return (
    <div className="rp-root">
      <TopBar scenario={trace.scenario} />
      <div className="rp-shell">
        <Rail
          trace={trace}
          eventAmount={eventAmount}
          profile={profile}
          baselineGuard={baselineGuard}
          memoryGuard={memoryGuard}
          finalDecision={memory.decision}
        />
        <main className="rp-main">
          <div className="rp-main-head">
            <h3>
              Event journey
              {/* WHICH AGENT IS DECIDING. Three point-agents share this pipeline
                  and the page never said which one was acting — a reader had to
                  infer it from the event table's name. */}
              <span className="rp-agent-badge">{AGENT_LABEL[event.domain] ?? event.domain} agent</span>
            </h3>
            {/* Just the stage count. This used to read "7 captured trace steps"
                beside a six-node stepper, which looked like an off-by-one: the
                7 was rows in agent_trace_events, not stages. The trace-row
                counts are visible per arm inside the steps themselves, so
                naming them here bought a contradiction and nothing else. */}
            <p>{STEP_NAMES.length} stages</p>
          </div>
          <Stepper current={current} setCurrent={goTo} memory={memory} baseline={baseline} />
          {/* `key` remounts the card so the enter animation replays. There is
              deliberately NO leave animation: a leave-then-enter pair doubles
              the wait without adding information, which is what made stepping
              between sections feel sluggish. */}
          <div className="rp-card" key={current} data-dir={dir}>
            {/* The aside sits BESIDE the header, not inside the body, so its
                heading starts level with the step title. Nudging it upward with
                a negative margin would depend on the height of the title and
                subtitle, which differ per step. */}
            <div className={`rp-card-body ${aside ? "has-aside" : ""}`}>
            <div className="rp-card-main">
            <StepCard
              index={current}
              trace={trace}
              memory={memory}
              baseline={baseline}
              profile={profile}
              evaluated={evaluated}
              memoryGuard={memoryGuard}
              baselineGuard={baselineGuard}
            />
            </div>
            {aside}
            </div>
            <div className="rp-nav">
              <button type="button" onClick={() => goTo(current - 1)} disabled={current === 0}>
                ← Previous
              </button>
              <button
                type="button"
                className="primary"
                onClick={() => goTo(current + 1)}
                disabled={current === STEP_NAMES.length - 1}
              >
                Next →
              </button>
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}

function TopBar({ scenario }: { scenario: ReplayTrace["scenario"] }) {
  return (
    <div className="rp-topbar">
      <div className="rp-brand">
        <span className="rp-eyebrow">Cross-Agent Memory</span>
        <h1>Live Decision Trace</h1>
      </div>
      <div className="rp-topbar-right">
        <div className="rp-pills">
          <span className="rp-pill active">
            {scenario ? SCENARIO_LABELS[scenario] : "Unlabelled"} (default)
          </span>
          {/* The other scenarios are real and planted in the batch, but this
              page replays one. Shown disabled rather than hidden so the scope
              is visible instead of implied. */}
          <span className="rp-pill" aria-disabled="true" title="Not built — this page replays one scenario">
            Composite risk · escalation
          </span>
          <span className="rp-pill" aria-disabled="true" title="Not built — this page replays one scenario">
            Cross-agent gaming
          </span>
        </div>
      </div>
    </div>
  );
}

function Stepper({
  current,
  setCurrent,
  memory,
  baseline,
}: {
  current: number;
  setCurrent: (n: number) => void;
  memory: TraceArm;
  baseline: TraceArm;
}) {
  return (
    <div className="rp-stepper">
      {STEP_NAMES.map((name, i) => {
        const source = STEP_SOURCE[i];
        // A stage is "unbacked" when the trace step it renders is absent, so a
        // capture gap is visible from the stepper rather than only after
        // clicking into it.
        const unbacked = source != null && !stepOf(memory, source) && !stepOf(baseline, source);
        const done = i < current;
        return (
          <button
            type="button"
            key={name}
            className={`rp-node ${i === current ? "current" : ""} ${done ? "done" : ""} ${
              unbacked ? "unbacked" : ""
            }`}
            onClick={() => setCurrent(i)}
          >
            {/* The segment to the RIGHT of this node. It fills blue once the
                node is behind the viewer, so the line advances step by step. */}
            <span className="rp-connector" />
            <span className="rp-circle">{unbacked ? "!" : done ? "✓" : i + 1}</span>
            <span className="rp-node-label">{name}</span>
          </button>
        );
      })}
    </div>
  );
}

// ------------------------------------------------------------------- the rail

function Rail({
  trace,
  eventAmount,
  profile,
  baselineGuard,
  memoryGuard,
  finalDecision,
}: {
  trace: ReplayTrace;
  eventAmount: number | undefined;
  profile: Record<string, unknown> | null;
  baselineGuard: GuardrailDetail | null;
  memoryGuard: GuardrailDetail | null;
  finalDecision: TraceArm["decision"];
}) {
  const event = trace.event!;
  const initials = trace.customer.name
    .split(" ")
    .map((p) => p[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

  const memoryBlocked = (memoryGuard?.blocking_signals.length ?? 0) > 0;
  const capDelta =
    baselineGuard && memoryGuard ? baselineGuard.cap_paise - memoryGuard.cap_paise : null;

  const breakdown = (profile?.dispute_breakdown ?? null) as Record<string, number> | null;
  const discountHistory = (profile?.discount_usage_history ?? null) as unknown[] | null;
  const recovery = (profile?.recovery_frequency ?? null) as { agent: string; count: number }[] | null;

  return (
    <aside className="rp-rail">
      <div className="rp-identity">
        <div className="rp-avatar">{initials}</div>
        <div>
          <h2>{trace.customer.name}</h2>
          <span>{trace.customer.customer_id}</span>
        </div>
      </div>

      <section>
        <div className="rp-rail-label">Activity</div>
        <div className="rp-legend">
          {Object.entries(DOMAIN_LABEL).map(([k, v]) => (
            <span key={k} className="rp-legend-item">
              <i className={`rp-legend-dot d-${k}`} />
              {v}
            </span>
          ))}
        </div>
        {/* The customer's whole real timeline, not only the replayed event —
            the prior events are what the memory profile is built from. */}
        <div className="rp-timeline">
          {trace.timeline.map((e) => {
            const isTrigger = e.event_id === event.event_id;
            const amount = (e.detail.amount ?? e.detail.plan_amount) as number | undefined;
            return (
              <div key={e.event_id} className={`rp-trow d-${e.domain} ${isTrigger ? "trigger" : ""}`}>
                <span className="rp-tleft">
                  <i className={`rp-tdot d-${e.domain} ${isTrigger ? "pulse" : ""}`} />
                  <span className="rp-tname">
                    {DOMAIN_LABEL[e.domain] ?? e.domain} ·{" "}
                    {amount != null ? formatPaise(amount) : <Missing what="no amount on this row" />}
                    <em>
                      {" "}
                      {e.domain === "dispute_responder"
                        ? (DISPUTE_STATUS_LABEL[String(e.detail.status)] ?? String(e.detail.status))
                        : String(e.detail.status ?? "")}
                    </em>
                  </span>
                </span>
                <span
                  className="rp-ttime"
                  title={isTrigger ? "the event being replayed" : relativeDays(e.timestamp, event.timestamp).full}
                >
                  {isTrigger ? "this event" : relativeDays(e.timestamp, event.timestamp).short}
                </span>
              </div>
            );
          })}
        </div>

        {/* THE COMPARISON THAT MATTERS: what each arm was PERMITTED to spend.
            Both numbers come off that arm's own guardrail step.
            Baseline is always the standing 20% default; the memory cap really
            does move (10/15/20/25% across the batch) and can also be removed
            entirely by a blocking signal, which a cap alone would not show. */}
        <div className="rp-compare">
          <div className="rp-compare-row baseline">
            <span className="rp-tag">Baseline cap</span>
            <span className="rp-val">
              {baselineGuard ? (
                `${baselineGuard.cap_percent}% · ${formatPaise(baselineGuard.cap_paise)}`
              ) : (
                <Missing what="no baseline guardrail step" />
              )}
            </span>
          </div>
          <div className={`rp-compare-row memory ${memoryBlocked ? "blocked" : ""}`}>
            <span className="rp-tag">Memory cap</span>
            <span className="rp-val">
              {!memoryGuard ? (
                <Missing what="no memory guardrail step" />
              ) : memoryBlocked ? (
                "spend blocked"
              ) : (
                `${memoryGuard.cap_percent}% · ${formatPaise(memoryGuard.cap_paise)}`
              )}
            </span>
          </div>
          {capDelta != null && capDelta !== 0 && (
            <div className="rp-compare-delta">
              {capDelta > 0 ? "−" : "+"}
              {formatPaise(Math.abs(capDelta))} permitted vs baseline
            </div>
          )}
        </div>
      </section>

      <section>
        <div className="rp-rail-label">Memory profile (as of this event)</div>
        {profile ? (
          <div className="rp-stat-grid">
            <Tile
              tone="coral"
              num={breakdown ? breakdown.customer_adverse : null}
              label="Adverse disputes"
            />
            <Tile tone="amber" num={profile.rolling_health_score as number} label="Health score" />
            <Tile tone="blue" num={discountHistory ? discountHistory.length : null} label="Discounts used" />
            <Tile
              tone="violet"
              num={profile.successful_payment_count as number}
              label="Successful payments"
            />
          </div>
        ) : (
          <MissingBlock what="The memory read step was not captured for this event." />
        )}
        {recovery && recovery.length > 0 && (
          <div className="rp-recovery">
            <span className="rp-recovery-label">Recovery flows triggered</span>
            {recovery.map((r) => (
              <span key={r.agent}>
                {DOMAIN_LABEL[r.agent] ?? r.agent}: {r.count}
              </span>
            ))}
          </div>
        )}
      </section>

      <div className="rp-outcome-zone">
        <span className="rp-outcome-label">Final decision</span>
        {finalDecision ? (
          <>
            <strong>{finalDecision.action}</strong>
            <span>
              {spendPhrase(finalDecision.committed_spend_paise)} committed
              {finalDecision.escalate_to_human ? " · ⚑ human review" : ""}
            </span>
            {eventAmount != null && <span className="muted">on {formatPaise(eventAmount)}</span>}
          </>
        ) : (
          <Missing what="no decision row for the memory arm" />
        )}
      </div>
    </aside>
  );
}

function Tile({ tone, num, label }: { tone: string; num: number | null; label: string }) {
  return (
    <div className={`rp-tile ${tone}`}>
      <div className="rp-tile-num">{num == null ? "—" : num}</div>
      <div className="rp-tile-lbl">{label}</div>
    </div>
  );
}

// -------------------------------------------------------------- the six steps

function StepCard(props: {
  index: number;
  trace: ReplayTrace;
  memory: TraceArm;
  baseline: TraceArm;
  profile: Record<string, unknown> | null;
  evaluated: EvaluatedSignal[] | null;
  memoryGuard: GuardrailDetail | null;
  baselineGuard: GuardrailDetail | null;
}) {
  const { index } = props;
  const heads = [
    {
      t: "Event received",
      s: "A customer filled a cart, tried to pay, and the payment failed. Razorpay already recorded that as an order — this is that record, and it is what wakes the agent up.",
    },
    {
      t: "Memory read",
      s: "What all three agents already know about this customer, as it stood the moment this event arrived.",
    },
    { t: "Signals derived", s: "What that history means in policy terms — the rules that read the profile." },
    { t: "Model proposes", s: "A real Claude call. Input left, raw output right — both arms." },
    { t: "Guardrails", s: "What policy permitted, and whether it changed anything." },
    { t: "Execution", s: "The final decision, and a real Razorpay test-mode link on request." },
  ];
  const head = heads[index]!;

  return (
    <>
      <div className="rp-card-head">
        <span className="rp-card-eyebrow">
          Step {index + 1} / {STEP_NAMES.length}
        </span>
        <h3 className="rp-card-title">{head.t}</h3>
      </div>
      <p className="rp-card-sub">{head.s}</p>
      {index === 0 && <EventStep trace={props.trace} />}
      {index === 1 && <MemoryStep memory={props.memory} profile={props.profile} />}
      {index === 2 && <SignalsStep evaluated={props.evaluated} />}
      {index === 3 && <DecisionStep memory={props.memory} baseline={props.baseline} />}
      {index === 4 && <GuardrailStep memoryGuard={props.memoryGuard} baselineGuard={props.baselineGuard} />}
      {index === 5 && (
        <ExecutionStep
          trace={props.trace}
          memory={props.memory}
          baseline={props.baseline}
          memoryGuard={props.memoryGuard}
          baselineGuardCapPercent={props.baselineGuard?.cap_percent ?? null}
        />
      )}
    </>
  );
}

function EventStep({ trace }: { trace: ReplayTrace }) {
  const event = trace.event!;
  const row = event.detail;
  // The literal stored columns, in the order schema.sql declares them. Only
  // keys actually present on the row are rendered.
  // The three last_* columns are collapsed into one "last attempt" row below.
  // They are the payments-report fields denormalised onto the order, and as
  // three separate rows they took a third of the table to say one thing.
  const keys = [
    "order_id",
    "customer_id",
    "amount",
    "amount_paid",
    "amount_due",
    "currency",
    "status",
    "attempts",
    "created_at",
  ].filter((k) => k in row);

  const method = row.last_method as string | null;
  const errorCode = row.last_error_code as string | null;
  const errorDesc = row.last_error_description as string | null;
  const notes = row.notes as Record<string, unknown> | null;

  return (
    <>
      {/* WHAT KIND OF EVENT THIS IS, said plainly. The table name alone, set
          small and grey, was not carrying it.
          Deliberately NOT a stored event_type column: every row of this table
          would hold the same constant, no signal or decision reads it, and
          Razorpay's Orders report has no such field — so it would weaken the
          "this mirrors real data" claim this very step is making. The event
          type is established by which table the row lives in. */}
      <div className="rp-kv-card">
        <div className="rp-source">
          <span className="rp-source-kind">Cart abandonment</span>
          <span className="rp-source-table">
            stored in <code>{event.domain}_events</code> — the table it lives in is what makes it a
            cart-abandonment event; there is no event_type column repeating that on every row
          </span>
        </div>
        {keys.map((k) => (
          <div className="rp-kv-row" key={k}>
            <span className="rp-k">{k}</span>
            <span className="rp-v">
              {row[k] == null ? (
                <em>null</em>
              ) : (
                <>
                  {String(row[k])}
                  {/* The stored value stays first and authoritative; the
                      readable form trails it, so the row is still a faithful
                      copy of the database. */}
                  {PAISE_COLUMNS.has(k) && typeof row[k] === "number" && (
                    <span className="rp-gloss"> {formatPaise(row[k] as number)}</span>
                  )}
                  {k === "created_at" && (
                    <span className="rp-gloss"> {formatWhen(String(row[k]))}</span>
                  )}
                </>
              )}
            </span>
          </div>
        ))}

        {/* notes is Razorpay's free-form key/value bag on an order. A real
            integration puts cart contents and merchant identifiers here; this
            batch's generator writes item count and acquisition channel, so that
            is what is shown. */}
        <div className="rp-kv-row">
          <span className="rp-k">notes</span>
          <span className="rp-v">
            {notes == null ? (
              <em>null</em>
            ) : (
              Object.entries(notes)
                .map(([k, v]) => `${k}: ${String(v)}`)
                .join("  ·  ")
            )}
          </span>
        </div>

        {/* One row, not three: method + error are a single fact about the last
            payment attempt. last_error_code is the load-bearing one — it is
            what paymentFriction reads. */}
        <div className="rp-kv-row">
          <span className="rp-k">last attempt</span>
          <span className="rp-v">
            {method == null && errorCode == null ? (
              <em>never attempted</em>
            ) : (
              <>
                {method ?? "—"}
                {errorCode && <span className="rp-err"> · {errorCode}</span>}
              </>
            )}
          </span>
        </div>
        {errorDesc && <div className="rp-kv-note">{errorDesc}</div>}
      </div>
    </>
  );
}

// Rendered as the card's ASIDE rather than inside its body, so its heading
// starts level with the step title instead of partway down the prose. The
// counts are this customer's own, as of this event, so it shows what the
// profile was actually built from rather than naming tables in the abstract.
function SourcesPanel({
  profile,
  timeline,
}: {
  profile: Record<string, unknown> | null;
  timeline: ReplayTrace["timeline"];
}) {
  if (!profile) return null;
  const discounts = profile.discount_usage_history as unknown[];
  const cartCount = timeline.filter((e) => e.domain === "cart_abandonment").length;
  const subCount = timeline.filter((e) => e.domain === "subscription_recovery").length;
  return (
    <div className="rp-sources">
      <h5>Built from</h5>
      <div className="rp-source-item">
        <code>orders</code>
        <span>{cartCount} for this customer</span>
      </div>
      <div className="rp-source-item">
        <code>subscription charges</code>
        <span>{subCount}</span>
      </div>
      <div className="rp-source-item">
        <code>disputes</code>
        <span>{profile.dispute_count as number}</span>
      </div>
      <div className="rp-source-item">
        <code>discounts granted</code>
        <span>{discounts.length}</span>
      </div>
      <div className="rp-sources-foot">
        The first three are Razorpay's own records. Only the last is produced by this system.
      </div>
    </div>
  );
}

function MemoryStep({ memory, profile }: { memory: TraceArm; profile: Record<string, unknown> | null }) {
  const step = stepOf(memory, "read_memory_profile");
  if (!step || !profile) {
    return (
      <MissingBlock what="No read_memory_profile step was captured for this event. Re-run `npm run agents:memory --customer=<id>` to capture it." />
    );
  }
  const breakdown = profile.dispute_breakdown as Record<string, number>;
  const discounts = profile.discount_usage_history as unknown[];
  const recovery = profile.recovery_frequency as { agent: string; count: number }[];

  return (
    <>
      {/* WHAT THE SHARED PROFILE IS. There is no memory_profile table — the
          question "is this a derived copy or a mirror of Razorpay's own data?"
          has a real answer and the page was not giving it. */}
      <div className="rp-intro">
        <p className="rp-prose">
          <b>Not a stored table.</b> It is computed on every read from records Razorpay already holds,
          plus the discounts this run granted — an aggregation of existing sources, not a new one.
        </p>
        <p className="rp-prose">
          <b>Shared</b> means all three agents read the same profile: Cart Abandonment sees the
          disputes the Dispute Responder handled, and vice versa. Read as of{" "}
          <code title={String(step.detail.as_of)}>{formatWhen(String(step.detail.as_of))}</code>, this
          event's own timestamp, so no later dispute ruling leaks backwards.{" "}
          <b>The baseline arm reads none of it</b> — that asymmetry is the experiment.
        </p>
      </div>

      <div className="rp-kv-card">
        <h4>Aggregated from those records</h4>
        <Accordion>
        <ExpandableRow
          label="dispute_breakdown.customer_adverse"
          value={String(breakdown.customer_adverse)}
        >
          <p>
            <b>What it means:</b> the customer raised a chargeback, the merchant challenged it with
            evidence, and the bank ruled for the merchant. The customer's claim did not hold up.
          </p>
          <p>
            Razorpay stores that outcome as <code>won</code> — won <i>by the merchant</i>, since a
            dispute belongs to the merchant. It is the one dispute outcome that counts against a
            customer.
          </p>
          <p>
            <b>Why it matters:</b> it is the strongest dispute-caution level, and the only one of the four
            buckets that counts against the customer. Full split here —{" "}
            {Object.entries(breakdown)
              .map(([k, v]) => `${k}: ${v}`)
              .join(", ")}
            .
          </p>
        </ExpandableRow>
        <ExpandableRow label="rolling_health_score" value={String(profile.rolling_health_score)}>
          <p>
            <b>What it means:</b> 100 minus weighted penalties, where a customer-adverse dispute costs 12
            and an unresolved one costs 6. Merchant-conceded and closed disputes are free.
          </p>
          <p>
            <b>Why it matters:</b> a single composite risk number the model reads directly, rather than
            re-deriving risk from raw counts.
          </p>
        </ExpandableRow>
        <ExpandableRow label="adverse_disputed_amount" value={money(profile.adverse_disputed_amount as number)}>
          <p>
            <b>What it means:</b> the rupee value of the disputes resolved against this customer.
          </p>
          <p>
            <b>Why it matters:</b> prose carries judgments, JSON carries magnitudes. A signal can say a
            dispute went against this customer; only this says whether it was trivial or ruinous. It is
            always sent, so a zero here positively states that nothing has been resolved against them.
          </p>
        </ExpandableRow>
        <ExpandableRow
          label="discount_usage_history"
          value={`${discounts.length} ${discounts.length === 1 ? "entry" : "entries"}`}
        >
          <p>
            <b>What it means:</b> every discount any agent has already granted this customer in this run.
          </p>
          <p>
            <b>Why it matters:</b> it feeds <code>discountAttemptsForAgent</code> and{" "}
            <code>stoppingRuleHit</code>, the per-agent cutoff after 3 discounts.
          </p>
        </ExpandableRow>
        <ExpandableRow
          label="recovery_frequency"
          value={recovery.length === 0 ? "none" : recovery.map((r) => `${r.agent}: ${r.count}`).join(", ")}
        >
          <p>
            <b>What it means:</b> how often each agent's recovery flow has fired for this customer.
          </p>
          <p>
            <b>Why it matters:</b> summed across agents it catches gaming spread thin across domains,
            which no single agent looking at its own history could see.
          </p>
        </ExpandableRow>
        <ExpandableRow label="successful_payment_count" value={String(profile.successful_payment_count)}>
          <p>
            <b>What it means:</b> completed payments across every domain.
          </p>
          <p>
            <b>Why it matters:</b> the only fact <code>provenPayer</code> checks — 2 or more widens the
            discount cap to 25%.
          </p>
        </ExpandableRow>
        </Accordion>
      </div>
    </>
  );
}

// WHETHER A SIGNAL FIRED IS NOT THE SAME QUESTION AS WHETHER IT SPOKE.
//
// The trace's `active` flag means "this signal contributed prompt text", which
// is the definition summarizeActiveSignals and the generated policy block use.
// Two signals deliberately carry no prompt text at any value —
// disputeCautionWarranted (the level signal already says it) and, when
// inactive, every boolean — so rendering `active` as "fired" reported
// disputeCautionWarranted as not fired on a customer whose dispute caution was
// the whole story.
//
// Fired is a property of the VALUE: the same inactive test the guardrail uses
// when auditing unsupported citations.
function hasFired(value: unknown): boolean {
  return !(value === false || value === "none" || value === 0 || value == null);
}

function SignalsStep({ evaluated }: { evaluated: EvaluatedSignal[] | null }) {
  if (!evaluated) {
    return (
      <MissingBlock what="No evaluate_policy_signals step was captured. This trace predates structured signal capture — re-run the memory arm for this customer." />
    );
  }
  const fired = evaluated.filter((s) => hasFired(s.value));
  return (
    <>
      <p className="rp-prose">
        <b>
          {fired.length} of {evaluated.length} signals fired.
        </b>{" "}
        All are listed — a brake that stayed silent is as much a part of the justification as one that
        did not.
      </p>
      <div className="rp-signals">
        <Accordion>
        {evaluated.map((s) => (
          <ExpandableRow
            key={s.id}
            rowClass={hasFired(s.value) ? "fired" : ""}
            label={
              <>
                <span className={`rp-sigdot ${hasFired(s.value) ? "fired" : "off"}`} />
                {s.id}
                <span className={`rp-kind ${s.kind}`}>{s.kind}</span>
              </>
            }
            value={
              // A counter is not a switch. discountAttemptsForAgent is a number,
              // and "not fired" for a count of zero says less than the count.
              typeof s.value === "number"
                ? `${s.value}`
                : hasFired(s.value)
                  ? `fired — ${JSON.stringify(s.value)}`
                  : "not fired"
            }
          >
            <p>
              <b>Scope:</b> {s.scope}-scoped ·{" "}
              {s.scope === "customer"
                ? "true about the person, so any new agent inherits it unchanged."
                : "computed against the asking agent, so a new agent implements its own."}
            </p>
            <p>
              <b>Value:</b> <code>{JSON.stringify(s.value)}</code>
            </p>
            {s.describe ? (
              <p>
                <b>What the model was told:</b> {s.describe}
              </p>
            ) : (
              <p>
                <b>What the model was told:</b> nothing.{" "}
                {hasFired(s.value)
                  ? "This signal fired but contributes no prompt text of its own — the value still goes over in the policy_signals JSON."
                  : "An inactive signal contributes no prompt text; its value still goes over in the policy_signals JSON."}
              </p>
            )}
            <p>
              <b>Effects:</b>{" "}
              {Object.keys(s.effects).length === 0 ? (
                <em>none — this signal changes no limit</em>
              ) : (
                <code>{JSON.stringify(s.effects)}</code>
              )}
            </p>
          </ExpandableRow>
        ))}
        </Accordion>
      </div>
    </>
  );
}

// The model's raw output, per arm. `proposed` is deliberately read from the
// agent_reasoning step rather than from the decision row, because the decision
// row is POST-guardrail — using it would make the "proposed" and "final"
// columns identical in exactly the cases where the difference is the point.
function armProposal(arm: TraceArm): TracedDecisionShape | null {
  const step = stepOf(arm, "agent_reasoning");
  return (step?.detail.decision as TracedDecisionShape | undefined) ?? null;
}

function DecisionStep({ memory, baseline }: { memory: TraceArm; baseline: TraceArm }) {
  const request = stepOf(memory, "model_request");
  const memProposal = armProposal(memory);
  const baseProposal = armProposal(baseline);
  const memStep = stepOf(memory, "agent_reasoning");

  return (
    <>
      <div className="rp-io-row">
        <div className="rp-io-col input">
          <div className="rp-io-header">
            <span className="rp-io-title">Input</span>
            <span className="rp-io-sub">sent to the model (memory arm)</span>
          </div>
          {request ? (
            <div className="rp-io-body">
              <Accordion>
              <ExpandableRow label="System objective" value="identical in both arms">
                <p>
                  One exported constant used by both arms word-for-word, which is what keeps the baseline
                  a valid control. If the control received even a slightly different objective, any
                  measured difference would be partly the objective's doing.
                </p>
              </ExpandableRow>
              <ExpandableRow
                label="What memory told the model"
                // Counts the "- " bullets buildSignalPolicyText emits. Splitting
                // on "\n- " undercounted by one, because the first bullet has no
                // newline before it.
                value={(() => {
                  const n = (String(request.detail.signal_prose).match(/^- /gm) ?? []).length;
                  return `${n} ${n === 1 ? "finding" : "findings"}`;
                })()}
              >
                <p>
                  Generated from each active signal's own description, so the prompt cannot drift from
                  what the guardrail enforces — both are read off the same registry entry.
                </p>
                <pre className="rp-pre">{String(request.detail.signal_prose)}</pre>
              </ExpandableRow>
              <ExpandableRow
                label="memory_profile keys sent"
                value={`${(request.detail.memory_profile_keys as string[]).length} keys`}
              >
                <p>
                  <code>{(request.detail.memory_profile_keys as string[]).join(", ")}</code>
                </p>
                <p>
                  Conditional keys (<code>dispute_breakdown</code>,{" "}
                  <code>unresolved_dispute_reasons</code>) are dropped when a dispute finding is already
                  stated in the prose, since they are what that finding is derived from.
                </p>
              </ExpandableRow>
              <ExpandableRow
                label="policy_signals keys sent"
                value={`${(request.detail.policy_signals_keys as string[]).length} keys`}
              >
                <p>
                  <code>{(request.detail.policy_signals_keys as string[]).join(", ")}</code>
                </p>
                <p>
                  Only signals the prose does not already state, plus{" "}
                  <code>discountAttemptsForAgent</code> regardless — a count is a magnitude, and prose
                  carries magnitudes badly.
                </p>
              </ExpandableRow>
              </Accordion>
            </div>
          ) : (
            <MissingBlock what="No model_request step was captured, so which keys were sent on this call is unknown." />
          )}
        </div>

        {/* The duration alone read as a mystery number. It is the wall-clock
            time of the real Claude call this step made — labelled as such. */}
        <div className="rp-io-arrow">
          <span className="rp-io-glyph">→</span>
          <span className="rp-io-cap">Claude API</span>
          {memStep && <span className="rp-io-ms">{(memStep.duration_ms / 1000).toFixed(1)}s</span>}
        </div>

        <div className="rp-io-col output">
          <div className="rp-io-header">
            <span className="rp-io-title">Output</span>
            <span className="rp-io-sub">raw, before guardrails</span>
          </div>
          <div className="rp-io-body">
            <Accordion>
              <ArmOutput label="Memory arm" proposal={memProposal} arm={memory} />
              <ArmOutput label="Baseline arm" proposal={baseProposal} arm={baseline} />
            </Accordion>
          </div>
        </div>
      </div>

      {memStep && (
        <div className="rp-kv-card">
          <ExpandableRow
            label="Memory arm reasoning"
            value="generated before the action"
          >
            <pre className="rp-pre">{String(memStep.detail.summary)}</pre>
          </ExpandableRow>
        </div>
      )}
    </>
  );
}

function ArmOutput({
  label,
  proposal,
  arm,
}: {
  label: string;
  proposal: TracedDecisionShape | null;
  arm: TraceArm;
}) {
  if (!proposal) {
    return (
      <div className="rp-arm-out">
        <h5>{label}</h5>
        <MissingBlock what={`No agent_reasoning step captured the raw decision for the ${arm.mode} arm.`} />
      </div>
    );
  }
  const unsupported = arm.decision?.unsupported_factor_citations ?? [];
  return (
    <div className="rp-arm-out">
      <h5>{label}</h5>
      <ExpandableRow label="action" value={proposal.action}>
        <p>One of a per-agent action enum. Guardrails can change the spend attached to an action, and
        can swap it for a non-spend fallback, but never invent an action outside the enum.</p>
      </ExpandableRow>
      <ExpandableRow label="committed_spend_paise" value={money(proposal.committed_spend_paise)}>
        <p>
          Margin this decision commits. <code>null</code> means the action spends nothing — which is
          information, not an inapplicable field.
        </p>
      </ExpandableRow>
      <ExpandableRow label="escalate_to_human" value={String(proposal.escalate_to_human)}>
        <p>
          A disposition, not an action: whether a person signs off before the action happens. Orthogonal
          to which action was chosen.
        </p>
      </ExpandableRow>
      <ExpandableRow
        label="memory_factors_used"
        value={proposal.memory_factors_used.length === 0 ? "[]" : `${proposal.memory_factors_used.length} cited`}
      >
        <p>
          <code>{JSON.stringify(proposal.memory_factors_used)}</code>
        </p>
        <p>
          Self-reported attribution from a fixed enum — evidence about the model's stated reasoning, not
          proof of what caused the decision.
        </p>
        {arm.mode === "baseline" && (
          <p>
            <b>Empty is the expected value here.</b> The baseline is given no history, so anything cited
            in this arm would mean memory had leaked into the control. The runner counts those and
            reports them as <code>baselineMemoryLeaks</code>.
          </p>
        )}
        {unsupported.length > 0 && (
          <p className="rp-warn">
            {unsupported.length} unsupported citation{unsupported.length === 1 ? "" : "s"}:{" "}
            <code>{unsupported.join(", ")}</code> — cited as decisive while inactive. Recorded and
            counted, never corrected: silently editing the model's stated reasoning would destroy the
            artifact being measured.
          </p>
        )}
      </ExpandableRow>
    </div>
  );
}

function GuardrailStep({
  memoryGuard,
  baselineGuard,
}: {
  memoryGuard: GuardrailDetail | null;
  baselineGuard: GuardrailDetail | null;
}) {
  if (!memoryGuard) {
    return (
      <MissingBlock what="No policy_override step was captured for the memory arm. Older traces only wrote this row when an override fired; re-run the memory arm to capture the no-override case too." />
    );
  }
  return (
    <>
      {/* THREE SLOTS, ALWAYS. Rendering these only when an override fired would
          hide the far more common case — the guardrail ran and found nothing to
          correct — which is exactly what `applied: false` records. */}
      <div className="rp-override-row">
        <div className="rp-slot proposed">
          <h5>Model proposed</h5>
          <p>
            {memoryGuard.proposed.action} · {spendPhrase(memoryGuard.proposed.committed_spend_paise)}
          </p>
        </div>
        <div className="rp-slot-arrow">→</div>
        <div className="rp-slot check">
          <h5>Checked against</h5>
          <p>
            {memoryGuard.capping_signal ? (
              <>
                <code>{memoryGuard.capping_signal}</code> → {memoryGuard.cap_percent}% cap (
                {formatPaise(memoryGuard.cap_paise)})
              </>
            ) : (
              <>
                default {memoryGuard.cap_percent}% cap ({formatPaise(memoryGuard.cap_paise)}) — no signal
                tightened it
              </>
            )}
          </p>
          {memoryGuard.blocking_signals.length > 0 && (
            <p className="rp-warn">blocked by: {memoryGuard.blocking_signals.join(", ")}</p>
          )}
        </div>
        <div className="rp-slot-arrow">→</div>
        <div className={`rp-slot final ${memoryGuard.applied ? "changed" : ""}`}>
          <h5>Final action</h5>
          <p>
            {memoryGuard.final.action} · {spendPhrase(memoryGuard.final.committed_spend_paise)}
          </p>
          <span className={`rp-badge ${memoryGuard.applied ? "changed" : "clean"}`}>
            {memoryGuard.applied ? "override applied" : "no override"}
          </span>
        </div>
      </div>

      <div className="rp-kv-card">
        <h4>What the guardrail recorded</h4>
        <div className="rp-kv-row">
          <span className="rp-k">notes</span>
          <span className="rp-v">
            {memoryGuard.notes.length === 0 ? <em>none — nothing needed correcting</em> : memoryGuard.notes.join("; ")}
          </span>
        </div>
        <div className="rp-kv-row">
          <span className="rp-k">triggered_by</span>
          <span className="rp-v">
            {memoryGuard.triggered_by.length === 0 ? <em>none</em> : memoryGuard.triggered_by.join(", ")}
          </span>
        </div>
      </div>

      {/* The genuine divergence on this event is the CEILING, not the outcome. */}
      <div className="rp-cap-compare">
        <h4>What each arm was permitted to spend</h4>
        <div className="rp-cap-bars">
          <CapBar
            label="Baseline"
            guard={baselineGuard}
            eventAmount={memoryGuard.event_amount_paise}
            tone="baseline"
          />
          <CapBar
            label="Memory"
            guard={memoryGuard}
            eventAmount={memoryGuard.event_amount_paise}
            tone="memory"
          />
        </div>
        {baselineGuard && (
          <p className="rp-prose">
            <b>{formatPaise(baselineGuard.cap_paise - memoryGuard.cap_paise)} less</b> permitted, via{" "}
            <code>{memoryGuard.capping_signal ?? "no signal"}</code>.{" "}
            {!memoryGuard.applied && "Nothing was clamped — the model proposed no spend."}
          </p>
        )}
      </div>

      <div className="rp-kv-card">
        <ExpandableRow label="Why two enforcement layers" value="universal + memory-derived">
          <p>
            <code>enforceUniversalPolicy</code> runs on both arms identically — spend bounds,
            action/spend coherence, the default ceiling. <code>resolveSignalEffects</code> runs on the
            memory arm only and moves that ceiling, blocks it, or forces escalation.
          </p>
          <p>
            Sharing the universal layer is what stops "memory saved money" from merely measuring the
            presence of a guardrail.
          </p>
        </ExpandableRow>
      </div>
    </>
  );
}

function CapBar({
  label,
  guard,
  eventAmount,
  tone,
}: {
  label: string;
  guard: GuardrailDetail | null;
  eventAmount: number;
  tone: string;
}) {
  if (!guard) {
    return (
      <div className="rp-capbar">
        <span className="rp-capbar-label">{label}</span>
        <Missing what="no guardrail step for this arm" />
      </div>
    );
  }
  // Width is the cap as a fraction of the event amount — a real ratio, not a
  // cosmetic scale.
  const pct = eventAmount > 0 ? (guard.cap_paise / eventAmount) * 100 : 0;
  return (
    <div className="rp-capbar">
      <span className="rp-capbar-label">{label}</span>
      <span className="rp-capbar-track">
        <span className={`rp-capbar-fill ${tone}`} style={{ width: `${pct}%` }} />
      </span>
      <span className="rp-capbar-val">
        {guard.cap_percent}% · {formatPaise(guard.cap_paise)}
      </span>
    </div>
  );
}

function ExecutionStep({
  trace,
  memory,
  baseline,
  memoryGuard,
  baselineGuardCapPercent,
}: {
  trace: ReplayTrace;
  memory: TraceArm;
  baseline: TraceArm;
  memoryGuard: GuardrailDetail | null;
  baselineGuardCapPercent: number | null;
}) {
  const event = trace.event!;
  const decision = memory.decision;
  if (!decision) {
    return <MissingBlock what="No decision row exists for the memory arm on this event." />;
  }

  const eventAmount = (event.detail.amount ?? event.detail.plan_amount) as number | undefined;

  const spend = decision.committed_spend_paise;
  // What the link would actually charge: the event amount less any committed
  // discount. When nothing was committed this is the full amount — the decision
  // was a reminder, and the reminder points at the original cart.
  const payable = eventAmount != null ? eventAmount - (spend ?? 0) : null;

  const diverged =
    baseline.decision != null &&
    (baseline.decision.action !== decision.action ||
      (baseline.decision.committed_spend_paise ?? 0) !== (spend ?? 0) ||
      baseline.decision.escalate_to_human !== decision.escalate_to_human);

  return (
    <>
      <div className="rp-final-compare">
        <div className="rp-final-col">
          <h5>Baseline decided</h5>
          {baseline.decision ? (
            <p>
              {baseline.decision.action} · {spendPhrase(baseline.decision.committed_spend_paise)}
              {baseline.decision.escalate_to_human && " · ⚑ human review"}
            </p>
          ) : (
            <Missing what="no baseline decision row" />
          )}
        </div>
        <div className="rp-final-col">
          <h5>Memory decided</h5>
          <p>
            {decision.action} · {spendPhrase(spend)}
            {decision.escalate_to_human && " · ⚑ human review"}
          </p>
        </div>
        <div className={`rp-final-verdict ${diverged ? "diverged" : "same"}`}>
          {diverged ? "arms diverged" : "arms agreed"}
        </div>
      </div>

      {!diverged && memoryGuard && (
        <p className="rp-prose">
          Both arms reached the same action. What memory changed was the <b>ceiling</b> —{" "}
          {memoryGuard.cap_percent}% against the baseline's {baselineGuardCapPercent ?? "default"}%.
          Reported as it happened, not framed as a win: here the constraint did not bind.
        </p>
      )}

      <div className="rp-paylink-card">
        <div className="rp-paylink-top">
          <div>
            <div className="rp-paylink-amount">
              {payable != null ? formatPaise(payable) : <Missing what="event has no amount" />}
              {spend != null && eventAmount != null && (
                <span className="rp-paylink-orig">{formatPaise(eventAmount)}</span>
              )}
            </div>
            <div className="rp-paylink-hint">
              {spend != null
                ? `${money(spend)} discount committed by ${decision.action}`
                : `no discount committed — this link charges the full cart amount`}
            </div>
          </div>
        </div>
        <div className="rp-paylink-actions">
          {/* The existing manual, demo-only button — a real Razorpay test-mode
              call, fired by a click and never automatically. */}
          <SendPaymentLinkButton
            customerId={trace.customer.customer_id}
            eventId={event.event_id}
            amountPaise={payable ?? 0}
            description={`Cart recovery — ${event.event_id}`}
          />
        </div>
      </div>

      {/* The audit row, read as English rather than as three columns.
          `escalation_reason: null` in particular was actively misleading — it
          reads as missing data when it means the opposite: nobody needed to be
          involved. Raw values are kept on `title` so the underlying record is
          still one hover away and nothing is actually hidden. */}
      <div className="rp-kv-card">
        <h4>Audit record</h4>
        <div className="rp-kv-row">
          <span className="rp-k">Human sign-off</span>
          <span className="rp-v">
            {decision.escalate_to_human
              ? `Required — ${decision.escalation_reason ?? "reason not recorded"}`
              : "Not required"}
          </span>
        </div>
        <div className="rp-kv-row">
          <span className="rp-k">Decided</span>
          <span className="rp-v" title={decision.timestamp}>
            {formatWhen(decision.timestamp)}
          </span>
        </div>
        <ExpandableRow
          label="Governed by policy"
          value={decision.policy_version ?? <Missing what="no policy version on this row" />}
        >
          <p>
            Which policy produced this decision: a manually bumped version, then a hash of every
            threshold and the signal registry's shape.
          </p>
          <p>
            Without it, changing a threshold would make every historical row uninterpretable — you could
            still see what the signals said, but not what the rules did with them.
          </p>
        </ExpandableRow>
      </div>
    </>
  );
}
