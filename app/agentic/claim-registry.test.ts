// Unit tests for the explicit job-ownership CLAIM registry (#713, upstream keystone nano-ide#542).
//
// The claim registry is the AUTHORITATIVE visibility source that replaces the fragile relay-derived
// jobKeys. These tests pin: idempotent claim / release; the two derived-from-one-write projections
// (instance→jobKeys and jobKey→owner) staying consistent across claim / re-claim (move) / release /
// releaseInstance; the late/duplicate-release no-op; the presence `jobKeysFor` seam; the claim-keyed
// drill `primaryStreamFor`; the reconnect-resync rebuild; the bounded-memory `reconcile`; and the
// sorted snapshot. Mirrors `app/agentic/correlation.test.ts`.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ClaimRegistry,
  currentClaimRegistry,
  setCurrentClaimRegistry,
} from "./claim-registry.ts";

test("claim records both projections; jobKeysFor and primaryStreamFor resolve against it", () => {
  const reg = new ClaimRegistry();
  reg.claim("wk-a", "8420");

  assert.deepEqual(reg.jobKeysFor("wk-a"), ["8420"]);
  assert.equal(reg.ownerOf("8420"), "wk-a");
  assert.equal(reg.isClaimed("8420"), true);
  assert.equal(reg.primaryStreamFor("wk-a"), "job:8420");
  assert.equal(reg.count(), 1);
});

test("claim is idempotent — a duplicate claim of the same {instance, jobKey} is a no-op re-assertion", () => {
  const reg = new ClaimRegistry();
  reg.claim("wk-a", "8420");
  reg.claim("wk-a", "8420");
  reg.claim("wk-a", "8420");
  assert.deepEqual(reg.jobKeysFor("wk-a"), ["8420"]);
  assert.equal(reg.count(), 1);
});

test("empty instance or jobKey is ignored (an empty value is invalid)", () => {
  const reg = new ClaimRegistry();
  reg.claim("", "8420");
  reg.claim("wk-a", "");
  assert.equal(reg.count(), 0);
  assert.deepEqual(reg.jobKeysFor("wk-a"), []);
  reg.release("", "8420");
  reg.release("wk-a", "");
  assert.equal(reg.count(), 0);
});

test("re-claiming a jobKey under a different instance MOVES it (drops the stale reverse edge)", () => {
  const reg = new ClaimRegistry();
  reg.claim("wk-a", "8420");
  reg.claim("wk-b", "8420");
  assert.deepEqual(reg.jobKeysFor("wk-a"), [], "the old owner no longer holds it");
  assert.deepEqual(reg.jobKeysFor("wk-b"), ["8420"], "the new owner holds it");
  assert.equal(reg.ownerOf("8420"), "wk-b");
  assert.equal(reg.count(), 1, "a moved job never double-counts");
});

test("a worker can hold several claims; jobKeysFor is sorted and primaryStreamFor is the lowest", () => {
  const reg = new ClaimRegistry();
  reg.claim("wk-a", "8420");
  reg.claim("wk-a", "8419");
  reg.claim("wk-a", "8421");
  assert.deepEqual(reg.jobKeysFor("wk-a"), ["8419", "8420", "8421"]);
  assert.equal(reg.primaryStreamFor("wk-a"), "job:8419");
});

test("release clears one claim; a late / duplicate release is a no-op", () => {
  const reg = new ClaimRegistry();
  reg.claim("wk-a", "8420");
  reg.release("wk-a", "8420");
  assert.deepEqual(reg.jobKeysFor("wk-a"), []);
  assert.equal(reg.isClaimed("8420"), false);
  assert.equal(reg.count(), 0);
  // Late / duplicate release — a no-op, never throws.
  reg.release("wk-a", "8420");
  // A release with no preceding claim — a no-op.
  reg.release("wk-a", "9999");
  assert.equal(reg.count(), 0);
});

test("release from a non-owner (the job already moved) is a strict no-op — it can't blank the live owner", () => {
  const reg = new ClaimRegistry();
  reg.claim("wk-a", "8420");
  reg.claim("wk-b", "8420"); // moved to wk-b
  reg.release("wk-a", "8420"); // stale release from the former owner
  assert.deepEqual(reg.jobKeysFor("wk-b"), ["8420"], "the current owner's job is untouched");
  assert.equal(reg.ownerOf("8420"), "wk-b");
});

test("releaseInstance clears every claim a worker holds", () => {
  const reg = new ClaimRegistry();
  reg.claim("wk-a", "8420");
  reg.claim("wk-a", "8421");
  reg.claim("wk-b", "8500");
  reg.releaseInstance("wk-a");
  assert.deepEqual(reg.jobKeysFor("wk-a"), []);
  assert.equal(reg.isClaimed("8420"), false);
  assert.equal(reg.isClaimed("8421"), false);
  assert.deepEqual(reg.jobKeysFor("wk-b"), ["8500"], "another instance's claims survive");
  reg.releaseInstance("nobody"); // unknown instance — no-op
});

test("reconnect-resync: re-register + re-claim rebuilds the same claim (never blanks a still-running job)", () => {
  const reg = new ClaimRegistry();
  reg.claim("wk-a", "8420");
  // A WS reconnect drops the connection but presence survives (keyed by instance); the supervisor
  // re-claims every active jobKey. The idempotent claim leaves the jobKey in place across the churn.
  reg.claim("wk-a", "8420");
  assert.deepEqual(reg.jobKeysFor("wk-a"), ["8420"], "the jobKey never blanked across the reconnect");
  assert.equal(reg.count(), 1);
});

test("reconcile drops claims for absent instances, keeps present ones, and reports the released", () => {
  const reg = new ClaimRegistry();
  reg.claim("wk-a", "8420");
  reg.claim("wk-b", "8500");
  reg.claim("wk-c", "8600");
  const released = reg.reconcile(new Set(["wk-b"]));
  assert.deepEqual(released.sort(), ["wk-a", "wk-c"]);
  assert.deepEqual(reg.jobKeysFor("wk-a"), []);
  assert.deepEqual(reg.jobKeysFor("wk-c"), []);
  assert.deepEqual(reg.jobKeysFor("wk-b"), ["8500"], "a present instance's claim survives");
  assert.equal(reg.isClaimed("8420"), false);
  assert.equal(reg.isClaimed("8500"), true);
});

test("primaryStreamFor / jobKeysFor for an unknown instance are undefined / empty", () => {
  const reg = new ClaimRegistry();
  assert.equal(reg.primaryStreamFor("nobody"), undefined);
  assert.deepEqual(reg.jobKeysFor("nobody"), []);
});

test("snapshot is sorted by instance then jobKey and counts held claims", () => {
  const reg = new ClaimRegistry();
  reg.claim("wk-b", "8500");
  reg.claim("wk-a", "8421");
  reg.claim("wk-a", "8420");
  const snap = reg.snapshot();
  assert.deepEqual(snap.claims, [
    { instance: "wk-a", jobKey: "8420" },
    { instance: "wk-a", jobKey: "8421" },
    { instance: "wk-b", jobKey: "8500" },
  ]);
  assert.equal(snap.count, 3);
});

test("currentClaimRegistry / setCurrentClaimRegistry install and clear the singleton", () => {
  assert.equal(currentClaimRegistry(), undefined);
  const reg = new ClaimRegistry();
  setCurrentClaimRegistry(reg);
  assert.equal(currentClaimRegistry(), reg);
  setCurrentClaimRegistry(undefined);
  assert.equal(currentClaimRegistry(), undefined);
});
