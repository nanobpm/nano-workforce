// Guard for the app's network posture (nano.app.json). nano-workforce drives a distributed LAN
// worker fleet: remote `senior:*` agents must reach the capability hooks (`/app/api/hooks/abandon`,
// `/app/api/hooks/blackboard`) over the app's hostname. Urban's runtime bind default is loopback
// (secure by default), which silently makes those hooks unreachable off-box — the failure mode
// behind the wedged review agents (jwulf/c8ctl-plugin-nano#76, issue #224): an agent parked on a
// wait-answer escalation it could not resolve because the abandon endpoint refused hostname
// connections. The manifest must therefore declare `network.bind: "all"` so nwf is reachable by
// its fleet out of the box. The LOCAL agentic-channel token is loopback-guarded independently
// (#228) so binding wide does not expose it.
import { test } from "node:test";
import { assert, assertEquals } from "#test-assert";
import { readFileSync } from "node:fs";

test("nano.app.json binds to all interfaces so a remote worker fleet can reach the capability hooks", () => {
  const manifest = JSON.parse(readFileSync(new URL("../nano.app.json", import.meta.url), "utf8"));
  assert(manifest.network, "nano.app.json must declare a network block (fleet reachability)");
  assertEquals(
    manifest.network.bind,
    "all",
    "network.bind must be \"all\": loopback silently makes the capability hooks unreachable off-box for the distributed fleet",
  );
});
