#!/bin/sh
# Nano Workforce — one-command onboarding installer.
#
#   curl -fsSL https://raw.githubusercontent.com/nanobpm/nano-workforce/main/install.sh | sh
#
# Takes a machine from "has some coding-agent CLIs installed" to "a running Nano
# engine with a supervised workforce of hired agents". It installs @camunda8/cli
# and the c8ctl-plugin-nano plugin, lets you pick which of your installed coding
# harnesses to hire (and with which model / how many instances), composes a
# declarative workforce manifest from those choices, and brings the engine and
# the workforce up.
#
# Scope: this script stops at "engine up, workforce up, agents polling". It does
# NOT install/deploy/run the Nano Workforce app itself (that is a follow-up).
#
# Constraints (see nanobpm/nano-workforce#576):
#   - POSIX sh only (piped to `sh`, which is dash on many distros). No bashisms:
#     no arrays, no `[[`, no `local`, no `read -a`, no `set -o pipefail`.
#   - stdin is the curl pipe, NOT the keyboard: every prompt reads from /dev/tty.
#   - never sudo on the user's behalf.
#   - shellcheck -s sh clean (enforced in CI).

set -eu

# ---------------------------------------------------------------------------
# Curated data tables — refresh these against each harness's current docs.
# Kept together near the top so they are cheap to update.
#
# ACP invocation per harness (the base command line the worker spawns). Every
# hire uses --protocol acp; two harnesses ride an adapter binary:
#
#   copilot  copilot --acp                (native; plugin appends --acp)
#   kimi     kimi acp                     (native subcommand)
#   qwen     qwen --experimental-acp      (native, hidden flag)
#   claude   claude-code-acp              (adapter: @zed-industries/claude-code-acp)
#   pi       pi-acp                       (adapter: pi-acp)
#
# The chosen model is baked into the --command as `--model <id>` so it actually
# reaches the harness (c8 nano hire --model only sets AGENT_MODEL in the env,
# which nothing forwards to the CLI automatically). --model is still passed to
# `hire` for bookkeeping (it shows in `hire --list` / `supervisor status`).
# ---------------------------------------------------------------------------

ALL_HARNESSES='kimi qwen copilot claude pi'

# Curated, known-good model ids for the non-queryable harnesses (copilot, claude,
# qwen). pi/kimi are queried live and fall back to these. Verify at refresh time.
MODELS_copilot='gpt-5.4 claude-sonnet-4.6 claude-opus-4.8'
MODELS_claude='sonnet opus haiku'
MODELS_qwen='qwen3-coder-plus qwen3-coder-flash qwen-max'
MODELS_pi='pi-fast pi-balanced pi-max'
MODELS_kimi='kimi-k2 kimi-k2-turbo'

MIN_NODE='22.18.0'          # @camunda8/cli engines floor
PLUGIN='c8ctl-plugin-nano'

# ---------------------------------------------------------------------------
# Output helpers
# ---------------------------------------------------------------------------
if [ -t 2 ]; then
  C_RESET=$(printf '\033[0m'); C_BOLD=$(printf '\033[1m')
  C_RED=$(printf '\033[31m'); C_YEL=$(printf '\033[33m'); C_GRN=$(printf '\033[32m')
else
  C_RESET=''; C_BOLD=''; C_RED=''; C_YEL=''; C_GRN=''
fi

info() { printf '%s\n' "${C_BOLD}==>${C_RESET} $*" >&2; }
note() { printf '%s\n' "    $*" >&2; }
warn() { printf '%s\n' "${C_YEL}warning:${C_RESET} $*" >&2; }
err()  { printf '%s\n' "${C_RED}error:${C_RESET} $*" >&2; }
ok()   { printf '%s\n' "${C_GRN}ok:${C_RESET} $*" >&2; }

die() { err "$*"; exit 1; }

