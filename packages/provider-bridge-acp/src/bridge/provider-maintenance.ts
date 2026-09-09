import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import type {
  ProviderHealthResult,
  ProviderInstallationRunResult,
  ProviderInstallationStatus,
  ProviderUsage,
  ProviderUsageResult,
  ProviderUsageWindow,
} from "@bb/provider-bridge-protocol";
import {
  clampPercent,
  downloadedInstallerCommand,
  readCliVersion,
  resolveExecutablePath,
} from "@bb/provider-bridge-protocol/bridge-kit";
import { z } from "zod";

const execFileAsync = promisify(execFile);
const USAGE_FETCH_TIMEOUT_MS = 15_000;
const CURSOR_DASHBOARD_URL =
  "https://api2.cursor.sh/aiserver.v1.DashboardService";
const CURSOR_KEYCHAIN_ACCOUNT = "cursor-user";
const CURSOR_ACCESS_TOKEN_SERVICE = "cursor-access-token";
const CURSOR_INSTALL_SCRIPT_URL = "https://cursor.com/install";

const KIRO_LOGIN_COMMAND = "kiro-cli login";
const KIRO_INSTALL_URL = "https://kiro.dev";
const KIRO_DEFAULT_REGION = "us-east-1";
const KIRO_USAGE_TARGET = "AmazonCodeWhispererService.GetUsageLimits";
const KIRO_TOKEN_KEY = "kirocli:odic:token";
const KIRO_PROFILE_STATE_KEY = "api.codewhisperer.profile";

function cursorAuthFilePath(): string {
  if (process.platform === "win32") {
    const appData =
      process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming");
    return path.join(appData, "Cursor", "auth.json");
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), ".cursor", "auth.json");
  }
  const configHome =
    process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config");
  return path.join(configHome, "cursor", "auth.json");
}

