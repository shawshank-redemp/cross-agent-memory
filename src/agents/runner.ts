import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type Database from "better-sqlite3";
import { openDb } from "../db/connection.js";
import { getModelInUse, getUsageTotals } from "./claudeClient.js";
import { BATCH_DISCOUNT, costUsd, pricingFor } from "../lib/pricing.js";
import {
  CART_ELIGIBLE_SQL,
  DISPUTE_ELIGIBLE_SQL,
  SUBSCRIPTION_ELIGIBLE_SQL,
} from "../db/eligibility.js";
import type { Scenario, ScenarioLabel } from "../data/generator.js";
import { getRunTotals, resetRunTotals } from "./enforcement.js";
import { MAX_FORCED_ESCALATIONS_PER_RUN, RUN_DISCOUNT_BUDGET_PAISE } from "./signals/thresholds.js";
import {
  appendAuditLog,
  recordDiscountUsage,
  recordInterventionOutcome,
  type PolicyOverrideRecord,
} from "../memory/profile.js";
import {
  resolveDisputeResponseOutcome,
  resolveRecoveryOutcome,
  rollsForEvent,
} from "../outcomes/resolveOutcomes.js";
import { POLICY_FINGERPRINT, type MemorySignals } from "./policy.js";
import type {
  AgentType,
  CartAbandonmentEvent,
  Customer,
  DisputeEvent,
  SubscriptionFailureEvent,
} from "../types/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = join(__dirname, "..", "..", "data", "results");
const GENERATED_DIR = join(__dirname, "..", "..", "data", "generated");

const ALL_SCENARIOS: Scenario[] = [
  "normal",
  "repeat_offender_cart",
  "repeat_offender_subscription",
  "repeat_offender_dispute",
  "cross_domain_risk",
  "churn_signal",
  "noise",
];

// The normalisation seam for event identity. Each event table now has its own
// natural primary key — order_id, payment_id, dispute_id — because that is
// what a real Razorpay export has. Everything downstream of here (audit_log,
// agent_trace_events, discount_usage, the decisions JSON, compareRuns) is
// deliberately agent-agnostic and keeps a generic `event_id`, so the two
// vocabularies meet exactly once: right here, where an event is tagged with
// the agent that will handle it.
export type TaggedEvent =
  | { agent: "cart_abandonment"; event_id: string; timestamp: string; event: CartAbandonmentEvent }
  | { agent: "subscription_recovery"; event_id: string; timestamp: string; event: SubscriptionFailureEvent }
  | { agent: "dispute_responder"; event_id: string; timestamp: string; event: DisputeEvent };

export interface DecisionLike {
  reasoning: string;
  memory_factors_used: string[];
  action: string;
  committed_spend_paise: number | null;
  escalate_to_human: boolean;
  escalation_reason: string | null;
  // Which policy governed this decision — metadata about the RUN, never part of
  // the prompt payload and never a citable memory factor.
  policy_version?: string;
  // Memory path only. The baseline path has no memory to compute signals
  // from, so these are absent there by construction rather than by omission.
  signals?: MemorySignals | null;
  policy_override?: PolicyOverrideRecord | null;
  // Memory path only: true when the guardrail could not be evaluated and the
  // conservative decision was substituted.
  guardrail_failed?: boolean;
  // Memory path only: signal ids cited that were not actually active.
  unsupported_factor_citations?: string[];
}

// An event whose decision could not be produced. Recorded rather than thrown:
// one API failure at event 3,000 must not reject every worker and discard a
// run that has already been paid for.
interface FailedEvent {
  event_id: string;
  agent: AgentType;
  customer_id: string;
  error: string;
}

interface DecisionRecord extends DecisionLike {
  agent: AgentType;
  customer_id: string;
  event_id: string;
}

