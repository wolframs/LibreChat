#!/usr/bin/env bash
#
# deploy.sh — rebuild and redeploy the LibreChat fork.
#
# The api image is built from the WORKING TREE, so building on the wrong branch
# silently ships a stack without the local features. This script exists to make
# that impossible: it refuses to build unless the expected branch is checked out,
# then verifies the local features are actually present in the deployed image.
#
# Usage:
#   ./scripts/deploy.sh              full deploy: guards -> build -> recreate -> verify
#   ./scripts/deploy.sh --config     .env / librechat.yaml change only (no rebuild)
#   ./scripts/deploy.sh --check      verify the running stack, change nothing
#   ./scripts/deploy.sh --sidecars   like --check, then rebuild any sidecar whose
#                                    running code has drifted from the working tree
#   ./scripts/deploy.sh --no-cache   full deploy with a from-scratch image build
#   ./scripts/deploy.sh --yes        don't prompt (for unattended runs)
#
# Env overrides:
#   DEPLOY_BRANCH=<name>   expected branch (default: local-features)
#
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"

EXPECT_BRANCH="${DEPLOY_BRANCH:-local-features}"
BASE_URL="http://localhost:13080"

MODE=full
ASSUME_YES=0
BUILD_ARGS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --config)   MODE=config ;;
    --check)    MODE=check ;;
    --sidecars) MODE=sidecars ;;
    --no-cache) BUILD_ARGS+=(--no-cache) ;;
    --yes|-y)   ASSUME_YES=1 ;;
    -h|--help)  sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1 (try --help)" >&2; exit 2 ;;
  esac
  shift
