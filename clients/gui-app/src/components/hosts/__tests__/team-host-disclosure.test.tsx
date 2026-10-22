import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type {
  HostListItem,
  HostOwnerPrincipal,
} from "@traycer/protocol/host/host-status";
import {
  hostListItemToDirectoryEntry,
  type RemoteHostDirectoryEntry,
} from "@traycer-clients/shared/host-client/remote-fetcher";
import type {
  EpicCollaboratorsView,
  EpicCollaboratorView,
  EpicTeamCollaboratorView,
} from "@/hooks/epics/use-epic-collaborators-query";
import {
  createFakeSandboxBinding,
  type FakeSandboxBinding,
} from "@/hooks/sandboxes/__tests__/sandbox-binding-fixture";

/**
 * A team host's first tab says what a shared host means, once per person per
 * host. Everything the card reads (who is viewing, whether the account may
 * spend its cloud capability, the open task and its collaborators) is mocked
 * at the hook boundary.
 */

const mocks = vi.hoisted(() => {
  const viewer: { current: string } = { current: "" };
  const cloudAuthorized: { current: boolean } = { current: true };
  const openEpicId: { current: string | null } = { current: null };
  const collaborators: { current: EpicCollaboratorsView | undefined } = {
    current: undefined,
  };
  // What the collaborators query reports while it is ENABLED: an answered
  // query (the default) has neither flag; a pending or errored one has data
  // undefined. A disabled query is always pending with no data, as in
  // react-query.
  const queryState: { current: { isPending: boolean; isError: boolean } } = {
    current: { isPending: false, isError: false },
  };
  const binding: { current: FakeSandboxBinding | null } = { current: null };
  const entry: { current: RemoteHostDirectoryEntry | null } = {
    current: null,
  };
  return {
    viewer,
    cloudAuthorized,
    openEpicId,
    collaborators,
    queryState,
    binding,
    entry,
  };
});

vi.mock("@/hooks/chats/use-cloud-chat-queries", () => ({
  useCloudChatViewerId: () => mocks.viewer.current,
  useCloudChatHasCloudAuthorization: () => mocks.cloudAuthorized.current,
}));
// The tile's epic, if it is in one: the frame also wraps tiles outside an
// epic session, so the disclosure reads the session without requiring one.
vi.mock("@/providers/use-open-epic-handle", () => ({
  useMaybeOpenEpicHandle: () =>
    mocks.openEpicId.current === null
      ? null
      : { epicId: mocks.openEpicId.current },
}));
vi.mock("@/hooks/epic/use-epic-session-host-client", () => ({
  useEpicSessionHostClient: () => null,
}));
vi.mock(
  "@/hooks/epics/use-epic-collaborators-query",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/hooks/epics/use-epic-collaborators-query")
    >()),
    // The real hook withholds its data while it may not spend the cloud
    // capability, and has nothing to ask without a task: the mock does the
    // same, and reports such a query as pending (a disabled react-query query
    // is pending, with no data).
    useEpicCollaboratorsQuery: (
      epicId: string,
      options: { readonly enabled: boolean },
    ) => {
      const enabled = options.enabled && epicId.length > 0;
      const isPending = enabled ? mocks.queryState.current.isPending : true;
      const isError = enabled ? mocks.queryState.current.isError : false;
      return {
        data: enabled ? mocks.collaborators.current : undefined,
        query: null,
        isPending,
        isLoading: enabled && isPending,
        isFetching: enabled && isPending,
        isError,
        error: null,
      };
    },
  }),
);
vi.mock("@/components/epic-canvas/hooks/use-tab-host-id", () => ({
  useTabHostId: () => "host-sbx-1",
}));
vi.mock("@/hooks/host/use-host-directory-entry", () => ({
  useHostDirectoryEntry: () => mocks.entry.current,
}));
vi.mock("@/lib/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host")>()),
  useHostBinding: () => mocks.binding.current,
}));
vi.mock("@/hooks/sandboxes/use-sandbox-list-query", () => ({
  useSandboxList: () => ({
    data: null,
    isError: false,
    isFetching: false,
    refetch: vi.fn(),
  }),
}));
vi.mock("@/providers/use-runner-host", () => ({
  useRunnerHost: () => ({ refreshHostFleet: vi.fn() }),
  useRunnerHostOrNull: () => ({ sandboxControlUnavailableReason: null }),
}));
vi.mock("@/lib/host/fleet-refresh", () => ({ requestFleetRefresh: vi.fn() }));
vi.mock("@/lib/auth-error-toast", () => ({ toastFromAuthError: vi.fn() }));

