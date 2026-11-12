import { Fragment, StrictMode, useState, type ReactNode } from "react";
import {
  PROVIDER_PROFILE_ACCENT_COLORS,
  type ProviderCliState,
  type ProviderLoginRefusal,
  type ProviderProfile,
} from "@traycer/protocol/host/provider-schemas";
import type {
  ConnectionManifest,
  SchemaVersion,
} from "@traycer/protocol/framework/index";
import type {
  ProvidersLinkRequestV12,
  ProvidersLinkResponseV12,
} from "@traycer/protocol/host/environment-schemas";
import type { EnvironmentListResponseV11 } from "@traycer/protocol/host/environment/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  HostClient,
  HostRequestDispatchOptions,
} from "@traycer-clients/shared/host-client/host-client";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import { REPLACE_PROFILE_ACCOUNT_LINE } from "@traycer-clients/shared/providers/environment-profile-sign-in";
import {
  createCallEvents,
  type CallEvents,
} from "../../../providers/__tests__/environment-sign-in-call-events";
import type { HostRpcRegistry } from "@/lib/host";
import { TooltipProvider } from "@/components/ui/tooltip";
import { PersonalPageContext } from "@/components/settings/personal/personal-page-context";
import { useAuthStore } from "@/stores/auth/auth-store";
import {
  buildEnvironmentClient,
  environmentStatusFixture,
} from "@/lib/environment/__tests__/environment-test-support";
import {
  recordNegotiatedHostManifest,
  recordNegotiatedHostMethods,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";

// The whole point of this suite is the REAL mutation stack: `useMutation`'s
// observer, the host-scoped hook's own `onError` toast, and the login flow on
// top of it. Only the host transport is faked. The sibling suites fake the
// start-login hook itself, and a fake `mutate` that calls its per-call
// `onError` synchronously can never show what went wrong here - TanStack
// dropping that callback while its own mutation-level toast still fires.
//
// `providers.awaitLogin` is the one call here that is not a plain `request`:
// the login flow hands each wait its attempt's `AbortSignal`, and a wait with a
// signal is dispatched through `requestWithOptions` (a wait without one stays
// on `requestWithResponseTimeout`, which no flow in this suite uses).
const host = vi.hoisted(() => ({
  request: vi.fn<(method: string, params: unknown) => Promise<unknown>>(),
  requestWithOptions:
    vi.fn<
      (
        method: string,
        params: unknown,
        options: HostRequestDispatchOptions,
      ) => Promise<unknown>
    >(),
}));
const optionalClient = vi.hoisted(
  (): {
    current: HostClient<HostRpcRegistry> | null;
  } => ({
    current: null,
  }),
);

vi.mock("@/lib/host", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/host")>();
  const client = Object.assign({} as HostClient<HostRpcRegistry>, {
    getActiveHostId: () => "host-local",
    request: host.request,
    requestWithSignal: host.request,
    requestWithOptions: host.requestWithOptions,
  });
  const currentClient = () => optionalClient.current ?? client;
  return {
    ...actual,
    useHostClient: currentClient,
    useOptionalHostClient: currentClient,
  };
});
vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: () => null,
}));
vi.mock("@/hooks/providers/use-refresh-providers", () => ({
  useRefreshProviders: () => () => Promise.resolve(),
}));
// A spy, so a test can see which link a button sent the user to.
const links = vi.hoisted(() => ({
  openLink: vi.fn<(url: string, kind: string, event: unknown) => unknown>(),
}));
vi.mock("@/lib/links/open-link", () => ({
  useOpenLink: () => links.openLink,
}));
vi.mock("@/lib/host-error-toast", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/host-error-toast")>();
  return { ...actual, toastFromHostError: vi.fn() };
});

import { toastFromHostError } from "@/lib/host-error-toast";
import { ProfileEditDialog } from "@/components/settings/panels/provider-profile-edit-dialog";
import { AddProviderProfileDialog } from "@/components/settings/panels/add-provider-profile-dialog";
import { DEFAULT_PROVIDER_NATIVE_CAPABILITIES } from "@traycer/protocol/host/provider-native-schemas";

const PROVIDER_ID = "claude-code";
const PROFILE_ID = "profile-surya-2";
const ADD_HOST_ID = "host-profile-add-route";
const PERSONAL_ENVIRONMENT_ID = "environment-personal-profile-add";
const SIGN_IN_V12 = { major: 1, minor: 2 } as const;
const PERSONAL_PROFILE_ENVIRONMENT_LIST: EnvironmentListResponseV11 = {
  environments: [
    {
      environmentId: PERSONAL_ENVIRONMENT_ID,
      ownerKind: "user",
      ownerId: "owner-test",
      roomId: "room-test",
      label: "Personal",
      effectiveRole: "owner",
      kind: "personal",
      hostCount: 0,
      providerHandle: null,
    },
  ],
};
const personalEnvironmentListReads: string[] = [];

interface PersonalAddCallEvents {
  readonly link: CallEvents | null;
  readonly start: CallEvents | null;
}

function setSignedInViewer(): void {
  useAuthStore.setState({
    status: "signed-in",
    profile: {
      userId: "test-viewer",
      userName: "Test Viewer",
      email: "viewer@example.test",
    },
    contextMetadata: { userId: "test-viewer", username: "test-viewer" },
    signingInAttempt: null,
    signedOutCause: null,
    hostRefusedHeldBearer: false,
  });
}

function signedOutProfile(): ProviderProfile {
  return {
    profileId: PROFILE_ID,
    enabled: true,
    kind: "managed",
    authType: "oauth",
    label: "Surya 2",
    auth: {
      status: "unauthenticated",
      badgeText: null,
      label: null,
      detail: null,
    },
    identity: { email: null, tier: null, accountUuid: null },
    usageUpdatedAt: null,
    rateLimitStatus: "unknown",
    rateLimitLimitedScopes: null,
    duplicateOfProfileId: null,
    accentColor: null,
    ambientDriftNotice: null,
  };
}

