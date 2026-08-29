#!/bin/sh
# Hermetic smoke test for install.sh — asserts the command sequence it EMITS
# under --dry-run for a few selections, plus the guard-rail exit codes. No nano
# CLI or coding harness/adapter needs to be installed: --dry-run means the
# mutating commands are printed (never run), harness detection is stubbed via
# NANO_INSTALL_HARNESSES_OVERRIDE, and adapter presence via
# NANO_INSTALL_ADAPTERS_PRESENT. Only `node` and `npm` are required (the
# preflight probe still runs), so run it where both are available.
#
# The phase-2 (app install, nano-workforce#583) scenarios also drive the real
# curl-backed console flow against an in-process node stub console via the
# NANO_INSTALL_TEST_PHASE2_ONLY hook — those need `node` + `curl`, and are
# skipped (still PASS) if either is missing.
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
# install.sh reads prompts from /dev/tty, and `</dev/null` does not detach the
# controlling terminal — so from an interactive shell this scenario would open
# the real tty and hang. Only exercise it when there is no controlling TTY (CI),
# and skip it (still PASS) when run interactively.
if ( exec </dev/tty ) >/dev/null 2>&1; then
  pass "s4: skipped (controlling TTY present; would hang interactively)"
else
  set +e
  sh "$SCRIPT" --dry-run </dev/null >/dev/null 2>&1
  RC=$?
  set -e
  if [ "$RC" -ne 0 ]; then pass "s4: no TTY and no --harness exits non-zero"; else fail "s4: expected non-zero exit with no TTY and no flags"; fi
fi

# --- Scenario 5: default instances (5 then 1) and default model ------------
OUT=$(NANO_INSTALL_HARNESSES_OVERRIDE="copilot claude" NANO_INSTALL_ADAPTERS_PRESENT="claude-code-acp" \
  sh "$SCRIPT" --harness copilot --harness claude --yes --dry-run 2>&1)
assert_contains "s5: first selection defaults to 5 instances" \
  "nano workforce add copilot --instances 5 --auto" "$OUT"
assert_contains "s5: later selection defaults to 1 instance" \
  "nano workforce add claude --instances 1 --auto" "$OUT"
assert_contains "s5: default model => bare adapter command, empty --model" \
  "--command 'claude-code-acp' --model ''" "$OUT"

# ===========================================================================
# GitHub credential preflight — three-state check (nano-workforce#588)
# ===========================================================================
# The probe is stubbed hermetically via NANO_INSTALL_GH_STATE / NANO_INSTALL_GH_SCOPES
# / NANO_INSTALL_GIT_STATE so no real gh/git auth is needed. All run under
# --dry-run (never blocks) unless a scenario specifically exercises the
# non-interactive fail path.

# --- Scenario G1: token in env is usable, gh absent → app-fine caveat -------
OUT=$(NANO_INSTALL_HARNESSES_OVERRIDE="copilot" NANO_INSTALL_GH_STATE="missing" \
  NANO_INSTALL_TOKEN_STATE="ok" GITHUB_TOKEN="ghp_dummy" \
  sh "$SCRIPT" --harness copilot:gpt-5.4:1 --yes --dry-run 2>&1)
assert_contains "sG1: token detected treated as usable" \
  "GitHub token detected in the environment" "$OUT"
assert_contains "sG1: token+no-gh caveat about harnesses shelling out to gh" \
  "harnesses that shell out to 'gh' still won't work" "$OUT"

# --- Scenario G1b: a set-but-invalid token FAILS validation (not trusted) ---
# A non-empty token is not trusted blindly: an expired/revoked/underscoped
# token is the exact late failure this preflight exists to surface early.
OUT=$(NANO_INSTALL_HARNESSES_OVERRIDE="copilot" NANO_INSTALL_GH_STATE="missing" \
  NANO_INSTALL_TOKEN_STATE="bad" GITHUB_TOKEN="ghp_expired" \
  sh "$SCRIPT" --harness copilot:gpt-5.4:1 --yes --dry-run 2>&1)
assert_contains "sG1b: invalid token reported as failing validation" \
  "failed validation" "$OUT"
assert_contains "sG1b: invalid token names remediation (fix or unset)" \
  "expired, revoked, or lacks access" "$OUT"

