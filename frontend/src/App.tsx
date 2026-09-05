import { useEffect, useState } from "react";
import "./App.css";
import { api, type ComparisonReport, type CustomerSummary } from "./api";
import { CustomerExplorer } from "./components/CustomerExplorer";
import { OverviewSection } from "./components/OverviewSection";
import { ReplayView } from "./components/ReplayView";
import "./components/ReplayView.css";

// Minimal path routing, no router dependency. There are two pages: the
// dashboard and one replay. Vite's dev server and any static host serve
// index.html for unknown paths, so /replay/<id> reaches this component.
function replayCustomerId(pathname: string): string | null {
  const match = /^\/replay\/([^/?#]+)/.exec(pathname);
  return match ? decodeURIComponent(match[1]!) : null;
}

export default function App() {
  const replayId = replayCustomerId(window.location.pathname);
  if (replayId) return <ReplayView customerId={replayId} />;
  return <Dashboard />;
}

function Dashboard() {
  const [report, setReport] = useState<ComparisonReport | null>(null);
  const [customers, setCustomers] = useState<CustomerSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([api.comparison(), api.customers()])
      .then(([r, c]) => {
        setReport(r);
        setCustomers(c);
      })
      .catch((e) => setError(String(e)));
  }, []);

  return (
    <div className="app">
      <header className="app-header">
        <h1>Cross-Agent Memory</h1>
        <p>
          Shared customer memory across Razorpay's Cart Abandonment, Subscription Recovery, and
          Dispute Responder agents — baseline (no memory) vs memory-informed, on the same
          synthetic batch.
        </p>
      </header>

      {error && <p className="error">Couldn't reach the API: {error}. Is `npm run server:dev` running?</p>}
      {!error && !(report && customers) && <p className="muted">Loading…</p>}

      {report && <OverviewSection report={report} />}
      {customers && <CustomerExplorer customers={customers} />}
    </div>
  );
}
