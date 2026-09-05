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

function pct(value: number | null): string {
  return value == null ? "n/a" : `${value}%`;
}

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
  const { adverse, merchant_conceded: merchantConceded, summary } = crossDomainSuppression;

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

  // Memory both cuts spend on some customers and raises it on others, so the
  // reduction alone is not the whole story — the net is shown alongside it
  // rather than letting a one-sided figure stand as the headline.
  const discountReducedPct = overall.baselineDiscountPaise
    ? Math.round((overall.discountReducedPaise / overall.baselineDiscountPaise) * 100)
    : 0;
  const netChange = overall.netDiscountChangePaise;

  return (
    <section>
      <div className="kpi-row">
        <KpiCard
          label="Discount spend avoided"
          value={formatPaise(overall.discountReducedPaise)}
          sub={`${discountReducedPct}% cut where memory spent less; net ${
            netChange > 0 ? "+" : ""
          }${formatPaise(netChange)} overall`}
        />
        <KpiCard
          label="Memory informed spend"
          value={formatPaise(overall.baselineDiscountPaise)}
        />
        <KpiCard label="Baseline discount spend" value={formatPaise(overall.memoryDiscountPaise)} />
        <KpiCard
          label="Suppressed after an adverse dispute"
          value={`${adverse.suppressed}/${adverse.customersChecked}`}
          sub={`${pct(summary.adverseSuppressionRatePct)} — correct: the merchant contested it successfully, or it is still open`}
        />
        <KpiCard
          label="Suppressed after a conceded dispute"
          value={`${merchantConceded.suppressed}/${merchantConceded.customersChecked}`}
          sub={`${pct(summary.merchantConcededSuppressionRatePct)} — false positives: the merchant conceded, so the customer was right to complain`}
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
        The two cross-domain cards above are the same experiment run twice.{" "}
        <strong>Identical event shape in both cohorts</strong> — a paid order, a dispute filed
        against it, then a later abandoned cart. The only difference is how the dispute resolved,
        and that flips which behaviour is correct: suppressing the next discount is right when the
        dispute went against the customer, and a false positive when the merchant conceded it. A system
        that simply reacted to <em>having</em> a dispute would score the same in both columns.
        Across the whole cohort, {summary.correctSuppressions} of {summary.totalSuppressions}{" "}
        suppressions landed on the cohort that deserved them ({pct(summary.correctSuppressionRatePct)}).
      </p>

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
