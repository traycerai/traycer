import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { RefObject } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import {
  recordNegotiatedHostManifest,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import type { ProviderProfile } from "@traycer/protocol/host/provider-schemas";
import { PickerProfileDropdown } from "@/components/home/pickers/picker-profile-dropdown";
import { ProfileEditDialog } from "@/components/settings/panels/provider-profile-edit-dialog";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useProvidersListForClient } from "@/hooks/providers/use-providers-list-query";
import { useProfileRecordEnvironmentId } from "@/hooks/providers/use-profile-record-environment-id";
import {
  createProfileListHost,
  readinessFor,
  type ProfileListAnswer,
  type ProfileListHost,
} from "@/components/providers/__tests__/profile-pin-host-fixture";
import {
  pinProfile,
  legacyProfile,
  providerState,
} from "@/components/providers/__tests__/profile-pin-fixtures";
import {
  userSubscription,
  userWith,
} from "@/lib/sandboxes/__tests__/auth-user-fixture";
import { profileUsesRecord } from "@/components/providers/provider-profile-model";
import type { HostRpcRegistry } from "@/lib/host";
import { AuthService } from "@/lib/auth/auth-service";
import { useAuthStore } from "@/stores/auth/auth-store";

const AUTH = vi.hoisted(() => ({ service: null as AuthService | null }));

const holder = vi.hoisted(() => ({
  client: null as HostClient<HostRpcRegistry> | null,
  hostId: null as string | null,
}));

vi.mock("@/components/ui/dropdown-menu", async () =>
  (
    await import("@/components/providers/__tests__/profile-dropdown-menu-mock")
  ).profileDropdownMenuMock(),
);

vi.mock("@/hooks/rate-limits/use-profile-usage-presentation", () => ({
  useProfileUsagePresentation: () => null,
}));

vi.mock("@/lib/host", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/host")>();
  return {
    ...actual,
    useHostClient: () => holder.client,
    useAuthService: () => AUTH.service,
  };
});

vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: () => holder.client,
  useHostDirectoryEntryForHostId: () => null,
}));

vi.mock("@/hooks/host/use-reactive-host-readiness", () => ({
  useReactiveHostReadiness: (client: object | null) => readinessFor(client),
}));

vi.mock(
  "@/components/settings/personal/personal-page-context",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@/components/settings/personal/personal-page-context")
      >();
    return {
      ...actual,
      usePersonalPageHost: () => ({
        hostId: holder.hostId,
        client: holder.client,
      }),
    };
  },
);

vi.mock("@/hooks/providers/use-remove-provider-profile-mutation", () => ({
  useRemoveProviderProfile: () => ({
    mutate: () => undefined,
    isPending: false,
    error: null,
  }),
}));

vi.mock("@/hooks/providers/use-recolor-provider-profile-mutation", () => ({
  useRecolorProviderProfile: () => ({
    mutate: () => undefined,
    isPending: false,
    error: null,
  }),
}));

vi.mock("@/hooks/providers/use-refresh-providers", () => ({
  useRefreshProviders: () => () => Promise.resolve(),
}));

const INPUT_REF: RefObject<HTMLInputElement | null> = { current: null };
const VALIDATION_URL = "http://localhost:5005/api/v3/user/negotiated";
const PROFILE_RECORD_URL =
  "http://localhost:5005/api/v3/environments/environment-profile-fixture/profile-records/work-row/name";

interface HttpCall {
  readonly url: string;
  readonly method: string | undefined;
  readonly body: BodyInit | null | undefined;
}

const httpCalls: HttpCall[] = [];
const recordNameTransport = {
  onNameAccepted: (_name: string): void => undefined,
};

function validationResponse(): Response {
  const user = userWith(
    userSubscription({
      totalPlanCredits: 0,
      consumedFromPlan: 0,
      bonusCredits: 0,
      consumedFromBonus: 0,
      bundleRemaining: 0,
    }),
    [],
  );
  return new Response(JSON.stringify(user), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "x-traycer-user-record-version": "3.0",
    },
  });
}

