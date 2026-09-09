#!/usr/bin/env bash
set -euo pipefail

# Taskboard "load more" helper.
#
# Widens (or narrows) the time window of the current BB project's Taskboard
# Jira JQL, then refreshes so the board reloads with more/less history.
# The window is expressed as an `updated >= -<N><unit>` clause; `all` removes
# the clause entirely to load every matching issue.
#
# Usage:
#   scripts/taskboard-window.sh [WINDOW] [--project <proj_id>]
#
#   WINDOW  one of: 1w 2w 4w 13w 26w 52w all   (default: prints current window)
#           Jira relative dates only accept w/d/h units, so "months" are
#           expressed in weeks (13w ~ 3 months, 26w ~ 6 months, 52w ~ 1 year).
#
# Examples:
#   scripts/taskboard-window.sh          # show current window + item count
#   scripts/taskboard-window.sh 2w       # default focused window
#   scripts/taskboard-window.sh 13w      # load more (~last 3 months)
#   scripts/taskboard-window.sh all      # load everything

BB="${BB_CLI:-bb}"

window=""
project_args=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --project)
      project_args=(--project "${2:?--project needs a value}")
      shift 2
      ;;
    *)
      window="$1"
      shift
      ;;
  esac
done

read_jql() {
  "$BB" taskboard config ${project_args[@]+"${project_args[@]}"} --json \
    | python3 -c "import json,sys;print(json.load(sys.stdin)['config']['jiraJql'])"
}

item_count() {
  "$BB" taskboard refresh jira ${project_args[@]+"${project_args[@]}"} --json \
    | python3 -c "import json,sys;print(json.load(sys.stdin).get('itemCount'))"
}

if [[ -z "$window" ]]; then
  echo "Current JQL: $(read_jql)"
  exit 0
fi

case "$window" in
  1w|2w|3w|4w|8w|13w|26w|52w|all) ;;
  *) echo "Invalid window '$window'. Use one of: 1w 2w 4w 13w 26w 52w all (Jira units: w/d only)" >&2; exit 2 ;;
esac

current="$(read_jql)"

# Strip any existing `AND updated >= -<window>` clause (case-insensitive),
# leaving the rest of the JQL (including ORDER BY) intact.
new_jql="$(WINDOW="$window" CURRENT="$current" python3 <<'PY'
import os, re
current = os.environ["CURRENT"]
window = os.environ["WINDOW"]

# Remove an existing updated-window clause if present.
stripped = re.sub(
    r'\s+AND\s+updated\s*>=\s*-\S+', '', current, flags=re.IGNORECASE
)

if window == "all":
    print(stripped.strip())
else:
    m = re.search(r'\s+ORDER\s+BY\s+.*$', stripped, flags=re.IGNORECASE)
    if m:
        head = stripped[:m.start()].rstrip()
        order = stripped[m.start():].strip()
        print(f"{head} AND updated >= -{window} {order}")
    else:
        print(f"{stripped.strip()} AND updated >= -{window}")
PY
)"

"$BB" taskboard config ${project_args[@]+"${project_args[@]}"} --source jira --jira-jql "$new_jql" --json >/dev/null
echo "Window set to: ${window}"
echo "JQL: ${new_jql}"
echo "Loaded items: $(item_count)"
