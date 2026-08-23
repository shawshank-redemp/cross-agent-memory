import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { formatPaise, SCENARIO_LABELS, type ComparisonReport } from "../api";

function KpiCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="kpi-card">
      <div className="kpi-label">{label}</div>
      <div className="kpi-value">{value}</div>
      {sub && <div className="kpi-sub">{sub}</div>}
    </div>
  );
}

export function OverviewSection({ report }: { report: ComparisonReport }) {
  const { overall, byScenario, crossDomainSuppression } = report;

  const discountChartData = byScenario
    .filter((s) => s.baselineDiscountPaise > 0 || s.memoryDiscountPaise > 0)
    .map((s) => ({
      scenario: SCENARIO_LABELS[s.scenario],
      Baseline: s.baselineDiscountPaise / 100,
      "Memory-informed": s.memoryDiscountPaise / 100,
    }));

  const escalationChartData = byScenario.map((s) => ({
    scenario: SCENARIO_LABELS[s.scenario],
    Baseline: s.baselineEscalations,
    "Memory-informed": s.memoryEscalations,
  }));

  const discountAvoidedPct = overall.baselineDiscountPaise
    ? Math.round((overall.discountAvoidedPaise / overall.baselineDiscountPaise) * 100)
    : 0;

  return (
    <section>
      <div className="kpi-row">
        <KpiCard
          label="Discount spend avoided"
          value={formatPaise(overall.discountAvoidedPaise)}
          sub={`${discountAvoidedPct}% reduction vs. baseline`}
        />
        <KpiCard
          label="Baseline discount spend"
          value={formatPaise(overall.baselineDiscountPaise)}
        />
        <KpiCard label="Memory-informed spend" value={formatPaise(overall.memoryDiscountPaise)} />
        <KpiCard
          label="Cross-domain suppressions"
          value={`${crossDomainSuppression.suppressed}/${crossDomainSuppression.customersChecked}`}
          sub="disputed customers whose next cart discount was capped or dropped"
        />
        <KpiCard
          label="Escalations (baseline → memory)"
          value={`${overall.baselineEscalations} → ${overall.memoryEscalations}`}
          sub="volume goes up, but targeted (see Normal below)"
        />
      </div>

      <div className="chart-grid">
        <div className="chart-card">
          <h3>Discount spend by scenario (₹)</h3>
          <ResponsiveContainer width="100%" height={280}>
            <BarChart data={discountChartData} margin={{ top: 8, right: 16, left: 0, bottom: 40 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--grid-line)" />
              <XAxis dataKey="scenario" angle={-25} textAnchor="end" interval={0} height={70} tick={{ fontSize: 12 }} />
              <YAxis tick={{ fontSize: 12 }} />
              <Tooltip formatter={(v: unknown) => `₹${Number(v).toLocaleString("en-IN")}`} />
              <Legend />
              <Bar dataKey="Baseline" fill="var(--baseline-color)" radius={[4, 4, 0, 0]} />
              <Bar dataKey="Memory-informed" fill="var(--memory-color)" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>

        <div className="chart-card">
          <h3>Escalations by scenario</h3>
          <ResponsiveContainer width="100%" height={280}>
            <BarChart data={escalationChartData} margin={{ top: 8, right: 16, left: 0, bottom: 40 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--grid-line)" />
              <XAxis dataKey="scenario" angle={-25} textAnchor="end" interval={0} height={70} tick={{ fontSize: 12 }} />
              <YAxis tick={{ fontSize: 12 }} allowDecimals={false} />
              <Tooltip />
              <Legend />
              <Bar dataKey="Baseline" fill="var(--baseline-color)" radius={[4, 4, 0, 0]} />
              <Bar dataKey="Memory-informed" fill="var(--memory-color)" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      <p className="callout">
        Look at <strong>Normal</strong> in the escalation chart: baseline's dispute agent escalates
        almost every dispute reflexively, with no history to reason from. Memory drops those
        escalations to zero on clean customers while pushing them up sharply for repeat-offender
        and churn-signal patterns — the point isn't escalating <em>more</em>, it's escalating{" "}
        <em>precisely</em>.
      </p>
    </section>
  );
}