async function signedInAuthService(denied: boolean): Promise<AuthService> {
  const runnerHost = new MockRunnerHost({
    signInUrl: "https://auth.traycer.invalid/sign-in",
    authnBaseUrl: "http://localhost:5005",
    localHost: null,
    hosts: [],
    workspaceFolderPickerPaths: undefined,
    hasLocalHost: undefined,
    traycerCli: undefined,
  });
  const service = new AuthService({ runnerHost });
  await runnerHost.tokenStore.signIn(
    {
      token: "synthetic-person-token",
      refreshToken: "synthetic-refresh-token",
    },
    { id: "u1", email: "ada@example.com", name: "Ada" },
  );
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>((input, init) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      if (url === VALIDATION_URL) return Promise.resolve(validationResponse());
      httpCalls.push({ url, method: init?.method, body: init?.body });
      if (!denied) recordNameTransport.onNameAccepted("Desk");
      return Promise.resolve(
        new Response(
          JSON.stringify(
            denied
              ? {
                  statusCode: 403,
                  error: "private response detail",
                  code: "environment_action_forbidden",
                }
              : {
                  profileId: "work-row",
                  harnessId: "opencode",
                  recordRevision: "18",
                  name: "Desk",
                },
          ),
          {
            status: denied ? 403 : 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
      );
    }),
  );
  await service.start();
  AUTH.service = service;
  httpCalls.length = 0;
  return service;
}

function managed(input: {
  readonly profileId: string;
  readonly label: string;
  readonly otherNames: readonly string[];
}): ProviderProfile {
  return pinProfile({
    profileId: input.profileId,
    label: input.label,
    kind: "managed",
    enabled: true,
    authStatus: "authenticated",
    aliases: [],
    personNotice: null,
    terminalOnThisComputer: false,
    otherNames: input.otherNames,
  });
}

function answerOf(profiles: readonly ProviderProfile[]): ProfileListAnswer {
  return {
    providers: [
      providerState({
        providerId: "opencode",
        authStatus: "authenticated",
        profiles,
      }),
    ],
    native: null,
    removedProfiles: [],
  };
}

function ListedDropdown() {
  const list = useProvidersListForClient(holder.client, {
    enabled: true,
    subscribed: true,
  });
  const state = list.data?.providers.find(
    (provider) => provider.providerId === "opencode",
  );
  if (state === undefined || holder.hostId === null) return null;
  return (
    <PickerProfileDropdown
      providerId="opencode"
      providerLabel="OpenCode"
      profiles={state.profiles}
      activeProfileId="work-row"
      onSelectProfile={() => undefined}
      onCreateProfile={() => undefined}
      createProfileDisabled={false}
      createProfileDisabledReason={undefined}
      shortcutHintForIndex={() => null}
      profileEnablementPending={() => false}
      contentContainer={null}
      inputRef={INPUT_REF}
      runTargetHostId={holder.hostId}
      admissionByProfileId={null}
    />
  );
}

function RecordEnvironmentIdReadout() {
  const environmentId = useProfileRecordEnvironmentId(holder.client, true);
  return <output>{environmentId}</output>;
}

function mount(input: {
  readonly profiles: readonly ProviderProfile[];
  readonly profile: ProviderProfile;
  readonly methods: readonly string[];
}): ProfileListHost {
  const host = createProfileListHost({
    answer: answerOf(input.profiles),
    answerProfileName: (request) => ({ label: request.label }),
    failSetEnabled: false,
  });
  holder.client = host.client;
  holder.hostId = host.hostId;
  const recordRow = profileUsesRecord(input.profile);
  if (recordRow) host.exposeEnvironmentBinding();
  const methods = [
    ...input.methods,
    ...(recordRow ? ["environment.status", "environment.host.read"] : []),
  ];
  recordNegotiatedHostManifest(
    host.hostId,
    Object.fromEntries(
      methods.map((method) => [method, methodVersion(method)]),
    ),
  );
  const state = answerOf(input.profiles).providers[0];
  render(
    <host.Wrapper>
      <TooltipProvider>
        <ListedDropdown />
        {recordRow ? <RecordEnvironmentIdReadout /> : null}
        <ProfileEditDialog
          state={state}
          profile={input.profile}
          profiles={input.profiles}
          canOauth={false}
          oauthUnavailableHint={null}
          startInReauth={false}
          isLocalHost
          open
          onOpenChange={() => undefined}
          remainingProfilesAfterRemoval={input.profiles}
          onSelectedProfileIdChange={() => undefined}
          profileEnablementAvailable={false}
          profileEnablementPending={() => false}
          onSetProfileEnabled={() => undefined}
        />
      </TooltipProvider>
    </host.Wrapper>,
  );
  return host;
}

