// The Link dialog calls `useHostClient()` with no client prop. Mocked at that
// boundary (the way `providers-settings-panel.test.tsx` does), with ONE stable
// scripted client: the poll effect depends on `client`.
const clientMock = vi.hoisted(
  (): { current: HostClient<HostRpcRegistry> | null } => ({ current: null }),
);
const useHostClientMock = vi.hoisted(() =>
  vi.fn<() => HostClient<HostRpcRegistry>>(),
);
vi.mock("@/lib/host/runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/host/runtime")>();
  return { ...actual, useHostClient: useHostClientMock };
});

// Personal's id is read from `environment.list` under the signed-in viewer.
vi.mock("@/hooks/chats/use-cloud-chat-queries", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/hooks/chats/use-cloud-chat-queries")
  >()),
  useCloudChatViewerId: () => "user-me",
}));

// What a link asks the app to open. The call is awaited with `.catch`, so it
// answers a promise.
const openLinkMock = vi.hoisted(() => vi.fn<OpenLink>());
vi.mock("@/lib/links/open-link", () => ({
  useOpenLink: () => openLinkMock,
}));

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  waitForElementToBeRemoved,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ProvidersLinkCompleteRequestV11,
  ProvidersLinkCompleteResponseV12,
  ProvidersLinkRequestV12,
  ProvidersLinkResponseV12,
} from "@traycer/protocol/host/environment-schemas";
import type { ConnectionManifest } from "@traycer/protocol/framework/index";
import { hostRpcRegistry } from "@traycer/protocol/host";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import {
  MockHostMessenger,
  type MockHandlerMap,
} from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { HostRuntimeProvider, useHostBinding } from "@/lib/host/runtime";
import { sandboxHostEntry } from "@/lib/sandboxes/__tests__/sandbox-host-directory-fixture";
import type { HostRpcRegistry } from "@/lib/host";
import { useProvidersList } from "@/hooks/providers/use-providers-list-query";
import { ProviderLinkDialog } from "@/components/settings/panels/provider-link-dialog";
import { PersonalPageContext } from "@/components/settings/personal/personal-page-context";
import { ConfigurationSourceContext } from "@/components/settings/environment/configuration-source";
import { resolveNamedHostClient } from "@/lib/host/binding-host-client";
import {
  buildEnvironmentClient,
  environmentStatusFixture,
} from "@/lib/environment/__tests__/environment-test-support";
import type { OpenLink } from "@/lib/links/open-link";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useProviderLinkDialogStore } from "@/stores/providers/provider-link-dialog-store";
import { useSettingsEnvironmentPickStore } from "@/stores/settings/settings-environment-pick-store";
import { createCallEvents } from "@/components/providers/__tests__/environment-sign-in-call-events";
import {
  recordNegotiatedHostManifest,
  recordNegotiatedHostMethods,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";

const listMock = vi.hoisted(() => vi.fn<() => void>());
const providersListMock = vi.hoisted(() => vi.fn<() => void>());
// While set, `environment.list` does not answer until it resolves.
const listGate = vi.hoisted((): { current: Promise<void> | null } => ({
  current: null,
}));

const HOST_ID = "host-link";
const PERSONAL_ENV_ID = "env-personal";
const HOST_NAME = "Studio";
const PROFILE_ID = "5f0c9b3e-7a41-4d0e-9c53-0b1f6e2a8d44";
const LINK_ID = "link-1";
const SIGN_IN_URL = "https://claude.ai/oauth/authorize?state=abc";
const SANDBOX_HOST_ID = "sandbox-link-host";
const LEGACY_SIGN_IN_MANIFEST: ConnectionManifest = {
  "providers.link": { major: 1, minor: 1 },
  "providers.linkComplete": { major: 1, minor: 1 },
  "environment.list": { major: 1, minor: 1 },
};
const ENVIRONMENT_SIGN_IN_MANIFEST: ConnectionManifest = {
  "providers.link": { major: 1, minor: 2 },
  "providers.linkComplete": { major: 1, minor: 2 },
  "environment.list": { major: 1, minor: 1 },
};
const SIGNED_IN_AUTH_FIXTURE = {
  status: "signed-in" as const,
  profile: {
    userId: "test-viewer",
    userName: "Test Viewer",
    email: "viewer@example.test",
  },
  contextMetadata: { userId: "test-viewer", username: "test-viewer" },
  shareableTeams: [],
  subscriptionStatus: null,
  signingInAttempt: null,
  signedOutCause: null,
  cloudVerdictLoss: "unreachable" as const,
  hostRefusedHeldBearer: false,
};
const SIGNED_OUT_AUTH_FIXTURE = {
  status: "signed-out" as const,
  profile: null,
  contextMetadata: null,
  shareableTeams: [],
  subscriptionStatus: null,
  signingInAttempt: null,
  signedOutCause: "retired" as const,
  cloudVerdictLoss: "unreachable" as const,
  hostRefusedHeldBearer: false,
};

function useFixtureHostClient(): HostClient<HostRpcRegistry> {
  const client = clientMock.current;
  if (client === null) {
    throw new Error("The host client fixture was not initialized.");
  }
  return client;
}

function ProvidersListQueryObserver(): null {
  useProvidersList({ enabled: true, subscribed: true });
  return null;
}

function linkDialogFooter(): HTMLElement {
  const footer = screen
    .getByTestId("provider-link-dialog")
    .querySelector('[data-slot="dialog-footer"]');
  if (!(footer instanceof HTMLElement)) {
    throw new Error("Expected the provider link dialog footer.");
  }
  return footer;
}

function useSandboxNamedHostClient(): HostClient<HostRpcRegistry> {
  const binding = useHostBinding();
  const client = resolveNamedHostClient(binding, SANDBOX_HOST_ID);
  if (client === null) {
    throw new Error("The sandbox runtime binding was not available.");
  }
  return client;
}

function SandboxRuntimeHarness(props: {
  readonly runnerHost: MockRunnerHost;
  readonly handlers: MockHandlerMap<HostRpcRegistry>;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <RunnerHostProvider runnerHost={props.runnerHost}>
      <HostRuntimeProvider
        registry={hostRpcRegistry}
        messengerFactory={({ registry }) =>
          new MockHostMessenger({
            registry,
            requestId: () => "req-sandbox-link",
            handlers: props.handlers,
          })
        }
        invalidator={null}
        requestId={null}
        remoteFetcher={() =>
          Promise.resolve({
            kind: "hosts",
            entries: [sandboxHostEntry(SANDBOX_HOST_ID, null)],
          })
        }
        fallback={null}
      >
        {props.children}
      </HostRuntimeProvider>
    </RunnerHostProvider>
  );
}

type LinkHandler = (
  request: ProvidersLinkRequestV12,
) => Promise<ProvidersLinkResponseV12>;
type CompleteHandler = (
  request: ProvidersLinkCompleteRequestV11,
) => Promise<ProvidersLinkCompleteResponseV12>;

const linkMock = vi.hoisted(() => ({
  link: vi.fn<LinkHandler>(),
  complete: vi.fn<CompleteHandler>(),
}));

const SIGN_IN_RESPONSE: ProvidersLinkResponseV12 = {
  linkId: LINK_ID,
  environmentProfileId: null,
  prompt: { kind: "sign_in_url", url: SIGN_IN_URL, codePrompt: "Code" },
};
const DEVICE_RESPONSE: ProvidersLinkResponseV12 = {
  linkId: LINK_ID,
  environmentProfileId: null,
  prompt: {
    kind: "device_code",
    verificationUrl: "https://auth.example.test/device",
    userCode: "ABCD-1234",
    expiresAt: 1_900_000_000,
  },
};
const HANDOFF_RESPONSE: ProvidersLinkResponseV12 = {
  linkId: LINK_ID,
  environmentProfileId: null,
  prompt: { kind: "local_handoff" },
};

function answer(
  overrides: Partial<ProvidersLinkCompleteResponseV12>,
): ProvidersLinkCompleteResponseV12 {
  return {
    state: "pending",
    code: null,
    account: null,
    expectedAccount: null,
    environmentProfileId: null,
    profileId: null,
    ...overrides,
  };
}

function rpcError(
  code: "PROVIDER_LINK_NOT_OFFERED" | "PROVIDER_LINK_UNAVAILABLE" | "RPC_ERROR",
  message: string,
): HostRpcError {
  return new HostRpcError({
    code,
    message,
    requestId: "req-1",
    method: "providers.link",
    fatalDetails: null,
  });
}

function personalPage(children: ReactNode): ReactNode {
  return (
    <PersonalPageContext.Provider
      value={{
        section: "providers",
        pick: { kind: "personal" },
        state: { kind: "ready", status: environmentStatusFixture({}) },
        line: null,
        hostName: HOST_NAME,
        localOverrides: [],
        hostId: HOST_ID,
        client: null,
        notices: [],
        review: [],
      }}
    >
      {children}
    </PersonalPageContext.Provider>
  );
}

function cloudPersonalPage(children: ReactNode): ReactNode {
  return (
    <ConfigurationSourceContext.Provider
      value={{
        kind: "pool",
        configuration: "personal",
        environmentId: PERSONAL_ENV_ID,
        roomId: "room-personal",
        providerHandle: null,
        effectiveRole: "owner",
      }}
    >
      {personalPage(children)}
    </ConfigurationSourceContext.Provider>
  );
}

beforeEach(() => {
  resetNegotiatedManifests();
  recordNegotiatedHostManifest(HOST_ID, LEGACY_SIGN_IN_MANIFEST);
  useHostClientMock.mockReset();
  useAuthStore.setState(SIGNED_OUT_AUTH_FIXTURE);
  linkMock.link.mockReset();
  listMock.mockReset();
  providersListMock.mockReset();
  listGate.current = null;
  linkMock.complete.mockReset();
  openLinkMock.mockReset();
  openLinkMock.mockResolvedValue(undefined);
  const { client } = buildEnvironmentClient({
    hostId: HOST_ID,
    handlers: {
      "environment.list": async () => {
        listMock();
        await listGate.current;
        return {
          environments: [
            {
              environmentId: PERSONAL_ENV_ID,
              ownerKind: "user" as const,
              ownerId: "user-me",
              roomId: "room-personal",
              label: "Personal",
              effectiveRole: "owner" as const,
              kind: "personal" as const,
              hostCount: 0,
              providerHandle: null,
            },
          ],
        };
      },
      "providers.link": linkMock.link,
      "providers.linkComplete": linkMock.complete,
      "providers.list": () => {
        providersListMock();
        return { providers: [], native: null };
      },
    },
  });
  clientMock.current = client;
  useHostClientMock.mockImplementation(useFixtureHostClient);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  useHostClientMock.mockReset();
  useHostClientMock.mockImplementation(useFixtureHostClient);
  resetNegotiatedManifests();
  clientMock.current = null;
  useProviderLinkDialogStore.setState({ target: null });
  useSettingsEnvironmentPickStore.setState({ pick: null });
  useAuthStore.setState(SIGNED_OUT_AUTH_FIXTURE);
});

/**
 * Renders and waits for Continue to be enabled: it waits for Personal's id,
 * since a link started before it has would name the host's own. A click on
 * Continue before then does nothing.
 */
async function renderDialog(children: ReactNode): Promise<void> {
  render(
    <QueryClientProvider client={new QueryClient()}>
      {children}
    </QueryClientProvider>,
  );
  if (vi.isFakeTimers()) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    return;
  }
  await waitFor(() => {
    expect(
      screen.getByTestId("provider-link-continue").hasAttribute("disabled"),
    ).toBe(false);
  });
}