# --- Scenario G2: gh missing, no token → not-detected + platform hint -------
OUT=$(NANO_INSTALL_HARNESSES_OVERRIDE="copilot" NANO_INSTALL_GH_STATE="missing" \
  sh "$SCRIPT" --harness copilot:gpt-5.4:1 --yes --dry-run 2>&1)
assert_contains "sG2: no gh + no token reported" \
  "no gh CLI and no GITHUB_TOKEN/GH_TOKEN" "$OUT"
assert_contains "sG2: not-detected headline" \
  "GitHub access not detected" "$OUT"
assert_contains "sG2: Debian/Ubuntu install hint" "sudo apt install gh" "$OUT"
assert_contains "sG2: macOS install hint" "brew install gh" "$OUT"
assert_contains "sG2: gh auth login remediation printed" "gh auth login" "$OUT"
assert_contains "sG2: this-host-only caveat" "covers THIS host only" "$OUT"
# The script must NEVER run gh auth login itself — only print it.
assert_not_contains "sG2: never runs gh auth login (no 'Running' style exec)" \
  "would run: gh auth login" "$OUT"

# --- Scenario G3: gh present but unauthenticated ---------------------------
OUT=$(NANO_INSTALL_HARNESSES_OVERRIDE="copilot" NANO_INSTALL_GH_STATE="unauthed" \
  sh "$SCRIPT" --harness copilot:gpt-5.4:1 --yes --dry-run 2>&1)
assert_contains "sG3: installed-but-unauthenticated state" \
  "gh is installed but not authenticated" "$OUT"

# --- Scenario G4: gh authenticated but unusable (gh api user fails) ---------
OUT=$(NANO_INSTALL_HARNESSES_OVERRIDE="copilot" NANO_INSTALL_GH_STATE="unusable" \
  sh "$SCRIPT" --harness copilot:gpt-5.4:1 --yes --dry-run 2>&1)
assert_contains "sG4: authenticated-but-unusable state (gh api user failed)" \
  "'gh api user' failed" "$OUT"
assert_contains "sG4: names SAML SSO as a likely cause" "SAML SSO" "$OUT"

# --- Scenario G5: authenticated + usable, missing repo scope FAILS ----------
OUT=$(NANO_INSTALL_HARNESSES_OVERRIDE="copilot" NANO_INSTALL_GH_STATE="ok" \
  NANO_INSTALL_GH_SCOPES="gist,read:org" \
  sh "$SCRIPT" --harness copilot:gpt-5.4:1 --yes --dry-run 2>&1)
assert_contains "sG5: missing repo scope fails the check" \
  "missing the 'repo' scope" "$OUT"

# --- Scenario G6: usable with repo but missing workflow scope only WARNS ----
OUT=$(NANO_INSTALL_HARNESSES_OVERRIDE="copilot" NANO_INSTALL_GH_STATE="ok" \
  NANO_INSTALL_GH_SCOPES="repo,read:org" \
  sh "$SCRIPT" --harness copilot:gpt-5.4:1 --yes --dry-run 2>&1)
assert_contains "sG6: missing workflow scope warns (non-fatal)" \
  "missing the 'workflow' scope" "$OUT"
assert_contains "sG6: repo+ passes the check" "GitHub access OK via the host gh CLI" "$OUT"

# --- Scenario G7: git absence is flagged -----------------------------------
OUT=$(NANO_INSTALL_HARNESSES_OVERRIDE="copilot" NANO_INSTALL_GH_STATE="ok" \
  NANO_INSTALL_GH_SCOPES="repo,workflow" NANO_INSTALL_GIT_STATE="missing" \
  sh "$SCRIPT" --harness copilot:gpt-5.4:1 --yes --dry-run 2>&1)
assert_contains "sG7: git presence checked alongside gh" \
  "git not found on this host" "$OUT"

# --- Scenario G8: non-interactive (--yes) FAILS without --allow-no-github ----
if NANO_INSTALL_HARNESSES_OVERRIDE="copilot" NANO_INSTALL_GH_STATE="missing" \
     sh "$SCRIPT" --harness copilot:gpt-5.4:1 --yes >/dev/null 2>&1; then
  fail "sG8: non-interactive run with no GitHub access should exit non-zero"
else
  pass "sG8: non-interactive run with no GitHub access exits non-zero"
