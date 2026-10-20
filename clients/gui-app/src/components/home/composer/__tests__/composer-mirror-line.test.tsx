/**
 * The mirror line on the composer.
 *
 * A task can hold hosts of more than one principal: the viewer's laptop beside
 * a team's sandbox. Agents on one cannot work with agents on the other, and the
 * person starting a conversation should hear that ONCE per task, before they
 * expect otherwise. The line is informational (role "status", not the refusal
 * slot's "alert"), names the other side, and is not repeated for the same
 * viewer and task once seen.
 *
 * Four layers, bottom up: the pure model (which host is named, in which order),
 * the persisted "seen" store (bounded), the notice component (its role per
 * kind), and the hook that joins them to the task's hosts view.
 */
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  HostListItem,
  HostOwnerPrincipal,
} from "@traycer/protocol/host/host-status";
import type {
  TaskHostPrincipal,
  TaskHostRow,
} from "@traycer/protocol/host/task-host-summary";
import {
  TASK_HOST_UNNAMED_LABEL,
  type TaskHostDirectoryFact,
  type TaskHostGroup,
  type TaskHostGroupRow,
  taskHostGroups,
} from "@/components/epic-canvas/sidebar/task-host-groups-model";
import {
  composerMirrorLineText,
  composerTopNotice,
  mirrorLineOtherHostName,
  type ComposerMirrorLine,
} from "@/components/home/composer/composer-mirror-line-model";
import {
  ComposerHostNotice,
  type ComposerHostNoticeState,
} from "@/components/home/composer/composer-host-notice";
import { useComposerMirrorLine } from "@/hooks/composer/use-composer-mirror-line";
import type { TaskHostsView } from "@/hooks/epic/use-task-hosts-view";
import {
  COMPOSER_MIRROR_LINE_SEEN_CAP,
  composerMirrorLineSeen,
  useComposerMirrorLineSeenStore,
} from "@/stores/epics/composer-mirror-line-seen-store";

/**
 * What the hook reads, driven per test. Each holder is annotated INSIDE the
 * hoisted factory: an inferred `{ current: { kind: "none" } }` widens `kind` to
 * `string` and the view could then never be assigned a hosts or error view.
 */
const inputs = vi.hoisted(() => {
  const view: { current: TaskHostsView } = { current: { kind: "none" } };
  const viewerId: { current: string } = { current: "user-1" };
  const registry: { current: { hosts: HostListItem[] } | null } = {
    current: null,
  };
  // What the task-host groups are composed from, beside the task's rows.
  const teams: {
    current: readonly { readonly teamId: string; readonly name: string }[];
  } = { current: [] };
  const collaboratorNames: { current: ReadonlyMap<string, string> } = {
    current: new Map(),
  };
  const directory: { current: ReadonlyMap<string, TaskHostDirectoryFact> } = {
    current: new Map(),
  };
  return {
    view,
    viewerId,
    registry,
    teams,
    collaboratorNames,
    directory,
    groupViewerId: "user-1",
  };
});

vi.mock("@/hooks/epic/use-task-hosts-view", () => ({
  useTaskHostsView: (): TaskHostsView => inputs.view.current,
}));

// The groups are composed by the REAL model from the task's rows, as the Hosts
// section composes them, so a person host (`label: null` on the wire) takes its
// display label from the directory and a collaborator's from the group title.
vi.mock("@/hooks/epic/use-task-host-groups", async () => {
  const model =
    await import("@/components/epic-canvas/sidebar/task-host-groups-model");
  return {
    useTaskHostGroups: (
      _epicId: string,
      hosts: readonly TaskHostRow[] | null,
    ): readonly TaskHostGroup[] =>
      hosts === null
        ? []
        : model.taskHostGroups({
            hosts,
            viewerUserId: inputs.groupViewerId,
            teams: inputs.teams.current,
            collaboratorNames: inputs.collaboratorNames.current,
            directory: inputs.directory.current,
            agentCountByHostId: new Map(),
          }),
  };
});

vi.mock("@/hooks/chats/use-cloud-chat-queries", () => ({
  useCloudChatViewerId: (): string => inputs.viewerId.current,
}));

