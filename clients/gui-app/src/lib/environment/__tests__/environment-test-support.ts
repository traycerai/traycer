import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import {
  MockHostMessenger,
  type MockHandlerMap,
} from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import type {
  EnvironmentItemStatus,
  EnvironmentPendingUpload,
  EnvironmentStatusResponseV11,
} from "@traycer/protocol/host/environment-schemas";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { hostRpcSchedulingPolicy } from "@/lib/host-rpc-policy/host-method-policy-table";

/**
 * Fixtures shared by the environment suites (grant, stale write, Personal
 * pages). The host is a real `HostClient` over an in-memory messenger, so a
 * suite exercises the same request path the app does and fakes only the host
 * on the far side of it.
 */

export function hostEntryFixture(hostId: string): HostDirectoryEntry {
  return {
    hostId,
    label: hostId,
    kind: "local",
    websocketUrl: "ws://127.0.0.1:0",
    version: "1.5.0",
    transportDialability: "dialable",
  };
}

export interface EnvironmentClientFixture {
  /** The unpinned spine: `getActiveHostId()` is `null`. */
  readonly spine: HostClient<HostRpcRegistry>;
  /** A requester pinned to `hostId`. */
  readonly client: HostClient<HostRpcRegistry>;
}

export function buildEnvironmentClient(options: {
  readonly hostId: string;
  readonly handlers: MockHandlerMap<HostRpcRegistry>;
}): EnvironmentClientFixture {
  const entry = hostEntryFixture(options.hostId);
  const spine = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: { invalidateHostScope: () => undefined },
    schedulingPolicy: hostRpcSchedulingPolicy,
    findHostById: (hostId) => (hostId === entry.hostId ? entry : null),
    messenger: new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => `req-${options.hostId}`,
      handlers: options.handlers,
    }),
  });
  spine.setRequestContext(
    createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
  );
  return { spine, client: spine.createRequester(entry) };
}

export function itemStatusFixture(
  overrides: Partial<EnvironmentItemStatus> & {
    readonly kind: EnvironmentItemStatus["kind"];
    readonly key: string;
  },
): EnvironmentItemStatus {
  return {
    os: "any",
    desiredRevision: 1,
    status: "applied",
    code: "ok",
    args: { exitStatus: null, stage: null, durationMs: null, kind: null },
    brokerEnforced: null,
    minimumHostVersion: null,
    appliedAs: null,
    ...overrides,
  };
}

export function pendingUploadFixture(
  overrides: Partial<EnvironmentPendingUpload> & {
    readonly kind: EnvironmentPendingUpload["kind"];
    readonly key: string;
  },
): EnvironmentPendingUpload {
  return {
    uploadId: `upload-${overrides.key}`,
    os: "any",
    queuedAt: 1,
    receipt: "pending",
    code: null,
    ...overrides,
  };
}

export function environmentStatusFixture(
  overrides: Partial<EnvironmentStatusResponseV11>,
): EnvironmentStatusResponseV11 {
  return {
    consent: null,
    planes: { records: "moved", broker: "moved", room: "moved" },
    returnedFromTeam: null,
    stoppedAt: null,
    principal: { kind: "personal" },
    reachability: "connected",
    bindingGeneration: 1,
    desiredRevision: 1,
    receivedRevision: 1,
    appliedRevision: 1,
    receiptAgeMs: 0,
    items: [],
    pendingUploads: [],
    setup: null,
    remoteAccess: "off",
    ...overrides,
  };
}
