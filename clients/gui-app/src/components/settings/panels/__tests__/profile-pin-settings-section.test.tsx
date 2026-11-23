import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import {
  recordNegotiatedHostMethods,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import type { ProviderProfile } from "@traycer/protocol/host/provider-schemas";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useProvidersList } from "@/hooks/providers/use-providers-list-query";
import { readinessFor } from "@/components/providers/__tests__/profile-pin-host-fixture";
import {
  legacyProfile,
  pinProfile,
  providerState,
  removedEntry,
} from "@/components/providers/__tests__/profile-pin-fixtures";
import {
  createProfileListHost,
  type ProfileListAnswer,
  type ProfileListHost,
} from "@/components/providers/__tests__/profile-pin-host-fixture";
import { UNRESOLVED_PICK } from "@/lib/settings-environment-pages";
import type { HostRpcRegistry } from "@/lib/host";
import { useSettingsEnvironmentPickStore } from "@/stores/settings/settings-environment-pick-store";
import { ProviderProfileScopedSection } from "@/components/settings/panels/provider-profile-scoped-section";

const holder = vi.hoisted(() => ({
  client: null as HostClient<HostRpcRegistry> | null,
}));
const toastError = vi.hoisted(() => vi.fn<(message: string) => string>());

vi.mock("@/components/ui/dropdown-menu", async () =>
  (
    await import("@/components/providers/__tests__/profile-dropdown-menu-mock")
  ).profileDropdownMenuMock(),
);

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

vi.mock("sonner", () => ({
  toast: {
    error: (message: string) => toastError(message),
    success: () => "toast-1",
    dismiss: () => undefined,
  },
}));

vi.mock("@/components/settings/panels/provider-profile-edit-dialog", () => ({
  ProfileEditDialog: () => null,
}));

function managed(input: {
  readonly profileId: string;
  readonly label: string;
  readonly aliases: readonly string[];
  readonly personNotice: "needs-sign-in" | "waiting" | null;
  readonly terminalOnThisComputer: boolean;
  readonly otherNames: readonly string[];
  readonly authStatus: "authenticated" | "unauthenticated";
}): ProviderProfile {
  return pinProfile({ ...input, kind: "managed", enabled: true });
}

function stale(profile: ProviderProfile): ProviderProfile {
  return {
    ...profile,
    credentialHome: {
      homeAddress: "synthetic-home",
      bindingVersion: 1,
      materialRevision: 1,
      custodyVersion: 1,
      custodyClass: "self-sufficient",
      environmentPresence: null,
      handoffEnvironmentId: null,
      materialFingerprint: "synthetic-material",
      observation: null,
      materialMatchesBinding: "yes",
      standing: {
        material: "stale",
        repairDeadline: null,
        familyVersion: null,
        authority: null,
        cause: "Clock skew",
        observation: {
          source: "custodian",
          status: "answered",
          capturedAt: 1,
        },
      },
    },
  };
}

function answerOf(
  profiles: readonly ProviderProfile[],
  removed: ProfileListAnswer["removedProfiles"],
): ProfileListAnswer {
  return {
    providers: [
      providerState({
        providerId: "opencode",
        authStatus: "authenticated",
        profiles,
      }),
    ],
    native: null,
    removedProfiles: [...removed],
  };
}

function ListedSection(props: { readonly selectedProfileId: string | null }) {
  const list = useProvidersList({ enabled: true, subscribed: true });
  const state = list.data?.providers.find(
    (provider) => provider.providerId === "opencode",
  );
  if (state === undefined) return null;
  return (
    <ProviderProfileScopedSection
      state={state}
      hostId={holder.client?.getActiveHostId() ?? null}
      isSelectedHostLocal
      canAddProfile
      credentialRefusal={null}
      onOpenCliSettings={() => undefined}
      startInReauth={false}
      failedAttempt={null}
      onAddProfile={() => undefined}
      onDismissFailedAttempt={() => undefined}
      selectedProfileId={props.selectedProfileId}
      onSelectedProfileIdChange={() => undefined}
      profileEnablementAvailable={false}
      profileEnablementPending={() => false}
      onSetProfileEnabled={() => undefined}
    />
  );
}