fi

# --- Scenario G9: --allow-no-github lets a non-interactive run proceed -------
# Under --dry-run this exercises the --allow-no-github *continue* decision (the
# preflight records GITHUB_DEGRADED and breaks instead of dying). The final
# summary's degraded-failure line is intentionally NOT emitted here: dry-run
# makes no changes, so report_and_exit() only records the degraded failure when
# DRY_RUN=0 — that real-run summary path is a deliberate no-op under --dry-run.
OUT=$(NANO_INSTALL_HARNESSES_OVERRIDE="copilot" NANO_INSTALL_GH_STATE="missing" \
  sh "$SCRIPT" --harness copilot:gpt-5.4:1 --yes --dry-run --allow-no-github 2>&1)
assert_contains "sG9: --allow-no-github continues" \
  "continuing without GitHub access" "$OUT"

# --- Scenario G9b: git-missing AND github-missing both surface (no masking) --
# The GitHub-degraded reason must ACCUMULATE onto the earlier git-missing one,
# not overwrite it — so a host lacking both never loses the git problem behind
# the GitHub message. Both warnings must appear in the same run.
OUT=$(NANO_INSTALL_HARNESSES_OVERRIDE="copilot" NANO_INSTALL_GH_STATE="missing" \
  NANO_INSTALL_GIT_STATE="missing" \
  sh "$SCRIPT" --harness copilot:gpt-5.4:1 --yes --dry-run --allow-no-github 2>&1)
assert_contains "sG9b: git-missing warning still shown alongside github" \
  "git not found on this host" "$OUT"
assert_contains "sG9b: github-missing continue also shown" \
  "continuing without GitHub access" "$OUT"

# ===========================================================================
# Phase 2 — install & run the Nano Workforce app (nano-workforce#583)
# ===========================================================================

# --- Scenario 6: phase-2 dry-run emits the full console call sequence -------
OUT=$(NANO_INSTALL_HARNESSES_OVERRIDE="copilot" \
  sh "$SCRIPT" --harness copilot:gpt-5.4:1 --yes --dry-run 2>&1)
assert_contains "s6: urban toolkit install" \
  "POST http://localhost:8080/console/api/urban/install" "$OUT"
assert_contains "s6: extension install with pkg" \
  'POST http://localhost:8080/console/api/extensions/install  {"pkg":"@nanobpm/nano-workforce"}' "$OUT"
assert_contains "s6: GET projects to confirm the template" \
  "GET http://localhost:8080/console/api/projects" "$OUT"
assert_contains "s6: create project from template nano-workforce" \
  '{"name":"Workforce","template":"nano-workforce"}' "$OUT"
assert_contains "s6: 409-exists convergence branch documented" \
  "on 409 (project exists) we skip scaffolding" "$OUT"
assert_contains "s6: NANO_WORKFORCE_BASE_URL is console origin + app-view prefix" \
  '"NANO_WORKFORCE_BASE_URL":"http://localhost:8080/console/app-view/Workforce"' "$OUT"
assert_contains "s6: NANOBPMN_BASE_URL written" \
  '"NANOBPMN_BASE_URL":"http://localhost:8080"' "$OUT"
assert_contains "s6: PR_REVIEW_PORT written" '"PR_REVIEW_PORT":"3000"' "$OUT"
assert_contains "s6: run the project" \
  "POST http://localhost:8080/console/api/projects/Workforce/run" "$OUT"
assert_contains "s6: readiness poll of the app's own /app/api/version" \
  "poll GET http://localhost:8080/console/app-view/Workforce/app/api/version" "$OUT"
assert_contains "s6: surface app-view URL" \
  "http://localhost:8080/console/app-view/Workforce/" "$OUT"
assert_contains "s6: surface Tasks inbox" \
  "http://localhost:8080/console/app-view/Workforce/tasks" "$OUT"
assert_contains "s6: surface Delivery Graphs" \
  "http://localhost:8080/console/app-view/Workforce/delivery-graphs" "$OUT"
assert_contains "s6: surface agent guide" \
  "http://localhost:8080/console/app-view/Workforce/app/api/agent" "$OUT"
assert_contains "s6: surface MCP endpoint" \
  "http://localhost:8080/console/app-view/Workforce/app/mcp" "$OUT"
