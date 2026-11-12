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
import type { RequestOfMethod } from "@traycer-clients/shared/host-transport/host-messenger";
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
  readonly setEnabledRequests: RequestOfMethod<
    HostRpcRegistry,
    "providers.setEnabled"
  >[];
  readonly providersListCalls: number[];
}

type StartLinkHandler = (
  request: ProvidersLinkRequestV12,
  callNumber: number,
) => ProvidersLinkResponseV12 | Promise<ProvidersLinkResponseV12>;

function makeHost(
  onInventoryProfileAdded: () => void,
  events: string[],
  startLinkHandler: StartLinkHandler | undefined,
): ColorHost {
  const linkRequests: ColorHost["linkRequests"] = [];
  const setEnabledRequests: ColorHost["setEnabledRequests"] = [];
  const providersListCalls: number[] = [];
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
        return startLinkHandler === undefined
          ? linkResponse
          : startLinkHandler(request, linkRequests.length);
      },
      "providers.linkComplete": (_request: LinkCompleteRequest) =>
        linkCompleteResponse,
      "providers.linkCancel": () => ({}),
      "providers.list": () => {
        const callNumber = providersListCalls.length + 1;
        providersListCalls.push(callNumber);
        if (callNumber === 2) onInventoryProfileAdded();
        const profiles =
          callNumber === 1
            ? [existingProfile()]
            : [existingProfile(), createdProfile()];
        return {
          providers: [providerState(profiles)],
          native: null,
        };
      },
      "providers.setEnabled": (request) => {
        events.push("recolor");
        setEnabledRequests.push(request);
        return { state: providerState([createdProfile()]) };
      },
    },
  });
  recordNegotiatedHostManifest(HOST_ID, MANIFEST);
  return {
    ...fixture,
    linkRequests,
    setEnabledRequests,
    providersListCalls,
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
      undefined,
    );
    const onOpenChange = vi.fn();
    const onProfileCreated = vi.fn();
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

    await waitFor(() =>
      expect(host.providersListCalls.length).toBeGreaterThan(0),
    );
    await user.click(
      screen.getByRole("button", { name: `Use color ${CHOSEN_COLOR}` }),
    );
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    await screen.findByLabelText("One-time code");
    fireEvent.change(screen.getByLabelText("One-time code"), {
      target: { value: SIGN_IN_CODE },
    });
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() =>
      expect(host.providersListCalls.length).toBeGreaterThan(1),
    );
    await waitFor(() => expect(host.setEnabledRequests).toHaveLength(1));
    await waitFor(() =>
      expect(onProfileCreated).toHaveBeenCalledWith(PROFILE_ID),
    );
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
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
    let rejectFirstStart: (error: Error) => void = () => {
      throw new Error("First sign-in did not start.");
    };
    let resolveSecondStart: (
      response: ProvidersLinkResponseV12,
    ) => void = () => {
      throw new Error("Retry sign-in did not start.");
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
      (_request, callNumber) => {
        if (callNumber === 1) {
          return new Promise<ProvidersLinkResponseV12>((_resolve, reject) => {
            rejectFirstStart = reject;
          });
        }
        return new Promise<ProvidersLinkResponseV12>((resolve) => {
          resolveSecondStart = resolve;
        });
      },
    );
    const onOpenChange = vi.fn();
    const onProfileCreated = vi.fn();
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

    await waitFor(() =>
      expect(host.providersListCalls.length).toBeGreaterThan(0),
    );
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() => expect(host.linkRequests).toHaveLength(1));
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
      rejectFirstStart(new Error("Simulated startup failure."));
      await Promise.resolve();
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
    await waitFor(() => expect(host.linkRequests).toHaveLength(2));
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
      resolveSecondStart({
        linkId: "link-created-profile",
        environmentProfileId: ENVIRONMENT_PROFILE_ID,
        prompt: {
          kind: "sign_in_url",
          url: "https://auth.example.test/sign-in",
          codePrompt: "One-time code",
        },
      });
      await Promise.resolve();
    });
    await screen.findByLabelText("One-time code");
    expect(screen.getByLabelText("Profile name").hasAttribute("disabled")).toBe(
      true,
    );
    fireEvent.change(screen.getByLabelText("One-time code"), {
      target: { value: SIGN_IN_CODE },
    });
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() => expect(host.setEnabledRequests).toHaveLength(1));
    await waitFor(() =>
      expect(onProfileCreated).toHaveBeenCalledWith(PROFILE_ID),
    );
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
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
});
