import { useEffect, useState } from "react";
import "./App.css";
import { api, type ComparisonReport, type CustomerSummary } from "./api";
import { CustomerExplorer } from "./components/CustomerExplorer";
import { OverviewSection } from "./components/OverviewSection";
import { ReplayView } from "./components/ReplayView";
import "./components/ReplayView.css";

function replayCustomerId(pathname: string): string | null {
  const match = /^\/replay\/([^/?#]+)/.exec(pathname);
  return match ? decodeURIComponent(match[1]!) : null;
}

function isDashboard(pathname: string): boolean {
  return pathname === "/dashboard";
}

export default function App() {
  const pathname = window.location.pathname;
  const replayId = replayCustomerId(pathname);

  if (replayId) return <ReplayView customerId={replayId} />;
  if (isDashboard(pathname)) return <FinalDashboard />;

  // Root "/" — show the landing page
  return <LandingPage />;
}

function LandingPage() {
  const [defaultCustomerId, setDefaultCustomerId] = useState<string | null>(null);

  useEffect(() => {
    api.customers().then((customers) => {
      const diverged = customers.filter((c) => c.hasDivergence);
      const pick = diverged[0] ?? customers[0];
      if (pick) setDefaultCustomerId(pick.customer_id);
    }).catch(() => {});
  }, []);

  const traceUrl = defaultCustomerId ? `/replay/${encodeURIComponent(defaultCustomerId)}` : "#";

  return (
    <div className="landing">
      <nav className="landing-nav">
        <span className="landing-nav-brand">Cross-Agent Memory</span>
        <a
          className="landing-nav-github"
          href="https://github.com/shawshank-redemp/cross.agent-memory"
          target="_blank"
          rel="noopener noreferrer"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 2C6.477 2 2 6.477 2 12c0 4.418 2.865 8.166 6.839 9.489.5.092.682-.217.682-.482 0-.237-.009-.868-.013-1.703-2.782.604-3.369-1.342-3.369-1.342-.454-1.155-1.11-1.462-1.11-1.462-.908-.62.069-.608.069-.608 1.003.07 1.531 1.03 1.531 1.03.892 1.529 2.341 1.087 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.11-4.555-4.943 0-1.091.39-1.984 1.029-2.683-.103-.253-.446-1.27.098-2.647 0 0 .84-.269 2.75 1.025A9.578 9.578 0 0 1 12 6.836a9.59 9.59 0 0 1 2.504.337c1.909-1.294 2.747-1.025 2.747-1.025.546 1.377.203 2.394.1 2.647.64.699 1.028 1.592 1.028 2.683 0 3.842-2.339 4.687-4.566 4.935.359.309.678.919.678 1.852 0 1.336-.012 2.415-.012 2.741 0 .267.18.579.688.481C19.138 20.163 22 16.418 22 12c0-5.523-4.477-10-10-10z"/>
          </svg>
          GitHub
        </a>
      </nav>
      <div className="landing-hero">
        <div className="landing-eyebrow">AI Revenue Recovery · Shared Memory Architecture</div>
        <h1 className="landing-title">Cross-Agent Memory</h1>
        <p className="landing-subtitle">
          Three recovery agents — cart abandonment, subscription failure, and dispute response —
          sharing a single customer memory instead of deciding in silos. Every agent reads what
          the others have already learned, and writes back what it discovers. The result:
          smarter offers, fewer wasted discounts, and recovered revenue that isolated agents miss.
        </p>
        <a className="landing-cta" href={traceUrl}>
          Watch a live decision →
        </a>
      </div>

      <div className="landing-cards">
        <div className="landing-card">
          <div className="landing-card-icon">🛒</div>
          <div className="landing-card-name">Cart Abandonment Agent</div>
          <p>Sees prior dispute history and subscription status before deciding whether to offer a discount — and how large.</p>
        </div>
        <div className="landing-card">
          <div className="landing-card-icon">🔄</div>
          <div className="landing-card-name">Subscription Recovery Agent</div>
          <p>Reads cart signals and dispute flags to avoid over-discounting a customer already mid-recovery from another channel.</p>
        </div>
        <div className="landing-card">
          <div className="landing-card-icon">⚖️</div>
          <div className="landing-card-name">Dispute Response Agent</div>
          <p>Checks if a customer is in an active cart or subscription recovery flow before escalating, preventing contradictory actions.</p>
        </div>
      </div>

      <div className="landing-how">
        <h2>How it works</h2>
        <div className="landing-steps">
          <div className="landing-step">
            <div className="landing-step-num">1</div>
            <div>
              <strong>Event arrives</strong>
              <p>A cart is abandoned, a subscription payment fails, or a dispute is filed.</p>
            </div>
          </div>
          <div className="landing-step">
            <div className="landing-step-num">2</div>
            <div>
              <strong>Agent reads shared memory</strong>
              <p>Before deciding, the agent reads the customer's full cross-agent profile — disputes, recoveries, discount history, trust signals.</p>
            </div>
          </div>
          <div className="landing-step">
            <div className="landing-step-num">3</div>
            <div>
              <strong>Decision adjusts</strong>
              <p>A customer with zero disputes and three paid carts gets a smaller discount. A first-timer with a recent failure gets a more generous offer.</p>
            </div>
          </div>
          <div className="landing-step">
            <div className="landing-step-num">4</div>
            <div>
              <strong>Memory updates</strong>
              <p>The agent writes back what it did and what it observed, so the next agent starts smarter.</p>
            </div>
          </div>
        </div>
      </div>

      <div className="landing-footer-cta">
        <a className="landing-cta" href={traceUrl}>
          See the decision trace →
        </a>
        <span className="landing-footer-note">
          A real agent decision, walked step-by-step through all six stages
        </span>
      </div>
    </div>
  );
}

function FinalDashboard() {
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
        <div className="dash-nav">
          <a href="/" className="dash-back">← Back to overview</a>
        </div>
        <h1>Results Dashboard</h1>
        <p>
          Baseline (no memory) vs memory-informed agents on the same synthetic customer batch —
          cart abandonment, subscription recovery, and dispute response.
        </p>
      </header>

      {error && <p className="error">Couldn't reach the API: {error}. Is `npm run server:dev` running?</p>}
      {!error && !(report && customers) && <p className="muted">Loading…</p>}

      {report && <OverviewSection report={report} />}
      {customers && <CustomerExplorer customers={customers} />}
    </div>
  );
}
