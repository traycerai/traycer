import "../../../../__tests__/test-browser-apis";
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
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  useEffect,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";
import type { ConnectionManifest } from "@traycer/protocol/framework/index";
import type {
  ProvidersLinkCompleteResponseV12,
  ProvidersLinkRequestV12,
  ProvidersLinkResponseV12,
} from "@traycer/protocol/host/environment-schemas";
import {
  PROVIDER_PROFILE_ACCENT_COLORS,
  type ProviderCliState,
  type ProviderProfile,
} from "@traycer/protocol/host/provider-schemas";
import type {
  RequestOfMethod,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import {
  createCallEvents,
  type CallEvents,
} from "./environment-sign-in-call-events";
import { AddProviderProfileDialog } from "@/components/settings/panels/add-provider-profile-dialog";
import {
  buildEnvironmentClient,
  type EnvironmentClientFixture,
} from "@/lib/environment/__tests__/environment-test-support";
import type { HostRpcRegistry } from "@/lib/host";
import { useProvidersListForClient } from "@/hooks/providers/use-providers-list-query";
import {
  recordNegotiatedHostManifest,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";

const HOST_ID = "host-add-profile-color";
const ENVIRONMENT_ID = "environment-add-profile-color";
const openLink = vi.hoisted(() => vi.fn());
vi.mock("@/lib/links/open-link", () => ({ useOpenLink: () => openLink }));
// The route is read elsewhere; this suite starts on the environment it names.
vi.mock("@/hooks/providers/use-profile-sign-in-environment", () => ({
  useEnvironmentProfileSignInSupported: () => true,
  useProfileSignInEnvironment: () => ({
    kind: "environment",
    environmentId: "environment-add-profile-color",
    canSignIn: true,
    team: false,
  }),
}));
const ENVIRONMENT_PROFILE_ID = "environment-profile-created";
const PROFILE_ID = "managed-profile-created";
const EXISTING_PROFILE_ID = "managed-profile-existing";
const CHOSEN_COLOR = PROVIDER_PROFILE_ACCENT_COLORS[0];
const SIGN_IN_CODE = "COLOR-CODE#state";

const MANIFEST: ConnectionManifest = {
  "providers.link": { major: 1, minor: 2 },
  "providers.linkComplete": { major: 1, minor: 2 },
  "providers.linkCancel": { major: 1, minor: 0 },
  "providers.list": { major: 10, minor: 9 },
  "providers.setEnabled": { major: 2, minor: 1 },
};

type LinkCompleteRequest = RequestOfMethod<
  HostRpcRegistry,
  "providers.linkComplete"
>;
type RecolorRequest = RequestOfMethod<HostRpcRegistry, "providers.setEnabled">;
type RecolorResponse = ResponseOfMethod<
  HostRpcRegistry,
  "providers.setEnabled"
>;
type ProvidersListResponse = ResponseOfMethod<
  HostRpcRegistry,
  "providers.list"
>;

type LinkCompleteHandler = (
  request: LinkCompleteRequest,
  callNumber: number,
) =>
  | ProvidersLinkCompleteResponseV12
  | Promise<ProvidersLinkCompleteResponseV12>;
type ProvidersListHandler = (
  callNumber: number,
) => ProvidersListResponse | Promise<ProvidersListResponse>;

function providerState(profiles: readonly ProviderProfile[]): ProviderCliState {
  return {
    providerId: "claude-code",
    enabled: true,
    disabledBy: null,
    nativeCapabilities: {
      supportedTabs: ["general", "env", "usage"],
      mcp: null,
      plugins: null,
      skills: null,
      modelProviders: null,
    },
    selected: { kind: "bundled" },
    candidates: [],
    auth: { status: "unknown", badgeText: null, label: null, detail: null },
    authPending: false,
    checkedAt: null,
    apiKey: { supported: false, configured: false, source: null },
    terminalAgentArgs: "",
    envOverrides: [],
    loginCapability: null,
    availabilityPending: false,
    profiles: [...profiles],
  };
}

function createdProfile(): ProviderProfile {
  return {
    profileId: PROFILE_ID,
    enabled: true,
    kind: "managed",
    authType: "oauth",
    label: "New profile",
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
    environmentProfileId: ENVIRONMENT_PROFILE_ID,
    presence: { kind: "admitted", bindingVersion: 1 },
  };
}

function existingProfile(): ProviderProfile {
  return {
    ...createdProfile(),
    profileId: EXISTING_PROFILE_ID,
    label: "Existing profile",
    environmentProfileId: null,
    accentColor: PROVIDER_PROFILE_ACCENT_COLORS[2],
  };
}

interface ColorHost extends EnvironmentClientFixture {
  readonly linkRequests: ProvidersLinkRequestV12[];
  readonly linkCompleteRequests: LinkCompleteRequest[];
  readonly setEnabledRequests: RequestOfMethod<
    HostRpcRegistry,
    "providers.setEnabled"
  >[];
  readonly providersListCalls: number[];
  readonly linkEvents: CallEvents;
  readonly linkCompleteEvents: CallEvents;
  readonly setEnabledEvents: CallEvents;
  readonly providersListEvents: CallEvents;
}

type StartLinkHandler = (
  request: ProvidersLinkRequestV12,
  callNumber: number,
) => ProvidersLinkResponseV12 | Promise<ProvidersLinkResponseV12>;
type RecolorHandler = (
  request: RecolorRequest,
  callNumber: number,
) => RecolorResponse | Promise<RecolorResponse>;

interface ColorHostOverrides {
  readonly startLinkHandler: StartLinkHandler | undefined;
  readonly recolorHandler: RecolorHandler | undefined;
  readonly linkCompleteHandler: LinkCompleteHandler | undefined;
  readonly providersListHandler: ProvidersListHandler | undefined;
}

function makeHost(
  onInventoryProfileAdded: () => void,
  events: string[],
  overrides: ColorHostOverrides,
): ColorHost {
  const linkRequests: ColorHost["linkRequests"] = [];
  const linkCompleteRequests: ColorHost["linkCompleteRequests"] = [];
  const setEnabledRequests: ColorHost["setEnabledRequests"] = [];
  const providersListCalls: number[] = [];
  const linkEvents = createCallEvents();
  const linkCompleteEvents = createCallEvents();
  const setEnabledEvents = createCallEvents();
  const providersListEvents = createCallEvents();
  const linkResponse: ProvidersLinkResponseV12 = {
    linkId: "link-created-profile",
    environmentProfileId: ENVIRONMENT_PROFILE_ID,
    prompt: {
      kind: "sign_in_url",
      url: "https://auth.example.test/sign-in",
      codePrompt: "One-time code",
    },
  };
  const linkCompleteResponse: ProvidersLinkCompleteResponseV12 = {
    state: "installing",
    code: null,
    account: null,
    expectedAccount: null,
    environmentProfileId: ENVIRONMENT_PROFILE_ID,
    profileId: PROFILE_ID,
  };
  const fixture = buildEnvironmentClient({
    hostId: HOST_ID,
    handlers: {
      "providers.link": (request) => {
        linkRequests.push(request);
        linkEvents.emit();
        return overrides.startLinkHandler === undefined
          ? linkResponse
          : overrides.startLinkHandler(request, linkRequests.length);
      },
      "providers.linkComplete": (request: LinkCompleteRequest) => {
        linkCompleteRequests.push(request);
        linkCompleteEvents.emit();
        if (overrides.linkCompleteHandler !== undefined)
          return overrides.linkCompleteHandler(
            request,
            linkCompleteRequests.length,
          );
        return linkCompleteResponse;
      },
      "providers.linkCancel": () => ({}),
      "providers.list": () => {
        const callNumber = providersListCalls.length + 1;
        providersListCalls.push(callNumber);
        providersListEvents.emit();
        if (callNumber === 2) onInventoryProfileAdded();
        if (overrides.providersListHandler !== undefined)
          return overrides.providersListHandler(callNumber);
        const profiles =
          callNumber === 1
            ? [existingProfile()]
            : [existingProfile(), createdProfile()];
        return { providers: [providerState(profiles)], native: null };
      },
      "providers.setEnabled": (request: RecolorRequest) => {
        events.push("recolor");
        setEnabledRequests.push(request);
        setEnabledEvents.emit();
        if (overrides.recolorHandler !== undefined)
          return overrides.recolorHandler(request, setEnabledRequests.length);
        return { state: providerState([createdProfile()]) };
      },
    },
  });
  recordNegotiatedHostManifest(HOST_ID, MANIFEST);
  return {
    ...fixture,
    linkRequests,
    linkCompleteRequests,
    setEnabledRequests,
    providersListCalls,
    linkEvents,
    linkCompleteEvents,
    setEnabledEvents,
    providersListEvents,
  };
}

function AddProfileFromProviderInventory(props: {
  readonly client: ColorHost["client"];
  readonly onOpenChange: (open: boolean) => void;
  readonly onProfileCreated: (profileId: string) => void;
  readonly onParentStateWriter: (
    writer: Dispatch<SetStateAction<ProviderCliState>> | null,
  ) => void;
  readonly events: string[];
}): ReactNode {
  useProvidersListForClient(props.client, { enabled: true, subscribed: true });
  const [state, setState] = useState(() => providerState([existingProfile()]));
  const { onParentStateWriter } = props;
  useEffect(() => {
    onParentStateWriter(setState);
    return () => onParentStateWriter(null);
  }, [onParentStateWriter, setState]);
  useEffect(() => {
    if (state.profiles.some((profile) => profile.profileId === PROFILE_ID)) {
      props.events.push("parent-inventory-rerender");
    }
  }, [props.events, state.profiles]);
  return (
    <AddProviderProfileDialog
      state={state}
      client={props.client}
      isLocalHost
      open
      onOpenChange={props.onOpenChange}
      onFailedAttempt={() => undefined}
      onProfileCreated={props.onProfileCreated}
    />
  );
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  openLink.mockReset();
  resetNegotiatedManifests();
});

describe("the add dialog on the environment sign-in: profile color", () => {
  it("keeps the chosen color when inventory adds the new profile before sign-in finishes", async () => {
    const events: string[] = [];
    const parentStateWriter: {
      current: Dispatch<SetStateAction<ProviderCliState>> | null;
    } = { current: null };
    const onParentStateWriter = (
      writer: Dispatch<SetStateAction<ProviderCliState>> | null,
    ): void => {
      parentStateWriter.current = writer;
    };
    const host = makeHost(
      () => {
        act(() => {
          parentStateWriter.current?.(
            providerState([existingProfile(), createdProfile()]),
          );
        });
      },
      events,
      {
        startLinkHandler: undefined,
        recolorHandler: undefined,
        linkCompleteHandler: undefined,
        providersListHandler: undefined,
      },
    );
    const opened = Promise.withResolvers<boolean>();
    const created = Promise.withResolvers<string>();
    const onOpenChange = vi.fn((open: boolean) => opened.resolve(open));
    const onProfileCreated = vi.fn((profileId: string) =>
      created.resolve(profileId),
    );
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false, gcTime: 0 },
        mutations: { retry: false },
      },
    });
    const user = userEvent.setup();

    render(
      <QueryClientProvider client={queryClient}>
        <AddProfileFromProviderInventory
          client={host.client}
          onOpenChange={onOpenChange}
          onProfileCreated={onProfileCreated}
          onParentStateWriter={onParentStateWriter}
          events={events}
        />
      </QueryClientProvider>,
    );

    await host.providersListEvents.waitFor(1);
    await user.click(
      screen.getByRole("button", { name: `Use color ${CHOSEN_COLOR}` }),
    );
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    await screen.findByLabelText("Paste the code");
    fireEvent.change(screen.getByLabelText("Paste the code"), {
      target: { value: SIGN_IN_CODE },
    });
    await user.click(screen.getByRole("button", { name: "Submit code" }));

    await host.providersListEvents.waitFor(2);
    await host.setEnabledEvents.waitFor(1);
    await expect(created.promise).resolves.toBe(PROFILE_ID);
    await expect(opened.promise).resolves.toBe(false);
    expect(host.setEnabledRequests[0]).toMatchObject({
      providerId: "claude-code",
      enabled: true,
      profileAction: {
        type: "recolor",
        profileId: PROFILE_ID,
        accentColor: CHOSEN_COLOR,
      },
    });
    expect(events.indexOf("parent-inventory-rerender")).toBeGreaterThanOrEqual(
      0,
    );
    expect(events.indexOf("parent-inventory-rerender")).toBeLessThan(
      events.indexOf("recolor"),
    );
  });

  it("keeps the started name, color and sharing through a failed start, then retries them and recolors", async () => {
    const events: string[] = [];
    const parentStateWriter: {
      current: Dispatch<SetStateAction<ProviderCliState>> | null;
    } = { current: null };
    const onParentStateWriter = (
      writer: Dispatch<SetStateAction<ProviderCliState>> | null,
    ): void => {
      parentStateWriter.current = writer;
    };
    const firstStart = Promise.withResolvers<ProvidersLinkResponseV12>();
    const secondStart = Promise.withResolvers<ProvidersLinkResponseV12>();
    const host = makeHost(
      () => {
        act(() => {
          parentStateWriter.current?.(
            providerState([existingProfile(), createdProfile()]),
          );
        });
      },
      events,
      {
        startLinkHandler: (_request, callNumber) =>
          callNumber === 1 ? firstStart.promise : secondStart.promise,
        recolorHandler: undefined,
        linkCompleteHandler: undefined,
        providersListHandler: undefined,
      },
    );
    const opened = Promise.withResolvers<boolean>();
    const created = Promise.withResolvers<string>();
    const onOpenChange = vi.fn((open: boolean) => opened.resolve(open));
    const onProfileCreated = vi.fn((profileId: string) =>
      created.resolve(profileId),
    );
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false, gcTime: 0 },
        mutations: { retry: false },
      },
    });
    const user = userEvent.setup();

    render(
      <QueryClientProvider client={queryClient}>
        <AddProfileFromProviderInventory
          client={host.client}
          onOpenChange={onOpenChange}
          onProfileCreated={onProfileCreated}
          onParentStateWriter={onParentStateWriter}
          events={events}
        />
      </QueryClientProvider>,
    );

    await host.providersListEvents.waitFor(1);
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    await host.linkEvents.waitFor(1);
    expect(screen.getByLabelText("Profile name").hasAttribute("disabled")).toBe(
      true,
    );
    expect(
      screen
        .getByRole("button", { name: `Use color ${CHOSEN_COLOR}` })
        .hasAttribute("disabled"),
    ).toBe(true);
    const shareTools = screen.getByRole("checkbox", {
      name: "Use terminal account skills and plugins",
    });
    expect(shareTools.hasAttribute("disabled")).toBe(true);

    await act(async () => {
      firstStart.reject(new Error("Simulated startup failure."));
      await firstStart.promise.catch(() => undefined);
    });
    const failedAlert = await screen.findByRole("alert");
    expect(failedAlert.textContent).toBe("Sign-in did not start. Try again.");
    // As before environment sign-in: the started values stay until it ends.
    expect(screen.getByLabelText("Profile name").hasAttribute("disabled")).toBe(
      true,
    );
    expect(shareTools.hasAttribute("disabled")).toBe(true);
    await user.click(screen.getByRole("button", { name: "Retry" }));
    await host.linkEvents.waitFor(2);
    const started = {
      providerId: "claude-code",
      profileId: null,
      environmentId: ENVIRONMENT_ID,
      createProfile: {
        label: "New profile",
        shareSkillsAndPlugins: true,
      },
      replaceAccount: false,
    };
    expect(host.linkRequests).toEqual([started, started]);

    await act(async () => {
      secondStart.resolve({
        linkId: "link-created-profile",
        environmentProfileId: ENVIRONMENT_PROFILE_ID,
        prompt: {
          kind: "sign_in_url",
          url: "https://auth.example.test/sign-in",
          codePrompt: "One-time code",
        },
      });
      await secondStart.promise;
    });
    await screen.findByLabelText("Paste the code");
    expect(screen.getByLabelText("Profile name").hasAttribute("disabled")).toBe(
      true,
    );
    fireEvent.change(screen.getByLabelText("Paste the code"), {
      target: { value: SIGN_IN_CODE },
    });
    await user.click(screen.getByRole("button", { name: "Submit code" }));

    await host.setEnabledEvents.waitFor(1);
    await expect(created.promise).resolves.toBe(PROFILE_ID);
    await expect(opened.promise).resolves.toBe(false);
    expect(host.setEnabledRequests[0]).toMatchObject({
      providerId: "claude-code",
      enabled: true,
      profileAction: {
        type: "recolor",
        profileId: PROFILE_ID,
        accentColor: CHOSEN_COLOR,
      },
    });
    expect(events.indexOf("parent-inventory-rerender")).toBeLessThan(
      events.indexOf("recolor"),
    );
  });

  it.each(["authenticated profile", "certified linked profile"] as const)(
    "blocks every close path while recoloring a %s, then retries a failed recolor",
    async (completionPath) => {
      const certifiedInventory = Promise.withResolvers<ProvidersListResponse>();
      const isCertifiedLink = completionPath === "certified linked profile";
      const events: string[] = [];
      const parentStateWriter: {
        current: Dispatch<SetStateAction<ProviderCliState>> | null;
      } = { current: null };
      const onParentStateWriter = (
        writer: Dispatch<SetStateAction<ProviderCliState>> | null,
      ): void => {
        parentStateWriter.current = writer;
      };
      const firstRecolor = Promise.withResolvers<RecolorResponse>();
      const host = makeHost(
        () => {
          act(() => {
            parentStateWriter.current?.(
              providerState([existingProfile(), createdProfile()]),
            );
          });
        },
        events,
        {
          startLinkHandler: undefined,
          recolorHandler: (_request, callNumber) =>
            callNumber === 1
              ? firstRecolor.promise
              : { state: providerState([createdProfile()]) },
          linkCompleteHandler: isCertifiedLink
            ? () => ({
                state: "linked",
                code: null,
                account: null,
                expectedAccount: null,
                environmentProfileId: ENVIRONMENT_PROFILE_ID,
                profileId: PROFILE_ID,
              })
            : undefined,
          providersListHandler: isCertifiedLink
            ? (callNumber) =>
                callNumber === 2
                  ? certifiedInventory.promise
                  : {
                      providers: [
                        providerState(
                          callNumber === 1
                            ? [existingProfile()]
                            : [existingProfile(), createdProfile()],
                        ),
                      ],
                      native: null,
                    }
            : undefined,
        },
      );
      const opened = Promise.withResolvers<boolean>();
      const created = Promise.withResolvers<string>();
      const onOpenChange = vi.fn((open: boolean) => opened.resolve(open));
      const onProfileCreated = vi.fn((profileId: string) =>
        created.resolve(profileId),
      );
      const queryClient = new QueryClient({
        defaultOptions: {
          queries: { retry: false, gcTime: 0 },
          mutations: { retry: false },
        },
      });
      const user = userEvent.setup();

      render(
        <QueryClientProvider client={queryClient}>
          <AddProfileFromProviderInventory
            client={host.client}
            onOpenChange={onOpenChange}
            onProfileCreated={onProfileCreated}
            onParentStateWriter={onParentStateWriter}
            events={events}
          />
        </QueryClientProvider>,
      );

      await host.providersListEvents.waitFor(1);
      await user.click(
        screen.getByRole("button", { name: `Use color ${CHOSEN_COLOR}` }),
      );
      await user.click(screen.getByRole("button", { name: "Sign in" }));
      await screen.findByLabelText("Paste the code");
      fireEvent.change(screen.getByLabelText("Paste the code"), {
        target: { value: SIGN_IN_CODE },
      });
      await user.click(screen.getByRole("button", { name: "Submit code" }));
      if (isCertifiedLink) {
        await host.linkCompleteEvents.waitFor(1);
        await host.providersListEvents.waitFor(2);
        expect(host.linkCompleteRequests).toEqual([
          {
            linkId: "link-created-profile",
            code: SIGN_IN_CODE,
            environmentId: ENVIRONMENT_ID,
          },
        ]);
        expect(host.providersListCalls).toEqual([1, 2]);
        expect(events).toContain("parent-inventory-rerender");
        expect(host.setEnabledRequests).toEqual([]);
        expect(onProfileCreated).not.toHaveBeenCalled();
        await act(async () => {
          certifiedInventory.resolve({ providers: [], native: null });
          await certifiedInventory.promise;
        });
      } else {
        await host.providersListEvents.waitFor(2);
      }
      await host.setEnabledEvents.waitFor(1);
      const dialog = screen.getByRole("dialog");
      expect(
        await within(dialog).findByText("Finishing profile setup"),
      ).toBeTruthy();
      expect(host.providersListCalls).toEqual([1, 2]);
      expect(onProfileCreated).not.toHaveBeenCalled();

      expect(screen.queryByRole("button", { name: "Close" })).toBeNull();
      fireEvent.keyDown(document, { key: "Escape" });
      const overlay = document.querySelector('[data-slot="dialog-overlay"]');
      expect(overlay).not.toBeNull();
      if (overlay === null) throw new Error("Dialog overlay was not rendered.");
      fireEvent.pointerDown(overlay, { button: 0, pointerType: "mouse" });
      expect(onOpenChange).not.toHaveBeenCalled();
      expect(onProfileCreated).not.toHaveBeenCalled();
      expect(host.setEnabledRequests).toHaveLength(1);
      expect(screen.getByRole("dialog")).toBeTruthy();

      await act(async () => {
        firstRecolor.reject(new Error("Color could not be saved."));
        await firstRecolor.promise.catch(() => undefined);
      });
      expect(await screen.findByRole("alert")).toBeTruthy();
      await user.click(screen.getByRole("button", { name: "Retry" }));
      await host.setEnabledEvents.waitFor(2);
      await expect(created.promise).resolves.toBe(PROFILE_ID);
      await expect(opened.promise).resolves.toBe(false);
      await host.providersListEvents.waitFor(3);
      expect(onOpenChange).toHaveBeenCalledExactlyOnceWith(false);
      expect(onProfileCreated).toHaveBeenCalledExactlyOnceWith(PROFILE_ID);
      expect(host.providersListCalls).toEqual([1, 2, 3]);
      expect(host.setEnabledRequests).toHaveLength(2);
      expect(host.setEnabledRequests).toMatchObject([
        {
          providerId: "claude-code",
          enabled: true,
          profileAction: {
            type: "recolor",
            profileId: PROFILE_ID,
            accentColor: CHOSEN_COLOR,
          },
        },
        {
          providerId: "claude-code",
          enabled: true,
          profileAction: {
            type: "recolor",
            profileId: PROFILE_ID,
            accentColor: CHOSEN_COLOR,
          },
        },
      ]);
      if (isCertifiedLink) expect(host.linkCompleteRequests).toHaveLength(1);
    },
  );

  it("closes uncertified delivery pending without recoloring or selecting an id", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const missingInventory = Promise.withResolvers<ProvidersListResponse>();
    const events: string[] = [];
    const host = makeHost(() => undefined, events, {
      startLinkHandler: undefined,
      recolorHandler: undefined,
      linkCompleteHandler: undefined,
      providersListHandler: (callNumber) =>
        callNumber === 2
          ? missingInventory.promise
          : { providers: [providerState([existingProfile()])], native: null },
    });
    const opened = Promise.withResolvers<boolean>();
    const profileCreated = Promise.withResolvers<string>();
    const onProfileCreated = vi.fn((profileId: string) =>
      profileCreated.resolve(profileId),
    );
    const onOpenChange = vi.fn((open: boolean) => opened.resolve(open));
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false, gcTime: 0 },
        mutations: { retry: false },
      },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <AddProfileFromProviderInventory
          client={host.client}
          onOpenChange={onOpenChange}
          onProfileCreated={onProfileCreated}
          onParentStateWriter={() => undefined}
          events={events}
        />
      </QueryClientProvider>,
    );

    await host.providersListEvents.waitFor(1);
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await screen.findByLabelText("Paste the code");
    fireEvent.change(screen.getByLabelText("Paste the code"), {
      target: { value: SIGN_IN_CODE },
    });
    fireEvent.click(screen.getByRole("button", { name: "Submit code" }));
    await host.linkCompleteEvents.waitFor(1);
    await host.providersListEvents.waitFor(2);
    expect(host.linkCompleteRequests).toEqual([
      {
        linkId: "link-created-profile",
        code: SIGN_IN_CODE,
        environmentId: ENVIRONMENT_ID,
      },
    ]);
    await act(async () => {
      missingInventory.resolve({ providers: [], native: null });
      await missingInventory.promise;
    });

    fireEvent.click(await screen.findByRole("button", { name: "Done" }));
    await expect(opened.promise).resolves.toBe(false);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    expect(onOpenChange).toHaveBeenCalledExactlyOnceWith(false);
    expect(onProfileCreated).not.toHaveBeenCalled();
    expect(host.setEnabledRequests).toEqual([]);
    expect(host.linkCompleteRequests).toHaveLength(1);
    expect(host.providersListCalls).toEqual([1, 2]);
  });
});