vi.mock("@/hooks/auth/use-registered-hosts-query", () => ({
  useRegisteredHosts: (): {
    readonly data: { hosts: HostListItem[] } | null;
  } => ({
    data: inputs.registry.current,
  }),
}));

const VIEWER_ID = "user-1";
const VIEWER: TaskHostPrincipal = { kind: "user", id: VIEWER_ID };
const ACME: TaskHostPrincipal = { kind: "team", id: "team-acme" };
const GLOBEX: TaskHostPrincipal = { kind: "team", id: "team-globex" };
const COLLABORATOR: TaskHostPrincipal = { kind: "user", id: "user-2" };

function row(
  hostId: string,
  label: string | null,
  principal: TaskHostPrincipal,
): TaskHostRow {
  return { hostId, label, principal, reach: "same_principal" };
}

function registryItem(
  hostId: string,
  owner: HostOwnerPrincipal | null,
): HostListItem {
  return {
    hostId,
    displayName: null,
    platform: null,
    kind: "sandbox",
    publicKey: "public-key",
    createdAt: "2026-10-01T00:00:00.000Z",
    status: {
      connectivity: "connectable",
      viewerReachability: "ok",
      clientCloud: "ok",
      updateState: "current",
      appVersion: null,
      lastSeenAt: null,
    },
    ...(owner === null ? {} : { owner }),
    updatePolicy: "manual",
  };
}

const SEEN_KEY = "traycer-gui-app:composer-mirror-line-seen";

function defaultDirectory(): ReadonlyMap<string, TaskHostDirectoryFact> {
  return new Map<string, TaskHostDirectoryFact>([
    ["h-laptop", { label: "My laptop", state: "online" }],
    ["h-laptop-2", { label: "My other laptop", state: "online" }],
  ]);
}

beforeEach(() => {
  useComposerMirrorLineSeenStore.setState({ seen: {} });
  inputs.teams.current = [{ teamId: ACME.id, name: "acme" }];
  inputs.collaboratorNames.current = new Map();
  inputs.directory.current = defaultDirectory();
});

afterEach(() => {
  cleanup();
  useComposerMirrorLineSeenStore.setState({ seen: {} });
  window.localStorage.removeItem(SEEN_KEY);
  inputs.view.current = { kind: "none" };
  inputs.viewerId.current = VIEWER_ID;
  inputs.registry.current = null;
  inputs.teams.current = [];
  inputs.collaboratorNames.current = new Map();
  inputs.directory.current = new Map();
  vi.useRealTimers();
});

describe("composerMirrorLineText", () => {
  it("names the other host in the line, verbatim", () => {
    expect(composerMirrorLineText("Acme sandbox")).toBe(
      "Agents here cannot work with the agents on Acme sandbox; the task still shares its files and chats.",
    );
  });
});

function groupRow(hostId: string, label: string): TaskHostGroupRow {
  return {
    hostId,
    label,
    agentsLine: null,
    unreachable: false,
    state: null,
    openable: false,
  };
}

function group(
  key: string,
  title: string,
  rows: readonly TaskHostGroupRow[],
): TaskHostGroup {
  return { key, title, rows };
}

