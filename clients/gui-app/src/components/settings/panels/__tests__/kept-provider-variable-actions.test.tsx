// Target: traycer/clients/gui-app/src/components/settings/panels/__tests__/
// kept-provider-variable-actions.test.tsx, at OSS a3b41c76.
//
// The real provider variable section, the real `useProvidersSetEnvOverride`,
// the real settings-save follow and the real Use everywhere handler, over a
// mock host client and a fake authn, inside the bare Personal page context
// that carries this computer's own value (as kept-shell-variable-actions does).
//
// Fixture: this computer keeps B for ANTHROPIC_BASE_URL; Personal holds A.

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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  recordNegotiatedHostManifest,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import { hostV115MutationV20Fixtures } from "@traycer/protocol/host/__tests__/__fixtures__/host-v1.1.5-mutation-v20";
import { providerMutationCliStateSchemaV21 } from "@traycer/protocol/host/provider-schemas";
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
import {
  buildEnvironmentClient,
  environmentStatusFixture,
} from "@/lib/environment/__tests__/environment-test-support";
import { PERSONAL_PICK } from "@/lib/settings-environment-pages";
import { useAuthStore } from "@/stores/auth/auth-store";
import { ProviderEnvOverridesSection } from "../provider-env-overrides-section";
import {
  commitRender,
  mutationsSettled,
} from "./kept-variable-actions-support";

const HOST_ID = "host-a";
const KEY = "ANTHROPIC_BASE_URL";
const PERSONAL_A = "https://personal-a.example.invalid";
const OWN_B = "https://own-b.example.invalid";
const NEW_C = "https://new-c.example.invalid";
const TARGET = {
  kind: "env_override",
  providerId: "claude-code",
  key: KEY,
} as const;
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

const OWN: LocalOverride = {
  target: TARGET,
  os: "any",
  value: OWN_B,
  setAt: 1,
};

interface ApplyRequest {
  readonly method: string;
  readonly url: string;
  readonly body: unknown;
}

let fakeAuthn: FakeEnvironmentAuthn | null = null;

/**
 * This computer keeps B while Personal holds A, on a host that negotiated the
 * new pair (`providers.setEnvOverride@2.3`, `saveToPersonal`, `clear@1.1`).
 * `applyStatus` is what authn answers to the held change's apply.
 */
function mount(args: {
  readonly saveAnswersLocally: boolean;
  readonly applyStatus: number;
  readonly applyBody: unknown;
}) {
  const order: string[] = [];
  const applies: ApplyRequest[] = [];
  const setEnvOverride = vi.fn(() => {
    order.push("setEnvOverride");
    return Promise.resolve({
      state: providerMutationCliStateSchemaV21.parse({
        ...hostV115MutationV20Fixtures.minimalStatesByProviderId["claude-code"],
        profiles: [],
      }),
      ...(args.saveAnswersLocally ? { savedLocally: true as const } : {}),
    });
  });
  const saveToPersonal = vi.fn((_request: ConfigEnvLocalOverrideSetRequest) => {
    order.push("saveToPersonal");
    return Promise.resolve({
      environmentId: "env-personal",
      heldId: "held-1",
      revision: 4,
      expectedLiveRevision: 3,
      reviewRequired: false,
    });
  });
  const clear = vi.fn(
    (
      _request: ConfigEnvLocalOverrideClearRequest,
    ): Promise<ConfigEnvLocalOverrideResponse> => {
      order.push("clear");
      return Promise.resolve({ outcome: "saved", overrides: [] });
    },
  );
  const handlers: MockHandlerMap<HostRpcRegistry> = {
    "environment.status": () => environmentStatusFixture({}),
    "environment.localOverrides": () => ({ overrides: [OWN] }),
    "providers.setEnvOverride": setEnvOverride,
    "config.env.localOverride.saveToPersonal": saveToPersonal,
    "config.env.localOverride.clear": clear,
    "environment.list": () => environmentList,
  };
  const { client } = buildEnvironmentClient({ hostId: HOST_ID, handlers });
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
    "environment.status": { major: 1, minor: 1 },
    "environment.localOverrides": { major: 1, minor: 0 },
    "environment.list": { major: 1, minor: 0 },
    "config.env.localOverride.clear": { major: 1, minor: 1 },
    "config.env.localOverride.saveToPersonal": { major: 1, minor: 0 },
    "providers.setEnvOverride": { major: 2, minor: 3 },
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
    section: "providers",
    pick: PERSONAL_PICK,
    state: { kind: "unknown" },
    hostName: "dev-box",
    localOverrides: [OWN],
    hostId: HOST_ID,
    client,
    notices: [],
    review: [],
  } satisfies PersonalPageContextValue;
  render(
    <QueryClientProvider client={queryClient}>
      <PersonalPageContext.Provider value={personalPageValue}>
        <ProviderEnvOverridesSection
          providerId="claude-code"
          overrides={[{ key: KEY, value: PERSONAL_A }]}
          envOverrideScope="harness-and-native-config"
        />
      </PersonalPageContext.Provider>
    </QueryClientProvider>,
  );
  return { queryClient, order, applies, setEnvOverride, saveToPersonal, clear };
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

