import "../../../../__tests__/test-browser-apis";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
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
import { EnvironmentAddProfileDialog } from "@/components/providers/environment-add-profile-dialog";
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
const ENVIRONMENT_PROFILE_ID = "environment-profile-created";
const PROFILE_ID = "managed-profile-created";
const EXISTING_PROFILE_ID = "managed-profile-existing";
const CHOSEN_COLOR = PROVIDER_PROFILE_ACCENT_COLORS[0];
const INITIAL_COLOR = PROVIDER_PROFILE_ACCENT_COLORS[1];
const SIGN_IN_CODE = "COLOR-CODE";

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
    <EnvironmentAddProfileDialog
      state={state}
      client={props.client}
      environmentId={ENVIRONMENT_ID}
      isLocalHost
      open
      onOpenChange={props.onOpenChange}
      onFailedAttempt={() => undefined}
      onProfileCreated={props.onProfileCreated}
      initialAccentColor={INITIAL_COLOR}
      sharesSkillsAndPlugins
    />
  );
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  resetNegotiatedManifests();
});

describe("EnvironmentAddProfileDialog profile color", () => {
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
    await screen.findByLabelText("One-time code");
    fireEvent.change(screen.getByLabelText("One-time code"), {
      target: { value: SIGN_IN_CODE },
    });
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    await host.providersListEvents.waitFor(2);
    await host.setEnabledEvents.waitFor(1);
    await screen.findByRole("button", { name: "Done" });
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

  it("unlocks after startup fails, then retries edited values and recolors the new profile", async () => {
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
      name: "Use terminal skills and plugins on this computer",
    });
    expect(shareTools.hasAttribute("disabled")).toBe(true);

    await act(async () => {
      firstStart.reject(new Error("Simulated startup failure."));
      await firstStart.promise.catch(() => undefined);
    });
    const failedAlert = await screen.findByRole("alert");
    expect(failedAlert.textContent).toBe("Sign-in did not start. Try again.");
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(screen.getByLabelText("Profile name").hasAttribute("disabled")).toBe(
      false,
    );
    expect(
      screen
        .getByRole("button", { name: `Use color ${CHOSEN_COLOR}` })
        .hasAttribute("disabled"),
    ).toBe(false);
    expect(shareTools.hasAttribute("disabled")).toBe(false);

    const profileName = screen.getByLabelText("Profile name");
    await user.clear(profileName);
    expect(
      screen.getByRole("button", { name: "Retry" }).hasAttribute("disabled"),
    ).toBe(true);
    await user.type(screen.getByLabelText("Profile name"), "Retry profile");
    expect(
      screen.getByRole("button", { name: "Retry" }).hasAttribute("disabled"),
    ).toBe(false);
    await user.click(
      screen.getByRole("button", {
        name: `Use color ${PROVIDER_PROFILE_ACCENT_COLORS[3]}`,
      }),
    );
    await user.click(shareTools);
    expect(screen.getByRole("alert").textContent).toBe(
      "Sign-in did not start. Try again.",
    );
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Retry" }));
    await host.linkEvents.waitFor(2);
    expect(host.linkRequests[0]).toEqual({
      providerId: "claude-code",
      profileId: null,
      environmentId: ENVIRONMENT_ID,
      createProfile: {
        label: "New profile",
        shareSkillsAndPlugins: true,
      },
      replaceAccount: false,
    });
    expect(host.linkRequests[1]).toEqual({
      providerId: "claude-code",
      profileId: null,
      environmentId: ENVIRONMENT_ID,
      createProfile: {
        label: "Retry profile",
        shareSkillsAndPlugins: false,
      },
      replaceAccount: false,
    });
    expect(screen.getByLabelText("Profile name").hasAttribute("disabled")).toBe(
      true,
    );
    expect(shareTools.hasAttribute("disabled")).toBe(true);

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
    await screen.findByLabelText("One-time code");
    expect(screen.getByLabelText("Profile name").hasAttribute("disabled")).toBe(
      true,
    );
    fireEvent.change(screen.getByLabelText("One-time code"), {
      target: { value: SIGN_IN_CODE },
    });
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    await host.setEnabledEvents.waitFor(1);
    await screen.findByRole("button", { name: "Done" });
    await expect(created.promise).resolves.toBe(PROFILE_ID);
    await expect(opened.promise).resolves.toBe(false);
    expect(host.setEnabledRequests[0]).toMatchObject({
      providerId: "claude-code",
      enabled: true,
      profileAction: {
        type: "recolor",
        profileId: PROFILE_ID,
        accentColor: PROVIDER_PROFILE_ACCENT_COLORS[3],
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
      await screen.findByLabelText("One-time code");
      fireEvent.change(screen.getByLabelText("One-time code"), {
        target: { value: SIGN_IN_CODE },
      });
      await user.click(screen.getByRole("button", { name: "Sign in" }));
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
      await screen.findByRole("button", { name: "Done" });
      expect(host.providersListCalls).toEqual([1, 2]);
      expect(onProfileCreated).not.toHaveBeenCalled();

      expect(screen.queryByRole("button", { name: "Close" })).toBeNull();
      fireEvent.keyDown(document, { key: "Escape" });
      const overlay = document.querySelector('[data-slot="dialog-overlay"]');
      expect(overlay).not.toBeNull();
      if (overlay === null) throw new Error("Dialog overlay was not rendered.");
      fireEvent.pointerDown(overlay, { button: 0, pointerType: "mouse" });
      await user.click(screen.getByRole("button", { name: "Done" }));
      expect(onOpenChange).not.toHaveBeenCalled();
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
    await screen.findByLabelText("One-time code");
    fireEvent.change(screen.getByLabelText("One-time code"), {
      target: { value: SIGN_IN_CODE },
    });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
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