# Dry-run must not assert readiness: it changed nothing, so it must not claim the
# app "is up" / "is running" — it states the surfaces are what *would* be available.
assert_not_contains "s6: dry-run does not falsely claim the app is up" \
  "Nano Workforce is up" "$OUT"
assert_not_contains "s6: dry-run does not falsely claim the app is running" \
  "the Nano Workforce app is running" "$OUT"
assert_contains "s6: dry-run frames surfaces as would-be-available" \
  "would be available" "$OUT"
assert_contains "s6: dry-run final report states no changes were made" \
  "Dry-run complete — no changes were made" "$OUT"

# --- Scenario 6b: --project-name flows through every URL and body ----------
OUT=$(NANO_INSTALL_HARNESSES_OVERRIDE="copilot" \
  sh "$SCRIPT" --harness copilot:gpt-5.4:1 --yes --dry-run --project-name Fleet 2>&1)
assert_contains "s6b: project name in the create body" \
  '{"name":"Fleet","template":"nano-workforce"}' "$OUT"
assert_contains "s6b: project name in the app-view base" \
  '"NANO_WORKFORCE_BASE_URL":"http://localhost:8080/console/app-view/Fleet"' "$OUT"
assert_contains "s6b: project name in the run URL" \
  "POST http://localhost:8080/console/api/projects/Fleet/run" "$OUT"

# --- Scenario 6c: GITHUB_TOKEN is redacted in dry-run, never printed --------
OUT=$(NANO_INSTALL_HARNESSES_OVERRIDE="copilot" GITHUB_TOKEN="ghp_SHOULD_NOT_APPEAR" \
  NANO_INSTALL_TOKEN_STATE="ok" \
  sh "$SCRIPT" --harness copilot:gpt-5.4:1 --yes --dry-run 2>&1)
assert_contains "s6c: token key present, masked" '"GITHUB_TOKEN":"***"' "$OUT"
assert_not_contains "s6c: token value never printed" "ghp_SHOULD_NOT_APPEAR" "$OUT"

# --- Scenario 7: --skip-app runs phase 1 only, emits no console calls -------
OUT=$(NANO_INSTALL_HARNESSES_OVERRIDE="copilot" \
  sh "$SCRIPT" --harness copilot:gpt-5.4:1 --yes --dry-run --skip-app 2>&1)
assert_not_contains "s7: no console API calls under --skip-app" "/console/api/" "$OUT"
assert_contains "s7: skip note shown" "Phase 2 skipped (--skip-app)" "$OUT"
assert_contains "s7: dry-run + skip-app report states no changes were made" \
  "Dry-run complete — no changes were made" "$OUT"

# --- Scenarios 8-15: live phase-2 flow against a stubbed node console -------
if command -v node >/dev/null 2>&1 && command -v curl >/dev/null 2>&1; then
  STUBDIR=$(mktemp -d "${TMPDIR:-/tmp}/nwf-smoke.XXXXXX")
  STUB="$STUBDIR/stub-console.cjs"
  # The repo's package.json sets "type":"module", so the CommonJS stub must be
  # a .cjs file. It answers just enough of the console API to exercise the flow.
  cat > "$STUB" <<'CJS'