describe("mirrorLineOtherHostName", () => {
  const START = "h-start";

  it("walks the groups in order and names the first row whose principal differs", () => {
    const hosts = [
      row(START, null, ACME),
      row("h-viewer", null, VIEWER),
      row("h-globex", "Globex sandbox", GLOBEX),
      row("h-user-2", null, COLLABORATOR),
    ];
    // Groups in the task-host groups' order: Personal, teams, collaborators. The
    // order of `hosts` (the wire order) is deliberately different.
    const groups = [
      group("personal", "Personal", [groupRow("h-viewer", "My laptop")]),
      group("team:team-globex", "globex", [
        groupRow("h-globex", "Globex sandbox"),
      ]),
      group("user:user-2", "Alice's", [
        groupRow("h-user-2", "Collaborator laptop"),
      ]),
    ];
    expect(
      mirrorLineOtherHostName({
        groups,
        hosts,
        startHostId: START,
        startPrincipalFallback: ACME,
      }),
    ).toBe("My laptop");
  });

  it("walks each group's rows in order", () => {
    const hosts = [
      row(START, null, VIEWER),
      row("h-globex", "Globex sandbox", GLOBEX),
      row("h-acme", "Acme sandbox", ACME),
    ];
    const groups = [
      group("personal", "Personal", [groupRow(START, "Start box")]),
      group("team:mixed", "teams", [
        groupRow("h-acme", "Acme sandbox"),
        groupRow("h-globex", "Globex sandbox"),
      ]),
    ];
    expect(
      mirrorLineOtherHostName({
        groups,
        hosts,
        startHostId: START,
        startPrincipalFallback: VIEWER,
      }),
    ).toBe("Acme sandbox");
  });

  it("never counts the start host itself", () => {
    expect(
      mirrorLineOtherHostName({
        groups: [
          group("team:team-acme", "acme", [groupRow(START, "Start box")]),
        ],
        hosts: [row(START, "Start box", ACME)],
        startHostId: START,
        startPrincipalFallback: VIEWER,
      }),
    ).toBeNull();
  });

  it("is null when every other row has the start host's principal", () => {
    const hosts = [
      row(START, "Acme one", ACME),
      row("h-acme-2", "Acme two", ACME),
      row("h-acme-3", "Acme three", ACME),
    ];
    const groups = [
      group("team:team-acme", "acme", [
        groupRow(START, "Acme one"),
        groupRow("h-acme-2", "Acme two"),
        groupRow("h-acme-3", "Acme three"),
      ]),
    ];
    expect(
      mirrorLineOtherHostName({
        groups,
        hosts,
        startHostId: START,
        startPrincipalFallback: ACME,
      }),
    ).toBeNull();
  });

  it("tells two teams apart by id", () => {
    const hosts = [
      row(START, "Acme one", ACME),
      row("h-globex", "Globex", GLOBEX),
    ];
    const groups = [
      group("team:team-acme", "acme", [groupRow(START, "Acme one")]),
      group("team:team-globex", "globex", [groupRow("h-globex", "Globex")]),
    ];
    expect(
      mirrorLineOtherHostName({
        groups,
        hosts,
        startHostId: START,
        startPrincipalFallback: ACME,
      }),
    ).toBe("Globex");
  });

  it("tells a user from a team that shares its id", () => {
    const sameId = "shared-id";
    const hosts = [
      row(START, null, { kind: "user", id: sameId }),
      row("h-team", "A team's host", { kind: "team", id: sameId }),
    ];
    const groups = [
      group("user:shared-id", "Alice's", [groupRow(START, "A user's host")]),
      group("team:shared-id", "acme", [groupRow("h-team", "A team's host")]),
    ];
    expect(
      mirrorLineOtherHostName({
        groups,
        hosts,
        startHostId: START,
        startPrincipalFallback: { kind: "user", id: sameId },
      }),
    ).toBe("A team's host");
  });

  it("takes a row's principal from the hosts row with its id, and skips a group row that has none", () => {
    const hosts = [row(START, null, VIEWER), row("h-real", "Real", ACME)];
    const groups = [
      group("personal", "Personal", [
        groupRow(START, "Start box"),
        // Not a task row: nothing says whose it is, so it cannot be named.
        groupRow("h-ghost", "Ghost"),
      ]),
      group("team:team-acme", "acme", [groupRow("h-real", "Real")]),
    ];
    expect(
      mirrorLineOtherHostName({
        groups,
        hosts,
        startHostId: START,
        startPrincipalFallback: VIEWER,
      }),
    ).toBe("Real");
  });

  it("uses the fallback principal when the start host is not a task row", () => {
    const hosts = [row("h-viewer", null, VIEWER)];
    const groups = [
      group("personal", "Personal", [groupRow("h-viewer", "My laptop")]),
    ];
    expect(
      mirrorLineOtherHostName({
        groups,
        hosts,
        startHostId: START,
        startPrincipalFallback: ACME,
      }),
    ).toBe("My laptop");
    expect(
      mirrorLineOtherHostName({
        groups,
        hosts,
        startHostId: START,
        startPrincipalFallback: VIEWER,
      }),
    ).toBeNull();
  });

  it("prefers the start host's own hosts row over the fallback when the row exists", () => {
    // Were the fallback (a team) used, the second row (the viewer's) would
    // differ from it; the row's own principal is the viewer, so it does not.
    const hosts = [row(START, null, VIEWER), row("h-viewer-2", null, VIEWER)];
    const groups = [
      group("personal", "Personal", [
        groupRow(START, "My laptop"),
        groupRow("h-viewer-2", "My other laptop"),
      ]),
    ];
    expect(
      mirrorLineOtherHostName({
        groups,
        hosts,
        startHostId: START,
        startPrincipalFallback: ACME,
      }),
    ).toBeNull();
  });

  it("is null for no groups", () => {
    expect(
      mirrorLineOtherHostName({
        groups: [],
        hosts: [],
        startHostId: START,
        startPrincipalFallback: VIEWER,
      }),
    ).toBeNull();
  });

  describe("an unnamed host", () => {
    function unnamedIn(
      groupKey: string,
      groupTitle: string,
      principal: TaskHostPrincipal,
    ): string | null {
      return mirrorLineOtherHostName({
        groups: [
          group(groupKey, groupTitle, [
            groupRow("h-unnamed", TASK_HOST_UNNAMED_LABEL),
          ]),
        ],
        hosts: [
          row(START, "Start box", ACME),
          row("h-unnamed", null, principal),
        ],
        startHostId: START,
        startPrincipalFallback: ACME,
      });
    }

    it("has the label the task-host groups give unnamed hosts", () => {
      expect(TASK_HOST_UNNAMED_LABEL).toBe("Unnamed host");
    });

    it("is one of your hosts in the Personal group", () => {
      expect(unnamedIn("personal", "Personal", VIEWER)).toBe(
        "one of your hosts",
      );
    });

    it("is the collaborator's host when the collaborator is named", () => {
      expect(unnamedIn("user:user-2", "Alice's", COLLABORATOR)).toBe(
        "Alice's host",
      );
    });

    it("keeps the case of a collaborator named A Kumar", () => {
      expect(unnamedIn("user:user-kumar", "A Kumar's", COLLABORATOR)).toBe(
        "A Kumar's host",
      );
    });

    it("lower-cases the A of an anonymous collaborator's group title", () => {
      expect(unnamedIn("user:user-2", "A collaborator's", COLLABORATOR)).toBe(
        "a collaborator's host",
      );
    });

    it("lower-cases the A of an unnamed team's group title", () => {
      expect(unnamedIn("team:team-globex", "A team", GLOBEX)).toBe(
        "a team host",
      );
    });

    it("keeps a team's own name, as the group titles it", () => {
      expect(unnamedIn("team:team-globex", "acme", GLOBEX)).toBe("acme host");
    });

    it("leaves a named host's label alone, even in the Personal group", () => {
      expect(
        mirrorLineOtherHostName({
          groups: [
            group("personal", "Personal", [groupRow("h-named", "MacBook Pro")]),
          ],
          hosts: [row(START, "Start box", ACME), row("h-named", null, VIEWER)],
          startHostId: START,
          startPrincipalFallback: ACME,
        }),
      ).toBe("MacBook Pro");
    });
  });
});