import {
  taskHasReadersOutsideTeam,
  teamHostDisclosureSentences,
  teamHostOutsideReadersLine,
} from "@/components/hosts/team-host-disclosure-model";
import { TeamHostDisclosure } from "@/components/hosts/team-host-disclosure";
import { SandboxTileStateFrame } from "@/components/hosts/sandbox-tile-state-frame";
import {
  TEAM_HOST_DISCLOSURE_SEEN_CAP,
  teamHostDisclosureSeen,
  useTeamHostDisclosureSeenStore,
} from "@/stores/hosts/team-host-disclosure-seen-store";

const PERSIST_KEY = "traycer-gui-app:team-host-disclosure-seen";
const VIEWER = "user-viewer";
const HOST_ID = "host-sbx-1";
const TEAM_ID = "team-a";
const TEAM_NAME = "Alpha";

describe("teamHostDisclosureSentences", () => {
  it("names the team in the first and third sentences, word for word", () => {
    expect(teamHostDisclosureSentences("Alpha")).toEqual([
      "Agents here run as the host. Anything another member's agent does on it can read what yours can, browser sign-ins included. Agents here work with Alpha's hosts only. A browser-using agent here runs its browser in the sandbox, never on your computer.",
      "Another member's agent here can act and be charged as you while you are attached.",
      "A copy of your sign-in to this host, taken by anyone who was root here, keeps working against Alpha's hosts until this host sleeps.",
    ]);
  });

  it("carries the team name it is given, not a fixed one", () => {
    const [first, , third] = teamHostDisclosureSentences("Platform Crew");
    expect(first).toContain("Platform Crew's hosts only");
    expect(third).toContain("against Platform Crew's hosts until");
  });

  it("names the outside readers line", () => {
    expect(teamHostOutsideReadersLine("Alpha")).toBe(
      "People outside Alpha can read chats in this task.",
    );
  });
});

function person(
  userId: string | null,
  source: "direct-user" | "team",
): EpicCollaboratorView {
  return {
    key: `k-${userId ?? "none"}`,
    userId,
    displayName: userId ?? "Unknown",
    email: "",
    handle: "",
    avatarUrl: null,
    role: "editor",
    accessSource: source,
    teamId: source === "team" ? TEAM_ID : null,
    teamName: source === "team" ? TEAM_NAME : null,
  };
}

function team(
  teamId: string,
  memberIds: readonly string[],
): EpicTeamCollaboratorView {
  return {
    key: `team-${teamId}`,
    teamId,
    teamName: teamId,
    role: "editor",
    members: memberIds.map((id) => person(id, "team")),
  };
}

function view(input: {
  readonly direct: readonly string[];
  readonly ownerTeam: EpicTeamCollaboratorView | null;
  readonly teams: readonly EpicTeamCollaboratorView[];
}): EpicCollaboratorsView {
  const directUsers = input.direct.map((id) => person(id, "direct-user"));
  const owner = input.ownerTeam === null ? [] : [input.ownerTeam];
  return {
    directUsers,
    teams: input.teams,
    ownerTeam: input.ownerTeam,
    flatRows: [
      ...directUsers,
      ...[...owner, ...input.teams].flatMap((t) => t.members),
    ],
  };
}

function outside(collaborators: EpicCollaboratorsView | null): boolean {
  return taskHasReadersOutsideTeam({
    viewerUserId: VIEWER,
    teamId: TEAM_ID,
    collaborators,
  });
}