async function readKeychainAccessToken(): Promise<string | null> {
  if (process.platform !== "darwin") return null;
  try {
    const { stdout } = await execFileAsync(
      "security",
      [
        "find-generic-password",
        "-s",
        CURSOR_ACCESS_TOKEN_SERVICE,
        "-a",
        CURSOR_KEYCHAIN_ACCOUNT,
        "-w",
      ],
      { timeout: 10_000 },
    );
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

const cursorFileCredentialsSchema = z.object({
  accessToken: z.string().min(1).nullish(),
});

async function readAccessToken(): Promise<string | null> {
  const keychain = await readKeychainAccessToken();
  if (keychain) return keychain;
  try {
    const parsed = cursorFileCredentialsSchema.safeParse(
      JSON.parse(await fs.readFile(cursorAuthFilePath(), "utf8")),
    );
    return parsed.success ? (parsed.data.accessToken ?? null) : null;
  } catch {
    return null;
  }
}

function cursorStateDatabasePath(): string {
  if (process.platform === "win32") {
    const appData =
      process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming");
    return path.join(appData, "Cursor", "User", "globalStorage", "state.vscdb");
  }
  if (process.platform === "darwin") {
    return path.join(
      os.homedir(),
      "Library",
      "Application Support",
      "Cursor",
      "User",
      "globalStorage",
      "state.vscdb",
    );
  }
  const configHome =
    process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config");
  return path.join(
    configHome,
    "Cursor",
    "User",
    "globalStorage",
    "state.vscdb",
  );
}

function readAccountEmail(): string | null {
  const databasePath = cursorStateDatabasePath();
  if (!existsSync(databasePath)) return null;
  let database: DatabaseSync | null = null;
  try {
    database = new DatabaseSync(databasePath);
    database.exec("PRAGMA query_only = true");
    const row = database
      .prepare("SELECT value FROM ItemTable WHERE key = ?")
      .get("cursorAuth/cachedEmail");
    const parsed = z.object({ value: z.string().email() }).safeParse(row);
    return parsed.success ? parsed.data.value : null;
  } catch {
    return null;
  } finally {
    database?.close();
  }
}

export interface AcpMaintenanceDialect {
  loginCommand: string;
  installer(): { command: string; args: string[]; displayCommand: string };
  readAccount(): Promise<{ email: string | null } | null>;
  readUsage(): Promise<ProviderUsageResult>;
}

function healthResult(args: {
  maintenance: AcpMaintenanceDialect | undefined;
  status: "ready" | "not_installed" | "unauthenticated" | "unknown";
  accountEmail?: string | null;
  installedVersion?: string | null;
  statusMessage?: string | null;
}): ProviderHealthResult {
  const maintained = args.maintenance !== undefined;
  return {
    supported: true,
    health: {
      status: args.status,
      statusMessage: args.statusMessage ?? null,
      accountEmail: args.accountEmail ?? null,
      planLabel: null,
      installedVersion: args.installedVersion ?? null,
      minimumSupportedVersion: null,
      canInstall: maintained,
      canUpdate: maintained && args.status !== "not_installed",
      loginCommand: args.maintenance?.loginCommand ?? null,
    },
  };
}

export async function getAcpProviderHealth(args: {
  maintenance: AcpMaintenanceDialect | undefined;
  command: string | null;
}): Promise<ProviderHealthResult> {
  const maintenance = args.maintenance;
  if (args.command === null) {
    return healthResult({
      maintenance,
      status: "unknown",
      statusMessage: "The ACP provider has no launch command.",
    });
  }
  if ((await resolveExecutablePath(args.command)) === null) {
    return healthResult({ maintenance, status: "not_installed" });
  }
  const version = await readCliVersion(args.command);
  if (maintenance === undefined) {
    return healthResult({
      maintenance,
      status: "ready",
      installedVersion: version,
    });
  }
  try {
    const account = await maintenance.readAccount();
    return healthResult({
      maintenance,
      status: account === null ? "unauthenticated" : "ready",
      accountEmail: account?.email ?? null,
      installedVersion: version,
    });
  } catch (error) {
    return healthResult({
      maintenance,
      status: "unknown",
      installedVersion: version,
      statusMessage: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function getAcpProviderInstallationStatus(args: {
  maintenance: AcpMaintenanceDialect | undefined;
  command: string | null;
}): Promise<ProviderInstallationStatus> {
  const executableName = args.command ?? "";
  const resolvedExecutable =
    args.command === null ? null : await resolveExecutablePath(args.command);
  const installed = resolvedExecutable !== null;
  const currentVersion =
    installed && args.command !== null
      ? await readCliVersion(args.command)
      : null;
  const installAction =
    args.maintenance !== undefined && !installed
      ? {
          kind: "install" as const,
          label: "Install" as const,
          command: args.maintenance.installer().displayCommand,
        }
      : null;
  return {
    executableName,
    executablePath: resolvedExecutable,
    installed,
    installSource: installed ? "external" : "notInstalled",
    currentVersion,
    latestVersion: null,
    minimumSupportedVersion: null,
    npmPackageName: null,
    npmGlobalPackageVersion: null,
    installAction,
    needsUpdate: false,
    versionUnsupported: false,
  };
}

export async function getAcpProviderInstallationRun(args: {
  maintenance: AcpMaintenanceDialect | undefined;
  command: string | null;
  action: "install" | "update";
}): Promise<ProviderInstallationRunResult> {
  const status = await getAcpProviderInstallationStatus(args);
  return buildAcpProviderInstallationRun(status, args);
}

function buildAcpProviderInstallationRun(
  status: ProviderInstallationStatus,
  args: {
    maintenance: AcpMaintenanceDialect | undefined;
    command: string | null;
    action: "install" | "update";
  },
): ProviderInstallationRunResult {
  if (
    status.installAction?.kind !== args.action ||
    args.maintenance === undefined
  ) {
    return {
      available: false,
      message: `${args.command ?? "This ACP agent"} ${args.action} is not available on this host.`,
    };
  }
  return {
    available: true,
    command: args.maintenance.installer(),
    verification: { kind: "installed" },
  };
}

const cursorNonNegativeIntegerSchema = z
  .union([
    z.number().int().nonnegative(),
    z.string().regex(/^\d+$/u).transform(Number),
  ])
  .refine(Number.isSafeInteger);

const cursorUsageResponseSchema = z
  .object({
    billingCycleEnd: cursorNonNegativeIntegerSchema.nullish(),
    planUsage: z
      .object({ totalPercentUsed: z.number().nonnegative().default(0) })
      .nullish(),
    spendLimitUsage: z
      .object({
        overallLimit: cursorNonNegativeIntegerSchema.nullish(),
        overallUsed: cursorNonNegativeIntegerSchema.nullish(),
        individualLimit: cursorNonNegativeIntegerSchema.nullish(),
        individualUsed: cursorNonNegativeIntegerSchema.nullish(),
        pooledLimit: cursorNonNegativeIntegerSchema.nullish(),
        pooledUsed: cursorNonNegativeIntegerSchema.nullish(),
      })
      .nullish(),
  })
  .passthrough();

const cursorPlanResponseSchema = z
  .object({
    planInfo: z.object({ planName: z.string().min(1) }).nullish(),
  })
  .passthrough();

function normalizeUsage(
  rawUsage: unknown,
  rawPlan: unknown,
  accountEmail: string | null = null,
): ProviderUsage {
  const usage = cursorUsageResponseSchema.safeParse(rawUsage);
  if (!usage.success) {
    return {
      status: "error",
      message: "Cursor usage response was malformed.",
      planLabel: null,
      accountEmail,
    };
  }
  const plan = cursorPlanResponseSchema.safeParse(rawPlan);
  const resetsAt =
    usage.data.billingCycleEnd == null
      ? null
      : new Date(usage.data.billingCycleEnd).toISOString();
  const windows: ProviderUsageWindow[] = [];
  if (usage.data.planUsage?.totalPercentUsed != null) {
    windows.push({
      label: "Plan usage",
      usedPercent: clampPercent(usage.data.planUsage.totalPercentUsed),
      resetsAt,
    });
  }
  const spend = usage.data.spendLimitUsage;
  const pair =
    spend?.overallLimit != null
      ? { limit: spend.overallLimit, used: spend.overallUsed ?? 0 }
      : spend?.individualLimit != null
        ? { limit: spend.individualLimit, used: spend.individualUsed ?? 0 }
        : spend?.pooledLimit != null
          ? { limit: spend.pooledLimit, used: spend.pooledUsed ?? 0 }
          : null;
  if (pair && pair.limit > 0) {
    windows.push({
      label: "On-demand spend",
      usedPercent: clampPercent((pair.used / pair.limit) * 100),
      resetsAt,
      cost: { usedUsdCents: pair.used, limitUsdCents: pair.limit },
    });
  }
  return {
    status: "ok",
    accountEmail,
    planLabel: plan.success ? (plan.data.planInfo?.planName ?? null) : null,
    windows,
  };
}

function fetchDashboard(
  method: string,
  accessToken: string,
): Promise<Response> {
  return fetch(`${CURSOR_DASHBOARD_URL}/${method}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
      "Content-Type": "application/json",
      "Connect-Protocol-Version": "1",
      "x-cursor-client-type": "cli",
      "x-cursor-client-version": "cli-bb-provider-acp",
    },
    body: "{}",
    signal: AbortSignal.timeout(USAGE_FETCH_TIMEOUT_MS),
  });
}

export async function getAcpProviderUsage(args: {
  maintenance: AcpMaintenanceDialect | undefined;
  command: string | null;
}): Promise<ProviderUsageResult> {
  if (args.maintenance === undefined) return { supported: false };
  if (
    args.command === null ||
    (await resolveExecutablePath(args.command)) === null
  ) {
    return { supported: true, usage: { status: "not_installed" } };
  }
  return args.maintenance.readUsage();
}

export const CURSOR_ACP_MAINTENANCE: AcpMaintenanceDialect = {
  loginCommand: "cursor-agent login",
  installer: () => downloadedInstallerCommand(CURSOR_INSTALL_SCRIPT_URL),
  readAccount: async () => {
    const accessToken = await readAccessToken();
    return accessToken === null ? null : { email: readAccountEmail() };
  },
  readUsage: readCursorUsage,
};

async function readCursorUsage(): Promise<ProviderUsageResult> {
  const accessToken = await readAccessToken();
  if (!accessToken) {
    return { supported: true, usage: { status: "unauthenticated" } };
  }
  try {
    const [usageResponse, planResponse] = await Promise.all([
      fetchDashboard("GetCurrentPeriodUsage", accessToken),
      fetchDashboard("GetPlanInfo", accessToken),
    ]);
    if (usageResponse.status === 401 || planResponse.status === 401) {
      return { supported: true, usage: { status: "expired" } };
    }
    if (!usageResponse.ok) {
      return {
        supported: true,
        usage: {
          status: "error",
          message: `Cursor usage request failed (HTTP ${usageResponse.status}).`,
          planLabel: null,
          accountEmail: readAccountEmail(),
        },
      };
    }
    return {
      supported: true,
      usage: normalizeUsage(
        await usageResponse.json(),
        planResponse.ok ? await planResponse.json() : {},
        readAccountEmail(),
      ),
    };
  } catch (error) {
    return {
      supported: true,
      usage: {
        status: "error",
        message: error instanceof Error ? error.message : String(error),
        planLabel: null,
        accountEmail: readAccountEmail(),
      },
    };
  }
}

function kiroDatabasePath(): string {
  if (process.platform === "win32") {
    const appData =
      process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming");
    return path.join(appData, "kiro-cli", "data.sqlite3");
  }
  if (process.platform === "darwin") {
    return path.join(
      os.homedir(),
      "Library",
      "Application Support",
      "kiro-cli",
      "data.sqlite3",
    );
  }
  const dataHome =
    process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share");
  return path.join(dataHome, "kiro-cli", "data.sqlite3");
}

const kiroTokenSchema = z
  .object({ access_token: z.string().min(1) })
  .passthrough();
const kiroProfileStateSchema = z
  .object({
    arn: z.string().min(1),
    profile_name: z.string().min(1).nullish(),
  })
  .passthrough();

interface KiroCredentials {
  accessToken: string;
  profileArn: string | null;
  region: string;
}

function decodeKiroStateValue(value: unknown): unknown {
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
  if (value instanceof Uint8Array) {
    try {
      return JSON.parse(Buffer.from(value).toString("utf8"));
    } catch {
      return null;
    }
  }
  return value;
}

const VALID_KIRO_REGIONS = new Set([
  "us-east-1",
  "eu-central-1",
  "us-gov-east-1",
  "us-gov-west-1",
]);

function extractRegionFromArn(arn: string | null): string | null {
  if (arn === null) return null;
  const match = /^arn:aws:[^:]+:([^:]+):/u.exec(arn);
  return match?.[1] ?? null;
}

function readKiroCredentials(): KiroCredentials | null {
  const databasePath = kiroDatabasePath();
  if (!existsSync(databasePath)) return null;
  let database: DatabaseSync | null = null;
  try {
    database = new DatabaseSync(databasePath);
    database.exec("PRAGMA query_only = true");
    const tokenRow = database
      .prepare("SELECT value FROM auth_kv WHERE key = ?")
      .get(KIRO_TOKEN_KEY);
    const tokenValue =
      tokenRow === undefined
        ? null
        : decodeKiroStateValue(Reflect.get(tokenRow, "value"));
    const token = kiroTokenSchema.safeParse(tokenValue);
    if (!token.success) return null;

    const profileRow = database
      .prepare("SELECT value FROM state WHERE key = ?")
      .get(KIRO_PROFILE_STATE_KEY);
    const profile = kiroProfileStateSchema.safeParse(
      profileRow === undefined
        ? null
        : decodeKiroStateValue(Reflect.get(profileRow, "value")),
    );

    const profileArn = profile.success ? profile.data.arn : null;
    const arnRegion = extractRegionFromArn(profileArn);
    const region =
      arnRegion !== null && VALID_KIRO_REGIONS.has(arnRegion)
        ? arnRegion
        : KIRO_DEFAULT_REGION;

    return {
      accessToken: token.data.access_token,
      profileArn,
      region,
    };
  } catch {
    return null;
  } finally {
    database?.close();
  }
}

const kiroUsageBreakdownSchema = z
  .object({
    resourceType: z.string().min(1).nullish(),
    displayName: z.string().min(1).nullish(),
    displayNamePlural: z.string().min(1).nullish(),
    currentUsageWithPrecision: z.number().nonnegative().nullish(),
    currentUsage: z.number().nonnegative().nullish(),
    usageLimitWithPrecision: z.number().nonnegative().nullish(),
    usageLimit: z.number().nonnegative().nullish(),
    nextDateReset: z.number().nonnegative().nullish(),
  })
  .passthrough();

const kiroUsageResponseSchema = z
  .object({
    nextDateReset: z.number().nonnegative().nullish(),
    subscriptionInfo: z
      .object({ subscriptionTitle: z.string().min(1).nullish() })
      .passthrough()
      .nullish(),
    usageBreakdownList: z.array(kiroUsageBreakdownSchema).default([]),
  })
  .passthrough();

function epochSecondsToIso(seconds: number | null | undefined): string | null {
  if (seconds == null || !Number.isFinite(seconds) || seconds <= 0) {
    return null;
  }
  const date = new Date(seconds * 1_000);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function normalizeKiroUsage(raw: unknown): ProviderUsage {
  const parsed = kiroUsageResponseSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      status: "error",
      message: "Kiro usage response was malformed.",
      planLabel: null,
      accountEmail: null,
    };
  }
  const planLabel = parsed.data.subscriptionInfo?.subscriptionTitle ?? null;
  const windows: ProviderUsageWindow[] = [];
  for (const breakdown of parsed.data.usageBreakdownList) {
    const limit = breakdown.usageLimitWithPrecision ?? breakdown.usageLimit;
    const used =
      breakdown.currentUsageWithPrecision ?? breakdown.currentUsage ?? 0;
    if (limit == null || limit <= 0) continue;
    const label =
      breakdown.displayNamePlural ??
      breakdown.displayName ??
      breakdown.resourceType ??
      "Usage";
    windows.push({
      label,
      usedPercent: clampPercent((used / limit) * 100),
      resetsAt:
        epochSecondsToIso(breakdown.nextDateReset) ??
        epochSecondsToIso(parsed.data.nextDateReset),
    });
  }
  return {
    status: "ok",
    accountEmail: null,
    planLabel,
    windows,
  };
}

async function fetchKiroUsageLimits(
  credentials: KiroCredentials,
): Promise<Response> {
  const body: Record<string, string> = { resourceType: "AGENTIC_REQUEST" };
  if (credentials.profileArn !== null) {
    body.profileArn = credentials.profileArn;
  }
  return fetch(`https://management.${credentials.region}.kiro.dev/`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${credentials.accessToken}`,
      Accept: "application/json",
      "Content-Type": "application/x-amz-json-1.0",
      "X-Amz-Target": KIRO_USAGE_TARGET,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(USAGE_FETCH_TIMEOUT_MS),
  });
}

async function readKiroUsage(): Promise<ProviderUsageResult> {
  const credentials = readKiroCredentials();
  if (credentials === null) {
    return { supported: true, usage: { status: "unauthenticated" } };
  }
  try {
    const response = await fetchKiroUsageLimits(credentials);
    if (response.status === 401 || response.status === 403) {
      return { supported: true, usage: { status: "expired" } };
    }
    if (!response.ok) {
      return {
        supported: true,
        usage: {
          status: "error",
          message: `Kiro usage request failed (HTTP ${response.status}).`,
          planLabel: null,
          accountEmail: null,
        },
      };
    }
    return {
      supported: true,
      usage: normalizeKiroUsage(await response.json()),
    };
  } catch (error) {
    const cause =
      error instanceof Error && error.cause !== undefined
        ? error.cause instanceof Error
          ? error.cause.message
          : String(error.cause)
        : null;
    const message =
      cause !== null
        ? `${error instanceof Error ? error.message : String(error)}: ${cause}`
        : error instanceof Error
          ? error.message
          : String(error);
    return {
      supported: true,
      usage: {
        status: "error",
        message,
        planLabel: null,
        accountEmail: null,
      },
    };
  }
}

export const KIRO_ACP_MAINTENANCE: AcpMaintenanceDialect = {
  loginCommand: KIRO_LOGIN_COMMAND,
  installer: () => downloadedInstallerCommand(KIRO_INSTALL_URL),
  readAccount: async () => {
    const credentials = readKiroCredentials();
    return credentials === null ? null : { email: null };
  },
  readUsage: readKiroUsage,
};

export const __testing = {
  buildProviderInstallationRun: buildAcpProviderInstallationRun,
  normalizeUsage,
  normalizeKiroUsage,
};
