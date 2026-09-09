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

  it("normalizes Antigravity quota-summary groups into remaining-based windows", () => {
    expect(
      __testing.normalizeAntigravityUsage({
        response: {
          groups: [
            {
              displayName: "Gemini Models",
              buckets: [
                {
                  bucketId: "gemini-weekly",
                  displayName: "Weekly Limit Remaining",
                  window: "weekly",
                  remainingFraction: 0.11264957,
                  resetTime: "2026-09-11T02:41:41Z",
                },
                {
                  bucketId: "gemini-5h",
                  displayName: "Five Hour Limit Remaining",
                  window: "5h",
                  remainingFraction: 0.0364187,
                  resetTime: "2026-09-09T07:43:55Z",
                },
              ],
            },
            {
              displayName: "Claude and GPT models",
              buckets: [
                {
                  bucketId: "3p-weekly",
                  window: "weekly",
                  remainingFraction: 0.68260735,
                  resetTime: "2026-09-15T18:35:06Z",
                },
              ],
            },
          ],
        },
      }),
    ).toEqual({
      status: "ok",
      accountEmail: null,
      planLabel: null,
      windows: [
        {
          label: "Gemini Models · Weekly",
          usedPercent: 89,
          resetsAt: "2026-09-11T02:41:41Z",
        },
        {
          label: "Gemini Models · 5-hour",
          usedPercent: 96,
          resetsAt: "2026-09-09T07:43:55Z",
        },
        {
          label: "Claude and GPT models · Weekly",
          usedPercent: 32,
          resetsAt: "2026-09-15T18:35:06Z",
        },
      ],
    });
  });

  it("skips Antigravity buckets that carry reset prose but no remaining fraction", () => {
    expect(
      __testing.normalizeAntigravityUsage({
        response: {
          groups: [
            {
              displayName: "Gemini Models",
              buckets: [
                {
                  bucketId: "gemini-5h",
                  description: "Refreshes in 51 minutes.",
                  window: "5h",
                  resetTime: "2026-09-09T07:43:55Z",
                },
              ],
            },
          ],
        },
      }),
    ).toEqual({
      status: "ok",
      accountEmail: null,
      planLabel: null,
      windows: [],
    });
  });

  it("reports an error when the Antigravity usage response is malformed", () => {
    expect(__testing.normalizeAntigravityUsage({ response: "nope" })).toEqual({
      status: "error",
      message: "Antigravity usage response was malformed.",
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
