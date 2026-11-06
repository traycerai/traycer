import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  advanceLegendListTime,
  installLegendListTestClock,
} from "@/components/chat/__tests__/legend-list-test-environment";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  recordNegotiatedHostMethods,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import type {
  EnvironmentMoveAcceptRequest,
  EnvironmentMoveAcceptResponse,
  EnvironmentMovePlanResponseV12,
} from "@traycer/protocol/host/environment/move-contracts";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@/lib/host";
import { MoveSheet } from "@/components/settings/move-sheet";
import type { HostsRunningConfiguration } from "@/components/settings/environment/hosts-running-configuration-model";
import { buildEnvironmentClient } from "@/lib/environment/__tests__/environment-test-support";
import { useMoveSheetStore } from "@/stores/settings/move-sheet-store";

const HOST_ID = "old";

const clientMock = vi.hoisted(
  (): { current: HostClient<HostRpcRegistry> | null } => ({ current: null }),
);
vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: () => clientMock.current,
}));

// The computers running Personal, as the one hook answers them.
const runningPersonalMock = vi.hoisted(
  (): { current: HostsRunningConfiguration | null; retry: () => void } => ({
    current: null,
    retry: () => undefined,
  }),
);
vi.mock(
  "@/components/settings/environment/use-hosts-running-configuration",
  () => ({
    useHostsRunningPersonal: () => runningPersonalMock.current,
  }),
);

type PlanRows = EnvironmentMovePlanResponseV12["rows"];

function row(key: string, label: string, detail: string | null) {
  return { kind: "variable" as const, key, os: null, label, detail };
}

function rowOfKind(key: string, kind: string, label: string) {
  return { kind, key, os: null, label, detail: null };
}

function plan(
  planHash: string,
  rows: Partial<PlanRows>,
): EnvironmentMovePlanResponseV12 {
  return planWith(planHash, rows, {
    personalHoldsSecrets: false,
    itemChoices: false,
  });
}

function planWith(
  planHash: string,
  rows: Partial<PlanRows>,
  flags: {
    readonly personalHoldsSecrets: boolean;
    readonly itemChoices: boolean;
  },
): EnvironmentMovePlanResponseV12 {
  return {
    ...flags,
    planHash,
    planRevision: 1,
    hostVersion: "1.5.0",
    disclosureVersion: 1,
    rows: {
      moves: [],
      staysOnThisComputer: [],
      alreadyInPersonal: [],
      differsMasked: [],
      ...rows,
    },
    guideDiffers: false,
  };
}

const FIRST_PLAN = plan("hash-1", {
  moves: [row("EDITOR", "EDITOR", "variable"), row("PAGER", "PAGER", null)],
  staysOnThisComputer: [
    row("SSH", "SSH sign-in", "terminal"),
    row(
      "OPENAI_API_KEY",
      "OPENAI_API_KEY",
      "OPENAI_API_KEY (variable) holds a value that reads like a key, and a key's value does not move in or out of a computer, so it stays here and keeps working. To use it everywhere, add it on Secrets.",
    ),
  ],
});

interface Harness {
  readonly accepts: EnvironmentMoveAcceptRequest[];
}

interface MountOptions {
  readonly plans: readonly EnvironmentMovePlanResponseV12[];
  readonly acceptAnswers: readonly EnvironmentMoveAcceptResponse[];
}

function mount(options: MountOptions): Harness {
  return mountReaching(options, []);
}

function mountReaching(
  options: MountOptions,
  runningPersonal: readonly { hostId: string; name: string }[],
): Harness {
  return mountWithRunning(options, {
    hosts: runningPersonal.map((host) => ({
      hostId: host.hostId,
      hostName: host.name,
      name: host.name,
      kind: "personal",
      isThisComputer: false,
      lastReportedAt: 1,
      applied: [],
    })),
    state: "ready",
    thisComputerUnread: false,
    collisions: [],
    retry: runningPersonalMock.retry,
    reread: () => undefined,
  });
}

