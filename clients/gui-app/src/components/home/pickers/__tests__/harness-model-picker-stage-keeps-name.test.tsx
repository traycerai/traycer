import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The cloud's Traycer list and the sandbox configuration are the only
// boundaries faked beside the host client; the toolbar store, the staged
// store and the picker are real.
const cloud = vi.hoisted(() => ({
  models: undefined as ReadonlyArray<unknown> | undefined,
  sandboxHost: false,
}));
const hostBindingMock = vi.hoisted(() => ({
  current: null as { readonly hostClient: unknown } | null,
}));

vi.mock("@/hooks/sandboxes/use-sandbox-traycer-models-query", () => ({
  useSandboxTraycerModels: () => ({
    data: cloud.models,
    error: null,
    isPending: cloud.models === undefined,
    isFetching: false,
    fetchStatus: "idle",
    isError: false,
  }),
}));
vi.mock("@/hooks/sandboxes/use-on-team-sandbox", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/hooks/sandboxes/use-on-team-sandbox")
  >()),
  useSandboxHostConfiguration: () =>
    cloud.sandboxHost ? { kind: "personal" as const } : null,
}));
vi.mock("@/hooks/sandboxes/use-sandbox-catalogue-query", () => ({
  useSandboxCatalogue: () => ({
    data: undefined,
    isError: false,
    isFetching: false,
    refetch: vi.fn(),
  }),
}));
vi.mock("@/providers/use-runner-host", () => ({
  useRunnerHost: () => ({ signInUrl: "https://billing.test" }),
}));
vi.mock("@/hooks/auth/use-auth-user-query", () => ({
  useAuthUser: () => ({
    data: null,
    refetch: () => Promise.resolve({ data: null, isError: false }),
  }),
}));
vi.mock("@/lib/links/open-link", () => ({ useOpenLink: () => vi.fn() }));
vi.mock("@/hooks/providers/use-resolved-seeded-profile-id", () => ({
  useResolvedSeededProfileId: (_harnessId: string, profileId: string | null) =>
    profileId,
}));
vi.mock("@/stores/tabs/use-system-tab-modal", () => ({
  useSystemTabModalActions: () => ({
    openSettings: vi.fn(),
    openHistory: vi.fn(),
    close: vi.fn(),
    setSection: vi.fn(),
  }),
}));
vi.mock("@/hooks/providers/use-providers-list-query", () => ({
  useProvidersList: () => ({
    data: { providers: [] },
    isPending: false,
    isError: false,
    isFetching: false,
  }),
  useProvidersListForClient: () => ({
    data: { providers: [] },
    isPending: false,
    isError: false,
    isFetching: false,
  }),
}));
vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: (hostId: string | null) =>
    hostId === null ? (hostBindingMock.current?.hostClient ?? null) : hostId,
}));
vi.mock("@/hooks/host/use-host-credential-refusal", () => ({
  useHostCredentialRefusal: () => null,
}));
vi.mock("@/hooks/host/use-addressable-host-id", () => ({
  useAddressableHostId: () => "local",
}));
vi.mock("@/hooks/host/use-host-directory-list-query", () => ({
  useHostDirectoryList: () => ({
    data: [
      {
        hostId: "local",
        kind: "local",
        label: "Local host",
        transportDialability: "dialable",
        websocketUrl: "ws://127.0.0.1:0",
      },
    ],
  }),
}));
vi.mock("@/lib/host/runtime", () => ({
  useHostBinding: () => hostBindingMock.current,
  useHostClient: () => hostBindingMock.current?.hostClient,
  useHostRuntimeClient: () => hostBindingMock.current?.hostClient,
}));

import { act, cleanup, render, screen } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import type { ChatRunSettings } from "@traycer/protocol/host/agent/gui/subscribe";
import { ALL_PERMISSION_MODES } from "@traycer/protocol/persistence/epic/foundation";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { createAppQueryClient } from "@/lib/query-client";
import { hostRpcSchedulingPolicy } from "@/lib/host-rpc-policy/host-method-policy-table";
import { HarnessModelPicker } from "@/components/home/pickers/harness-model-picker";
import { SurfaceActivityProvider } from "@/components/home/composer/surface-activity-context";
import { ComposerStagedSurfaceKeyContext } from "@/components/composer/composer-staged-surface-key";
import { useComposerToolbarStore } from "@/components/home/hooks/use-composer-toolbar-store";
import type { ModelOption } from "@/components/home/data/landing-options";
import { fallbackSeedSource } from "@/lib/composer/composer-seed-source";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useComposerHarnessMemoryStore } from "@/stores/composer/composer-harness-memory-store";
import {
  useStagedSandboxStore,
  type StagedSandboxTarget,
} from "@/stores/composer/staged-sandbox-store";

const SURFACE = "landing:window-1";

function traycerModel(
  slug: string,
  label: string,
  metadata: ModelOption["metadata"],
): ModelOption {
  return {
    harnessId: "traycer",
    slug,
    label,
    description: null,
    contextWindow: null,
    maxOutputTokens: null,
    defaultReasoningEffort: null,
    supportedReasoningEfforts: [],
    defaultServiceTier: null,
    supportedServiceTiers: [],
    metadata,
  };
}

const NO_GROUP = {};
const GROUPED = {
  openCodeProviderLabel: "Vendor",
  openCodeProviderId: "vendor",
};

// The host's own Traycer list, which holds the pick while no stage is up. Its
// label carries the group prefix its display name drops.
const PICKED = traycerModel("trc-picked", "Vendor: Picked Name", GROUPED);
const OTHER = traycerModel("trc-other", "Other Name", NO_GROUP);

