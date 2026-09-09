import { useMemo } from "react";
import type {
  ProviderUsage,
  ProviderUsageWindow,
} from "@bb/host-daemon-contract";
import { Popover, PopoverContent, PopoverTrigger } from "@bb/shared-ui/popover";
import { cn } from "@bb/shared-ui/lib/utils";
import { useHoverPopover } from "../ui/hooks/use-hover-popover.js";
import { useSystemProviderUsageLimits } from "@/hooks/queries/system-queries";

export interface ProviderQuotaIndicatorProps {
  providerId: string;
  providerLabel: string;
  hostId?: string;
  enabled?: boolean;
  defaultOpen?: boolean;
  className?: string;
}

interface QuotaWindowView {
  label: string;
  usedPercent: number;
  remainingPercent: number;
  reset: string | null;
  costText: string | null;
}

const QUOTA_POPOVER_CLOSE_DELAY_MS = 60;
const QUOTA_PANEL_CLASS_NAME =
  "w-60 rounded-md border bg-popover p-2 text-popover-foreground shadow-md max-md:w-full max-md:rounded-none max-md:border-0 max-md:bg-transparent max-md:px-4 max-md:pt-2 max-md:pb-[max(1rem,env(safe-area-inset-bottom))] max-md:shadow-none";
const RING_RADIUS = 6.5;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

function toneClass(usedPercent: number): string {
  if (usedPercent >= 90) {
    return "text-destructive";
  }
  if (usedPercent >= 75) {
    return "text-warning-text";
  }
  return "text-muted-foreground";
}

function formatReset(resetsAt: string | null): string | null {
  if (!resetsAt) {
    return null;
  }
  const reset = new Date(resetsAt);
  if (Number.isNaN(reset.getTime())) {
    return null;
  }
  const diffMs = reset.getTime() - Date.now();
  if (diffMs <= 0) {
    return "Resetting now";
  }
  const diffMinutes = Math.round(diffMs / 60_000);
  if (diffMinutes < 60) {
    return `Resets in ${diffMinutes} min`;
  }
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) {
    const minutes = diffMinutes % 60;
    return minutes > 0
      ? `Resets in ${diffHours} hr ${minutes} min`
      : `Resets in ${diffHours} hr`;
  }
  const withinWeek = diffMs < 7 * 24 * 60 * 60_000;
  const formatted = reset.toLocaleString(undefined, {
    weekday: withinWeek ? "short" : undefined,
    month: withinWeek ? undefined : "short",
    day: withinWeek ? undefined : "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  return `Resets ${formatted}`;
}

function formatUsdCents(cents: number, alwaysShowCents: boolean): string {
  const hasFractionalDollar = cents % 100 !== 0;
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: alwaysShowCents || hasFractionalDollar ? 2 : 0,
    maximumFractionDigits: 2,
  }).format(cents / 100);
}

function windowCostText(window: ProviderUsageWindow): string | null {
  if (!window.cost) {
    return null;
  }
  return `${formatUsdCents(window.cost.usedUsdCents, true)} / ${formatUsdCents(
    window.cost.limitUsdCents,
    false,
  )}`;
}

function toWindowView(window: ProviderUsageWindow): QuotaWindowView {
  const usedPercent = Math.max(0, Math.min(100, window.usedPercent));
  return {
    label: window.label,
    usedPercent,
    remainingPercent: Math.round(100 - usedPercent),
    reset: formatReset(window.resetsAt),
    costText: windowCostText(window),
  };
}

function readOkWindows(usage: ProviderUsage | undefined): QuotaWindowView[] {
  if (usage === undefined || usage.status !== "ok") {
    return [];
  }
  return usage.windows.map(toWindowView);
}

function statusMessage(
  usage: ProviderUsage,
  providerLabel: string,
): string | null {
  switch (usage.status) {
    case "ok":
      return null;
    case "not_installed":
      return null;
    case "unauthenticated":
      return `Sign in to ${providerLabel} to see usage limits.`;
    case "expired":
      return `Your ${providerLabel} session expired. Sign in again to see usage limits.`;
    case "error":
      return usage.message;
  }
}

function QuotaWindowRow({ window }: { window: QuotaWindowView }) {
  const visualPercent = window.usedPercent;
  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between gap-2 text-xs max-md:text-sm">
        <span className="min-w-0 truncate text-muted-foreground">
          {window.label}
        </span>
        <span
          className={cn(
            "shrink-0 font-medium tabular-nums",
            toneClass(window.usedPercent),
          )}
        >
          {window.costText ?? `${window.remainingPercent}% left`}
        </span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-border max-md:h-2">
        <div
          className={cn("h-full rounded-full bg-current", toneClass(window.usedPercent))}
          style={{ width: `${Math.max(visualPercent, 2)}%` }}
        />
      </div>
      {window.reset ? (
        <p className="text-xs tabular-nums text-muted-foreground max-md:text-sm">
          {window.reset}
        </p>
      ) : null}
    </div>
  );
}

