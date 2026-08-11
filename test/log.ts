// A no-op `Logger` for test doubles. The runtime injects `app.log` into every operation delegate
// and worker handler, but the in-memory `app` fakes the suite builds don't carry one — so a
// delegate that logs on a covered path would throw on `app.log.info(...)`. `createLogger` (exported
// from urban's runtime barrel since 0.42.0) builds a spec-correct Logger over a discarding sink, so
// tests exercise the logging code paths without asserting on them and stay correct if the Logger
// interface grows. Spread into the fake `app`: `{ ...data, log: noopLog() } as unknown as AppApi`.
import { createLogger, type Logger } from "@nanobpm/urban/runtime";

/** A `Logger` that silently discards every record (and whose `child()` does the same). */
export function noopLog(): Logger {
  return createLogger(() => {});
}
