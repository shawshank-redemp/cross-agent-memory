import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

export interface ProfileTimelinePoint {
  event_id: string;
  timestamp: string;
  dispute_count: number;
  cart_abandonment_count: number;
  subscription_recovery_count: number;
  dispute_responder_count: number;
}

export function ProfileTimelineChart({ points }: { points: ProfileTimelinePoint[] }) {
  if (points.length < 2) {
    return <p className="muted">Only one event for this customer — nothing to accumulate yet.</p>;
  }

  const data = points.map((p, i) => ({
    label: `#${i + 1}`,
    date: new Date(p.timestamp).toLocaleDateString("en-IN", { month: "short", day: "numeric" }),
    "Cart triggers": p.cart_abandonment_count,
    "Subscription triggers": p.subscription_recovery_count,
    "Dispute triggers": p.dispute_responder_count,
  }));

  return (
    <div className="chart-card">
      <h3>Memory profile accumulation over time</h3>
      <p className="muted">
        What the memory-informed agent actually saw at each event, in order — not the final
        state, the causal snapshot as of that point in the customer's own history.
      </p>
      <ResponsiveContainer width="100%" height={240}>
        <LineChart data={data} margin={{ top: 8, right: 16, left: 0, bottom: 8 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--grid-line)" />
          <XAxis dataKey="date" tick={{ fontSize: 12 }} />
          <YAxis yAxisId="left" tick={{ fontSize: 12 }} domain={[0, 100]} />
          <YAxis yAxisId="right" orientation="right" tick={{ fontSize: 12 }} allowDecimals={false} />
          <Tooltip />
          <Legend />
          <Line yAxisId="right" type="stepAfter" dataKey="Cart triggers" stroke="var(--memory-color)" strokeWidth={1.5} dot={false} />
          <Line yAxisId="right" type="stepAfter" dataKey="Subscription triggers" stroke="#a855f7" strokeWidth={1.5} dot={false} />
          <Line yAxisId="right" type="stepAfter" dataKey="Dispute triggers" stroke="#f97316" strokeWidth={1.5} dot={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
