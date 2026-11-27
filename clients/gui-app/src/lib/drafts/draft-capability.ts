import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostRequestDispatchOptions } from "@traycer-clients/shared/host-client/host-client";

const releasedDraftDispatchOptions = {
  idempotencyKey: null,
  responseTimeoutMs: null,
  requiredHostMethodVersion: null,
  signal: undefined,
} satisfies HostRequestDispatchOptions;

export const RELEASED_DRAFT_LIST_AND_UPSERT_OPTIONS = {
  ...releasedDraftDispatchOptions,
  callerVersion: { major: 2, minor: 0 },
  fallbackWireVersions: [{ major: 1, minor: 0 }],
} as const;

export const RELEASED_DRAFT_DELETE_AND_RETRACT_OPTIONS = {
  ...releasedDraftDispatchOptions,
  callerVersion: { major: 1, minor: 0 },
  fallbackWireVersions: [],
} as const;

export function isDraftsCapabilityMissing(error: unknown): boolean {
  return error instanceof HostRpcError && error.code === "E_HOST_UNSUPPORTED";
}
