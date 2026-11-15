// The Personal pages read through the window's own host. Mocked at the scope
// boundary, as the other Personal suites do, because they render bare, without
// the host runtime the real scope composes.
const scopeOverrides = vi.hoisted((): { current: Record<string, unknown> } => ({
  current: {},
}));
vi.mock("@/components/settings/host-scope/use-host-scope", async () => {
  const { hostScopeFixture } =
    await import("@/components/settings/host-scope/host-scope-fixture");
  const useHostScope = () => hostScopeFixture(scopeOverrides.current);
  return { useHostScope, usePersonalHostScope: useHostScope };
});

// The page's reads of Personal's id, notices and review sheet are the app's own
// calls to authn, and the grant minter a write carries is read from the host
// binding: the real runtime's binding, with only its `auth` swapped for the
// fake sign-in. The client is a REAL `HostClient` over an in-memory messenger
// (`buildAccessHost`): only the host on the far side is faked.
const hostMock = vi.hoisted((): { auth: AuthService | null } => ({
  auth: null,
}));
const toastErrorMock = vi.hoisted(() => vi.fn());
vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: toastErrorMock,
    info: vi.fn(),
    message: vi.fn(),
  },
}));
vi.mock("@/lib/host", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/host")>();
  return {
    ...actual,
    useHostBinding: () => {
      const real = actual.useHostBinding();
      return real === null || hostMock.auth === null
        ? real
        : { ...real, auth: hostMock.auth };
    },
  };
});