# ---------------------------------------------------------------------------
# Global state
# ---------------------------------------------------------------------------
DRY_RUN=0
ASSUME_YES=0
SHELL_OVERRIDE=''
INSTALL_ADAPTERS=0        # auto-install missing adapters without prompting
CLI_HARNESS_SPECS=''      # newline-separated name[:model][:instances] from --harness
SELECTIONS=''             # newline-separated "name<US>model<US>instances" (US = non-whitespace 0x1f, so an empty model field does not collapse under read)
FAILURES=''               # newline-separated failure notes (partial-success report)
SEP=$(printf '\037')      # US (unit separator): non-whitespace, so `read` never collapses adjacent/empty fields

# Test hooks (undocumented; used by the CI dry-run smoke test to stay hermetic).
#   NANO_INSTALL_HARNESSES_OVERRIDE  — space list of "detected" harnesses.
#   NANO_INSTALL_ADAPTERS_PRESENT    — space list of adapter bins to treat present.
HARNESS_OVERRIDE="${NANO_INSTALL_HARNESSES_OVERRIDE:-}"
ADAPTERS_PRESENT="${NANO_INSTALL_ADAPTERS_PRESENT:-}"

CLI=''      # resolved c8ctl / c8 binary
TTY=''      # /dev/tty if usable, else empty

# ---------------------------------------------------------------------------
# Command runner — honours --dry-run for mutating commands.
# ---------------------------------------------------------------------------
run() {
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '%s\n' "+ $*" >&2
    return 0
  fi
  "$@"
}

# Like run() but for a command whose printed form differs from argv (a string we
# assembled). $1 is the human/dry-run string; the rest is the argv to execute.
run_as() {
  _show=$1; shift
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '%s\n' "+ $_show" >&2
    return 0
  fi
  "$@"
}

record_failure() { FAILURES="${FAILURES}$1
"; }

# ---------------------------------------------------------------------------
# TTY-backed prompting (stdin is the curl pipe, so read from /dev/tty)
# ---------------------------------------------------------------------------
init_tty() {
  if [ -e /dev/tty ] && (: >/dev/tty) 2>/dev/null && (: </dev/tty) 2>/dev/null; then
    TTY=/dev/tty
  else
    TTY=''
  fi
}

# ask "<prompt>" -> sets ANS (empty string on EOF)
ask() {
  ANS=''
  [ -n "$TTY" ] || return 0
  printf '%s' "$1" >"$TTY"
  IFS= read -r ANS <"$TTY" || ANS=''
}

# confirm "<prompt>" -> returns 0 for yes
confirm() {
  ask "$1 [y/N] "
  case "$ANS" in
    y|Y|yes|YES|Yes) return 0 ;;
    *) return 1 ;;
  esac
}

