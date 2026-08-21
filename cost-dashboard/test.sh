#!/usr/bin/env bash
#
# Run the cost-dashboard tests inside the image.
#
# The image carries only the modules it serves — no test files and no pytest —
# so the suite runs against a mounted source tree instead of a rebuilt image.
# tx.ts is mounted where the container expects it so `test_listprices.py` can
# check the real rate table rather than skipping.
#
#   ./cost-dashboard/test.sh                    # everything
#   ./cost-dashboard/test.sh test_markets.py    # one file, or any pytest args
#
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"

exec docker compose run --rm \
  -v "$REPO/cost-dashboard:/tests:ro" \
  -v "$REPO/packages/data-schemas/src/methods/tx.ts:/app/tx.ts:ro" \
  --entrypoint sh cost-dashboard -c \
  "pip install --quiet pytest >/dev/null 2>&1; cd /tests && exec python -m pytest -q -p no:cacheprovider $*" \
  2> >(grep -vE '(UID|GID|ADMIN_PANEL_SESSION_SECRET)[^ ]* variable is not set' >&2)