async function renderCloudDialog(): Promise<void> {
  render(
    <QueryClientProvider client={new QueryClient()}>
      {cloudPersonalPage(<ProviderLinkDialog />)}
    </QueryClientProvider>,
  );
  await screen.findByLabelText("Profile name");
}

async function openDialog(
  providerId: string,
  profileId: string | null,
): Promise<void> {
  useProviderLinkDialogStore.getState().open({ providerId, profileId });
  await renderDialog(personalPage(<ProviderLinkDialog />));
}

async function openCloudDialog(
  providerId: string,
  profileId: string | null,
): Promise<void> {
  useProviderLinkDialogStore.getState().open({
    providerId,
    profileId,
    environmentId: PERSONAL_ENV_ID,
  });
  await renderCloudDialog();
}

function dialogState(): string | null {
  return screen.getByTestId("provider-link-dialog").getAttribute("data-state");
}

async function clickAndSettle(element: HTMLElement): Promise<void> {
  await act(async () => {
    fireEvent.click(element);
    await vi.advanceTimersByTimeAsync(0);
  });
}

/** Opens the dialog and walks it to the sign-in state. */
async function reachSignIn(profileId: string | null): Promise<void> {
  linkMock.link.mockResolvedValueOnce(SIGN_IN_RESPONSE);
  await openDialog("claude-code", profileId);
  fireEvent.click(screen.getByTestId("provider-link-continue"));
  await screen.findByTestId("provider-link-code");
}