function claudeState(profile: ProviderProfile): ProviderCliState {
  return {
    providerId: PROVIDER_ID,
    enabled: true,
    disabledBy: null,
    nativeCapabilities: DEFAULT_PROVIDER_NATIVE_CAPABILITIES,
    selected: { kind: "bundled" },
    candidates: [],
    auth: {
      status: "unauthenticated",
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
    profiles: [profile],
  };
}

function refusal(): HostRpcError {
  return new HostRpcError({
    code: "RPC_ERROR",
    message: "Refused to start the login",
    requestId: "req-start-login",
    method: "providers.startLogin",
    fatalDetails: null,
  });
}

/** The desktop renderer mounts under `<StrictMode>`, so the dev builds a
 *  sign-in is driven in run every mount effect setup -> cleanup -> setup.
 *  Production runs it once; both have to settle. */
const MOUNT_MODES = [
  { name: "under StrictMode", Wrapper: StrictMode },
  { name: "without StrictMode", Wrapper: Fragment },
] as const;

function renderSignInDialog(
  Wrapper: (props: { readonly children: ReactNode }) => ReactNode,
) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  const profile = signedOutProfile();
  return render(
    <Wrapper>
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <ProfileEditDialog
            state={claudeState(profile)}
            profile={profile}
            profiles={[profile]}
            canOauth
            oauthUnavailableHint={null}
            startInReauth
            isLocalHost
            open
            onOpenChange={() => undefined}
            remainingProfilesAfterRemoval={[]}
            onSelectedProfileIdChange={() => undefined}
            profileEnablementAvailable
            profileEnablementPending={() => false}
            onSetProfileEnabled={() => undefined}
          />
        </TooltipProvider>
      </QueryClientProvider>
    </Wrapper>,
  );
}

function authenticatedAmbientProfile(): ProviderProfile {
  return {
    ...signedOutProfile(),
    profileId: "ambient",
    kind: "ambient",
    label: "Terminal account",
    auth: {
      status: "authenticated",
      badgeText: null,
      label: null,
      detail: null,
    },
    identity: { email: "before@example.test", tier: null, accountUuid: null },
  };
}

function renderSwitchAccountDialog(profile: ProviderProfile) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  const dialog = (currentProfile: ProviderProfile): ReactNode => (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <ProfileEditDialog
          state={claudeState(currentProfile)}
          profile={currentProfile}
          profiles={[currentProfile]}
          canOauth
          oauthUnavailableHint={null}
          startInReauth={false}
          isLocalHost
          open
          onOpenChange={() => undefined}
          remainingProfilesAfterRemoval={[]}
          onSelectedProfileIdChange={() => undefined}
          profileEnablementAvailable
          profileEnablementPending={() => false}
          onSetProfileEnabled={() => undefined}
        />
      </TooltipProvider>
    </QueryClientProvider>
  );
  const rendered = render(dialog(profile));
  return {
    rerender: (refreshedProfile: ProviderProfile): void => {
      rendered.rerender(dialog(refreshedProfile));
    },
  };
}

function EnvironmentProfileEditDialogHarness(props: {
  readonly client: HostClient<HostRpcRegistry>;
  readonly profile: ProviderProfile;
  readonly startInReauth: boolean;
  readonly queryClient: QueryClient;
  readonly onOpenChange: (open: boolean) => void;
}): ReactNode {
  const [open, setOpen] = useState(true);
  return (
    <PersonalPageContext.Provider
      value={{
        section: "providers",
        pick: { kind: "personal" },
        state: { kind: "ready", status: environmentStatusFixture({}) },
        line: null,
        hostName: "Studio",
        localOverrides: [],
        hostId: ADD_HOST_ID,
        client: props.client,
        notices: [],
        review: [],
      }}
    >
      <QueryClientProvider client={props.queryClient}>
        <TooltipProvider>
          <ProfileEditDialog
            state={claudeState(props.profile)}
            profile={props.profile}
            profiles={[props.profile]}
            canOauth
            oauthUnavailableHint={null}
            startInReauth={props.startInReauth}
            isLocalHost
            open={open}
            onOpenChange={(nextOpen) => {
              props.onOpenChange(nextOpen);
              setOpen(nextOpen);
            }}
            remainingProfilesAfterRemoval={[]}
            onSelectedProfileIdChange={() => undefined}
            profileEnablementAvailable
            profileEnablementPending={() => false}
            onSetProfileEnabled={() => undefined}
          />
        </TooltipProvider>
      </QueryClientProvider>
    </PersonalPageContext.Provider>
  );
}

