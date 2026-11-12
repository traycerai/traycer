import "../../../../__tests__/test-browser-apis";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toast as sonnerToast } from "sonner";
import type { ConnectionManifest } from "@traycer/protocol/framework/index";
import type { RpcErrorCode } from "@traycer/protocol/framework/versioned-rpc-types";
import type {
  ProvidersLinkCompleteResponseV12,
  ProvidersLinkRequestV12,
  ProvidersLinkResponseV12,
} from "@traycer/protocol/host/environment-schemas";
import type {
  ProviderCliState,
  ProviderProfile,
} from "@traycer/protocol/host/provider-schemas";
import { markMayHaveReachedHost } from "@traycer/protocol/host-transport/remote/rpc-types";
import { EnvironmentProfileSignIn } from "@/components/providers/environment-profile-sign-in";
import {
  buildEnvironmentClient,
  type EnvironmentClientFixture,
} from "@/lib/environment/__tests__/environment-test-support";
import { hostRpcRegistry } from "@/lib/host";
import {
  LINK_NO_SIGN_IN,
  LINK_OUTCOME_UNKNOWN,
} from "@/lib/providers/provider-link-copy";
import {
  ACCOUNT_MISMATCH_SIGN_IN_LINE,
  ACCOUNT_UNIDENTIFIED_SIGN_IN_LINE,
  REPLACE_PROFILE_ACCOUNT_LINE,
  SIGNED_IN_RECEIVING_LINE,
} from "@traycer-clients/shared/providers/environment-profile-sign-in";
import {
  HostRpcError,
  HostTransportFailureError,
  type RequestOfMethod,
  type ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import { providersListQueryKey } from "@/lib/query-keys/providers-query-keys";
import {
  createCallEvents,
  type CallEvents,
} from "./environment-sign-in-call-events";
import {
  recordNegotiatedHostManifest,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";

const toast = vi.hoisted(() => ({ info: vi.fn() }));
vi.mock("sonner", () => ({ toast }));
const openLinkMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/links/open-link", () => ({
  useOpenLink: () => openLinkMock,
}));

const HOST_ID = "host-environment-sign-in";
const ENVIRONMENT_ID = "environment-sign-in";
const ENVIRONMENT_PROFILE_ID = "environment-profile-alias";
const MANAGED_PROFILE_ID = "managed-profile-local";
const OLD_ADMITTED_PROFILE_ID = "managed-profile-old-admitted";
const CODE = "SIGN-IN-CODE#state";
const V12 = { major: 1, minor: 2 } as const;
type LinkCompleteRequest = RequestOfMethod<
  typeof hostRpcRegistry,
  "providers.linkComplete"
>;

const CREATE_PROFILE_REQUEST: ProvidersLinkRequestV12 = {
  providerId: "claude-code",
  profileId: null,
  environmentId: ENVIRONMENT_ID,
  createProfile: { label: "Work profile", shareSkillsAndPlugins: true },
  replaceAccount: false,
};

const DEVICE_REQUEST: ProvidersLinkRequestV12 = {
  providerId: "codex",
  profileId: null,
  environmentId: ENVIRONMENT_ID,
  createProfile: { label: "Work profile", shareSkillsAndPlugins: false },
  replaceAccount: false,
};

const EXISTING_PROFILE_REQUEST: ProvidersLinkRequestV12 = {
  providerId: "claude-code",
  profileId: MANAGED_PROFILE_ID,
  environmentId: ENVIRONMENT_ID,
  createProfile: null,
  replaceAccount: false,
};

const SIGN_IN_URL_RESPONSE: ProvidersLinkResponseV12 = {
  linkId: "link-attempt",
  environmentProfileId: ENVIRONMENT_PROFILE_ID,
  prompt: {
    kind: "sign_in_url",
    url: "https://auth.example.test/sign-in",
    codePrompt: "One-time code",
  },
};

type LinkHandler = (
  request: ProvidersLinkRequestV12,
) => ProvidersLinkResponseV12 | Promise<ProvidersLinkResponseV12>;
type CompleteHandler = (
  request: LinkCompleteRequest,
  callNumber: number,
) =>
  | ProvidersLinkCompleteResponseV12
  | Promise<ProvidersLinkCompleteResponseV12>;
type ProviderListHandler = (
  callNumber: number,
) =>
  | ResponseOfMethod<typeof hostRpcRegistry, "providers.list">
  | Promise<ResponseOfMethod<typeof hostRpcRegistry, "providers.list">>;

type Completion = {
  readonly environmentProfileId: string | null;
  readonly profile: ProviderProfile | null;
};

function completionObserver() {
  const completed = Promise.withResolvers<Completion>();
  return {
    completed: completed.promise,
    onComplete: vi.fn((completion: Completion) =>
      completed.resolve(completion),
    ),
  };
}

interface EnvironmentSignInHostOptions {
  readonly hostId?: string;
  readonly link?: LinkHandler;
  readonly complete?: CompleteHandler;
  readonly providersList?: ProviderListHandler;
}

interface EnvironmentSignInHost {
  readonly client: EnvironmentClientFixture["client"];
  readonly linkRequests: ProvidersLinkRequestV12[];
  readonly completeRequests: LinkCompleteRequest[];
  readonly cancelRequests: RequestOfMethod<
    typeof hostRpcRegistry,
    "providers.linkCancel"
  >[];
  readonly providersListCalls: number[];
  readonly linkEvents: CallEvents;
  readonly completeEvents: CallEvents;
  readonly cancelEvents: CallEvents;
  readonly providersListEvents: CallEvents;
}

function negotiatedManifest(): ConnectionManifest {
  return {
    "providers.link": V12,
    "providers.linkComplete": V12,
    "providers.linkCancel": { major: 1, minor: 0 },
    "providers.list": { major: 10, minor: 9 },
  };
}