describe("taskHostGroups, a personal host the registry never named", () => {
  it("labels it Unnamed host when the directory only echoes its host id", () => {
    // A registry host with no display name reaches the directory with
    // `label === hostId` (the remote fetcher falls back to the id), so the id
    // is not a name and must not become the row's label.
    const hostId = "h-raw-laptop";
    const groups = taskHostGroups({
      hosts: [row(hostId, null, VIEWER)],
      viewerUserId: VIEWER_ID,
      teams: [],
      collaboratorNames: new Map(),
      directory: new Map<string, TaskHostDirectoryFact>([
        [hostId, { label: hostId, state: "online" }],
      ]),
      agentCountByHostId: new Map(),
    });

    expect(groups).toHaveLength(1);
    expect(groups[0]?.key).toBe("personal");
    expect(groups[0]?.rows.map((groupedRow) => groupedRow.label)).toEqual([
      "Unnamed host",
    ]);
  });
});

describe("the composer mirror line seen store", () => {
  it("starts empty and has seen nothing", () => {
    const { seen } = useComposerMirrorLineSeenStore.getState();
    expect(Object.keys(seen)).toHaveLength(0);
    expect(composerMirrorLineSeen(seen, "user-1", "epic-1")).toBe(false);
  });

  it("records a viewer and task pair, and no other", () => {
    useComposerMirrorLineSeenStore.getState().markSeen("user-1", "epic-1");
    const { seen } = useComposerMirrorLineSeenStore.getState();

    expect(composerMirrorLineSeen(seen, "user-1", "epic-1")).toBe(true);
    expect(composerMirrorLineSeen(seen, "user-1", "epic-2")).toBe(false);
    expect(composerMirrorLineSeen(seen, "user-2", "epic-1")).toBe(false);
  });

  it("evicts the oldest entry when a new pair is marked at the cap", () => {
    expect(COMPOSER_MIRROR_LINE_SEEN_CAP).toBe(500);
    // Fake only the clock, one tick per mark: eviction by age is then
    // unambiguous whether the store stamps a time or a sequence.
    vi.useFakeTimers({ toFake: ["Date"] });
    const { markSeen } = useComposerMirrorLineSeenStore.getState();
    for (let index = 0; index < COMPOSER_MIRROR_LINE_SEEN_CAP; index += 1) {
      vi.setSystemTime(1_000_000 + index);
      markSeen("user-1", `epic-${index}`);
    }
    const full = useComposerMirrorLineSeenStore.getState().seen;
    expect(Object.keys(full)).toHaveLength(COMPOSER_MIRROR_LINE_SEEN_CAP);
    expect(composerMirrorLineSeen(full, "user-1", "epic-0")).toBe(true);

    vi.setSystemTime(1_000_000 + COMPOSER_MIRROR_LINE_SEEN_CAP);
    markSeen("user-1", "epic-new");

    const after = useComposerMirrorLineSeenStore.getState().seen;
    expect(Object.keys(after)).toHaveLength(COMPOSER_MIRROR_LINE_SEEN_CAP);
    expect(composerMirrorLineSeen(after, "user-1", "epic-new")).toBe(true);
    expect(composerMirrorLineSeen(after, "user-1", "epic-0")).toBe(false);
    expect(composerMirrorLineSeen(after, "user-1", "epic-1")).toBe(true);
  });

  it("marking a pair that is already recorded evicts nothing at the cap", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { markSeen } = useComposerMirrorLineSeenStore.getState();
    for (let index = 0; index < COMPOSER_MIRROR_LINE_SEEN_CAP; index += 1) {
      vi.setSystemTime(2_000_000 + index);
      markSeen("user-1", `epic-${index}`);
    }

    vi.setSystemTime(2_000_000 + COMPOSER_MIRROR_LINE_SEEN_CAP);
    markSeen("user-1", "epic-5");

    const after = useComposerMirrorLineSeenStore.getState().seen;
    expect(Object.keys(after)).toHaveLength(COMPOSER_MIRROR_LINE_SEEN_CAP);
    expect(composerMirrorLineSeen(after, "user-1", "epic-0")).toBe(true);
    expect(composerMirrorLineSeen(after, "user-1", "epic-5")).toBe(true);
  });

  describe("across windows", () => {
    function seenBlob(pairs: readonly (readonly [string, string])[]): string {
      const seen: Record<string, number> = {};
      for (const [viewer, epic] of pairs) {
        seen[`${viewer}\u0000${epic}`] = 5_000;
      }
      return JSON.stringify({ state: { seen }, version: 1 });
    }

    function persistedPairCount(): number {
      const raw = window.localStorage.getItem(SEEN_KEY);
      if (raw === null) return 0;
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== "object" || parsed === null) return 0;
      if (!("state" in parsed)) return 0;
      const state = parsed.state;
      if (typeof state !== "object" || state === null) return 0;
      if (!("seen" in state)) return 0;
      const seen = state.seen;
      if (typeof seen !== "object" || seen === null) return 0;
      return Object.keys(seen).length;
    }

    it("keeps a pair another window wrote after this store hydrated when it marks its own", async () => {
      // Another window marked pair A; this window's store has not heard (the
      // `storage` event is not in play), so its memory still lacks A.
      window.localStorage.setItem(SEEN_KEY, seenBlob([["user-1", "epic-a"]]));
      expect(
        composerMirrorLineSeen(
          useComposerMirrorLineSeenStore.getState().seen,
          "user-1",
          "epic-a",
        ),
      ).toBe(false);

      useComposerMirrorLineSeenStore.getState().markSeen("user-1", "epic-b");

      // `markSeen` rehydrates before it writes, so neither pair is lost, in
      // memory or on disk. (Written blind it would persist {B} over {A}.)
      await vi.waitFor(() => {
        const { seen } = useComposerMirrorLineSeenStore.getState();
        expect(composerMirrorLineSeen(seen, "user-1", "epic-a")).toBe(true);
        expect(composerMirrorLineSeen(seen, "user-1", "epic-b")).toBe(true);
        expect(persistedPairCount()).toBe(2);
      });
    });

    it("picks up another window's write when the storage event fires", async () => {
      expect(
        composerMirrorLineSeen(
          useComposerMirrorLineSeenStore.getState().seen,
          "user-1",
          "epic-c",
        ),
      ).toBe(false);

      window.localStorage.setItem(SEEN_KEY, seenBlob([["user-1", "epic-c"]]));
      window.dispatchEvent(new StorageEvent("storage", { key: SEEN_KEY }));

      await vi.waitFor(() => {
        expect(
          composerMirrorLineSeen(
            useComposerMirrorLineSeenStore.getState().seen,
            "user-1",
            "epic-c",
          ),
        ).toBe(true);
      });
    });
  });
});