/** Clicks Use everywhere and returns once the action's mutation ended. */
async function clickUseEverywhere(queryClient: QueryClient): Promise<void> {
  const settled = mutationsSettled(queryClient);
  fireEvent.click(screen.getByRole("button", { name: "Use everywhere" }));
  await settled;
  await commitRender();
}

describe("Use everywhere on a provider variable this computer keeps its own value for (B) while Personal holds A", () => {
  // The put of a kept row answers `savedLocally` and proposes nothing, so the
  // old put-then-clear erased B and left A. Use everywhere now publishes B
  // through the held save, applies the hold, and only then clears the keep.
  it("publishes B through saveToPersonal, applies the hold, and only then clears the keep", async () => {
    const run = mount({
      saveAnswersLocally: true,
      applyStatus: 200,
      applyBody: {},
    });

    await clickUseEverywhere(run.queryClient);

    expect(run.saveToPersonal.mock.calls[0]?.[0]).toEqual({
      target: TARGET,
      value: OWN_B,
    });
    expect(run.setEnvOverride).not.toHaveBeenCalled();
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

  it("keeps B when the hold's revision is stale, because only an applied hold clears", async () => {
    const run = mount({
      saveAnswersLocally: true,
      applyStatus: 409,
      applyBody: { code: "revision_conflict" },
    });

    await clickUseEverywhere(run.queryClient);

    expect(run.saveToPersonal).toHaveBeenCalledTimes(1);
    expect(run.applies).toHaveLength(1);
    expect(run.clear).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Use everywhere" })).toBeTruthy();
  });
});

describe("an ordinary Save of a kept provider variable", () => {
  // The answer says `savedLocally` and proposes nothing to Personal. The
  // own-override read was not invalidated, so the note kept saying B after C
  // was saved. The follow memory's release of that save is covered where the
  // real save coordinator is mounted (use-settings-save.test.tsx).
  it("invalidates this computer's own-value read after a savedLocally answer", async () => {
    const run = mount({
      saveAnswersLocally: true,
      applyStatus: 200,
      applyBody: {},
    });
    const invalidated: string[] = [];
    const invalidate = run.queryClient.invalidateQueries.bind(run.queryClient);
    vi.spyOn(run.queryClient, "invalidateQueries").mockImplementation(
      (filters, options) => {
        invalidated.push(JSON.stringify(filters?.queryKey));
        return invalidate(filters, options);
      },
    );
    const value = screen.getByLabelText<HTMLInputElement>(`Value for ${KEY}`);
    const saved = mutationsSettled(run.queryClient);
    fireEvent.change(value, { target: { value: NEW_C } });
    fireEvent.blur(value);
    await saved;
    await commitRender();

    expect(run.setEnvOverride).toHaveBeenCalledTimes(1);
    expect(
      invalidated.some((key) => key.includes('"environment.localOverrides"')),
    ).toBe(true);
    expect(run.saveToPersonal).not.toHaveBeenCalled();
    expect(run.clear).not.toHaveBeenCalled();
  });
});