function renderEnvironmentProfileEditDialog(
  startInReauth: boolean,
  environmentList: Promise<EnvironmentListResponseV11>,
) {
  setSignedInViewer();
  const environmentListDispatched = Promise.withResolvers<void>();
  const requests: {
    readonly links: ProvidersLinkRequestV12[];
    readonly completes: unknown[];
    readonly starts: unknown[];
  } = { links: [], completes: [], starts: [] };
  const { client } = buildEnvironmentClient({
    hostId: ADD_HOST_ID,
    handlers: {
      "environment.list": () => {
        environmentListDispatched.resolve();
        return environmentList;
      },
      "providers.link": (request) => {
        requests.links.push(request);
        return {
          linkId: "edit-dialog-delivery-link",
          environmentProfileId: "edit-dialog-environment-profile",
          prompt: {
            kind: "sign_in_url",
            url: "https://auth.example.test/sign-in",
            codePrompt: "One-time code",
          },
        };
      },
      "providers.linkComplete": (request) => {
        requests.completes.push(request);
        return {
          state: "installing",
          code: null,
          account: null,
          expectedAccount: null,
          environmentProfileId: "edit-dialog-environment-profile",
          profileId: null,
        };
      },
      "providers.linkCancel": () => ({}),
      "providers.list": () => ({ providers: [], native: null }),
      "providers.startLogin": (request) => {
        requests.starts.push(request);
        return Promise.reject(
          new Error("Unexpected native sign-in in the environment fixture."),
        );
      },
    },
  });
  optionalClient.current = client;
  recordNegotiatedHostManifest(
    ADD_HOST_ID,
    addRouteManifest(SIGN_IN_V12, SIGN_IN_V12),
  );

  const profile = signedOutProfile();
  const onOpenChange = vi.fn<(open: boolean) => void>();
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <EnvironmentProfileEditDialogHarness
      client={client}
      profile={profile}
      startInReauth={startInReauth}
      queryClient={queryClient}
      onOpenChange={onOpenChange}
    />,
  );
  return {
    requests,
    onOpenChange,
    environmentListDispatched: environmentListDispatched.promise,
  };
}

function startLoginCalls(): number {
  return host.request.mock.calls.filter(
    ([method]) => method === "providers.startLogin",
  ).length;
}

beforeEach(() => {
  personalEnvironmentListReads.length = 0;
  recordNegotiatedHostManifest("host-local", {
    "providers.list": { major: 10, minor: 9 },
  });
  host.request.mockImplementation((method) =>
    method === "providers.startLogin"
      ? Promise.reject(refusal())
      : Promise.resolve({}),
  );
  // The long-poll that follows a started login: it stays open for the whole
  // browser leg, which is exactly the state a started sign-in should show.
  host.requestWithOptions.mockImplementation(
    () => new Promise<unknown>(() => undefined),
  );
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  optionalClient.current = null;
  resetNegotiatedManifests();
  useAuthStore.setState({
    status: "signed-out",
    profile: null,
    contextMetadata: null,
    signingInAttempt: null,
    signedOutCause: "retired",
    hostRefusedHeldBearer: false,
  });
});

function ClaudeAddDialogHarness(props: {
  readonly client: HostClient<HostRpcRegistry>;
  readonly queryClient: QueryClient;
  readonly onOpenChange: (open: boolean) => void;
}): ReactNode {
  const [open, setOpen] = useState(true);
  return (
    <PersonalPageContext.Provider
      value={{
        section: "providers",
        pick: { kind: "personal" },
        state: { kind: "ready", status: environmentStatusFixture({}) },
        line: null,
        hostName: "Studio",
        localOverrides: [],
        hostId: ADD_HOST_ID,
        client: props.client,
        notices: [],
        review: [],
      }}
    >
      <QueryClientProvider client={props.queryClient}>
        <TooltipProvider>
          <AddProviderProfileDialog
            state={claudeState(signedOutProfile())}
            client={props.client}
            isLocalHost
            open={open}
            onOpenChange={(nextOpen) => {
              props.onOpenChange(nextOpen);
              setOpen(nextOpen);
            }}
            onFailedAttempt={() => undefined}
            onProfileCreated={() => undefined}
          />
        </TooltipProvider>
      </QueryClientProvider>
    </PersonalPageContext.Provider>
  );
}

function renderClaudeAddDialog(
  client: HostClient<HostRpcRegistry>,
  onOpenChange: (open: boolean) => void,
): void {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <ClaudeAddDialogHarness
      client={client}
      queryClient={queryClient}
      onOpenChange={onOpenChange}
    />,
  );
}

function addRouteManifest(
  linkVersion: SchemaVersion,
  completeVersion: SchemaVersion,
): ConnectionManifest {
  return {
    "providers.link": linkVersion,
    "providers.linkComplete": completeVersion,
    "providers.linkCancel": { major: 1, minor: 0 },
    "providers.list": { major: 10, minor: 9 },
    "environment.list": { major: 1, minor: 0 },
  };
}

function buildPersonalAddClient(
  linkRequests: ProvidersLinkRequestV12[],
  startRequests: unknown[],
  events: PersonalAddCallEvents,
): HostClient<HostRpcRegistry> {
  const { client } = buildEnvironmentClient({
    hostId: ADD_HOST_ID,
    handlers: {
      "environment.list": () => {
        personalEnvironmentListReads.push("environment.list");
        return {
          environments: [
            {
              environmentId: PERSONAL_ENVIRONMENT_ID,
              ownerKind: "user",
              ownerId: "owner-test",
              roomId: "room-test",
              label: "Personal",
              effectiveRole: "owner",
              kind: "personal",
              hostCount: 0,
              providerHandle: null,
            },
          ],
        };
      },
      "providers.link": (request) => {
        linkRequests.push(request);
        events.link?.emit();
        const response: ProvidersLinkResponseV12 = {
          linkId: "link-add-route",
          environmentProfileId: "environment-profile-add-route",
          prompt: {
            kind: "sign_in_url",
            url: "https://auth.example.test/sign-in",
            codePrompt: "One-time code",
          },
        };
        return response;
      },
      "providers.linkComplete": () => ({
        state: "pending",
        code: null,
        account: null,
        expectedAccount: null,
        environmentProfileId: null,
        profileId: null,
      }),
      "providers.linkCancel": () => ({}),
      "providers.list": () => ({ providers: [], native: null }),
      "providers.startLogin": (request) => {
        startRequests.push(request);
        events.start?.emit();
        return Promise.reject(refusal());
      },
    },
  });
  return client;
}

