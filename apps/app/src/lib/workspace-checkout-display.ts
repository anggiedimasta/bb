import type { GitCheckoutRef, WorkspaceBranch } from "@bb/domain";

const SHORT_SHA_LENGTH = 7;

export interface WorkspaceCheckoutDisplay {
  copyErrorMessage: string | null;
  copyLabel: string | null;
  copySuccessMessage: string | null;
  copyValue: string | null;
  label: string;
  rowLabel: "Branch" | "Checkout";
  title: string;
  aheadCount?: number;
  behindCount?: number;
  upstream?: string | null;
  syncLabel?: string | null;
}

interface FormatWorkspaceCheckoutDisplayArgs {
  checkout: GitCheckoutRef;
  branch?: WorkspaceBranch | null;
}

function shortSha(sha: string): string {
  return sha.slice(0, SHORT_SHA_LENGTH);
}

export function formatWorkspaceCheckoutDisplay({
  checkout,
  branch,
}: FormatWorkspaceCheckoutDisplayArgs): WorkspaceCheckoutDisplay {
  switch (checkout.kind) {
    case "branch": {
      const ahead = branch?.aheadCount ?? 0;
      const behind = branch?.behindCount ?? 0;
      const upstream = branch?.upstream ?? null;
      const syncLabel = upstream || ahead > 0 || behind > 0
        ? `${behind}↓ ${ahead}↑`
        : null;

      return {
        copyErrorMessage: "Failed to copy branch name",
        copyLabel: "Copy branch name",
        copySuccessMessage: "Branch name copied",
        copyValue: checkout.branchName,
        label: checkout.branchName,
        rowLabel: "Branch",
        title: `Copy branch name: ${checkout.branchName}${upstream ? ` (${upstream}: ${behind} behind, ${ahead} ahead)` : ""}`,
        aheadCount: ahead,
        behindCount: behind,
        upstream,
        syncLabel,
      };
    }
    case "detached":
      if (checkout.headSha === null) {
        return {
          copyErrorMessage: null,
          copyLabel: null,
          copySuccessMessage: null,
          copyValue: null,
          label: "detached HEAD",
          rowLabel: "Checkout",
          title: "Detached HEAD",
        };
      }
      return {
        copyErrorMessage: "Failed to copy commit SHA",
        copyLabel: "Copy commit SHA",
        copySuccessMessage: "Commit SHA copied",
        copyValue: checkout.headSha,
        label: `detached ${shortSha(checkout.headSha)}`,
        rowLabel: "Checkout",
        title: `Detached HEAD: ${checkout.headSha}`,
      };
    case "unborn":
      return {
        copyErrorMessage: null,
        copyLabel: null,
        copySuccessMessage: null,
        copyValue: null,
        label:
          checkout.branchName !== null
            ? `${checkout.branchName} (empty)`
            : "empty repo",
        rowLabel: "Checkout",
        title:
          checkout.branchName !== null
            ? `Empty branch: ${checkout.branchName}`
            : "Empty repository",
      };
    case "unknown":
      return {
        copyErrorMessage: null,
        copyLabel: null,
        copySuccessMessage: null,
        copyValue: null,
        label: "unknown checkout",
        rowLabel: "Checkout",
        title: `Unknown checkout: ${checkout.reason}`,
      };
  }
}
