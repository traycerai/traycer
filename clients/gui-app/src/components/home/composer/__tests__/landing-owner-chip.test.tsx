import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
} from "@testing-library/react";
import type { EpicShareableTeam } from "@/stores/auth/auth-store";
import { useAuthStore } from "@/stores/auth/auth-store";

/**
 * The Belongs to chip: a landing draft's owner follows its resolved host's team
 * until the person picks one, the chip lists Personal and each of the person's
 * teams, and a team pick says who will read the first chat.
 */

const mocks = vi.hoisted(() => {
  // hostId -> the team that owns that host; a host absent here is no team's.
  const hostTeams: { current: Record<string, string | null> } = { current: {} };
  return { hostTeams };
});

vi.mock("@/hooks/sandboxes/use-on-team-sandbox", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/hooks/sandboxes/use-on-team-sandbox")
  >()),
  useHostOwnerTeamId: (hostId: string | null): string | null =>
    hostId === null ? null : (mocks.hostTeams.current[hostId] ?? null),
}));

import {
  LandingOwnerChip,
  LandingTeamChatLine,
} from "@/components/home/composer/landing-owner-chip";
import { useLandingOwner } from "@/hooks/home/use-landing-owner";
import { useLandingOwnerStore } from "@/stores/home/landing-owner-store";

const ACME: EpicShareableTeam = {
  teamId: "t1",
  slug: "acme",
  avatarUrl: null,
};
const BETA: EpicShareableTeam = {
  teamId: "t2",
  slug: "beta",
  avatarUrl: null,
};
const DRAFT_ID = "d1";
const HOST_ID = "host-1";

function setTeams(teams: ReadonlyArray<EpicShareableTeam>): void {
  useAuthStore.setState({
    status: "signed-in",
    contextMetadata: { userId: "user-viewer", username: "viewer" },
    shareableTeams: teams,
  });
}

function trigger(): HTMLElement {
  return screen.getByTestId("landing-owner-chip");
}

function triggerText(): string {
  return trigger().textContent;
}

function openMenu(): void {
  // Radix's DropdownMenuTrigger opens on pointerdown, not the click event.
  fireEvent.pointerDown(trigger(), { button: 0 });
}

function renderChip(draftId: string | null, hostId: string | null): void {
  render(<LandingOwnerChip draftId={draftId} resolvedHostId={hostId} />);
}

beforeEach(() => {
  mocks.hostTeams.current = {};
  useLandingOwnerStore.setState({ byDraftId: {} });
  setTeams([ACME, BETA]);
});

afterEach(() => {
  cleanup();
  useLandingOwnerStore.setState({ byDraftId: {} });
  useAuthStore.setState({
    status: "signed-out",
    contextMetadata: null,
    shareableTeams: [],
  });
});

describe("<LandingOwnerChip />", () => {
  it("renders nothing for a person in no team", () => {
    setTeams([]);

    renderChip(DRAFT_ID, HOST_ID);

    expect(screen.queryByTestId("landing-owner-chip")).toBeNull();
  });

  it("is labelled Belongs to", () => {
    renderChip(DRAFT_ID, HOST_ID);

    expect(trigger().getAttribute("aria-label")).toBe("Belongs to");
  });

  it("reads Personal when the host belongs to no team", () => {
    renderChip(DRAFT_ID, HOST_ID);

    expect(triggerText()).toBe("Personal");
  });

  it("follows the host's team by default", () => {
    mocks.hostTeams.current = { [HOST_ID]: "t1" };

    renderChip(DRAFT_ID, HOST_ID);

    expect(triggerText()).toBe("acme");
  });

  it("reads Personal for a host owned by a team the person is not in", () => {
    mocks.hostTeams.current = { [HOST_ID]: "t-other" };

    renderChip(DRAFT_ID, HOST_ID);

    expect(triggerText()).toBe("Personal");
  });

  it("lists Personal and each of the person's teams by slug", () => {
    renderChip(DRAFT_ID, HOST_ID);
    openMenu();

    expect(
      screen.getByTestId("landing-owner-option-personal").textContent,
    ).toContain("Personal");
    expect(screen.getByTestId("landing-owner-option-t1").textContent).toContain(
      "acme",
    );
    expect(screen.getByTestId("landing-owner-option-t2").textContent).toContain(
      "beta",
    );
  });

  it("stores a team pick for the draft and reads it back", () => {
    renderChip(DRAFT_ID, HOST_ID);
    openMenu();

    fireEvent.click(screen.getByTestId("landing-owner-option-t2"));

    expect(useLandingOwnerStore.getState().byDraftId[DRAFT_ID]).toEqual({
      kind: "team",
      teamId: "t2",
    });
    expect(triggerText()).toBe("beta");
  });

  it("stores Personal on a team host and reads Personal", () => {
    mocks.hostTeams.current = { [HOST_ID]: "t1" };
    renderChip(DRAFT_ID, HOST_ID);
    expect(triggerText()).toBe("acme");
    openMenu();

    fireEvent.click(screen.getByTestId("landing-owner-option-personal"));

    expect(useLandingOwnerStore.getState().byDraftId[DRAFT_ID]).toEqual({
      kind: "personal",
    });
    expect(triggerText()).toBe("Personal");
  });

  it("keys a draft with no id as the empty string", () => {
    renderChip(null, HOST_ID);
    openMenu();

    fireEvent.click(screen.getByTestId("landing-owner-option-t1"));

    expect(useLandingOwnerStore.getState().byDraftId[""]).toEqual({
      kind: "team",
      teamId: "t1",
    });
    expect(triggerText()).toBe("acme");
  });

  it("keeps one draft's pick off another draft", () => {
    useLandingOwnerStore.setState({
      byDraftId: { "d-other": { kind: "team", teamId: "t2" } },
    });

    renderChip(DRAFT_ID, HOST_ID);

    expect(triggerText()).toBe("Personal");
  });
});

