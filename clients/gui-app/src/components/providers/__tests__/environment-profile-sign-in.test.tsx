import "../../../../__tests__/test-browser-apis";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { toast as sonnerToast } from "sonner";
import type { ConnectionManifest } from "@traycer/protocol/framework/index";
import type {
  ProvidersLinkCompleteResponseV12,
  ProvidersLinkRequestV12,
  ProvidersLinkResponseV12,
} from "@traycer/protocol/host/environment-schemas";
import type {
  ProviderCliState,
  ProviderProfile,
} from "@traycer/protocol/host/provider-schemas";
import { EnvironmentProfileSignIn } from "@/components/providers/environment-profile-sign-in";
import {
  ACCOUNT_MISMATCH_SIGN_IN_LINE,
  ACCOUNT_UNIDENTIFIED_SIGN_IN_LINE,
  REPLACE_PROFILE_ACCOUNT_LINE,
  SIGNED_IN_RECEIVING_LINE,
} from "@traycer-clients/shared/providers/environment-profile-sign-in";
import {
  buildEnvironmentClient,
  type EnvironmentClientFixture,
} from "@/lib/environment/__tests__/environment-test-support";
import { hostRpcRegistry } from "@/lib/host";
import type {
  RequestOfMethod,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import {
  recordNegotiatedHostManifest,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";

const toast = vi.hoisted(() => ({ info: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

const HOST_ID = "host-environment-sign-in";
const ENVIRONMENT_ID = "environment-sign-in";
const ENVIRONMENT_PROFILE_ID = "environment-profile-alias";
const MANAGED_PROFILE_ID = "managed-profile-local";
const OLD_ADMITTED_PROFILE_ID = "managed-profile-old-admitted";
const CODE = "SIGN-IN-CODE";
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

interface EnvironmentSignInHostOptions {
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
  const linkRequests: ProvidersLinkRequestV12[] = [];
  const completeRequests: LinkCompleteRequest[] = [];
  const cancelRequests: EnvironmentSignInHost["cancelRequests"] = [];
  const providersListCalls: number[] = [];
  const fixture = buildEnvironmentClient({
    hostId: HOST_ID,
    handlers: {
      "providers.link": (request) => {
        linkRequests.push(request);
        return options?.link?.(request) ?? SIGN_IN_URL_RESPONSE;
      },
      "providers.linkComplete": (request) => {
        completeRequests.push(request);
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
        return {};
      },
      "providers.list": () => {
        const callNumber = providersListCalls.length + 1;
        providersListCalls.push(callNumber);
        return (
          options?.providersList?.(callNumber) ?? {
            providers: [],
            native: null,
          }
        );
      },
    },
  });
  recordNegotiatedHostManifest(HOST_ID, negotiatedManifest());
  return {
    client: fixture.client,
    linkRequests,
    completeRequests,
    cancelRequests,
    providersListCalls,
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
  readonly autoStart: boolean;
  readonly waitForLocalProfile: boolean;
  readonly onComplete: (completion: {
    readonly environmentProfileId: string | null;
    readonly profile: ProviderProfile | null;
  }) => void;
  readonly onCancel: () => void;
}) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <EnvironmentProfileSignIn
        client={input.host.client}
        request={input.request}
        autoStart={input.autoStart}
        waitForLocalProfile={input.waitForLocalProfile}
        disabled={false}
        onComplete={input.onComplete}
        onCancel={input.onCancel}
      />
    </QueryClientProvider>,
  );
}

async function flushRequests(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  resetNegotiatedManifests();
});

describe("<EnvironmentProfileSignIn />", () => {
  it("starts Claude with its profile choices, then maps the environment alias to the admitted local profile", async () => {
    const profile = managedProfile(
      MANAGED_PROFILE_ID,
      "Claude on this computer",
      ENVIRONMENT_PROFILE_ID,
      { kind: "admitted", bindingVersion: 1 },
    );
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
        providers: [providerState("claude-code", [profile])],
        native: null,
      }),
    });
    const onComplete = vi.fn();
    const onCancel = vi.fn();
    renderSignIn({
      host,
      request: CREATE_PROFILE_REQUEST,
      autoStart: true,
      waitForLocalProfile: true,
      onComplete,
      onCancel,
    });

    await screen.findByLabelText("One-time code");
    expect(host.linkRequests).toEqual([
      {
        ...CREATE_PROFILE_REQUEST,
        replaceAccount: false,
      },
    ]);
    fireEvent.change(screen.getByLabelText("One-time code"), {
      target: { value: CODE },
    });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    await screen.findByText("Waiting for this profile on this computer…");
    await vi.waitFor(() => {
      expect(onComplete).toHaveBeenCalledExactlyOnceWith({
        environmentProfileId: ENVIRONMENT_PROFILE_ID,
        profile,
      });
    });
    expect(host.completeRequests).toEqual([
      {
        linkId: "link-attempt",
        code: CODE,
        environmentId: ENVIRONMENT_ID,
      },
    ]);
    expect(host.providersListCalls).toEqual([1]);
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
    const onComplete = vi.fn();
    const onCancel = vi.fn();
    renderSignIn({
      host,
      request: DEVICE_REQUEST,
      autoStart: true,
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
    await flushRequests();
    expect(host.completeRequests).toHaveLength(1);
    expect(host.completeRequests[0]).toEqual({
      linkId: "link-codex-device",
      code: null,
      environmentId: ENVIRONMENT_ID,
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    await flushRequests();
    expect(host.completeRequests).toHaveLength(2);
    expect(host.providersListCalls).toEqual([1]);
    expect(onComplete).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    await flushRequests();
    expect(host.providersListCalls).toEqual([1, 2]);
    await waitFor(() => {
      expect(onComplete).toHaveBeenCalledExactlyOnceWith({
        environmentProfileId: ENVIRONMENT_PROFILE_ID,
        profile: admitted,
      });
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
    const onComplete = vi.fn();
    const onCancel = vi.fn();
    renderSignIn({
      host,
      request: EXISTING_PROFILE_REQUEST,
      autoStart: true,
      waitForLocalProfile: true,
      onComplete,
      onCancel,
    });

    await screen.findByLabelText("One-time code");
    fireEvent.change(screen.getByLabelText("One-time code"), {
      target: { value: CODE },
    });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await screen.findByText("Waiting for this profile on this computer…");
    await vi.waitFor(() =>
      expect(host.providersListCalls.length).toBeGreaterThan(0),
    );
    expect(host.completeRequests).toHaveLength(1);
    expect(onComplete).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    await flushRequests();
    expect(host.completeRequests).toHaveLength(2);
    expect(onComplete).not.toHaveBeenCalled();
    const inventoryReadsBeforeLinked = host.providersListCalls.length;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    await flushRequests();
    await vi.waitFor(() => expect(onComplete).toHaveBeenCalledOnce());
    expect(host.completeRequests).toHaveLength(3);
    expect(host.completeRequests.map(({ code }) => code)).toEqual([
      CODE,
      null,
      null,
    ]);
    expect(host.providersListCalls.length).toBeGreaterThan(
      inventoryReadsBeforeLinked,
    );
    expect(onComplete).toHaveBeenCalledExactlyOnceWith({
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
    const onComplete = vi.fn();
    const onCancel = vi.fn();
    renderSignIn({
      host,
      request: EXISTING_PROFILE_REQUEST,
      autoStart: true,
      waitForLocalProfile: true,
      onComplete,
      onCancel,
    });

    await screen.findByLabelText("One-time code");
    fireEvent.change(screen.getByLabelText("One-time code"), {
      target: { value: CODE },
    });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await screen.findByText("Waiting for this profile on this computer…");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    await flushRequests();
    expect(host.completeRequests).toHaveLength(2);
    expect(host.linkRequests).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(onComplete).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    await flushRequests();
    expect(host.completeRequests).toHaveLength(3);
    expect(host.linkRequests).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(onComplete).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    await flushRequests();
    await waitFor(() => {
      expect(onComplete).toHaveBeenCalledExactlyOnceWith({
        environmentProfileId: ENVIRONMENT_PROFILE_ID,
        profile,
      });
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

  it("treats expiry after connection as still receiving on this computer", async () => {
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
    const onCancel = vi.fn();
    renderSignIn({
      host,
      request: EXISTING_PROFILE_REQUEST,
      autoStart: true,
      waitForLocalProfile: true,
      onComplete,
      onCancel,
    });

    await screen.findByLabelText("One-time code");
    fireEvent.change(screen.getByLabelText("One-time code"), {
      target: { value: CODE },
    });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await screen.findByText("Waiting for this profile on this computer…");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    await flushRequests();

    expect(host.completeRequests).toHaveLength(2);
    expect(sonnerToast.info).toHaveBeenCalledWith(SIGNED_IN_RECEIVING_LINE);
    expect(onComplete).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalledOnce();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(screen.getByRole("button", { name: "Done" })).toBeTruthy();
  });

  it.each([
    ["harness_account_mismatch", ACCOUNT_MISMATCH_SIGN_IN_LINE],
    ["harness_account_unidentified", ACCOUNT_UNIDENTIFIED_SIGN_IN_LINE],
  ] as const)(
    "preserves an existing profile after %s and requires confirmation before switching",
    async (code, refusalLine) => {
      const host = makeHost({
        complete: () => ({
          state: "mismatch",
          code,
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
        autoStart: true,
        waitForLocalProfile: true,
        onComplete,
        onCancel,
      });

      await screen.findByLabelText("One-time code");
      fireEvent.change(screen.getByLabelText("One-time code"), {
        target: { value: CODE },
      });
      fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

      expect((await screen.findByRole("alert")).textContent).toBe(refusalLine);
      expect(host.linkRequests).toEqual([
        { ...EXISTING_PROFILE_REQUEST, replaceAccount: false },
      ]);
      expect(onComplete).not.toHaveBeenCalled();

      fireEvent.click(screen.getByRole("button", { name: "Switch account" }));
      expect(screen.getByText(REPLACE_PROFILE_ACCOUNT_LINE)).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Switch account" }));
      await screen.findByLabelText("One-time code");
      expect(host.linkRequests).toEqual([
        { ...EXISTING_PROFILE_REQUEST, replaceAccount: false },
        { ...EXISTING_PROFILE_REQUEST, replaceAccount: true },
      ]);
    },
  );

  it("calls linkCancel once when a prompted sign-in is dismissed", async () => {
    const host = makeHost(undefined);
    const onComplete = vi.fn();
    const onCancel = vi.fn();
    renderSignIn({
      host,
      request: CREATE_PROFILE_REQUEST,
      autoStart: true,
      waitForLocalProfile: true,
      onComplete,
      onCancel,
    });

    await screen.findByLabelText("One-time code");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await flushRequests();

    expect(host.cancelRequests).toEqual([
      { linkId: "link-attempt", environmentId: ENVIRONMENT_ID },
    ]);
    expect(onCancel).toHaveBeenCalledOnce();
    expect(onComplete).not.toHaveBeenCalled();
  });

  it("cancels once when dismissed before start answers, releasing the late link id", async () => {
    let resolveStart: (response: ProvidersLinkResponseV12) => void = () =>
      undefined;
    const host = makeHost({
      link: () =>
        new Promise((resolve) => {
          resolveStart = resolve;
        }),
    });
    const onCancel = vi.fn();
    renderSignIn({
      host,
      request: CREATE_PROFILE_REQUEST,
      autoStart: true,
      waitForLocalProfile: true,
      onComplete: vi.fn(),
      onCancel,
    });

    await act(async () => {
      await Promise.resolve();
    });
    expect(host.linkRequests).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(host.cancelRequests).toHaveLength(0);

    await act(async () => {
      resolveStart(SIGN_IN_URL_RESPONSE);
      await Promise.resolve();
    });
    await flushRequests();
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
    const onCancel = vi.fn();
    renderSignIn({
      host,
      request: CREATE_PROFILE_REQUEST,
      autoStart: true,
      waitForLocalProfile: true,
      onComplete,
      onCancel,
    });

    await screen.findByLabelText("One-time code");
    fireEvent.change(screen.getByLabelText("One-time code"), {
      target: { value: CODE },
    });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await screen.findByText("Waiting for this profile on this computer…");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await flushRequests();

    expect(host.cancelRequests).toEqual([]);
    expect(onCancel).toHaveBeenCalledOnce();
    expect(onComplete).not.toHaveBeenCalled();
  });
});
