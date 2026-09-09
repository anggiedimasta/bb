// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { ProviderUsageResponse } from "@bb/host-daemon-contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sdk } from "@/lib/sdk";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import { ProviderQuotaIndicator } from "./ProviderQuotaIndicator";

vi.mock("@/lib/sdk", () => ({
  BbHttpError: class BbHttpError extends Error {},
  sdk: {
    system: {
      usageLimits: vi.fn(),
    },
  },
}));

const usageLimitsMock = vi.mocked(sdk.system.usageLimits);

function renderIndicator(
  props: Partial<Parameters<typeof ProviderQuotaIndicator>[0]> = {},
) {
  const { wrapper } = createQueryClientTestHarness();
  return render(
    <ProviderQuotaIndicator
      providerId="claude"
      providerLabel="Claude Code"
      {...props}
    />,
    { wrapper },
  );
}

function usageResponse(response: ProviderUsageResponse) {
  usageLimitsMock.mockResolvedValue(response);
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("ProviderQuotaIndicator", () => {
  it("shows the most-constrained window's remaining percentage", async () => {
    usageResponse({
      claude: {
        status: "ok",
        accountEmail: null,
        planLabel: "Max",
        windows: [
          { label: "Weekly limit", usedPercent: 32, resetsAt: null },
          { label: "5-hour limit", usedPercent: 52, resetsAt: null },
        ],
      },
    });

    renderIndicator();

    const indicator = await screen.findByLabelText(
      "Claude Code: 48% of 5-hour limit remaining",
    );
    expect(indicator.textContent).toContain("48%");
  });

  it("renders nothing when the provider reports no usage windows", async () => {
    usageResponse({
      claude: {
        status: "ok",
        accountEmail: null,
        planLabel: null,
        windows: [],
      },
    });

    const { container } = renderIndicator();

    await waitFor(() => {
      expect(usageLimitsMock).toHaveBeenCalled();
    });
    expect(
      container.querySelector("[data-provider-quota-indicator]"),
    ).toBeNull();
  });

  it("shows a neutral indicator with a sign-in hint when unauthenticated", async () => {
    usageResponse({ claude: { status: "unauthenticated" } });

    renderIndicator();

    const indicator = await screen.findByLabelText(
      "Claude Code usage: Sign in to Claude Code to see usage limits.",
    );
    expect(indicator.getAttribute("data-provider-quota-status")).toBe(
      "unauthenticated",
    );
  });

  it("renders nothing when the provider does not report usage at all", async () => {
    usageResponse({});

    const { container } = renderIndicator();

    await waitFor(() => {
      expect(usageLimitsMock).toHaveBeenCalled();
    });
    expect(
      container.querySelector("[data-provider-quota-indicator]"),
    ).toBeNull();
  });

  it("renders nothing while disabled and does not query usage", () => {
    usageResponse({
      claude: {
        status: "ok",
        accountEmail: null,
        planLabel: null,
        windows: [{ label: "Weekly limit", usedPercent: 10, resetsAt: null }],
      },
    });

    const { container } = renderIndicator({ enabled: false });

    expect(usageLimitsMock).not.toHaveBeenCalled();
    expect(
      container.querySelector("[data-provider-quota-indicator]"),
    ).toBeNull();
  });

  it("requests usage for the given provider on the given host", async () => {
    usageResponse({
      openai: {
        status: "ok",
        accountEmail: null,
        planLabel: null,
        windows: [{ label: "Monthly limit", usedPercent: 5, resetsAt: null }],
      },
    });

    renderIndicator({
      providerId: "openai",
      providerLabel: "OpenAI",
      hostId: "host-1",
    });

    await waitFor(() => {
      expect(usageLimitsMock).toHaveBeenCalledWith(
        expect.objectContaining({ hostId: "host-1", providerId: "openai" }),
      );
    });
    expect(
      await screen.findByLabelText(
        "OpenAI: 95% of Monthly limit remaining",
      ),
    ).not.toBeNull();
  });

  it("shows cost windows using the dollar range instead of percent", async () => {
    usageResponse({
      codex: {
        status: "ok",
        accountEmail: null,
        planLabel: null,
        windows: [
          {
            label: "Spend",
            usedPercent: 40,
            resetsAt: null,
            cost: { usedUsdCents: 400, limitUsdCents: 1000 },
          },
        ],
      },
    });

    renderIndicator({ providerId: "codex", providerLabel: "Codex" });

    expect(
      await screen.findByLabelText("Codex: 60% of Spend remaining"),
    ).not.toBeNull();
  });
});