# ---------------------------------------------------------------------------
# Version comparison — is $1 >= $2 (dotted numeric, e.g. 22.18.0)?
# ---------------------------------------------------------------------------
ver_field() { # ver index(1..3) -> numeric field, missing = 0
  _v=$1; _i=$2
  _v=${_v%%[!0-9.]*}
  case "$_i" in
    1) printf '%s' "${_v%%.*}" ;;
    2) _r=${_v#*.}; [ "$_r" = "$_v" ] && { printf '0'; return; }; printf '%s' "${_r%%.*}" ;;
    3) _r=${_v#*.}; [ "$_r" = "$_v" ] && { printf '0'; return; }
       _r=${_r#*.}; case "$_r" in *.*) printf '%s' "${_r%%.*}" ;; "$_v") printf '0' ;; *) printf '%s' "$_r" ;; esac ;;
  esac
}

ver_ge() { # $1 >= $2 ?
  _i=1
  while [ "$_i" -le 3 ]; do
    _a=$(ver_field "$1" "$_i"); _b=$(ver_field "$2" "$_i")
    [ -z "$_a" ] && _a=0; [ -z "$_b" ] && _b=0
    if [ "$_a" -gt "$_b" ]; then return 0; fi
    if [ "$_a" -lt "$_b" ]; then return 1; fi
    _i=$((_i + 1))
  done
  return 0
}

# ---------------------------------------------------------------------------
# Usage
# ---------------------------------------------------------------------------
usage() {
  cat >&2 <<'EOF'
Nano Workforce installer — hire your coding harnesses and bring up a workforce.

Usage:
  curl -fsSL https://raw.githubusercontent.com/nanobpm/nano-workforce/main/install.sh | sh
  sh install.sh [options]

Options:
  --harness <name>[:<model>][:<instances>]
                     Non-interactive selection; repeatable. <name> is one of
                     kimi|qwen|copilot|claude|pi. Omit :model for the harness
                     default (NOT allowed for qwen). Omit :instances for 5 on the
                     first selection, 1 thereafter.
  --yes              Skip the confirmation summary.
  --install-adapters Auto-install a selected harness's missing ACP adapter
                     (claude/pi) instead of prompting/skipping.
  --shell <bash|zsh|fish>
                     Override shell-completion detection.
  --dry-run          Print every command that would run; change nothing.
  -h, --help         Show this help.

Non-interactive example:
  curl -fsSL .../install.sh | sh -s -- --harness copilot:gpt-5.4:5 --harness claude:opus:1 --yes

With no controlling terminal (/dev/tty) and no --harness, the script exits
non-zero rather than hanging on a prompt.
EOF
}

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------
parse_args() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --harness)
        [ $# -ge 2 ] || die "--harness requires a value (name[:model][:instances])"
        CLI_HARNESS_SPECS="${CLI_HARNESS_SPECS}$2
"
        shift 2 ;;
      --harness=*)
        CLI_HARNESS_SPECS="${CLI_HARNESS_SPECS}${1#--harness=}
"
        shift ;;
      --yes|-y) ASSUME_YES=1; shift ;;
      --install-adapters) INSTALL_ADAPTERS=1; shift ;;
      --dry-run) DRY_RUN=1; shift ;;
      --shell)
        [ $# -ge 2 ] || die "--shell requires a value (bash|zsh|fish)"
        SHELL_OVERRIDE=$2; shift 2 ;;
      --shell=*) SHELL_OVERRIDE=${1#--shell=}; shift ;;
      -h|--help) usage; exit 0 ;;
      *) err "unknown option: $1"; usage; exit 2 ;;
    esac
  done
}

# ---------------------------------------------------------------------------
# Step 1 — Preflight
# ---------------------------------------------------------------------------
preflight() {
  info "Preflight"
  command -v node >/dev/null 2>&1 || die "node not found. Install Node >= ${MIN_NODE} (https://nodejs.org or use nvm), then re-run."
  command -v npm  >/dev/null 2>&1 || die "npm not found. Install Node/npm >= ${MIN_NODE} (https://nodejs.org), then re-run."
  _nv=$(node -v 2>/dev/null | sed 's/^v//')
  if ! ver_ge "$_nv" "$MIN_NODE"; then
    die "node $_nv is too old — @camunda8/cli needs >= ${MIN_NODE}. Upgrade via https://nodejs.org or nvm, then re-run."
  fi
  ok "node $_nv (>= ${MIN_NODE}), npm present"

  # Non-fatal: agents need GitHub access to do useful work.
  if [ -z "${GITHUB_TOKEN:-}" ] && [ -z "${GH_TOKEN:-}" ]; then
    if command -v gh >/dev/null 2>&1; then
      if ! gh auth status >/dev/null 2>&1; then
        warn "gh is installed but not authenticated, and no GITHUB_TOKEN/GH_TOKEN is set."
        note "Agents need GitHub access — run 'gh auth login' or export GITHUB_TOKEN before they start pulling work."
      fi
    else
      warn "no gh CLI and no GITHUB_TOKEN/GH_TOKEN in the environment."
      note "Agents need GitHub access — install gh (https://cli.github.com) and 'gh auth login', or export GITHUB_TOKEN."
    fi
  fi
}

# ---------------------------------------------------------------------------
# Step 2 — Install the CLI + plugin, version-gate on `nano workforce`
# ---------------------------------------------------------------------------
resolve_cli() {
  if command -v c8ctl >/dev/null 2>&1; then CLI=c8ctl
  elif command -v c8 >/dev/null 2>&1; then CLI=c8
  else CLI=c8ctl; fi
}

