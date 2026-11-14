import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useState, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createRequestContext,
  identityFromAuthenticatedUser,
  type RequestContext,
} from "@traycer/protocol/auth/request-context";
import { hostRpcRegistry } from "@traycer/protocol/host/registry";
import {
  providerMutationCliStateSchemaV21,
  providersBeginApiKeyChangeResponseSchema,
  providersSetApiKeyResponseSchema,
  providersSettleApiKeyChangeResponseSchema,
} from "@traycer/protocol/host/provider-schemas";
import {
  MockHostMessenger,
  type MockHandlerMap,
} from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import {
  HostClient,
  type IHostQueryInvalidator,
} from "@traycer-clients/shared/host-client/host-client";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import { createAuthenticatedUserFixture } from "@traycer-clients/shared/test-fixtures/authenticated-user";
import { hostV115MutationV20Fixtures } from "@traycer/protocol/host/__tests__/__fixtures__/host-v1.1.5-mutation-v20";
import { ProviderApiKeySection } from "@/components/settings/panels/provider-api-key-section";
import {
  apiKeyState,
  storedApiKeyState,
} from "./provider-api-key-section-fixture";

const mocks = vi.hoisted(() => ({
  hostClient: vi.fn(),
  authService: vi.fn(),
  openLink: vi.fn(),
  toastError: vi.fn(),
  mobileApp: false,
  mobilePlatform: "ios" as "ios" | "android" | null,
}));

vi.mock("@/lib/host", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/host")>();
  return {
    ...actual,
    useHostClient: () => mocks.hostClient(),
    useAuthService: () => mocks.authService(),
  };
});

vi.mock("@/lib/links/open-link", () => ({
  useOpenLink: () => mocks.openLink,
}));

vi.mock("@/lib/mobile-app", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/mobile-app")>();
  return {
    ...actual,
    isMobileApp: () => mocks.mobileApp,
    getMobileAppPlatform: () => mocks.mobilePlatform,
  };
});

vi.mock("sonner", async (importOriginal) => {
  const actual = await importOriginal<typeof import("sonner")>();
  return {
    ...actual,
    toast: { ...actual.toast, error: mocks.toastError },
  };
});

vi.mock("@/lib/analytics", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/analytics")>();
  return {
    ...actual,
    Analytics: { getInstance: () => ({ track: vi.fn() }) },
  };
});

const API_KEY = "synthetic-provider-key";
const ENVIRONMENT_ID = "env-synthetic";
const PROFILE_ID = "profile-synthetic";
const STATE = providerMutationCliStateSchemaV21.parse({
  ...hostV115MutationV20Fixtures.minimalStatesByProviderId.codex,
  profiles: [],
});
const BEGIN_RESPONSE = providersBeginApiKeyChangeResponseSchema.parse({
  mode: "record",
  changeToken: "opaque-change-token",
  environmentId: ENVIRONMENT_ID,
});

interface Rig {
  readonly client: HostClient<typeof hostRpcRegistry>;
  readonly context: RequestContext;
}

const rigs: Rig[] = [];

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function makeRig(
  result:
    | "installed"
    | "unchanged"
    | "kept-local"
    | "refused"
    | "dropped"
    | "unavailable",
  beginError: HostRpcError | null,
): Rig {
  const handlers: MockHandlerMap<typeof hostRpcRegistry> = {
    "providers.beginApiKeyChange": () => {
      if (beginError !== null) throw beginError;
      return BEGIN_RESPONSE;
    },
    "providers.settleApiKeyChange": () =>
      providersSettleApiKeyChangeResponseSchema.parse({ result, state: STATE }),
    "providers.setApiKey": () =>
      providersSetApiKeyResponseSchema.parse({ state: STATE }),
    "providers.clearApiKey": () =>
      providersSetApiKeyResponseSchema.parse({ state: STATE }),
  };
  const messenger = new MockHostMessenger({
    registry: hostRpcRegistry,
    handlers,
    requestId: () => "request-synthetic",
  });
  const directory = new Map([[mockLocalHostEntry.hostId, mockLocalHostEntry]]);
  const invalidator: IHostQueryInvalidator = {
    invalidateHostScope: () => undefined,
  };
  const client = new HostClient({
    registry: hostRpcRegistry,
    messenger,
    invalidator,
    requestCoordinator: null,
    findHostById: (hostId) => directory.get(hostId) ?? null,
  });
  const context = createRequestContext({
    identity: identityFromAuthenticatedUser(
      createAuthenticatedUserFixture(undefined),
    ),
    bearerToken: "synthetic-session-token",
    origin: "test",
    connectionId: undefined,
    operationId: undefined,
    externalAbortSignal: undefined,
    cloudAuthorized: true,
  });
  client.setRequestContext(context);
  const requester = client.createRequesterForHostId(mockLocalHostEntry.hostId);
  mocks.hostClient.mockReturnValue(requester);
  mocks.authService.mockReturnValue({
    changeProviderKeyRecord: async (
      _environmentId: string,
      providerId: string,
      change: { readonly action: "set" | "clear" },
    ) => ({
      kind: "record",
      record: {
        profileId: PROFILE_ID,
        providerId,
        state: change.action === "set" ? "live" : "removed",
        signInNumber: "3",
        recordRevision: "5",
        personIntentNumber: "2",
      },
    }),
  });
  const rig = { client, context };
  rigs.push(rig);
  return rig;
}