function pickOf(model: string): ChatRunSettings {
  return {
    ultracode: false,
    harnessId: "traycer",
    model,
    permissionMode: "supervised",
    reasoningEffort: null,
    serviceTier: null,
    agentMode: "regular",
    profileId: null,
  };
}

function stagedTarget(): StagedSandboxTarget {
  return {
    kind: "new",
    configuration: { kind: "personal" },
    shape: {
      os: "linux",
      cpus: 2,
      memoryMb: 8192,
      diskMb: null,
      region: "us-east",
      idleMinutes: 30,
      destroyAfterRestingMinutes: null,
    },
    name: "",
    wakeString: null,
  };
}

function createHostWrapper(
  hostModels: ReadonlyArray<ModelOption>,
): (props: { readonly children: ReactNode }) => ReactNode {
  const queryClient = createAppQueryClient();
  let requestCounter = 0;
  const spine = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    schedulingPolicy: hostRpcSchedulingPolicy,
    invalidator: createHostQueryInvalidator(queryClient),
    findHostById: (hostId) =>
      hostId === mockLocalHostEntry.hostId ? mockLocalHostEntry : null,
    messenger: new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => {
        requestCounter += 1;
        return `req-${String(requestCounter)}`;
      },
      handlers: {
        "agent.gui.listHarnesses": () => ({
          harnesses: [
            {
              id: "traycer",
              label: "Traycer",
              enabled: true,
              available: true,
              error: null,
              modes: ["gui", "tui"],
              requiresApiKey: false,
              supportedPermissionModes: [...ALL_PERMISSION_MODES],
              nativeAutoJudge: false,
              availabilityPending: false,
            },
          ],
        }),
        "agent.gui.listModels": (params) => ({
          harnessId: params.harnessId,
          models: [...hostModels],
        }),
        "agent.gui.listCommands": (params) => ({
          harnessId: params.harnessId,
          commands: [],
        }),
      },
    }),
  });
  spine.setRequestContext(
    createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
  );
  hostBindingMock.current = {
    hostClient: spine.createRequester(mockLocalHostEntry),
  };
  return (props) => (
    <QueryClientProvider client={queryClient}>
      {props.children}
    </QueryClientProvider>
  );
}

function Composer(props: { readonly pick: ChatRunSettings }): ReactNode {
  const hostClient = hostBindingMock.current?.hostClient;
  if (!(hostClient instanceof HostClient)) {
    throw new Error("the host client was not set up");
  }
  const store = useComposerToolbarStore(
    null,
    fallbackSeedSource(props.pick, hostClient),
    null,
    {
      hostClient,
      hostId: "local",
      tuiOnly: false,
      chatLineCarriesAutoMode: null,
      ultracodeCarried: false,
      stagedSurfaceKey: SURFACE,
      sendsToRestingSandbox: false,
    },
  );
  return (
    <ComposerStagedSurfaceKeyContext value={SURFACE}>
      <SurfaceActivityProvider active>
        <TooltipProvider delayDuration={0}>
          <HarnessModelPicker
            withUltracode={false}
            labelDisplay="responsive"
            store={store}
            maxModeContext={{ kind: "none" }}
            withServiceTier={false}
            withReasoning
            tuiOnly={false}
            lockedHarnessId={null}
            disabled={false}
            registerActivation={false}
            createProfileHostId={null}
            runTargetHostId={null}
            profileAdmission={null}
            terminalLoginSurface={null}
            embedding={null}
          />
        </TooltipProvider>
      </SurfaceActivityProvider>
    </ComposerStagedSurfaceKeyContext>
  );
}

function renderComposer(
  hostModels: ReadonlyArray<ModelOption>,
  pick: ChatRunSettings,
): void {
  const Wrapper = createHostWrapper(hostModels);
  render(
    <Wrapper>
      <Composer pick={pick} />
    </Wrapper>,
  );
}

function stageSandbox(): void {
  act(() => {
    useStagedSandboxStore.getState().stage(SURFACE, stagedTarget());
  });
}

beforeEach(() => {
  localStorage.clear();
  useStagedSandboxStore.setState({ bySurface: {} });
  useComposerHarnessMemoryStore.getState().resetForTests();
  cloud.models = undefined;
  cloud.sandboxHost = false;
});

afterEach(() => {
  cleanup();
  hostBindingMock.current = null;
});

describe("<HarnessModelPicker /> under a staged sandbox", () => {
  it("keeps the pick's name when the cloud list omits it", async () => {
    cloud.sandboxHost = true;
    renderComposer([PICKED, OTHER], pickOf("trc-picked"));
    await screen.findByRole("button", { name: /^Picked Name/ });

    cloud.models = [OTHER];
    stageSandbox();

    expect(
      await screen.findByRole("button", { name: /^Picked Name/ }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Select model/ })).toBeNull();
  });

  it("shows the slug for a pick no list has named", async () => {
    cloud.sandboxHost = true;
    cloud.models = [OTHER];
    useStagedSandboxStore.getState().stage(SURFACE, stagedTarget());
    renderComposer([OTHER], pickOf("trc-unlisted"));

    expect(
      await screen.findByRole("button", { name: /^trc-unlisted/ }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Select model/ })).toBeNull();
  });

  it("shows a listed pick's own row name", async () => {
    cloud.sandboxHost = true;
    cloud.models = [PICKED, OTHER];
    useStagedSandboxStore.getState().stage(SURFACE, stagedTarget());
    renderComposer([PICKED, OTHER], pickOf("trc-picked"));

    expect(
      await screen.findByRole("button", { name: /^Picked Name/ }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Vendor/ })).toBeNull();
  });

  it("still reads Select model for a missing pick with no stage", async () => {
    renderComposer([OTHER], pickOf("trc-unlisted"));

    expect(
      await screen.findByRole("button", { name: /Select model/ }),
    ).toBeTruthy();
  });
});
