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

  const baselineByEvent = new Map(detail.decisions.baseline.map((d) => [d.event_id, d]));
  const memoryByEvent = new Map(detail.decisions.memory.map((d) => [d.event_id, d]));

  const expanded = expandedEventId
    ? { baseline: baselineByEvent.get(expandedEventId), memory: memoryByEvent.get(expandedEventId) }
    : null;
  const expandedEvent = detail.events.find((e) => e.event_id === expandedEventId);

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
        <a href={`/replay/${detail.customer.customer_id}`} className="replay-link" target="_blank" rel="noreferrer">View Live Trace →</a>
      </div>
      {detail.note && <p className="muted">{detail.note}</p>}

      <div className="profile-stats">
        <div>
          <strong>Disputes</strong>
          <span>
            {detail.profileCore.dispute_count} ({formatPaise(detail.profileCore.total_disputed_amount)})
          </span>
        </div>
        {detail.profileCore.recovery_activity.by_agent.map((r) => (
          <div key={r.agent}>
            <strong>{r.agent.replace(/_/g, " ")} triggers</strong>
            <span>
              {r.count_all_time}
              {r.count_recent !== r.count_all_time ? ` (${r.count_recent} in last 90d)` : ""}
            </span>
          </div>
        ))}
        {detail.profileCore.intervention_outcomes.map((o) => (
          <div key={`${o.agent}:${o.action}`}>
            <strong>
              {o.agent.replace(/_/g, " ")} · {o.action.replace(/_/g, " ")}
            </strong>
            <span>
              {o.conversions}/{o.attempts} worked
            </span>
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
            {/*
              Only unpaid cart-abandonment events qualify for a Payment Link.
              Subscription failures should use subscription retry, while dispute
              events do not request a new customer payment.
            */}
            {expandedEventId &&
              expandedEvent?.domain === "cart_abandonment" &&
              expandedEvent.detail.status !== "paid" &&
              expanded.memory &&
              ["send_discount", "send_reminder"].includes(expanded.memory.action) &&
              !expanded.memory.escalate_to_human && (
              <SendPaymentLinkButton
                eventId={expandedEventId}
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}
