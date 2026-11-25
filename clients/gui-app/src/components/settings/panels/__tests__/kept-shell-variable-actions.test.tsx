// The real shell variable list and the real Use everywhere handler, over a
// mock host client and a fake authn, inside the bare Personal page context
// that shell-settings-panel.test.tsx's renderShellPanelOverRpc also supplies
// (the context carries this computer's own value; the host transport and the
// click handler stay real). Unlike that file, the manifest here records
// versions, so the exact-pair gate is reached.
//
// Fixture: this computer keeps B for LOG_LEVEL; Personal holds A.

const scopeOverrides = vi.hoisted((): { current: Record<string, unknown> } => ({
  current: {},
}));
vi.mock("@/components/settings/host-scope/use-host-scope", async () => {
  const { hostScopeFixture } =
    await import("@/components/settings/host-scope/host-scope-fixture");
  const useHostScope = () => hostScopeFixture(scopeOverrides.current);
  return {
    useHostScope,
    useHostScopeFor: useHostScope,
    WINDOW_HOST_SELECTION: {
      scopedHostId: null,
      setScopedHostId: () => undefined,
    },
    usePersonalHostScope: useHostScope,
  };
});
vi.mock("@/lib/settings-navigation", () => ({
  navigateToSettingsSection: () => true,
}));
const hostBindingMock = vi.hoisted(
  (): {
    current: {
      readonly hostClient: unknown;
      readonly auth: {
        readonly environmentCloud: () => EnvironmentCloud;
        readonly listEnvironments: () => Promise<EnvironmentDirectoryResult>;
      } | null;
    } | null;
  } => ({ current: null }),
);
vi.mock("@/lib/host", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/host")>();
  return {
    ...actual,
    useHostBinding: () => hostBindingMock.current,
    useHostClient: () => hostBindingMock.current?.hostClient,
  };
});
vi.mock("@/hooks/host/use-host-credential-refusal", () => ({
  useHostCredentialRefusal: () => null,
}));
vi.mock("@/hooks/chats/use-cloud-chat-queries", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/hooks/chats/use-cloud-chat-queries")
  >()),
  useCloudChatViewerId: () => "user-me",
}));

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import {
  recordNegotiatedHostManifest,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import {
  MockRunnerHost,
  MockTraycerCli,
} from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import type {
  ConfigEnvLocalOverrideClearRequest,
  ConfigEnvLocalOverrideResponse,
  ConfigEnvLocalOverrideSetRequest,
  LocalOverride,
} from "@traycer/protocol/host/environment-schemas";
import type { EnvironmentCloud } from "@traycer-clients/shared/environment/environment-cloud";
import type { EnvironmentDirectoryResult } from "@traycer-clients/shared/host-client/environment-directory";
import type { MockHandlerMap } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import type { HostRpcRegistry } from "@/lib/host";
import {
  createFakeEnvironmentAuthn,
  type FakeEnvironmentAuthn,
} from "@/components/settings/environment/__tests__/environment-authn-test-support";
import { hostScopeOptionFixture } from "@/components/settings/host-scope/host-scope-fixture";
import {
  PersonalPageContext,
  type PersonalPageContextValue,
} from "@/components/settings/personal/personal-page-context";
import { PERSONAL_PICK } from "@/lib/settings-environment-pages";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { useAuthStore } from "@/stores/auth/auth-store";
import { ShellSettingsPanel } from "../shell-settings-panel";
import {
  CONFIG_SHELL_METHODS,
  buildConfigHostFixture,
} from "./host-config-rpc-test-support";
import {
  commitRender,
  mutationsSettled,
  queryUpdatedBeyond,
} from "./kept-variable-actions-support";

const HOST_ID = "host-a";
const KEY = "LOG_LEVEL";
const PERSONAL_A = "info";
const OWN_B = "warn";
const TARGET = { kind: "variable", key: KEY } as const;
const PUT = "environment.configuration.items.put";
const APPLY_PATH = "/review/held/held-1/apply";

const environmentList = {
  environments: [
    {
      environmentId: "env-personal",
      ownerKind: "user" as const,
      ownerId: "user-me",
      roomId: "room-personal",
      label: "Personal",
      effectiveRole: "owner" as const,
      kind: "personal" as const,
      hostCount: 1,
      providerHandle: null,
    },
  ],
};

function ownOverride(value: string): LocalOverride {
  return { target: TARGET, os: "any", value, setAt: 1 };
}

interface ApplyRequest {
  readonly method: string;
  readonly url: string;
  readonly body: unknown;
}

interface Run {
  readonly queryClient: QueryClient;
  readonly order: string[];
  readonly applies: ApplyRequest[];
  readonly set: Mock<
    (request: { key: string; value: string | null }) => Promise<SetAnswer>
  >;
  readonly saveToPersonal: Mock<
    (request: ConfigEnvLocalOverrideSetRequest) => Promise<HeldReceipt>
  >;
  readonly clear: Mock<
    (
      request: ConfigEnvLocalOverrideClearRequest,
    ) => Promise<ConfigEnvLocalOverrideResponse>
  >;
}

interface SetAnswer {
  readonly key: string;
  readonly value: string | null;
  readonly savedLocally?: true;
}

interface HeldReceipt {
  readonly environmentId: string;
  readonly heldId: string;
  readonly revision: number;
  readonly expectedLiveRevision: number;
  readonly reviewRequired: boolean;
}

/** The versions the host negotiated; `null` leaves the method out. */
interface Negotiated {
  readonly envSet: { readonly major: 1; readonly minor: number };
  readonly saveToPersonal: boolean;
  readonly clear: { readonly major: 1; readonly minor: number };
}

const NEW_PAIR: Negotiated = {
  envSet: { major: 1, minor: 2 },
  saveToPersonal: true,
  clear: { major: 1, minor: 1 },
};

let fakeAuthn: FakeEnvironmentAuthn | null = null;

function mount(args: {
  readonly negotiated: Negotiated;
  /** What an ordinary Save answers; `savedLocally` is the kept row's answer. */
  readonly setAnswersLocally: boolean;
  /** What authn answers to the held change's apply; 200 is applied. */
  readonly applyStatus: number;
  readonly applyBody: unknown;
  readonly reviewRequired: boolean;
}): Run {
  const order: string[] = [];
  const applies: ApplyRequest[] = [];
  const cli = new MockTraycerCli();
  cli.shellConfig = { path: "/bin/zsh", args: ["-i", "-l"], synthesised: true };
  cli.envOverrides = [{ key: KEY, value: PERSONAL_A }];
  const set = vi.fn(
    (request: { key: string; value: string | null }): Promise<SetAnswer> => {
      order.push("set");
      return Promise.resolve({
        key: request.key,
        value: request.value,
        ...(args.setAnswersLocally ? { savedLocally: true as const } : {}),
      });
    },
  );
  const saveToPersonal = vi.fn(
    (_request: ConfigEnvLocalOverrideSetRequest): Promise<HeldReceipt> => {
      order.push("saveToPersonal");
      return Promise.resolve({
        environmentId: "env-personal",
        heldId: "held-1",
        revision: 4,
        expectedLiveRevision: 3,
        reviewRequired: args.reviewRequired,
      });
    },
  );
  const clear = vi.fn(
    (
      _request: ConfigEnvLocalOverrideClearRequest,
    ): Promise<ConfigEnvLocalOverrideResponse> => {
      order.push("clear");
      return Promise.resolve({ outcome: "saved", overrides: [] });
    },
  );
  const environmentHandlers: MockHandlerMap<HostRpcRegistry> = {
    "environment.list": () => environmentList,
  };
  const handlers: MockHandlerMap<HostRpcRegistry> = {
    ...environmentHandlers,
    "config.env.set": set,
    "config.env.localOverride.saveToPersonal": saveToPersonal,
    "config.env.localOverride.clear": clear,
  };
  const { client } = buildConfigHostFixture({
    hostId: HOST_ID,
    isLocalMachine: true,
    cli,
    overrideHandlers: handlers,
  });
  const authn = createFakeEnvironmentAuthn(handlers);
  fakeAuthn = authn;
  // The held change is applied by the real shared helper over the real
  // cloud; only authn's answer to the apply is scripted.
  const cloud: EnvironmentCloud = {
    ...authn.cloud,
    transport: async (request) => {
      if (request.url.endsWith(APPLY_PATH)) {
        order.push(`authn-apply:${request.method}`);
        applies.push({
          method: request.method,
          url: request.url,
          body: request.body,
        });
        return {
          status: args.applyStatus,
          text: JSON.stringify(args.applyBody),
        };
      }
      return authn.cloud.transport(request);
    },
  };
  recordNegotiatedHostManifest(HOST_ID, {
    ...Object.fromEntries(
      CONFIG_SHELL_METHODS.map((method) => [method, { major: 1, minor: 0 }]),
    ),
    "environment.localOverrides": { major: 1, minor: 0 },
    "environment.list": { major: 1, minor: 0 },
    "config.env.set": args.negotiated.envSet,
    "config.env.localOverride.clear": args.negotiated.clear,
    ...(args.negotiated.saveToPersonal
      ? { "config.env.localOverride.saveToPersonal": { major: 1, minor: 0 } }
      : {}),
  });
  scopeOverrides.current = {
    host: hostScopeOptionFixture({ hostId: HOST_ID, name: "dev-box" }),
    hostId: HOST_ID,
    status: "ready",
    client,
  };
  hostBindingMock.current = {
    hostClient: client,
    auth: {
      environmentCloud: () => cloud,
      listEnvironments: () =>
        Promise.resolve({ kind: "ok" as const, list: environmentList }),
    },
  };
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  const personalPageValue = {
    section: "shell",
    pick: PERSONAL_PICK,
    state: { kind: "unknown" },
    hostName: "dev-box",
    localOverrides: [ownOverride(OWN_B)],
    hostId: HOST_ID,
    client,
    notices: [],
    review: [],
  } satisfies PersonalPageContextValue;
  const runnerHost = new MockRunnerHost({
    signInUrl: "https://example.invalid/signin",
    authnBaseUrl: "https://example.invalid",
    localHost: null,
    hosts: [],
    workspaceFolderPickerPaths: undefined,
    hasLocalHost: undefined,
    traycerCli: undefined,
  });
  render(
    <QueryClientProvider client={queryClient}>
      <RunnerHostProvider runnerHost={runnerHost}>
        <PersonalPageContext.Provider value={personalPageValue}>
          <ShellSettingsPanel />
        </PersonalPageContext.Provider>
      </RunnerHostProvider>
    </QueryClientProvider>,
  );
  return { queryClient, order, applies, set, saveToPersonal, clear };
}

beforeEach(() => {
  useAuthStore.setState({ status: "signed-in" });
});
afterEach(() => {
  cleanup();
  resetNegotiatedManifests();
  scopeOverrides.current = {};
  hostBindingMock.current = null;
  fakeAuthn?.restore();
  fakeAuthn = null;
  vi.clearAllMocks();
  useAuthStore.setState({ status: "signed-out" });
});

/**
 * The row shows its Use everywhere action once the variable list has read:
 * the own value comes from the page context, so the list is the only read.
 */
async function ownValueRead(run: Run): Promise<HTMLElement> {
  await queryUpdatedBeyond(run.queryClient, "config.env.list", 0);
  await commitRender();
  return screen.findByRole("button", { name: "Use everywhere" });
}

/** Clicks Use everywhere and returns once the action's mutation ended. */
async function clickUseEverywhere(run: Run): Promise<void> {
  const button = await ownValueRead(run);
  const settled = mutationsSettled(run.queryClient);
  fireEvent.click(button);
  await settled;
  await commitRender();
}

describe("a shell variable this computer keeps its own value for (B) while Personal holds A", () => {
  // The put of a kept row answers `savedLocally` and proposes nothing, so the
  // old put-then-clear erased B and left A. On a host that negotiated
  // `config.env.set@1.2`, `saveToPersonal` and `clear@1.1`, Use everywhere
  // publishes B through the held save, applies the hold, and only an applied
  // hold clears the keep.
  it("publishes B through saveToPersonal, applies the hold to Personal, and only then clears the keep", async () => {
    const run = mount({
      negotiated: NEW_PAIR,
      setAnswersLocally: true,
      applyStatus: 200,
      applyBody: {},
      reviewRequired: false,
    });

    await clickUseEverywhere(run);

    expect(run.clear).toHaveBeenCalledTimes(1);
    expect(run.saveToPersonal).toHaveBeenCalledTimes(1);
    expect(run.saveToPersonal.mock.calls[0]?.[0]).toEqual({
      target: TARGET,
      value: OWN_B,
    });
    // Never the generic put, and never the host's own set.
    expect(run.set).not.toHaveBeenCalled();
    expect(fakeAuthn?.paramsOf(PUT)).toHaveLength(0);
    expect(run.applies).toHaveLength(1);
    expect(run.applies[0]?.method).toBe("POST");
    expect(run.applies[0]?.url).toContain(
      "/environments/env-personal/review/held/held-1/apply",
    );
    expect(run.applies[0]?.body).toEqual({
      revision: 4,
      expectedLiveRevision: 3,
    });
    expect(run.order).toEqual(["saveToPersonal", "authn-apply:POST", "clear"]);
    expect(run.clear.mock.calls[0]?.[0]).toEqual({
      target: TARGET,
      expectedValue: OWN_B,
    });
  });

  it("keeps B when authn refuses the apply with a stale revision, because only an applied hold clears", async () => {
    const run = mount({
      negotiated: NEW_PAIR,
      setAnswersLocally: true,
      applyStatus: 409,
      applyBody: { code: "revision_conflict" },
      reviewRequired: false,
    });

    await clickUseEverywhere(run);

    expect(run.saveToPersonal).toHaveBeenCalledTimes(1);
    expect(run.applies).toHaveLength(1);
    expect(run.clear).not.toHaveBeenCalled();
    expect(run.set).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Use everywhere" })).toBeTruthy();
    expect(screen.getByTestId("env-row-own-value").textContent).toContain(
      OWN_B,
    );
  });
});

describe("a host on config.env.set below 1.2", () => {
  // Such a host never answers `savedLocally` for a kept row, so today's Use
  // everywhere stays: the ordinary set, then the clear, with no hold and no
  // apply, whatever else the host advertises.
  it("sets B through the ordinary put and clears, without saveToPersonal or an apply", async () => {
    const run = mount({
      negotiated: { ...NEW_PAIR, envSet: { major: 1, minor: 1 } },
      setAnswersLocally: false,
      applyStatus: 200,
      applyBody: {},
      reviewRequired: false,
    });

    await clickUseEverywhere(run);

    expect(run.clear).toHaveBeenCalledTimes(1);
    expect(run.set).toHaveBeenCalledTimes(1);
    expect(run.set.mock.calls[0]?.[0]).toEqual({ key: KEY, value: OWN_B });
    expect(run.saveToPersonal).not.toHaveBeenCalled();
    expect(run.applies).toHaveLength(0);
    expect(run.order).toEqual(["set", "clear"]);
    expect(run.clear.mock.calls[0]?.[0]).toEqual({ target: TARGET });
  });
});
