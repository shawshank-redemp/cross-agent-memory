import type { AgentType } from "./events.js";

export interface AuditLogEntry {
  timestamp: string;
  agent: AgentType | "system";
  action: string;
  reasoning: string;
}

export interface DiscountUsageRecord {
  timestamp: string;
  agent: AgentType;
  amount: number; // paise
  order_id: string;
}

export interface RecoveryFrequencyRecord {
  agent: AgentType;
  count: number;
  window_start: string;
  window_end: string;
}

export interface CustomerMemoryProfile {
  customer_id: string;
  dispute_count: number;
  total_disputed_amount: number; // paise
  discount_usage_history: DiscountUsageRecord[];
  recovery_frequency: RecoveryFrequencyRecord[];
  rolling_health_score: number; // 0-100, higher is healthier
  audit_log: AuditLogEntry[];
}
