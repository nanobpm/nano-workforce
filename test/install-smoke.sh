#!/bin/sh
# Hermetic smoke test for install.sh — asserts the command sequence it EMITS
# under --dry-run for a few selections, plus the guard-rail exit codes. No CLI,
# npm or coding harness is installed: --dry-run means the mutating commands are
# printed (never run), harness detection is stubbed via
# NANO_INSTALL_HARNESSES_OVERRIDE, and adapter presence via
# NANO_INSTALL_ADAPTERS_PRESENT. Only `node` is required (the preflight probe).
#
# Run from the repo root:  sh test/install-smoke.sh
set -eu

ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
SCRIPT="$ROOT/install.sh"
FAILED=0

pass() { printf 'PASS: %s\n' "$1"; }
fail() { printf 'FAIL: %s\n' "$1" >&2; FAILED=1; }

# assert_contains "<label>" "<needle>" "<haystack>"
assert_contains() {
  case "$3" in
    *"$2"*) pass "$1" ;;
    *) fail "$1 — expected to find: $2"; printf '%s\n' "$3" | sed 's/^/    | /' >&2 ;;
  esac
}
assert_not_contains() {
  case "$3" in
    *"$2"*) fail "$1 — did NOT expect: $2" ;;
    *) pass "$1" ;;
  esac
}

# --- Scenario 1: copilot + qwen, models + instances, dry-run ----------------
OUT=$(NANO_INSTALL_HARNESSES_OVERRIDE="copilot qwen" \
  sh "$SCRIPT" --harness copilot:gpt-5.4:5 --harness qwen:qwen3-coder-plus:2 --yes --dry-run 2>&1)
assert_contains "s1: copilot model baked into --command" \
  "--command 'copilot --acp --model gpt-5.4'" "$OUT"
assert_contains "s1: copilot --model bookkeeping" "--model 'gpt-5.4'" "$OUT"
assert_contains "s1: copilot hired senior/acp/yolo" \
  "--rank senior --command 'copilot --acp --model gpt-5.4' --model 'gpt-5.4' --capabilities '' --protocol acp --permission yolo" "$OUT"
assert_contains "s1: qwen model baked (mandatory)" \
  "--command 'qwen --experimental-acp --model qwen3-coder-plus'" "$OUT"
assert_contains "s1: workforce add copilot x5 auto" \
  "nano workforce add copilot --instances 5 --auto" "$OUT"
assert_contains "s1: workforce add qwen x2 auto" \
  "nano workforce add qwen --instances 2 --auto" "$OUT"
assert_contains "s1: engine start then workforce start" "nano start" "$OUT"
assert_contains "s1: workforce start" "nano workforce start" "$OUT"
assert_contains "s1: yolo warning shown" "UNATTENDED with --permission yolo" "$OUT"

# --- Scenario 2: qwen with NO model must fail (mandatory-model rule) ---------
if NANO_INSTALL_HARNESSES_OVERRIDE="qwen" \
     sh "$SCRIPT" --harness qwen --yes --dry-run >/dev/null 2>&1; then
  fail "s2: qwen without a model should exit non-zero"
else
  pass "s2: qwen without a model exits non-zero"
fi

# --- Scenario 3: missing ACP adapter, non-interactive decline -> skip + rc1 --
set +e
OUT=$(NANO_INSTALL_HARNESSES_OVERRIDE="claude copilot" NANO_INSTALL_ADAPTERS_PRESENT="" \
  sh "$SCRIPT" --harness claude:opus:1 --harness copilot:gpt-5.4:2 --yes --dry-run 2>&1)
RC=$?
set -e
assert_contains "s3: claude skipped (missing adapter)" \
  "skipping claude — ACP adapter 'claude-code-acp' not installed" "$OUT"
assert_not_contains "s3: claude NOT hired" "nano hire --name claude" "$OUT"
assert_contains "s3: copilot still hired" "nano hire --name copilot" "$OUT"
if [ "$RC" -ne 0 ]; then pass "s3: partial success exits non-zero"; else fail "s3: expected non-zero exit after a skip"; fi

# --- Scenario 4: no TTY + no --harness must not hang; exits non-zero --------
set +e
sh "$SCRIPT" --dry-run </dev/null >/dev/null 2>&1
RC=$?
set -e
if [ "$RC" -ne 0 ]; then pass "s4: no TTY and no --harness exits non-zero"; else fail "s4: expected non-zero exit with no TTY and no flags"; fi

# --- Scenario 5: default instances (5 then 1) and default model ------------
OUT=$(NANO_INSTALL_HARNESSES_OVERRIDE="copilot claude" NANO_INSTALL_ADAPTERS_PRESENT="claude-code-acp" \
  sh "$SCRIPT" --harness copilot --harness claude --yes --dry-run 2>&1)
assert_contains "s5: first selection defaults to 5 instances" \
  "nano workforce add copilot --instances 5 --auto" "$OUT"
assert_contains "s5: later selection defaults to 1 instance" \
  "nano workforce add claude --instances 1 --auto" "$OUT"
assert_contains "s5: default model => bare adapter command, empty --model" \
  "--command 'claude-code-acp' --model ''" "$OUT"

if [ "$FAILED" -ne 0 ]; then
  printf '\nSMOKE TEST FAILED\n' >&2
  exit 1
fi
printf '\nAll install.sh smoke assertions passed.\n'
