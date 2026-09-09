import { execFile } from "node:child_process";
import type { ContentfulStatusCode } from "hono/utils/http-status";

export interface GitSyncCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type RunGitSyncCommand = (
  args: string[],
  options: { cwd: string; timeoutMs: number },
) => Promise<GitSyncCommandResult>;

export interface GitSyncOptions {
  cwd: string;
  timeoutMs?: number;
  runGit?: RunGitSyncCommand;
}

export interface GitSyncResult {
  message: string;
  summary: string;
  pulled: boolean;
  pushed: boolean;
}

export class GitSyncError extends Error {
  readonly code: string;
  readonly status: ContentfulStatusCode;
  constructor(
    code: string,
    message: string,
    status: ContentfulStatusCode = 500,
  ) {
    super(message);
    this.code = code;
    this.status = status;
    this.name = "GitSyncError";
  }
}

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_BUFFER_BYTES = 10 * 1024 * 1024;

const defaultRunGit: RunGitSyncCommand = (args, options) =>
  new Promise<GitSyncCommandResult>((resolve) => {
    execFile(
      "git",
      args,
      {
        cwd: options.cwd,
        timeout: options.timeoutMs,
        maxBuffer: MAX_BUFFER_BYTES,
      },
      (error, stdout, stderr) => {
        const exitCode =
          error && typeof (error as { code?: unknown }).code === "number"
            ? ((error as { code: number }).code as number)
            : error
              ? 1
              : 0;
        resolve({
          stdout: stdout ?? "",
          stderr: stderr ?? "",
          exitCode,
        });
      },
    );
  });

function trim(value: string): string {
  return value.trim();
}

function firstNonEmptyMessage(...values: Array<string | undefined>): string {
  for (const value of values) {
    const trimmed = trim(value ?? "");
    if (trimmed) {
      return trimmed;
    }
  }
  return "";
}

function summarizePull(stdout: string): string {
  const output = trim(stdout);
  if (/already up to date/i.test(output)) {
    return "Already up to date with remote.";
  }
  const filesChanged = output.match(/(\d+\s+files?\s+changed[^\r\n]*)/i);
  if (filesChanged) {
    return trim(filesChanged[1]);
  }
  if (output) {
    const lines = output.split("\n").filter(Boolean);
    return trim(lines[lines.length - 1] ?? "") || "Pulled latest changes.";
  }
  return "Pulled latest changes.";
}

async function getCurrentBranch(
  runGit: RunGitSyncCommand,
  cwd: string,
  timeoutMs: number,
): Promise<string> {
  const result = await runGit(["rev-parse", "--abbrev-ref", "HEAD"], {
    cwd,
    timeoutMs,
  });
  const branch = trim(result.stdout);
  if (result.exitCode !== 0 || !branch || branch === "HEAD") {
    throw new GitSyncError(
      "git_sync_no_branch",
      "Cannot sync: no branch is checked out (detached HEAD).",
      409,
    );
  }
  return branch;
}

async function hasUpstream(
  runGit: RunGitSyncCommand,
  cwd: string,
  timeoutMs: number,
): Promise<boolean> {
  const result = await runGit(
    ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
    { cwd, timeoutMs },
  );
  return result.exitCode === 0 && trim(result.stdout).length > 0;
}

async function isWorkingTreeClean(
  runGit: RunGitSyncCommand,
  cwd: string,
  timeoutMs: number,
): Promise<boolean> {
  const result = await runGit(
    ["--no-optional-locks", "status", "--porcelain"],
    { cwd, timeoutMs },
  );
  if (result.exitCode !== 0) {
    throw new GitSyncError(
      "git_sync_failed",
      firstNonEmptyMessage(result.stderr, result.stdout) ||
        "Failed to read git status.",
    );
  }
  return trim(result.stdout).length === 0;
}

async function abortRebaseIfInProgress(
  runGit: RunGitSyncCommand,
  cwd: string,
  timeoutMs: number,
): Promise<void> {
  const inProgress = await runGit(
    ["rev-parse", "--verify", "--quiet", "REBASE_HEAD"],
    { cwd, timeoutMs },
  );
  const rebaseDir = await runGit(["rev-parse", "--git-path", "rebase-merge"], {
    cwd,
    timeoutMs,
  });
  const applyDir = await runGit(["rev-parse", "--git-path", "rebase-apply"], {
    cwd,
    timeoutMs,
  });
  const looksLikeRebase =
    inProgress.exitCode === 0 ||
    trim(rebaseDir.stdout).length > 0 ||
    trim(applyDir.stdout).length > 0;
  if (looksLikeRebase) {
    await runGit(["rebase", "--abort"], { cwd, timeoutMs });
  }
}

export async function syncGitBranch(
  options: GitSyncOptions,
): Promise<GitSyncResult> {
  const cwd = options.cwd;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const runGit = options.runGit ?? defaultRunGit;

  const fetch = await runGit(["fetch", "--prune"], { cwd, timeoutMs });
  if (fetch.exitCode !== 0) {
    const stderr = trim(fetch.stderr);
    if (
      /no such remote|does not appear to be a git repository|no configured/i.test(
        stderr,
      )
    ) {
      return {
        message: "Nothing to sync",
        summary: "No remote is configured for this branch.",
        pulled: false,
        pushed: false,
      };
    }
    throw new GitSyncError("git_sync_failed", stderr || "git fetch failed.");
  }

  const branch = await getCurrentBranch(runGit, cwd, timeoutMs);

  if (!(await hasUpstream(runGit, cwd, timeoutMs))) {
    return {
      message: "Nothing to sync",
      summary: `Branch ${branch} has no upstream to sync with.`,
      pulled: false,
      pushed: false,
    };
  }

  if (!(await isWorkingTreeClean(runGit, cwd, timeoutMs))) {
    throw new GitSyncError(
      "git_sync_dirty_worktree",
      "Cannot sync with uncommitted changes. Commit or stash them first, then sync.",
      409,
    );
  }

  const pull = await runGit(["pull", "--rebase"], { cwd, timeoutMs });
  if (pull.exitCode !== 0) {
    await abortRebaseIfInProgress(runGit, cwd, timeoutMs);
    const detail = firstNonEmptyMessage(pull.stderr, pull.stdout);
    if (/conflict/i.test(detail)) {
      throw new GitSyncError(
        "git_sync_conflict",
        "Rebase hit conflicts and was aborted. Resolve the conflicting commits locally, then sync again.",
        409,
      );
    }
    throw new GitSyncError(
      "git_sync_failed",
      detail || "git pull --rebase failed.",
    );
  }
  const pullSummary = summarizePull(pull.stdout);

  const push = await runGit(["push"], { cwd, timeoutMs });
  if (push.exitCode !== 0) {
    const detail = firstNonEmptyMessage(push.stderr, push.stdout);
    if (/non-fast-forward|fetch first|rejected/i.test(detail)) {
      throw new GitSyncError(
        "git_sync_push_rejected",
        "Push was rejected because the remote moved ahead. Sync again to rebase on the latest remote; bb never force-pushes.",
        409,
      );
    }
    throw new GitSyncError("git_sync_failed", detail || "git push failed.");
  }

  const pushOutput = firstNonEmptyMessage(push.stderr, push.stdout);
  const pushedNothing = /everything up-to-date/i.test(pushOutput);

  const summaryParts: string[] = [pullSummary];
  summaryParts.push(
    pushedNothing ? "Nothing new to push." : "Local commits pushed to remote.",
  );

  return {
    message: "Branch synchronized",
    summary: summaryParts.join(" "),
    pulled: true,
    pushed: !pushedNothing,
  };
}
