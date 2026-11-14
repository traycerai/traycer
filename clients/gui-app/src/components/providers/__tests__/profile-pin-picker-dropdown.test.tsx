import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { RefObject } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { ProviderProfile } from "@traycer/protocol/host/provider-schemas";
import { PickerProfileDropdown } from "@/components/home/pickers/picker-profile-dropdown";
import type { HostRpcRegistry } from "@/lib/host";
import {
  pinProfile,
  legacyProfile,
  providerState,
  removedEntry,
} from "./profile-pin-fixtures";
import {
  createProfileListHost,
  readinessFor,
  type ProfileListAnswer,
  type ProfileListHost,
} from "./profile-pin-host-fixture";

const holder = vi.hoisted(() => ({
  client: null as HostClient<HostRpcRegistry> | null,
  computerLabel: null as string | null,
}));

vi.mock("@/components/ui/dropdown-menu", async () =>
  (await import("./profile-dropdown-menu-mock")).profileDropdownMenuMock(),
);

vi.mock("@/hooks/rate-limits/use-profile-usage-presentation", () => ({
  useProfileUsagePresentation: () => null,
}));

vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: () => holder.client,
  useHostDirectoryEntryForHostId: () =>
    holder.computerLabel === null ? null : { label: holder.computerLabel },
}));

vi.mock("@/hooks/host/use-reactive-host-readiness", () => ({
  useReactiveHostReadiness: (client: object | null) => readinessFor(client),
}));

const INPUT_REF: RefObject<HTMLInputElement | null> = { current: null };
const ALIAS_ID = "alias-work";

function row(input: {
  readonly profileId: string;
  readonly label: string;
  readonly kind: "ambient" | "managed";
  readonly authStatus: "authenticated" | "unauthenticated";
  readonly aliases: readonly string[];
  readonly personNotice: "needs-sign-in" | "waiting" | null;
  readonly terminalOnThisComputer: boolean;
  readonly otherNames: readonly string[];
}): ProviderProfile {
  return pinProfile({ ...input, enabled: true });
}

function answerOf(
  profiles: readonly ProviderProfile[],
  removed: ProfileListAnswer["removedProfiles"],
): ProfileListAnswer {
  return {
    providers: [
      providerState({
        providerId: "codex",
        authStatus: "authenticated",
        profiles,
      }),
    ],
    native: null,
    removedProfiles: [...removed],
  };
}

function mount(input: {
  readonly profiles: readonly ProviderProfile[];
  readonly activeProfileId: string | null;
  readonly removed: ProfileListAnswer["removedProfiles"];
  readonly computerLabel: string | null;
}): ProfileListHost {
  const host = createProfileListHost({
    answer: answerOf(input.profiles, input.removed),
    answerProfileName: (request) => ({ label: request.label }),
    failSetEnabled: false,
  });
  holder.client = host.client;
  holder.computerLabel = input.computerLabel;
  render(
    <host.Wrapper>
      <PickerProfileDropdown
        providerId="codex"
        providerLabel="Codex"
        profiles={input.profiles}
        activeProfileId={input.activeProfileId}
        onSelectProfile={() => undefined}
        onCreateProfile={() => undefined}
        createProfileDisabled={false}
        createProfileDisabledReason={undefined}
        shortcutHintForIndex={() => null}
        profileEnablementPending={() => false}
        contentContainer={null}
        inputRef={INPUT_REF}
        runTargetHostId={host.hostId}
        admissionByProfileId={null}
      />
    </host.Wrapper>,
  );
  return host;
}

function triggerName(): string | null {
  return screen
    .getByRole("button", { name: /^Codex profile: / })
    .getAttribute("aria-label");
}

function checkedName(): string | null {
  return (
    screen
      .queryByRole("menuitem", { current: true })
      ?.getAttribute("aria-label") ?? null
  );
}

const side = row({
  profileId: "side-row",
  label: "Side",
  kind: "managed",
  authStatus: "authenticated",
  aliases: [],
  personNotice: null,
  terminalOnThisComputer: false,
  otherNames: [],
});

const work = row({
  profileId: "work-row",
  label: "Work",
  kind: "managed",
  authStatus: "authenticated",
  aliases: [ALIAS_ID],
  personNotice: null,
  terminalOnThisComputer: false,
  otherNames: [],
});