// Where the Review button asks Settings to go.
const navigateToSettingsSectionMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/settings-navigation", () => ({
  navigateToSettingsSection: navigateToSettingsSectionMock,
}));

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useRetrospectiveSheetStore } from "@/stores/settings/retrospective-sheet-store";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import type { IRunnerHost } from "@traycer-clients/shared/platform/runner-host";
import {
  recordNegotiatedHostMethods,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import type {
  EnvironmentReviewEntry,
  EnvironmentReviewEntryV12,
  EnvironmentStatusResponse,
} from "@traycer/protocol/host/environment-schemas";
import type { EnvironmentDescriptorV11 } from "@traycer/protocol/host/environment/contracts";
import type {
  EnvironmentTransportAnswer,
  EnvironmentTransportRequest,
} from "@traycer-clients/shared/environment/environment-cloud";
import type { AuthService } from "@/lib/auth/auth-service";
import {
  createFakeEnvironmentCloudServices,
  createFakeEnvironmentCloudTransport,
  jsonEnvironmentAnswer,
} from "../../../../../__tests__/create-fake-runner-host";
import {
  ACCESS_HOST_ID,
  ACCESS_HOST_NAME,
  ACCESS_METHODS,
  buildAccessHost,
  noticeFixture,
  reviewEntryFixture,
  type AccessHost,
  type AccessHostState,
} from "@/components/settings/host-scope/__tests__/host-access-test-support";
import { hostScopeOptionFixture } from "@/components/settings/host-scope/host-scope-fixture";
import { useHostScope } from "@/components/settings/host-scope/use-host-scope";
import { useScopedHostBinding } from "@/components/settings/host-scope/use-scoped-host-binding";
import { useSettingsEnvironmentPickStore } from "@/stores/settings/settings-environment-pick-store";
import { useAuthStore } from "@/stores/auth/auth-store";
import { PersonalPageFrame } from "@/components/settings/personal/personal-page-frame";
import { provider } from "@/components/settings/panels/permissions/__tests__/judge-test-support";
import { SettingsPanelShell } from "@/components/settings/settings-panel-shell";
import { environmentStatusFixture } from "@/lib/environment/__tests__/environment-test-support";
import {
  HostRuntimeContext,
  HostRuntimeProvider,
  hostRpcRegistry,
  type HostRpcRegistry,
} from "@/lib/host";
import type { SettingsSectionId } from "@/lib/settings-sections";
import { RunnerHostContext } from "@/providers/runner-host-context";
import { RunnerHostProvider } from "@/providers/runner-host-provider";

afterEach(() => {
  useSettingsEnvironmentPickStore.setState({ pick: null });
  cleanup();
  useRetrospectiveSheetStore.setState({ target: null, open: false });
  resetNegotiatedManifests();
  scopeOverrides.current = {};
  hostMock.auth = null;
  navigateToSettingsSectionMock.mockReset();
  toastErrorMock.mockReset();
  useAuthStore.setState({ status: "signed-out", contextMetadata: null });
});

function FakePanel(): ReactNode {
  return (
    <SettingsPanelShell title="Shell" description="How terminals start.">
      <button type="button">Edit the page</button>
    </SettingsPanelShell>
  );
}

interface FrameOptions {
  readonly section: SettingsSectionId;
  readonly methods: readonly string[];
  /** The host id the window addresses; the notice's host id is compared to it. */
  readonly windowHostId: string;
  readonly runnerHost: IRunnerHost | null;
  /** `true` stands up a grant minter, so a write's grant is observable. */
  readonly mintsGrants: boolean;
  /**
   * Answers an authn request ahead of the host-backed answers below, or
   * declines it with null.
   */
  readonly onAuthnRequest:
    | ((
        request: EnvironmentTransportRequest,
      ) => EnvironmentTransportAnswer | null)
    | null;
}

const SHELL_PAGE: FrameOptions = {
  section: "shell",
  methods: ACCESS_METHODS,
  windowHostId: ACCESS_HOST_ID,
  runnerHost: null,
  mintsGrants: true,
  onAuthnRequest: null,
};

/** Reads and writes authn received for the page under test, in arrival order. */
interface AuthnLog {
  readonly queryClient: QueryClient;
  readonly requests: EnvironmentTransportRequest[];
  notices: number;
  review: number;
}

function authnLog(queryClient: QueryClient): AuthnLog {
  return { queryClient, requests: [], notices: 0, review: 0 };
}

/**
 * Personal's notices, review holds and Undo as authn answers them, from the
 * fake host's state: a notice's address is its place in the list (its
 * revision), an Undo is recorded among the host's writes so that the order of
 * "keep here, then undo everywhere" is observable, and a hold names the host
 * that proposed it.
 */
function hostBackedAuthnAnswer(
  host: AccessHost,
  log: AuthnLog,
  request: EnvironmentTransportRequest,
): EnvironmentTransportAnswer | null {
  const path = new URL(request.url).pathname;
  if (request.method === "GET" && path.endsWith("/notices")) {
    log.notices += 1;
    return jsonEnvironmentAnswer({
      notices: host.state.notices.map((notice, index) => ({
        kind: notice.kind,
        key: notice.key,
        os: notice.os === "any" ? null : notice.os,
        revision: index + 1,
        writtenAt: notice.writtenAt,
        source: notice.source,
        hostId: notice.from.kind === "host" ? notice.from.hostId : null,
        hostName: notice.from.kind === "host" ? notice.from.hostLabel : null,
        displaced: "previous",
      })),
    });
  }
  if (request.method === "GET" && path.endsWith("/review")) {
    log.review += 1;
    return jsonEnvironmentAnswer({
      review: {
        hosts: [],
        needsYou: host.state.review.map((entry, index) => ({
          type: "held",
          heldId: entry.entryId,
          revision: index + 1,
          kind: entry.kind,
          key: entry.key,
          os: entry.os === "any" ? null : entry.os,
          hostId: entry.hostId ?? ACCESS_HOST_ID,
          sharingGeneration: null,
          hostName: ACCESS_HOST_NAME,
          heldAt: entry.heldAt,
          live: null,
          op: "put",
          value: heldValueOf(entry),
        })),
      },
    });
  }
  if (request.method === "POST" && path.endsWith("/undo")) {
    host.requests.push({ method: "environment.undo", params: request.body });
    const answer = host.state.undoAnswer;
    if (answer.outcome === "needs_grant") {
      return {
        status: 403,
        text: JSON.stringify({ code: "executable_write_needs_grant" }),
      };
    }
    if (answer.outcome === "stale") {
      return {
        status: 409,
        text: JSON.stringify({ code: "superseded", current: null }),
      };
    }
    return jsonEnvironmentAnswer({
      item: {
        kind: "variable",
        key: "LOG_LEVEL",
        os: null,
        value: { value: "debug" },
        revision: 2,
        updatedAt: 2,
        writtenBy: { source: "dashboard", hostId: null, hostName: null },
      },
    });
  }
  return null;
}

/** The held value authn would carry for an entry, as its line is derived from it. */
function heldValueOf(
  entry: EnvironmentReviewEntry | EnvironmentReviewEntryV12,
): unknown {
  const command = "command" in entry ? entry.command : null;
  if (command === null) return {};
  const [path, ...args] = command.split(" ");
  return entry.kind === "shell" ? { path, args } : { text: command };
}

/**
 * The page under the host runtime Settings gives it: the real provider, and
 * the scope's client re-provided the way a host-scoped panel does, so the
 * page's own chip reads the same host the page does.
 */
function ScopedHostRuntime(props: { readonly children: ReactNode }): ReactNode {
  return (
    <RunnerHostProvider
      runnerHost={
        new MockRunnerHost({
          signInUrl: "https://auth.traycer.invalid/sign-in",
          authnBaseUrl: "https://authn.traycer.invalid",
          localHost: null,
          hosts: [],
          workspaceFolderPickerPaths: undefined,
          hasLocalHost: undefined,
          traycerCli: undefined,
        })
      }
    >
      <HostRuntimeProvider
        registry={hostRpcRegistry}
        messengerFactory={(args) =>
          new MockHostMessenger<HostRpcRegistry>({
            registry: args.registry,
            requestId: () => "req-runtime",
            handlers: {},
          })
        }
        invalidator={null}
        requestId={null}
        remoteFetcher={() => Promise.resolve({ kind: "hosts", entries: [] })}
        fallback={null}
      >
        <ScopedBinding>{props.children}</ScopedBinding>
      </HostRuntimeProvider>
    </RunnerHostProvider>
  );
}

function ScopedBinding(props: { readonly children: ReactNode }): ReactNode {
  const binding = useScopedHostBinding(useHostScope());
  return (
    <HostRuntimeContext.Provider value={binding}>
      {props.children}
    </HostRuntimeContext.Provider>
  );
}

function renderPage(host: AccessHost, options: FrameOptions): AuthnLog {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const log = authnLog(queryClient);
  recordNegotiatedHostMethods(options.windowHostId, options.methods);
  const { auth } = createFakeEnvironmentCloudServices({
    listEnvironments: () =>
      Promise.resolve({
        kind: "ok" as const,
        list: { environments: host.state.environments },
      }),
    transport: createFakeEnvironmentCloudTransport({
      environments: () => host.state.environments,
      onRequest: (request) => {
        log.requests.push(request);
        return (
          options.onAuthnRequest?.(request) ??
          hostBackedAuthnAnswer(host, log, request)
        );
      },
    }),
    runnerHostOverrides: { authnBaseUrl: "https://authn.example.test" },
  });
  if (options.mintsGrants) {
    auth.mintExecutableWriteGrant = () =>
      Promise.resolve({
        kind: "ok" as const,
        grant: "grant-1",
        expiresInSeconds: 600,
      });
  }
  hostMock.auth = auth;
  // The reads of Personal's id and its notices wait for a verified viewer.
  useAuthStore.setState({
    status: "signed-in",
    contextMetadata: { userId: "user-me", username: "user-me" },
  });
  // These cases are about a host's own pages, which a Local row reads.
  useSettingsEnvironmentPickStore.setState({
    pick: {
      kind: "local",
      hostId: options.windowHostId,
      hostName: ACCESS_HOST_NAME,
    },
  });
  scopeOverrides.current = {
    host: hostScopeOptionFixture({
      hostId: options.windowHostId,
      name: ACCESS_HOST_NAME,
    }),
    hostId: options.windowHostId,
    status: "ready",
    client: host.client,
  };
  const page: ReactNode = (
    <PersonalPageFrame section={options.section}>
      <FakePanel />
    </PersonalPageFrame>
  );
  render(
    <QueryClientProvider client={queryClient}>
      <ScopedHostRuntime>
        {/* The page's own shell, or none, as each case says; the runtime's
            shell above is only what the provider starts on. */}
        <RunnerHostContext.Provider value={options.runnerHost}>
          {page}
        </RunnerHostContext.Provider>
      </ScopedHostRuntime>
    </QueryClientProvider>,
  );
  return log;
}

const PERSONAL_ENVIRONMENTS: EnvironmentDescriptorV11[] = [
  {
    environmentId: "environment-personal",
    ownerKind: "user" as const,
    ownerId: "user-me",
    roomId: "room-personal",
    label: "Personal",
    effectiveRole: "owner" as const,
    kind: "personal" as const,
    hostCount: 1,
    providerHandle: null,
  },
];

/** authn refuses the Undo with a 403 whose body names `code`. */
function renderUndoAuthnPage(code: string): EnvironmentTransportRequest[] {
  const host = hostWith({}, { notices: [noticeFixture({})] });
  return renderPage(host, {
    ...SHELL_PAGE,
    mintsGrants: false,
    onAuthnRequest: (request) =>
      request.method === "POST" &&
      new URL(request.url).pathname.endsWith("/undo")
        ? { status: 403, text: JSON.stringify({ code }) }
        : null,
  }).requests;
}

/** A held entry as an `environment.review@1.2` host sends it. */
function heldCommandEntry(
  overrides: Partial<EnvironmentReviewEntryV12>,
): EnvironmentReviewEntryV12 {
  return {
    ...reviewEntryFixture({}),
    command: null,
    event: null,
    description: null,
    harness: null,
    value: null,
    ...overrides,
  };
}

function hostWith(
  status: Partial<EnvironmentStatusResponse>,
  rest: Partial<AccessHostState>,
): AccessHost {
  return buildAccessHost({
    status: environmentStatusFixture(status),
    environments: PERSONAL_ENVIRONMENTS,
    ...rest,
  });
}

/**
 * Waits until every read the page started has answered, so a NEGATIVE
 * assertion runs after the reads it depends on, not after a guessed delay.
 */
async function settled(log: AuthnLog): Promise<void> {
  await waitFor(() => {
    expect(log.queryClient.isFetching()).toBe(0);
  });
}

function methodsOf(host: AccessHost): string[] {
  return host.requests.map((request) => request.method);
}

const FROM_DEV_BOX = {
  kind: "host",
  hostId: ACCESS_HOST_ID,
  hostLabel: ACCESS_HOST_NAME,
} as const;

describe("a Personal page's convergence notices", () => {
  it("says which change now applies everywhere, and where it came from", async () => {
    const host = hostWith(
      {},
      {
        notices: [
          noticeFixture({ key: "LOG_LEVEL", from: FROM_DEV_BOX }),
          noticeFixture({
            noticeId: "notice-2",
            key: "DATABASE_URL",
            from: { kind: "dashboard" },
          }),
        ],
      },
    );
    renderPage(host, SHELL_PAGE);

    const rows = await screen.findAllByTestId("personal-notice");
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining("LOG_LEVEL from dev-box now applies everywhere."),
      expect.stringContaining(
        "DATABASE_URL from the dashboard now applies everywhere.",
      ),
    ]);
    // Under the page's heading, in the shell's header with the status line.
    const header = rows[0].closest("header");
    expect(header).not.toBeNull();
    expect(header?.closest("[data-settings-panel-shell]")).not.toBeNull();
  });

  it("names another host without a label as 'another host'", async () => {
    const host = hostWith(
      {},
      {
        notices: [
          noticeFixture({
            from: { kind: "host", hostId: "host-b", hostLabel: null },
          }),
        ],
      },
    );
    renderPage(host, SHELL_PAGE);

    expect(
      (await screen.findByTestId("personal-notice")).textContent,
    ).toContain("LOG_LEVEL from another host now applies everywhere.");
  });

  it("shows only the notices of this page's kinds", async () => {
    const host = hostWith(
      {},
      {
        notices: [
          noticeFixture({ kind: "variable", key: "LOG_LEVEL" }),
          noticeFixture({
            noticeId: "notice-2",
            kind: "mcp_server",
            key: "linear",
          }),
          noticeFixture({
            noticeId: "notice-3",
            kind: "skill",
            key: "review",
          }),
        ],
      },
    );
    renderPage(host, SHELL_PAGE);

    const rows = await screen.findAllByTestId("personal-notice");
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain("LOG_LEVEL");
  });

  it("shows no notices list when this page has none", async () => {
    const host = hostWith(
      {},
      { notices: [noticeFixture({ kind: "mcp_server", key: "linear" })] },
    );
    const log = renderPage(host, SHELL_PAGE);

    await waitFor(() => {
      expect(log.notices).toBeGreaterThan(0);
    });
    await settled(log);
    expect(screen.queryByTestId("personal-page-notices")).toBeNull();
    expect(screen.queryByTestId("personal-notice")).toBeNull();
  });
});

