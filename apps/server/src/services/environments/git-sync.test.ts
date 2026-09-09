import { describe, expect, it } from "vitest";
import {
  GitSyncError,
  syncGitBranch,
  type GitSyncCommandResult,
  type RunGitSyncCommand,
} from "./git-sync.js";

interface StubResponse {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
}

function createRunGit(config: {
  responses?: Record<string, StubResponse>;
  fallback?: StubResponse;
}): { runGit: RunGitSyncCommand; calls: string[][] } {
  const calls: string[][] = [];
  const runGit: RunGitSyncCommand = (args) => {
    calls.push(args);
    const key = args.join(" ");
    const match = config.responses?.[key] ?? config.fallback ?? {};
    const result: GitSyncCommandResult = {
      stdout: match.stdout ?? "",
      stderr: match.stderr ?? "",
      exitCode: match.exitCode ?? 0,
    };
    return Promise.resolve(result);
  };
  return { runGit, calls };
}

const CLEAN_ENV = {
  "rev-parse --abbrev-ref HEAD": { stdout: "feature/topic\n" },
  "rev-parse --abbrev-ref --symbolic-full-name @{upstream}": {
    stdout: "origin/feature/topic\n",
  },
  "--no-optional-locks status --porcelain": { stdout: "" },
} satisfies Record<string, StubResponse>;

describe("syncGitBranch", () => {
  it("runs fetch, pull --rebase, then push in order and never forces", async () => {
    const { runGit, calls } = createRunGit({
      responses: {
        ...CLEAN_ENV,
        "pull --rebase": { stdout: "Successfully rebased and updated." },
        push: { stderr: "To github.com\n   abc123..def456  feature/topic" },
      },
    });

    const result = await syncGitBranch({ cwd: "/repo", runGit });

    const commands = calls.map((args) => args.join(" "));
    expect(commands).toEqual([
      "fetch --prune",
      "rev-parse --abbrev-ref HEAD",
      "rev-parse --abbrev-ref --symbolic-full-name @{upstream}",
      "--no-optional-locks status --porcelain",
      "pull --rebase",
      "push",
    ]);
    for (const args of calls) {
      expect(args.join(" ")).not.toMatch(/--force|-f\b|--force-with-lease/);
    }
    expect(result.pulled).toBe(true);
    expect(result.pushed).toBe(true);
    expect(result.message).toBe("Branch synchronized");
  });

  it("aborts the rebase and reports a conflict error without forcing", async () => {
    const { runGit, calls } = createRunGit({
      responses: {
        ...CLEAN_ENV,
        "pull --rebase": {
          exitCode: 1,
          stderr:
            "CONFLICT (content): Merge conflict in src/app.ts\nerror: could not apply ...",
        },
        "rev-parse --verify --quiet REBASE_HEAD": { stdout: "deadbeef\n" },
        "rev-parse --git-path rebase-merge": {
          stdout: "/repo/.git/rebase-merge\n",
        },
        "rev-parse --git-path rebase-apply": {
          stdout: "/repo/.git/rebase-apply\n",
        },
      },
    });

    await expect(
      syncGitBranch({ cwd: "/repo", runGit }),
    ).rejects.toMatchObject({
      code: "git_sync_conflict",
      status: 409,
    });

    const commands = calls.map((args) => args.join(" "));
    expect(commands).toContain("rebase --abort");
    expect(commands).not.toContain("push");
    for (const args of calls) {
      expect(args.join(" ")).not.toMatch(/--force/);
    }
  });

  it("refuses to sync when the working tree is dirty", async () => {
    const { runGit, calls } = createRunGit({
      responses: {
        ...CLEAN_ENV,
        "--no-optional-locks status --porcelain": {
          stdout: " M src/app.ts\n",
        },
      },
    });

    await expect(
      syncGitBranch({ cwd: "/repo", runGit }),
    ).rejects.toMatchObject({ code: "git_sync_dirty_worktree", status: 409 });

    const commands = calls.map((args) => args.join(" "));
    expect(commands).not.toContain("pull --rebase");
    expect(commands).not.toContain("push");
  });

  it("rejects a non-fast-forward push instead of force-pushing", async () => {
    const { runGit, calls } = createRunGit({
      responses: {
        ...CLEAN_ENV,
        "pull --rebase": { stdout: "Already up to date." },
        push: {
          exitCode: 1,
          stderr:
            "! [rejected] feature/topic -> feature/topic (non-fast-forward)\nerror: failed to push some refs",
        },
      },
    });

    await expect(
      syncGitBranch({ cwd: "/repo", runGit }),
    ).rejects.toMatchObject({ code: "git_sync_push_rejected", status: 409 });

    for (const args of calls) {
      expect(args.join(" ")).not.toMatch(/--force/);
    }
  });

  it("skips pull/push when the branch has no upstream", async () => {
    const { runGit, calls } = createRunGit({
      responses: {
        "fetch --prune": { stdout: "" },
        "rev-parse --abbrev-ref HEAD": { stdout: "solo\n" },
        "rev-parse --abbrev-ref --symbolic-full-name @{upstream}": {
          exitCode: 128,
          stderr: "fatal: no upstream configured for branch 'solo'",
        },
      },
    });

    const result = await syncGitBranch({ cwd: "/repo", runGit });
    expect(result.pulled).toBe(false);
    expect(result.pushed).toBe(false);
    expect(result.message).toBe("Nothing to sync");

    const commands = calls.map((args) => args.join(" "));
    expect(commands).not.toContain("pull --rebase");
    expect(commands).not.toContain("push");
  });

  it("reports up-to-date when nothing changed on either side", async () => {
    const { runGit } = createRunGit({
      responses: {
        ...CLEAN_ENV,
        "pull --rebase": { stdout: "Already up to date." },
        push: { stderr: "Everything up-to-date" },
      },
    });

    const result = await syncGitBranch({ cwd: "/repo", runGit });
    expect(result.pulled).toBe(true);
    expect(result.pushed).toBe(false);
    expect(result.summary).toContain("Already up to date");
    expect(result.summary).toContain("Nothing new to push.");
  });

  it("surfaces a generic failure when fetch fails for a real reason", async () => {
    const { runGit } = createRunGit({
      responses: {
        "fetch --prune": {
          exitCode: 128,
          stderr: "fatal: unable to access remote: Connection timed out",
        },
      },
    });

    await expect(
      syncGitBranch({ cwd: "/repo", runGit }),
    ).rejects.toBeInstanceOf(GitSyncError);
  });
});
