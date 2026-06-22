import { mkdir, readFile, writeFile } from "node:fs/promises";
import { hostname as osHostname } from "node:os";
import { join } from "node:path";
import type { DesktopLocalHostSnapshot } from "../../ipc-contracts/host-types";
import type { HostNameSettings } from "../../ipc-contracts/host-management-types";
import type { HostFsLayout } from "./host-paths";

const HOST_NAME_SETTINGS_FILE = "host-name.json";
const MAX_HOST_NAME_LENGTH = 80;
const FALLBACK_SYSTEM_NAME = "This host";

interface BaseDesktopLocalHostSnapshot {
  readonly hostId: string;
  readonly websocketUrl: string;
  readonly version: string;
  readonly pid: number;
}

function hostNameSettingsPath(layout: HostFsLayout): string {
  return join(layout.rootDir, HOST_NAME_SETTINGS_FILE);
}

function systemHostName(): string {
  const trimmed = osHostname().trim();
  return trimmed.length > 0 ? trimmed : FALLBACK_SYSTEM_NAME;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function normalizeCustomHostName(raw: string | null): string | null {
  if (raw === null) return null;
  const normalized = raw.trim().replace(/\s+/g, " ");
  if (normalized.length === 0) return null;
  if (normalized.length > MAX_HOST_NAME_LENGTH) {
    throw new Error(
      `Host name must be ${MAX_HOST_NAME_LENGTH} characters or fewer`,
    );
  }
  return normalized;
}

async function readCustomHostName(
  layout: HostFsLayout,
): Promise<string | null> {
  let text: string;
  try {
    text = await readFile(hostNameSettingsPath(layout), { encoding: "utf8" });
  } catch {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(text);
    if (!isRecord(parsed)) return null;
    const customName = parsed.customName;
    return typeof customName === "string"
      ? normalizeCustomHostName(customName)
      : null;
  } catch {
    return null;
  }
}

export async function readHostNameSettings(
  layout: HostFsLayout,
): Promise<HostNameSettings> {
  const systemName = systemHostName();
  const customName = await readCustomHostName(layout);
  return {
    systemName,
    customName,
    effectiveName: customName ?? systemName,
  };
}

export async function writeHostNameSettings(
  layout: HostFsLayout,
  customName: string | null,
): Promise<HostNameSettings> {
  const normalized = normalizeCustomHostName(customName);
  await mkdir(layout.rootDir, { recursive: true });
  await writeFile(
    hostNameSettingsPath(layout),
    JSON.stringify({ customName: normalized }, null, 2),
    { encoding: "utf8" },
  );
  return readHostNameSettings(layout);
}

export function withDefaultHostName(
  snapshot: BaseDesktopLocalHostSnapshot,
): DesktopLocalHostSnapshot {
  const systemName = systemHostName();
  return {
    ...snapshot,
    systemHostName: systemName,
    displayName: systemName,
  };
}

export async function withConfiguredHostName(
  layout: HostFsLayout,
  snapshot: DesktopLocalHostSnapshot,
): Promise<DesktopLocalHostSnapshot> {
  const settings = await readHostNameSettings(layout);
  return {
    ...snapshot,
    systemHostName: settings.systemName,
    displayName: settings.effectiveName,
  };
}