describe("Undo on a notice", () => {
  it("shows the permission toast for authn's non-grant 403", async () => {
    const requests = renderUndoAuthnPage("forbidden");

    fireEvent.click(await screen.findByRole("button", { name: "Undo" }));

    await waitFor(() => {
      expect(toastErrorMock).toHaveBeenCalled();
    });
    expect(toastErrorMock.mock.calls[0]?.[0]).toBe(
      "This change needs permission.",
    );
    expect(requests).toContainEqual(
      expect.objectContaining({
        method: "POST",
        url: "https://authn.example.test/api/v3/environments/environment-personal/changes/1/undo",
        body: { kind: "variable", key: "LOG_LEVEL", os: null },
      }),
    );
  });

  it("keeps the row's confirmation line for authn's grant 403", async () => {
    const requests = renderUndoAuthnPage("executable_write_needs_grant");

    fireEvent.click(await screen.findByRole("button", { name: "Undo" }));

    expect(
      (await screen.findByTestId("personal-notice-refusal")).textContent,
    ).toBe(
      "Couldn't undo: it needs your confirmation. Sign in again and retry.",
    );
    expect(toastErrorMock).not.toHaveBeenCalled();
    expect(requests).toContainEqual(
      expect.objectContaining({
        method: "POST",
        url: "https://authn.example.test/api/v3/environments/environment-personal/changes/1/undo",
        body: { kind: "variable", key: "LOG_LEVEL", os: null },
      }),
    );
  });

  it("sends the Undo to authn with the change's kind, key and os", async () => {
    const host = hostWith({}, { notices: [noticeFixture({})] });
    renderPage(host, SHELL_PAGE);

    fireEvent.click(await screen.findByRole("button", { name: "Undo" }));

    await waitFor(() => {
      expect(host.paramsOf("environment.undo")).toEqual([
        { kind: "variable", key: "LOG_LEVEL", os: null },
      ]);
    });
    expect(screen.queryByTestId("personal-notice-refusal")).toBeNull();
  });

  it("says the value was changed again since when authn answers superseded", async () => {
    const host = hostWith(
      {},
      {
        notices: [noticeFixture({})],
        undoAnswer: {
          outcome: "stale",
          currentRevision: 5,
          changedBy: { kind: "dashboard" },
        },
      },
    );
    renderPage(host, SHELL_PAGE);

    fireEvent.click(await screen.findByRole("button", { name: "Undo" }));

    expect(
      (await screen.findByTestId("personal-notice-refusal")).textContent,
    ).toBe("Couldn't undo: LOG_LEVEL was changed again since.");
  });

  it("asks the person to sign in again when authn asks for a confirmation", async () => {
    const host = hostWith(
      {},
      {
        notices: [noticeFixture({})],
        undoAnswer: { outcome: "needs_grant" },
      },
    );
    renderPage(host, SHELL_PAGE);

    fireEvent.click(await screen.findByRole("button", { name: "Undo" }));

    expect(
      (await screen.findByTestId("personal-notice-refusal")).textContent,
    ).toBe(
      "Couldn't undo: it needs your confirmation. Sign in again and retry.",
    );
  });
});