describe("managed profile add entry-point routing", () => {
  it("waits for published support before using the Personal environment on @1.2", async () => {
    setSignedInViewer();
    const linkRequests: ProvidersLinkRequestV12[] = [];
    const startRequests: unknown[] = [];
    const linkEvents = createCallEvents();
    const events: PersonalAddCallEvents = { link: linkEvents, start: null };
    const client = buildPersonalAddClient(linkRequests, startRequests, events);

    renderClaudeAddDialog(client, () => undefined);
    expect(
      await screen.findByText("Reading where this profile will be available…"),
    ).toBeTruthy();
    expect(linkRequests).toHaveLength(0);
    expect(startRequests).toHaveLength(0);

    act(() => {
      recordNegotiatedHostManifest(
        ADD_HOST_ID,
        addRouteManifest(SIGN_IN_V12, SIGN_IN_V12),
      );
    });
    expect(
      await screen.findByText(
        "Use terminal skills and plugins on this computer",
      ),
    ).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await linkEvents.waitFor(1);

    await screen.findByLabelText("One-time code");
    expect(linkRequests).toHaveLength(1);
    expect(linkRequests[0]).toEqual({
      providerId: "claude-code",
      profileId: null,
      environmentId: PERSONAL_ENVIRONMENT_ID,
      createProfile: { label: "New profile", shareSkillsAndPlugins: true },
      replaceAccount: false,
    });
    expect(startRequests).toEqual([]);
  });

  it("keeps the local add flow when providers.linkComplete negotiates @1.1", async () => {
    setSignedInViewer();
    const linkRequests: ProvidersLinkRequestV12[] = [];
    const startRequests: unknown[] = [];
    const startEvents = createCallEvents();
    const events: PersonalAddCallEvents = { link: null, start: startEvents };
    const client = buildPersonalAddClient(linkRequests, startRequests, events);

    recordNegotiatedHostMethods(ADD_HOST_ID, [
      "providers.link",
      "providers.linkComplete",
      "providers.linkCancel",
      "providers.list",
      "environment.list",
    ]);
    renderClaudeAddDialog(client, () => undefined);
    expect(
      await screen.findByText("Reading where this profile will be available…"),
    ).toBeTruthy();
    expect(startRequests).toHaveLength(0);
    expect(linkRequests).toHaveLength(0);

    act(() => {
      recordNegotiatedHostManifest(
        ADD_HOST_ID,
        addRouteManifest(SIGN_IN_V12, { major: 1, minor: 1 }),
      );
    });
    await userEvent.click(
      await screen.findByRole("button", { name: "Sign in" }),
    );
    await startEvents.waitFor(1);

    await screen.findByText(
      "Sign-in did not start. You can retry when the provider is available.",
    );
    expect(startRequests).toHaveLength(1);
    expect(linkRequests).toEqual([]);
  });

  it("keeps Personal Add local when its known manifest lacks environment.list", async () => {
    setSignedInViewer();
    const linkRequests: ProvidersLinkRequestV12[] = [];
    const startRequests: unknown[] = [];
    const startEvents = createCallEvents();
    const events: PersonalAddCallEvents = { link: null, start: startEvents };
    const client = buildPersonalAddClient(linkRequests, startRequests, events);
    recordNegotiatedHostManifest(ADD_HOST_ID, {
      "providers.link": SIGN_IN_V12,
      "providers.linkComplete": SIGN_IN_V12,
      "providers.linkCancel": { major: 1, minor: 0 },
      "providers.list": { major: 10, minor: 9 },
    });

    renderClaudeAddDialog(client, () => undefined);
    await userEvent.click(
      await screen.findByRole("button", { name: "Sign in" }),
    );
    await startEvents.waitFor(1);
    await screen.findByText(
      "Sign-in did not start. You can retry when the provider is available.",
    );

    expect(startRequests).toHaveLength(1);
    expect(linkRequests).toEqual([]);
    expect(personalEnvironmentListReads).toEqual([]);
  });

  it("does not dispatch after Add closes while host support is unknown", async () => {
    setSignedInViewer();
    const linkRequests: ProvidersLinkRequestV12[] = [];
    const startRequests: unknown[] = [];
    const events: PersonalAddCallEvents = { link: null, start: null };
    const client = buildPersonalAddClient(linkRequests, startRequests, events);
    const onOpenChange = vi.fn<(open: boolean) => void>();

    renderClaudeAddDialog(client, onOpenChange);
    expect(
      await screen.findByText("Reading where this profile will be available…"),
    ).toBeTruthy();
    await userEvent.keyboard("{Escape}");
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(screen.queryByRole("dialog")).toBeNull();

    act(() => {
      recordNegotiatedHostManifest(
        ADD_HOST_ID,
        addRouteManifest(SIGN_IN_V12, SIGN_IN_V12),
      );
    });
    expect(linkRequests).toHaveLength(0);
    expect(startRequests).toHaveLength(0);
  });
});