done

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
die()  { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

# docker-compose.yml references ${UID}/${GID}/${ADMIN_PANEL_SESSION_SECRET}, which are
# deliberately unset here (blank => containers keep their image-default user; setting
# them would change bind-mount ownership). Filter only those known-benign warnings.
compose() {
  docker compose "$@" 2> >(grep -vE '(UID|GID|ADMIN_PANEL_SESSION_SECRET)[^ ]* variable is not set' >&2)
}

confirm() {
  [[ $ASSUME_YES -eq 1 ]] && return 0
  read -r -p "  $1 [y/N] " reply
  [[ "$reply" =~ ^[Yy]$ ]]
}

# ---------------------------------------------------------------- preflight --

bold "Preflight"

docker info >/dev/null 2>&1 || die "Docker isn't running (start OrbStack first)."
ok "docker reachable"

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [[ "$BRANCH" != "$EXPECT_BRANCH" ]]; then
  if [[ "$MODE" == "check" || "$MODE" == "sidecars" ]]; then
    warn "on '$BRANCH', expected '$EXPECT_BRANCH'"
  else
    die "On branch '$BRANCH', expected '$EXPECT_BRANCH'.
    The image builds from the working tree, so this would ship whatever '$BRANCH' contains
    — off 'local-features' that means no cache-TTL pill, no 5m TTL default, no opus-5 pricing.
    Fix:  git checkout $EXPECT_BRANCH
    Deploy '$BRANCH' on purpose:  DEPLOY_BRANCH=$BRANCH $0"
  fi
else
  ok "on branch $BRANCH ($(git rev-parse --short HEAD))"
fi

if [[ "$MODE" != "check" && "$MODE" != "sidecars" ]]; then
  DIRTY="$(git status --porcelain)"
  if [[ -n "$DIRTY" ]]; then
    warn "working tree is dirty — these uncommitted changes WILL ship in the image:"
    printf '      %s\n' $(git status --porcelain | awk '{print $2}')
    confirm "Continue anyway?" || die "aborted"
  else
    ok "working tree clean"
  fi
fi

# Runtime files are bind-mounted, not baked in — a missing one fails at container start.
for f in .env librechat.yaml nginx/default.conf searxng/settings.yml; do
  [[ -f "$f" ]] || die "missing required runtime file: $f
    (searxng/settings.yml is git-excluded — copy searxng/settings.yml.example and fill in the keys)"
done
if grep -q 'CHANGEME' searxng/settings.yml; then
  die "searxng/settings.yml still has CHANGEME placeholders — fill in the real keys."
fi
ok "runtime config files present"

if [[ "$MODE" == "check" || "$MODE" == "sidecars" ]]; then
  echo
else
  # ------------------------------------------------------------- build/deploy --
  echo
  # cost-dashboard is recreated alongside api because it bind-mounts the SAME single
  # file, ./librechat.yaml. A single-file bind binds the inode, and almost every editor
  # writes a temp file and renames over the original — a new inode. The container keeps
  # pointing at the old, now-unlinked one, and the path inside it turns into a stale
  # entry that cannot even be stat'd. Nothing errors: the api gets recreated and reads
  # the new yaml, while the dashboard silently loses its copy and
  # /cost/markets/endpoints starts returning [] — i.e. the market-price button just
  # stops appearing. Recreating both is what keeps them looking at the same file.
  if [[ "$MODE" == "config" ]]; then
    bold "Recreating api + cost-dashboard (config-only, no rebuild)"
    compose up -d --force-recreate api cost-dashboard
  else
    bold "Building api from working tree"
    # ${a[@]+…} guard: bash 3.2 (macOS) treats an empty array as unbound under `set -u`
    compose build "${BUILD_ARGS[@]+"${BUILD_ARGS[@]}"}" api
    echo
    bold "Recreating stack"
    compose up -d --force-recreate api cost-dashboard
    compose up -d
  fi

  # nginx resolves `api` and `cost-dashboard` once, at worker start, and caches the
  # addresses for the life of the process. Recreating those two together lets them swap
  # addresses on the compose network, at which point nginx proxies chat traffic to the
  # dashboard and /cost to the api — every route 502s with "Connection refused" against
  # an IP that is very much alive. Restarting nginx costs under a second and closes the
  # whole class, including the single-container case.
  compose restart nginx
  echo
fi

# ------------------------------------------------------------------- verify --

bold "Verify"

printf '  waiting for api'
for i in $(seq 1 60); do
  if curl -fsS -o /dev/null "$BASE_URL/health" 2>/dev/null; then
    printf '\r'; ok "api healthy ($BASE_URL/health)"; break
  fi
  printf '.'
  sleep 2
  if [[ $i -eq 60 ]]; then
    printf '\n'
    die "api did not come up within 120s — check: docker compose logs --tail=100 api"
  fi
done

SIDECAR_BAD=0
for path in /cost/healthz /export/healthz; do
  body="$(curl -fsS "$BASE_URL$path" 2>/dev/null)" || { warn "$path unreachable"; continue; }
  ok "$path $body"
  # The market popup measures its discount against the provider's list price,
  # which the sidecar reads from a bind-mounted tx.ts. Drop the mount and it
  # falls back to the marketplace's own reference — a reseller's marked-up
  # catalogue — so the popup overstates the discount, with nothing to show for
  # it but a plausible wrong number.
  if [[ "$path" == "/cost/healthz" && "$body" == *'"rates":0'* ]]; then
    warn "cost-dashboard read no provider list prices — tx.ts is not mounted"
    SIDECAR_BAD=1
  fi
done
if [[ $SIDECAR_BAD -eq 1 ]]; then
  die "The market-price popup would show a discount measured against the marketplace's
    own reference instead of the provider's list. Fix the tx.ts mount in
    docker-compose.override.yml, then:  docker compose up -d --build cost-dashboard"
fi

# The other half of the same mount: the dashboard names the marketplace-backed yaml rows
# by reading librechat.yaml itself, and marketplace_endpoint_names() swallows every error
# and returns []. A dangling bind is therefore indistinguishable from "no gateway is
# configured" — the market-price button simply never renders, with nothing in any log.
# Checking readability inside the container is the only place the difference shows.
if ! compose exec -T cost-dashboard test -r /app/librechat.yaml 2>/dev/null; then
  die "cost-dashboard cannot read its bind-mounted /app/librechat.yaml.
    Editing librechat.yaml replaces the file's inode and detaches a single-file bind on
    any container that was not recreated afterwards. The market-price button on gateway
    models silently stops appearing. Fix:  docker compose up -d --force-recreate cost-dashboard"
fi
markets_json="$(curl -fsS "$BASE_URL/cost/markets/endpoints" 2>/dev/null)" || markets_json=""
if [[ -n "$markets_json" ]]; then
  if [[ "$markets_json" == '{"endpoints":[]}'* ]] && grep -q 'api.surplusintelligence.ai' librechat.yaml; then
    warn "librechat.yaml has a marketplace baseURL but /cost/markets/endpoints is empty"
    warn "  → the market-price button will not render; check MARKETPLACE_HOSTS in cost-dashboard/markets.py"
  else
    ok "/cost/markets/endpoints $markets_json"
  fi
fi

# The image MCP server has no nginx route, and reachability is the half that
# actually breaks: the api container has to resolve mcp-image-gen on the compose
# network AND get past the mcpSettings allowlist. So probe it from inside api
# rather than from the host.
if compose ps --services 2>/dev/null | grep -qx mcp-image-gen; then
  mcp_body="$(compose exec -T api node -e '
    fetch("http://mcp-image-gen:3013/healthz")
      .then((r) => r.json())
      .then((j) => console.log(JSON.stringify(j)))
      .catch((e) => { console.log("ERR " + e.message); process.exitCode = 1; })
  ' 2>/dev/null)" || mcp_body="ERR exec failed"
  case "$mcp_body" in
    ERR*)  warn "mcp-image-gen unreachable from api — $mcp_body" ;;
    *'"warnings":[]'*)
           ok "mcp-image-gen $mcp_body" ;;
    *)     # A configured model with no key for its provider: the model is offered
           # in the tool description and refuses on first use.
           warn "mcp-image-gen up but a configured model has no key — $mcp_body" ;;
  esac