function mount(input: {
  readonly profiles: readonly ProviderProfile[];
  readonly removed: ProfileListAnswer["removedProfiles"];
  readonly selectedProfileId: string | null;
  readonly answerLabel: string | null;
  readonly failAnswer: boolean;
  readonly methods: readonly string[];
  readonly listLabelAfterAnswer?: string;
}): ProfileListHost {
  const host = createProfileListHost({
    answer: answerOf(input.profiles, input.removed),
    listLabelAfterAnswer: input.listLabelAfterAnswer,
    answerProfileName: (request) => {
      if (input.failAnswer) {
        throw new HostRpcError({
          code: "RPC_ERROR",
          message: "The name was not saved.",
          requestId: "req-1",
          method: "providers.answerProfileName",
          fatalDetails: null,
        });
      }
      return { label: input.answerLabel ?? request.label };
    },
    failSetEnabled: false,
  });
  holder.client = host.client;
  recordNegotiatedHostMethods(host.hostId, input.methods);
  render(
    <host.Wrapper>
      <TooltipProvider>
        <ListedSection selectedProfileId={input.selectedProfileId} />
      </TooltipProvider>
    </host.Wrapper>,
  );
  return host;
}

const ANSWER_NAME = ["providers.answerProfileName"] as const;

const side = managed({
  profileId: "side-row",
  label: "Side",
  aliases: [],
  personNotice: null,
  terminalOnThisComputer: false,
  otherNames: [],
  authStatus: "authenticated",
});

const work = managed({
  profileId: "work-row",
  label: "Work",
  aliases: ["alias-work"],
  personNotice: null,
  terminalOnThisComputer: false,
  otherNames: [],
  authStatus: "authenticated",
});

function triggerName(): string | null {
  return screen
    .getByRole("button", { name: /^OpenCode profile: / })
    .getAttribute("aria-label");
}

