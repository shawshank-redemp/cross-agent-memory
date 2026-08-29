// Facade over the signal registry.
//
// Everything that used to live here — the MemorySignals interface,
// computeMemorySignals, the thresholds, the dispute caution levels — now lives
// in src/agents/signals/, where each signal is a single self-contained object
// declaring how it is computed, how it is explained to the model, and what it
// does to the decision. See signals/registry.ts for why.
//
// This file remains as the import path the rest of the codebase already uses.
export * from "./signals/index.js";
