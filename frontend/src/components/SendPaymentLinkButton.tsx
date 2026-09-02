import { useState } from "react";
import { api, formatPaise, type PaymentLinkResult } from "../api";

// MANUAL, DEMO-ONLY. Creates a real test-mode Razorpay payment link for one
// event, so a demo can show the decision producing a genuine artifact rather
// than a simulated one.
//
// Its only job is to prove the link was really created by Razorpay. It
// deliberately does NOT poll, listen for webhooks, or report whether anyone
// paid — payment status is out of scope by design, and the outcome model in
// src/outcomes/ remains the single source of truth for what a decision was
// worth. Nothing here feeds it.
export function SendPaymentLinkButton({
  customerId,
  eventId,
  amountPaise,
  description,
}: {
  customerId: string;
  eventId: string;
  amountPaise: number;
  description?: string;
}) {
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<PaymentLinkResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function send() {
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      setResult(await api.createPaymentLink({ customerId, eventId, amountPaise, description }));
    } catch (err) {
      // Shown inline rather than thrown or alert()ed — a failed demo click
      // should read as a message on the page, not as a broken app.
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  // Razorpay rejects a non-positive amount, and the zero-value cart the `noise`
  // scenario plants can reach here when a decision committed no spend. Say so
  // on the page rather than letting the click fail with a 400.
  const payable = Number.isInteger(amountPaise) && amountPaise > 0;

  return (
    <div className="payment-link-trigger">
      <button type="button" onClick={send} disabled={loading || !payable}>
        {loading ? "Creating link…" : "Send payment link"}
      </button>
      <span className="muted">
        {" "}
        {payable ? `${formatPaise(amountPaise)} · ${eventId}` : "nothing to charge for on this event"}
      </span>

      {/* Inline, on the same row as the amount and event id — the link and its
          plink id are the whole result, and Razorpay's status plus whether the
          link was newly made or already existed were detail nobody reads. */}
      {result && (
        <span className="payment-link-result">
          {" · "}
          <a href={result.short_url} target="_blank" rel="noreferrer">
            {result.short_url}
          </a>
          {" · "}
          {result.id}
        </span>
      )}

      {error && <div className="payment-link-error">{error}</div>}
    </div>
  );
}