function pasteAndLink(code: string): void {
  fireEvent.change(screen.getByTestId("provider-link-code"), {
    target: { value: code },
  });
  fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
}

describe("the intro", () => {
  it("shows the plan sentence and starts the link for the profile on Continue", async () => {
    linkMock.link.mockResolvedValueOnce(SIGN_IN_RESPONSE);
    await openDialog("claude-code", PROFILE_ID);

    expect(dialogState()).toBe("intro");
    expect(
      screen.getByText(
        "This signs Traycer in to your plan once. It will be offered on every host and sandbox you use; it counts as a device on your plan.",
      ),
    ).toBeTruthy();
    expect(linkMock.link).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByTestId("provider-link-sign-in");

    expect(linkMock.link).toHaveBeenCalledTimes(1);
    expect(linkMock.link).toHaveBeenCalledWith({
      providerId: "claude-code",
      profileId: PROFILE_ID,
      environmentId: PERSONAL_ENV_ID,
      createProfile: null,
      replaceAccount: false,
    });
  });

  it("starts a new profile's link with a null profile id", async () => {
    linkMock.link.mockResolvedValueOnce(SIGN_IN_RESPONSE);
    await openDialog("claude-code", null);
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByTestId("provider-link-sign-in");

    expect(linkMock.link).toHaveBeenCalledWith({
      providerId: "claude-code",
      profileId: null,
      environmentId: PERSONAL_ENV_ID,
      createProfile: null,
      replaceAccount: false,
    });
  });
});

describe("the paired environment sign-in versions", () => {
  const mixedManifests: Array<{
    readonly olderMethod: string;
    readonly manifest: ConnectionManifest;
  }> = [
    {
      olderMethod: "providers.link",
      manifest: {
        "providers.link": { major: 1, minor: 1 },
        "providers.linkComplete": { major: 1, minor: 2 },
        "environment.list": { major: 1, minor: 1 },
      },
    },
    {
      olderMethod: "providers.linkComplete",
      manifest: {
        "providers.link": { major: 1, minor: 2 },
        "providers.linkComplete": { major: 1, minor: 1 },
        "environment.list": { major: 1, minor: 1 },
      },
    },
  ];

  it.each(mixedManifests)(
    "uses the legacy flow when $olderMethod is below 1.2",
    async ({ manifest }) => {
      useAuthStore.setState(SIGNED_IN_AUTH_FIXTURE);
      recordNegotiatedHostManifest(HOST_ID, manifest);
      linkMock.link.mockResolvedValueOnce(SIGN_IN_RESPONSE);
      useProviderLinkDialogStore.getState().open({
        providerId: "claude-code",
        profileId: null,
        environmentId: PERSONAL_ENV_ID,
      });
      render(
        <QueryClientProvider client={new QueryClient()}>
          {cloudPersonalPage(<ProviderLinkDialog />)}
        </QueryClientProvider>,
      );
      await screen.findByRole("button", { name: "Continue" });

      expect(screen.queryByLabelText("Profile name")).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Continue" }));
      await screen.findByTestId("provider-link-code");

      expect(linkMock.link).toHaveBeenCalledWith({
        providerId: "claude-code",
        profileId: null,
        environmentId: PERSONAL_ENV_ID,
        createProfile: null,
        replaceAccount: false,
      });
    },
  );
});

describe("negotiated sign-in routing", () => {
  it("waits through name-only negotiation before reading and starting an environment link", async () => {
    resetNegotiatedManifests();
    useAuthStore.setState(SIGNED_IN_AUTH_FIXTURE);
    useProviderLinkDialogStore.setState({
      target: {
        providerId: "claude-code",
        profileId: null,
        environmentId: PERSONAL_ENV_ID,
      },
    });
    const listRequested = Promise.withResolvers<void>();
    listMock.mockImplementationOnce(() => listRequested.resolve());
    linkMock.link.mockResolvedValueOnce(SIGN_IN_RESPONSE);
    render(
      <QueryClientProvider client={new QueryClient()}>
        {cloudPersonalPage(<ProviderLinkDialog />)}
      </QueryClientProvider>,
    );

    expect(await screen.findByRole("button", { name: "Back" })).toBeTruthy();
    expect(listMock).not.toHaveBeenCalled();
    expect(linkMock.link).not.toHaveBeenCalled();
    expect(providersListMock).not.toHaveBeenCalled();

    act(() => {
      recordNegotiatedHostMethods(HOST_ID, [
        "providers.link",
        "providers.linkComplete",
      ]);
    });
    expect(screen.getByRole("button", { name: "Back" })).toBeTruthy();
    expect(listMock).not.toHaveBeenCalled();
    expect(linkMock.link).not.toHaveBeenCalled();

    act(() =>
      recordNegotiatedHostManifest(HOST_ID, ENVIRONMENT_SIGN_IN_MANIFEST),
    );
    await listRequested.promise;
    await screen.findByLabelText("Profile name");
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await screen.findByLabelText("Code");

    expect(listMock).toHaveBeenCalledTimes(1);
    expect(linkMock.link).toHaveBeenCalledWith({
      providerId: "claude-code",
      profileId: null,
      environmentId: PERSONAL_ENV_ID,
      createProfile: { label: "New profile", shareSkillsAndPlugins: false },
      replaceAccount: false,
    });
    expect(providersListMock).not.toHaveBeenCalled();
  });

  it("does not dispatch after Back closes the dialog before manifest publication", async () => {
    resetNegotiatedManifests();
    useAuthStore.setState(SIGNED_IN_AUTH_FIXTURE);
    useProviderLinkDialogStore.setState({
      target: {
        providerId: "claude-code",
        profileId: null,
        environmentId: PERSONAL_ENV_ID,
      },
    });
    render(
      <QueryClientProvider client={new QueryClient()}>
        {cloudPersonalPage(<ProviderLinkDialog />)}
      </QueryClientProvider>,
    );

    expect(await screen.findByRole("button", { name: "Back" })).toBeTruthy();
    expect(listMock).not.toHaveBeenCalled();
    expect(linkMock.link).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));

    expect(useProviderLinkDialogStore.getState().target).toBeNull();
    expect(screen.queryByTestId("provider-link-dialog")).toBeNull();
    act(() =>
      recordNegotiatedHostManifest(HOST_ID, ENVIRONMENT_SIGN_IN_MANIFEST),
    );

    expect(listMock).not.toHaveBeenCalled();
    expect(linkMock.link).not.toHaveBeenCalled();
    expect(providersListMock).not.toHaveBeenCalled();
  });
});