install_cli() {
  info "Installing @camunda8/cli"
  if ! run npm i -g @camunda8/cli; then
    err "'npm i -g @camunda8/cli' failed."
    note "If this was an EACCES permissions error, do NOT sudo blindly. Options:"
    note "  - set a user npm prefix:  npm config set prefix ~/.npm-global  (then add its bin to PATH)"
    note "  - use nvm so global installs land in your user dir"
    note "  - run 'sudo npm i -g @camunda8/cli' yourself if you understand the implications"
    exit 1
  fi
  resolve_cli
  if [ "$DRY_RUN" -eq 0 ]; then
    command -v "$CLI" >/dev/null 2>&1 || die "@camunda8/cli installed but '$CLI' is not on PATH — add npm's global bin dir to PATH and re-run."
  fi
  ok "@camunda8/cli installed ($CLI)"

  # Shell completion — non-fatal.
  info "Installing shell completion"
  if [ -n "$SHELL_OVERRIDE" ]; then
    if run "$CLI" completion install --shell "$SHELL_OVERRIDE"; then ok "completion installed (--shell $SHELL_OVERRIDE)"; else warn "completion install failed (non-fatal) — continuing."; fi
  else
    if run "$CLI" completion install; then ok "completion installed"; else warn "completion install failed (non-fatal) — continuing."; fi
  fi

  # Load the nano plugin — idempotent (load, else upgrade, else already present).
  info "Loading the $PLUGIN plugin"
  if run "$CLI" load plugin "$PLUGIN"; then
    ok "plugin loaded"
  elif run "$CLI" upgrade plugin "$PLUGIN"; then
    ok "plugin upgraded"
  elif [ "$DRY_RUN" -eq 1 ] || "$CLI" nano >/dev/null 2>&1; then
    note "plugin already loaded — continuing."
  else
    die "could not load the $PLUGIN plugin. Try: $CLI load plugin $PLUGIN"
  fi

  version_gate
}

# Version-gate: `c8 nano workforce` must exist. The command supports `list --json`
# (documented "for the install script / CI"); on a plugin new enough to have the
# workforce subcommand that emits a JSON object, older plugins print top-level
# usage text instead. Detect the JSON.
version_gate() {
  info "Checking plugin version (needs 'nano workforce')"
  if [ "$DRY_RUN" -eq 1 ]; then
    note "dry-run: skipping live version-gate probe."
    return 0
  fi
  _out=$("$CLI" nano workforce list --json 2>/dev/null || true)
  case "$_out" in
    '{'*|' {'*|"$(printf '\n')"'{'*)
      ok "'nano workforce' available" ;;
    *)
      # Second chance: some builds print with leading whitespace/newlines.
      if printf '%s' "$_out" | grep -Eq '"workers"|"version"|"name"'; then
        ok "'nano workforce' available"
      else
        die "the installed $PLUGIN is too old: it has no 'nano workforce' command (needs jwulf/c8ctl-plugin-nano#117). Upgrade with: $CLI upgrade plugin $PLUGIN"
      fi ;;
  esac
}

# ---------------------------------------------------------------------------
# Step 3 — Detect installed harnesses
# ---------------------------------------------------------------------------
harness_detected() { # $1 harness -> 0 if present
  if [ -n "$HARNESS_OVERRIDE" ]; then
    case " $HARNESS_OVERRIDE " in *" $1 "*) return 0 ;; *) return 1 ;; esac
  fi
  command -v "$1" >/dev/null 2>&1
}

DETECTED=''
detect_harnesses() {
  info "Detecting installed coding harnesses"
  DETECTED=''
  for _h in $ALL_HARNESSES; do
    if harness_detected "$_h"; then
      DETECTED="${DETECTED}${_h} "
      note "found: $_h"
    else
      note "not installed (skipping): $_h"
    fi
  done
  DETECTED=$(printf '%s' "$DETECTED" | sed 's/ *$//')
  [ -n "$DETECTED" ] || die "none of ${ALL_HARNESSES} are installed — install a coding-agent CLI first, then re-run."
}