describe("Keep this host's value", () => {
  const KEEP = "Keep dev-box's value on dev-box";

  it("keeps the current value on this host FIRST and undoes the change everywhere SECOND", async () => {
    const host = hostWith(
      {},
      {
        notices: [noticeFixture({ from: FROM_DEV_BOX })],
        envEntries: [{ key: "LOG_LEVEL", value: "debug" }],
      },
    );
    renderPage(host, SHELL_PAGE);

    fireEvent.click(await screen.findByRole("button", { name: KEEP }));

    await waitFor(() => {
      expect(methodsOf(host)).toEqual([
        "config.env.localOverride.set",
        "environment.undo",
      ]);
    });
    expect(host.requests).toEqual([
      {
        method: "config.env.localOverride.set",
        params: {
          target: { kind: "variable", key: "LOG_LEVEL" },
          value: "debug",
          executableWriteGrant: "grant-1",
        },
      },
      {
        method: "environment.undo",
        params: { kind: "variable", key: "LOG_LEVEL", os: null },
      },
    ]);
    expect(screen.queryByTestId("personal-notice-refusal")).toBeNull();
  });

  it("keeps the value on this host even when the undo is refused as stale, and says so", async () => {
    const host = hostWith(
      {},
      {
        notices: [noticeFixture({ from: FROM_DEV_BOX })],
        envEntries: [{ key: "LOG_LEVEL", value: "debug" }],
        undoAnswer: {
          outcome: "stale",
          currentRevision: 5,
          changedBy: { kind: "dashboard" },
        },
      },
    );
    renderPage(host, SHELL_PAGE);

    fireEvent.click(await screen.findByRole("button", { name: KEEP }));

    expect(
      (await screen.findByTestId("personal-notice-refusal")).textContent,
    ).toBe(
      "Kept on dev-box, but couldn't undo the change everywhere: LOG_LEVEL was changed again since.",
    );
    // The override stays: it was set, and nothing took it back.
    expect(methodsOf(host)).toEqual([
      "config.env.localOverride.set",
      "environment.undo",
    ]);
    expect(host.paramsOf("config.env.localOverride.clear")).toEqual([]);
  });

  it("does not undo anything when the host will not keep the value without a confirmation", async () => {
    const host = hostWith(
      {},
      {
        notices: [noticeFixture({ from: FROM_DEV_BOX })],
        envEntries: [{ key: "LOG_LEVEL", value: "debug" }],
        localOverrideNeedsGrant: true,
      },
    );
    renderPage(host, SHELL_PAGE);

    fireEvent.click(await screen.findByRole("button", { name: KEEP }));

    expect(
      (await screen.findByTestId("personal-notice-refusal")).textContent,
    ).toBe("Couldn't keep the value without your confirmation.");
    expect(methodsOf(host)).toEqual(["config.env.localOverride.set"]);
  });

  it("is offered only on the host the change came from", async () => {
    const host = hostWith(
      {},
      {
        notices: [
          noticeFixture({
            from: { kind: "host", hostId: "host-b", hostLabel: "laptop" },
          }),
        ],
        envEntries: [{ key: "LOG_LEVEL", value: "debug" }],
      },
    );
    const log = renderPage(host, SHELL_PAGE);

    const row = await screen.findByTestId("personal-notice");
    expect(row.textContent).toContain("LOG_LEVEL from laptop");
    expect(within(row).getByRole("button", { name: "Undo" })).toBeTruthy();
    await settled(log);
    expect(within(row).queryByRole("button", { name: /^Keep / })).toBeNull();
  });

  it("is not offered for a change made in the dashboard", async () => {
    const host = hostWith(
      {},
      {
        notices: [noticeFixture({ from: { kind: "dashboard" } })],
        envEntries: [{ key: "LOG_LEVEL", value: "debug" }],
      },
    );
    const log = renderPage(host, SHELL_PAGE);

    const row = await screen.findByTestId("personal-notice");
    await settled(log);
    expect(within(row).getByRole("button", { name: "Undo" })).toBeTruthy();
    expect(within(row).queryByRole("button", { name: /^Keep / })).toBeNull();
  });

  it("is not offered until the host's current value is read", async () => {
    const host = hostWith(
      {},
      {
        notices: [noticeFixture({ from: FROM_DEV_BOX })],
        envEntries: [{ key: "OTHER", value: "x" }],
      },
    );
    const log = renderPage(host, SHELL_PAGE);

    const row = await screen.findByTestId("personal-notice");
    await settled(log);
    expect(within(row).getByRole("button", { name: "Undo" })).toBeTruthy();
    expect(within(row).queryByRole("button", { name: /^Keep / })).toBeNull();
  });

  it("draws no row and no Keep for a change authn's list does not carry", async () => {
    // authn lists a change only while no later change superseded it, so a
    // superseded one is simply absent from its answer.
    const host = hostWith(
      {},
      { notices: [], envEntries: [{ key: "LOG_LEVEL", value: "debug" }] },
    );
    const log = renderPage(host, SHELL_PAGE);

    await waitFor(() => {
      expect(log.notices).toBeGreaterThan(0);
    });
    await settled(log);
    expect(screen.queryByTestId("personal-notice")).toBeNull();
    expect(screen.queryByRole("button", { name: /^Keep / })).toBeNull();
  });

  it("keeps a provider's variable as that provider's override", async () => {
    const claude = {
      ...provider("claude-code", []),
      envOverrides: [{ key: "ANTHROPIC_BASE_URL", value: "http://proxy" }],
    };
    const host = hostWith(
      {},
      {
        notices: [
          noticeFixture({
            kind: "env_override",
            key: "claude-code:ANTHROPIC_BASE_URL",
            from: FROM_DEV_BOX,
          }),
        ],
        providers: [claude],
      },
    );
    // Nothing else on the page reads the provider list: the Keep row reads
    // the value itself.
    renderPage(host, { ...SHELL_PAGE, section: "providers" });

    expect(
      (await screen.findByTestId("personal-notice")).textContent,
    ).toContain("ANTHROPIC_BASE_URL from dev-box now applies everywhere.");
    fireEvent.click(await screen.findByRole("button", { name: KEEP }));

    await waitFor(() => {
      expect(methodsOf(host)).toEqual([
        "config.env.localOverride.set",
        "environment.undo",
      ]);
    });
    expect(host.paramsOf("config.env.localOverride.set")).toEqual([
      {
        target: {
          kind: "env_override",
          providerId: "claude-code",
          key: "ANTHROPIC_BASE_URL",
        },
        value: "http://proxy",
        executableWriteGrant: "grant-1",
      },
    ]);
  });
});