fi

# Same probe, same reason, for the audio sidecar.
if compose ps --services 2>/dev/null | grep -qx mcp-audio-ears; then
  ears_body="$(compose exec -T api node -e '
    fetch("http://mcp-audio-ears:3014/healthz")
      .then((r) => r.json())
      .then((j) => console.log(JSON.stringify(j)))
      .catch((e) => { console.log("ERR " + e.message); process.exitCode = 1; })
  ' 2>/dev/null)" || ears_body="ERR exec failed"
  case "$ears_body" in
    ERR*)  warn "mcp-audio-ears unreachable from api — $ears_body" ;;
    *'"hasKey":false'*)
           warn "mcp-audio-ears up but OPENROUTER_KEY is unset — listen_to_audio will refuse"
           echo "      $ears_body" ;;
    *)     ok "mcp-audio-ears $ears_body" ;;
  esac
fi

# The code-agent sidecar is a HOST process, not a compose service, so it is
# probed by hostname from inside api rather than by service name. A stopped
# LaunchAgent is a warning, not a failure: the stack is fine without it.
ca_body="$(compose exec -T api node -e '
  fetch("http://host.docker.internal:3015/healthz")
    .then((r) => r.json())
    .then((j) => console.log(JSON.stringify(j)))
    .catch((e) => { console.log("ERR " + (e.cause ? e.cause.code : e.message)); })
' 2>/dev/null)" || ca_body="ERR exec failed"
case "$ca_body" in
  ERR*)  warn "mcp-code-agent not answering — $ca_body
      start it with: launchctl load ~/Library/LaunchAgents/local.librechat.code-agent.plist" ;;
  *'"agentAvailable":false'*)
         warn "mcp-code-agent up but the claude CLI is not runnable from it — check PATH in the LaunchAgent"
         echo "      $ca_body" ;;
  *)     ok "mcp-code-agent $ca_body" ;;