describe.each(MOUNT_MODES)(
  "the 'Sign in to <profile>' dialog $name",
  ({ Wrapper }) => {
    it("leaves 'Opening the sign-in page…' when providers.startLogin is refused", async () => {
      renderSignInDialog(Wrapper);

      expect(
        screen.getByRole("heading", { name: "Sign in to Surya 2" }),
      ).toBeTruthy();
      expect(screen.getByText("Opening the sign-in page…")).toBeTruthy();

      // The hook's own toast, once. This is the half that always worked: it
      // runs from the mutation's own options, not the observer's.
      // The dialog follows it: the refusal is said inline, the pending step
      // is gone, and the retry is live - not a spinner outliving the toast.
      expect(
        await screen.findByText("Sign-in did not start. Try again when ready."),
      ).toBeTruthy();
      expect(toastFromHostError).toHaveBeenCalledTimes(1);
      expect(toastFromHostError).toHaveBeenCalledWith(
        expect.objectContaining({ code: "RPC_ERROR" }),
        "Couldn't start the sign-in flow.",
      );
      expect(screen.queryByText("Opening the sign-in page…")).toBeNull();
      const retry = screen.getByRole("button", { name: "Retry" });
      expect(retry.hasAttribute("disabled")).toBe(false);
      expect(startLoginCalls()).toBe(1);
    });

    it("sends a fresh providers.startLogin from Retry after a refusal", async () => {
      renderSignInDialog(Wrapper);
      await screen.findByText("Sign-in did not start. Try again when ready.");

      fireEvent.click(screen.getByRole("button", { name: "Retry" }));

      expect(await screen.findByText("Opening the sign-in page…")).toBeTruthy();
      // Refused again: the dialog settles again rather than sticking.
      expect(
        await screen.findByText("Sign-in did not start. Try again when ready."),
      ).toBeTruthy();
      expect(startLoginCalls()).toBe(2);
      expect(toastFromHostError).toHaveBeenCalledTimes(2);
      expect(screen.queryByText("Opening the sign-in page…")).toBeNull();
    });

    it("moves on to the browser step when providers.startLogin starts the login", async () => {
      host.request.mockImplementation((method) =>
        method === "providers.startLogin"
          ? Promise.resolve({
              url: "https://claude.test/oauth",
              started: true,
              profileId: PROFILE_ID,
              userCode: null,
            })
          : Promise.resolve({}),
      );
      renderSignInDialog(Wrapper);

      expect(
        await screen.findByText("Approve sign-in in your browser"),
      ).toBeTruthy();
      expect(screen.queryByText("Opening the sign-in page…")).toBeNull();
      const awaitCall = host.requestWithOptions.mock.calls.find(
        ([method]) => method === "providers.awaitLogin",
      );
      if (awaitCall === undefined) {
        throw new Error("Expected a providers.awaitLogin dispatch.");
      }
      const [, awaitParams, awaitOptions] = awaitCall;
      expect(awaitParams).toEqual({
        providerId: PROVIDER_ID,
        profileId: PROFILE_ID,
        lastSeenReaderCount: null,
      });
      expect(typeof awaitOptions.responseTimeoutMs).toBe("number");
      expect(awaitOptions.idempotencyKey).toBeNull();
      expect(awaitOptions.requiredHostMethodVersion).toBeNull();
      expect(awaitOptions.signal).toBeInstanceOf(AbortSignal);
    });

    it("consumes a refusal that lands after the dialog unmounted", async () => {
      const startLoginResult = Promise.withResolvers<unknown>();
      const startDispatched = Promise.withResolvers<void>();
      const refusalHandled = Promise.withResolvers<void>();
      host.request.mockImplementation((method) => {
        if (method !== "providers.startLogin") return Promise.resolve({});
        startDispatched.resolve();
        return startLoginResult.promise;
      });
      vi.mocked(toastFromHostError).mockImplementationOnce(() => {
        refusalHandled.resolve();
      });
      const { unmount } = renderSignInDialog(Wrapper);
      await startDispatched.promise;
      unmount();

      await act(async () => {
        startLoginResult.reject(refusal());
        await startLoginResult.promise.catch(() => undefined);
      });
      await refusalHandled.promise;

      // The mounted-independent mutation handler consumes and reports the
      // refusal even after the observer has been removed.
      expect(startLoginCalls()).toBe(1);
      expect(toastFromHostError).toHaveBeenCalledTimes(1);
      expect(toastFromHostError).toHaveBeenCalledWith(
        expect.objectContaining({ code: "RPC_ERROR" }),
        "Couldn't start the sign-in flow.",
      );
    });
  },
);

describe("the Switch account panel through a providers refresh", () => {
  it("keeps waiting and its copy link through a refreshed ambient row, then shows a failed attempt without returning to the switch row", async () => {
    let resolveAwait: (result: {
      readonly state: null;
      readonly existingProfileId: string | null;
      readonly codeRejected: boolean;
      readonly refusal: ProviderLoginRefusal | null;
    }) => void = () => undefined;
    host.request.mockImplementation((method) =>
      method === "providers.startLogin"
        ? Promise.resolve({
            url: "https://claude.test/oauth",
            started: true,
            profileId: "ambient",
            userCode: null,
          })
        : Promise.resolve({}),
    );
    host.requestWithOptions.mockImplementation(
      () =>
        new Promise<unknown>((resolve) => {
          resolveAwait = (result) => resolve(result);
        }),
    );
    const profile = authenticatedAmbientProfile();
    const { rerender } = renderSwitchAccountDialog(profile);

    fireEvent.click(screen.getByRole("button", { name: "Switch account" }));
    expect(
      await screen.findByText("Approve sign-in in your browser"),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Copy sign-in link" }),
    ).toBeTruthy();

    // A cache refresh replaces both the provider and profile objects while
    // the browser approval remains pending. The reauth panel owns the attempt
    // and must not fall back to the Switch account row because those props did.
    rerender({
      ...profile,
      auth: { ...profile.auth },
      identity: profile.identity === null ? null : { ...profile.identity },
    });
    expect(screen.getByText("Approve sign-in in your browser")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Copy sign-in link" }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Switch account" })).toBeNull();

    resolveAwait({
      state: null,
      existingProfileId: null,
      codeRejected: false,
      refusal: null,
    });

    expect(
      await screen.findByText("Sign-in did not finish. Try again."),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cancel sign-in" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Edit profile" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Switch account" })).toBeNull();
  });
});