# ---------------------------------------------------------------------------
# ACP command / adapter tables
# ---------------------------------------------------------------------------
acp_base() { # $1 harness -> base ACP invocation
  case "$1" in
    copilot) printf 'copilot --acp' ;;
    kimi)    printf 'kimi acp' ;;
    qwen)    printf 'qwen --experimental-acp' ;;
    claude)  printf 'claude-code-acp' ;;
    pi)      printf 'pi-acp' ;;
    *)       printf '%s' "$1" ;;
  esac
}

adapter_bin() { # $1 harness -> adapter binary name (empty if native)
  case "$1" in
    claude) printf 'claude-code-acp' ;;
    pi)     printf 'pi-acp' ;;
    *)      printf '' ;;
  esac
}

adapter_pkg() { # $1 harness -> npm package for its adapter (empty if native)
  case "$1" in
    claude) printf '@zed-industries/claude-code-acp' ;;
    pi)     printf 'pi-acp' ;;
    *)      printf '' ;;
  esac
}

adapter_present() { # $1 adapter bin -> 0 if present
  if [ -n "$ADAPTERS_PRESENT" ]; then
    case " $ADAPTERS_PRESENT " in *" $1 "*) return 0 ;; *) return 1 ;; esac
  fi
  command -v "$1" >/dev/null 2>&1
}

# Assemble the full ACP command line for a harness+model (model baked in).
build_command() { # $1 harness $2 model
  _cmd=$(acp_base "$1")
  if [ -n "$2" ]; then _cmd="$_cmd --model $2"; fi
  printf '%s' "$_cmd"
}

curated_models() { # $1 harness -> space list
  case "$1" in
    copilot) printf '%s' "$MODELS_copilot" ;;
    claude)  printf '%s' "$MODELS_claude" ;;
    qwen)    printf '%s' "$MODELS_qwen" ;;
    pi)      printf '%s' "$MODELS_pi" ;;
    kimi)    printf '%s' "$MODELS_kimi" ;;
    *)       printf '' ;;
  esac
}

# Live model query for the queryable harnesses. Prints models (best-effort), one
# per line, or nothing if the query fails / is unavailable.
live_models() { # $1 harness -> newline list on stdout
  case "$1" in
    pi)
      pi --list-models 2>/dev/null | awk 'NR>1 && $2 != "" {print $2}' ;;
    kimi)
      kimi provider list --json 2>/dev/null \
        | grep -o '"[a-zA-Z0-9._-]*"' | tr -d '"' | grep -- '-' ;;
    *) : ;;
  esac
}

# ---------------------------------------------------------------------------
# Step 4/5 — interactive selection + model + instances
# ---------------------------------------------------------------------------
add_selection() { # $1 harness $2 model $3 instances
  if [ -n "$2" ] && ! printf '%s' "$2" | grep -Eq '^[A-Za-z0-9._:/@+-]+$'; then
    die "refusing model id '$2' for $1: only [A-Za-z0-9._:/@+-] are allowed (guards against shell-metacharacter injection into the hire --command)."
  fi
  SELECTIONS="${SELECTIONS}$1${SEP}$2${SEP}$3
"
}