function makeHost(
  options: EnvironmentSignInHostOptions | undefined,
): EnvironmentSignInHost {
  const hostId = options?.hostId ?? HOST_ID;
  const linkRequests: ProvidersLinkRequestV12[] = [];
  const completeRequests: LinkCompleteRequest[] = [];
  const cancelRequests: EnvironmentSignInHost["cancelRequests"] = [];
  const providersListCalls: number[] = [];
  const linkEvents = createCallEvents();
  const completeEvents = createCallEvents();
  const cancelEvents = createCallEvents();
  const providersListEvents = createCallEvents();
  const fixture = buildEnvironmentClient({
    hostId,
    handlers: {
      "providers.link": (request) => {
        linkRequests.push(request);
        linkEvents.emit();
        return options?.link?.(request) ?? SIGN_IN_URL_RESPONSE;
      },
      "providers.linkComplete": (request) => {
        completeRequests.push(request);
        completeEvents.emit();
        return (
          options?.complete?.(request, completeRequests.length) ?? {
            state: "pending",
            code: null,
            account: null,
            expectedAccount: null,
            environmentProfileId: ENVIRONMENT_PROFILE_ID,
            profileId: null,
          }
        );
      },
      "providers.linkCancel": (request) => {
        cancelRequests.push(request);
        cancelEvents.emit();
        return {};
      },
      "providers.list": () => {
        const callNumber = providersListCalls.length + 1;
        providersListCalls.push(callNumber);
        providersListEvents.emit();
        return (
          options?.providersList?.(callNumber) ?? {
            providers: [],
            native: null,
          }
        );
      },
    },
  });
  recordNegotiatedHostManifest(hostId, negotiatedManifest());
  return {
    client: fixture.client,
    linkRequests,
    completeRequests,
    cancelRequests,
    providersListCalls,
    linkEvents,
    completeEvents,
    cancelEvents,
    providersListEvents,
  };
}

function managedProfile(
  profileId: string,
  label: string,
  environmentProfileId: string | null,
  presence: NonNullable<ProviderProfile["presence"]>,
): ProviderProfile {
  return {
    profileId,
    enabled: true,
    kind: "managed",
    authType: "oauth",
    label,
    auth: {
      status: "authenticated",
      badgeText: null,
      label: null,
      detail: null,
    },
    identity: null,
    usageUpdatedAt: null,
    rateLimitStatus: "unknown",
    rateLimitLimitedScopes: null,
    duplicateOfProfileId: null,
    accentColor: null,
    ambientDriftNotice: null,
    environmentProfileId,
    presence,
  };
}

function providerState(
  providerId: ProviderCliState["providerId"],
  profiles: readonly ProviderProfile[],
): ProviderCliState {
  return {
    providerId,
    enabled: true,
    disabledBy: null,
    selected: { kind: "bundled" },
    candidates: [],
    auth: {
      status: "authenticated",
      badgeText: null,
      label: null,
      detail: null,
    },
    authPending: false,
    checkedAt: null,
    apiKey: { supported: false, configured: false, source: null },
    terminalAgentArgs: "",
    envOverrides: [],
    loginCapability: null,
    availabilityPending: false,
    nativeCapabilities: {
      supportedTabs: ["general", "env", "usage"],
      mcp: null,
      plugins: null,
      skills: null,
      modelProviders: null,
    },
    managedInstallState: null,
    versionVisibility: null,
    advisory: null,
    profiles: [...profiles],
  };
}

function renderSignIn(input: {
  readonly host: EnvironmentSignInHost;
  readonly request: ProvidersLinkRequestV12;
  readonly waitForLocalProfile: boolean;
  readonly onComplete: (completion: {
    readonly environmentProfileId: string | null;
    readonly profile: ProviderProfile | null;
  }) => void;
  readonly onCancel: () => void;
  readonly onNotOffered?: () => void;
  readonly team?: boolean;
  readonly onDeliveryPending?: (certifiedProfileId: string | null) => void;
}) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  return {
    ...render(
      <QueryClientProvider client={queryClient}>
        <EnvironmentProfileSignIn
          client={input.host.client}
          request={input.request}
          waitForLocalProfile={input.waitForLocalProfile}
          team={input.team ?? true}
          ruleAboveWaitingStep={false}
          reportSource="Add profile"
          onComplete={input.onComplete}
          onNotOffered={input.onNotOffered ?? null}
          {...(input.onDeliveryPending === undefined
            ? {}
            : { onDeliveryPending: input.onDeliveryPending })}
          onCancel={input.onCancel}
        />
      </QueryClientProvider>,
    ),
    queryClient,
  };
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  openLinkMock.mockReset();
  resetNegotiatedManifests();
});

beforeEach(() => {
  toast.info.mockClear();
});

