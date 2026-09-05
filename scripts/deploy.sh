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
  if [[ "$MODE" == "check" ]]; then
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

if [[ "$MODE" != "check" ]]; then
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

if [[ "$MODE" == "check" ]]; then
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
    *'"hasKey":false'*)
           warn "mcp-image-gen up but OPENROUTER_KEY is unset — generate_image will refuse"
           echo "      $mcp_body" ;;
    *)     ok "mcp-image-gen $mcp_body" ;;
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

echo
if [[ $MISSING -eq 1 ]]; then
  die "Deployed image is missing local features. Confirm the branch and rebuild:
    git branch --show-current   # expect $EXPECT_BRANCH
    ./scripts/deploy.sh"
fi

bold "Deployed: $(git rev-parse --short HEAD) on $BRANCH"
echo "  Smoke-test at $BASE_URL — send one Claude message, confirm the Thoughts panel"
echo "  and the cache-TTL pill, then check the rate landed: $BASE_URL/cost"
