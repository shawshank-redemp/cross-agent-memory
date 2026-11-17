import { useState } from "react";
import { api, type PaymentLinkResult } from "../api";

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
  eventId,
}: {
  eventId: string;
}) {
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<PaymentLinkResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function send() {
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      setResult(await api.createPaymentLink(eventId));
    } catch (err) {
      // Shown inline rather than thrown or alert()ed — a failed demo click
      // should read as a message on the page, not as a broken app.
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="payment-link-trigger">
      <button type="button" onClick={send} disabled={loading}>
        {loading ? "Creating link…" : "Send payment link"}
      </button>
      <span className="muted"> · amount derived from the approved cart decision · {eventId}</span>

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
