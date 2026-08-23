import { useEffect, useState } from "react";
import "./App.css";
import { api, type ComparisonReport, type CustomerSummary } from "./api";
import { CustomerExplorer } from "./components/CustomerExplorer";
import { OverviewSection } from "./components/OverviewSection";

export default function App() {
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