esac

# ------------------------------------------------------- sidecar staleness --
#
# The sidecars are not part of the api image, so this script does not rebuild
# them — and nothing else noticed when their source moved on without them.
#
# On 2026-09-07 mcp-image-gen ran for 46 hours on code two commits behind the
# tree. It was healthy the whole time and answered every probe above. What it
# actually did was hand models the *old* result text — the text that claimed
# they could see an image the gateway had stripped — so a model duly filed a
# fault against a stack that had already fixed it. There is no error to grep
# for; the only observable is that the words are wrong, and only a reader who
# remembers the previous wording can tell.
#
# So: compare the source in the working tree against the copy baked into the
# running container, file by file. A warning, not a failure — a stale sidecar
# does not invalidate an api deploy, and the operator may be mid-edit.
# `--sidecars` rebuilds exactly the ones that drifted.
bold "Sidecar code vs. working tree"

DRIFTED=""

# Echoes the names of files whose working-tree copy differs from the container's,
# and separately any that never made it into the image at all.
#
# `cat | cmp` rather than hashing: busybox, coreutils and macOS disagree about
# which md5 binary exists, and these files are a few kB each.
#
# Test files are skipped. cost-dashboard's Dockerfile copies its modules by name
# and deliberately leaves `test_*.py` out, so including them would report drift on
# every run — a check that always fires is a check nobody reads. A *non*-test file
# missing from the image is the opposite: that is a COPY line someone forgot to
# update, and it is reported as its own thing rather than folded into "differs".
sidecar_drift() {
  local svc="$1"; shift
  local f name
  for f in "$@"; do
    [[ -f "$f" ]] || continue
    name="$(basename "$f")"
    case "$name" in test_*|*_test.*|*.spec.*) continue ;; esac
    if ! compose exec -T "$svc" test -f "/app/$name" 2>/dev/null; then
      echo "!$name"
    elif ! compose exec -T "$svc" cat "/app/$name" 2>/dev/null | cmp -s - "$f"; then
      echo "$name"
    fi
  done
}

check_sidecar() {
  local svc="$1"; shift
  compose ps --services 2>/dev/null | grep -qx "$svc" || return 0
  local all differs missing
  all="$(sidecar_drift "$svc" "$@")"
  differs="$(echo "$all" | grep -v '^!' | grep . | paste -sd' ' - || true)"
  missing="$(echo "$all" | grep '^!' | tr -d '!' | paste -sd' ' - || true)"
  if [[ -z "$differs" && -z "$missing" ]]; then
    ok "$svc matches the tree"
    return 0
  fi
  if [[ -n "$differs" ]]; then
    warn "$svc is running code that differs from the tree: $differs"
  fi
  if [[ -n "$missing" ]]; then
    warn "$svc image is missing source files entirely: $missing
      (its Dockerfile copies modules by name — add them there, or they never ship)"
  fi
  echo "      fix:  docker compose up -d --build $svc"
  DRIFTED="$DRIFTED $svc"
}

