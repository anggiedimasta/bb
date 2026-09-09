import { describe, expect, it } from "vitest";
import { CURSOR_ACP_MAINTENANCE, __testing } from "./provider-maintenance.js";

function cursorMissingInstallationStatus() {
  return {
    executableName: "cursor-agent",
    executablePath: null,
    installed: false,
    installSource: "notInstalled" as const,
    currentVersion: null,
    latestVersion: null,
    minimumSupportedVersion: null,
    npmPackageName: null,
    npmGlobalPackageVersion: null,
    installAction: {
      kind: "install" as const,
      label: "Install" as const,
      command: "install Cursor",
    },
    needsUpdate: false,
    versionUnsupported: false,
  };
}

describe("ACP provider maintenance", () => {
  it("normalizes Cursor plan and spend limits without reading daemon state", () => {
    expect(
      __testing.normalizeUsage(
        {
          billingCycleEnd: "1767225600000",
          planUsage: { totalPercentUsed: 72.2 },
          spendLimitUsage: {
            overallUsed: "1250",
            overallLimit: "5000",
          },
        },
        { planInfo: { planName: "Pro" } },
        "cursor@example.com",
      ),
    ).toEqual({
      status: "ok",
      accountEmail: "cursor@example.com",
      planLabel: "Pro",
      windows: [
        {
          label: "Plan usage",
          usedPercent: 72,
          resetsAt: "2026-01-01T00:00:00.000Z",
        },
        {
          label: "On-demand spend",
          usedPercent: 25,
          resetsAt: "2026-01-01T00:00:00.000Z",
          cost: { usedUsdCents: 1250, limitUsdCents: 5000 },
        },
      ],
    });
  });

  it("normalizes Kiro credit usage from the GetUsageLimits response", () => {
    expect(
      __testing.normalizeKiroUsage({
        nextDateReset: 1790812800,
        subscriptionInfo: { subscriptionTitle: "KIRO PRO" },
        usageBreakdownList: [
          {
            resourceType: "CREDIT",
            displayName: "Credit",
            displayNamePlural: "Credits",
            currentUsage: 62,
            currentUsageWithPrecision: 62.61,
            usageLimit: 1000,
            usageLimitWithPrecision: 1000,
            nextDateReset: 1790812800,
          },
        ],
      }),
    ).toEqual({
      status: "ok",
      accountEmail: null,
      planLabel: "KIRO PRO",
      windows: [
        {
          label: "Credits",
          usedPercent: 6,
          resetsAt: "2026-10-01T00:00:00.000Z",
        },
      ],
    });
  });

  it("falls back to the top-level reset and skips zero-limit Kiro windows", () => {
    expect(
      __testing.normalizeKiroUsage({
        nextDateReset: 1790812800,
        subscriptionInfo: {},
        usageBreakdownList: [
          { resourceType: "CREDIT", currentUsage: 5, usageLimit: 0 },
          { displayNamePlural: "Requests", currentUsage: 10, usageLimit: 40 },
        ],
      }),
    ).toEqual({
      status: "ok",
      accountEmail: null,
      planLabel: null,
      windows: [
        {
          label: "Requests",
          usedPercent: 25,
          resetsAt: "2026-10-01T00:00:00.000Z",
        },
      ],
    });
  });

  it("reports an error when the Kiro usage response is malformed", () => {
    expect(
      __testing.normalizeKiroUsage({ usageBreakdownList: "nope" }),
    ).toEqual({
      status: "error",
      message: "Kiro usage response was malformed.",
      planLabel: null,
      accountEmail: null,
    });
  });

  it("offers the installer only through a fresh matching action", () => {
    expect(
      __testing.buildProviderInstallationRun(
        cursorMissingInstallationStatus(),
        {
          maintenance: CURSOR_ACP_MAINTENANCE,
          command: "cursor-agent",
          action: "install",
        },
      ),
    ).toMatchObject({
      available: true,
      command: { command: "sh" },
      verification: { kind: "installed" },
    });
    expect(
      __testing.buildProviderInstallationRun(
        { ...cursorMissingInstallationStatus(), installAction: null },
        { maintenance: undefined, command: "opencode", action: "install" },
      ),
    ).toEqual({
      available: false,
      message: "opencode install is not available on this host.",
    });
    expect(
      __testing.buildProviderInstallationRun(
        cursorMissingInstallationStatus(),
        {
          maintenance: undefined,
          command: "opencode",
          action: "install",
        },
      ),
    ).toEqual({
      available: false,
      message: "opencode install is not available on this host.",
    });
  });
});
