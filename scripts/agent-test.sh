#!/usr/bin/env bash
# Run this repo's unit tests in a shape an agent can actually read.
#
# Two problems this exists for.
#
# 1. THE SUITE IS RED OUT OF THE BOX. `npx jest src/mcp` reports 7 failed suites
#    and 72 failed tests on a clean tree. None of them are real: they are Redis
#    and OAuth *integration* suites that need infrastructure this checkout does
#    not have, a `.manual.` performance benchmark that is not meant to run
#    unattended, and two helper modules that live in a `__tests__/` directory and
#    contain no tests, so jest counts them as suites that "failed to run".
#
#    Ambient red is worse than no tests. An agent — or a person — that sees 72
#    failures either tries to fix them or learns that failures are normal, and
#    both of those are how a real regression gets waved through.
#
# 2. RAW JEST OUTPUT IS ENORMOUS. Measured on `src/mcp`: 300 KB, roughly 75,000
#    tokens, for a run whose useful content is five lines. Worse, jest prints its
#    summary LAST and agent harnesses truncate long command output, so the raw
#    invocation costs a fortune and then throws away the only part that mattered.
#
# So: green runs print the summary and nothing else. Red runs print the summary
# plus the failing blocks. The exclusion list is echoed every time, because a
# test suite that hides things quietly is how you get back to problem 1.
#
#   ./scripts/agent-test.sh                       # every workspace
#   ./scripts/agent-test.sh packages/api          # one workspace
#   ./scripts/agent-test.sh packages/api src/mcp  # one workspace, one path filter
#
# Exit code is jest's: non-zero means something really failed.

set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

# Suites excluded from every run, with the reason each one is here. Widening this
# list is a diff someone can see and argue with — which is the point of it living
# in a committed file rather than in an agent's instructions, where "just exclude
# the failing one" is a thought with no witness.
IGNORE=(
  "integration"          # needs a live Redis / OAuth server; absent in a checkout
  "\.manual\."           # perf benchmarks, meant to be run deliberately
  "__tests__/helpers/"   # helper modules, not suites — jest calls them failures
  "\.helper\.ts$"        # same
)

WORKSPACES=(packages/api packages/data-provider packages/data-schemas api client)

target="${1:-}"
filter="${2:-}"
[[ -n "$target" ]] && WORKSPACES=("$target")

echo "excluding: ${IGNORE[*]}"
echo

overall=0
for ws in "${WORKSPACES[@]}"; do
  [[ -d "$ws" ]] || { echo "skip $ws (not present)"; continue; }

  out="$(cd "$ws" && npx jest ${filter:+"$filter"} --silent \
        --testPathIgnorePatterns "${IGNORE[@]}" 2>&1)"
  status=$?

  summary="$(printf '%s\n' "$out" | grep -E '^(Test Suites|Tests|Snapshots|Time):' || true)"

  if [[ $status -eq 0 ]]; then
    echo "PASS $ws"
    printf '%s\n\n' "$summary"
  else
    overall=$status
    echo "FAIL $ws"
    printf '%s\n\n' "$summary"
    # The failing files first, as a list to work from...
    printf '%s\n' "$out" | grep -E '^FAIL ' | sort -u
    echo
    # ...then the failure bodies themselves. Everything from jest's first `●`
    # bullet to the summary line, which is the expected/received pairs and the
    # code frames — the part a fix is actually written from. A blank line
    # separates the bullet from its own detail, so this cannot be a range ending
    # at /^$/; that was the first version of this and it printed only headings.
    printf '%s\n' "$out" | awk '/^  ● /{f=1} /^Test Suites:/{f=0} f' | head -150
    echo
  fi
done

exit $overall