describe("ComposerHostNotice", () => {
  const MIRROR: ComposerHostNoticeState = {
    kind: "mirror",
    message: composerMirrorLineText("Acme sandbox"),
  };
  const REFUSED: ComposerHostNoticeState = {
    kind: "refused",
    message: "Could not start on that host.",
  };

  it("renders a mirror notice as a status, not an alert", () => {
    const onDismiss = vi.fn();
    render(<ComposerHostNotice notice={MIRROR} onDismiss={onDismiss} />);

    const notice = screen.getByRole("status");
    expect(notice.getAttribute("data-notice-kind")).toBe("mirror");
    expect(notice.textContent).toContain(MIRROR.message);
    expect(screen.queryByRole("alert")).toBeNull();

    fireEvent.click(screen.getByTestId("composer-host-notice-dismiss"));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("keeps a refusal an alert", () => {
    render(<ComposerHostNotice notice={REFUSED} onDismiss={vi.fn()} />);

    const notice = screen.getByRole("alert");
    expect(notice.getAttribute("data-notice-kind")).toBe("refused");
    expect(notice.textContent).toContain(REFUSED.message);
    expect(screen.queryByRole("status")).toBeNull();
  });
});

describe("composerTopNotice", () => {
  const MIRROR: ComposerHostNoticeState = {
    kind: "mirror",
    message: composerMirrorLineText("Acme sandbox"),
  };
  const REFUSED: ComposerHostNoticeState = {
    kind: "refused",
    message: "Could not start on that host.",
  };

  it("lets a refusal outrank the mirror line, with the refusal's own dismiss", () => {
    const dismissRefused = vi.fn();
    const markSeen = vi.fn();
    const mirror: ComposerMirrorLine = { notice: MIRROR, markSeen };

    const top = composerTopNotice(REFUSED, dismissRefused, mirror);

    expect(top.notice).toBe(REFUSED);
    expect(top.dismiss).toBe(dismissRefused);
    top.dismiss();
    expect(dismissRefused).toHaveBeenCalledTimes(1);
    expect(markSeen).not.toHaveBeenCalled();
  });

  it("shows the mirror line when nothing was refused, and its dismiss marks it seen", () => {
    const dismissRefused = vi.fn();
    const markSeen = vi.fn();
    const mirror: ComposerMirrorLine = { notice: MIRROR, markSeen };

    const top = composerTopNotice(null, dismissRefused, mirror);

    expect(top.notice).toBe(MIRROR);
    expect(top.dismiss).toBe(markSeen);
    top.dismiss();
    expect(markSeen).toHaveBeenCalledTimes(1);
    expect(dismissRefused).not.toHaveBeenCalled();
  });

  it("shows nothing when there is neither a refusal nor a mirror line", () => {
    const markSeen = vi.fn();
    const top = composerTopNotice(null, vi.fn(), { notice: null, markSeen });

    expect(top.notice).toBeNull();
    expect(top.dismiss).toBe(markSeen);
  });
});

describe("useComposerMirrorLine", () => {
  const LAPTOP = row("h-laptop", null, VIEWER);
  const SANDBOX = row("h-sandbox", "Acme sandbox", ACME);

  function hostsView(hosts: readonly TaskHostRow[]): TaskHostsView {
    return { kind: "hosts", hosts };
  }

  it("names the team sandbox for a conversation starting on the viewer's laptop", () => {
    inputs.view.current = hostsView([LAPTOP, SANDBOX]);
    const { result } = renderHook(() =>
      useComposerMirrorLine("epic-1", "h-laptop"),
    );

    expect(result.current.notice).toEqual({
      kind: "mirror",
      message: composerMirrorLineText("Acme sandbox"),
    });
  });

  it("names the laptop for a conversation starting on a task row of the team sandbox", () => {
    inputs.view.current = hostsView([LAPTOP, SANDBOX]);
    const { result } = renderHook(() =>
      useComposerMirrorLine("epic-1", "h-sandbox"),
    );

    expect(result.current.notice).toEqual({
      kind: "mirror",
      message: composerMirrorLineText("My laptop"),
    });
  });

  it("takes the start host's principal from the registry owner when the sandbox is not yet a task row", () => {
    inputs.view.current = hostsView([LAPTOP]);
    inputs.registry.current = {
      hosts: [
        registryItem("h-sandbox", {
          kind: "team",
          id: ACME.id,
          name: "Acme",
        }),
      ],
    };
    const { result } = renderHook(() =>
      useComposerMirrorLine("epic-1", "h-sandbox"),
    );

    expect(result.current.notice).toEqual({
      kind: "mirror",
      message: composerMirrorLineText("My laptop"),
    });
  });

  it("falls back to the viewer for a start host the task and the registry both lack", () => {
    inputs.view.current = hostsView([LAPTOP, SANDBOX]);
    const { result } = renderHook(() =>
      useComposerMirrorLine("epic-1", "h-unlisted"),
    );

    // The viewer's own principal differs from the team sandbox only, and the
    // laptop (also the viewer's) is the same principal as the fallback.
    expect(result.current.notice).toEqual({
      kind: "mirror",
      message: composerMirrorLineText("Acme sandbox"),
    });
  });

  it("names the label the task-host groups give the viewer's own host, from the directory", () => {
    inputs.directory.current = new Map<string, TaskHostDirectoryFact>([
      ["h-laptop", { label: "MacBook Pro", state: "online" }],
    ]);
    inputs.view.current = hostsView([LAPTOP, SANDBOX]);
    const { result } = renderHook(() =>
      useComposerMirrorLine("epic-1", "h-sandbox"),
    );

    expect(result.current.notice).toEqual({
      kind: "mirror",
      message: composerMirrorLineText("MacBook Pro"),
    });
  });

  it("names a collaborator's unnamed host after the collaborator", () => {
    inputs.collaboratorNames.current = new Map([[COLLABORATOR.id, "Alice"]]);
    inputs.view.current = hostsView([
      LAPTOP,
      row("h-alice", null, COLLABORATOR),
    ]);
    const { result } = renderHook(() =>
      useComposerMirrorLine("epic-1", "h-laptop"),
    );

    expect(result.current.notice).toEqual({
      kind: "mirror",
      message: composerMirrorLineText("Alice's host"),
    });
  });

  it("names a collaborator nobody knows the name of as a collaborator's host", () => {
    inputs.view.current = hostsView([
      LAPTOP,
      row("h-alice", null, COLLABORATOR),
    ]);
    const { result } = renderHook(() =>
      useComposerMirrorLine("epic-1", "h-laptop"),
    );

    expect(result.current.notice).toEqual({
      kind: "mirror",
      message: composerMirrorLineText("a collaborator's host"),
    });
  });

  it("names a team's unnamed host after the team, and one of an unknown team as a team host", () => {
    inputs.view.current = hostsView([LAPTOP, row("h-acme", null, ACME)]);
    const known = renderHook(() => useComposerMirrorLine("epic-1", "h-laptop"));
    expect(known.result.current.notice).toEqual({
      kind: "mirror",
      message: composerMirrorLineText("acme host"),
    });

    inputs.teams.current = [];
    const unknown = renderHook(() =>
      useComposerMirrorLine("epic-2", "h-laptop"),
    );
    expect(unknown.result.current.notice).toEqual({
      kind: "mirror",
      message: composerMirrorLineText("a team host"),
    });
  });

  it("names the viewer's own unnamed host as one of your hosts", () => {
    inputs.directory.current = new Map();
    inputs.view.current = hostsView([LAPTOP, SANDBOX]);
    const { result } = renderHook(() =>
      useComposerMirrorLine("epic-1", "h-sandbox"),
    );

    expect(result.current.notice).toEqual({
      kind: "mirror",
      message: composerMirrorLineText("one of your hosts"),
    });
  });

  it("calls the viewer's own host one of your hosts when the directory only echoes its host id", () => {
    const rawHostId = "h-raw-laptop";
    inputs.directory.current = new Map<string, TaskHostDirectoryFact>([
      [rawHostId, { label: rawHostId, state: "online" }],
    ]);
    inputs.view.current = hostsView([row(rawHostId, null, VIEWER), SANDBOX]);
    const { result } = renderHook(() =>
      useComposerMirrorLine("epic-1", "h-sandbox"),
    );

    expect(result.current.notice).toEqual({
      kind: "mirror",
      message:
        "Agents here cannot work with the agents on one of your hosts; the task still shares its files and chats.",
    });
    expect(result.current.notice?.message).not.toContain(rawHostId);
  });

  it("shows nothing when every host in the task is the start host's principal", () => {
    inputs.view.current = hostsView([LAPTOP, row("h-laptop-2", null, VIEWER)]);
    const { result } = renderHook(() =>
      useComposerMirrorLine("epic-1", "h-laptop"),
    );

    expect(result.current.notice).toBeNull();
  });

  it("shows nothing for an unlisted start host when the task holds only the viewer's hosts", () => {
    inputs.view.current = hostsView([LAPTOP]);
    const { result } = renderHook(() =>
      useComposerMirrorLine("epic-1", "h-unlisted"),
    );

    expect(result.current.notice).toBeNull();
  });

  it("shows nothing when the hosts view is none or an error", () => {
    inputs.view.current = { kind: "none" };
    const none = renderHook(() => useComposerMirrorLine("epic-1", "h-laptop"));
    expect(none.result.current.notice).toBeNull();

    inputs.view.current = { kind: "error", retry: () => undefined };
    const failed = renderHook(() =>
      useComposerMirrorLine("epic-1", "h-laptop"),
    );
    expect(failed.result.current.notice).toBeNull();
  });

  it("shows nothing while the composer has resolved no host", () => {
    inputs.view.current = hostsView([LAPTOP, SANDBOX]);
    const { result } = renderHook(() => useComposerMirrorLine("epic-1", null));

    expect(result.current.notice).toBeNull();
  });

  it("stops showing the line for this viewer and task once marked seen, and only for them", () => {
    inputs.view.current = hostsView([LAPTOP, SANDBOX]);
    const first = renderHook(() => useComposerMirrorLine("epic-1", "h-laptop"));
    expect(first.result.current.notice).not.toBeNull();

    act(() => {
      first.result.current.markSeen();
    });

    expect(first.result.current.notice).toBeNull();

    // The same viewer in another task still hears it.
    const otherEpic = renderHook(() =>
      useComposerMirrorLine("epic-2", "h-laptop"),
    );
    expect(otherEpic.result.current.notice).not.toBeNull();

    // Another viewer in the same task still hears it.
    inputs.viewerId.current = "user-9";
    const otherViewer = renderHook(() =>
      useComposerMirrorLine("epic-1", "h-laptop"),
    );
    expect(otherViewer.result.current.notice).not.toBeNull();

    // And the first viewer's mark is what the store holds.
    const { seen } = useComposerMirrorLineSeenStore.getState();
    expect(composerMirrorLineSeen(seen, VIEWER_ID, "epic-1")).toBe(true);
    expect(composerMirrorLineSeen(seen, "user-9", "epic-1")).toBe(false);
  });

  it("does not show the line for a pair already seen before the composer mounted", () => {
    useComposerMirrorLineSeenStore.getState().markSeen(VIEWER_ID, "epic-1");
    inputs.view.current = hostsView([LAPTOP, SANDBOX]);
    const { result } = renderHook(() =>
      useComposerMirrorLine("epic-1", "h-laptop"),
    );

    expect(result.current.notice).toBeNull();
  });
});