it("shows the real sandbox refusal before either link request can be sent", async () => {
  const runnerHost = new MockRunnerHost({
    signInUrl: "https://auth.traycer.invalid/sign-in",
    authnBaseUrl: "https://authn.traycer.invalid",
    localHost: null,
    hosts: [],
    workspaceFolderPickerPaths: undefined,
    hasLocalHost: undefined,
    traycerCli: undefined,
  });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const sandboxAttempts = { link: vi.fn(), complete: vi.fn() };
  const handlers: MockHandlerMap<HostRpcRegistry> = {
    "environment.list": () => ({
      environments: [
        {
          environmentId: PERSONAL_ENV_ID,
          ownerKind: "user",
          ownerId: "owner-sandbox-fixture",
          roomId: "room-personal",
          label: "Personal",
          effectiveRole: "owner",
          kind: "personal",
          hostCount: 0,
          providerHandle: null,
        },
      ],
    }),
    "providers.link": (request) => {
      sandboxAttempts.link(request);
      return Promise.resolve(SIGN_IN_RESPONSE);
    },
    "providers.linkComplete": (request) => {
      sandboxAttempts.complete(request);
      return Promise.resolve(answer({ state: "linked" }));
    },
  };
  recordNegotiatedHostManifest(SANDBOX_HOST_ID, {
    "providers.link": { major: 1, minor: 2 },
    "providers.linkComplete": { major: 1, minor: 2 },
    "environment.list": { major: 1, minor: 1 },
  });
  useProviderLinkDialogStore.setState({
    target: {
      providerId: "claude-code",
      profileId: null,
      environmentId: PERSONAL_ENV_ID,
    },
  });
  useHostClientMock.mockImplementation(useSandboxNamedHostClient);

  render(
    <QueryClientProvider client={queryClient}>
      <SandboxRuntimeHarness runnerHost={runnerHost} handlers={handlers}>
        {cloudPersonalPage(<ProviderLinkDialog />)}
      </SandboxRuntimeHarness>
    </QueryClientProvider>,
  );

  expect(await screen.findByText("Sandboxes don't take sign-ins")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Back" })).toBeTruthy();
  expect(screen.queryByLabelText("Code")).toBeNull();
  expect(sandboxAttempts.link).not.toHaveBeenCalled();
  expect(sandboxAttempts.complete).not.toHaveBeenCalled();
});

describe("a sign-in URL with a pasted code", () => {
  it("unlocks a cloud profile after start fails and retries with the edited label", async () => {
    recordNegotiatedHostManifest(HOST_ID, {
      "providers.link": { major: 1, minor: 2 },
      "providers.linkComplete": { major: 1, minor: 2 },
      "providers.linkCancel": { major: 1, minor: 0 },
      "environment.list": { major: 1, minor: 1 },
    });
    await openCloudDialog("claude-code", null);
    const profileName = screen.getByLabelText("Profile name");
    fireEvent.change(profileName, { target: { value: "Original profile" } });

    const start = Promise.withResolvers<ProvidersLinkResponseV12>();
    linkMock.link.mockReturnValueOnce(start.promise);
    linkMock.link.mockResolvedValueOnce({
      linkId: "retry-link",
      environmentProfileId: "retry-environment-profile",
      prompt: {
        kind: "sign_in_url",
        url: "https://auth.example.test/retry",
        codePrompt: "Retry code",
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(profileName.hasAttribute("disabled")).toBe(true);

    await act(async () => {
      start.reject(rpcError("RPC_ERROR", "Synthetic sign-in startup failure"));
      await start.promise.catch(() => undefined);
    });
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Sign-in did not start. Try again.",
    );
    expect(profileName.hasAttribute("disabled")).toBe(false);

    fireEvent.change(profileName, { target: { value: "" } });
    const retry = screen.getByRole("button", { name: "Retry" });
    expect(retry.hasAttribute("disabled")).toBe(true);
    fireEvent.change(profileName, { target: { value: "Updated profile" } });
    expect(retry.hasAttribute("disabled")).toBe(false);
    fireEvent.click(retry);
    await screen.findByLabelText("Retry code");

    expect(profileName.hasAttribute("disabled")).toBe(true);
    expect(linkMock.link).toHaveBeenCalledTimes(2);
    expect(linkMock.link.mock.calls.map(([request]) => request)).toEqual([
      {
        providerId: "claude-code",
        profileId: null,
        environmentId: PERSONAL_ENV_ID,
        createProfile: {
          label: "Original profile",
          shareSkillsAndPlugins: false,
        },
        replaceAccount: false,
      },
      {
        providerId: "claude-code",
        profileId: null,
        environmentId: PERSONAL_ENV_ID,
        createProfile: {
          label: "Updated profile",
          shareSkillsAndPlugins: false,
        },
        replaceAccount: false,
      },
    ]);

    linkMock.complete.mockResolvedValueOnce(
      answer({ state: "installing", account: "synthetic-account" }),
    );
    fireEvent.change(screen.getByLabelText("Retry code"), {
      target: { value: "RETRY-CODE" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect((await screen.findByRole("status")).textContent).toBe("Signed in.");
    expect(providersListMock).not.toHaveBeenCalled();
  });

  it("finishes a new cloud profile at link completion without polling local providers", async () => {
    recordNegotiatedHostManifest(HOST_ID, {
      "providers.link": { major: 1, minor: 2 },
      "providers.linkComplete": { major: 1, minor: 2 },
      "providers.linkCancel": { major: 1, minor: 0 },
      "environment.list": { major: 1, minor: 1 },
    });
    await openCloudDialog("claude-code", null);
    const profileName = screen.getByLabelText("Profile name");
    if (!(profileName instanceof HTMLInputElement)) {
      throw new Error("Expected a native profile label input.");
    }
    const maximumLabel = "C".repeat(64);
    await userEvent.clear(profileName);
    await userEvent.type(profileName, `${maximumLabel}X`);
    expect(profileName.value).toBe(maximumLabel);
    linkMock.link.mockResolvedValueOnce(SIGN_IN_RESPONSE);
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await screen.findByLabelText("Code");

    expect(linkMock.link).toHaveBeenCalledWith({
      providerId: "claude-code",
      profileId: null,
      environmentId: PERSONAL_ENV_ID,
      createProfile: {
        label: maximumLabel,
        shareSkillsAndPlugins: false,
      },
      replaceAccount: false,
    });
    linkMock.complete.mockResolvedValueOnce(
      answer({ state: "installing", account: "synthetic-account" }),
    );
    fireEvent.change(screen.getByLabelText("Code"), {
      target: { value: "abc#def" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    expect((await screen.findByRole("status")).textContent).toBe("Signed in.");
    expect(screen.getByRole("button", { name: "Done" })).toBeTruthy();
    expect(linkMock.complete).toHaveBeenCalledTimes(1);
    expect(providersListMock).not.toHaveBeenCalled();
  });

  it("opens the sign-in page, sends the trimmed code and ends on Signed in", async () => {
    await reachSignIn(PROFILE_ID);
    expect(
      screen.getByText("Sign in on claude.ai, then paste the code it shows."),
    ).toBeTruthy();

    fireEvent.click(
      screen.getByRole("button", { name: "Sign in on claude.ai" }),
    );
    expect(openLinkMock).toHaveBeenCalledTimes(1);
    expect(openLinkMock).toHaveBeenCalledWith(SIGN_IN_URL, "auth", null);

    // Nothing to send until a code is typed.
    expect(
      screen.getByTestId("provider-link-submit-code").hasAttribute("disabled"),
    ).toBe(true);

    linkMock.complete.mockResolvedValueOnce(
      answer({ state: "linked", account: "a@x.test" }),
    );
    pasteAndLink("  abc#def  ");
    const linked = await screen.findByTestId("provider-link-linked");

    expect(linkMock.complete).toHaveBeenCalledTimes(1);
    expect(linkMock.complete).toHaveBeenCalledWith({
      linkId: LINK_ID,
      code: "abc#def",
      environmentId: PERSONAL_ENV_ID,
    });
    expect(linked.textContent).toBe("Signed in.");
  });

  it("closes an unavailable Personal legacy completion after refreshing observed inventory", async () => {
    useAuthStore.setState(SIGNED_IN_AUTH_FIXTURE);
    recordNegotiatedHostManifest(HOST_ID, {
      ...LEGACY_SIGN_IN_MANIFEST,
      "providers.list": { major: 10, minor: 9 },
    });
    const inventoryEvents = createCallEvents();
    const completeEvents = createCallEvents();
    const completeRequests: ProvidersLinkCompleteRequestV11[] = [];
    providersListMock.mockImplementation(() => inventoryEvents.emit());
    linkMock.link.mockResolvedValueOnce(SIGN_IN_RESPONSE);
    linkMock.complete.mockImplementationOnce((request) => {
      completeRequests.push(request);
      completeEvents.emit();
      return Promise.resolve(answer({ state: "unavailable" }));
    });
    useProviderLinkDialogStore.getState().open({
      providerId: "claude-code",
      profileId: PROFILE_ID,
    });
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    render(
      <QueryClientProvider client={queryClient}>
        {personalPage(
          <>
            <ProviderLinkDialog />
            <ProvidersListQueryObserver />
          </>,
        )}
      </QueryClientProvider>,
    );

    await inventoryEvents.waitFor(1);
    await waitFor(() => {
      expect(
        screen.getByTestId("provider-link-continue").hasAttribute("disabled"),
      ).toBe(false);
    });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByLabelText("Code");
    fireEvent.change(screen.getByLabelText("Code"), {
      target: { value: "abc#def" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    await completeEvents.waitFor(1);
    const failedLine = await screen.findByTestId("provider-link-failed");
    expect(failedLine.textContent).toBe(
      "Couldn't confirm whether sign-in finished. Check Providers before trying again.",
    );
    await inventoryEvents.waitFor(2);

    expect(linkMock.link.mock.calls.map(([request]) => request)).toEqual([
      {
        providerId: "claude-code",
        profileId: PROFILE_ID,
        environmentId: PERSONAL_ENV_ID,
        createProfile: null,
        replaceAccount: false,
      },
    ]);
    expect(completeRequests).toEqual([
      {
        linkId: LINK_ID,
        code: "abc#def",
        environmentId: PERSONAL_ENV_ID,
      },
    ]);
    expect(providersListMock).toHaveBeenCalledTimes(2);
    expect(
      within(linkDialogFooter()).getByRole("button", { name: "Close" }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();

    fireEvent.click(
      within(linkDialogFooter()).getByRole("button", { name: "Close" }),
    );
    expect(useProviderLinkDialogStore.getState().target).toBeNull();
    expect(screen.queryByTestId("provider-link-dialog")).toBeNull();
  });

  it("closes and clears the target on Done", async () => {
    await reachSignIn(PROFILE_ID);
    linkMock.complete.mockResolvedValueOnce(
      answer({ state: "linked", account: "a@x.test" }),
    );
    pasteAndLink("abc#def");
    await screen.findByTestId("provider-link-linked");

    fireEvent.click(screen.getByRole("button", { name: "Done" }));

    expect(useProviderLinkDialogStore.getState().target).toBeNull();
    expect(screen.queryByTestId("provider-link-dialog")).toBeNull();
  });

  it("asks for the whole code when the paste was short, and keeps the code box", async () => {
    await reachSignIn(PROFILE_ID);
    linkMock.complete.mockResolvedValueOnce(
      answer({ state: "pending", code: "harness_token_shape" }),
    );
    pasteAndLink("abc");

    const note = await screen.findByTestId("provider-link-code-note");
    expect(note.textContent).toBe("Paste the whole code claude.ai shows.");
    expect(dialogState()).toBe("sign_in");
    expect(screen.getByTestId("provider-link-code")).toBeTruthy();

    // The next paste is judged afresh: the note goes when the code is fine.
    linkMock.complete.mockResolvedValueOnce(answer({ state: "pending" }));
    pasteAndLink("abc#def");
    await waitForElementToBeRemoved(note);
    expect(linkMock.complete).toHaveBeenCalledTimes(2);
  });
});

describe("a team device poll with an unknown completion outcome", () => {
  it("refreshes observed inventory, stops polling, and closes without retry", async () => {
    const teamEnvironmentId = "env-team-link";
    const teamDeviceCode = "TEAM-DEVICE-CODE";
    useAuthStore.setState(SIGNED_IN_AUTH_FIXTURE);
    recordNegotiatedHostManifest(HOST_ID, {
      ...LEGACY_SIGN_IN_MANIFEST,
      "providers.list": { major: 10, minor: 9 },
    });
    const inventoryEvents = createCallEvents();
    const linkEvents = createCallEvents();
    const completeEvents = createCallEvents();
    const pollIntervals = createCallEvents();
    const linkRequests: ProvidersLinkRequestV12[] = [];
    const completeRequests: ProvidersLinkCompleteRequestV11[] = [];
    const startResponse = Promise.withResolvers<ProvidersLinkResponseV12>();
    const initialPollResponse =
      Promise.withResolvers<ProvidersLinkCompleteResponseV12>();
    const uncertainPollResponse =
      Promise.withResolvers<ProvidersLinkCompleteResponseV12>();
    providersListMock.mockImplementation(() => inventoryEvents.emit());
    linkMock.link.mockImplementationOnce((request) => {
      linkRequests.push(request);
      linkEvents.emit();
      return startResponse.promise;
    });
    linkMock.complete.mockImplementationOnce((request) => {
      completeRequests.push(request);
      completeEvents.emit();
      return initialPollResponse.promise;
    });
    linkMock.complete.mockImplementationOnce((request) => {
      completeRequests.push(request);
      completeEvents.emit();
      return uncertainPollResponse.promise;
    });
    useProviderLinkDialogStore.getState().open({
      providerId: "codex",
      profileId: PROFILE_ID,
      environmentId: teamEnvironmentId,
    });
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const intervalWindow: Pick<Window, "setInterval"> = window;
    const realSetInterval = intervalWindow.setInterval.bind(intervalWindow);
    const intervalSpy = vi
      .spyOn(intervalWindow, "setInterval")
      .mockImplementation((handler, timeout) => {
        const intervalId = realSetInterval(handler, timeout);
        if (timeout === 5_000) pollIntervals.emit();
        return intervalId;
      });

    try {
      render(
        <QueryClientProvider client={queryClient}>
          <ConfigurationSourceContext.Provider
            value={{
              kind: "pool",
              configuration: "team",
              environmentId: teamEnvironmentId,
              roomId: "room-team-link",
              providerHandle: "provider-handle-team-link",
              effectiveRole: "editor",
            }}
          >
            <ProviderLinkDialog />
            <ProvidersListQueryObserver />
          </ConfigurationSourceContext.Provider>
        </QueryClientProvider>,
      );

      await inventoryEvents.waitFor(1);
      fireEvent.click(screen.getByRole("button", { name: "Continue" }));
      await linkEvents.waitFor(1);
      await act(async () => {
        startResponse.resolve({
          linkId: LINK_ID,
          environmentProfileId: null,
          prompt: {
            kind: "device_code",
            verificationUrl: "https://auth.example.test/team-device",
            userCode: teamDeviceCode,
            expiresAt: Date.now() + 60_000,
          },
        });
        await startResponse.promise;
      });
      await completeEvents.waitFor(1);
      expect(screen.getByTestId("provider-link-user-code").textContent).toBe(
        teamDeviceCode,
      );
      await act(async () => {
        initialPollResponse.resolve(answer({ state: "pending" }));
        await initialPollResponse.promise;
      });
      await pollIntervals.waitFor(1);

      const completionError = new HostRpcError({
        code: "RPC_ERROR",
        message: "Unable to confirm completion.",
        requestId: "req-link-completion-unknown",
        method: "providers.linkComplete",
        fatalDetails: null,
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });
      await completeEvents.waitFor(2);
      await act(async () => {
        uncertainPollResponse.reject(completionError);
        await uncertainPollResponse.promise.catch(() => undefined);
      });

      const failedLine = await screen.findByTestId("provider-link-failed");
      expect(failedLine.textContent).toBe(
        "Couldn't confirm whether sign-in finished. Check Providers before trying again.",
      );
      await inventoryEvents.waitFor(2);
      expect(linkRequests).toEqual([
        {
          providerId: "codex",
          profileId: PROFILE_ID,
          environmentId: teamEnvironmentId,
          createProfile: null,
          replaceAccount: false,
        },
      ]);
      expect(completeRequests).toEqual([
        {
          linkId: LINK_ID,
          code: null,
          environmentId: teamEnvironmentId,
        },
        {
          linkId: LINK_ID,
          code: null,
          environmentId: teamEnvironmentId,
        },
      ]);
      expect(providersListMock).toHaveBeenCalledTimes(2);
      expect(
        within(linkDialogFooter()).getByRole("button", { name: "Close" }),
      ).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });
      expect(completeRequests).toHaveLength(2);
      fireEvent.click(
        within(linkDialogFooter()).getByRole("button", { name: "Close" }),
      );
      expect(useProviderLinkDialogStore.getState().target).toBeNull();
      expect(screen.queryByTestId("provider-link-dialog")).toBeNull();
    } finally {
      intervalSpy.mockRestore();
      vi.useRealTimers();
    }
  });
});

describe("a mismatch", () => {
  async function reachMismatch(profileId: string | null): Promise<void> {
    await reachSignIn(profileId);
    linkMock.complete.mockResolvedValueOnce(
      answer({
        state: "mismatch",
        account: "a@x.test",
        expectedAccount: "b@x.test",
      }),
    );
    pasteAndLink("abc#def");
    await screen.findByTestId("provider-link-mismatch");
  }

  it("names both accounts", async () => {
    await reachMismatch(PROFILE_ID);
    expect(screen.getByTestId("provider-link-mismatch").textContent).toBe(
      "You signed in as a@x.test, not b@x.test.",
    );
  });

  it("Retry starts the same profile's link again", async () => {
    await reachMismatch(PROFILE_ID);
    linkMock.link.mockResolvedValueOnce(SIGN_IN_RESPONSE);

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByTestId("provider-link-code");

    expect(linkMock.link).toHaveBeenCalledTimes(2);
    expect(linkMock.link).toHaveBeenLastCalledWith({
      providerId: "claude-code",
      profileId: PROFILE_ID,
      environmentId: PERSONAL_ENV_ID,
      createProfile: null,
      replaceAccount: false,
    });
  });

  it("Add as a new profile starts a link with a null profile id, and keeps it for a later Retry", async () => {
    await reachMismatch(PROFILE_ID);
    linkMock.link.mockResolvedValueOnce(SIGN_IN_RESPONSE);

    fireEvent.click(
      screen.getByRole("button", { name: "Add as a new profile" }),
    );
    await screen.findByTestId("provider-link-code");

    expect(linkMock.link).toHaveBeenCalledTimes(2);
    expect(linkMock.link).toHaveBeenLastCalledWith({
      providerId: "claude-code",
      profileId: null,
      environmentId: PERSONAL_ENV_ID,
      createProfile: null,
      replaceAccount: false,
    });

    linkMock.complete.mockResolvedValueOnce(
      answer({
        state: "mismatch",
        account: "a@x.test",
        expectedAccount: null,
      }),
    );
    pasteAndLink("abc#def");
    await screen.findByTestId("provider-link-mismatch");
    linkMock.link.mockResolvedValueOnce(SIGN_IN_RESPONSE);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByTestId("provider-link-code");

    expect(linkMock.link).toHaveBeenLastCalledWith({
      providerId: "claude-code",
      profileId: null,
      environmentId: PERSONAL_ENV_ID,
      createProfile: null,
      replaceAccount: false,
    });
  });
});

describe("a device code", () => {
  async function reachDevice(): Promise<void> {
    vi.useFakeTimers();
    linkMock.link.mockResolvedValueOnce(DEVICE_RESPONSE);
    await openDialog("codex", PROFILE_ID);
    await clickAndSettle(screen.getByRole("button", { name: "Continue" }));
  }

  it("shows the code and polls every 5 s until it is linked", async () => {
    await reachDevice();
    expect(dialogState()).toBe("device");
    expect(screen.getByTestId("provider-link-user-code").textContent).toBe(
      "ABCD-1234",
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Open the sign-in page" }),
    );
    expect(openLinkMock).toHaveBeenCalledWith(
      "https://auth.example.test/device",
      "auth",
      null,
    );

    // Nothing is asked before the first beat.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_999);
    });
    expect(linkMock.complete).not.toHaveBeenCalled();

    linkMock.complete.mockResolvedValueOnce(answer({ state: "pending" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(linkMock.complete).toHaveBeenCalledTimes(1);
    expect(linkMock.complete).toHaveBeenLastCalledWith({
      linkId: LINK_ID,
      code: null,
      environmentId: PERSONAL_ENV_ID,
    });
    expect(dialogState()).toBe("device");

    // A pending answer keeps the same state and still arms the next poll.
    linkMock.complete.mockResolvedValueOnce(answer({ state: "pending" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(linkMock.complete).toHaveBeenCalledTimes(2);
    expect(dialogState()).toBe("device");

    linkMock.complete.mockResolvedValueOnce(
      answer({ state: "linked", account: "dev@x.test" }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(linkMock.complete).toHaveBeenCalledTimes(3);
    expect(screen.getByTestId("provider-link-linked").textContent).toBe(
      "Signed in.",
    );

    // Settled: no further polls.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    expect(linkMock.complete).toHaveBeenCalledTimes(3);
  });

  it("stops polling once the dialog is closed", async () => {
    await reachDevice();
    linkMock.complete.mockResolvedValue(answer({ state: "pending" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(linkMock.complete).toHaveBeenCalledTimes(1);

    await clickAndSettle(
      within(linkDialogFooter()).getByRole("button", { name: "Close" }),
    );
    expect(useProviderLinkDialogStore.getState().target).toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(linkMock.complete).toHaveBeenCalledTimes(1);
  });

  it("shows the expired line when the code expires, with Reconnect", async () => {
    await reachDevice();
    linkMock.complete.mockResolvedValueOnce(answer({ state: "expired" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });

    expect(screen.getByTestId("provider-link-expired").textContent).toBe(
      "This sign-in expired.",
    );
    linkMock.link.mockResolvedValueOnce(DEVICE_RESPONSE);
    await clickAndSettle(screen.getByRole("button", { name: "Reconnect" }));
    expect(linkMock.link).toHaveBeenCalledTimes(2);
    expect(linkMock.link).toHaveBeenLastCalledWith({
      providerId: "codex",
      profileId: PROFILE_ID,
      environmentId: PERSONAL_ENV_ID,
      createProfile: null,
      replaceAccount: false,
    });
    expect(dialogState()).toBe("device");
  });

  it("shows the outcome-unknown line when a completion poll fails", async () => {
    await reachDevice();
    linkMock.complete.mockRejectedValueOnce(
      new HostRpcError({
        code: "PROVIDER_LINK_UNAVAILABLE",
        message: "offline detail",
        requestId: "req-poll-unavailable",
        method: "providers.linkComplete",
        fatalDetails: null,
      }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });

    expect(screen.getByTestId("provider-link-failed").textContent).toBe(
      "Couldn't confirm whether sign-in finished. Check Providers before trying again.",
    );
    expect(
      within(linkDialogFooter()).getByRole("button", { name: "Close" }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });
});

describe("a local handoff", () => {
  it("shows Signing in…, polls every 2 s, then Signed in", async () => {
    vi.useFakeTimers();
    linkMock.link.mockResolvedValueOnce(HANDOFF_RESPONSE);
    await openDialog("claude-code", PROFILE_ID);
    await clickAndSettle(screen.getByRole("button", { name: "Continue" }));

    expect(screen.getByTestId("provider-link-linking").textContent).toBe(
      "Signing in…",
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_999);
    });
    expect(linkMock.complete).not.toHaveBeenCalled();

    linkMock.complete.mockResolvedValueOnce(answer({ state: "pending" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(linkMock.complete).toHaveBeenCalledTimes(1);
    expect(linkMock.complete).toHaveBeenLastCalledWith({
      linkId: LINK_ID,
      code: null,
      environmentId: PERSONAL_ENV_ID,
    });
    expect(dialogState()).toBe("linking");

    linkMock.complete.mockResolvedValueOnce(
      answer({ state: "linked", account: "a@x.test" }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(linkMock.complete).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId("provider-link-linked").textContent).toBe(
      "Signed in.",
    );
  });
});

describe("an expired sign-in", () => {
  it("says so and Reconnect starts the profile's link again", async () => {
    await reachSignIn(PROFILE_ID);
    linkMock.complete.mockResolvedValueOnce(answer({ state: "expired" }));
    pasteAndLink("abc#def");

    const expired = await screen.findByTestId("provider-link-expired");
    expect(expired.textContent).toBe("This sign-in expired.");

    linkMock.link.mockResolvedValueOnce(SIGN_IN_RESPONSE);
    fireEvent.click(screen.getByRole("button", { name: "Reconnect" }));
    await screen.findByTestId("provider-link-code");
    expect(linkMock.link).toHaveBeenCalledTimes(2);
    expect(linkMock.link).toHaveBeenLastCalledWith({
      providerId: "claude-code",
      profileId: PROFILE_ID,
      environmentId: PERSONAL_ENV_ID,
      createProfile: null,
      replaceAccount: false,
    });
  });
});

describe("a refused start", () => {
  it("says the profile is on this host only, and shows none of the error's text", async () => {
    linkMock.link.mockRejectedValueOnce(
      rpcError("PROVIDER_LINK_NOT_OFFERED", "internal-detail-xyz"),
    );
    await openDialog("claude-code", PROFILE_ID);
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    const line = await screen.findByTestId("provider-link-not-offered");
    expect(line.textContent).toBe("On Studio only.");
    expect(screen.queryByText(/internal-detail-xyz/)).toBeNull();
    // Nothing left to start: the only way on is to close.
    expect(screen.queryByRole("button", { name: "Continue" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("names this host generically outside a Personal page", async () => {
    linkMock.link.mockRejectedValueOnce(
      rpcError("PROVIDER_LINK_NOT_OFFERED", "internal-detail-xyz"),
    );
    useProviderLinkDialogStore
      .getState()
      .open({ providerId: "claude-code", profileId: PROFILE_ID });
    await renderDialog(<ProviderLinkDialog />);
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    const line = await screen.findByTestId("provider-link-not-offered");
    expect(line.textContent).toBe("On this host only.");
  });

  it("asks to connect to Traycer when it is unavailable, and Retry tries again", async () => {
    linkMock.link.mockRejectedValueOnce(
      rpcError("PROVIDER_LINK_UNAVAILABLE", "internal-detail-xyz"),
    );
    await openDialog("claude-code", PROFILE_ID);
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    const line = await screen.findByTestId("provider-link-unavailable");
    expect(line.textContent).toBe("Connect to Traycer to sign in.");
    expect(screen.queryByText(/internal-detail-xyz/)).toBeNull();

    linkMock.link.mockResolvedValueOnce(SIGN_IN_RESPONSE);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByTestId("provider-link-code");
    expect(linkMock.link).toHaveBeenCalledTimes(2);
    expect(linkMock.link).toHaveBeenLastCalledWith({
      providerId: "claude-code",
      profileId: PROFILE_ID,
      environmentId: PERSONAL_ENV_ID,
      createProfile: null,
      replaceAccount: false,
    });
  });

  it("shows another error's message as the failed line", async () => {
    linkMock.link.mockRejectedValueOnce(
      rpcError("RPC_ERROR", "the keychain is locked"),
    );
    await openDialog("claude-code", PROFILE_ID);
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    const line = await screen.findByTestId("provider-link-failed");
    expect(line.textContent).toBe("the keychain is locked");
  });

  it("explains a missing local sign-in when the link fails with no_sign_in", async () => {
    await reachSignIn(PROFILE_ID);
    linkMock.complete.mockResolvedValueOnce(
      answer({ state: "failed", code: "no_sign_in" }),
    );
    pasteAndLink("abc#def");

    const line = await screen.findByTestId("provider-link-failed");
    expect(line.textContent).toBe(
      "Sign in on the selected computer first, then try again.",
    );
  });
});

describe("a provider the dialog does not know", () => {
  it("says the profile is on this host only and never calls the host", async () => {
    await openDialog("nope", PROFILE_ID);
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    const line = await screen.findByTestId("provider-link-not-offered");
    expect(line.textContent).toBe("On Studio only.");
    expect(linkMock.link).not.toHaveBeenCalled();
  });
});

describe("closing", () => {
  it("clears the store target on Close", async () => {
    await openDialog("claude-code", PROFILE_ID);
    fireEvent.click(
      within(linkDialogFooter()).getByRole("button", { name: "Close" }),
    );

    expect(useProviderLinkDialogStore.getState().target).toBeNull();
    expect(screen.queryByTestId("provider-link-dialog")).toBeNull();
  });

  it("reopens at the intro with no code typed", async () => {
    await reachSignIn(PROFILE_ID);
    fireEvent.change(screen.getByTestId("provider-link-code"), {
      target: { value: "half-typed" },
    });
    fireEvent.click(
      within(linkDialogFooter()).getByRole("button", { name: "Close" }),
    );
    expect(screen.queryByTestId("provider-link-dialog")).toBeNull();

    act(() => {
      useProviderLinkDialogStore
        .getState()
        .open({ providerId: "claude-code", profileId: PROFILE_ID });
    });
    expect(dialogState()).toBe("intro");
    expect(screen.queryByTestId("provider-link-code")).toBeNull();

    linkMock.link.mockResolvedValueOnce(SIGN_IN_RESPONSE);
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    const box = await screen.findByTestId("provider-link-code");
    expect(box instanceof HTMLInputElement ? box.value : null).toBe("");
  });
});

describe("the environment a link names", () => {
  it("names Personal's own id on the Personal pick, for the start and for the code", async () => {
    await reachSignIn(PROFILE_ID);
    linkMock.complete.mockResolvedValueOnce(
      answer({ state: "linked", account: "a@x.test" }),
    );
    pasteAndLink("abc#def");
    await screen.findByTestId("provider-link-linked");

    expect(linkMock.link.mock.calls[0]?.[0].environmentId).toBe(
      PERSONAL_ENV_ID,
    );
    expect(linkMock.complete.mock.calls[0]?.[0].environmentId).toBe(
      PERSONAL_ENV_ID,
    );
  });

  it("names the host's own (null) on a Local pick, for the start and for the code", async () => {
    useSettingsEnvironmentPickStore.setState({
      pick: { kind: "local", hostId: HOST_ID, hostName: HOST_NAME },
    });
    await reachSignIn(PROFILE_ID);
    linkMock.complete.mockResolvedValueOnce(
      answer({ state: "linked", account: "a@x.test" }),
    );
    pasteAndLink("abc#def");
    await screen.findByTestId("provider-link-linked");

    expect(linkMock.link.mock.calls[0]?.[0].environmentId).toBeNull();
    expect(linkMock.complete.mock.calls[0]?.[0].environmentId).toBeNull();
  });

  it("holds Continue until Personal's id has arrived, then sends it", async () => {
    let release: () => void = () => undefined;
    listGate.current = new Promise<void>((resolve) => {
      release = resolve;
    });
    linkMock.link.mockResolvedValueOnce(SIGN_IN_RESPONSE);
    useProviderLinkDialogStore
      .getState()
      .open({ providerId: "claude-code", profileId: PROFILE_ID });
    const listRequested = Promise.withResolvers<void>();
    listMock.mockImplementationOnce(() => listRequested.resolve());
    render(
      <QueryClientProvider client={new QueryClient()}>
        {personalPage(<ProviderLinkDialog />)}
      </QueryClientProvider>,
    );
    await listRequested.promise;

    const continueButton = screen.getByTestId("provider-link-continue");
    expect(continueButton.hasAttribute("disabled")).toBe(true);
    fireEvent.click(continueButton);
    expect(linkMock.link).not.toHaveBeenCalled();

    release();
    await waitFor(() => {
      expect(
        screen.getByTestId("provider-link-continue").hasAttribute("disabled"),
      ).toBe(false);
    });
    fireEvent.click(screen.getByTestId("provider-link-continue"));
    await screen.findByTestId("provider-link-code");

    expect(linkMock.link.mock.calls[0]?.[0].environmentId).toBe(
      PERSONAL_ENV_ID,
    );
  });
});