# Prompt for a model for a harness. Sets ANS to the chosen model (may be empty
# for "harness default"; never empty for qwen).
choose_model() { # $1 harness
  _h=$1
  # Build the candidate list: live query for pi/kimi, else curated. Model ids
  # contain no spaces, so a space-separated list + `for` keeps this in the
  # current shell (no subshell to lose _map/_count to).
  _live=$(live_models "$_h" 2>/dev/null | sed '/^$/d' | head -20 | tr '\n' ' ' || true)
  if [ -n "$(printf '%s' "$_live" | tr -d ' ')" ]; then
    _cands=$_live
    note "live models for $_h:"
  else
    _cands=$(curated_models "$_h")
    [ -n "$_cands" ] && note "known-good models for $_h:"
  fi

  _n=0
  _map=''
  for _m in $_cands; do
    [ -n "$_m" ] || continue
    _n=$((_n + 1))
    printf '  %s) %s\n' "$_n" "$_m" >"$TTY"
    _map="${_map}${_n}=${_m} "
  done
  _count=$_n

  if [ "$_h" = qwen ]; then
    note "qwen requires an explicit model (it stalls with none)."
    _extra="  c) enter your own"
  else
    _extra="  c) enter your own
  d) use the harness default (no model)"
  fi
  printf '%s\n' "$_extra" >"$TTY"

  while :; do
    if [ "$_h" = qwen ]; then
      ask "Model for $_h (1-${_count} or c): "
    else
      ask "Model for $_h (1-${_count}, c, or d): "
    fi
    case "$ANS" in
      c|C)
        ask "Enter model id for $_h: "
        _m=$(printf '%s' "$ANS" | awk '{print $1}')
        if [ -n "$_m" ]; then ANS=$_m; return 0; fi
        warn "empty model id" ;;
      d|D)
        if [ "$_h" = qwen ]; then warn "qwen needs an explicit model"; continue; fi
        ANS=''; return 0 ;;
      ''|*[!0-9]*)
        warn "please choose one of the listed options" ;;
      *)
        _sel=$(printf '%s' "$_map" | tr ' ' '\n' | grep "^${ANS}=" | head -1 | cut -d= -f2-)
        if [ -n "$_sel" ]; then ANS=$_sel; return 0; fi
        warn "no such option: $ANS" ;;
    esac
  done
}

# Ensure a harness's ACP adapter is present; may install (with consent) or skip.
# Returns 0 to keep the harness, 1 to skip it.
ensure_adapter() { # $1 harness
  _h=$1
  _bin=$(adapter_bin "$_h")
  [ -n "$_bin" ] || return 0                    # native, nothing to do
  if adapter_present "$_bin"; then return 0; fi
  _pkg=$(adapter_pkg "$_h")
  if [ "$INSTALL_ADAPTERS" -eq 1 ]; then
    info "Installing $_h ACP adapter ($_pkg)"
    if run npm i -g "$_pkg"; then return 0; fi
    warn "adapter install failed for $_h — skipping this harness."
    record_failure "$_h: adapter install ($_pkg) failed"
    return 1
  fi
  if [ -n "$TTY" ] && confirm "$_h needs the ACP adapter '$_bin' ($_pkg). Install it globally now?"; then
    info "Installing $_h ACP adapter ($_pkg)"
    if run npm i -g "$_pkg"; then return 0; fi
    warn "adapter install failed for $_h — skipping this harness."
    record_failure "$_h: adapter install ($_pkg) failed"
    return 1
  fi
  warn "skipping $_h — ACP adapter '$_bin' not installed (install with: npm i -g $_pkg)."
  record_failure "$_h: skipped (missing ACP adapter $_bin)"
  return 1
}