describe("environment delivery pending from ProfileEditDialog", () => {
  it("returns to editing when Back cancels a held Personal environment read", async () => {
    const heldEnvironmentList =
      Promise.withResolvers<EnvironmentListResponseV11>();
    const { requests, onOpenChange, environmentListDispatched } =
      renderEnvironmentProfileEditDialog(false, heldEnvironmentList.promise);
    const nextColor = PROVIDER_PROFILE_ACCENT_COLORS[0];
    const profileName = screen.getByLabelText("Profile name");
    await userEvent.clear(profileName);
    await userEvent.type(profileName, "Uncommitted label");
    await userEvent.click(
      screen.getByRole("button", { name: `Use color ${nextColor}` }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Switch account" }));
    await environmentListDispatched;
    fireEvent.click(await screen.findByRole("button", { name: "Back" }));
    await screen.findByRole("button", { name: "Switch account" });

    const returnedName = screen.getByLabelText("Profile name");
    if (!(returnedName instanceof HTMLInputElement)) {
      throw new Error(
        "Expected the profile name input after returning from Back.",
      );
    }
    expect(returnedName.value).toBe("Uncommitted label");
    expect(returnedName.disabled).toBe(false);
    expect(
      screen
        .getByRole("button", { name: `Use color ${nextColor}` })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(requests.links).toHaveLength(0);
    expect(requests.starts).toHaveLength(0);

    await act(async () => {
      heldEnvironmentList.resolve(PERSONAL_PROFILE_ENVIRONMENT_LIST);
      await heldEnvironmentList.promise;
    });

    expect(screen.getByRole("button", { name: "Switch account" })).toBeTruthy();
    const nameAfterLateRead = screen.getByLabelText("Profile name");
    if (!(nameAfterLateRead instanceof HTMLInputElement)) {
      throw new Error(
        "Expected the profile name input after the held read resolved.",
      );
    }
    expect(nameAfterLateRead.value).toBe("Uncommitted label");
    expect(nameAfterLateRead.disabled).toBe(false);
    expect(
      screen
        .getByRole("button", { name: `Use color ${nextColor}` })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(requests.links).toHaveLength(0);
    expect(requests.starts).toHaveLength(0);
  });

  it("returns a cancelled reauth to editing before an explicit account switch", async () => {
    const { requests, onOpenChange } = renderEnvironmentProfileEditDialog(
      true,
      Promise.resolve(PERSONAL_PROFILE_ENVIRONMENT_LIST),
    );
    await screen.findByLabelText("One-time code");
    expect(requests.links).toHaveLength(1);
    expect(requests.links[0]?.replaceAccount).toBe(false);

    const signInBody = screen
      .getByLabelText("One-time code")
      .closest<HTMLElement>('[aria-live="polite"]');
    if (signInBody === null) {
      throw new Error("Expected the one-time-code sign-in body.");
    }
    fireEvent.click(within(signInBody).getByRole("button", { name: "Close" }));
    await screen.findByRole("heading", { name: "Edit profile" });

    const nextColor = PROVIDER_PROFILE_ACCENT_COLORS[0];
    const nameInput = screen.getByLabelText("Profile name");
    await userEvent.clear(nameInput);
    await userEvent.type(nameInput, "Uncommitted label");
    await userEvent.click(
      screen.getByRole("button", { name: `Use color ${nextColor}` }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Switch account" }));
    await screen.findByText(REPLACE_PROFILE_ACCOUNT_LINE);
    expect(requests.links).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Switch account" }));
    await screen.findByLabelText("One-time code");
    fireEvent.change(screen.getByLabelText("One-time code"), {
      target: { value: "delivery-code" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    fireEvent.click(await screen.findByRole("button", { name: "Done" }));

    const returnedName = screen.getByLabelText("Profile name");
    if (!(returnedName instanceof HTMLInputElement)) {
      throw new Error("Expected the profile name input after delivery.");
    }
    expect(returnedName.value).toBe("Uncommitted label");
    expect(
      screen
        .getByRole("button", { name: `Use color ${nextColor}` })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    expect(requests.links).toHaveLength(2);
    expect(requests.links.map((request) => request.replaceAccount)).toEqual([
      false,
      true,
    ]);
    expect(requests.completes).toHaveLength(1);
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("closes a reauth edit when delivery is pending", async () => {
    const { requests, onOpenChange } = renderEnvironmentProfileEditDialog(
      true,
      Promise.resolve(PERSONAL_PROFILE_ENVIRONMENT_LIST),
    );
    await screen.findByLabelText("One-time code");
    fireEvent.change(screen.getByLabelText("One-time code"), {
      target: { value: "delivery-code" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    fireEvent.click(await screen.findByRole("button", { name: "Done" }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(requests.links).toHaveLength(1);
    expect(requests.links[0]?.replaceAccount).toBe(false);
    expect(requests.completes).toHaveLength(1);
  });
});

// A provider can accept the browser consent and still turn the account away
// (`providers.awaitLogin@2.2` `refusal`): Antigravity does it for an account
// Google wants verified first. Both surfaces that run the sign-in flow have to
// say so in the provider's own words and offer the way through, instead of the
// generic "did not finish" a refused sign-in used to end in.
const ANTIGRAVITY_REFUSAL: ProviderLoginRefusal = {
  reason:
    "Your current account is not eligible for Antigravity. Verify your account to continue.",
  actionUrl: "https://accounts.google.com/signin/continue?sarp=1&scc=1",
};

const REFUSAL_HEADLINE = "Antigravity turned down this sign-in.";

function antigravityState(profile: ProviderProfile): ProviderCliState {
  return { ...claudeState(profile), providerId: "antigravity" };
}

/** The host answers `startLogin` with a started sign-in and holds `awaitLogin`
 *  until the browser leg is over, then answers it with `awaitAnswer`. */
function answerSignInWith(awaitAnswer: {
  readonly state: null;
  readonly existingProfileId: string | null;
  readonly codeRejected: boolean;
  readonly refusal: ProviderLoginRefusal | null;
}): CallEvents {
  const startLoginEvents = createCallEvents();
  host.request.mockImplementation((method) => {
    if (method !== "providers.startLogin") return Promise.resolve({});
    startLoginEvents.emit();
    return Promise.resolve({
      url: "https://accounts.google.com/o/oauth2/v2/auth?client_id=agy",
      started: true,
      profileId: PROFILE_ID,
      userCode: null,
    });
  });
  host.requestWithOptions.mockImplementation((method) =>
    method === "providers.awaitLogin"
      ? Promise.resolve(awaitAnswer)
      : new Promise<unknown>(() => undefined),
  );
  return startLoginEvents;
}

function renderAntigravityReauth() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const profile = signedOutProfile();
  return render(
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <ProfileEditDialog
          state={antigravityState(profile)}
          profile={profile}
          profiles={[profile]}
          canOauth
          oauthUnavailableHint={null}
          startInReauth
          isLocalHost
          open
          onOpenChange={() => undefined}
          remainingProfilesAfterRemoval={[]}
          onSelectedProfileIdChange={() => undefined}
          profileEnablementAvailable
          profileEnablementPending={() => false}
          onSetProfileEnabled={() => undefined}
        />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

function renderAntigravityAddDialog(
  onFailedAttempt: (attempt: unknown) => void,
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const client = Object.assign({} as HostClient<HostRpcRegistry>, {
    getActiveHostId: () => "host-local",
    request: host.request,
    requestWithSignal: host.request,
    requestWithOptions: host.requestWithOptions,
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <AddProviderProfileDialog
          state={antigravityState(signedOutProfile())}
          client={client}
          isLocalHost
          open
          onOpenChange={() => undefined}
          onFailedAttempt={onFailedAttempt}
          onProfileCreated={() => undefined}
        />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

describe("the reauth panel when the provider refuses the sign-in", () => {
  it("names the provider, gives its reason, offers Verify account and retries as 'Try another account'", async () => {
    answerSignInWith({
      state: null,
      existingProfileId: null,
      codeRejected: false,
      refusal: ANTIGRAVITY_REFUSAL,
    });
    renderAntigravityReauth();

    expect(await screen.findByText(REFUSAL_HEADLINE)).toBeTruthy();
    expect(screen.getByText(ANTIGRAVITY_REFUSAL.reason)).toBeTruthy();
    // The flow's own wording is replaced, not stacked under the provider's.
    expect(screen.queryByText(/did not finish/i)).toBeNull();
    expect(screen.getByRole("button", { name: "Verify account" })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Try another account" }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("sends the user to the provider's verification link through the auth link opener", async () => {
    answerSignInWith({
      state: null,
      existingProfileId: null,
      codeRejected: false,
      refusal: ANTIGRAVITY_REFUSAL,
    });
    renderAntigravityReauth();

    fireEvent.click(
      await screen.findByRole("button", { name: "Verify account" }),
    );

    expect(links.openLink).toHaveBeenCalledTimes(1);
    expect(links.openLink).toHaveBeenCalledWith(
      ANTIGRAVITY_REFUSAL.actionUrl,
      "auth",
      expect.anything(),
    );
  });

  it("starts a fresh sign-in from 'Try another account'", async () => {
    const startLoginEvents = answerSignInWith({
      state: null,
      existingProfileId: null,
      codeRejected: false,
      refusal: ANTIGRAVITY_REFUSAL,
    });
    renderAntigravityReauth();
    await screen.findByText(REFUSAL_HEADLINE);
    expect(startLoginCalls()).toBe(1);

    fireEvent.click(
      screen.getByRole("button", { name: "Try another account" }),
    );

    await startLoginEvents.waitFor(2);
    expect(await screen.findByText(REFUSAL_HEADLINE)).toBeTruthy();
    expect(startLoginCalls()).toBe(2);
  });

  it("offers no Verify account button when the provider offered no link, but still retries as 'Try another account'", async () => {
    answerSignInWith({
      state: null,
      existingProfileId: null,
      codeRejected: false,
      refusal: { reason: "This account cannot be used.", actionUrl: null },
    });
    renderAntigravityReauth();

    expect(await screen.findByText(REFUSAL_HEADLINE)).toBeTruthy();
    expect(screen.getByText("This account cannot be used.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Verify account" })).toBeNull();
    expect(
      screen.getByRole("button", { name: "Try another account" }),
    ).toBeTruthy();
  });

  it("keeps the flow's own wording and the plain Retry when the sign-in simply did not finish", async () => {
    answerSignInWith({
      state: null,
      existingProfileId: null,
      codeRejected: false,
      refusal: null,
    });
    renderAntigravityReauth();

    expect(await screen.findByRole("button", { name: "Retry" })).toBeTruthy();
    expect(screen.queryByText(REFUSAL_HEADLINE)).toBeNull();
    expect(screen.queryByRole("button", { name: "Verify account" })).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Try another account" }),
    ).toBeNull();
  });
});

describe("the add-profile dialog when the provider refuses the sign-in", () => {
  it("shows the provider's refusal with Verify account and a 'Try another account' retry, and reports the reason as the failed attempt", async () => {
    answerSignInWith({
      state: null,
      existingProfileId: null,
      codeRejected: false,
      refusal: ANTIGRAVITY_REFUSAL,
    });
    const onFailedAttempt = vi.fn<(attempt: unknown) => void>();
    renderAntigravityAddDialog(onFailedAttempt);

    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByText(REFUSAL_HEADLINE)).toBeTruthy();
    expect(screen.getByText(ANTIGRAVITY_REFUSAL.reason)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Verify account" })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Try another account" }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(onFailedAttempt).toHaveBeenCalledWith({
      providerId: "antigravity",
      message: ANTIGRAVITY_REFUSAL.reason,
    });
  });

  it("opens the verification link and starts a fresh sign-in from 'Try another account'", async () => {
    const startLoginEvents = answerSignInWith({
      state: null,
      existingProfileId: null,
      codeRejected: false,
      refusal: ANTIGRAVITY_REFUSAL,
    });
    renderAntigravityAddDialog(vi.fn());
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    fireEvent.click(
      await screen.findByRole("button", { name: "Verify account" }),
    );
    expect(links.openLink).toHaveBeenCalledWith(
      ANTIGRAVITY_REFUSAL.actionUrl,
      "auth",
      expect.anything(),
    );

    expect(startLoginCalls()).toBe(1);
    fireEvent.click(
      screen.getByRole("button", { name: "Try another account" }),
    );
    await startLoginEvents.waitFor(2);
    expect(await screen.findByText(REFUSAL_HEADLINE)).toBeTruthy();
    expect(startLoginCalls()).toBe(2);
  });

  it("offers no Verify account button when the provider offered no link", async () => {
    answerSignInWith({
      state: null,
      existingProfileId: null,
      codeRejected: false,
      refusal: { reason: "This account cannot be used.", actionUrl: null },
    });
    renderAntigravityAddDialog(vi.fn());
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByText(REFUSAL_HEADLINE)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Verify account" })).toBeNull();
    expect(
      screen.getByRole("button", { name: "Try another account" }),
    ).toBeTruthy();
  });

  it("keeps the plain failure and the Retry label when the sign-in did not finish without a refusal", async () => {
    answerSignInWith({
      state: null,
      existingProfileId: null,
      codeRejected: false,
      refusal: null,
    });
    renderAntigravityAddDialog(vi.fn());
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    expect(
      await screen.findByText(
        "Sign-in did not finish. Retry when you are ready.",
      ),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(screen.queryByText(REFUSAL_HEADLINE)).toBeNull();
    expect(screen.queryByRole("button", { name: "Verify account" })).toBeNull();
  });
});

// The host settled that nothing can run Antigravity on this Mac
// (`macosRequirement.launch`). Both Settings sign-in surfaces drive the one
// login flow, so neither may send a request, and each says why.
const MACOS_SENTENCE =
  "Antigravity needs macOS 14.0 or later. This Mac runs macOS 13.6.";

function antigravityMacosState(profile: ProviderProfile): ProviderCliState {
  return {
    ...antigravityState(profile),
    candidates: [],
    cliBinaryResolved: false,
    macosRequirement: {
      runningMacos: "13.6",
      managed: { requiredMacos: "14.0" },
      launch: { requiredMacos: "14.0" },
      refusedVersions: [],
    },
  };
}

function hostCallsFor(method: string): number {
  return (
    host.request.mock.calls.filter(([called]) => called === method).length +
    host.requestWithOptions.mock.calls.filter(([called]) => called === method)
      .length
  );
}

describe.each(MOUNT_MODES)(
  "Settings sign-in on a Mac that cannot run Antigravity $name",
  ({ Wrapper }) => {
    it("the reauth panel's mount effect lands on the sentence without startLogin or ensurePack", async () => {
      const queryClient = new QueryClient({
        defaultOptions: {
          queries: { retry: false },
          mutations: { retry: false },
        },
      });
      const profile = signedOutProfile();
      render(
        <Wrapper>
          <QueryClientProvider client={queryClient}>
            <TooltipProvider>
              <ProfileEditDialog
                state={antigravityMacosState(profile)}
                profile={profile}
                profiles={[profile]}
                canOauth
                oauthUnavailableHint={null}
                startInReauth
                isLocalHost
                open
                onOpenChange={() => undefined}
                remainingProfilesAfterRemoval={[]}
                onSelectedProfileIdChange={() => undefined}
                profileEnablementAvailable
                profileEnablementPending={() => false}
                onSetProfileEnabled={() => undefined}
              />
            </TooltipProvider>
          </QueryClientProvider>
        </Wrapper>,
      );

      expect(await screen.findByText(MACOS_SENTENCE)).toBeTruthy();
      expect(screen.queryByText("Opening the sign-in page…")).toBeNull();
      expect(hostCallsFor("providers.startLogin")).toBe(0);
      expect(hostCallsFor("providers.ensurePack")).toBe(0);
    });

    it("the add-profile dialog shows the sentence and its Sign in control sends nothing", async () => {
      const queryClient = new QueryClient({
        defaultOptions: {
          queries: { retry: false },
          mutations: { retry: false },
        },
      });
      const client = Object.assign({} as HostClient<HostRpcRegistry>, {
        getActiveHostId: () => "host-local",
        request: host.request,
        requestWithSignal: host.request,
        requestWithOptions: host.requestWithOptions,
      });
      render(
        <Wrapper>
          <QueryClientProvider client={queryClient}>
            <TooltipProvider>
              <AddProviderProfileDialog
                state={antigravityMacosState(signedOutProfile())}
                client={client}
                isLocalHost
                open
                onOpenChange={() => undefined}
                onFailedAttempt={() => undefined}
                onProfileCreated={() => undefined}
              />
            </TooltipProvider>
          </QueryClientProvider>
        </Wrapper>,
      );

      expect(await screen.findByText(MACOS_SENTENCE)).toBeTruthy();
      const link = screen.getByRole("button", { name: /Sign in/u });
      expect(link.hasAttribute("disabled")).toBe(true);
      fireEvent.click(link);
      expect(hostCallsFor("providers.startLogin")).toBe(0);
      expect(hostCallsFor("providers.ensurePack")).toBe(0);
    });
  },
);