export function ProviderQuotaIndicator({
  providerId,
  providerLabel,
  hostId,
  enabled = true,
  defaultOpen,
  className,
}: ProviderQuotaIndicatorProps) {
  const providerIds = useMemo(() => [providerId], [providerId]);
  const active = enabled && providerId.length > 0;
  const usageQuery = useSystemProviderUsageLimits({
    ...(hostId === undefined ? {} : { hostId }),
    enabled: active,
    providerIds,
  });
  const usage = usageQuery.usage[providerId];
  const windows = useMemo(() => readOkWindows(usage), [usage]);

  const {
    open: hoverOpen,
    triggerHoverProps,
    contentHoverProps,
    handleOpenChange,
  } = useHoverPopover({
    closeDelayMs: QUOTA_POPOVER_CLOSE_DELAY_MS,
    hoverableContent: false,
  });
  const open = (defaultOpen ?? false) || hoverOpen;

  if (!active || usage === undefined) {
    return null;
  }

  if (usage.status !== "ok") {
    const message = statusMessage(usage, providerLabel);
    if (message === null) {
      return null;
    }
    return (
      <Popover open={open} onOpenChange={handleOpenChange}>
        <PopoverTrigger asChild>
          <button
            type="button"
            {...triggerHoverProps}
            data-provider-quota-indicator=""
            data-provider-quota-status={usage.status}
            aria-label={`${providerLabel} usage: ${message}`}
            className={cn(
              "inline-flex shrink-0 cursor-default items-center gap-1 rounded-sm px-1 py-0.5 text-2xs tabular-nums text-muted-foreground transition-colors hover:bg-state-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              className,
            )}
          >
            <svg
              viewBox="0 0 16 16"
              className="size-3.5 shrink-0"
              aria-hidden="true"
            >
              <circle
                cx="8"
                cy="8"
                r={RING_RADIUS}
                fill="none"
                strokeWidth="3"
                strokeDasharray="2 2"
                className="stroke-border-hairline"
              />
            </svg>
          </button>
        </PopoverTrigger>
        <PopoverContent
          side="top"
          align="end"
          sideOffset={8}
          {...contentHoverProps}
          mobileTitle={`${providerLabel} usage`}
          className={QUOTA_PANEL_CLASS_NAME}
        >
          <div className="space-y-1">
            <span className="text-xs font-medium text-popover-foreground max-md:text-sm">
              {providerLabel}
            </span>
            <p className="text-xs text-muted-foreground max-md:text-sm">
              {message}
            </p>
          </div>
        </PopoverContent>
      </Popover>
    );
  }

  if (windows.length === 0) {
    return null;
  }

  const constrainingWindow = windows.reduce((worst, candidate) =>
    candidate.usedPercent > worst.usedPercent ? candidate : worst,
  );
  const visualPercent = constrainingWindow.usedPercent;
  const dashOffset = RING_CIRCUMFERENCE * (1 - visualPercent / 100);
  const summaryLabel = `${providerLabel}: ${constrainingWindow.remainingPercent}% of ${constrainingWindow.label} remaining`;
  const planLabel = usage.planLabel;

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <button
          type="button"
          {...triggerHoverProps}
          data-provider-quota-indicator=""
          aria-label={summaryLabel}
          className={cn(
            "inline-flex shrink-0 cursor-default items-center gap-1 rounded-sm px-1 py-0.5 text-2xs tabular-nums transition-colors hover:bg-state-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            toneClass(visualPercent),
            className,
          )}
        >
          <svg
            viewBox="0 0 16 16"
            className="size-3.5 shrink-0"
            aria-hidden="true"
          >
            <circle
              cx="8"
              cy="8"
              r={RING_RADIUS}
              fill="none"
              strokeWidth="3"
              className="stroke-border-hairline"
            />
            <circle
              cx="8"
              cy="8"
              r={RING_RADIUS}
              fill="none"
              stroke="currentColor"
              strokeWidth="3"
              strokeLinecap="round"
              strokeDasharray={RING_CIRCUMFERENCE}
              strokeDashoffset={dashOffset}
              transform="rotate(-90 8 8)"
            />
          </svg>
          <span aria-hidden="true">{constrainingWindow.remainingPercent}%</span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="end"
        sideOffset={8}
        {...contentHoverProps}
        mobileTitle={`${providerLabel} usage`}
        className={QUOTA_PANEL_CLASS_NAME}
      >
        <div className="space-y-2 max-md:space-y-3">
          <div className="flex items-baseline justify-between gap-2">
            <span className="min-w-0 truncate text-xs font-medium text-popover-foreground max-md:text-sm">
              {providerLabel}
            </span>
            {planLabel ? (
              <span className="shrink-0 text-2xs text-subtle-foreground max-md:text-xs">
                {planLabel}
              </span>
            ) : null}
          </div>
          <div className="space-y-2.5 max-md:space-y-3">
            {windows.map((window) => (
              <QuotaWindowRow key={window.label} window={window} />
            ))}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