interactive_select() {
  info "Select harnesses to hire"
  _i=0
  _idxmap=''
  for _h in $DETECTED; do
    _i=$((_i + 1))
    printf '  %s) %s\n' "$_i" "$_h" >"$TTY"
    _idxmap="${_idxmap}${_i}=${_h}
"
  done
  _total=$_i

  while :; do
    ask "Which to hire? (e.g. '1 3' or 'all'): "
    _pick=$ANS
    [ -n "$_pick" ] || { warn "select at least one, or Ctrl-C to abort"; continue; }
    _chosen=''
    if [ "$_pick" = all ] || [ "$_pick" = ALL ]; then
      _chosen=$DETECTED
    else
      _bad=0
      for _tok in $_pick; do
        case "$_tok" in
          ''|*[!0-9]*) warn "not a number: $_tok"; _bad=1; break ;;
        esac
        _m=$(printf '%s' "$_idxmap" | grep "^${_tok}=" | head -1 | cut -d= -f2-)
        if [ -z "$_m" ]; then warn "no such option: $_tok"; _bad=1; break; fi
        case " $_chosen " in *" $_m "*) : ;; *) _chosen="$_chosen $_m" ;; esac
      done
      [ "$_bad" -eq 0 ] || continue
    fi
    _chosen=$(printf '%s' "$_chosen" | sed 's/^ *//;s/ *$//')
    [ -n "$_chosen" ] && break
  done

  _first=1
  for _h in $_chosen; do
    ensure_adapter "$_h" || { _first=0; continue; }
    choose_model "$_h"; _model=$ANS
    if [ "$_first" -eq 1 ]; then _def=5; else _def=1; fi
    while :; do
      ask "How many '$_h' workers? [default $_def]: "
      if [ -z "$ANS" ]; then _inst=$_def; break; fi
      case "$ANS" in
        ''|*[!0-9]*) warn "enter a whole number" ;;
        *) if [ "$ANS" -ge 1 ]; then _inst=$ANS; break; else warn "must be >= 1"; fi ;;
      esac
    done
    add_selection "$_h" "$_model" "$_inst"
    _first=0
  done
}

# Non-interactive selection from --harness specs.
noninteractive_select() {
  info "Composing workforce from --harness flags"
  _first=1
  # Specs are name[:model][:instances] with no spaces, so iterate with `for`
  # in the current shell (add_selection must mutate SELECTIONS here).
  for _spec in $CLI_HARNESS_SPECS; do
    [ -n "$_spec" ] || continue
    _name=$(printf '%s' "$_spec" | cut -d: -f1)
    _model=$(printf '%s' "$_spec" | cut -s -d: -f2)
    _inst=$(printf '%s' "$_spec" | cut -s -d: -f3)
    case " $ALL_HARNESSES " in
      *" $_name "*) : ;;
      *) die "unknown harness in --harness: '$_name' (expected one of ${ALL_HARNESSES})" ;;
    esac
    if ! harness_detected "$_name"; then
      warn "--harness $_name: not installed on this host — skipping."
      record_failure "$_name: not installed"
      continue
    fi
    if [ "$_name" = qwen ] && [ -z "$_model" ]; then
      die "--harness qwen requires an explicit model (qwen stalls with none): use qwen:<model>[:<instances>]"
    fi
    ensure_adapter "$_name" || { _first=0; continue; }
    if [ -z "$_inst" ]; then
      if [ "$_first" -eq 1 ]; then _inst=5; else _inst=1; fi
    fi
    case "$_inst" in
      ''|*[!0-9]*) die "--harness $_name: instances must be a whole number, got '$_inst'" ;;
    esac
    [ "$_inst" -ge 1 ] || die "--harness $_name: instances must be >= 1"
    add_selection "$_name" "$_model" "$_inst"
    _first=0
  done
}

# ---------------------------------------------------------------------------
# Step 7 — confirm
# ---------------------------------------------------------------------------
print_summary() {
  info "Workforce to compose"
  printf '%s\n' "$SELECTIONS" | sed '/^$/d' | while IFS="$SEP" read -r _h _model _inst; do
    _shown=${_model:-'(harness default)'}
    note "$_h  ×$_inst   model: $_shown"
  done
}

confirm_or_die() {
  [ -n "$SELECTIONS" ] || die "no harnesses selected — nothing to do."
  print_summary
  warn "These agents run UNATTENDED with --permission yolo: full tool access"
  warn "(shell, file writes, network) as $(id -un 2>/dev/null || printf 'the current user') on this host."
  if [ "$ASSUME_YES" -eq 1 ] || [ "$DRY_RUN" -eq 1 ]; then
    [ "$DRY_RUN" -eq 1 ] && note "dry-run: not asking for confirmation."
    return 0
  fi
  if [ -z "$TTY" ]; then
    die "refusing to proceed without confirmation and no /dev/tty — re-run with --yes."
  fi
  confirm "Proceed and bring up this unattended workforce?" || die "aborted by user."
}

