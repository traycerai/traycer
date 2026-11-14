import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import type { IRunnerHost } from "@traycer-clients/shared/platform/runner-host";
import type {
  EnvironmentCloud,
  EnvironmentTransportRequest,
} from "@traycer-clients/shared/environment/environment-cloud";
import type {
  EnvironmentNotice,
  EnvironmentReviewEntry,
  EnvironmentStatusResponseV12,
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
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type {
  EnvironmentDescriptorV11,
  EnvironmentHostBinding,
  EnvironmentListResponseV11,
} from "@traycer/protocol/host/environment/contracts";

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
  "host.status.refresh",
  "environment.host.read",
  "environment.list",
  "providers.list",
  "providers.setProfileEnabled",
];

export interface AccessHostState {
  status: EnvironmentStatusResponseV12;
  /** The host cannot answer `environment.status` (it is down). */
  failStatus: boolean;
  notices: EnvironmentNotice[];
  review: EnvironmentReviewEntry[];
  overrides: LocalOverride[];
  providers: ProviderCliState[];
  envEntries: ConfigEnvEntry[];
  /** What `host.remoteAccess.set` answers. */
  remoteAccessAnswer: HostRemoteAccessSetResponse;
  remoteAccessError: HostRpcError | null;
  /** What `host.status.refresh` answers. */
  statusRefreshError: Error | null;
  binding: EnvironmentHostBinding | null;
  environments: EnvironmentDescriptorV11[];
  failEnvironmentList: boolean;
  environmentListRead: Promise<EnvironmentListResponseV11> | null;
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
  environments: number;
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
    remoteAccessError: null,
    statusRefreshError: null,
    binding: null,
    environments: [],
    failEnvironmentList: false,
    environmentListRead: null,
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
  const reads: AccessHostReads = {
    status: 0,
    notices: 0,
    review: 0,
    environments: 0,
  };
  const { client } = buildEnvironmentClient({
    hostId,
    handlers: {
      "environment.host.read": () => {
        if (state.binding === null) throw new Error("Binding unavailable");
        return { ...state.binding, sharingGeneration: null };
      },
      "environment.list": () => {
        reads.environments += 1;
        if (state.failEnvironmentList)
          throw new Error("Environment list unavailable");
        if (state.environmentListRead !== null)
          return state.environmentListRead;
        return { environments: state.environments };
      },
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
        return {
          // A row a test built as `@1.2` keeps its facts.
          entries: state.review.map((entry) => ({
            command: null,
            event: null,
            description: null,
            harness: null,
            value: null,
            ...entry,
          })),
          shownAt: null,
          acknowledgedAt: null,
          evidence: { version: null, at: null },
        };
      },
      "environment.localOverrides": () => ({ overrides: [...state.overrides] }),
      "providers.list": () => ({
        providers: [...state.providers],
        native: null,
      }),
      "config.env.list": () => ({ entries: [...state.envEntries] }),
      "host.remoteAccess.set": (request) => {
        requests.push({ method: "host.remoteAccess.set", params: request });
        if (state.remoteAccessError !== null) throw state.remoteAccessError;
        return state.remoteAccessAnswer;
      },
      "host.status.refresh": (request) => {
        requests.push({ method: "host.status.refresh", params: request });
        if (state.statusRefreshError !== null) throw state.statusRefreshError;
        return {};
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
    reason: "executable_entry",
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

/** An authn transport fake that records the request without changing its path. */
export function fakeEnvironmentCloud(answer: {
  readonly status: number;
  readonly body: unknown;
}): {
  readonly cloud: EnvironmentCloud;
  readonly requests: EnvironmentTransportRequest[];
} {
  const requests: EnvironmentTransportRequest[] = [];
  return {
    cloud: {
      authnBaseUrl: "https://authn.test",
      bearer: { kind: "cloud", getBearerToken: () => "test-bearer" },
      onOriginSignIn: () => true,
      transport: (request) => {
        requests.push(request);
        return Promise.resolve({
          status: answer.status,
          text: JSON.stringify(answer.body),
        });
      },
    },
    requests,
  };
}

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
