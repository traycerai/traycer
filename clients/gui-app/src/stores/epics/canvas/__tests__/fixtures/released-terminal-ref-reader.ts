import { DEFAULT_TERMINAL_TITLE } from "@/lib/terminals/terminal-title";
import type { DesktopJsonValue } from "@/lib/windows/types";
import {
  providerIdSchema,
  type ProviderId,
} from "@traycer/protocol/host/provider-schemas";
import { readTileInstanceId } from "@/stores/epics/canvas/tile-schema/instance-id";

export interface ReleasedTerminalRef {
  readonly id: string;
  readonly instanceId: string;
  readonly type: "terminal";
  readonly name: string;
  readonly titleSource: "default" | "manual";
  readonly hostId: string;
  readonly cwd: string;
  readonly origin?: "shell" | "provider-login";
  readonly originProviderId?: ProviderId;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Frozen copy of the released HEAD terminal-ref reader. */
export function parseReleasedTerminalRef(
  value: unknown,
): ReleasedTerminalRef | null {
  if (!isRecord(value)) return null;
  if (
    value.type !== "terminal" ||
    typeof value.id !== "string" ||
    typeof value.name !== "string" ||
    typeof value.hostId !== "string" ||
    typeof value.cwd !== "string" ||
    value.cwd.length === 0
  ) {
    return null;
  }
  let titleSource: "default" | "manual";
  if (value.titleSource === "manual" || value.titleSource === "default") {
    titleSource = value.titleSource;
  } else {
    titleSource = value.name === DEFAULT_TERMINAL_TITLE ? "default" : "manual";
  }
  const origin =
    value.origin === "shell" || value.origin === "provider-login"
      ? value.origin
      : undefined;
  const provider = providerIdSchema.safeParse(value.originProviderId);
  return {
    id: value.id,
    instanceId: readTileInstanceId(value.instanceId),
    type: "terminal",
    name: value.name,
    titleSource,
    hostId: value.hostId,
    cwd: value.cwd,
    ...(origin === undefined ? {} : { origin }),
    ...(provider.success ? { originProviderId: provider.data } : {}),
  };
}

/** Frozen copy of the released HEAD terminal-ref writer. */
export function serializeReleasedTerminalRef(
  ref: ReleasedTerminalRef,
): DesktopJsonValue {
  return {
    id: ref.id,
    instanceId: ref.instanceId,
    type: ref.type,
    name: ref.name,
    titleSource: ref.titleSource,
    hostId: ref.hostId,
    cwd: ref.cwd,
    origin: ref.origin ?? null,
    originProviderId: ref.originProviderId ?? null,
  };
}