// memory_factors_used must ALWAYS be empty in the baseline arm: baseline
// agents are given no memory, so a citation there means memory has leaked into
// the control and the comparison is no longer measuring what it claims to.
// Loud rather than fatal — a mid-batch throw would discard real progress, and
// the count is reported at the end of the run.
function assertBaselineCitesNoMemory(
  mode: "baseline" | "memory",
  decision: DecisionLike,
  customerId: string,
  eventId: string,
): boolean {
  if (mode !== "baseline" || decision.memory_factors_used.length === 0) return false;
  console.warn(
    `  !! BASELINE MEMORY LEAK: ${customerId} / ${eventId} cited ` +
      `${decision.memory_factors_used.join(", ")} with no memory in context`,
  );
  return true;
}

// Event selection for a targeted run.
//
// --limit alone takes the FIRST N events in timestamp order, which are the
// oldest events in the batch — every one of them has an empty asOf profile,
// so a --limit run exercises the pipeline but never a memory signal. The
// customer-granular filters below are what let a small run actually reach
// gaming/churn/dispute-caution behaviour.
//
// --scenario and --customer are customer-granular on purpose. A customer's
// recovery_frequency and dispute counts are read from the raw event tables
// (asOf-scoped, see profile.ts), so those signals are correct no matter which
// events a run processes. discount_usage_history is NOT — it only contains
// discounts this run actually granted — so dropping some of a customer's
// events mid-stream would under-report stoppingRuleHit. Selecting whole
// customers keeps every one of their events in the run, which keeps the
// stopping rule faithful. --limit does not have that property: it can cut a
// customer off partway. Combining --limit with a filter is fine for a smoke
// test, but read stopping-rule counts from a filter-only run.
export interface EventSelection {
  limit?: number;
  scenarios?: Set<Scenario>;
  customers?: Set<string>;
}

function parseListArg(flag: string): string[] | undefined {
  const arg = process.argv.find((a) => a.startsWith(`${flag}=`));
  if (!arg) return undefined;
  const values = arg
    .slice(flag.length + 1)
    .split(",")
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
  return values.length > 0 ? values : undefined;
}

function parseResume(): boolean {
  return process.argv.includes("--resume");
}

// Events this mode has already decided, read from audit_log's decision rows.
// audit_log is authoritative rather than the partial file: it is written inside
// the same synchronous step as the decision itself, so it cannot be ahead of or
// behind what actually happened.
function loadAlreadyDecided(db: Database.Database, mode: "baseline" | "memory"): Set<string> {
  const rows = db
    .prepare("SELECT DISTINCT event_id FROM audit_log WHERE mode = ? AND entry_type = 'decision' AND event_id IS NOT NULL")
    .all(mode) as { event_id: string }[];
  return new Set(rows.map((r) => r.event_id));
}

function parseSelection(): EventSelection {
  const selection: EventSelection = {};

  const limitArg = process.argv.find((a) => a.startsWith("--limit="));
  if (limitArg) {
    const n = Number(limitArg.split("=")[1]);
    if (Number.isFinite(n) && n > 0) selection.limit = n;
  }

  const scenarios = parseListArg("--scenario");
  if (scenarios) {
    const unknown = scenarios.filter((v) => !ALL_SCENARIOS.includes(v as Scenario));
    if (unknown.length > 0) {
      throw new Error(
        `Unknown --scenario value(s): ${unknown.join(", ")}. Valid scenarios: ${ALL_SCENARIOS.join(", ")}`,
      );
    }
    selection.scenarios = new Set(scenarios as Scenario[]);
  }

  const customers = parseListArg("--customer");
  if (customers) selection.customers = new Set(customers);

  return selection;
}

// Scenario labels live alongside the generated batch rather than in the DB —
// they are generator ground truth about how a customer was planted, not an
// observed fact an agent is allowed to read.
//
// The OUTCOME MODEL is allowed to read them, and does: it is the hidden ground
// truth that decides what actually happens, exactly as it already does in
// compareRuns.ts. The AGENT never sees a scenario. That boundary is what keeps
// the feedback loop honest — memory records what happened, never the
// probability that made it happen.
function loadScenarioLabels(): ScenarioLabel[] {
  const path = join(GENERATED_DIR, "scenario_labels.json");
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as ScenarioLabel[];
  } catch {
    throw new Error(`--scenario needs ${path}; run \`npm run generate:data\` first.`);
  }
}