describe("a Personal page's 'needs you' rows", () => {
  it("says why a held command waits, and sends it to the host's retrospective sheet", async () => {
    const host = hostWith(
      {},
      {
        review: [
          heldCommandEntry({
            entryId: "entry-2",
            kind: "shell",
            key: "shell",
            reason: "executable_entry",
            command: "zsh -l",
          }),
        ],
      },
    );
    renderPage(host, SHELL_PAGE);

    const rows = await screen.findAllByTestId("personal-review-row");
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining(
        "shell (shell) is what terminals and agents start in: zsh -l and is on hold until you choose",
      ),
    ]);
    expect(
      within(rows[0]).getByRole("button", { name: "Review" }),
    ).toBeTruthy();

    // A held command's Review opens the host's retrospective sheet.
    fireEvent.click(within(rows[0]).getByRole("button", { name: "Review" }));
    expect(navigateToSettingsSectionMock).not.toHaveBeenCalled();
    expect(useRetrospectiveSheetStore.getState()).toMatchObject({
      open: true,
      target: { hostId: ACCESS_HOST_ID, hostName: ACCESS_HOST_NAME },
    });
  });

  it("words a held variable from a host that sends none by what it changes", async () => {
    const host = hostWith(
      {},
      {
        review: [
          heldCommandEntry({
            entryId: "entry-1",
            kind: "variable",
            key: "SHELL_INIT",
            reason: "executable_entry",
          }),
        ],
      },
    );
    renderPage(host, SHELL_PAGE);

    const rows = await screen.findAllByTestId("personal-review-row");
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining(
        "SHELL_INIT (variable) changes how programs start and is on hold until you choose",
      ),
    ]);
  });

  it("shows only the rows of this page's kinds", async () => {
    const host = hostWith(
      {},
      {
        review: [
          reviewEntryFixture({ kind: "variable", key: "DATABASE_URL" }),
          reviewEntryFixture({
            entryId: "entry-2",
            kind: "mcp_server",
            key: "linear",
          }),
        ],
      },
    );
    renderPage(host, SHELL_PAGE);

    const rows = await screen.findAllByTestId("personal-review-row");
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain("DATABASE_URL");
  });
});

