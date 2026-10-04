// PRE-RESOLVED BASELINE DECISIONS, for the batched path.
//
// The baseline arm's request is built from {customer, event} and nothing else —
// no profile, no signals, no prior decisions — so every one of its calls is
// independent and the whole arm can go through the Batch API at half price.
//
// The runner's loop is deliberately untouched by this. It still walks events in
// timestamp order, calls the agent's decide(), records audit and trace rows, and
// applies enforcement per event. All that changes is where the MODEL's answer
// came from: a batch resolved before the loop started, rather than a live call
// inside it. Resume, partial-file writes, failure handling and the run breakers
// therefore behave identically on both paths.
//
// Falling back to a live call when an id is absent is what makes that true: a
// request the batch dropped is simply decided the normal way, so a partial batch
// degrades to the old behaviour rather than losing an event.
import { withClosingInstruction } from "./objective.js";
import type { Customer } from "../types/index.js";

// ONE definition of a baseline user message, used by the batch builder AND by
// each agent's live path. Two copies of this would let the batched and live
// arms quietly describe the same event differently, which is the one thing that
// would invalidate the comparison.
//
// Strip error code fields from event: baseline knows "payment was attempted" but
// not why it failed. The error code is information about a past attempt, which is
// history baseline should not have. Memory gets the full event.
function stripErrorHistory(event: unknown): unknown {
  if (typeof event !== "object" || event === null) return event;
  const { last_error_code, last_error_description, last_method, ...rest } = event as Record<string, unknown>;
  return rest;
}

export function baselineUserContent(customer: Customer, event: unknown): string {
  return withClosingInstruction(JSON.stringify({ customer, event: stripErrorHistory(event) }, null, 2));
}

let prefetched: Map<string, unknown> | null = null;

export function setPrefetchedBaseline(map: Map<string, unknown>): void {
  prefetched = map;
}

// Consumed once. Taking rather than reading keeps the map from being used twice
// for one event if the runner ever retries, which would silently hide a failure
// that ought to reach the per-event catch.
export function takePrefetchedBaseline<T>(eventId: string): T | null {
  if (!prefetched) return null;
  const hit = prefetched.get(eventId);
  if (hit === undefined) return null;
  prefetched.delete(eventId);
  return hit as T;
}

export function prefetchedRemaining(): number {
  return prefetched?.size ?? 0;
}