// customer_id -> planted scenario, for the OUTCOME MODEL only. Tolerates a
// missing labels file: without it the feedback loop simply records nothing,
// which is better than failing a paid run over a ground-truth file the agents
// never read.
function loadScenarioByCustomer(): Map<string, Scenario> {
  try {
    return new Map(loadScenarioLabels().map((l) => [l.customer_id, l.scenario]));
  } catch {
    console.warn("  warning: scenario_labels.json not found — intervention outcomes will not be recorded.");
    return new Map();
  }
}

// The gross amount this decision was about, in paise. Each event type keeps its
// own vocabulary here rather than in the outcome model, the same way
// TriggeringEventFacts does for signals.
function grossAmountFor(item: TaggedEvent): number {
  switch (item.agent) {
    case "cart_abandonment":
      return item.event.amount;
    case "subscription_recovery":
      return item.event.plan_amount;
    case "dispute_responder":
      return item.event.amount;
  }
}

function applySelection(tagged: TaggedEvent[], selection: EventSelection): TaggedEvent[] {
  let selected = tagged;

  if (selection.scenarios) {
    const wanted = selection.scenarios;
    const matching = new Set(
      loadScenarioLabels()
        .filter((l) => wanted.has(l.scenario))
        .map((l) => l.customer_id),
    );
    selected = selected.filter((item) => matching.has(item.event.customer_id));
  }

  if (selection.customers) {
    const wanted = selection.customers;
    const found = new Set(selected.map((item) => item.event.customer_id));
    const missing = [...wanted].filter((id) => !found.has(id));
    if (missing.length > 0) {
      console.warn(`  warning: no events for customer(s): ${missing.join(", ")}`);
    }
    selected = selected.filter((item) => wanted.has(item.event.customer_id));
  }

  // Applied last, so --limit trims the already-filtered set rather than
  // competing with it.
  return selection.limit ? selected.slice(0, selection.limit) : selected;
}

// Whole customers run in parallel; --concurrency tunes how many at once.
// Default 12 is a compromise between wall-clock time and API rate limits —
// lower it if the run starts returning 429s.
const DEFAULT_CONCURRENCY = 12;