describe("a team's host on a Personal page", () => {
  it("shows the team line, puts the page in an inert region and reads no notices", async () => {
    const host = hostWith(
      { principal: { kind: "team", teamName: "Acme" } },
      {
        notices: [noticeFixture({})],
        review: [reviewEntryFixture({})],
      },
    );
    const log = renderPage(host, SHELL_PAGE);

    const line = await screen.findByTestId("team-owned-line");
    expect(
      within(line).getByText("These settings belong to Acme."),
    ).toBeTruthy();
    expect(line.closest("[inert]")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Edit the page" }).closest("[inert]"),
    ).not.toBeNull();

    await settled(log);
    expect(screen.queryByTestId("personal-notice")).toBeNull();
    expect(screen.queryByTestId("personal-review-row")).toBeNull();
    expect(log.notices).toBe(0);
    expect(log.review).toBe(0);
  });

  it("does not put the person's own page in an inert region", async () => {
    const host = hostWith({ principal: { kind: "personal" } }, {});
    const log = renderPage(host, SHELL_PAGE);

    const edit = await screen.findByRole("button", { name: "Edit the page" });
    await waitFor(() => {
      expect(host.reads.status).toBeGreaterThan(0);
    });
    await settled(log);
    expect(edit.closest("[inert]")).toBeNull();
    expect(screen.queryByTestId("team-owned-line")).toBeNull();
  });
});