# ---------------------------------------------------------------------------
# Step 6/7 — hire, compose, bring up
# ---------------------------------------------------------------------------
hire_all() {
  info "Hiring agents"
  while IFS="$SEP" read -r _h _model _inst; do
    [ -n "$_h" ] || continue
    _cmd=$(build_command "$_h" "$_model")
    _show="$CLI nano hire --name $_h --rank senior --command '$_cmd' --model '$_model' --capabilities '' --protocol acp --permission yolo"
    if run_as "$_show" "$CLI" nano hire \
        --name "$_h" \
        --rank senior \
        --command "$_cmd" \
        --model "$_model" \
        --capabilities '' \
        --protocol acp \
        --permission yolo; then
      ok "hired $_h"
    else
      warn "hire failed for $_h — continuing with the rest."
      record_failure "$_h: hire failed"
    fi
  done <<EOF
$(printf '%s\n' "$SELECTIONS" | sed '/^$/d')
EOF
}

compose_workforce() {
  info "Composing the workforce manifest"
  while IFS="$SEP" read -r _h _model _inst; do
    [ -n "$_h" ] || continue
    if run "$CLI" nano workforce add "$_h" --instances "$_inst" --auto; then
      ok "workforce add $_h ×$_inst"
    else
      warn "workforce add failed for $_h."
      record_failure "$_h: workforce add failed"
    fi
  done <<EOF
$(printf '%s\n' "$SELECTIONS" | sed '/^$/d')
EOF
}

bring_up() {
  info "Starting the engine"
  if ! run "$CLI" nano start; then
    err "'$CLI nano start' failed."
    record_failure "engine: nano start failed"
    return 1
  fi
  info "Starting the workforce"
  if ! run "$CLI" nano workforce start; then
    err "'$CLI nano workforce start' failed."
    record_failure "workforce: nano workforce start failed"
    return 1
  fi
}

# ---------------------------------------------------------------------------
# Step 8 — output + hints
# ---------------------------------------------------------------------------
print_status_and_hints() {
  info "Workforce status"
  run "$CLI" nano workforce status || true

  info "What now"
  cat >&2 <<EOF
  $CLI nano status                                  engine health
  $CLI nano workforce list | status                 the composed fleet (desired vs actual)
  $CLI nano workforce add <profile> --instances N --auto   grow the fleet, then 'workforce start'
  $CLI nano workforce remove <profile>              shrink it, then 'workforce start'
  $CLI nano supervisor status                       per-worker state
  $CLI nano supervisor logs <worker> --follow       tail one worker's logs
  $CLI nano workforce stop   /   $CLI nano stop      shut the fleet / engine down
  $CLI nano hire --list                             the hired profiles

  Note: the Nano Workforce APP itself is not installed by this script yet — this
  brings up the engine + a workforce of hired agents. See the README's "Run from
  the CLI" section for installing/running the app.
EOF
}

# ---------------------------------------------------------------------------
# Partial-success report
# ---------------------------------------------------------------------------
report_and_exit() {
  if [ -n "$FAILURES" ]; then
    warn "Completed with some steps skipped or failed:"
    printf '%s\n' "$FAILURES" | sed '/^$/d' | while IFS= read -r _f; do note "- $_f"; done
    exit 1
  fi
  ok "Done — engine up, workforce of hired agents up."
  exit 0
}

# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------
main() {
  parse_args "$@"
  init_tty

  # Decide interactive vs non-interactive up front.
  _have_specs=0
  [ -n "$(printf '%s' "$CLI_HARNESS_SPECS" | sed '/^$/d')" ] && _have_specs=1
  if [ "$_have_specs" -eq 0 ] && [ -z "$TTY" ]; then
    err "no controlling terminal (/dev/tty) and no --harness given — cannot prompt."
    usage
    exit 2
  fi

  preflight
  install_cli
  detect_harnesses

  if [ "$_have_specs" -eq 1 ]; then
    noninteractive_select
  else
    interactive_select
  fi

  confirm_or_die
  hire_all
  compose_workforce
  bring_up || true
  print_status_and_hints
  report_and_exit
}

main "$@"