describe("PickerProfileDropdown pin", () => {
  afterEach(() => {
    holder.client = null;
    holder.computerLabel = null;
    cleanup();
  });

  it("an alias pin checks the canonical row and never the first row", () => {
    mount({
      profiles: [side, work],
      activeProfileId: ALIAS_ID,
      removed: [],
      computerLabel: null,
    });

    expect(triggerName()).toBe("Codex profile: Work");
    expect(checkedName()).toContain("Work");
    expect(checkedName()).not.toContain("Side");
  });

  it("a removed profile id reads Was removed once the list arrives", async () => {
    const host = mount({
      profiles: [side, work],
      activeProfileId: "gone-row",
      removed: [
        removedEntry({
          providerId: "codex",
          profileId: "gone-row",
          aliases: [],
        }),
      ],
      computerLabel: null,
    });

    await waitFor(() => {
      expect(triggerName()).toBe("Codex profile: Was removed");
    });
    expect(host.listCalls.length).toBeGreaterThan(0);
    expect(host.answer.removedProfiles).toEqual([
      removedEntry({
        providerId: "codex",
        profileId: "gone-row",
        aliases: [],
      }),
    ]);
    const trigger = screen.getByRole("button", {
      name: "Codex profile: Was removed",
    });
    expect(trigger.textContent).toContain("Was removed");
    expect(trigger.querySelector("[style*='--swatch']")).toBeNull();
    expect(trigger.textContent).not.toContain("Terminal");
    expect(checkedName()).toBeNull();
  });

  it("a removed entry alias reads Was removed once the list arrives", async () => {
    mount({
      profiles: [side, work],
      activeProfileId: "gone-alias",
      removed: [
        removedEntry({
          providerId: "codex",
          profileId: "other-gone",
          aliases: ["gone-alias"],
        }),
      ],
      computerLabel: null,
    });

    await waitFor(() => {
      expect(triggerName()).toBe("Codex profile: Was removed");
    });
    expect(checkedName()).toBeNull();
  });

  it("two rows listing one id show the first row and check none", async () => {
    const desk = row({
      profileId: "desk-row",
      label: "Desk",
      kind: "managed",
      authStatus: "authenticated",
      aliases: [],
      personNotice: null,
      terminalOnThisComputer: false,
      otherNames: [],
    });
    const shared = row({
      profileId: "shared-id",
      label: "Side",
      kind: "managed",
      authStatus: "authenticated",
      aliases: [],
      personNotice: null,
      terminalOnThisComputer: false,
      otherNames: [],
    });
    const also = row({
      profileId: "work-row",
      label: "Work",
      kind: "managed",
      authStatus: "authenticated",
      aliases: ["shared-id"],
      personNotice: null,
      terminalOnThisComputer: false,
      otherNames: [],
    });
    const host = mount({
      profiles: [desk, shared, also],
      activeProfileId: "shared-id",
      removed: [],
      computerLabel: null,
    });

    await waitFor(() => {
      expect(host.listCalls.length).toBeGreaterThan(0);
    });
    expect(triggerName()).toBe("Codex profile: Desk");
    expect(checkedName()).toBeNull();
  });

  it("two aliases of one id show the first row and check none", async () => {
    const desk = row({
      profileId: "desk-row",
      label: "Desk",
      kind: "managed",
      authStatus: "authenticated",
      aliases: [],
      personNotice: null,
      terminalOnThisComputer: false,
      otherNames: [],
    });
    const left = row({
      profileId: "side-row",
      label: "Side",
      kind: "managed",
      authStatus: "authenticated",
      aliases: ["shared-id"],
      personNotice: null,
      terminalOnThisComputer: false,
      otherNames: [],
    });
    const right = row({
      profileId: "work-row",
      label: "Work",
      kind: "managed",
      authStatus: "authenticated",
      aliases: ["shared-id"],
      personNotice: null,
      terminalOnThisComputer: false,
      otherNames: [],
    });
    const host = mount({
      profiles: [desk, left, right],
      activeProfileId: "shared-id",
      removed: [],
      computerLabel: null,
    });

    await waitFor(() => {
      expect(host.listCalls.length).toBeGreaterThan(0);
    });
    expect(triggerName()).toBe("Codex profile: Desk");
    expect(checkedName()).toBeNull();
  });

  it("an id a row lists stays that row when a removed entry also lists it", async () => {
    const desk = row({
      profileId: "desk-row",
      label: "Desk",
      kind: "managed",
      authStatus: "authenticated",
      aliases: [],
      personNotice: null,
      terminalOnThisComputer: false,
      otherNames: [],
    });
    const kept = row({
      profileId: "work-row",
      label: "Work",
      kind: "managed",
      authStatus: "authenticated",
      aliases: ["kept-id"],
      personNotice: null,
      terminalOnThisComputer: false,
      otherNames: [],
    });
    const host = mount({
      profiles: [desk, kept],
      activeProfileId: "kept-id",
      removed: [
        removedEntry({
          providerId: "codex",
          profileId: "other-gone",
          aliases: ["kept-id"],
        }),
      ],
      computerLabel: null,
    });

    await waitFor(() => {
      expect(host.listCalls.length).toBeGreaterThan(0);
    });
    expect(triggerName()).toBe("Codex profile: Work");
    expect(checkedName()).toContain("Work");
    expect(screen.queryByText("Was removed")).toBeNull();
  });

  it("needs a sign-in replaces the signed-out suffix", () => {
    const noticed = row({
      profileId: "work-row",
      label: "Work",
      kind: "managed",
      authStatus: "unauthenticated",
      aliases: [],
      personNotice: "needs-sign-in",
      terminalOnThisComputer: false,
      otherNames: [],
    });
    mount({
      profiles: [side, noticed],
      activeProfileId: "work-row",
      removed: [],
      computerLabel: null,
    });

    const name = checkedName();
    expect(name).toContain("Needs a sign-in");
    expect(name).not.toContain("Signed out");
  });

  it("waiting for Traycer replaces the status suffix", () => {
    const noticed = row({
      profileId: "work-row",
      label: "Work",
      kind: "managed",
      authStatus: "unauthenticated",
      aliases: [],
      personNotice: "waiting",
      terminalOnThisComputer: false,
      otherNames: [],
    });
    mount({
      profiles: [side, noticed],
      activeProfileId: "work-row",
      removed: [],
      computerLabel: null,
    });

    const name = checkedName();
    expect(name).toContain("Waiting for Traycer");
    expect(name).not.toContain("Signed out");
  });

  it("a null person notice keeps Signed out", () => {
    const signedOut = row({
      profileId: "work-row",
      label: "Work",
      kind: "managed",
      authStatus: "unauthenticated",
      aliases: [],
      personNotice: null,
      terminalOnThisComputer: false,
      otherNames: [],
    });
    mount({
      profiles: [side, signedOut],
      activeProfileId: "work-row",
      removed: [],
      computerLabel: null,
    });

    expect(checkedName()).toContain("Signed out");
  });

  it("a row without the person notice key keeps Signed out", () => {
    const signedOut = legacyProfile({
      profileId: "work-row",
      label: "Work",
      kind: "managed",
      enabled: true,
      authStatus: "unauthenticated",
    });
    mount({
      profiles: [side, signedOut],
      activeProfileId: "work-row",
      removed: [],
      computerLabel: null,
    });

    expect(checkedName()).toContain("Signed out");
    expect(checkedName()).not.toContain("Needs a sign-in");
    expect(checkedName()).not.toContain("Waiting for Traycer");
  });

  it("a record that is the Terminal login is the null pin and names the computer", () => {
    const terminal = row({
      profileId: "work-row",
      label: "Work",
      kind: "managed",
      authStatus: "authenticated",
      aliases: [],
      personNotice: null,
      terminalOnThisComputer: true,
      otherNames: [],
    });
    mount({
      profiles: [side, terminal],
      activeProfileId: null,
      removed: [],
      computerLabel: "North desk",
    });

    expect(triggerName()).toBe("Codex profile: Work");
    expect(checkedName()).toContain("Terminal account on North desk");
    expect(triggerName()).not.toContain("Terminal");
    expect(
      screen.getAllByRole("menuitem").map((item) => item.textContent),
    ).toEqual(expect.arrayContaining([expect.stringContaining("Side")]));
    expect(
      screen
        .getAllByRole("menuitem")
        .filter((item) => item.textContent === "Terminal"),
    ).toEqual([]);
  });

  it("a record that is the Terminal login says Terminal account when the computer has no name", () => {
    const terminal = row({
      profileId: "work-row",
      label: "Work",
      kind: "managed",
      authStatus: "authenticated",
      aliases: [],
      personNotice: null,
      terminalOnThisComputer: true,
      otherNames: [],
    });
    mount({
      profiles: [side, terminal],
      activeProfileId: null,
      removed: [],
      computerLabel: null,
    });

    expect(triggerName()).toBe("Codex profile: Work");
    expect(checkedName()).toContain("Terminal account");
    expect(checkedName()).not.toContain("Terminal account on");
  });

  it("an ambient row with the terminal flag keeps today's badge and no second line", () => {
    const ambient = row({
      profileId: "ambient-row",
      label: "Desk login",
      kind: "ambient",
      authStatus: "authenticated",
      aliases: [],
      personNotice: null,
      terminalOnThisComputer: true,
      otherNames: [],
    });
    mount({
      profiles: [ambient, side],
      activeProfileId: null,
      removed: [],
      computerLabel: "North desk",
    });

    expect(triggerName()).toBe("Codex profile: Desk login, Terminal");
    expect(checkedName()).toContain("Desk login");
    expect(checkedName()).not.toContain("Terminal account");
    expect(screen.getAllByText("Terminal")).toHaveLength(2);
    expect(screen.queryByText("Terminal account")).toBeNull();
  });

  it("one other name is a chip and part of the row name", () => {
    const named = row({
      profileId: "work-row",
      label: "Work",
      kind: "managed",
      authStatus: "authenticated",
      aliases: [],
      personNotice: null,
      terminalOnThisComputer: false,
      otherNames: ["Home"],
    });
    mount({
      profiles: [side, named],
      activeProfileId: "work-row",
      removed: [],
      computerLabel: null,
    });

    const checked = screen.getByRole("menuitem", { current: true });
    expect(checked.textContent).toContain("Home");
    expect(checked.getAttribute("aria-label")).toContain("Also named Home");
    expect(triggerName()).toBe("Codex profile: Work");
    expect(triggerName()).not.toContain("Also named");
  });

  it("two other names are two chips", () => {
    const named = row({
      profileId: "work-row",
      label: "Work",
      kind: "managed",
      authStatus: "authenticated",
      aliases: [],
      personNotice: null,
      terminalOnThisComputer: false,
      otherNames: ["Home", "Side desk"],
    });
    mount({
      profiles: [side, named],
      activeProfileId: "work-row",
      removed: [],
      computerLabel: null,
    });

    const checked = screen.getByRole("menuitem", { current: true });
    expect(checked.textContent).toContain("Home");
    expect(checked.textContent).toContain("Side desk");
    expect(checked.getAttribute("aria-label")).toContain(
      "Also named Home, Side desk",
    );
  });

  it("a row with no other names has no chip", () => {
    mount({
      profiles: [side, work],
      activeProfileId: "work-row",
      removed: [],
      computerLabel: null,
    });

    expect(checkedName()).not.toContain("Also named");
  });

  it("an unknown id shows the first row and checks none", async () => {
    const host = mount({
      profiles: [side, work],
      activeProfileId: "missing-id",
      removed: [],
      computerLabel: null,
    });

    await waitFor(() => {
      expect(host.listCalls.length).toBeGreaterThan(0);
    });
    expect(triggerName()).toBe("Codex profile: Side");
    expect(checkedName()).toBeNull();
    expect(screen.queryByText("Was removed")).toBeNull();
  });

  it("a 10.10-shaped list shows the named row and the first row for an unknown id", async () => {
    const olderSide = legacyProfile({
      profileId: "side-row",
      label: "Side",
      kind: "managed",
      enabled: true,
      authStatus: "authenticated",
    });
    const olderWork = legacyProfile({
      profileId: "work-row",
      label: "Work",
      kind: "managed",
      enabled: true,
      authStatus: "authenticated",
    });
    const known = mount({
      profiles: [olderSide, olderWork],
      activeProfileId: "work-row",
      removed: [],
      computerLabel: null,
    });
    await waitFor(() => {
      expect(known.listCalls.length).toBeGreaterThan(0);
    });
    expect(triggerName()).toBe("Codex profile: Work");
    expect(checkedName()).toContain("Work");
    cleanup();

    const unknown = mount({
      profiles: [olderSide, olderWork],
      activeProfileId: "missing-id",
      removed: [],
      computerLabel: null,
    });
    await waitFor(() => {
      expect(unknown.listCalls.length).toBeGreaterThan(0);
    });
    expect(triggerName()).toBe("Codex profile: Side");
    expect(checkedName()).toBeNull();
    expect(screen.queryByText("Was removed")).toBeNull();
    expect(screen.queryByText("Needs a sign-in")).toBeNull();
    expect(screen.queryByText("Also named")).toBeNull();
  });
});
