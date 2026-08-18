// Unit coverage for the pure set-admission validator `validateEpicSet` (issue #292, slice S2). It
// exercises the SHAPE + DAG rules directly (no HTTP / no admitPlan), mirroring how app/plan.test.ts
// unit-tests the other pure plan helpers. The operation edge test
// (operations/startEpicSet.admission.integration.test.ts) proves the composed door behaviour.
import { test } from "node:test";
import { assertEquals } from "#test-assert";
import { EpicSetValidationError, validateEpicSet } from "./plan.ts";

const REPO = "owner/repo";
const key = (n: number) => `${REPO}#${n}`;

function expectReject(fn: () => unknown): EpicSetValidationError {
  try {
    fn();
  } catch (err) {
    if (err instanceof EpicSetValidationError) return err;
    throw err;
  }
  throw new Error("expected EpicSetValidationError, but validation passed");
}

test("valid linear DAG resolves every edge to plan keys", () => {
  const edges = validateEpicSet(
    [key(1), key(2), key(3)],
    [
      { consumer: key(2), producer: key(1), package: "p1", capabilityRef: key(1) },
      { consumer: key(3), producer: key(2), package: "p2", capabilityRef: key(2) },
    ],
  );
  assertEquals(edges, [
    { consumer: key(2), producer: key(1), package: "p1", capabilityRef: key(1) },
    { consumer: key(3), producer: key(2), package: "p2", capabilityRef: key(2) },
  ]);
});

test("a diamond DAG (two producers into one consumer) is acyclic and accepted", () => {
  const edges = validateEpicSet(
    [key(1), key(2), key(3), key(4)],
    [
      { consumer: key(3), producer: key(1), package: "a", capabilityRef: key(1) },
      { consumer: key(3), producer: key(2), package: "b", capabilityRef: key(2) },
      { consumer: key(4), producer: key(3), package: "c", capabilityRef: key(3) },
    ],
  );
  assertEquals(edges.length, 3);
});

test("empty set is rejected", () => {
  assertEquals(expectReject(() => validateEpicSet([], [])).status, 400);
});

test("duplicate epic in the set is rejected", () => {
  assertEquals(expectReject(() => validateEpicSet([key(1), key(1)], [])).status, 400);
});

test("edge endpoint outside the set is rejected", () => {
  const err = expectReject(() =>
    validateEpicSet([key(1)], [{ consumer: key(1), producer: key(2), package: "p", capabilityRef: key(2) }]),
  );
  assertEquals(err.status, 400);
});

test("self-edge is rejected", () => {
  const err = expectReject(() =>
    validateEpicSet([key(1)], [{ consumer: key(1), producer: key(1), package: "p", capabilityRef: key(1) }]),
  );
  assertEquals(err.status, 400);
});

test("blank package is rejected", () => {
  const err = expectReject(() =>
    validateEpicSet(
      [key(1), key(2)],
      [{ consumer: key(2), producer: key(1), package: "  ", capabilityRef: key(1) }],
    ),
  );
  assertEquals(err.status, 400);
});

test("blank capabilityRef is rejected", () => {
  const err = expectReject(() =>
    validateEpicSet(
      [key(1), key(2)],
      [{ consumer: key(2), producer: key(1), package: "p", capabilityRef: "" }],
    ),
  );
  assertEquals(err.status, 400);
});

test("a two-node cycle is rejected", () => {
  const err = expectReject(() =>
    validateEpicSet(
      [key(1), key(2)],
      [
        { consumer: key(2), producer: key(1), package: "p", capabilityRef: key(1) },
        { consumer: key(1), producer: key(2), package: "p", capabilityRef: key(2) },
      ],
    ),
  );
  assertEquals(err.status, 400);
});

test("a longer cycle (1→2→3→1) is rejected", () => {
  const err = expectReject(() =>
    validateEpicSet(
      [key(1), key(2), key(3)],
      [
        { consumer: key(1), producer: key(2), package: "p", capabilityRef: key(2) },
        { consumer: key(2), producer: key(3), package: "p", capabilityRef: key(3) },
        { consumer: key(3), producer: key(1), package: "p", capabilityRef: key(1) },
      ],
    ),
  );
  assertEquals(err.status, 400);
});

test("a duplicate edge in one submission is collapsed, not rejected", () => {
  const edges = validateEpicSet(
    [key(1), key(2)],
    [
      { consumer: key(2), producer: key(1), package: "p", capabilityRef: key(1) },
      { consumer: key(2), producer: key(1), package: "p", capabilityRef: key(1) },
    ],
  );
  assertEquals(edges.length, 1);
});

test("edge endpoints given as issue URLs resolve to the same plan keys", () => {
  const edges = validateEpicSet(
    [key(1), key(2)],
    [
      {
        consumer: `https://github.com/${REPO}/issues/2`,
        producer: `https://github.com/${REPO}/issues/1`,
        package: "p",
        capabilityRef: `https://github.com/${REPO}/issues/1`,
      },
    ],
  );
  assertEquals(edges[0].consumer, key(2));
  assertEquals(edges[0].producer, key(1));
});
