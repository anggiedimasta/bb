# Taskboard (worklog fork) — setup

This bb fork vendors Taskboard as a builtin plugin (`plugins/taskboard/`) with two
local modifications to the Jira source:

- **Status is derived from worklog markers, not the Jira status field.**
  - Any `[DONE]` worklog authored by you -> **Done** (regardless of later markers).
  - Otherwise, has any worklog -> **In Progress**.
  - No worklog at all -> **Todo**.
  - Activity markers (`[CODING]`, `[ANALYSIS DB]`, `[BLOCKED]`, `[REVISIT]`, ...)
    are surfaced as card labels.
- **Strictly read-only for Jira.** Status changes, drag/move, and issue creation
  are disabled in both the backend adapter and the UI. Browsing only.

Upstream: https://github.com/MateoCerquetella/bb-plugins (MIT). The unmodified
`LICENSE` is retained in this directory.

## First-time setup on a new machine

After cloning this bb fork:

```sh
pnpm install
bb plugin install taskboard --yes
```

Then configure the Jira connection for the bb project you want the board on:

```sh
bb taskboard config --source jira \
  --jira-url "https://<your-site>.atlassian.net" \
  --jira-email "<your-account-email>" \
  --jira-jql '"Platform Engineer" = currentUser() AND issuetype = "Sub-task Engineer" AND updated >= -2w ORDER BY updated DESC'
```

Set the Jira API token. The token is a secret and is NOT stored in git; provide
it once per machine via Taskboard -> Manage (the token field is write-only), or
place it in the plugin's per-project credential file:

```
<bb-data-dir>/plugins/taskboard/secrets/project-credentials/<sha256(bbProjectId)>/jira-api-token
```

(mode 0600). Reload afterwards:

```sh
bb plugin reload taskboard
bb taskboard refresh jira
```

## Time window / "load more"

The default JQL uses a 2-week window (`updated >= -2w`). To widen or narrow the
window, use the helper (Jira relative dates only accept w/d units):

```sh
scripts/taskboard-window.sh 2w    # default
scripts/taskboard-window.sh 4w
scripts/taskboard-window.sh 13w   # ~3 months
scripts/taskboard-window.sh 26w   # ~6 months
scripts/taskboard-window.sh 52w   # ~1 year
scripts/taskboard-window.sh all   # remove the window
```

## Notes for maintainers

- Registered as a builtin in `apps/server/src/services/plugins/builtin-registry.ts`
  (OFFICIAL_PLUGINS) and `plugins/bb-official.json`.
- Dependencies use `workspace:*` for `@get-bb/plugin-sdk` and `bb-app`.
- The worklog/read-only changes live in `sources/jira.ts`; the UI control
  removals live in `app.tsx`.
- Re-syncing upstream Taskboard means re-applying these two edits by hand.

> AGENT GENERATED