function mountWithRunning(
  options: MountOptions,
  running: HostsRunningConfiguration,
): Harness {
  const accepts: EnvironmentMoveAcceptRequest[] = [];
  let planReads = 0;
  const { client } = buildEnvironmentClient({
    hostId: HOST_ID,
    handlers: {
      "environment.move.plan": () => {
        const answer =
          options.plans[Math.min(planReads, options.plans.length - 1)];
        planReads += 1;
        return answer;
      },
      "environment.move.accept": (request) => {
        accepts.push(request);
        return options.acceptAnswers[
          Math.min(accepts.length - 1, options.acceptAnswers.length - 1)
        ];
      },
    },
  });
  clientMock.current = client;
  runningPersonalMock.current = running;
  recordNegotiatedHostMethods(HOST_ID, [
    "environment.move.plan",
    "environment.move.accept",
  ]);
  render(
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: {
            queries: { retry: false, gcTime: 0 },
            mutations: { retry: false },
          },
        })
      }
    >
      <MoveSheet />
    </QueryClientProvider>,
  );
  act(() => {
    useMoveSheetStore
      .getState()
      .openSheet({ hostId: HOST_ID, hostName: "Old laptop" });
  });
  return { accepts };
}

async function settle(): Promise<void> {
  await advanceLegendListTime(50);
}

beforeEach(() => {
  installLegendListTestClock();
  useMoveSheetStore.setState({ target: null });
});

afterEach(() => {
  cleanup();
  resetNegotiatedManifests();
  clientMock.current = null;
});

const ACCEPTED: EnvironmentMoveAcceptResponse = {
  outcome: "accepted",
  attemptId: "a",
  consentId: "c",
};

