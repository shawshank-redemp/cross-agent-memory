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

  // Memory spends MORE in aggregate than baseline (₹93,564 vs ₹39,688) — it is
  // not cheaper, it is better-targeted: it cuts spend on customers who don't
  // need convincing and raises it on customers where a discount actually
  // converts. Net revenue is the only number that says whether that
  // reallocation paid for itself, so it leads the section rather than either
  // spend total standing alone as the headline.
  const netChange = overall.netDiscountChangePaise;
  const netRevenueLift = overall.netRevenueLiftPaise;

  return (
    <section>
      <div className="hero-banner">
        <div className="hero-headline">
          Memory spends more on discounts — and nets{" "}
          {netRevenueLift > 0 ? "+" : ""}
          {formatPaise(netRevenueLift)} more revenue
        </div>
        <div className="hero-sub">
          Baseline spent {formatPaise(overall.baselineDiscountPaise)}; memory spent{" "}
          {formatPaise(overall.memoryDiscountPaise)}. Memory is not cheaper — it targets{" "}
          <em>who</em> gets a discount, and that reallocation pays for itself.
        </div>
      </div>

      <div className="kpi-row">
        <KpiCard
          label="Reduced on low-need customers"
          value={formatPaise(overall.discountReducedPaise)}
          sub="Loyal payers and clean customers who didn't need convincing"
        />
        <KpiCard
          label="Increased on high-convert customers"
          value={formatPaise(overall.discountIncreasedPaise)}
          sub="Repeat offenders and conflicted customers where a discount closes the sale"
        />
        <KpiCard
          label="Net discount change"
          value={`${netChange > 0 ? "+" : ""}${formatPaise(netChange)}`}
          sub={`memory spends this much more than baseline overall; net revenue lift ${
            netRevenueLift > 0 ? "+" : ""
          }${formatPaise(netRevenueLift)}`}
        />
        <KpiCard
          label="Baseline discount spend"
          value={formatPaise(overall.baselineDiscountPaise)}
          sub="Same rules, no customer history"
        />
        <KpiCard
          label="Memory discount spend"
          value={formatPaise(overall.memoryDiscountPaise)}
          sub="Spends more per customer where a discount is predicted to convert"
        />
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