function parseConcurrency(): number {
  const arg = process.argv.find((a) => a.startsWith("--concurrency="));
  if (!arg) return DEFAULT_CONCURRENCY;
  const n = Number(arg.split("=")[1]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_CONCURRENCY;
}

function describeSelection(selection: EventSelection): string {
  const parts: string[] = [];
  if (selection.scenarios) parts.push(`--scenario=${[...selection.scenarios].join(",")}`);
  if (selection.customers) parts.push(`--customer=${[...selection.customers].join(",")}`);
  if (selection.limit) parts.push(`--limit=${selection.limit}`);
  return parts.length > 0 ? ` (${parts.join(" ")})` : "";
}

// `notes` is a JSON TEXT column in SQLite but a structured object everywhere
// in TypeScript, so the raw row shape differs from the event shape by exactly
// that one field.
type CartEventRow = Omit<CartAbandonmentEvent, "notes"> & { notes: string };

function loadTaggedEvents(db: Database.Database): { customerById: Map<string, Customer>; tagged: TaggedEvent[] } {
  const customers = db.prepare("SELECT * FROM customers").all() as Customer[];
  const customerById = new Map(customers.map((c) => [c.customer_id, c]));

  // Only events with an open recovery question get their own decision. The
  // ineligible rows stay in the database untouched and are still read by the
  // asOf profile queries — this narrows the decision queue, never memory. See
  // db/eligibility.ts.
  const cartEvents = (
    db.prepare(`SELECT * FROM cart_abandonment_events WHERE ${CART_ELIGIBLE_SQL}`).all() as CartEventRow[]
  ).map((row): CartAbandonmentEvent => ({ ...row, notes: JSON.parse(row.notes) as CartAbandonmentEvent["notes"] }));
  const subEvents = db
    .prepare(`SELECT * FROM subscription_failure_events WHERE ${SUBSCRIPTION_ELIGIBLE_SQL}`)
    .all() as SubscriptionFailureEvent[];
  const disputeEvents = db
    .prepare(`SELECT * FROM dispute_events WHERE ${DISPUTE_ELIGIBLE_SQL}`)
    .all() as DisputeEvent[];

  const tagged: TaggedEvent[] = [
    ...cartEvents.map(
      (event): TaggedEvent => ({
        agent: "cart_abandonment",
        event_id: event.order_id,
        timestamp: event.created_at,
        event,
      }),
    ),
    ...subEvents.map(
      (event): TaggedEvent => ({
        agent: "subscription_recovery",
        event_id: event.payment_id,
        timestamp: event.created_at,
        event,
      }),
    ),
    ...disputeEvents.map(
      (event): TaggedEvent => ({
        agent: "dispute_responder",
        event_id: event.dispute_id,
        timestamp: event.dispute_created_at,
        event,
      }),
    ),
  ].sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  return { customerById, tagged };
}

export interface RunAgentBatchParams {
  mode: "baseline" | "memory";
  outputFile: string;
  decide: (item: TaggedEvent, customer: Customer, db: Database.Database) => Promise<DecisionLike>;
}

// --out= redirects this run's results file.
//
// The results file is REWRITTEN, not merged, with exactly the decisions this
// run produced. That is correct for a full batch and destructive for a targeted
// one: `--customer=X` without this flag replaces a 1,720-decision batch file
// with a single decision, discarding a run that cost real API calls. Analysis
// scripts read the default filenames, so a targeted run should write somewhere
// else and leave the batch alone.
function parseOutputFile(fallback: string): string {
  const arg = process.argv.find((a) => a.startsWith("--out="));
  if (!arg) return fallback;
  const value = arg.slice("--out=".length).trim();
  if (value.length === 0) return fallback;
  // Confined to RESULTS_DIR: this is a filename, not a path, so a stray
  // "../../src/something" cannot be handed to writeFileSync.
  if (value.includes("/") || value.includes("\\")) {
    throw new Error(`--out must be a bare filename (no path separators), got "${value}"`);
  }
  return value;
}

export async function runAgentBatch(params: RunAgentBatchParams): Promise<void> {
  const selection = parseSelection();
  const resume = parseResume();
  const db = openDb();
  const { customerById, tagged } = loadTaggedEvents(db);
  // Read once per run, for the outcome model only — never handed to an agent.
  const scenarioByCustomer = loadScenarioByCustomer();

  // SEED THE RUN BREAKERS from what this arm has already committed, so --resume
  // continues the same budget instead of quietly opening a second one. Without
  // the seed a run resumed three times could approve three full budgets.
  const priorSpend = (
    db
      .prepare("SELECT COALESCE(SUM(amount), 0) AS total FROM discount_usage WHERE mode = ?")
      .get(params.mode) as { total: number }
  ).total;
  const priorForced = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM audit_log
         WHERE mode = ? AND entry_type = 'decision' AND escalate_to_human = 1
           AND policy_override IS NOT NULL
           AND json_extract(policy_override, '$.escalation_reason_forced') = 1`,
      )
      .get(params.mode) as { n: number }
  ).n;
  resetRunTotals(priorSpend, priorForced);

  mkdirSync(RESULTS_DIR, { recursive: true });
  const outputFile = parseOutputFile(params.outputFile);
  const outputPath = join(RESULTS_DIR, outputFile);
  if (outputFile !== params.outputFile) {
    console.log(`Writing results to ${outputFile} (--out) instead of ${params.outputFile}`);
  }
  const partialPath = `${outputPath}.partial.jsonl`;

  let toProcess = applySelection(tagged, selection);

  // --resume skips events this mode has already decided, so a crashed run can
  // be continued without paying again for completed work. Without it the
  // partial file is truncated, because a fresh run's output must not be a
  // silent merge of two different runs.
  const resumedDecisions: DecisionRecord[] = [];
  if (resume) {
    const alreadyDecided = loadAlreadyDecided(db, params.mode);
    if (existsSync(partialPath)) {
      for (const line of readFileSync(partialPath, "utf-8").split("\n")) {
        if (line.trim().length === 0) continue;
        resumedDecisions.push(JSON.parse(line) as DecisionRecord);
      }
    }
    const recovered = new Set(resumedDecisions.map((d) => d.event_id));
    const before = toProcess.length;
    toProcess = toProcess.filter((item) => !alreadyDecided.has(item.event_id));
    console.log(`--resume: skipping ${before - toProcess.length} already-decided event(s)`);

    // audit_log is the authority on what was decided, but only the partial
    // file can reconstruct the decision RECORD. A gap between them means those
    // events are decided-but-unrecoverable and would silently vanish from the
    // output, so say so rather than writing a quietly short results file.
    const unrecoverable = [...alreadyDecided].filter((id) => !recovered.has(id));
    if (unrecoverable.length > 0) {
      console.warn(
        `  warning: ${unrecoverable.length} event(s) are recorded in audit_log but absent from ` +
          `${partialPath}, so their decision records cannot be restored into the results file.`,
      );
    }
  } else if (existsSync(partialPath)) {
    rmSync(partialPath);
  }

  const customerCount = new Set(toProcess.map((item) => item.event.customer_id)).size;
  console.log(
    `Running ${params.mode} agents over ${toProcess.length} event(s) across ${customerCount} customer(s)${describeSelection(selection)}...`,
  );
  if (toProcess.length === 0) {
    console.log("Nothing to process — check the selection flags.");
    db.close();
    return;
  }

  // Concurrency is partitioned BY CUSTOMER, and this is the only partition
  // that is safe. A memory-mode decision writes discount_usage/audit_log rows
  // that a LATER event for the SAME customer reads back through the asOf
  // profile, so a customer's events must stay strictly sequential and in
  // timestamp order or the causal chain breaks. Across customers there is no
  // shared state at all — every profile query in profile.ts filters by
  // customer_id — so interleaving whole customers is invisible to the
  // decision logic and produces the same result a fully sequential run would.
  //
  // better-sqlite3 is synchronous: each statement completes before control
  // returns, and these tasks only interleave at await points (the API call),
  // so no two writes can overlap. Baseline mode reads no memory at all and
  // would be safe at any granularity — it uses the same path for simplicity.
  const byCustomer = new Map<string, TaggedEvent[]>();
  for (const item of toProcess) {
    const existing = byCustomer.get(item.event.customer_id);
    if (existing) existing.push(item);
    else byCustomer.set(item.event.customer_id, [item]);
  }
  const queues = [...byCustomer.values()];

  const decisions: DecisionRecord[] = [...resumedDecisions];
  const failures: FailedEvent[] = [];
  let completed = 0;
  let nextQueue = 0;
  let baselineMemoryLeaks = 0;
  let unsupportedCitations = 0;
  let guardrailFailures = 0;

  // Every decision is appended to a JSONL sidecar the moment it is made, so a
  // hard crash (OOM, SIGKILL, a throw outside the per-event catch) still leaves
  // everything already decided on disk. The sorted .json below is written once
  // at the end; this file is what makes the run recoverable, and what --resume
  // reads back.
  const appendPartial = (record: DecisionRecord): void => {
    appendFileSync(partialPath, JSON.stringify(record) + "\n", "utf-8");
  };

  async function processQueue(queue: TaggedEvent[]): Promise<void> {
    for (const item of queue) {
      const customer = customerById.get(item.event.customer_id);
      if (!customer) continue;

      try {
        await decideOne(item, customer);
      } catch (err) {
        // ONE bad event must not end the run. decide() already retried once
        // internally, so reaching here means the event genuinely failed.
        const message = err instanceof Error ? err.message : String(err);
        failures.push({
          event_id: item.event_id,
          agent: item.agent,
          customer_id: customer.customer_id,
          error: message,
        });
        console.error(`  !! FAILED ${item.agent} ${item.event_id} (${customer.customer_id}): ${message}`);
      }
      completed += 1;
      if (completed % 25 === 0 || completed === toProcess.length) {
        console.log(`  ${completed}/${toProcess.length}${failures.length ? ` (${failures.length} failed)` : ""}`);
      }
    }
  }

  async function decideOne(item: TaggedEvent, customer: Customer): Promise<void> {
      const decision = await params.decide(item, customer, db);

      appendAuditLog(db, {
        customer_id: customer.customer_id,
        agent: item.agent,
        mode: params.mode,
        entry_type: "decision",
        event_id: item.event_id,
        action: decision.action,
        reasoning: decision.reasoning,
        escalate_to_human: decision.escalate_to_human,
        // Recorded on BOTH arms. Baseline is governed by
        // DEFAULT_DISCOUNT_CAP_PERCENT and AGENT_ACTION_POLICY, so it has a
        // policy too — one fingerprint covering the whole policy surface is
        // simpler to explain, and to query, than two partial ones that a reader
        // would have to know how to combine.
        policyVersion: POLICY_FINGERPRINT,
        signals: decision.signals ?? undefined,
        policyOverride: decision.policy_override ?? null,
        metadata: {
          // DB column names are unchanged by the decision-schema rename; the
          // mapping happens here, at the boundary.
          discount_amount: decision.committed_spend_paise,
          memory_factors_used: decision.memory_factors_used,
          escalation_reason: decision.escalation_reason,
          unsupported_factor_citations: decision.unsupported_factor_citations ?? [],
        },
        timestamp: item.timestamp,
      });

      if (decision.committed_spend_paise != null) {
        recordDiscountUsage(db, {
          customer_id: customer.customer_id,
          agent: item.agent,
          mode: params.mode,
          amount: decision.committed_spend_paise,
          event_id: item.event_id,
          // Cart events only: a dispute's order_id points at a PAST order, not
          // at the event being decided, so joining a discount to it would be
          // wrong. event_id above is the universal trace back to the cause.
          order_id: item.agent === "cart_abandonment" ? item.event.order_id : undefined,
          timestamp: item.timestamp,
        });
      }

      // CLOSE THE FEEDBACK LOOP.
      //
      // Resolve what this intervention actually achieved and write it down, so a
      // LATER decision on the same customer can read "we tried this and it did
      // not work". Every other memory field records what the customer did; this
      // is the only one that records what we did and how it turned out.
      //
      // Two properties make this safe rather than circular:
      //
      //   The dice are the SAME dice the comparison uses. rollsForEvent is
      //   seeded from event_id alone, so resolving here gives byte-identical
      //   outcomes to resolving at analysis time. Recording early changes what
      //   is KNOWN during the run, never what HAPPENED.
      //
      //   Memory reads the realised OUTCOME, never the PROBABILITY. The scenario
      //   and OUTCOME_PROBABILITIES stay on this side of the boundary; the
      //   profile stores only "we discounted, they paid". That is exactly what a
      //   production payment webhook would deliver.
      //
      // recordInterventionOutcome stamps observed_at = timestamp + the
      // observation lag, and the profile read filters on observed_at — so a
      // decision can never see an outcome that had not happened yet.
      const scenario = scenarioByCustomer.get(customer.customer_id);
      if (scenario) {
        const outcome =
          item.agent === "dispute_responder"
            ? resolveDisputeResponseOutcome(item.event_id, scenario, grossAmountFor(item), {
                action: decision.action,
                escalate_to_human: decision.escalate_to_human,
              })
            : resolveRecoveryOutcome(
                item.event_id,
                item.agent,
                scenario,
                grossAmountFor(item),
                {
                  committed_spend_paise: decision.committed_spend_paise,
                  escalate_to_human: decision.escalate_to_human,
                },
                rollsForEvent(item.event_id),
              );
        recordInterventionOutcome(db, {
          customerId: customer.customer_id,
          agent: item.agent,
          mode: params.mode,
          eventId: item.event_id,
          // The FINAL action after enforcePolicy, not what the model first
          // asked for: the loop must learn from what was actually done.
          action: decision.action,
          committedSpendPaise: decision.committed_spend_paise,
          converted: outcome.paid === true,
          amountCollectedPaise: outcome.money_collected,
          decidedAt: item.timestamp,
        });
      }

      if (assertBaselineCitesNoMemory(params.mode, decision, customer.customer_id, item.event_id)) {
        baselineMemoryLeaks += 1;
      }
      unsupportedCitations += decision.unsupported_factor_citations?.length ?? 0;
      if (decision.guardrail_failed) guardrailFailures += 1;

      const record: DecisionRecord = {
        agent: item.agent,
        customer_id: customer.customer_id,
        event_id: item.event_id,
        reasoning: decision.reasoning,
        memory_factors_used: decision.memory_factors_used,
        action: decision.action,
        committed_spend_paise: decision.committed_spend_paise,
        escalate_to_human: decision.escalate_to_human,
        escalation_reason: decision.escalation_reason,
        unsupported_factor_citations: decision.unsupported_factor_citations ?? [],
        policy_version: POLICY_FINGERPRINT,
      };
      decisions.push(record);
      appendPartial(record);
  }

  // Workers pull the next whole customer off a shared cursor, so a customer
  // with 7 events never blocks a worker that could be starting another one.
  async function worker(): Promise<void> {
    while (nextQueue < queues.length) {
      const queue = queues[nextQueue++]!;
      await processQueue(queue);
    }
  }

  const concurrency = Math.min(parseConcurrency(), queues.length);
  console.log(`  concurrency: ${concurrency} customer(s) in flight`);
  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  // Restore deterministic output ordering. Decisions land in completion order
  // under concurrency, which varies run to run with API latency; the results
  // file and everything downstream of it should not.
  decisions.sort((a, b) => a.event_id.localeCompare(b.event_id));

  db.close();

  writeFileSync(outputPath, JSON.stringify(decisions, null, 2) + "\n", "utf-8");

  const actionCounts: Record<string, number> = {};
  let totalDiscount = 0;
  let escalations = 0;
  for (const d of decisions) {
    actionCounts[d.action] = (actionCounts[d.action] ?? 0) + 1;
    if (d.committed_spend_paise) totalDiscount += d.committed_spend_paise;
    if (d.escalate_to_human) escalations++;
  }

  console.log(`Wrote ${decisions.length} decisions to ${outputPath}`);
  // Attribution counts are reported, never used to alter a decision:
  // memory_factors_used is self-reported evidence about the model's stated
  // reasoning, not ground truth about what caused the decision.
  const factorCounts: Record<string, number> = {};
  for (const d of decisions) {
    for (const f of d.memory_factors_used) factorCounts[f] = (factorCounts[f] ?? 0) + 1;
  }
  console.log(
    JSON.stringify(
      {
        actionCounts,
        totalDiscountPaise: totalDiscount,
        escalations,
        memoryFactorCitations: factorCounts,
        unsupportedFactorCitations: unsupportedCitations,
        baselineMemoryLeaks,
        guardrailFailures,
        // The run breakers. Reported unconditionally, not only when they trip:
        // "the breaker was never approached" and "there is no breaker" have to
        // look different in a summary, the same reason the guardrail trace row
        // is always emitted.
        discountBudget: {
          committedPaise: getRunTotals().spendPaise,
          budgetPaise: RUN_DISCOUNT_BUDGET_PAISE,
          spendRefusals: getRunTotals().spendRefusals,
        },
        escalationBudget: {
          forced: getRunTotals().forcedEscalations,
          budget: MAX_FORCED_ESCALATIONS_PER_RUN,
          refusals: getRunTotals().escalationRefusals,
        },
      },
      null,
      2,
    ),
  );
  const totals = getRunTotals();
  const pctOfBudget = ((totals.spendPaise / RUN_DISCOUNT_BUDGET_PAISE) * 100).toFixed(1);
  console.log(
    `\nRun breakers: discount ₹${Math.round(totals.spendPaise / 100).toLocaleString("en-IN")} of ` +
      `₹${Math.round(RUN_DISCOUNT_BUDGET_PAISE / 100).toLocaleString("en-IN")} (${pctOfBudget}%), ` +
      `forced escalations ${totals.forcedEscalations} of ${MAX_FORCED_ESCALATIONS_PER_RUN}`,
  );
  if (totals.spendRefusals > 0 || totals.escalationRefusals > 0) {
    console.error(
      `\n!! A RUN BREAKER TRIPPED: ${totals.spendRefusals} spend refusal(s), ` +
        `${totals.escalationRefusals} escalation refusal(s). These are safety limits that ordinary ` +
        `operation should never reach — treat this run's numbers as evidence of a misfire, not as a result.`,
    );
  }

  if (baselineMemoryLeaks > 0) {
    console.warn(
      `\n!! ${baselineMemoryLeaks} baseline decision(s) cited memory factors. The control arm is ` +
        `supposed to have no history in context — investigate before trusting this comparison.`,
    );
  }

  if (guardrailFailures > 0) {
    // Loud, because these decisions were made by the fail-closed path rather
    // than by the agent — the run "succeeded" but that many cases were handed
    // to a human without being reasoned about.
    console.warn(
      `\n!! ${guardrailFailures} decision(s) failed closed: the guardrail could not be evaluated, so ` +
        `no spend was committed and each was escalated for human review.`,
    );
  }

  // A partial run must never be mistaken for a complete one. The counts are
  // printed either way, and a non-zero exit is what stops a downstream
  // `npm run analyze:compare` in a shell chain from scoring an incomplete arm.
  // Actual token spend for this process. Only counts calls THIS run made, so a
  // --resume run reports the cost of the retry, not of the original attempt.
  const usage = getUsageTotals();
  const model = getModelInUse();
  const pricing = pricingFor(model);
  console.log(`\nAPI usage (this run): ${usage.calls} call(s), ${model}`);
  console.log(
    `  input  ${usage.inputTokens.toLocaleString()} tokens` +
      (usage.calls > 0 ? `  (${Math.round(usage.inputTokens / usage.calls)}/call)` : ""),
  );
  console.log(
    `  output ${usage.outputTokens.toLocaleString()} tokens` +
      (usage.calls > 0 ? `  (${Math.round(usage.outputTokens / usage.calls)}/call)` : ""),
  );
  if (usage.cacheReadTokens > 0 || usage.cacheCreationTokens > 0) {
    console.log(`  cache  ${usage.cacheReadTokens.toLocaleString()} read, ${usage.cacheCreationTokens.toLocaleString()} written`);
  }
  if (pricing) {
    const actual = costUsd(usage.inputTokens, usage.outputTokens, pricing);
    console.log(`  cost   $${actual.toFixed(2)} at ${model} rates ($${pricing.inputPerMTok}/$${pricing.outputPerMTok} per Mtok)`);
    console.log(`         $${(actual * BATCH_DISCOUNT).toFixed(2)} had this gone through the Batch API`);
  } else {
    // Never invent a price for an unrecognised model — the token counts above
    // are the answer, and a confidently wrong dollar figure is worse than none.
    console.log(`  cost   no published pricing for "${model}" in lib/pricing.ts — tokens reported above`);
  }

  console.log(
    `\nRun summary: ${toProcess.length} event(s) attempted, ${decisions.length - resumedDecisions.length} decided, ` +
      `${failures.length} failed` +
      (resumedDecisions.length > 0 ? `, ${resumedDecisions.length} restored from a previous run` : ""),
  );
  if (failures.length > 0) {
    console.error(`\n!! ${failures.length} event(s) failed and have NO decision:`);
    for (const f of failures) {
      console.error(`   ${f.agent} ${f.event_id} (${f.customer_id}): ${f.error}`);
    }
    console.error(
      `\nRe-run with --resume to retry only these; ${partialPath} holds everything already decided.`,
    );
    process.exitCode = 1;
  }
}