describe("<MoveSheet />", () => {
  it("draws the plan's rows: Moves, Stays with a key-shaped value, Already in Personal (empty)", async () => {
    mount({ plans: [FIRST_PLAN], acceptAnswers: [ACCEPTED] });
    await settle();

    expect(screen.getByText("Move Old laptop to Personal?")).toBeTruthy();
    expect(screen.getByTestId("move-sheet-description").textContent).toBe(
      "Your Personal settings start reaching it. The settings already on it stay there — nothing is deleted. You can move it back any time.",
    );
    const moves = screen.getByTestId("move-sheet-moves");
    expect(moves.textContent).toContain("Moves");
    expect(screen.getByTestId("move-sheet-moves-summary").textContent).toBe(
      "2 variables",
    );
    expect(
      within(moves).getByRole("button", { name: "Show all 2" }),
    ).toBeTruthy();
    const stays = screen.getByTestId("move-sheet-staysOnThisComputer");
    expect(stays.textContent).toContain("Stays on this computer");
    // The key-shaped value is a stay, with its own reason and no choice.
    expect(stays.textContent).toContain("OPENAI_API_KEY");
    expect(stays.textContent).toContain(
      "a key's value does not move in or out of a computer",
    );
    expect(
      screen.getByTestId("move-sheet-alreadyInPersonal").textContent,
    ).toContain("Nothing yet.");
    // Different from Personal is drawn only when the plan has any.
    expect(screen.queryByTestId("move-sheet-differsMasked")).toBeNull();
    // Nothing here is stored as a secret, so no custody sentence.
    expect(
      screen.getByTestId("move-sheet-disclosure").textContent,
    ).not.toContain("Stored encrypted in Traycer's cloud.");
  });

  it("titles the differing section and reads its rows as label: detail", async () => {
    mount({
      plans: [
        plan("hash-d", {
          moves: [row("EDITOR", "EDITOR", "variable")],
          differsMasked: [row("PAGER", "PAGER", "value differs")],
        }),
      ],
      acceptAnswers: [ACCEPTED],
    });
    await settle();

    const differs = screen.getByTestId("move-sheet-differsMasked");
    expect(differs.textContent).toContain("Different from Personal");
    expect(differs.textContent).not.toContain("Differs, masked");
    fireEvent.click(within(differs).getByRole("button", { name: "1 item" }));
    expect(differs.textContent).toContain("PAGER: value differs");
    // The other sections keep the `label · detail` form.
    const moves = screen.getByTestId("move-sheet-moves");
    fireEvent.click(within(moves).getByRole("button", { name: "Show all 1" }));
    expect(moves.textContent).toContain("EDITOR · variable");
  });

  it("draws Already in Personal above Different from Personal", async () => {
    mount({
      plans: [
        plan("hash-s", {
          alreadyInPersonal: [row("HOME", "HOME", null)],
          differsMasked: [row("PAGER", "PAGER", "value differs")],
        }),
      ],
      acceptAnswers: [ACCEPTED],
    });
    await settle();

    const already = screen.getByTestId("move-sheet-alreadyInPersonal");
    const differs = screen.getByTestId("move-sheet-differsMasked");
    expect(already.textContent).toContain("Already in Personal");
    expect(
      already.compareDocumentPosition(differs) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("says above Moves where an edited agent selection guide goes, naming the computer", async () => {
    mount({
      plans: [{ ...FIRST_PLAN, guideDiffers: true }],
      acceptAnswers: [ACCEPTED],
    });
    await settle();

    const note = screen.getByTestId("move-sheet-guide-differs");
    expect(note.textContent).toBe(
      "Agent selection guide: this computer's guide has your edits. It moves to Personal only if Personal has never had a guide. Otherwise it is set aside on Old laptop, and Old laptop uses Personal's guide, or the built-in one if Personal's was removed. Nothing in Personal is replaced or restored.",
    );
    expect(
      note.compareDocumentPosition(screen.getByTestId("move-sheet-moves")) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("says nothing of the guide while it is not edited", async () => {
    mount({ plans: [FIRST_PLAN], acceptAnswers: [ACCEPTED] });
    await settle();

    expect(screen.queryByTestId("move-sheet-guide-differs")).toBeNull();
  });

  it("holds Move to Personal while the computers running Personal are unread", async () => {
    mountWithRunning(
      { plans: [FIRST_PLAN], acceptAnswers: [ACCEPTED] },
      {
        hosts: [],
        state: "loading",
        thisComputerUnread: false,
        collisions: [],
        retry: () => undefined,
        reread: () => undefined,
      },
    );
    await settle();

    expect(
      screen.getByTestId("move-sheet-accept").hasAttribute("disabled"),
    ).toBe(true);
  });

  it("says it couldn't read which computers run Personal, and Retry reads again", async () => {
    const retry = vi.fn<() => void>();
    mountWithRunning(
      { plans: [FIRST_PLAN], acceptAnswers: [ACCEPTED] },
      {
        hosts: [],
        state: "failed",
        thisComputerUnread: false,
        collisions: [],
        retry,
        reread: () => undefined,
      },
    );
    await settle();

    expect(
      screen.getByText("Couldn't read which computers run Personal."),
    ).toBeTruthy();
    expect(screen.queryByTestId("move-sheet-loading")).toBeNull();
    expect(
      screen.getByTestId("move-sheet-accept").hasAttribute("disabled"),
    ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(retry).toHaveBeenCalledOnce();
  });

  it("says there is nothing to move, with Done alone, when no row moves", async () => {
    mount({
      plans: [
        plan("hash-n", {
          alreadyInPersonal: [row("HOME", "HOME", null)],
          staysOnThisComputer: [],
        }),
      ],
      acceptAnswers: [ACCEPTED],
    });
    await settle();

    expect(screen.queryByTestId("move-sheet-not-now")).toBeNull();
    expect(screen.queryByTestId("move-sheet-accept")).toBeNull();
    expect(screen.queryByTestId("move-sheet-disclosure")).toBeNull();
    expect(screen.queryByTestId("move-sheet-moves")).toBeNull();
    expect(screen.queryByTestId("move-sheet-staysOnThisComputer")).toBeNull();
    expect(screen.getByTestId("move-sheet-alreadyInPersonal")).toBeTruthy();
    fireEvent.click(screen.getByTestId("move-sheet-done"));
    expect(useMoveSheetStore.getState().target).toBeNull();
  });

  it("names a one-of-a-kind row by its page, and leaves other rows their label", async () => {
    mount({
      plans: [
        plan("hash-p", {
          moves: [
            rowOfKind("browser", "browser_agent_access", "browser"),
            rowOfKind("EDITOR", "variable", "EDITOR"),
            rowOfKind(
              "claude-code:ANTHROPIC_BASE_URL",
              "env_override",
              "ANTHROPIC_BASE_URL",
            ),
          ],
        }),
      ],
      acceptAnswers: [ACCEPTED],
    });
    await settle();

    const moves = screen.getByTestId("move-sheet-moves");
    fireEvent.click(within(moves).getByRole("button", { name: "Show all 3" }));
    expect(moves.textContent).toContain("Browser agent access");
    expect(moves.textContent).toContain("ANTHROPIC_BASE_URL (Claude Code)");
    expect(moves.textContent).not.toContain("Claude Code: ");
    expect(moves.textContent).not.toContain("browser ");
    expect(moves.textContent).toContain("EDITOR");
  });

  it("says where secrets are stored and who receives them only when something is stored as a secret", async () => {
    const custody =
      "Stored encrypted in Traycer's cloud. Computers running Personal receive the value, readable by their tools and agents; sandboxes use it without seeing it.";
    const accepts =
      "Move accepts this list as shown; if it changes before the upload finishes, you are asked again.";
    const disclosure = () =>
      screen.getByTestId("move-sheet-disclosure").textContent;
    const secretPlan = plan("hash-s", {
      moves: [rowOfKind("TOKEN", "secret", "TOKEN")],
    });
    const options = { plans: [secretPlan], acceptAnswers: [ACCEPTED] };

    mount({
      plans: [plan("hash-v", { moves: [row("EDITOR", "EDITOR", null)] })],
      acceptAnswers: [ACCEPTED],
    });
    await settle();
    expect(disclosure()).toBe(accepts);
    cleanup();

    mountReaching(options, [
      { hostId: "mac", name: "MacBook Pro" },
      { hostId: "dev", name: "dev-box" },
      { hostId: HOST_ID, name: "Old laptop" },
    ]);
    await settle();
    expect(disclosure()).toBe(
      `${custody} Today that is MacBook Pro and dev-box, and any computer that starts running Personal later receives these keys and secrets as values its tools and agents can read. ${accepts}`,
    );
    cleanup();

    mount(options);
    await settle();
    expect(disclosure()).toBe(
      `${custody} No other computer runs Personal yet. Any computer that starts running Personal later receives these keys and secrets as values its tools and agents can read. ${accepts}`,
    );
  });

  it("offers How Traycer handles this under the disclosure, and not on the nothing-to-move sheet", async () => {
    mount({ plans: [FIRST_PLAN], acceptAnswers: [ACCEPTED] });
    await settle();

    expect(screen.queryByTestId("members-data-handling-notice")).toBeNull();
    fireEvent.click(screen.getByTestId("members-data-handling-trigger"));
    expect(
      screen.getByTestId("members-data-handling-notice").textContent,
    ).toContain(
      "Traycer's cloud stores the value encrypted. Sandboxes running Personal or a team use the value without seeing it.",
    );
    cleanup();

    mount({
      plans: [
        plan("hash-n", { alreadyInPersonal: [row("HOME", "HOME", null)] }),
      ],
      acceptAnswers: [ACCEPTED],
    });
    await settle();
    expect(screen.queryByTestId("members-data-handling-trigger")).toBeNull();
  });

  it("has no Moves section when only stays rows are planned", async () => {
    mount({
      plans: [
        plan("hash-n2", { staysOnThisComputer: [row("SSH", "SSH", null)] }),
      ],
      acceptAnswers: [ACCEPTED],
    });
    await settle();

    expect(screen.queryByTestId("move-sheet-moves")).toBeNull();
  });

  it("shows a stays row's detail alone, so the item's name appears once", async () => {
    const detail =
      "github (MCP server) runs npx -y @acme/github on this computer, so it stays here and keeps working.";
    mount({
      plans: [
        plan("hash-s", {
          staysOnThisComputer: [
            row("github", "github", detail),
            row("SSH", "SSH sign-in", null),
          ],
        }),
      ],
      acceptAnswers: [ACCEPTED],
    });
    await settle();

    const stays = screen.getByTestId("move-sheet-staysOnThisComputer");
    const text = stays.textContent;
    expect(text).toContain(detail);
    expect(text.split("github").length - 1).toBe(
      detail.split("github").length - 1,
    );
    expect(text).not.toContain("github · ");
    expect(text).not.toContain("github: ");
    expect(text).toContain("SSH sign-in");
  });

  it("shows what stays on this computer without a click, while Moves stays folded", async () => {
    mount({
      plans: [
        plan("hash-stays", {
          moves: [row("PATH", "PATH", null)],
          staysOnThisComputer: [row("EDITOR", "EDITOR", null)],
        }),
      ],
      acceptAnswers: [ACCEPTED],
    });
    await settle();

    expect(
      screen.getByTestId("move-sheet-staysOnThisComputer").textContent,
    ).toContain("EDITOR");
    expect(screen.getByTestId("move-sheet-moves").textContent).not.toContain(
      "PATH",
    );
  });

  it("opens a section to its items", async () => {
    mount({ plans: [FIRST_PLAN], acceptAnswers: [ACCEPTED] });
    await settle();

    fireEvent.click(
      within(screen.getByTestId("move-sheet-moves")).getByRole("button", {
        name: "Show all 2",
      }),
    );
    expect(screen.getByTestId("move-sheet-moves").textContent).toContain(
      "EDITOR",
    );
    expect(screen.getByTestId("move-sheet-moves").textContent).toContain(
      "PAGER",
    );
    expect(screen.getByTestId("move-sheet-moves").textContent).toContain(
      "variable",
    );
  });

  it("sends the plan hash alone when no row's choice was changed", async () => {
    const { accepts } = mount({
      plans: [FIRST_PLAN],
      acceptAnswers: [ACCEPTED],
    });
    await settle();

    fireEvent.click(screen.getByTestId("move-sheet-accept"));
    await settle();

    expect(accepts).toEqual([{ planHash: "hash-1", keyChoices: [] }]);
    // An accepted move closes the sheet.
    expect(useMoveSheetStore.getState().target).toBeNull();
  });

  it("re-reads the plan on plan_changed, says so, and sends the new hash next", async () => {
    const changed = planWith(
      "hash-2",
      { moves: [row("EDITOR", "EDITOR", null)] },
      { personalHoldsSecrets: false, itemChoices: true },
    );
    const { accepts } = mount({
      plans: [
        planWith(
          "hash-1",
          { moves: [row("EDITOR", "EDITOR", null)] },
          { personalHoldsSecrets: false, itemChoices: true },
        ),
        changed,
      ],
      acceptAnswers: [{ outcome: "plan_changed" }, ACCEPTED],
    });
    await settle();
    fireEvent.click(
      within(screen.getByTestId("move-sheet-moves")).getByRole("button", {
        name: "Show all 1",
      }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Leave on this computer only" }),
    );

    fireEvent.click(screen.getByTestId("move-sheet-accept"));
    await settle();

    expect(screen.getByTestId("move-sheet-plan-changed").textContent).toBe(
      "This list changed. Read it again.",
    );
    expect(useMoveSheetStore.getState().target).not.toBeNull();

    fireEvent.click(screen.getByTestId("move-sheet-accept"));
    await settle();

    expect(accepts.map((request) => request.planHash)).toEqual([
      "hash-1",
      "hash-2",
    ]);
    // The re-read dropped the choice made against the list that is gone.
    expect(accepts[1]?.keyChoices).toEqual([]);
  });

  it("closes on Not now and sends nothing", async () => {
    const { accepts } = mount({
      plans: [FIRST_PLAN],
      acceptAnswers: [ACCEPTED],
    });
    await settle();

    fireEvent.click(screen.getByTestId("move-sheet-not-now"));
    await settle();

    expect(useMoveSheetStore.getState().target).toBeNull();
    expect(accepts).toEqual([]);
  });

  it("says nothing moved, and leaves the sheet open, when the host has no move waiting", async () => {
    const { accepts } = mount({
      plans: [FIRST_PLAN],
      acceptAnswers: [{ outcome: "not_awaiting" }],
    });
    await settle();

    fireEvent.click(screen.getByTestId("move-sheet-accept"));
    await settle();

    expect(accepts).toHaveLength(1);
    expect(screen.getByTestId("move-sheet-not-awaiting").textContent).toBe(
      "Old laptop has no move waiting to start, so nothing moved.",
    );
    expect(useMoveSheetStore.getState().target).not.toBeNull();
  });
  it("lists a provider override as <NAME> (<Provider>)", async () => {
    mount({
      plans: [
        plan("hash-o", {
          moves: [
            rowOfKind(
              "claude-code:ANTHROPIC_BASE_URL",
              "env_override",
              "ANTHROPIC_BASE_URL",
            ),
          ],
        }),
      ],
      acceptAnswers: [ACCEPTED],
    });
    await settle();

    const moves = screen.getByTestId("move-sheet-moves");
    fireEvent.click(within(moves).getByRole("button", { name: "Show all 1" }));
    expect(within(moves).getByTestId("move-sheet-moves-row").textContent).toBe(
      "ANTHROPIC_BASE_URL (Claude Code)",
    );
    expect(screen.getByTestId("move-sheet-moves-summary").textContent).toBe(
      "1 Claude Code env setting",
    );
  });

  it("names the other computers in the recipient boundary when a secret moves", async () => {
    const secretPlan = plan("hash-r", {
      moves: [rowOfKind("TOKEN", "secret", "TOKEN")],
    });
    const later =
      "any computer that starts running Personal later receives these keys and secrets as values its tools and agents can read.";
    const disclosure = () =>
      screen.getByTestId("move-sheet-disclosure").textContent;

    mount({ plans: [secretPlan], acceptAnswers: [ACCEPTED] });
    await settle();
    expect(disclosure()).toContain(
      `No other computer runs Personal yet. Any computer that starts running Personal later receives these keys and secrets as values its tools and agents can read.`,
    );
    cleanup();

    mountReaching({ plans: [secretPlan], acceptAnswers: [ACCEPTED] }, [
      { hostId: "a", name: "A" },
      { hostId: "b", name: "B" },
      { hostId: HOST_ID, name: "Old laptop" },
    ]);
    await settle();
    expect(disclosure()).toContain(`Today that is A and B, and ${later}`);
  });

  it("tells a second computer that Personal's existing keys and secrets arrive, when it stores none itself", async () => {
    const arrives =
      "Nothing new is stored as a secret. Once Old laptop runs Personal, it receives Personal's existing keys and secrets as values its tools and agents can read.";
    const accepts =
      "Move accepts this list as shown; if it changes before the upload finishes, you are asked again.";
    const variablePlan = (holds: boolean) =>
      planWith(
        "hash-h",
        { moves: [row("EDITOR", "EDITOR", null)] },
        { personalHoldsSecrets: holds, itemChoices: false },
      );

    mount({ plans: [variablePlan(true)], acceptAnswers: [ACCEPTED] });
    await settle();
    expect(screen.getByTestId("move-sheet-disclosure").textContent).toBe(
      `${arrives} ${accepts}`,
    );
    cleanup();

    mount({ plans: [variablePlan(false)], acceptAnswers: [ACCEPTED] });
    await settle();
    expect(screen.getByTestId("move-sheet-disclosure").textContent).toBe(
      accepts,
    );
  });

  describe("choices on a Moves row (itemChoices)", () => {
    const itemPlan = (itemChoices: boolean) =>
      planWith(
        "hash-i",
        {
          moves: [
            row("EDITOR", "EDITOR", null),
            rowOfKind("OPENAI_API_KEY", "secret", "OPENAI_API_KEY"),
            rowOfKind("fallback", "fallback_policy", "fallback"),
          ],
        },
        { personalHoldsSecrets: false, itemChoices },
      );

    function rowButtons(index: number): string[] {
      const rows = within(
        screen.getByTestId("move-sheet-moves"),
      ).getAllByTestId("move-sheet-moves-row");
      return within(rows[index])
        .queryAllByRole("button")
        .map((button) => button.textContent);
    }

    function openMoves(): void {
      fireEvent.click(
        within(screen.getByTestId("move-sheet-moves")).getByRole("button", {
          name: "Show all 3",
        }),
      );
    }

    it("offers Leave on a variable and a secret, and nothing on a fallback policy", async () => {
      mount({ plans: [itemPlan(true)], acceptAnswers: [ACCEPTED] });
      await settle();
      openMoves();

      expect(rowButtons(0)).toEqual(["Leave on this computer only"]);
      expect(rowButtons(1)).toEqual(["Leave on this computer only"]);
      expect(rowButtons(2)).toEqual([]);
    });

    it("offers no choice on a host that does not honour them, and sends no item entry", async () => {
      const { accepts } = mount({
        plans: [itemPlan(false)],
        acceptAnswers: [ACCEPTED],
      });
      await settle();
      openMoves();

      expect(rowButtons(0)).toEqual([]);
      expect(rowButtons(1)).toEqual([]);
      fireEvent.click(screen.getByTestId("move-sheet-accept"));
      await settle();
      expect(accepts[0]?.keyChoices).toEqual([]);
    });

    it("moves a row left on this computer only under Stays, where its pressed button takes it back", async () => {
      const { accepts } = mount({
        plans: [itemPlan(true)],
        acceptAnswers: [ACCEPTED],
      });
      await settle();
      openMoves();

      fireEvent.click(
        within(
          within(screen.getByTestId("move-sheet-moves")).getAllByTestId(
            "move-sheet-moves-row",
          )[0],
        ).getByRole("button", { name: "Leave on this computer only" }),
      );
      expect(screen.getByTestId("move-sheet-moves").textContent).not.toContain(
        "EDITOR",
      );
      const stays = screen.getByTestId("move-sheet-staysOnThisComputer");
      const left = within(stays).getByTestId("move-sheet-left-here-row");
      expect(left.textContent).toContain("EDITOR");
      const pressed = within(left).getByRole("button", {
        name: "Leave on this computer only",
      });
      expect(pressed.getAttribute("aria-pressed")).toBe("true");

      fireEvent.click(screen.getByTestId("move-sheet-accept"));
      await settle();
      expect(accepts[0]?.keyChoices).toEqual([
        { key: "item:variable:EDITOR", choice: "stays" },
      ]);
    });

    it("sends nothing for a row whose choice was taken back", async () => {
      const { accepts } = mount({
        plans: [itemPlan(true)],
        acceptAnswers: [ACCEPTED],
      });
      await settle();
      openMoves();

      fireEvent.click(
        within(
          within(screen.getByTestId("move-sheet-moves")).getAllByTestId(
            "move-sheet-moves-row",
          )[0],
        ).getByRole("button", { name: "Leave on this computer only" }),
      );
      const stays = screen.getByTestId("move-sheet-staysOnThisComputer");
      fireEvent.click(
        within(stays).getByRole("button", {
          name: "Leave on this computer only",
        }),
      );
      expect(screen.queryByTestId("move-sheet-left-here-row")).toBeNull();
      expect(
        within(screen.getByTestId("move-sheet-moves")).getByRole("button", {
          name: "Show all 3",
        }),
      ).toBeTruthy();
      fireEvent.click(screen.getByTestId("move-sheet-accept"));
      await settle();

      expect(accepts[0]?.keyChoices).toEqual([]);
    });
  });
});