describe("<LandingTeamChatLine />", () => {
  it("says who will read the first chat when the owner is a team", () => {
    mocks.hostTeams.current = { [HOST_ID]: "t1" };

    render(<LandingTeamChatLine draftId={DRAFT_ID} resolvedHostId={HOST_ID} />);

    expect(screen.getByTestId("landing-team-first-chat-line").textContent).toBe(
      "Chats here are visible to everyone in acme",
    );
  });

  it("follows an explicit team pick over the host", () => {
    useLandingOwnerStore.setState({
      byDraftId: { [DRAFT_ID]: { kind: "team", teamId: "t2" } },
    });

    render(<LandingTeamChatLine draftId={DRAFT_ID} resolvedHostId={HOST_ID} />);

    expect(screen.getByTestId("landing-team-first-chat-line").textContent).toBe(
      "Chats here are visible to everyone in beta",
    );
  });

  it("is absent when the owner is Personal", () => {
    render(<LandingTeamChatLine draftId={DRAFT_ID} resolvedHostId={HOST_ID} />);

    expect(screen.queryByTestId("landing-team-first-chat-line")).toBeNull();
  });

  it("is absent when Personal is picked on a team host", () => {
    mocks.hostTeams.current = { [HOST_ID]: "t1" };
    useLandingOwnerStore.setState({
      byDraftId: { [DRAFT_ID]: { kind: "personal" } },
    });

    render(<LandingTeamChatLine draftId={DRAFT_ID} resolvedHostId={HOST_ID} />);

    expect(screen.queryByTestId("landing-team-first-chat-line")).toBeNull();
  });
});

describe("useLandingOwner", () => {
  it("follows the resolved host's team when nothing is picked", () => {
    mocks.hostTeams.current = { [HOST_ID]: "t1" };

    const { result } = renderHook(() => useLandingOwner(DRAFT_ID, HOST_ID));

    expect(result.current).toEqual({ teamId: "t1", slug: "acme" });
  });

  it("is Personal when the host is no team's and nothing is picked", () => {
    const { result } = renderHook(() => useLandingOwner(DRAFT_ID, HOST_ID));

    expect(result.current).toBeNull();
  });

  it("lets an explicit pick win over the host's team", () => {
    mocks.hostTeams.current = { [HOST_ID]: "t1" };
    useLandingOwnerStore.setState({
      byDraftId: { [DRAFT_ID]: { kind: "team", teamId: "t2" } },
    });

    const { result } = renderHook(() => useLandingOwner(DRAFT_ID, HOST_ID));

    expect(result.current).toEqual({ teamId: "t2", slug: "beta" });
  });

  it("lets an explicit Personal pick win over the host's team", () => {
    mocks.hostTeams.current = { [HOST_ID]: "t1" };
    useLandingOwnerStore.setState({
      byDraftId: { [DRAFT_ID]: { kind: "personal" } },
    });

    const { result } = renderHook(() => useLandingOwner(DRAFT_ID, HOST_ID));

    expect(result.current).toBeNull();
  });

  it("reads a null draft id under the empty-string key", () => {
    useLandingOwnerStore.setState({
      byDraftId: { "": { kind: "team", teamId: "t2" } },
    });

    const { result } = renderHook(() => useLandingOwner(null, HOST_ID));

    expect(result.current).toEqual({ teamId: "t2", slug: "beta" });
  });

  it("does not read another draft's pick for a null draft id", () => {
    useLandingOwnerStore.setState({
      byDraftId: { [DRAFT_ID]: { kind: "team", teamId: "t2" } },
    });

    const { result } = renderHook(() => useLandingOwner(null, HOST_ID));

    expect(result.current).toBeNull();
  });
});