describe("taskHasReadersOutsideTeam", () => {
  it("is false when the collaborators are not loaded", () => {
    expect(outside(null)).toBe(false);
  });

  it("is false when every direct user is a member of the owning team", () => {
    expect(
      outside(
        view({
          ownerTeam: null,
          direct: [VIEWER, "user-ada", "user-bea"],
          teams: [team(TEAM_ID, [VIEWER, "user-ada", "user-bea"])],
        }),
      ),
    ).toBe(false);
  });

  it("is true when a direct user is not a member of the owning team", () => {
    expect(
      outside(
        view({
          ownerTeam: null,
          direct: ["user-ada", "user-stranger"],
          teams: [team(TEAM_ID, [VIEWER, "user-ada"])],
        }),
      ),
    ).toBe(true);
  });

  it("is true when the owning team's members are unknown and a direct user other than the viewer holds access", () => {
    expect(
      outside(
        view({ ownerTeam: null, direct: [VIEWER, "user-ada"], teams: [] }),
      ),
    ).toBe(true);
  });

  it("is false when the owning team's members are unknown and only the viewer holds direct access", () => {
    expect(
      outside(view({ ownerTeam: null, direct: [VIEWER], teams: [] })),
    ).toBe(false);
    expect(outside(view({ ownerTeam: null, direct: [], teams: [] }))).toBe(
      false,
    );
  });

  it("is true when another team holds access to the task", () => {
    expect(
      outside(
        view({
          ownerTeam: null,
          direct: [],
          teams: [team(TEAM_ID, [VIEWER]), team("team-other", ["user-zed"])],
        }),
      ),
    ).toBe(true);
  });

  it("is true when another team owns the task", () => {
    expect(
      outside(
        view({
          ownerTeam: team("team-other", ["user-zed"]),
          direct: [],
          teams: [team(TEAM_ID, [VIEWER])],
        }),
      ),
    ).toBe(true);
  });

  it("reads the owning team's members when it is the task's Owner team", () => {
    expect(
      outside(
        view({
          ownerTeam: team(TEAM_ID, [VIEWER, "user-ada"]),
          direct: ["user-ada"],
          teams: [],
        }),
      ),
    ).toBe(false);
  });

  it("is false when only the owning team holds access", () => {
    expect(
      outside(
        view({ ownerTeam: null, direct: [], teams: [team(TEAM_ID, [VIEWER])] }),
      ),
    ).toBe(false);
  });
});

function resetSeenStore(): void {
  window.localStorage.clear();
  useTeamHostDisclosureSeenStore.setState({ seen: {} });
}

describe("useTeamHostDisclosureSeenStore", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    resetSeenStore();
  });
  afterEach(() => {
    vi.useRealTimers();
    resetSeenStore();
  });

  it("answers false until a (viewer, host) pair is marked, and is per pair", () => {
    const { seen } = useTeamHostDisclosureSeenStore.getState();
    expect(teamHostDisclosureSeen(seen, VIEWER, "host-1")).toBe(false);

    useTeamHostDisclosureSeenStore.getState().markSeen(VIEWER, "host-1");

    const after = useTeamHostDisclosureSeenStore.getState().seen;
    expect(teamHostDisclosureSeen(after, VIEWER, "host-1")).toBe(true);
    expect(teamHostDisclosureSeen(after, VIEWER, "host-2")).toBe(false);
    expect(teamHostDisclosureSeen(after, "user-other", "host-1")).toBe(false);
  });

  it("persists under its own key at version 1", () => {
    useTeamHostDisclosureSeenStore.getState().markSeen(VIEWER, "host-1");

    const raw = window.localStorage.getItem(PERSIST_KEY);
    if (raw === null) throw new Error("Expected a persisted blob");
    expect(persistedBlob(raw).version).toBe(1);
  });

  it("caps the record at 500 pairs and evicts the oldest", () => {
    expect(TEAM_HOST_DISCLOSURE_SEEN_CAP).toBe(500);
    const store = useTeamHostDisclosureSeenStore.getState();
    for (let i = 0; i <= TEAM_HOST_DISCLOSURE_SEEN_CAP; i += 1) {
      vi.setSystemTime(1_000 + i);
      store.markSeen(VIEWER, `host-${i}`);
    }

    const seen = useTeamHostDisclosureSeenStore.getState().seen;
    expect(Object.keys(seen)).toHaveLength(TEAM_HOST_DISCLOSURE_SEEN_CAP);
    expect(teamHostDisclosureSeen(seen, VIEWER, "host-0")).toBe(false);
    expect(teamHostDisclosureSeen(seen, VIEWER, "host-1")).toBe(true);
    expect(
      teamHostDisclosureSeen(
        seen,
        VIEWER,
        `host-${TEAM_HOST_DISCLOSURE_SEEN_CAP}`,
      ),
    ).toBe(true);
  });

  it("rehydrates before it writes, so another window's pair survives this window's mark", () => {
    // Capture how another window's pair would be stored, without knowing the
    // key spelling: mark it here, read the blob, then forget it in memory.
    useTeamHostDisclosureSeenStore.getState().markSeen("user-other", "host-b");
    const foreign = window.localStorage.getItem(PERSIST_KEY);
    if (foreign === null) throw new Error("Expected a persisted blob");
    const foreignSeen = persistedBlob(foreign).seen;
    resetSeenStore();

    // The other window wrote its pair; this window's memory has not seen it.
    window.localStorage.setItem(
      PERSIST_KEY,
      JSON.stringify({ state: { seen: foreignSeen }, version: 1 }),
    );
    expect(
      teamHostDisclosureSeen(
        useTeamHostDisclosureSeenStore.getState().seen,
        "user-other",
        "host-b",
      ),
    ).toBe(false);

    useTeamHostDisclosureSeenStore.getState().markSeen(VIEWER, "host-a");

    const seen = useTeamHostDisclosureSeenStore.getState().seen;
    expect(teamHostDisclosureSeen(seen, VIEWER, "host-a")).toBe(true);
    expect(teamHostDisclosureSeen(seen, "user-other", "host-b")).toBe(true);
    const stored = window.localStorage.getItem(PERSIST_KEY);
    if (stored === null) throw new Error("Expected a persisted blob");
    expect(Object.keys(persistedBlob(stored).seen)).toHaveLength(2);
  });
});

