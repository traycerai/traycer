import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import type { IRunnerHost } from "@traycer-clients/shared/platform/runner-host";
import type {
  EnvironmentNotice,
  EnvironmentReviewEntry,
  EnvironmentStatusResponse,
  EnvironmentWriteOutcome,
  HostRemoteAccessSetResponse,
  LocalOverride,
} from "@traycer/protocol/host/environment-schemas";
import type { ConfigEnvEntry } from "@traycer/protocol/host/config/schemas";
import type { ProviderCliState } from "@traycer/protocol/host/provider-schemas";
import {
  buildEnvironmentClient,
  environmentStatusFixture,
} from "@/lib/environment/__tests__/environment-test-support";
import type { HostRpcRegistry } from "@/lib/host";

/**
 * A fake host for the Access and setup tab and the Personal page notices. The
 * client is a real `HostClient` over an in-memory messenger; this is the host
 * on the far side. Every answer is read from `state` when the request lands,
 * so a test changes what the host says by changing `state` and re-reading.
 * Writes are recorded in `requests`, in the order the host received them.
 */

export const ACCESS_HOST_ID = "host-a";
export const ACCESS_HOST_NAME = "dev-box";

/** The methods a current host advertises in its handshake. */
export const ACCESS_METHODS: readonly string[] = [
  "environment.status",
  "environment.notices",
  "environment.review",
  "environment.undo",
  "environment.localOverrides",
  "environment.setup.retry",
  "config.env.localOverride.set",
  "config.env.localOverride.clear",
  "config.env.list",
  "host.remoteAccess.set",
  "providers.list",
  "providers.setProfileEnabled",
];

export interface AccessHostState {
  status: EnvironmentStatusResponse;
  /** The host cannot answer `environment.status` (it is down). */
  failStatus: boolean;
  notices: EnvironmentNotice[];
  review: EnvironmentReviewEntry[];
  overrides: LocalOverride[];
  providers: ProviderCliState[];
  envEntries: ConfigEnvEntry[];
  /** What `host.remoteAccess.set` answers. */
  remoteAccessAnswer: HostRemoteAccessSetResponse;
  /** What `environment.undo` answers. */
  undoAnswer: EnvironmentWriteOutcome;
  /** `config.env.localOverride.set` answers `needs_grant` instead of saving. */
  localOverrideNeedsGrant: boolean;
}

export interface RecordedRequest {
  readonly method: string;
  readonly params: unknown;
}

export interface AccessHostReads {
  status: number;
  notices: number;
  review: number;
}

export interface AccessHost {
  readonly state: AccessHostState;
  /** How many times the host was asked for each read. */
  readonly reads: AccessHostReads;
  /** Every recorded write, in arrival order. */
  readonly requests: RecordedRequest[];
  readonly client: HostClient<HostRpcRegistry>;
  /** The params of every recorded request to `method`. */
  paramsOf(method: string): unknown[];
}

export function accessHostState(
  overrides: Partial<AccessHostState>,
): AccessHostState {
  return {
    status: environmentStatusFixture({}),
    failStatus: false,
    notices: [],
    review: [],
    overrides: [],
    providers: [],
    envEntries: [],
    remoteAccessAnswer: { state: "on" },
    undoAnswer: { outcome: "saved", revision: 2 },
    localOverrideNeedsGrant: false,
    ...overrides,
  };
}

export function buildAccessHost(
  overrides: Partial<AccessHostState>,
): AccessHost {
  return buildAccessHostOn(ACCESS_HOST_ID, overrides);
}

/** The same fake host, addressed by another host id. */
export function buildAccessHostOn(
  hostId: string,
  overrides: Partial<AccessHostState>,
): AccessHost {
  const state = accessHostState(overrides);
  const requests: RecordedRequest[] = [];
  const reads: AccessHostReads = { status: 0, notices: 0, review: 0 };
  const { client } = buildEnvironmentClient({
    hostId,
    handlers: {
      "environment.status": () => {
        reads.status += 1;
        if (state.failStatus) throw new Error("the host is down");
        return state.status;
      },
      "environment.notices": () => {
        reads.notices += 1;
        return { notices: [...state.notices] };
      },
      "environment.review": () => {
        reads.review += 1;
        return { entries: [...state.review] };
      },
      "environment.localOverrides": () => ({ overrides: [...state.overrides] }),
      "providers.list": () => ({
        providers: [...state.providers],
        native: null,
      }),
      "config.env.list": () => ({ entries: [...state.envEntries] }),
      "host.remoteAccess.set": (request) => {
        requests.push({ method: "host.remoteAccess.set", params: request });
        return state.remoteAccessAnswer;
      },
      "environment.setup.retry": (request) => {
        requests.push({ method: "environment.setup.retry", params: request });
        return { attemptId: "attempt-1" };
      },
      "environment.undo": (request) => {
        requests.push({ method: "environment.undo", params: request });
        return state.undoAnswer;
      },
      "config.env.localOverride.set": (request) => {
        requests.push({
          method: "config.env.localOverride.set",
          params: request,
        });
        if (state.localOverrideNeedsGrant) return { outcome: "needs_grant" };
        return { outcome: "saved", overrides: [...state.overrides] };
      },
      "config.env.localOverride.clear": (request) => {
        requests.push({
          method: "config.env.localOverride.clear",
          params: request,
        });
        return { outcome: "saved", overrides: [] };
      },
      "providers.setProfileEnabled": (request) => {
        requests.push({
          method: "providers.setProfileEnabled",
          params: request,
        });
        return { profileId: request.profileId, enabled: request.enabled };
      },
    },
  });
  return {
    state,
    reads,
    requests,
    client,
    paramsOf: (method) =>
      requests
        .filter((request) => request.method === method)
        .map((request) => request.params),
  };
}

export function noticeFixture(
  overrides: Partial<EnvironmentNotice>,
): EnvironmentNotice {
  return {
    noticeId: "notice-1",
    kind: "variable",
    key: "LOG_LEVEL",
    os: "any",
    source: "offline",
    from: { kind: "host", hostId: ACCESS_HOST_ID, hostLabel: ACCESS_HOST_NAME },
    writtenAt: 1,
    undoAvailable: true,
    ...overrides,
  };
}

export function reviewEntryFixture(
  overrides: Partial<EnvironmentReviewEntry>,
): EnvironmentReviewEntry {
  return {
    entryId: "entry-1",
    reason: "credential_like_value",
    kind: "variable",
    key: "DATABASE_URL",
    os: "any",
    hostId: null,
    heldAt: 1,
    ...overrides,
  };
}

/** The sign-in origin the dashboard links resolve against. */
export const DASHBOARD_ORIGIN = "https://example.invalid";

/** A shell with a sign-in origin, which is what the dashboard links need. */
export function dashboardRunnerHost(): IRunnerHost {
  return new MockRunnerHost({
    signInUrl: `${DASHBOARD_ORIGIN}/signin`,
    authnBaseUrl: DASHBOARD_ORIGIN,
    localHost: null,
    hosts: [],
    workspaceFolderPickerPaths: undefined,
    hasLocalHost: undefined,
    traycerCli: undefined,
  });
}
