import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { RefObject } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import {
  recordNegotiatedHostMethods,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import type { ProviderProfile } from "@traycer/protocol/host/provider-schemas";
import { PickerProfileDropdown } from "@/components/home/pickers/picker-profile-dropdown";
import { ProfileEditDialog } from "@/components/settings/panels/provider-profile-edit-dialog";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useProvidersListForClient } from "@/hooks/providers/use-providers-list-query";
import {
  createProfileListHost,
  readinessFor,
  type ProfileListAnswer,
  type ProfileListHost,
} from "@/components/providers/__tests__/profile-pin-host-fixture";
import {
  pinProfile,
  providerState,
} from "@/components/providers/__tests__/profile-pin-fixtures";
import type { HostRpcRegistry } from "@/lib/host";

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
  return { ...actual, useHostClient: () => holder.client };
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
  recordNegotiatedHostMethods(host.hostId, input.methods);
  const state = answerOf(input.profiles).providers[0];
  render(
    <host.Wrapper>
      <TooltipProvider>
        <ListedDropdown />
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
    holder.client = null;
    holder.hostId = null;
    resetNegotiatedManifests();
    cleanup();
  });

  it("a row with other names sends answerProfileName and the chip leaves", async () => {
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
    await screen.findByText("Home");
    fireEvent.change(nameField(), { target: { value: "Desk" } });
    fireEvent.click(
      screen.getByRole<HTMLButtonElement>("button", { name: "Save changes" }),
    );
    await waitFor(() => {
      expect(host.answerNameCalls).toEqual([
        { providerId: "opencode", profileId: "work-row", label: "Desk" },
      ]);
    });
    expect(host.setEnabledCalls).toEqual([]);
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

  it("a row with no other names still renames through setEnabled", async () => {
    const plain = managed({
      profileId: "work-row",
      label: "Work",
      otherNames: [],
    });
    const host = mount({
      profiles: [side, plain],
      profile: plain,
      methods: ["providers.list", "providers.answerProfileName"],
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
    expect(host.answerNameCalls).toEqual([]);
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

  it("a host without answerProfileName renames through setEnabled", async () => {
    const named = managed({
      profileId: "work-row",
      label: "Work",
      otherNames: ["Home"],
    });
    const host = mount({
      profiles: [side, named],
      profile: named,
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
    expect(host.answerNameCalls).toEqual([]);
    expect(host.setEnabledCalls[0]?.profileAction).toEqual({
      type: "rename",
      profileId: "work-row",
      label: "Desk",
    });
  });
});
