// nano-workforce — the crew vocabulary artifact (enrolment epic #152 / N1 #145, ADR 0059 revised +
// ADR 0056 §8–9).
//
// This is nwf's app-tier CORE vocabulary: the ONE authoritative capability→token map the app applies
// over the agentic channel (REGISTER → SERVE) and publishes at `GET /agentic/vocab`. It is authored
// in the SAME schema `@nanobpm/agentic/vocab` validates (`VocabDocument`) — we CONSUME the resolver,
// merge, diversity and demand machinery; we never re-implement the wire types (AGENTS.md: derivation
// over duplication).
//
// The crew (the agentic-SDLC networks nwf drives):
//   - planning.spar   — the red/blue planning spar. Two named seats (#red / #blue), STRICT
//                       distinct-family: the diversity SLO is RED if both spar seats are one family
//                       (ADR 0056 §10). A frontier planner and a kimi/qwen planner seat #red vs #blue.
//   - planning.finalize — the single planner who folds the spar into one plan.
//   - qa.review       — the red/blue QA review (STRICT distinct-family, two seats).
//   - qa.lint         — the single lint pass.
//   - implementation.senior / .junior / .reviewer — the build crew (reviewer is red/blue).
//   - ci.runner       — the CI runner.
//   - decide          — the bare decision role.
//
// Capability (cognition / weight / family / host) is an ENROLMENT attribute, never a routing token
// (ADR 0056 invariant 3): each role's `requires` gate — not the token — decides WHO may fill it.

import type { VocabDocument } from "@nanobpm/agentic/protocol";
import { CORE_VOCAB_VERSION, VocabResolver } from "@nanobpm/agentic/vocab";

/**
 * The crew vocabulary version. Bumped when the artifact's shape changes so a worker (and the
 * demand×supply report's `demandVersion`) can detect a vocab it doesn't recognise. Seeded from the
 * package's core-vocab version so the two move together.
 */
export const CREW_VOCAB_VERSION = CORE_VOCAB_VERSION;

/**
 * Recursively freezes an object graph. `Object.freeze()` is shallow, so a plain freeze on the vocab
 * artifact still leaves nested `networks` / `roles` / `seats` structures mutable — contradicting the
 * "no consumer can mutate the shared artifact" invariant. Deep-freezing every nested object and array
 * makes the whole document genuinely immutable.
 */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) {
      deepFreeze(nested);
    }
  }
  return value;
}

/**
 * The nwf crew vocabulary document. Authored in the `@nanobpm/agentic` `VocabDocument` schema so the
 * package resolver/merge/diversity all apply unchanged. Deep-frozen so no consumer can mutate the
 * shared artifact — including its nested `networks` / `roles` / `seats` structures (a shallow
 * `Object.freeze` would leave those mutable). Authors extend it with `mergeVocab`, which returns a
 * fresh document.
 */
export const CREW_VOCAB: VocabDocument = deepFreeze({
  version: CREW_VOCAB_VERSION,
  networks: {
    planning: {
      roles: {
        // The red/blue planning spar: two adversarial planners of DISTINCT families (frontier vs
        // kimi/qwen). Strict distinct-family so a single-family spar is an SLO violation (RED).
        spar: {
          requires: ["cognition=planning"],
          weight: 5,
          seats: ["red", "blue"],
          seatsDistinctFamily: true,
        },
        // Folds the spar into one plan — a single senior planner seat.
        finalize: {
          requires: ["cognition=planning", "weight>=4"],
          weight: 5,
          seats: 1,
        },
      },
    },
    qa: {
      roles: {
        // The red/blue QA review — two seats, strict distinct-family (same rationale as the spar).
        review: {
          requires: ["cognition=qa"],
          weight: 3,
          seats: ["red", "blue"],
          seatsDistinctFamily: true,
        },
        // The single lint pass.
        lint: {
          requires: ["cognition=qa"],
          weight: 2,
          seats: 1,
        },
      },
    },
    implementation: {
      roles: {
        senior: {
          requires: ["cognition=implementation", "weight>=4"],
          weight: 5,
          seats: 1,
        },
        junior: {
          requires: ["cognition=implementation"],
          weight: 2,
          seats: 3,
        },
        // The red/blue implementation review.
        reviewer: {
          requires: ["cognition=implementation"],
          weight: 4,
          seats: ["red", "blue"],
          seatsDistinctFamily: true,
        },
      },
    },
    ci: {
      roles: {
        runner: {
          requires: ["cognition=ci"],
          weight: 1,
          seats: 1,
        },
      },
    },
    // A bare role (no network segment): its token is just `decide`.
    decide: {
      roles: {
        decide: {
          requires: ["cognition=decide"],
          weight: 5,
          seats: 1,
        },
      },
    },
  },
});

// One shared resolver over the frozen artifact. The document is re-validated (and every `requires`
// gate parsed) at construction, so a malformed crew vocab fails loudly the first time it is read —
// not silently at match time. Built lazily and memoised so the validation cost is paid once.
let resolver: VocabResolver | undefined;

/** The shared crew {@link VocabResolver} — resolve a declared capability to its SERVE token set. */
export function crewResolver(): VocabResolver {
  if (!resolver) resolver = new VocabResolver(CREW_VOCAB);
  return resolver;
}