describe("Settings profile pin", () => {
  afterEach(() => {
    holder.client = null;
    toastError.mockReset();
    resetNegotiatedManifests();
    useSettingsEnvironmentPickStore.setState({
      pick: null,
      defaultPick: UNRESOLVED_PICK,
      defaultHostId: null,
    });
    cleanup();
  });

  it("a removed focus id shows the first row and checks none after the list names it", async () => {
    const host = mount({
      profiles: [side, work],
      removed: [
        removedEntry({
          providerId: "opencode",
          profileId: "gone-row",
          aliases: [],
        }),
      ],
      selectedProfileId: "gone-row",
      answerLabel: null,
      failAnswer: false,
      methods: ANSWER_NAME,
    });
    await waitFor(() => {
      expect(host.listCalls.length).toBeGreaterThan(0);
      expect(triggerName()).toBe("OpenCode profile: Side");
    });
    expect(screen.queryByRole("menuitem", { current: true })).toBeNull();
  });

  it("needs a sign-in replaces the status badge, hides the detail, and offers Sign in", async () => {
    const noticed = stale(
      managed({
        profileId: "work-row",
        label: "Work",
        aliases: [],
        personNotice: "needs-sign-in",
        terminalOnThisComputer: false,
        otherNames: [],
        authStatus: "authenticated",
      }),
    );
    mount({
      profiles: [side, noticed],
      removed: [],
      selectedProfileId: "work-row",
      answerLabel: null,
      failAnswer: false,
      methods: [],
    });
    const notices = await screen.findAllByText("Needs a sign-in");
    expect(
      notices.some((node) => node.getAttribute("data-slot") === "badge"),
    ).toBe(true);
    expect(screen.queryByText("Clock skew")).toBeNull();
    expect(screen.queryByText("Stale")).toBeNull();
    expect(screen.getByRole("button", { name: "Sign in" })).toBeDefined();
    expect(
      screen
        .getByRole("menuitem", { current: true })
        .getAttribute("aria-label"),
    ).toContain("Needs a sign-in");
  });

  it("waiting for Traycer replaces the status badge and offers Sign in", async () => {
    const noticed = stale(
      managed({
        profileId: "work-row",
        label: "Work",
        aliases: [],
        personNotice: "waiting",
        terminalOnThisComputer: false,
        otherNames: [],
        authStatus: "authenticated",
      }),
    );
    mount({
      profiles: [side, noticed],
      removed: [],
      selectedProfileId: "work-row",
      answerLabel: null,
      failAnswer: false,
      methods: [],
    });
    const notices = await screen.findAllByText("Waiting for Traycer");
    expect(
      notices.some((node) => node.getAttribute("data-slot") === "badge"),
    ).toBe(true);
    expect(screen.queryByText("Clock skew")).toBeNull();
    expect(screen.getByRole("button", { name: "Sign in" })).toBeDefined();
  });

  it("a null person notice keeps the standing badge and its detail", async () => {
    mount({
      profiles: [
        side,
        stale(
          managed({
            profileId: "work-row",
            label: "Work",
            aliases: [],
            personNotice: null,
            terminalOnThisComputer: false,
            otherNames: [],
            authStatus: "authenticated",
          }),
        ),
      ],
      removed: [],
      selectedProfileId: "work-row",
      answerLabel: null,
      failAnswer: false,
      methods: [],
    });
    await screen.findByText("Stale");
    expect(screen.getByText("Clock skew")).toBeDefined();
    expect(screen.queryByText("Needs a sign-in")).toBeNull();
    expect(screen.queryByRole("button", { name: "Sign in" })).toBeNull();
  });

  it("the selected record names the computer on the second line", async () => {
    useSettingsEnvironmentPickStore.setState({
      pick: { kind: "local", hostId: "desk-1", hostName: "North desk" },
    });
    const terminal = managed({
      profileId: "work-row",
      label: "Work",
      aliases: [],
      personNotice: null,
      terminalOnThisComputer: true,
      otherNames: [],
      authStatus: "authenticated",
    });
    mount({
      profiles: [side, terminal],
      removed: [],
      selectedProfileId: null,
      answerLabel: null,
      failAnswer: false,
      methods: [],
    });
    await waitFor(() => {
      expect(
        screen.getAllByText("Terminal account on North desk"),
      ).toHaveLength(2);
    });
    expect(triggerName()).toBe("OpenCode profile: Work");
    expect(
      screen
        .getByRole("menuitem", { current: true })
        .getAttribute("aria-label"),
    ).toContain("Terminal account on North desk");
  });

  it("the selected record says Terminal account when the page has no computer name", async () => {
    const terminal = managed({
      profileId: "work-row",
      label: "Work",
      aliases: [],
      personNotice: null,
      terminalOnThisComputer: true,
      otherNames: [],
      authStatus: "authenticated",
    });
    mount({
      profiles: [side, terminal],
      removed: [],
      selectedProfileId: null,
      answerLabel: null,
      failAnswer: false,
      methods: [],
    });
    await waitFor(() => {
      expect(screen.getAllByText("Terminal account")).toHaveLength(2);
    });
    expect(screen.queryByText(/Terminal account on/)).toBeNull();
  });

  it("an ambient row with the flag has no terminal account line", async () => {
    const ambient = pinProfile({
      profileId: "ambient-row",
      label: "Desk login",
      kind: "ambient",
      enabled: true,
      authStatus: "authenticated",
      aliases: [],
      personNotice: null,
      terminalOnThisComputer: true,
      otherNames: [],
    });
    mount({
      profiles: [ambient, side],
      removed: [],
      selectedProfileId: null,
      answerLabel: null,
      failAnswer: false,
      methods: [],
    });
    await screen.findByRole("button", {
      name: "OpenCode profile: OpenCode's own login",
    });
    expect(screen.queryByText(/Terminal account/)).toBeNull();
  });

  it("one other name asks for a pick and the current name is pressed", async () => {
    const named = managed({
      profileId: "work-row",
      label: "Work",
      aliases: [],
      personNotice: null,
      terminalOnThisComputer: false,
      otherNames: ["Home"],
      authStatus: "authenticated",
    });
    mount({
      profiles: [side, named],
      removed: [],
      selectedProfileId: "work-row",
      answerLabel: null,
      failAnswer: false,
      methods: ANSWER_NAME,
    });
    expect(
      await screen.findByText(
        "This account had two names. Pick the one to use on every computer.",
      ),
    ).toBeDefined();
    const group = screen.getByRole("group", { name: "Account name" });
    expect(
      within(group).getByRole<HTMLButtonElement>("button", { name: "Work" })
        .ariaPressed,
    ).toBe("true");
    expect(
      within(group).getByRole<HTMLButtonElement>("button", { name: "Home" })
        .ariaPressed,
    ).toBe("false");
    expect(
      screen.getByRole("button", { name: 'Keep "Work" and hide this' }),
    ).toBeDefined();
  });

  it("two other names say more than one name", async () => {
    const named = managed({
      profileId: "work-row",
      label: "Work",
      aliases: [],
      personNotice: null,
      terminalOnThisComputer: false,
      otherNames: ["Home", "Desk"],
      authStatus: "authenticated",
    });
    mount({
      profiles: [side, named],
      removed: [],
      selectedProfileId: "work-row",
      answerLabel: null,
      failAnswer: false,
      methods: ANSWER_NAME,
    });
    expect(
      await screen.findByText(
        "This account had more than one name. Pick the one to use on every computer.",
      ),
    ).toBeDefined();
    const group = screen.getByRole("group", { name: "Account name" });
    expect(within(group).getAllByRole("button")).toHaveLength(3);
  });

  it("pressing Home sends that label and the block leaves", async () => {
    const named = managed({
      profileId: "work-row",
      label: "Work",
      aliases: [],
      personNotice: null,
      terminalOnThisComputer: false,
      otherNames: ["Home"],
      authStatus: "authenticated",
    });
    const host = mount({
      profiles: [side, named],
      removed: [],
      selectedProfileId: "work-row",
      answerLabel: null,
      failAnswer: false,
      methods: ANSWER_NAME,
    });
    fireEvent.click(
      await screen.findByRole("button", { name: "Home", pressed: false }),
    );
    await waitFor(() => {
      expect(host.answerNameCalls).toEqual([
        { providerId: "opencode", profileId: "work-row", label: "Home" },
      ]);
    });
    await waitFor(() => {
      expect(triggerName()).toBe("OpenCode profile: Home");
    });
    expect(screen.queryByRole("group", { name: "Account name" })).toBeNull();
    expect(
      screen.queryByText("Home", { selector: "[class*='badge']" }),
    ).toBeNull();
  });

  it("an answer that kept Work shows Work and the block leaves", async () => {
    const named = managed({
      profileId: "work-row",
      label: "Work",
      aliases: [],
      personNotice: null,
      terminalOnThisComputer: false,
      otherNames: ["Home"],
      authStatus: "authenticated",
    });
    const host = mount({
      profiles: [side, named],
      removed: [],
      selectedProfileId: "work-row",
      answerLabel: "Work",
      failAnswer: false,
      methods: ANSWER_NAME,
    });
    fireEvent.click(
      await screen.findByRole("button", { name: "Home", pressed: false }),
    );
    await waitFor(() => {
      expect(host.answerNameCalls[0]?.label).toBe("Home");
    });
    await waitFor(() => {
      expect(screen.queryByRole("group", { name: "Account name" })).toBeNull();
    });
    expect(triggerName()).toBe("OpenCode profile: Work");
    expect(toastError).not.toHaveBeenCalled();
  });

  it("a later list name replaces the answer's label and shows no error dialog", async () => {
    const named = managed({
      profileId: "work-row",
      label: "Work",
      aliases: [],
      personNotice: null,
      terminalOnThisComputer: false,
      otherNames: ["Home"],
      authStatus: "authenticated",
    });
    const host = mount({
      profiles: [side, named],
      removed: [],
      selectedProfileId: "work-row",
      answerLabel: "Kept",
      listLabelAfterAnswer: "Listed",
      failAnswer: false,
      methods: ANSWER_NAME,
    });
    fireEvent.click(
      await screen.findByRole("button", { name: "Home", pressed: false }),
    );
    await waitFor(() => {
      expect(host.answerNameCalls[0]?.label).toBe("Home");
    });
    await waitFor(() => {
      expect(triggerName()).toBe("OpenCode profile: Listed");
    });
    expect(toastError).not.toHaveBeenCalled();
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("keep Work sends the current label and the block leaves", async () => {
    const named = managed({
      profileId: "work-row",
      label: "Work",
      aliases: [],
      personNotice: null,
      terminalOnThisComputer: false,
      otherNames: ["Home"],
      authStatus: "authenticated",
    });
    const host = mount({
      profiles: [side, named],
      removed: [],
      selectedProfileId: "work-row",
      answerLabel: null,
      failAnswer: false,
      methods: ANSWER_NAME,
    });
    fireEvent.click(
      await screen.findByRole("button", { name: 'Keep "Work" and hide this' }),
    );
    await waitFor(() => {
      expect(host.answerNameCalls).toEqual([
        { providerId: "opencode", profileId: "work-row", label: "Work" },
      ]);
    });
    await waitFor(() => {
      expect(screen.queryByRole("group", { name: "Account name" })).toBeNull();
    });
    expect(triggerName()).toBe("OpenCode profile: Work");
  });

  it("pressing the current name sends nothing", async () => {
    const named = managed({
      profileId: "work-row",
      label: "Work",
      aliases: [],
      personNotice: null,
      terminalOnThisComputer: false,
      otherNames: ["Home"],
      authStatus: "authenticated",
    });
    const host = mount({
      profiles: [side, named],
      removed: [],
      selectedProfileId: "work-row",
      answerLabel: null,
      failAnswer: false,
      methods: ANSWER_NAME,
    });
    const group = await screen.findByRole("group", { name: "Account name" });
    fireEvent.click(within(group).getByRole("button", { name: "Work" }));
    expect(host.answerNameCalls).toEqual([]);
    expect(group.isConnected).toBe(true);
  });

  it("a host that does not advertise the method shows no block", async () => {
    const named = managed({
      profileId: "work-row",
      label: "Work",
      aliases: [],
      personNotice: null,
      terminalOnThisComputer: false,
      otherNames: ["Home"],
      authStatus: "authenticated",
    });
    mount({
      profiles: [side, named],
      removed: [],
      selectedProfileId: "work-row",
      answerLabel: null,
      failAnswer: false,
      methods: ["providers.list"],
    });
    await screen.findByRole("button", { name: "OpenCode profile: Work" });
    expect(screen.queryByRole("group", { name: "Account name" })).toBeNull();
  });

  it("a 10.10-shaped row shows no block and no other-name chip", async () => {
    const older = legacyProfile({
      profileId: "work-row",
      label: "Work",
      kind: "managed",
      enabled: true,
      authStatus: "authenticated",
    });
    mount({
      profiles: [side, older],
      removed: [],
      selectedProfileId: "work-row",
      answerLabel: null,
      failAnswer: false,
      methods: ANSWER_NAME,
    });
    await screen.findByRole("button", { name: "OpenCode profile: Work" });
    expect(screen.queryByRole("group", { name: "Account name" })).toBeNull();
    expect(screen.queryByText(/Also named/)).toBeNull();
  });

  it("a failed answer toasts Couldn't rename profile and the block stays", async () => {
    const named = managed({
      profileId: "work-row",
      label: "Work",
      aliases: [],
      personNotice: null,
      terminalOnThisComputer: false,
      otherNames: ["Home"],
      authStatus: "authenticated",
    });
    const host = mount({
      profiles: [side, named],
      removed: [],
      selectedProfileId: "work-row",
      answerLabel: null,
      failAnswer: true,
      methods: ANSWER_NAME,
    });
    fireEvent.click(
      await screen.findByRole("button", { name: "Home", pressed: false }),
    );
    await waitFor(() => {
      expect(host.answerNameCalls).toEqual([
        { providerId: "opencode", profileId: "work-row", label: "Home" },
      ]);
      expect(toastError).toHaveBeenCalledWith("Couldn't rename profile.");
    });
    expect(screen.getByRole("group", { name: "Account name" })).toBeDefined();
  });
});
