// Node-native test assertions, presenting the small `@std/assert` surface this repo's suite used
// under Deno so the 35 ported `*.test.ts` files keep their call sites unchanged (only their import
// line moved to `#test-assert`). Backed by `node:assert/strict`. Semantics intentionally mirror
// Deno's std/assert (deep structural equality; the throw helpers return the caught error).
import nodeAssert from "node:assert/strict";

/** Deep structural equality (Deno `assertEquals`). */
export function assertEquals<T>(actual: T, expected: T, msg?: string): void {
  nodeAssert.deepStrictEqual(actual, expected, msg);
}

/** Deep structural inequality (Deno `assertNotEquals`). */
export function assertNotEquals<T>(actual: T, expected: T, msg?: string): void {
  nodeAssert.notDeepStrictEqual(actual, expected, msg);
}

/** Truthiness (Deno `assert`). */
export function assert(expr: unknown, msg?: string): asserts expr {
  nodeAssert.ok(expr, msg);
}

/** Substring containment (Deno `assertStringIncludes`). */
export function assertStringIncludes(actual: string, expected: string, msg?: string): void {
  nodeAssert.ok(
    actual.includes(expected),
    msg ?? `expected string to contain "${expected}" but got "${actual}"`,
  );
}

// The constructor rest is `any[]` so error subclasses with required args (e.g. WaveError(message))
// satisfy the type — param contravariance rejects a narrower `unknown[]`/`never[]` here.
type ErrorClass = new (...args: any[]) => Error;

function checkError(error: unknown, ErrorClass?: ErrorClass, msgIncludes?: string): Error {
  const err = error instanceof Error ? error : new Error(String(error));
  const gotName = err.constructor.name;
  if (ErrorClass && !(err instanceof ErrorClass)) {
    nodeAssert.fail(`expected error to be instance of ${ErrorClass.name}, got ${gotName}`);
  }
  if (msgIncludes && !err.message.includes(msgIncludes)) {
    nodeAssert.fail(`expected error message to include "${msgIncludes}", got "${err.message}"`);
  }
  return err;
}

/** Assert a sync fn throws; optionally check the error type/message. Returns the caught error
 *  (Deno `assertThrows`). */
export function assertThrows(
  fn: () => unknown,
  ErrorClass?: ErrorClass,
  msgIncludes?: string,
): Error {
  try {
    fn();
  } catch (error) {
    return checkError(error, ErrorClass, msgIncludes);
  }
  nodeAssert.fail("expected function to throw, but it did not");
}

/** Assert an async fn rejects; optionally check the error type/message. Returns the caught error
 *  (Deno `assertRejects`). */
export async function assertRejects(
  fn: () => Promise<unknown>,
  ErrorClass?: ErrorClass,
  msgIncludes?: string,
): Promise<Error> {
  try {
    await fn();
  } catch (error) {
    return checkError(error, ErrorClass, msgIncludes);
  }
  nodeAssert.fail("expected promise to reject, but it resolved");
}