/** The persisted blob's version and seen record, narrowed from the raw JSON. */
function persistedBlob(raw: string): {
  readonly version: unknown;
  readonly seen: object;
} {
  const parsed: unknown = JSON.parse(raw);
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("version" in parsed) ||
    !("state" in parsed)
  ) {
    throw new Error("Expected a persisted blob with a version and a state");
  }
  const state = parsed.state;
  if (typeof state !== "object" || state === null || !("seen" in state)) {
    throw new Error("Expected a persisted state with a seen record");
  }
  const seen = state.seen;
  if (typeof seen !== "object" || seen === null) {
    throw new Error("Expected the seen record to be an object");
  }
  return { version: parsed.version, seen };
}

function renderDisclosure(hostId: string): void {
  render(
    <TeamHostDisclosure
      hostId={hostId}
      teamId={TEAM_ID}
      teamName={TEAM_NAME}
    />,
  );
}

describe("<TeamHostDisclosure />", () => {
  beforeEach(() => {
    resetSeenStore();
    mocks.viewer.current = VIEWER;
    mocks.cloudAuthorized.current = true;
    mocks.openEpicId.current = "epic-1";
    mocks.collaborators.current = undefined;
    mocks.queryState.current = { isPending: false, isError: false };
  });
  afterEach(() => {
    cleanup();
    resetSeenStore();
  });

  it("shows the three sentences verbatim as a status", () => {
    renderDisclosure("host-1");

    const card = screen.getByTestId("team-host-disclosure");
    expect(card.getAttribute("role")).toBe("status");
    for (const sentence of teamHostDisclosureSentences(TEAM_NAME)) {
      expect(card.textContent).toContain(sentence);
    }
  });

  it("omits the outside-readers line when no one outside the team reads the task", () => {
    mocks.collaborators.current = view({
      ownerTeam: null,
      direct: [VIEWER],
      teams: [team(TEAM_ID, [VIEWER])],
    });
    renderDisclosure("host-1");

    expect(screen.queryByTestId("team-host-disclosure-outside")).toBeNull();
  });

  it("shows the outside-readers line when someone outside the team can read the task", () => {
    mocks.collaborators.current = view({
      ownerTeam: null,
      direct: [VIEWER, "user-stranger"],
      teams: [team(TEAM_ID, [VIEWER])],
    });
    renderDisclosure("host-1");

    expect(screen.getByTestId("team-host-disclosure-outside").textContent).toBe(
      teamHostOutsideReadersLine(TEAM_NAME),
    );
  });

  it("treats collaborators as null without an open task", () => {
    mocks.openEpicId.current = null;
    mocks.collaborators.current = view({
      ownerTeam: null,
      direct: ["user-stranger"],
      teams: [],
    });
    renderDisclosure("host-1");

    expect(screen.getByTestId("team-host-disclosure")).toBeTruthy();
    expect(screen.queryByTestId("team-host-disclosure-outside")).toBeNull();
  });

  it("withholds the collaborators without cloud authorization, and says readers may be outside the team", () => {
    // An unknown reader list is not "nobody outside". With an open task and
    // no authorization to ask, the card names the outside readers rather than
    // claiming there are none.
    mocks.cloudAuthorized.current = false;
    mocks.collaborators.current = view({
      ownerTeam: null,
      direct: ["user-stranger"],
      teams: [],
    });
    renderDisclosure("host-1");

    expect(screen.getByTestId("team-host-disclosure")).toBeTruthy();
    expect(screen.getByTestId("team-host-disclosure-outside").textContent).toBe(
      teamHostOutsideReadersLine(TEAM_NAME),
    );
  });

  it("dismisses on Got it: marks the pair seen and renders nothing", () => {
    renderDisclosure("host-1");
    const dismiss = screen.getByTestId("team-host-disclosure-dismiss");
    expect(dismiss.textContent).toBe("Got it");

    fireEvent.click(dismiss);

    expect(screen.queryByTestId("team-host-disclosure")).toBeNull();
    expect(
      teamHostDisclosureSeen(
        useTeamHostDisclosureSeenStore.getState().seen,
        VIEWER,
        "host-1",
      ),
    ).toBe(true);
  });

  it("renders nothing when the person has already seen it for this host", () => {
    useTeamHostDisclosureSeenStore.getState().markSeen(VIEWER, "host-1");

    renderDisclosure("host-1");

    expect(screen.queryByTestId("team-host-disclosure")).toBeNull();
  });

  it("is per host: another host of the same team still shows it", () => {
    useTeamHostDisclosureSeenStore.getState().markSeen(VIEWER, "host-1");

    renderDisclosure("host-2");

    expect(screen.getByTestId("team-host-disclosure")).toBeTruthy();
  });

  it("is per person: a pair seen by someone else does not hide it", () => {
    useTeamHostDisclosureSeenStore.getState().markSeen("user-other", "host-1");

    renderDisclosure("host-1");

    expect(screen.getByTestId("team-host-disclosure")).toBeTruthy();
  });

  it("renders nothing without a resolved viewer", () => {
    mocks.viewer.current = "";

    renderDisclosure("host-1");

    expect(screen.queryByTestId("team-host-disclosure")).toBeNull();
  });
});