const http = require('http');
const mode = process.env.STUB_MODE || 'happy'; // happy | exists | timeout
let ran = false;
const srv = http.createServer((req, res) => {
  const url = req.url, m = req.method;
  const json = (c, o) => { res.writeHead(c, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
  req.on('data', () => {}); req.on('end', () => {
    if (m === 'GET' && url === '/console/api/projects') {
      const projects = mode === 'exists' ? [{ name: 'Workforce', template: 'nano-workforce' }] : [];
      return json(200, { templates: [{ id: 'nano-workforce', pack: 'nano-workforce' }], projects });
    }
    if (m === 'POST' && url === '/console/api/urban/install') return json(200, { urbanAvailable: false });
    if (m === 'POST' && url === '/console/api/extensions/install') return json(201, { id: 'nano-workforce' });
    if (m === 'POST' && url === '/console/api/projects') return mode === 'exists' ? json(409, { error: 'exists' }) : json(201, { name: 'Workforce' });
    if (m === 'PUT' && url === '/console/api/projects/Workforce/config') return json(200, { ok: true });
    if (m === 'POST' && url === '/console/api/projects/Workforce/run') { ran = true; return json(200, { state: 'running' }); }
    if (m === 'GET' && url === '/console/app-view/Workforce/app/api/version') {
      if (mode === 'timeout') return json(404, {});
      return ran ? json(200, { version: '9.9.9' }) : json(404, {});
    }
    return json(404, { error: 'nomatch', url });
  });
});
srv.listen(0, '127.0.0.1', () => console.log('PORT ' + srv.address().port));
setTimeout(() => process.exit(0), 30000); // self-terminate: never leak the stub
CJS

  # run_phase2 <mode> [extra install.sh args...] -> sets PHASE2_RC, PHASE2_OUT
  run_phase2() {
    _mode=$1; shift
    STUB_MODE="$_mode" node "$STUB" > "$STUBDIR/$_mode.log" 2>&1 &
    _pid=$!
    _port=''; _i=0
    while [ "$_i" -lt 50 ]; do
      _port=$(sed -n 's/^PORT //p' "$STUBDIR/$_mode.log" 2>/dev/null)
      [ -n "$_port" ] && break
      _i=$((_i + 1)); sleep 1
    done
    if [ -z "$_port" ]; then
      kill "$_pid" 2>/dev/null || true
      wait "$_pid" 2>/dev/null || true
      PHASE2_OUT="stub console never reported a port for mode '$_mode'"; PHASE2_RC=127
      return 0
    fi
    set +e
    PHASE2_OUT=$(NANO_INSTALL_TEST_PHASE2_ONLY=1 \
      NANO_INSTALL_CONSOLE_ORIGIN="http://127.0.0.1:$_port" \
      NANO_INSTALL_APP_POLL_ATTEMPTS=3 NANO_INSTALL_APP_POLL_INTERVAL=0 \
      sh "$SCRIPT" --yes "$@" 2>&1)
    PHASE2_RC=$?
    set -e
    kill "$_pid" 2>/dev/null || true
    wait "$_pid" 2>/dev/null || true
  }

  if [ -z "$STUBDIR" ] || [ ! -f "$STUB" ]; then
    fail "s8-s15: could not create the stub console"
  else
    # Scenario 8 — happy path: success asserted via /app/api/version, exit 0.
    run_phase2 happy
    if [ "$PHASE2_RC" -eq 0 ]; then pass "s8: happy path exits zero"; else
      fail "s8: happy path should exit zero"; printf '%s\n' "$PHASE2_OUT" | sed 's/^/    | /' >&2; fi
    assert_contains "s8: readiness asserted via /app/api/version" "app is up" "$PHASE2_OUT"
    assert_contains "s8: project created (not 409)" "project 'Workforce' created" "$PHASE2_OUT"

    # Scenario 9 — existing project (409): configure + run, never re-scaffold.
    run_phase2 exists
    if [ "$PHASE2_RC" -eq 0 ]; then pass "s9: 409-exists converges (exit zero)"; else
      fail "s9: 409-exists path should exit zero"; printf '%s\n' "$PHASE2_OUT" | sed 's/^/    | /' >&2; fi
    assert_contains "s9: existing project configured+run, not re-scaffolded" \
      "already exists — configuring and running it (not re-scaffolding)" "$PHASE2_OUT"

    # Scenario 10 — readiness poll timeout: clear message, exit non-zero.
    run_phase2 timeout
    if [ "$PHASE2_RC" -ne 0 ]; then pass "s10: readiness timeout exits non-zero"; else
      fail "s10: readiness timeout should exit non-zero"; fi
    assert_contains "s10: timeout is a clear readiness message" \
      "did not answer 200 on /app/api/version" "$PHASE2_OUT"
    assert_contains "s10: timeout names the self-heal-on-Run dependency" \
      "self-heal-on-Run" "$PHASE2_OUT"

    # Scenario 11 — console off/unreachable: early failure that mutates nothing.
    set +e
    OFF=$(NANO_INSTALL_TEST_PHASE2_ONLY=1 NANO_INSTALL_CONSOLE_ORIGIN="http://127.0.0.1:1" \
      sh "$SCRIPT" --yes 2>&1)
    OFFRC=$?
    set -e
    if [ "$OFFRC" -ne 0 ]; then pass "s11: console-off exits non-zero"; else
      fail "s11: console-off should exit non-zero"; fi
    assert_contains "s11: console-off is a clear message" "console unreachable" "$OFF"
    assert_not_contains "s11: console-off mutates nothing (no extension install)" \
      "extensions/install" "$OFF"

    # Scenario 12 — schemeless console origin: fail early with a clear message,
    # never emit the "localhost:8080://localhost:8080"-style invalid origin.
    set +e
    SCHEMELESS=$(NANO_INSTALL_TEST_PHASE2_ONLY=1 NANO_INSTALL_CONSOLE_ORIGIN="localhost:8080" \
      sh "$SCRIPT" --yes 2>&1)
    SCHEMELESSRC=$?
    set -e
    if [ "$SCHEMELESSRC" -ne 0 ]; then pass "s12: schemeless origin exits non-zero"; else
      fail "s12: schemeless origin should exit non-zero"; fi
    assert_contains "s12: schemeless origin is a clear message" \
      "expected a URL with a scheme" "$SCHEMELESS"
    assert_not_contains "s12: schemeless origin never doubles the authority" \
      "localhost:8080://localhost:8080" "$SCHEMELESS"

    # Scenario 13 — mktemp unavailable: api() must fall back to a safe noclobber
    # temp file and the happy path must still converge. A PATH-shim `mktemp` that
    # always fails forces mktemp_safe() down its fallback branch for the script.
    SHIMDIR="$STUBDIR/shim"
    mkdir -p "$SHIMDIR"
    printf '#!/bin/sh\nexit 1\n' > "$SHIMDIR/mktemp"
    chmod +x "$SHIMDIR/mktemp"
    _oldpath="$PATH"
    PATH="$SHIMDIR:$PATH"; export PATH
    run_phase2 happy
    PATH="$_oldpath"; export PATH
    if [ "$PHASE2_RC" -eq 0 ]; then pass "s13: mktemp-unavailable fallback converges (exit zero)"; else
      fail "s13: mktemp-unavailable fallback should exit zero"; printf '%s\n' "$PHASE2_OUT" | sed 's/^/    | /' >&2; fi
    assert_contains "s13: fallback still asserts readiness via /app/api/version" "app is up" "$PHASE2_OUT"

    # Scenario 14 — a GITHUB_TOKEN carrying a control character (e.g. a stray
    # newline) must be rejected with a clear error before any JSON config body
    # is emitted, never producing invalid JSON that fails the console API
    # opaquely. The token flows through json_str() unredacted on the live PUT.
    _ctrl_token="$(printf 'ghp_bad\ntoken')"
    export GITHUB_TOKEN="$_ctrl_token"
    run_phase2 happy
    unset GITHUB_TOKEN
    if [ "$PHASE2_RC" -ne 0 ]; then pass "s14: control-char token rejected (exit non-zero)"; else
      fail "s14: control-char token should exit non-zero"; printf '%s\n' "$PHASE2_OUT" | sed 's/^/    | /' >&2; fi
    assert_contains "s14: control-char token has a clear message" \
      "control characters" "$PHASE2_OUT"

    # Scenario 15 — the control-char gate covers EVERY interpolated config value,
    # not just the token: a non-token field (here PR_REVIEW_PORT) carrying a
    # control character must be rejected the same way, naming the offending key.
    _ctrl_port="$(printf '3000\nbad')"
    export PR_REVIEW_PORT="$_ctrl_port"
    run_phase2 happy
    unset PR_REVIEW_PORT
    if [ "$PHASE2_RC" -ne 0 ]; then pass "s15: control-char non-token field rejected (exit non-zero)"; else
      fail "s15: control-char non-token field should exit non-zero"; printf '%s\n' "$PHASE2_OUT" | sed 's/^/    | /' >&2; fi
    assert_contains "s15: rejection names the offending field" \
      "PR_REVIEW_PORT contains control characters" "$PHASE2_OUT"

    rm -rf "$STUBDIR"
  fi
else
  pass "s8-s15: skipped (node or curl unavailable for the stubbed-console tests)"
fi

if [ "$FAILED" -ne 0 ]; then
  printf '\nSMOKE TEST FAILED\n' >&2
  exit 1
fi
printf '\nAll install.sh smoke assertions passed.\n'