function methodVersion(method: string): {
  readonly major: number;
  readonly minor: number;
} {
  if (method === "environment.status") return { major: 1, minor: 2 };
  if (method === "environment.host.read") return { major: 1, minor: 1 };
  if (method === "providers.list") return { major: 10, minor: 13 };
  if (method === "providers.setEnabled") return { major: 2, minor: 1 };
  return { major: 1, minor: 0 };
}

function nameField(): HTMLInputElement {
  const field = screen.getByRole("textbox", { name: "Profile name" });
  if (!(field instanceof HTMLInputElement)) {
    throw new Error("expected the profile name field");
  }
  return field;
}

const side = managed({
  profileId: "side-row",
  label: "Side",
  otherNames: [],
});

describe("ProfileEditDialog rename", () => {
  afterEach(() => {
    AUTH.service?.dispose();
    AUTH.service = null;
    useAuthStore.getState().setSignedOut();
    holder.client = null;
    holder.hostId = null;
    httpCalls.length = 0;
    recordNameTransport.onNameAccepted = () => undefined;
    resetNegotiatedManifests();
    cleanup();
    vi.unstubAllGlobals();
  });

  it("a record with empty aliases uses the app name route when sign-in offers are absent", async () => {
    await signedInAuthService(false);
    const named = managed({
      profileId: "work-row",
      label: "Work",
      otherNames: [],
    });
    const host = mount({
      profiles: [side, named],
      profile: named,
      methods: [
        "providers.list",
        "providers.answerProfileName",
        "providers.setEnabled",
      ],
    });
    recordNameTransport.onNameAccepted = (name) => {
      host.answer.providers = host.answer.providers.map((provider) =>
        provider.providerId !== "opencode"
          ? provider
          : {
              ...provider,
              profiles: provider.profiles.map((profile) =>
                profile.profileId === "work-row"
                  ? { ...profile, label: name, otherNames: [] }
                  : profile,
              ),
            },
      );
    };
    await screen.findByText("environment-profile-fixture");
    await screen.findByRole("textbox", { name: "Profile name" });
    fireEvent.change(nameField(), { target: { value: "Desk" } });
    fireEvent.click(
      screen.getByRole<HTMLButtonElement>("button", { name: "Save changes" }),
    );
    await waitFor(() => {
      expect(httpCalls).toEqual([
        {
          url: PROFILE_RECORD_URL,
          method: "POST",
          body: JSON.stringify({ harnessId: "opencode", name: "Desk" }),
        },
      ]);
    });
    expect(host.rpcCalls.map((call) => call.method)).not.toContain(
      "providers.answerProfileName",
    );
    expect(host.rpcCalls.map((call) => call.method)).not.toContain(
      "providers.setEnabled",
    );
    await waitFor(() => expect(host.listCalls.length).toBeGreaterThan(1));
    await waitFor(() => {
      expect(
        screen
          .getByRole("button", {
            name: /^OpenCode profile: /,
            hidden: true,
          })
          .getAttribute("aria-label"),
      ).toBe("OpenCode profile: Desk");
    });
  });

  it("a record with other names also uses the app name route", async () => {
    await signedInAuthService(false);
    const named = managed({
      profileId: "work-row",
      label: "Work",
      otherNames: ["Home"],
    });
    const host = mount({
      profiles: [side, named],
      profile: named,
      methods: ["providers.list", "providers.answerProfileName"],
    });
    recordNameTransport.onNameAccepted = (name) => {
      host.answer.providers = host.answer.providers.map((provider) =>
        provider.providerId !== "opencode"
          ? provider
          : {
              ...provider,
              profiles: provider.profiles.map((profile) =>
                profile.profileId === "work-row"
                  ? { ...profile, label: name, otherNames: [] }
                  : profile,
              ),
            },
      );
    };
    await screen.findByText("Home");
    fireEvent.change(nameField(), { target: { value: "Desk" } });
    fireEvent.click(
      screen.getByRole<HTMLButtonElement>("button", { name: "Save changes" }),
    );
    await waitFor(() => {
      expect(httpCalls).toEqual([
        {
          url: PROFILE_RECORD_URL,
          method: "POST",
          body: JSON.stringify({ harnessId: "opencode", name: "Desk" }),
        },
      ]);
    });
    expect(host.rpcCalls.map((call) => call.method)).not.toContain(
      "providers.answerProfileName",
    );
    expect(host.rpcCalls.map((call) => call.method)).not.toContain(
      "providers.setEnabled",
    );
    await waitFor(() => expect(host.listCalls.length).toBeGreaterThan(1));
    await waitFor(() => {
      expect(
        screen
          .getByRole("button", {
            name: /^OpenCode profile: /,
            hidden: true,
          })
          .getAttribute("aria-label"),
      ).toBe("OpenCode profile: Desk");
    });
    expect(screen.queryByText("Also named Home")).toBeNull();
    expect(screen.queryByText("Home")).toBeNull();
  });

  it("a local row keeps its computer rename call", async () => {
    await signedInAuthService(false);
    const local = legacyProfile({
      profileId: "work-row",
      label: "Work",
      kind: "managed",
      enabled: true,
      authStatus: "authenticated",
    });
    const host = mount({
      profiles: [side, local],
      profile: local,
      methods: ["providers.list"],
    });
    await screen.findByRole("textbox", { name: "Profile name" });
    fireEvent.change(nameField(), { target: { value: "Desk" } });
    fireEvent.click(
      screen.getByRole<HTMLButtonElement>("button", { name: "Save changes" }),
    );
    await waitFor(() => {
      expect(host.setEnabledCalls).toHaveLength(1);
    });
    expect(host.setEnabledCalls[0]?.profileAction).toEqual({
      type: "rename",
      profileId: "work-row",
      label: "Desk",
    });
    await waitFor(() => {
      expect(
        screen
          .getByRole("button", {
            name: /^OpenCode profile: /,
            hidden: true,
          })
          .getAttribute("aria-label"),
      ).toBe("OpenCode profile: Desk");
    });
    expect(httpCalls).toEqual([]);
  });

  it("a local row without answerProfileName keeps the rename fallback", async () => {
    await signedInAuthService(false);
    const local = {
      ...legacyProfile({
        profileId: "work-row",
        label: "Work",
        kind: "managed",
        enabled: true,
        authStatus: "authenticated",
      }),
      otherNames: ["Home"],
    };
    const host = mount({
      profiles: [side, local],
      profile: local,
      methods: ["providers.list"],
    });
    await screen.findByText("Home");
    fireEvent.change(nameField(), { target: { value: "Desk" } });
    fireEvent.click(
      screen.getByRole<HTMLButtonElement>("button", { name: "Save changes" }),
    );
    await waitFor(() => {
      expect(host.setEnabledCalls).toHaveLength(1);
    });
    expect(host.setEnabledCalls[0]?.profileAction).toEqual({
      type: "rename",
      profileId: "work-row",
      label: "Desk",
    });
    expect(httpCalls).toEqual([]);
  });

  it("shows the existing refusal sentence without exposing the server error", async () => {
    await signedInAuthService(true);
    const named = managed({
      profileId: "work-row",
      label: "Work",
      otherNames: [],
    });
    const host = mount({
      profiles: [side, named],
      profile: named,
      methods: [
        "providers.list",
        "providers.answerProfileName",
        "providers.setEnabled",
      ],
    });
    await screen.findByText("environment-profile-fixture");
    await screen.findByRole("textbox", { name: "Profile name" });
    fireEvent.change(nameField(), { target: { value: "Desk" } });
    fireEvent.click(
      screen.getByRole<HTMLButtonElement>("button", { name: "Save changes" }),
    );
    await screen.findByText("You don't have permission to do that.");
    expect(screen.queryByText("private response detail")).toBeNull();
    expect(host.rpcCalls.map((call) => call.method)).not.toContain(
      "providers.setEnabled",
    );
    expect(host.rpcCalls.map((call) => call.method)).not.toContain(
      "providers.answerProfileName",
    );
    expect(httpCalls).toEqual([
      {
        url: PROFILE_RECORD_URL,
        method: "POST",
        body: JSON.stringify({ harnessId: "opencode", name: "Desk" }),
      },
    ]);
    expect(host.listCalls.length).toBeGreaterThan(1);
  });
});
