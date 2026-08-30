import { useState } from "react";
import { formatPaise, SCENARIO_LABELS, type CustomerDetail, type DecisionRecord } from "../api";
import { ProfileTimelineChart } from "./ProfileTimelineChart";
import { SendPaymentLinkButton } from "./SendPaymentLinkButton";

function decisionSummary(d: DecisionRecord | undefined): string {
  if (!d) return "—";
  const parts = [d.action];
  if (d.committed_spend_paise != null) parts.push(formatPaise(d.committed_spend_paise));
  if (d.escalate_to_human) parts.push("⚑ escalate");
  return parts.join(" · ");
}

function diverged(b: DecisionRecord | undefined, m: DecisionRecord | undefined): boolean {
  if (!b || !m) return false;
  return (
    b.escalate_to_human !== m.escalate_to_human ||
    (b.committed_spend_paise ?? 0) !== (m.committed_spend_paise ?? 0)
  );
}

export function CustomerDetailView({ detail }: { detail: CustomerDetail }) {
  const [expandedEventId, setExpandedEventId] = useState<string | null>(null);

  // Fallback amount for the demo payment link when a decision committed no
  // spend. Reads the event's own value out of the timeline payload, which
  // carries the raw event under `detail`.
  function amountForEvent(eventId: string): number {
    const event = detail.events.find((e) => e.event_id === eventId);
    const raw = event?.detail as { amount?: number; plan_amount?: number } | undefined;
    return raw?.amount ?? raw?.plan_amount ?? 0;
  }

  const baselineByEvent = new Map(detail.decisions.baseline.map((d) => [d.event_id, d]));
  const memoryByEvent = new Map(detail.decisions.memory.map((d) => [d.event_id, d]));

  const expanded = expandedEventId
    ? { baseline: baselineByEvent.get(expandedEventId), memory: memoryByEvent.get(expandedEventId) }
    : null;

  return (
    <div className="customer-detail">
      <div className="customer-header">
        <div>
          <h2>{detail.customer.name}</h2>
          <div className="muted">
            {detail.customer.customer_id} · {detail.customer.plan_tier} tier · signed up{" "}
            {new Date(detail.customer.signup_date).toLocaleDateString()}
          </div>
        </div>
        <span className={`scenario-badge scenario-${detail.scenario}`}>{SCENARIO_LABELS[detail.scenario]}</span>
      </div>
      {detail.note && <p className="muted">{detail.note}</p>}

      <div className="profile-stats">
        <div>
          <strong>Health score</strong>
          <span>{detail.profileCore.rolling_health_score}/100</span>
        </div>
        <div>
          <strong>Disputes</strong>
          <span>
            {detail.profileCore.dispute_count} ({formatPaise(detail.profileCore.total_disputed_amount)})
          </span>
        </div>
        {detail.profileCore.recovery_frequency.map((r) => (
          <div key={r.agent}>
            <strong>{r.agent.replace(/_/g, " ")} triggers</strong>
            <span>{r.count}</span>
          </div>
        ))}
      </div>

      <ProfileTimelineChart points={detail.profileTimeline} />

      <h3>Event-by-event: baseline vs memory-informed</h3>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>When</th>
              <th>Domain</th>
              <th>Baseline</th>
              <th>Memory-informed</th>
            </tr>
          </thead>
          <tbody>
            {detail.events.map((e) => {
              const b = baselineByEvent.get(e.event_id);
              const m = memoryByEvent.get(e.event_id);
              const isDivergent = diverged(b, m);
              return (
                <tr
                  key={e.event_id}
                  className={`${isDivergent ? "divergent" : ""} ${expandedEventId === e.event_id ? "selected" : ""}`}
                  onClick={() => setExpandedEventId(expandedEventId === e.event_id ? null : e.event_id)}
                >
                  <td>{new Date(e.timestamp).toLocaleDateString()}</td>
                  <td>{e.domain.replace(/_/g, " ")}</td>
                  <td>{decisionSummary(b)}</td>
                  <td>{decisionSummary(m)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {expanded && (
        <div className="reasoning-panel">
          <div>
            <h4>Baseline reasoning</h4>
            <p>{expanded.baseline?.reasoning ?? "No decision for this event in baseline mode."}</p>
          </div>
          <div>
            <h4>Memory-informed reasoning</h4>
            <p>{expanded.memory?.reasoning ?? "No decision for this event in memory mode."}</p>
            {/*
              PLACEHOLDER LOCATION. This belongs in the split-panel replay view
              once that is built — it sits here for now because this is where a
              single memory-arm decision is already on screen, which is what the
              button needs to act on.

              Manual and demo-only: one human click, for one chosen event. It is
              not wired to anything that runs per event.
            */}
            {expandedEventId && expanded.memory && (
              <SendPaymentLinkButton
                customerId={detail.customer.customer_id}
                eventId={expandedEventId}
                // The committed spend when the decision granted one; otherwise
                // the event's own amount, so the demo still has something real
                // to charge for on a reminder-only decision.
                amountPaise={expanded.memory.committed_spend_paise ?? amountForEvent(expandedEventId)}
                description={`Recovery offer for ${detail.customer.name} (${expanded.memory.action})`}
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}