/**
 * The disclosure never claims "nobody outside" from a reader list it does not
 * have: while the collaborators query is pending the card waits; when it
 * errored, or cannot be asked (no cloud authorization), the card shows with
 * the outside-readers line; with no open task there are no readers to name.
 */
describe("<TeamHostDisclosure /> unknown readers", () => {
  beforeEach(() => {
    resetSeenStore();
    mocks.viewer.current = VIEWER;
    mocks.cloudAuthorized.current = true;
    mocks.openEpicId.current = "epic-1";
    mocks.collaborators.current = undefined;
    mocks.queryState.current = { isPending: false, isError: false };
  });
  afterEach(() => {
    cleanup();
    resetSeenStore();
  });

  it("does not render while the collaborators query is pending", () => {
    mocks.queryState.current = { isPending: true, isError: false };

    renderDisclosure("host-1");

    expect(screen.queryByTestId("team-host-disclosure")).toBeNull();
  });

  it("renders with the outside-readers line when the collaborators query errored", () => {
    mocks.queryState.current = { isPending: false, isError: true };

    renderDisclosure("host-1");

    expect(screen.getByTestId("team-host-disclosure")).toBeTruthy();
    expect(screen.getByTestId("team-host-disclosure-outside").textContent).toBe(
      teamHostOutsideReadersLine(TEAM_NAME),
    );
  });

  it("renders with the outside-readers line when the query is disabled for want of cloud authorization", () => {
    mocks.cloudAuthorized.current = false;

    renderDisclosure("host-1");

    expect(screen.getByTestId("team-host-disclosure")).toBeTruthy();
    expect(screen.getByTestId("team-host-disclosure-outside").textContent).toBe(
      teamHostOutsideReadersLine(TEAM_NAME),
    );
  });

  it("renders without the outside-readers line when no task is open", () => {
    mocks.openEpicId.current = null;

    renderDisclosure("host-1");

    expect(screen.getByTestId("team-host-disclosure")).toBeTruthy();
    expect(screen.queryByTestId("team-host-disclosure-outside")).toBeNull();
  });

  it("renders without the outside-readers line once the query answered with no one outside", () => {
    mocks.collaborators.current = view({
      ownerTeam: null,
      direct: [VIEWER],
      teams: [team(TEAM_ID, [VIEWER])],
    });

    renderDisclosure("host-1");

    expect(screen.getByTestId("team-host-disclosure")).toBeTruthy();
    expect(screen.queryByTestId("team-host-disclosure-outside")).toBeNull();
  });
});