describe("<EnvironmentProfileSignIn />", () => {
  it("waits for the admitted local profile to authenticate before completing", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const profile = managedProfile(
      MANAGED_PROFILE_ID,
      "Claude on this computer",
      ENVIRONMENT_PROFILE_ID,
      { kind: "admitted", bindingVersion: 1 },
    );
    const unauthenticatedProfile: ProviderProfile = {
      ...profile,
      auth: { ...profile.auth, status: "unauthenticated" },
    };
    let inventoryAuthenticated = false;
    const host = makeHost({
      complete: () => ({
        state: "installing",
        code: null,
        account: null,
        expectedAccount: null,
        environmentProfileId: ENVIRONMENT_PROFILE_ID,
        profileId: null,
      }),
      providersList: () => ({
        providers: [
          providerState("claude-code", [
            inventoryAuthenticated ? profile : unauthenticatedProfile,
          ]),
        ],
        native: null,
      }),
    });
    const { onComplete, completed } = completionObserver();
    const onCancel = vi.fn();
    renderSignIn({
      host,
      request: CREATE_PROFILE_REQUEST,
      waitForLocalProfile: true,
      onComplete,
      onCancel,
    });

    await screen.findByLabelText("Paste the code");
    expect(host.linkRequests).toEqual([
      {
        ...CREATE_PROFILE_REQUEST,
        replaceAccount: false,
      },
    ]);
    fireEvent.change(screen.getByLabelText("Paste the code"), {
      target: { value: CODE },
    });
    fireEvent.click(screen.getByRole("button", { name: "Submit code" }));

    await screen.findByText(SIGNED_IN_RECEIVING_LINE);
    await host.providersListEvents.waitFor(1);
    expect(onComplete).not.toHaveBeenCalled();
    const readsBeforeUnauthenticatedRefresh = host.providersListCalls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    await host.providersListEvents.waitFor(
      readsBeforeUnauthenticatedRefresh + 1,
    );
    expect(onComplete).not.toHaveBeenCalled();

    inventoryAuthenticated = true;
    const readsBeforeAuthenticatedRefresh = host.providersListCalls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    await host.providersListEvents.waitFor(readsBeforeAuthenticatedRefresh + 1);
    await expect(completed).resolves.toEqual({
      account: null,
      environmentProfileId: ENVIRONMENT_PROFILE_ID,
      profile,
    });
    expect(onComplete).toHaveBeenCalledExactlyOnceWith({
      account: null,
      environmentProfileId: ENVIRONMENT_PROFILE_ID,
      profile,
    });
    expect(host.completeRequests[0]).toEqual({
      linkId: "link-attempt",
      code: CODE,
      environmentId: ENVIRONMENT_ID,
    });
    expect(
      host.completeRequests.slice(1).every(({ code }) => code === null),
    ).toBe(true);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("polls Codex device sign-in and waits for admitted inventory by ids rather than label", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const placeholder = managedProfile(
      "not-admitted-yet",
      "Work profile",
      ENVIRONMENT_PROFILE_ID,
      { kind: "placeholder-only" },
    );
    const admitted = managedProfile(
      MANAGED_PROFILE_ID,
      "Codex local label differs",
      ENVIRONMENT_PROFILE_ID,
      { kind: "admitted", bindingVersion: 1 },
    );
    const host = makeHost({
      link: () => ({
        linkId: "link-codex-device",
        environmentProfileId: ENVIRONMENT_PROFILE_ID,
        prompt: {
          kind: "device_code",
          verificationUrl: "https://auth.example.test/device",
          userCode: "DEVICE-CODE",
          expiresAt: 1,
        },
      }),
      complete: (_request, callNumber) =>
        callNumber === 1
          ? {
              state: "pending",
              code: null,
              account: null,
              expectedAccount: null,
              environmentProfileId: ENVIRONMENT_PROFILE_ID,
              profileId: null,
            }
          : {
              state: "installing",
              code: null,
              account: null,
              expectedAccount: null,
              environmentProfileId: ENVIRONMENT_PROFILE_ID,
              profileId: null,
            },
      providersList: (callNumber) => ({
        providers: [
          providerState("codex", callNumber === 1 ? [placeholder] : [admitted]),
        ],
        native: null,
      }),
    });
    const { onComplete, completed } = completionObserver();
    const onCancel = vi.fn();
    renderSignIn({
      host,
      request: DEVICE_REQUEST,
      waitForLocalProfile: true,
      onComplete,
      onCancel,
    });

    expect(await screen.findByText("DEVICE-CODE")).toBeTruthy();
    expect(host.linkRequests).toEqual([
      {
        ...DEVICE_REQUEST,
        replaceAccount: false,
      },
    ]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    await host.completeEvents.waitFor(1);
    expect(host.completeRequests).toHaveLength(1);
    expect(host.completeRequests[0]).toEqual({
      linkId: "link-codex-device",
      code: null,
      environmentId: ENVIRONMENT_ID,
    });
    expect(screen.getByText("DEVICE-CODE")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open browser again" }));
    expect(openLinkMock).toHaveBeenCalledWith(
      "https://auth.example.test/device",
      "auth",
      null,
    );
    expect(
      screen.getByRole("button", { name: "Open browser again" }),
    ).toBeTruthy();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    await host.completeEvents.waitFor(2);
    expect(host.completeRequests).toHaveLength(2);
    expect(host.providersListCalls).toEqual([1]);
    expect(onComplete).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    await host.providersListEvents.waitFor(2);
    expect(host.providersListCalls).toEqual([1, 2]);
    await expect(completed).resolves.toEqual({
      account: null,
      environmentProfileId: ENVIRONMENT_PROFILE_ID,
      profile: admitted,
    });
    expect(onComplete).toHaveBeenCalledExactlyOnceWith({
      account: null,
      environmentProfileId: ENVIRONMENT_PROFILE_ID,
      profile: admitted,
    });
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("waits for an existing profile's linked local id before accepting fresh inventory", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const oldAdmitted = managedProfile(
      OLD_ADMITTED_PROFILE_ID,
      "Work profile",
      ENVIRONMENT_PROFILE_ID,
      { kind: "admitted", bindingVersion: 1 },
    );
    const linkedProfile = managedProfile(
      MANAGED_PROFILE_ID,
      "Claude on this computer",
      ENVIRONMENT_PROFILE_ID,
      { kind: "admitted", bindingVersion: 1 },
    );
    let linked = false;
    const host = makeHost({
      complete: (_request, callNumber) => {
        if (callNumber === 3) linked = true;
        return {
          state: linked ? "linked" : "installing",
          code: null,
          account: null,
          expectedAccount: null,
          environmentProfileId: ENVIRONMENT_PROFILE_ID,
          profileId: linked ? MANAGED_PROFILE_ID : null,
        };
      },
      providersList: () => ({
        providers: [
          providerState(
            "claude-code",
            linked ? [oldAdmitted, linkedProfile] : [oldAdmitted],
          ),
        ],
        native: null,
      }),
    });
    const { onComplete, completed } = completionObserver();
    const onCancel = vi.fn();
    renderSignIn({
      host,
      request: EXISTING_PROFILE_REQUEST,
      waitForLocalProfile: true,
      onComplete,
      onCancel,
    });

    await screen.findByLabelText("Paste the code");
    fireEvent.change(screen.getByLabelText("Paste the code"), {
      target: { value: CODE },
    });
    fireEvent.click(screen.getByRole("button", { name: "Submit code" }));
    await screen.findByText(SIGNED_IN_RECEIVING_LINE);
    await host.providersListEvents.waitFor(1);
    expect(host.completeRequests).toHaveLength(1);
    expect(onComplete).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    await host.completeEvents.waitFor(2);
    expect(host.completeRequests).toHaveLength(2);
    expect(onComplete).not.toHaveBeenCalled();
    const inventoryReadsBeforeLinked = host.providersListCalls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    await host.completeEvents.waitFor(3);
    await host.providersListEvents.waitFor(inventoryReadsBeforeLinked + 1);
    expect(host.providersListCalls.length).toBeGreaterThan(
      inventoryReadsBeforeLinked,
    );
    await expect(completed).resolves.toEqual({
      account: null,
      environmentProfileId: ENVIRONMENT_PROFILE_ID,
      profile: linkedProfile,
    });
    expect(host.completeRequests).toHaveLength(3);
    expect(host.completeRequests.map(({ code }) => code)).toEqual([
      CODE,
      null,
      null,
    ]);
    expect(onComplete).toHaveBeenCalledExactlyOnceWith({
      account: null,
      environmentProfileId: ENVIRONMENT_PROFILE_ID,
      profile: linkedProfile,
    });
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("keeps a connected profile pending through a poll failure and unavailable reply", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const profile = managedProfile(
      MANAGED_PROFILE_ID,
      "Claude on this computer",
      ENVIRONMENT_PROFILE_ID,
      { kind: "admitted", bindingVersion: 1 },
    );
    const host = makeHost({
      complete: (_request, callNumber) => {
        if (callNumber === 1) {
          return {
            state: "installing",
            code: null,
            account: null,
            expectedAccount: null,
            environmentProfileId: ENVIRONMENT_PROFILE_ID,
            profileId: null,
          };
        }
        if (callNumber === 2)
          return Promise.reject(new Error("Fake completion read failed."));
        if (callNumber === 3) {
          return {
            state: "unavailable",
            code: null,
            account: null,
            expectedAccount: null,
            environmentProfileId: ENVIRONMENT_PROFILE_ID,
            profileId: null,
          };
        }
        return {
          state: "linked",
          code: null,
          account: null,
          expectedAccount: null,
          environmentProfileId: ENVIRONMENT_PROFILE_ID,
          profileId: MANAGED_PROFILE_ID,
        };
      },
      providersList: () => ({
        providers: [providerState("claude-code", [profile])],
        native: null,
      }),
    });
    const { onComplete, completed } = completionObserver();
    const onCancel = vi.fn();
    renderSignIn({
      host,
      request: EXISTING_PROFILE_REQUEST,
      waitForLocalProfile: true,
      onComplete,
      onCancel,
    });

    await screen.findByLabelText("Paste the code");
    fireEvent.change(screen.getByLabelText("Paste the code"), {
      target: { value: CODE },
    });
    fireEvent.click(screen.getByRole("button", { name: "Submit code" }));
    await screen.findByText(SIGNED_IN_RECEIVING_LINE);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    await host.completeEvents.waitFor(2);
    expect(host.completeRequests).toHaveLength(2);
    expect(host.linkRequests).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(onComplete).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    await host.completeEvents.waitFor(3);
    expect(host.completeRequests).toHaveLength(3);
    expect(host.linkRequests).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(onComplete).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    await host.completeEvents.waitFor(4);
    await expect(completed).resolves.toEqual({
      account: null,
      environmentProfileId: ENVIRONMENT_PROFILE_ID,
      profile,
    });
    expect(onComplete).toHaveBeenCalledExactlyOnceWith({
      account: null,
      environmentProfileId: ENVIRONMENT_PROFILE_ID,
      profile,
    });
    expect(host.completeRequests).toEqual([
      { linkId: "link-attempt", code: CODE, environmentId: ENVIRONMENT_ID },
      { linkId: "link-attempt", code: null, environmentId: ENVIRONMENT_ID },
      { linkId: "link-attempt", code: null, environmentId: ENVIRONMENT_ID },
      { linkId: "link-attempt", code: null, environmentId: ENVIRONMENT_ID },
    ]);
    expect(host.linkRequests).toEqual([
      { ...EXISTING_PROFILE_REQUEST, replaceAccount: false },
    ]);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it.each([
    ["no_sign_in", "no_sign_in", LINK_NO_SIGN_IN],
    ["generic failure", null, "Sign-in did not finish. Try again."],
  ] as const)(
    "shows recovery copy for a failed %s completion",
    async (_description, code, expectedLine) => {
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
      const pollIntervalRegistered = Promise.withResolvers<void>();
      const intervalWindow: Pick<Window, "setInterval"> = window;
      const realSetInterval = intervalWindow.setInterval.bind(intervalWindow);
      const intervalSpy = vi
        .spyOn(intervalWindow, "setInterval")
        .mockImplementation((handler, timeout) => {
          const intervalId = realSetInterval(handler, timeout);
          if (timeout === 2_000) pollIntervalRegistered.resolve();
          return intervalId;
        });
      const host = makeHost({
        link: () => ({
          linkId: "link-local-handoff",
          environmentProfileId: ENVIRONMENT_PROFILE_ID,
          prompt: { kind: "local_handoff" },
        }),
        complete: () => ({
          state: "failed",
          code,
          account: null,
          expectedAccount: null,
          environmentProfileId: ENVIRONMENT_PROFILE_ID,
          profileId: null,
        }),
      });
      try {
        renderSignIn({
          host,
          request: CREATE_PROFILE_REQUEST,
          waitForLocalProfile: true,
          onComplete: vi.fn(),
          onCancel: vi.fn(),
        });

        expect(await screen.findByText("Waiting for sign-in…")).toBeTruthy();
        await pollIntervalRegistered.promise;
        await act(async () => {
          await vi.advanceTimersByTimeAsync(2_000);
        });
        await host.completeEvents.waitFor(1);
        expect((await screen.findByRole("alert")).textContent).toBe(
          expectedLine,
        );
        expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
        expect(host.linkRequests).toHaveLength(1);
        expect(host.completeRequests).toEqual([
          {
            linkId: "link-local-handoff",
            code: null,
            environmentId: ENVIRONMENT_ID,
          },
        ]);
      } finally {
        intervalSpy.mockRestore();
      }
    },
  );

  it.each([
    ["a new profile", CREATE_PROFILE_REQUEST],
    ["an existing profile", EXISTING_PROFILE_REQUEST],
  ] as const)(
    "treats expiry after connection for %s as still receiving on this computer",
    async (_description, request) => {
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
      const host = makeHost({
        complete: (_request, callNumber) =>
          callNumber === 1
            ? {
                state: "installing",
                code: null,
                account: null,
                expectedAccount: null,
                environmentProfileId: ENVIRONMENT_PROFILE_ID,
                profileId: null,
              }
            : {
                state: "expired",
                code: null,
                account: null,
                expectedAccount: null,
                environmentProfileId: ENVIRONMENT_PROFILE_ID,
                profileId: null,
              },
        providersList: () => ({ providers: [], native: null }),
      });
      const onComplete = vi.fn();
      const deliveryFinished = Promise.withResolvers<void>();
      const onCancel = vi.fn(() => deliveryFinished.resolve());
      renderSignIn({
        host,
        request,
        waitForLocalProfile: true,
        onComplete,
        onCancel,
      });

      await screen.findByLabelText("Paste the code");
      fireEvent.change(screen.getByLabelText("Paste the code"), {
        target: { value: CODE },
      });
      fireEvent.click(screen.getByRole("button", { name: "Submit code" }));
      await screen.findByText(SIGNED_IN_RECEIVING_LINE);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_000);
      });
      await host.completeEvents.waitFor(2);
      await deliveryFinished.promise;

      expect(host.completeRequests).toHaveLength(2);
      const inventoryReadsAtExpiry = host.providersListCalls.length;
      expect(sonnerToast.info).toHaveBeenCalledWith(SIGNED_IN_RECEIVING_LINE);
      expect(onComplete).not.toHaveBeenCalled();
      expect(onCancel).toHaveBeenCalledOnce();
      // Handed to the caller, which closes: the step shows nothing more.
      expect(screen.queryAllByRole("button")).toEqual([]);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(20_000);
      });
      await host.completeEvents.waitFor(2);
      expect(host.completeRequests).toHaveLength(2);
      expect(host.providersListCalls).toHaveLength(inventoryReadsAtExpiry);
    },
  );

  it.each(["unavailable", "unauthenticated"] as const)(
    "ends a certified link with delivery pending when fresh local inventory is %s",
    async (inventoryState) => {
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
      const unauthenticatedProfile: ProviderProfile = {
        ...managedProfile(
          MANAGED_PROFILE_ID,
          "Claude on this computer",
          ENVIRONMENT_PROFILE_ID,
          { kind: "admitted", bindingVersion: 1 },
        ),
        auth: {
          status: "unauthenticated",
          badgeText: null,
          label: null,
          detail: null,
        },
      };
      const host = makeHost({
        complete: () => ({
          state: "linked",
          code: null,
          account: null,
          expectedAccount: null,
          environmentProfileId: ENVIRONMENT_PROFILE_ID,
          profileId: MANAGED_PROFILE_ID,
        }),
        providersList: () =>
          inventoryState === "unavailable"
            ? Promise.reject(new Error("Inventory unavailable."))
            : {
                providers: [
                  providerState("claude-code", [unauthenticatedProfile]),
                ],
                native: null,
              },
      });
      const onComplete = vi.fn();
      const deliveryPending = Promise.withResolvers<string | null>();
      const onDeliveryPending = vi.fn((certifiedProfileId: string | null) =>
        deliveryPending.resolve(certifiedProfileId),
      );
      const onCancel = vi.fn();
      renderSignIn({
        host,
        request: EXISTING_PROFILE_REQUEST,
        waitForLocalProfile: true,
        onComplete,
        onDeliveryPending,
        onCancel,
      });

      await screen.findByLabelText("Paste the code");
      fireEvent.change(screen.getByLabelText("Paste the code"), {
        target: { value: CODE },
      });
      fireEvent.click(screen.getByRole("button", { name: "Submit code" }));
      expect(await screen.findByRole("button", { name: "Done" })).toBeTruthy();
      await expect(deliveryPending.promise).resolves.toBe(MANAGED_PROFILE_ID);
      expect(host.providersListCalls).toEqual([1]);
      expect(sonnerToast.info).toHaveBeenCalledWith(SIGNED_IN_RECEIVING_LINE);
      expect(onComplete).not.toHaveBeenCalled();
      expect(onDeliveryPending).toHaveBeenCalledExactlyOnceWith(
        MANAGED_PROFILE_ID,
      );
      expect(onCancel).not.toHaveBeenCalled();
      expect(host.cancelRequests).toEqual([]);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(20_000);
      });
      expect(host.completeRequests).toHaveLength(1);
      expect(host.providersListCalls).toEqual([1]);
    },
  );

  it.each([
    ["host RPC_ERROR", "rpc-error"],
    ["successful unavailable response", "unavailable"],
  ] as const)(
    "keeps an unconfirmed completion unknown after %s despite authenticated inventory",
    async (_description, outcome) => {
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
      const profile = managedProfile(
        MANAGED_PROFILE_ID,
        "Claude on this computer",
        ENVIRONMENT_PROFILE_ID,
        { kind: "admitted", bindingVersion: 1 },
      );
      const inventory = {
        providers: [providerState("claude-code", [profile])],
        native: null,
      };
      const host = makeHost({
        complete:
          outcome === "rpc-error"
            ? () =>
                Promise.reject(
                  new HostRpcError({
                    code: "RPC_ERROR",
                    message: "The host could not confirm sign-in completion.",
                    requestId: "req-completion-unknown",
                    method: "providers.linkComplete",
                    fatalDetails: null,
                  }),
                )
            : () => ({
                state: "unavailable",
                code: null,
                account: null,
                expectedAccount: null,
                environmentProfileId: ENVIRONMENT_PROFILE_ID,
                profileId: null,
              }),
        providersList: () => inventory,
      });
      const onComplete = vi.fn();
      const onDeliveryPending = vi.fn();
      const onCancel = vi.fn();
      const view = renderSignIn({
        host,
        request: CREATE_PROFILE_REQUEST,
        waitForLocalProfile: true,
        onComplete,
        onDeliveryPending,
        onCancel,
      });
      const listQueryKey = providersListQueryKey(HOST_ID);
      const listQueryHash = view.queryClient
        .getQueryCache()
        .find({ queryKey: listQueryKey })?.queryHash;
      if (listQueryHash === undefined)
        throw new Error("Provider inventory query was not registered");
      const inventoryRead = Promise.withResolvers<void>();
      const stopObservingInventory = view.queryClient
        .getQueryCache()
        .subscribe((event) => {
          if (
            event.type === "updated" &&
            event.action.type === "success" &&
            event.query.queryHash === listQueryHash
          )
            inventoryRead.resolve();
        });

      await screen.findByLabelText("Paste the code");
      fireEvent.change(screen.getByLabelText("Paste the code"), {
        target: { value: CODE },
      });
      fireEvent.click(screen.getByRole("button", { name: "Submit code" }));
      await host.completeEvents.waitFor(1);

      expect(await screen.findByRole("alert")).toBeTruthy();
      expect(
        await screen.findByRole("button", { name: "Cancel" }),
      ).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
      await host.providersListEvents.waitFor(1);
      await inventoryRead.promise;
      stopObservingInventory();

      expect(view.queryClient.getQueryData(listQueryKey)).toEqual(inventory);
      expect(host.linkRequests).toEqual([
        { ...CREATE_PROFILE_REQUEST, replaceAccount: false },
      ]);
      expect(host.completeRequests).toEqual([
        {
          linkId: "link-attempt",
          code: CODE,
          environmentId: ENVIRONMENT_ID,
        },
      ]);
      expect(host.providersListCalls).toEqual([1]);
      expect(host.cancelRequests).toEqual([]);
      expect(onComplete).not.toHaveBeenCalled();
      expect(onDeliveryPending).not.toHaveBeenCalled();
      expect(onCancel).not.toHaveBeenCalled();
      expect(sonnerToast.info).not.toHaveBeenCalledWith(
        SIGNED_IN_RECEIVING_LINE,
      );

      await act(async () => {
        await vi.advanceTimersByTimeAsync(20_000);
      });
      expect(host.completeRequests).toHaveLength(1);
      expect(host.providersListCalls).toEqual([1]);
      expect(host.linkRequests).toHaveLength(1);

      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      expect(onCancel).toHaveBeenCalledOnce();
      expect(host.cancelRequests).toEqual([]);
      expect(onComplete).not.toHaveBeenCalled();
      expect(onDeliveryPending).not.toHaveBeenCalled();
    },
  );

  it("preserves an existing profile after a completion mismatch and requires confirmation before switching", async () => {
    const host = makeHost({
      complete: () => ({
        state: "mismatch",
        code: "harness_account_mismatch",
        account: null,
        expectedAccount: null,
        environmentProfileId: ENVIRONMENT_PROFILE_ID,
        profileId: null,
      }),
    });
    const onComplete = vi.fn();
    const onCancel = vi.fn();
    renderSignIn({
      host,
      request: EXISTING_PROFILE_REQUEST,
      waitForLocalProfile: true,
      onComplete,
      onCancel,
    });

    await screen.findByLabelText("Paste the code");
    fireEvent.change(screen.getByLabelText("Paste the code"), {
      target: { value: CODE },
    });
    fireEvent.click(screen.getByRole("button", { name: "Submit code" }));

    expect((await screen.findByRole("alert")).textContent).toBe(
      ACCOUNT_MISMATCH_SIGN_IN_LINE,
    );
    expect(host.linkRequests).toEqual([
      { ...EXISTING_PROFILE_REQUEST, replaceAccount: false },
    ]);
    expect(onComplete).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Switch account" }));
    expect(screen.getByText(REPLACE_PROFILE_ACCOUNT_LINE)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Switch account" }));
    await screen.findByLabelText("Paste the code");
    expect(host.linkRequests).toEqual([
      { ...EXISTING_PROFILE_REQUEST, replaceAccount: false },
      { ...EXISTING_PROFILE_REQUEST, replaceAccount: true },
    ]);
  });

  it("asks before replacing an existing profile after the host cannot identify the account", async () => {
    const host = makeHost({
      link: () =>
        Promise.reject(
          new HostRpcError({
            code: "harness_account_unidentified",
            message: "The account on this profile could not be confirmed.",
            requestId: "req-unidentified-start",
            method: "providers.link",
            fatalDetails: null,
          }),
        ),
    });
    const onComplete = vi.fn();
    const onCancel = vi.fn();
    renderSignIn({
      host,
      request: EXISTING_PROFILE_REQUEST,
      waitForLocalProfile: true,
      onComplete,
      onCancel,
    });

    expect((await screen.findByRole("alert")).textContent).toBe(
      ACCOUNT_UNIDENTIFIED_SIGN_IN_LINE,
    );
    expect(host.linkRequests).toEqual([
      { ...EXISTING_PROFILE_REQUEST, replaceAccount: false },
    ]);
    expect(host.completeRequests).toEqual([]);
    expect(host.providersListCalls).toEqual([]);
    expect(onComplete).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Switch account" }));
    expect(screen.getByText(REPLACE_PROFILE_ACCOUNT_LINE)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Switch account" }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      ACCOUNT_UNIDENTIFIED_SIGN_IN_LINE,
    );
    expect(host.linkRequests).toEqual([
      { ...EXISTING_PROFILE_REQUEST, replaceAccount: false },
      { ...EXISTING_PROFILE_REQUEST, replaceAccount: true },
    ]);
    expect(host.completeRequests).toEqual([]);
    expect(host.providersListCalls).toEqual([]);
    expect(onComplete).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("keeps a marked unidentified start outcome unknown without retry or inventory refresh", async () => {
    const startError = new HostRpcError({
      code: "harness_account_unidentified",
      message: "The account on this profile could not be confirmed.",
      requestId: "req-unidentified-start-outcome",
      method: "providers.link",
      fatalDetails: null,
    });
    markMayHaveReachedHost(startError);
    const host = makeHost({
      link: () => Promise.reject(startError),
    });
    const onComplete = vi.fn();
    const onDeliveryPending = vi.fn();
    const onCancel = vi.fn();
    renderSignIn({
      host,
      request: EXISTING_PROFILE_REQUEST,
      waitForLocalProfile: true,
      onComplete,
      onDeliveryPending,
      onCancel,
    });

    expect((await screen.findByRole("alert")).textContent).toBe(
      LINK_OUTCOME_UNKNOWN,
    );
    expect(await screen.findByRole("button", { name: "Cancel" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Switch account" })).toBeNull();
    expect(screen.queryByLabelText("One-time code")).toBeNull();
    expect(host.linkRequests).toEqual([
      { ...EXISTING_PROFILE_REQUEST, replaceAccount: false },
    ]);
    expect(host.completeRequests).toEqual([]);
    expect(host.providersListCalls).toEqual([]);
    expect(host.cancelRequests).toEqual([]);
    expect(onComplete).not.toHaveBeenCalled();
    expect(onDeliveryPending).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledOnce();
    expect(host.cancelRequests).toEqual([]);
  });

  it("calls linkCancel once when a prompted sign-in is dismissed", async () => {
    const host = makeHost(undefined);
    const onComplete = vi.fn();
    const onCancel = vi.fn();
    renderSignIn({
      host,
      request: CREATE_PROFILE_REQUEST,
      waitForLocalProfile: true,
      onComplete,
      onCancel,
    });

    await screen.findByLabelText("Paste the code");
    fireEvent.click(screen.getByRole("button", { name: "Cancel sign-in" }));
    await host.cancelEvents.waitFor(1);

    expect(host.cancelRequests).toEqual([
      { linkId: "link-attempt", environmentId: ENVIRONMENT_ID },
    ]);
    expect(onCancel).toHaveBeenCalledOnce();
    expect(onComplete).not.toHaveBeenCalled();
  });

  it.each(["linked", "installing", "pending", "transport-failure"] as const)(
    "waits for an in-flight %s completion before deciding whether to withdraw the captured link",
    async (state) => {
      const {
        promise: completion,
        resolve: resolveCompletion,
        reject: rejectCompletion,
      } = Promise.withResolvers<ProvidersLinkCompleteResponseV12>();
      const host = makeHost({ complete: () => completion });
      const replacementHost = makeHost(undefined);
      const onComplete = vi.fn();
      const onDeliveryPending = vi.fn();
      const onCancel = vi.fn();
      const view = renderSignIn({
        host,
        request: EXISTING_PROFILE_REQUEST,
        waitForLocalProfile: true,
        onComplete,
        onDeliveryPending,
        onCancel,
      });

      await screen.findByLabelText("Paste the code");
      fireEvent.change(screen.getByLabelText("Paste the code"), {
        target: { value: CODE },
      });
      fireEvent.click(screen.getByRole("button", { name: "Submit code" }));
      await host.completeEvents.waitFor(1);

      fireEvent.click(screen.getByRole("button", { name: "Cancel sign-in" }));
      expect(onCancel).toHaveBeenCalledOnce();
      expect(host.cancelRequests).toEqual([]);

      view.rerender(
        <QueryClientProvider client={view.queryClient}>
          <EnvironmentProfileSignIn
            client={replacementHost.client}
            request={{
              ...EXISTING_PROFILE_REQUEST,
              environmentId: "environment-sign-in-replacement",
            }}
            waitForLocalProfile
            team
            ruleAboveWaitingStep={false}
            reportSource="Add profile"
            onNotOffered={null}
            onComplete={onComplete}
            onDeliveryPending={onDeliveryPending}
            onCancel={onCancel}
          />
        </QueryClientProvider>,
      );

      if (state === "transport-failure") {
        await act(async () => {
          rejectCompletion(
            new HostTransportFailureError({
              code: "RPC_ERROR",
              message: "The completion outcome is unknown.",
              requestId: "req-late-completion-failure",
              method: "providers.linkComplete",
              fatalDetails: null,
            }),
          );
          await completion.catch(() => undefined);
        });
        await host.providersListEvents.waitFor(1);
      } else {
        const response: ProvidersLinkCompleteResponseV12 = {
          state,
          code: null,
          account: null,
          expectedAccount: null,
          environmentProfileId: ENVIRONMENT_PROFILE_ID,
          profileId: state === "linked" ? MANAGED_PROFILE_ID : null,
        };
        await act(async () => {
          resolveCompletion(response);
          await completion;
        });
      }

      if (state === "pending") {
        await host.cancelEvents.waitFor(1);
        expect(host.cancelRequests).toEqual([
          {
            linkId: "link-attempt",
            environmentId: ENVIRONMENT_ID,
          },
        ]);
      } else {
        expect(host.cancelRequests).toEqual([]);
      }
      expect(replacementHost.cancelRequests).toEqual([]);
      expect(onComplete).not.toHaveBeenCalled();
      expect(onDeliveryPending).not.toHaveBeenCalled();
      if (state === "transport-failure") {
        expect(host.completeRequests).toEqual([
          {
            linkId: "link-attempt",
            code: CODE,
            environmentId: ENVIRONMENT_ID,
          },
        ]);
        expect(host.linkRequests).toEqual([
          { ...EXISTING_PROFILE_REQUEST, replaceAccount: false },
        ]);
        expect(host.providersListCalls).toEqual([1]);
        expect(host.cancelRequests).toEqual([]);
        expect(replacementHost.completeRequests).toEqual([]);
        expect(onCancel).toHaveBeenCalledOnce();
        expect(sonnerToast.info).not.toHaveBeenCalledWith(
          SIGNED_IN_RECEIVING_LINE,
        );
      }
    },
  );

  it("starts the new host scope and ignores the old startup failure", async () => {
    const { promise: oldStart, reject: rejectOldStart } =
      Promise.withResolvers<ProvidersLinkResponseV12>();
    const oldHost = makeHost({
      hostId: "host-sign-in-old-scope",
      link: () => oldStart,
    });
    const nextEnvironmentId = "environment-sign-in-next-scope";
    const nextHost = makeHost({
      hostId: "host-sign-in-next-scope",
      link: () => ({
        linkId: "link-next-scope",
        environmentProfileId: "environment-profile-next-scope",
        prompt: {
          kind: "sign_in_url",
          url: "https://auth.example.test/new-scope",
          codePrompt: "New code",
        },
      }),
      complete: () => ({
        state: "linked",
        code: null,
        account: null,
        expectedAccount: null,
        environmentProfileId: "environment-profile-next-scope",
        profileId: MANAGED_PROFILE_ID,
      }),
    });
    const oldOnComplete = vi.fn();
    const nextCompletion = completionObserver();
    const nextOnComplete = nextCompletion.onComplete;
    const view = renderSignIn({
      host: oldHost,
      request: EXISTING_PROFILE_REQUEST,
      waitForLocalProfile: false,
      onComplete: oldOnComplete,
      onCancel: vi.fn(),
    });

    await oldHost.linkEvents.waitFor(1);
    const nextRequest = {
      ...EXISTING_PROFILE_REQUEST,
      environmentId: nextEnvironmentId,
    };
    view.rerender(
      <QueryClientProvider client={view.queryClient}>
        <EnvironmentProfileSignIn
          client={nextHost.client}
          request={nextRequest}
          waitForLocalProfile={false}
          team
          ruleAboveWaitingStep={false}
          reportSource="Add profile"
          onNotOffered={null}
          onComplete={nextOnComplete}
          onCancel={vi.fn()}
        />
      </QueryClientProvider>,
    );

    expect(await screen.findByLabelText("Paste the code")).toBeTruthy();
    expect(nextHost.linkRequests).toEqual([
      { ...nextRequest, replaceAccount: false },
    ]);

    await act(async () => {
      rejectOldStart(new Error("Old host startup failed."));
      await oldStart.catch(() => undefined);
    });
    expect(screen.getByLabelText("Paste the code")).toBeTruthy();
    expect(oldOnComplete).not.toHaveBeenCalled();
    expect(nextOnComplete).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText("Paste the code"), {
      target: { value: "CODE-NEXT#state" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Submit code" }));
    await nextHost.completeEvents.waitFor(1);
    expect(nextHost.completeRequests[0]).toEqual({
      linkId: "link-next-scope",
      code: "CODE-NEXT#state",
      environmentId: nextEnvironmentId,
    });
    await nextCompletion.completed;
    expect(nextOnComplete).toHaveBeenCalledExactlyOnceWith({
      account: null,
      environmentProfileId: "environment-profile-next-scope",
      profile: null,
    });
    expect(oldHost.completeRequests).toEqual([]);
    expect(oldHost.cancelRequests).toEqual([]);
  });

  it("cancels once when dismissed before start answers, releasing the late link id", async () => {
    const startRequest = Promise.withResolvers<ProvidersLinkResponseV12>();
    const host = makeHost({
      link: () => startRequest.promise,
    });
    const onCancel = vi.fn();
    renderSignIn({
      host,
      request: CREATE_PROFILE_REQUEST,
      waitForLocalProfile: true,
      onComplete: vi.fn(),
      onCancel,
    });

    await host.linkEvents.waitFor(1);
    expect(host.linkRequests).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Cancel sign-in" }));
    expect(host.cancelRequests).toHaveLength(0);

    await act(async () => {
      startRequest.resolve(SIGN_IN_URL_RESPONSE);
      await startRequest.promise;
    });
    await host.cancelEvents.waitFor(1);
    expect(host.cancelRequests).toEqual([
      { linkId: "link-attempt", environmentId: ENVIRONMENT_ID },
    ]);
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("does not cancel a connection that has completed while local inventory is still installing", async () => {
    const host = makeHost({
      complete: () => ({
        state: "installing",
        code: null,
        account: null,
        expectedAccount: null,
        environmentProfileId: ENVIRONMENT_PROFILE_ID,
        profileId: MANAGED_PROFILE_ID,
      }),
      providersList: () => ({ providers: [], native: null }),
    });
    const onComplete = vi.fn();
    const deliveryPending = Promise.withResolvers<string | null>();
    const onDeliveryPending = vi.fn((certifiedProfileId: string | null) =>
      deliveryPending.resolve(certifiedProfileId),
    );
    const onCancel = vi.fn();
    renderSignIn({
      host,
      request: CREATE_PROFILE_REQUEST,
      waitForLocalProfile: true,
      onComplete,
      onDeliveryPending,
      onCancel,
    });

    await screen.findByLabelText("Paste the code");
    fireEvent.change(screen.getByLabelText("Paste the code"), {
      target: { value: CODE },
    });
    fireEvent.click(screen.getByRole("button", { name: "Submit code" }));
    expect(await screen.findByText(SIGNED_IN_RECEIVING_LINE)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    await expect(deliveryPending.promise).resolves.toBe(null);

    expect(host.cancelRequests).toEqual([]);
    expect(onDeliveryPending).toHaveBeenCalledExactlyOnceWith(null);
    expect(onCancel).not.toHaveBeenCalled();
    expect(onComplete).not.toHaveBeenCalled();
  });
});

describe("<EnvironmentProfileSignIn /> start refusals and polls", () => {
  function startRefusal(code: RpcErrorCode, message: string): HostRpcError {
    return new HostRpcError({
      code,
      message,
      requestId: "req-start-refused",
      method: "providers.link",
      fatalDetails: null,
    });
  }

  it("shows the host's reason with no Retry when environment sign-in is unavailable", async () => {
    const reason =
      "Environment sign-in is not available yet. Update Traycer and try again.";
    const host = makeHost({
      link: () =>
        Promise.reject(startRefusal("PROVIDER_LINK_UNAVAILABLE", reason)),
    });
    renderSignIn({
      host,
      request: CREATE_PROFILE_REQUEST,
      waitForLocalProfile: true,
      onComplete: vi.fn(),
      onCancel: vi.fn(),
    });

    expect((await screen.findByRole("alert")).textContent).toBe(reason);
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
  });

  it("hands a sign-in the host does not offer to the caller instead of a Retry", async () => {
    const host = makeHost({
      link: () =>
        Promise.reject(
          startRefusal("PROVIDER_LINK_NOT_OFFERED", "detached profile"),
        ),
    });
    const handedOff = Promise.withResolvers<void>();
    const onNotOffered = vi.fn(() => handedOff.resolve());
    renderSignIn({
      host,
      request: EXISTING_PROFILE_REQUEST,
      waitForLocalProfile: true,
      onComplete: vi.fn(),
      onCancel: vi.fn(),
      onNotOffered,
    });

    await handedOff.promise;
    expect(onNotOffered).toHaveBeenCalledOnce();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("does not send a Personal sign-in to a teammate when the start is forbidden", async () => {
    const host = makeHost({
      link: () =>
        Promise.reject(startRefusal("FORBIDDEN", "Not allowed to sign in.")),
    });
    renderSignIn({
      host,
      request: CREATE_PROFILE_REQUEST,
      waitForLocalProfile: true,
      onComplete: vi.fn(),
      onCancel: vi.fn(),
      team: false,
    });

    expect((await screen.findByRole("alert")).textContent).toBe(
      "Sign-in did not start. Try again.",
    );
    expect(
      screen.queryByText("Ask a teammate to sign in on Providers."),
    ).toBeNull();
  });

  it("keeps polling a device code through an unavailable answer and finishes", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const answers: ProvidersLinkCompleteResponseV12["state"][] = [
      "unavailable",
      "pending",
      "linked",
    ];
    const host = makeHost({
      link: () => ({
        linkId: "link-codex-device",
        environmentProfileId: ENVIRONMENT_PROFILE_ID,
        prompt: {
          kind: "device_code",
          verificationUrl: "https://auth.example.test/device",
          userCode: "DEVICE-CODE",
          expiresAt: Date.now() + 600_000,
        },
      }),
      complete: (_request, callNumber) => ({
        state: answers[callNumber - 1] ?? "linked",
        code: null,
        account: null,
        expectedAccount: null,
        environmentProfileId: ENVIRONMENT_PROFILE_ID,
        profileId: null,
      }),
    });
    const { completed, onComplete } = completionObserver();
    renderSignIn({
      host,
      request: DEVICE_REQUEST,
      waitForLocalProfile: false,
      onComplete,
      onCancel: vi.fn(),
    });

    expect(await screen.findByText("DEVICE-CODE")).toBeTruthy();
    for (const call of [1, 2, 3]) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_000);
      });
      await host.completeEvents.waitFor(call);
      expect(screen.queryByText(LINK_OUTCOME_UNKNOWN)).toBeNull();
    }
    await completed;
    expect(host.completeRequests).toHaveLength(3);
    expect(onComplete).toHaveBeenCalledOnce();
  });
});