check_sidecar mcp-image-gen  mcp-image-gen/*.js mcp-image-gen/package.json
check_sidecar mcp-audio-ears mcp-audio-ears/*.js mcp-audio-ears/*.py mcp-audio-ears/package.json
check_sidecar cost-dashboard cost-dashboard/*.py cost-dashboard/requirements.txt

# The code-agent is a host process, so there is no image to compare against —
# node just never reloads. It reports the answer itself; see staleSources().
case "$ca_body" in
  *'"stale"'*)
    warn "mcp-code-agent has been running since before its source last changed"
    echo "      fix:  launchctl kickstart -k gui/$(id -u)/local.librechat.code-agent" ;;
esac

if [[ -n "$DRIFTED" && "$MODE" == "sidecars" ]]; then
  echo
  bold "Rebuilding$DRIFTED"
  compose up -d --build $DRIFTED
  ok "rebuilt — re-run --check to confirm"
elif [[ -n "$DRIFTED" ]]; then
  echo "      or rebuild every drifted one:  $0 --sidecars"
fi
echo

# Local features must be present in the DEPLOYED image, not just on disk. Each marker
# corresponds to one local commit; a missing marker means the image predates it or was
# built from the wrong tree.
bold "Local features in the deployed image"
check_marker() {
  local label="$1" pattern="$2" path="$3"
  if compose exec -T api sh -c "grep -q -- '$pattern' $path" 2>/dev/null; then
    ok "$label"
  else
    warn "$label — NOT FOUND (expected '$pattern' in $path)"
    MISSING=1
  fi
}
MISSING=0
check_marker "claude-opus-5 pricing"  "claude-opus-5" "/app/packages/data-schemas/dist/index.cjs"
check_marker "claude-opus-5 tokens"   "claude-opus-5" "/app/packages/api/dist/index.cjs"
check_marker "prompt-cache TTL wiring" "promptCacheTtl" "/app/packages/api/dist/index.cjs"
check_marker "cache-TTL pill (client)" "cacheTTL" "/app/client/dist/assets/*.js"
check_marker "nominal-cost routing"       "routedVia" "/app/packages/api/dist/index.cjs"
check_marker "dotted gateway pricing"     "claude-opus-4.8" "/app/packages/data-schemas/dist/index.cjs"
check_marker "yaml param defs (client)"    "com_endpoint_prompt_cache_marketplace" "/app/client/dist/assets/*.js"
check_marker "anthropic model-fetch path"  "isAnthropicProvider" "/app/packages/api/dist/index.cjs"
check_marker "models.filter"               "applyModelFilter" "/app/packages/api/dist/index.cjs"
check_marker "models.chatOnly"             "applyChatOnlyFilter" "/app/packages/api/dist/index.cjs"
check_marker "market-prices popover (client)" "com_ui_market_prices" "/app/client/dist/assets/*.js"
# Without this, every gateway request bills as zero input tokens — silently, with
# a correct reply and no error anywhere. See fork-customizations.md §10.
check_marker "gateway usage recovery"       "observeAnthropicStreamUsage" "/app/packages/api/dist/index.cjs"
# Without this, an audio attachment on an OpenAI-compatible endpoint is dropped
# between upload and request: the file shows in the thread, the model never gets
# it, nothing is logged. See fork-customizations.md §11.
check_marker "audio input forwarding"       "has no audio input format" "/app/packages/api/dist/index.cjs"
# Without this, an MCP server cannot name the file_id its image will be saved under,
# so a model that just generated an image needs a second get_user_images call before
# it can edit it. See fork-customizations.md §12.
check_marker "MCP image file_id passthrough" "librechat/file_id" "/app/packages/api/dist/index.cjs"
# Without this, an image an MCP tool produced reaches a gateway nested inside a
# `tool_result` — the one position a gateway drops it from, silently. The user
# sees the picture, the model never does, and the reply describes something it
# was not shown. Measured on Surplus 2026-09-07; see fork-customizations.md §13.
check_marker "tool_result media lift"       "liftToolResultMedia" "/app/packages/api/dist/index.cjs"

echo
if [[ $MISSING -eq 1 ]]; then
  die "Deployed image is missing local features. Confirm the branch and rebuild:
    git branch --show-current   # expect $EXPECT_BRANCH
    ./scripts/deploy.sh"
fi

bold "Deployed: $(git rev-parse --short HEAD) on $BRANCH"
echo "  Smoke-test at $BASE_URL — send one Claude message, confirm the Thoughts panel"
echo "  and the cache-TTL pill, then check the rate landed: $BASE_URL/cost"