const TEAM_OWNER: HostOwnerPrincipal = {
  kind: "team",
  id: TEAM_ID,
  name: TEAM_NAME,
};

function registryItem(input: {
  readonly kind: "personal" | "sandbox";
  readonly owner: HostOwnerPrincipal | undefined;
}): HostListItem {
  return {
    hostId: HOST_ID,
    displayName: "build-box",
    platform: "linux",
    kind: input.kind,
    publicKey: "pk-1",
    createdAt: "2026-10-01T00:00:00.000Z",
    status: {
      connectivity: "connectable",
      viewerReachability: "unknown",
      clientCloud: "ok",
      updateState: "current",
      appVersion: "1.5.0",
      lastSeenAt: "2026-10-09T00:00:00.000Z",
    },
    updatePolicy: "manual",
    ...(input.kind === "sandbox"
      ? {
          sandboxState: "awake" as const,
          sandboxFrozen: false,
          profile: "agent" as const,
        }
      : {}),
    ...(input.owner === undefined ? {} : { owner: input.owner }),
  };
}

function renderFrame(): void {
  render(
    <SandboxTileStateFrame chat={null}>
      <textarea data-testid="tile-body" />
    </SandboxTileStateFrame>,
  );
}

describe("<SandboxTileStateFrame /> team host disclosure", () => {
  beforeEach(() => {
    resetSeenStore();
    mocks.viewer.current = VIEWER;
    mocks.cloudAuthorized.current = true;
    mocks.openEpicId.current = "epic-1";
    mocks.collaborators.current = undefined;
    mocks.queryState.current = { isPending: false, isError: false };
    mocks.binding.current = createFakeSandboxBinding();
  });
  afterEach(() => {
    cleanup();
    resetSeenStore();
    mocks.binding.current = null;
    mocks.entry.current = null;
  });

  it("carries the owning team's id on the directory's sandbox facts", () => {
    const entry = hostListItemToDirectoryEntry(
      registryItem({ kind: "sandbox", owner: TEAM_OWNER }),
      "wss://relay.example.test",
    );
    const facts = entry.sandbox;
    if (facts === null) throw new Error("Expected a sandbox directory entry");
    expect(facts.ownerTeamId).toBe(TEAM_ID);
    expect(facts.ownerTeamName).toBe(TEAM_NAME);
  });

  it("leaves ownerTeamId null on a personal sandbox", () => {
    const entry = hostListItemToDirectoryEntry(
      registryItem({ kind: "sandbox", owner: undefined }),
      "wss://relay.example.test",
    );
    const facts = entry.sandbox;
    if (facts === null) throw new Error("Expected a sandbox directory entry");
    expect(facts.ownerTeamId).toBeNull();
  });

  it("shows the disclosure on a team sandbox's tile", () => {
    mocks.entry.current = hostListItemToDirectoryEntry(
      registryItem({ kind: "sandbox", owner: TEAM_OWNER }),
      "wss://relay.example.test",
    );

    renderFrame();

    const card = screen.getByTestId("team-host-disclosure");
    expect(card.textContent).toContain("Alpha's hosts only");
    expect(screen.getByTestId("tile-body")).toBeTruthy();
  });

  it("shows nothing on a personal sandbox's tile", () => {
    mocks.entry.current = hostListItemToDirectoryEntry(
      registryItem({ kind: "sandbox", owner: undefined }),
      "wss://relay.example.test",
    );

    renderFrame();

    expect(screen.queryByTestId("team-host-disclosure")).toBeNull();
  });

  it("shows nothing on a user-owned sandbox's tile", () => {
    mocks.entry.current = hostListItemToDirectoryEntry(
      registryItem({
        kind: "sandbox",
        owner: { kind: "user", id: VIEWER },
      }),
      "wss://relay.example.test",
    );

    renderFrame();

    expect(screen.queryByTestId("team-host-disclosure")).toBeNull();
  });

  it("shows nothing on a host that is not a sandbox", () => {
    mocks.entry.current = hostListItemToDirectoryEntry(
      registryItem({ kind: "personal", owner: undefined }),
      "wss://relay.example.test",
    );

    renderFrame();

    expect(screen.queryByTestId("team-host-disclosure")).toBeNull();
  });
});
