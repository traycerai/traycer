import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { HostListItem } from "@traycer/protocol/host/host-status";
import type { SandboxListResponse } from "@traycer/protocol/host/sandbox-control";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { pickableHostOptions } from "@/components/settings/host-scope/host-option-model";
import { useHostOptions } from "@/components/settings/host-scope/use-host-options";

/**
 * A sandbox list whose FIRST read failed leaves every sandbox's control-plane
 * row unread, and the pickers fail closed on that (`hostOptionPickerGroup`),
 * while the directory and the registry both look loaded. It is a failed host
 * list by another name, so `listsFailed` says so and `retryLists` asks for the
 * sandbox list again.
 *
 * Wired through the real `useHostOptions`, with the three list hooks mocked at
 * their boundary, so a regression in the WIRING fails here and not only in the
 * pure predicate (`sandboxSummariesUnread`, covered in
 * `use-host-scope-status.test.ts`).
 */

interface QueryStub<Data> {
  readonly data: Data | undefined;
  readonly isError: boolean;
  readonly refetch: () => void;
}

const SANDBOX_HOST_ID = "sbx-host";

const registryItem: HostListItem = {
  hostId: SANDBOX_HOST_ID,
  displayName: "build-box",
  platform: "linux",
  kind: "sandbox",
  publicKey: "pk",
  createdAt: "2026-01-01T00:00:00Z",
  updatePolicy: "manual",
  status: {
    connectivity: "connectable",
    viewerReachability: "unknown",
    clientCloud: "ok",
    updateState: "current",
    appVersion: "1.5.0",
    lastSeenAt: "2026-01-01T00:00:00Z",
  },
  sandboxState: "awake",
  sandboxFrozen: false,
  profile: "agent",
};

const queries = vi.hoisted<{
  readonly directoryRefetch: Mock;
  readonly registryRefetch: Mock;
  readonly sandboxRefetch: Mock;
  sandboxList: QueryStub<SandboxListResponse> | null;
}>(() => ({
  directoryRefetch: vi.fn(),
  registryRefetch: vi.fn(),
  sandboxRefetch: vi.fn(),
  sandboxList: null,
}));

vi.mock("@/lib/host", () => ({
  useHostBinding: () => null,
}));
vi.mock("@/hooks/host/use-effective-host-id", () => ({
  useEffectiveHostId: () => mockLocalHostEntry.hostId,
}));
vi.mock("@/hooks/host/use-host-directory-list-query", () => ({
  useHostDirectoryList: () => ({
    data: [mockLocalHostEntry],
    isError: false,
    refetch: queries.directoryRefetch,
  }),
}));
vi.mock("@/hooks/auth/use-registered-hosts-query", () => ({
  useRegisteredHosts: () => ({
    data: { hosts: [registryItem] },
    isError: false,
    refetch: queries.registryRefetch,
  }),
}));
vi.mock("@/hooks/sandboxes/use-sandbox-list-query", () => ({
  useSandboxList: () => queries.sandboxList,
}));
vi.mock("@/hooks/host/use-remote-sessions-poll-readiness", () => ({
  useRemoteSessionsPollReadiness: () => () => false,
}));
vi.mock("@/hooks/host/use-host-lease", () => ({
  useHostLeases: () => [],
}));
vi.mock("@/hooks/host/use-selection-authority-attached", () => ({
  useSelectionAuthorityAttached: () => true,
}));
const runnerHost = vi.hoisted<{ current: MockRunnerHost | null }>(() => ({
  current: null,
}));
vi.mock("@/providers/use-runner-host", () => ({
  useRunnerHost: () => runnerHost.current,
}));

function sandboxList(
  data: SandboxListResponse | undefined,
  isError: boolean,
): QueryStub<SandboxListResponse> {
  return { data, isError, refetch: queries.sandboxRefetch };
}

function renderOptions() {
  runnerHost.current = new MockRunnerHost({
    signInUrl: "https://auth.traycer.invalid/sign-in",
    authnBaseUrl: "http://localhost:5005",
    localHost: {
      hostId: mockLocalHostEntry.hostId,
      websocketUrl: "ws://127.0.0.1:4917/rpc",
      version: "0.0.0-mock",
      pid: 1,
      systemHostName: "test-mac",
      displayName: "test-mac",
      availability: "available",
    },
    hosts: [mockLocalHostEntry],
    workspaceFolderPickerPaths: undefined,
    hasLocalHost: undefined,
    traycerCli: undefined,
    hostManagement: null,
  });
  const queryClient = new QueryClient();
  const wrapper = (props: { readonly children: ReactNode }): ReactNode => (
    <QueryClientProvider client={queryClient}>
      {props.children}
    </QueryClientProvider>
  );
  return renderHook(() => useHostOptions(), { wrapper });
}

beforeEach(() => {
  queries.directoryRefetch.mockClear();
  queries.registryRefetch.mockClear();
  queries.sandboxRefetch.mockClear();
});
afterEach(() => {
  cleanup();
  runnerHost.current = null;
});

describe("useHostOptions with a failed sandbox list", () => {
  it("reports the lists failed when the first sandbox read failed, and retryLists asks every list again", () => {
    queries.sandboxList = sandboxList(undefined, true);
    const { result } = renderOptions();

    expect(result.current.listsFailed).toBe(true);
    // The sandbox is listed, but its control-plane row is unread.
    const row = result.current.hosts.find((h) => h.hostId === SANDBOX_HOST_ID);
    expect(row?.sandbox?.summary).toBeNull();

    act(() => {
      result.current.retryLists();
    });

    expect(queries.sandboxRefetch).toHaveBeenCalled();
    expect(queries.directoryRefetch).toHaveBeenCalled();
    expect(queries.registryRefetch).toHaveBeenCalled();
  });

  it("does not report a failure while the first sandbox read is still loading", () => {
    queries.sandboxList = sandboxList(undefined, false);
    const { result } = renderOptions();

    expect(result.current.listsFailed).toBe(false);
  });

  it("does not report a failure when the sandbox list answered without that host's row, which stays out of the pickers", () => {
    queries.sandboxList = sandboxList({ sandboxes: [] }, false);
    const { result } = renderOptions();

    expect(result.current.listsFailed).toBe(false);
    expect(
      pickableHostOptions(result.current.hosts, null).map((h) => h.hostId),
    ).not.toContain(SANDBOX_HOST_ID);
  });

  it("keeps the last good answer through a later failed refetch: no failure to report", () => {
    queries.sandboxList = sandboxList({ sandboxes: [] }, true);
    const { result } = renderOptions();

    expect(result.current.listsFailed).toBe(false);
  });
});