describe("the add dialog on the environment sign-in: the steps it had before", () => {
  const WORK_EMAIL = "work@example.test";
  const noOverrides: ColorHostOverrides = {
    startLinkHandler: undefined,
    recolorHandler: undefined,
    linkCompleteHandler: undefined,
    providersListHandler: undefined,
  };

  function renderDialog(
    host: ColorHost,
    state: ProviderCliState,
    onOpenChange: (open: boolean) => void,
  ): void {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false, gcTime: 0 },
        mutations: { retry: false },
      },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <AddProviderProfileDialog
          state={state}
          client={host.client}
          isLocalHost
          open
          onOpenChange={onOpenChange}
          onFailedAttempt={() => undefined}
          onProfileCreated={() => undefined}
        />
      </QueryClientProvider>,
    );
  }

  it("opens the browser by itself and offers Open browser with a copy-link button", async () => {
    const host = makeHost(() => undefined, [], noOverrides);
    renderDialog(host, providerState([existingProfile()]), () => undefined);

    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await screen.findByLabelText("Paste the code");
    expect(openLink).toHaveBeenCalledExactlyOnceWith(
      "https://auth.example.test/sign-in",
      "auth",
      null,
    );
    expect(
      screen.getByRole("button", { name: "Open browser again" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Copy sign-in link" }),
    ).toBeTruthy();
    expect(
      screen.getByText("Sign in on claude.ai, then paste the code it shows."),
    ).toBeTruthy();
  });

  it("sends a pasted code by itself from the paste field", async () => {
    const host = makeHost(() => undefined, [], noOverrides);
    renderDialog(host, providerState([existingProfile()]), () => undefined);

    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    const field = await screen.findByLabelText("Paste the code");
    fireEvent.paste(field, {
      clipboardData: { getData: () => `  ${SIGN_IN_CODE}  ` },
    });
    await host.linkCompleteEvents.waitFor(1);
    expect(host.linkCompleteRequests).toEqual([
      {
        linkId: "link-created-profile",
        code: SIGN_IN_CODE,
        environmentId: ENVIRONMENT_ID,
      },
    ]);
  });

  it("starts a fresh link with the old notice when the provider refuses the code", async () => {
    const host = makeHost(() => undefined, [], {
      ...noOverrides,
      linkCompleteHandler: () => ({
        state: "failed",
        code: "harness_token_invalid",
        account: null,
        expectedAccount: null,
        environmentProfileId: null,
        profileId: null,
      }),
    });
    renderDialog(host, providerState([existingProfile()]), () => undefined);

    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    fireEvent.change(await screen.findByLabelText("Paste the code"), {
      target: { value: SIGN_IN_CODE },
    });
    fireEvent.click(screen.getByRole("button", { name: "Submit code" }));
    await host.linkEvents.waitFor(2);
    expect(
      await screen.findByText(
        "That code didn't work - a new sign-in link was generated.",
      ),
    ).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(host.linkRequests).toHaveLength(2);
  });

  it("shows the Codex device code with a copy-code button", async () => {
    const host = makeHost(() => undefined, [], {
      ...noOverrides,
      startLinkHandler: () => ({
        linkId: "link-codex-device",
        environmentProfileId: ENVIRONMENT_PROFILE_ID,
        prompt: {
          kind: "device_code",
          verificationUrl: "https://auth.example.test/device",
          userCode: "WDJB-MJHT",
          expiresAt: Date.now() + 600_000,
        },
      }),
    });
    renderDialog(
      host,
      { ...providerState([]), providerId: "codex" },
      () => undefined,
    );

    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByText("WDJB-MJHT")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Copy sign-in code" }),
    ).toBeTruthy();
    expect(openLink).toHaveBeenCalledWith(
      "https://auth.example.test/device",
      "auth",
      null,
    );
  });

  it("asks for a name after sign-in when the account's email is already on another profile", async () => {
    const withEmail = (profile: ProviderProfile): ProviderProfile => ({
      ...profile,
      identity: { email: WORK_EMAIL, tier: null, accountUuid: null },
    });
    const host = makeHost(() => undefined, [], {
      ...noOverrides,
      providersListHandler: () => ({
        providers: [
          providerState([
            withEmail(existingProfile()),
            withEmail(createdProfile()),
          ]),
        ],
        native: null,
      }),
    });
    const closed = Promise.withResolvers<boolean>();
    renderDialog(host, providerState([withEmail(existingProfile())]), (open) =>
      closed.resolve(open),
    );

    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    fireEvent.change(await screen.findByLabelText("Paste the code"), {
      target: { value: SIGN_IN_CODE },
    });
    fireEvent.click(screen.getByRole("button", { name: "Submit code" }));
    expect(
      await screen.findByText(
        "Existing profile already uses this email. Name this profile so you can tell them apart.",
      ),
    ).toBeTruthy();
    const name = screen.getByLabelText("Profile name");
    expect(name.hasAttribute("disabled")).toBe(false);
    fireEvent.change(name, { target: { value: "Second org" } });
    fireEvent.click(screen.getByRole("button", { name: "Save profile" }));

    await expect(closed.promise).resolves.toBe(false);
    expect(host.setEnabledRequests[0]).toMatchObject({
      profileAction: {
        type: "rename",
        profileId: PROFILE_ID,
        label: "Second org",
      },
    });
  });

  it("says the account is already signed in when sign-in lands on an existing profile", async () => {
    const host = makeHost(() => undefined, [], {
      ...noOverrides,
      linkCompleteHandler: () => ({
        state: "installing",
        code: null,
        account: null,
        expectedAccount: null,
        environmentProfileId: ENVIRONMENT_PROFILE_ID,
        profileId: EXISTING_PROFILE_ID,
      }),
      providersListHandler: () => ({
        providers: [providerState([existingProfile()])],
        native: null,
      }),
    });
    renderDialog(host, providerState([existingProfile()]), () => undefined);

    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    fireEvent.change(await screen.findByLabelText("Paste the code"), {
      target: { value: SIGN_IN_CODE },
    });
    fireEvent.click(screen.getByRole("button", { name: "Submit code" }));
    expect(await screen.findByText("Account already signed in")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Sign in again" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Done" })).toBeTruthy();
    expect(host.setEnabledRequests).toEqual([]);
  });
});
