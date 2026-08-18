// nano-workforce — the published vocab view (epic #152 / N1 #145, ADR 0059 revised).
//
// Projects the crew vocabulary artifact onto the `GET /agentic/vocab` contract: `{ networks,
// requirements, version }`. `networks` is the raw artifact tree (authored in the `@nanobpm/agentic`
// `VocabDocument` schema — a worker/tool consuming the endpoint gets the same document the resolver
// was built from); `requirements` is the flattened per-token enrolment gate (each role's `requires`
// predicates, seats and diversity flag) so a worker can see WHAT capability a token demands without
// re-deriving the tree.
import type { VocabRequirement, VocabView } from "../../../nano-generated/api-io.d.ts";
import { CREW_VOCAB, CREW_VOCAB_VERSION, crewResolver } from "./crew-vocab.ts";

/** The published, flattened enrolment requirements — one entry per crew-vocab leaf token, sorted. */
export function vocabRequirements(): VocabRequirement[] {
  return crewResolver()
    .roles()
    .map((role) => {
      const requirement: VocabRequirement = {
        token: role.token,
        role: role.role,
        requires: role.requires.map((predicate) => predicate.source),
        seats: typeof role.seats === "number" ? role.seats : [...role.seats],
        seatsDistinctFamily: role.seatsDistinctFamily,
      };
      if (role.network !== undefined) requirement.network = role.network;
      if (role.weight !== undefined) requirement.weight = role.weight;
      return requirement;
    });
}

/** The full published vocab view for `GET /agentic/vocab`. */
export function vocabView(): VocabView {
  return {
    version: CREW_VOCAB_VERSION,
    networks: { ...CREW_VOCAB.networks },
    requirements: vocabRequirements(),
  };
}
