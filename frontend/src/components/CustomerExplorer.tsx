import { useEffect, useMemo, useState } from "react";
import { api, SCENARIO_LABELS, type CustomerDetail, type CustomerSummary, type Scenario } from "../api";
import { CustomerDetailView } from "./CustomerDetailView";

export function CustomerExplorer({ customers }: { customers: CustomerSummary[] }) {
  const [scenarioFilter, setScenarioFilter] = useState<Scenario | "all">("all");
  const [divergentOnly, setDivergentOnly] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<CustomerDetail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);

  const filtered = useMemo(() => {
    return customers.filter((c) => {
      if (scenarioFilter !== "all" && c.scenario !== scenarioFilter) return false;
      if (divergentOnly && !c.hasDivergence) return false;
      return true;
    });
  }, [customers, scenarioFilter, divergentOnly]);

  useEffect(() => {
    if (!filtered.some((c) => c.customer_id === selectedId)) {
      setSelectedId(filtered[0]?.customer_id ?? null);
    }
  }, [filtered, selectedId]);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      return;
    }
    setLoadingDetail(true);
    api
      .customerDetail(selectedId)
      .then(setDetail)
      .finally(() => setLoadingDetail(false));
  }, [selectedId]);

  return (
    <section>
      <h2>Customer explorer</h2>
      <div className="explorer-controls">
        <label>
          Scenario:{" "}
          <select value={scenarioFilter} onChange={(e) => setScenarioFilter(e.target.value as Scenario | "all")}>
            <option value="all">All scenarios</option>
            {Object.entries(SCENARIO_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          <input type="checkbox" checked={divergentOnly} onChange={(e) => setDivergentOnly(e.target.checked)} />
          Only show customers where baseline and memory diverged
        </label>
        <span className="muted">{filtered.length} customer(s)</span>
      </div>

      <div className="explorer-layout">
        <ul className="customer-list">
          {filtered.map((c) => (
            <li
              key={c.customer_id}
              className={c.customer_id === selectedId ? "active" : ""}
              onClick={() => setSelectedId(c.customer_id)}
            >
              <div className="customer-list-name">{c.name}</div>
              <div className="muted">
                {SCENARIO_LABELS[c.scenario]} · {c.eventCount} event(s)
                {c.hasDivergence && <span className="divergence-dot" title="baseline/memory diverged" />}
              </div>
            </li>
          ))}
          {filtered.length === 0 && <li className="muted">No customers match this filter.</li>}
        </ul>

        <div className="customer-detail-pane">
          {loadingDetail && <p className="muted">Loading…</p>}
          {!loadingDetail && detail && <CustomerDetailView detail={detail} />}
          {!loadingDetail && !detail && <p className="muted">Select a customer to see their timeline.</p>}
        </div>
      </div>
    </section>
  );
}