function SettingsHarness(props: { readonly stored: boolean }): ReactNode {
  const [draft, setDraft] = useState(props.stored ? "" : API_KEY);
  return (
    <ProviderApiKeySection
      state={props.stored ? storedApiKeyState("cursor") : apiKeyState("cursor")}
      draft={draft}
      onDraftChange={setDraft}
    />
  );
}

function renderSettings(stored: boolean): void {
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false } },
  });
  render(<SettingsHarness stored={stored} />, {
    wrapper: ({ children }: { readonly children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    ),
  });
}

function apiKeyDraft(): string {
  const input = screen.getByLabelText("API key");
  if (!(input instanceof HTMLInputElement)) {
    throw new Error("API key field was not an input");
  }
  return input.value;
}

function updateRequiredError(): HostRpcError {
  return new HostRpcError({
    code: "update-required",
    message: "Update required",
    requestId: "request-synthetic",
    method: "providers.beginApiKeyChange",
    fatalDetails: null,
  });
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.useRealTimers();
  mocks.mobileApp = false;
  mocks.mobilePlatform = "ios";
  for (const rig of rigs.splice(0)) {
    rig.context.release();
    rig.client.dispose();
  }
});

describe("provider API-key change Settings flow", () => {
  it.each(["installed", "unchanged"] as const)(
    "keeps %s silent and clears the submitted draft",
    async (result) => {
      makeRig(result, null);
      mocks.mobileApp = false;
      renderSettings(false);

      fireEvent.click(screen.getByRole("button", { name: "Save" }));

      await waitFor(() => expect(apiKeyDraft()).toBe(""));
      expect(mocks.toastError).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["kept-local", "The API key was saved, but this computer is not using it."],
    ["refused", "The API key was saved, but this computer is not using it."],
    ["dropped", "The API key was saved, but this computer is not using it."],
    [
      "unavailable",
      "The API key was saved, but this computer may not be using it.",
    ],
  ] as const)(
    "shows the set notice for %s and clears the draft",
    async (result, message) => {
      makeRig(result, null);
      mocks.mobileApp = false;
      renderSettings(false);

      fireEvent.click(screen.getByRole("button", { name: "Save" }));

      await waitFor(() => expect(apiKeyDraft()).toBe(""));
      expect(
        mocks.toastError.mock.calls.some(([shown]) => shown === message),
      ).toBe(true);
    },
  );

  it.each([
    [
      "kept-local",
      "The API key was removed, but this computer was not changed.",
    ],
    ["refused", "The API key was removed, but this computer was not changed."],
    ["dropped", "The API key was removed, but this computer was not changed."],
    [
      "unavailable",
      "The API key was removed, but this computer may not have changed.",
    ],
  ] as const)("shows the clear notice for %s", async (result, message) => {
    makeRig(result, null);
    mocks.mobileApp = false;
    renderSettings(true);

    fireEvent.click(screen.getByRole("button", { name: "Clear" }));

    await waitFor(() =>
      expect(
        mocks.toastError.mock.calls.some(([shown]) => shown === message),
      ).toBe(true),
    );
  });

  it("keeps a forbidden draft intact and leaves the established permission copy visible", async () => {
    const forbidden = new HostRpcError({
      code: "FORBIDDEN",
      message: "Host refused request",
      requestId: "request-synthetic",
      method: "providers.beginApiKeyChange",
      fatalDetails: null,
    });
    makeRig("installed", forbidden);
    mocks.mobileApp = false;
    renderSettings(false);

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(mocks.toastError.mock.calls.length > 0).toBe(true),
    );
    expect(apiKeyDraft() === API_KEY).toBe(true);
    expect(
      mocks.toastError.mock.calls.some(
        ([shown]) => shown === "You don't have permission to do that.",
      ),
    ).toBe(true);
  });

  it("offers the desktop app release action for update-required", async () => {
    makeRig("installed", updateRequiredError());
    mocks.mobileApp = false;
    renderSettings(false);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(mocks.toastError.mock.calls.length > 0).toBe(true),
    );
    const toastCall = mocks.toastError.mock.calls[0];
    const options = recordOf(toastCall?.[1]);
    const action = recordOf(options?.action);
    const onClick = action?.onClick;
    expect(
      toastCall?.[0] === "Your app is too old" &&
        action?.label === "Update the app" &&
        typeof onClick === "function",
    ).toBe(true);
    if (typeof onClick === "function") Reflect.apply(onClick, undefined, []);
    expect(mocks.openLink.mock.calls.length === 1).toBe(true);
  });

  it.each([
    [
      "ios",
      "Update the Traycer app in TestFlight or the App Store, then reopen it.",
    ],
    ["android", "Update the Traycer app in Google Play, then reopen it."],
  ] as const)(
    "shows the %s store instruction without an action",
    async (platform, note) => {
      makeRig("installed", updateRequiredError());
      mocks.mobileApp = true;
      mocks.mobilePlatform = platform;
      renderSettings(false);
      fireEvent.click(screen.getByRole("button", { name: "Save" }));

      await waitFor(() =>
        expect(mocks.toastError.mock.calls.length > 0).toBe(true),
      );
      const toastCall = mocks.toastError.mock.calls[0];
      const options = recordOf(toastCall?.[1]);
      expect(
        toastCall?.[0] === "Your app is too old" &&
          options?.description === note &&
          !Object.hasOwn(options, "action"),
      ).toBe(true);
    },
  );
});
