import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
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
      looksLikeAKey: [],
      sameNameInPersonal: [],
      ...rows,
    },
    guideDiffers: false,
  };
}

const FIRST_PLAN = plan("hash-1", {
  moves: [row("EDITOR", "EDITOR", "variable"), row("PAGER", "PAGER", null)],
  staysOnThisComputer: [row("SSH", "SSH sign-in", "terminal")],
  looksLikeAKey: [
    row("OPENAI_API_KEY", "OPENAI_API_KEY", null),
    row("TOKEN_X", "TOKEN_X", null),
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
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
}

beforeEach(() => {
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
  it("draws the plan's rows: Moves, Stays, Already in Personal (empty), Looks like a key", async () => {
    mount({ plans: [FIRST_PLAN], acceptAnswers: [ACCEPTED] });
    await settle();

    expect(
      screen.getByText("Move Old laptop's settings to Personal"),
    ).toBeTruthy();
    const moves = screen.getByTestId("move-sheet-moves");
    expect(moves.textContent).toContain("Moves");
    expect(screen.getByTestId("move-sheet-moves-summary").textContent).toBe(
      "2 variables · 2 secrets",
    );
    expect(
      within(moves).getByRole("button", { name: "Show all 4" }),
    ).toBeTruthy();
    expect(
      screen.getByTestId("move-sheet-staysOnThisComputer").textContent,
    ).toContain("Stays on this computer");
    expect(
      screen.getByTestId("move-sheet-alreadyInPersonal").textContent,
    ).toContain("Nothing yet.");
    // Different from Personal is drawn only when the plan has any.
    expect(screen.queryByTestId("move-sheet-differsMasked")).toBeNull();
    expect(screen.getAllByTestId("move-sheet-key-row")).toHaveLength(2);
    expect(
      screen.getAllByRole("button", { name: "Leave as a variable" }),
    ).toHaveLength(2);
    expect(
      screen.getAllByRole("button", { name: "Leave on this computer only" }),
    ).toHaveLength(2);
    expect(screen.getByTestId("move-sheet-disclosure").textContent).toContain(
      "Stored encrypted in Traycer's cloud.",
    );
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

  it("draws Already in Personal, Same name in Personal, then Different from Personal, the same-name rows as label: detail", async () => {
    const detail =
      "Personal already has a secret with this name. MacBook's value is not uploaded and stays on MacBook; Personal's is kept for every other computer and sandbox. Secret values are never read back, so they can't be compared. To use MacBook's everywhere, Replace it on Secrets.";
    mount({
      plans: [
        plan("hash-s", {
          alreadyInPersonal: [row("HOME", "HOME", null)],
          sameNameInPersonal: [row("OPENAI_API_KEY", "OPENAI_API_KEY", detail)],
          differsMasked: [row("PAGER", "PAGER", "value differs")],
        }),
      ],
      acceptAnswers: [ACCEPTED],
    });
    await settle();

    const already = screen.getByTestId("move-sheet-alreadyInPersonal");
    const sameName = screen.getByTestId("move-sheet-sameNameInPersonal");
    const differs = screen.getByTestId("move-sheet-differsMasked");
    expect(already.textContent).toContain("Already in Personal");
    expect(sameName.textContent).toContain("Same name in Personal");
    expect(
      already.compareDocumentPosition(sameName) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      sameName.compareDocumentPosition(differs) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    fireEvent.click(within(sameName).getByRole("button", { name: "1 item" }));
    expect(sameName.textContent).toContain(`OPENAI_API_KEY: ${detail}`);
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

  it("leaves out Same name in Personal while it has no rows", async () => {
    mount({ plans: [FIRST_PLAN], acceptAnswers: [ACCEPTED] });
    await settle();

    expect(screen.queryByTestId("move-sheet-sameNameInPersonal")).toBeNull();
    expect(screen.queryByText("Same name in Personal")).toBeNull();
  });

  it("names the computers the moved settings reach, leaving out the target", async () => {
    const reach = async (names: readonly string[]): Promise<string | null> => {
      cleanup();
      useMoveSheetStore.setState({ target: null });
      mountReaching(
        { plans: [FIRST_PLAN], acceptAnswers: [ACCEPTED] },
        names.map((name) => ({ hostId: `id-${name}`, name })),
      );
      await settle();
      return screen.getByTestId("move-sheet-description").textContent;
    };

    expect(await reach([])).toBe(
      "Your settings then reach every computer and sandbox running Personal. After the move, that is Old laptop only. Old laptop keeps working either way. Every row opens to its items.",
    );
    expect(await reach(["MacBook Pro"])).toBe(
      "Your settings then reach every computer and sandbox running Personal, which today is MacBook Pro and Old laptop. Old laptop keeps working either way. Every row opens to its items.",
    );
    expect(await reach(["MacBook Pro", "dev-box"])).toBe(
      "Your settings then reach every computer and sandbox running Personal, which today is MacBook Pro, dev-box and Old laptop. Old laptop keeps working either way. Every row opens to its items.",
    );
    expect(await reach(["MacBook Pro", "dev-box", "build-1"])).toContain(
      "which today is MacBook Pro, dev-box and 1 more, and Old laptop. Old laptop keeps",
    );

    cleanup();
    mountReaching({ plans: [FIRST_PLAN], acceptAnswers: [ACCEPTED] }, [
      { hostId: HOST_ID, name: "Old laptop" },
      { hostId: "mac", name: "MacBook Pro" },
    ]);
    await settle();
    expect(screen.getByTestId("move-sheet-description").textContent).toContain(
      "which today is MacBook Pro and Old laptop. Old laptop keeps",
    );
  });

  it("names nobody and holds Move to Personal while the computers running Personal are unread", async () => {
    mountWithRunning(
      { plans: [FIRST_PLAN], acceptAnswers: [ACCEPTED] },
      {
        hosts: [],
        state: "loading",
        collisions: [],
        retry: () => undefined,
        reread: () => undefined,
      },
    );
    await settle();

    expect(screen.getByTestId("move-sheet-description").textContent).toBe(
      "Old laptop keeps working either way. Every row opens to its items.",
    );
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

    expect(screen.getByTestId("move-sheet-description").textContent).toBe(
      "Nothing on Old laptop needs moving.",
    );
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
    cleanup();

    mount({
      plans: [
        plan("hash-k", {
          looksLikeAKey: [row("OPENAI_API_KEY", "OPENAI_API_KEY", null)],
        }),
      ],
      acceptAnswers: [ACCEPTED],
    });
    await settle();
    expect(disclosure()).toContain(custody);
    fireEvent.click(
      screen.getByRole("button", { name: "Leave as a variable" }),
    );
    expect(disclosure()).toBe(accepts);
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

  it("lists a key row in Moves by how it moves, following its choice, and drops it only when it stays", async () => {
    const custody = "Stored encrypted in Traycer's cloud.";
    mount({
      plans: [
        plan("hash-m", {
          moves: [row("EDITOR", "EDITOR", null)],
          looksLikeAKey: [row("ENV_E2E_API_TOKEN", "ENV_E2E_API_TOKEN", null)],
        }),
      ],
      acceptAnswers: [ACCEPTED],
    });
    await settle();

    const moves = () => screen.getByTestId("move-sheet-moves");
    const openMoves = (count: string) =>
      fireEvent.click(within(moves()).getByRole("button", { name: count }));
    const disclosure = () =>
      screen.getByTestId("move-sheet-disclosure").textContent;

    expect(screen.getByTestId("move-sheet-moves-summary").textContent).toBe(
      "1 variable · 1 secret",
    );
    openMoves("Show all 2");
    expect(moves().textContent).toContain("ENV_E2E_API_TOKEN, as a secret");
    expect(moves().textContent).toContain("EDITOR");
    expect(disclosure()).toContain(custody);

    fireEvent.click(
      screen.getByRole("button", { name: "Leave as a variable" }),
    );
    expect(screen.getByTestId("move-sheet-moves-summary").textContent).toBe(
      "2 variables",
    );
    expect(moves().textContent).toContain("ENV_E2E_API_TOKEN, as a variable");
    expect(moves().textContent).not.toContain("as a secret");
    expect(disclosure()).not.toContain(custody);

    fireEvent.click(
      screen.getByRole("button", { name: "Leave on this computer only" }),
    );
    expect(screen.getByTestId("move-sheet-moves-summary").textContent).toBe(
      "1 variable",
    );
    expect(moves().textContent).not.toContain("ENV_E2E_API_TOKEN");
    expect(screen.getByTestId("move-sheet-key-row")).toBeTruthy();
    expect(disclosure()).not.toContain(custody);
  });

  it("keeps Moves for a lone key row left as a variable, and drops it when the row stays", async () => {
    mount({
      plans: [
        plan("hash-k2", {
          looksLikeAKey: [row("ENV_E2E_API_TOKEN", "ENV_E2E_API_TOKEN", null)],
        }),
      ],
      acceptAnswers: [ACCEPTED],
    });
    await settle();

    fireEvent.click(
      screen.getByRole("button", { name: "Leave as a variable" }),
    );
    const moves = screen.getByTestId("move-sheet-moves");
    expect(screen.getByTestId("move-sheet-moves-summary").textContent).toBe(
      "1 variable",
    );
    fireEvent.click(within(moves).getByRole("button", { name: "Show all 1" }));
    expect(moves.textContent).toContain("ENV_E2E_API_TOKEN, as a variable");

    fireEvent.click(
      screen.getByRole("button", { name: "Leave on this computer only" }),
    );
    expect(screen.queryByTestId("move-sheet-moves")).toBeNull();
    expect(screen.getByTestId("move-sheet-key-row")).toBeTruthy();
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
        name: "Show all 4",
      }),
    );
    expect(screen.getByTestId("move-sheet-moves").textContent).toContain(
      "OPENAI_API_KEY, as a secret",
    );
    expect(screen.getByTestId("move-sheet-moves").textContent).toContain(
      "EDITOR",
    );
    expect(screen.getByTestId("move-sheet-moves").textContent).toContain(
      "variable",
    );
  });

  it("sends the plan hash with a secret choice per key row, changed by the row's buttons", async () => {
    const { accepts } = mount({
      plans: [FIRST_PLAN],
      acceptAnswers: [ACCEPTED],
    });
    await settle();

    const [firstKey, secondKey] = screen.getAllByTestId("move-sheet-key-row");
    fireEvent.click(
      firstKey.querySelector<HTMLButtonElement>("button:nth-of-type(1)") ??
        firstKey,
    );
    fireEvent.click(
      secondKey.querySelector<HTMLButtonElement>("button:nth-of-type(2)") ??
        secondKey,
    );
    fireEvent.click(screen.getByTestId("move-sheet-accept"));
    await settle();

    expect(accepts).toEqual([
      {
        planHash: "hash-1",
        keyChoices: [
          { key: "OPENAI_API_KEY", choice: "variable" },
          { key: "TOKEN_X", choice: "stays" },
        ],
      },
    ]);
    // An accepted move closes the sheet.
    expect(useMoveSheetStore.getState().target).toBeNull();
  });

  it("sends secret for every key row the person left alone", async () => {
    const { accepts } = mount({
      plans: [FIRST_PLAN],
      acceptAnswers: [ACCEPTED],
    });
    await settle();

    fireEvent.click(screen.getByTestId("move-sheet-accept"));
    await settle();

    expect(accepts[0]?.keyChoices).toEqual([
      { key: "OPENAI_API_KEY", choice: "secret" },
      { key: "TOKEN_X", choice: "secret" },
    ]);
  });

  it("keeps an invalid held key local by default and when its variable choice is toggled back", async () => {
    const heldKeyPlan = plan("hash-held-key", {
      looksLikeAKey: [row("api_key", "api_key", null)],
    });
    const variableChoice = mount({
      plans: [heldKeyPlan],
      acceptAnswers: [ACCEPTED],
    });
    const initialRow = await screen.findByTestId("move-sheet-key-row");
    expect(screen.queryByTestId("move-sheet-moves")).toBeNull();
    expect(initialRow.textContent).not.toContain("would become a secret");
    expect(
      within(initialRow)
        .getByRole("button", {
          name: "Leave on this computer only",
        })
        .getAttribute("aria-pressed"),
    ).toBe("true");

    fireEvent.click(
      within(initialRow).getByRole("button", { name: "Leave as a variable" }),
    );
    expect(
      within(initialRow)
        .getByRole("button", {
          name: "Leave as a variable",
        })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    fireEvent.click(screen.getByTestId("move-sheet-accept"));
    await waitFor(() => {
      expect(variableChoice.accepts[0]?.keyChoices).toEqual([
        { key: "api_key", choice: "variable" },
      ]);
      expect(useMoveSheetStore.getState().target).toBeNull();
    });

    cleanup();
    useMoveSheetStore.setState({ target: null });

    const toggledBack = mount({
      plans: [heldKeyPlan],
      acceptAnswers: [ACCEPTED],
    });
    const toggledRow = await screen.findByTestId("move-sheet-key-row");
    const variableButton = within(toggledRow).getByRole("button", {
      name: "Leave as a variable",
    });
    fireEvent.click(variableButton);
    expect(variableButton.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(variableButton);

    expect(variableButton.getAttribute("aria-pressed")).toBe("false");
    expect(
      within(toggledRow)
        .getByRole("button", {
          name: "Leave on this computer only",
        })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    expect(screen.queryByTestId("move-sheet-moves")).toBeNull();

    fireEvent.click(screen.getByTestId("move-sheet-accept"));
    await waitFor(() => {
      expect(toggledBack.accepts[0]?.keyChoices).toEqual([
        { key: "api_key", choice: "stays" },
      ]);
      expect(useMoveSheetStore.getState().target).toBeNull();
    });
  });

  it("re-reads the plan on plan_changed, says so, and sends the new hash next", async () => {
    const changed = plan("hash-2", {
      moves: [row("EDITOR", "EDITOR", null)],
      looksLikeAKey: [row("OPENAI_API_KEY", "OPENAI_API_KEY", null)],
    });
    const { accepts } = mount({
      plans: [FIRST_PLAN, changed],
      acceptAnswers: [{ outcome: "plan_changed" }, ACCEPTED],
    });
    await settle();
    fireEvent.click(
      screen.getAllByRole("button", { name: "Leave as a variable" })[0],
    );

    fireEvent.click(screen.getByTestId("move-sheet-accept"));
    await settle();

    expect(screen.getByTestId("move-sheet-plan-changed").textContent).toBe(
      "This list changed. Read it again.",
    );
    expect(screen.getAllByTestId("move-sheet-key-row")).toHaveLength(1);
    expect(useMoveSheetStore.getState().target).not.toBeNull();

    fireEvent.click(screen.getByTestId("move-sheet-accept"));
    await settle();

    expect(accepts.map((request) => request.planHash)).toEqual([
      "hash-1",
      "hash-2",
    ]);
    // The first answer was for a list that no longer exists.
    expect(accepts[1]?.keyChoices).toEqual([
      { key: "OPENAI_API_KEY", choice: "secret" },
    ]);
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
  it("lists a Looks-like-a-key override as <NAME> (<Provider>), as a secret, then as a variable", async () => {
    mount({
      plans: [
        plan("hash-o", {
          looksLikeAKey: [
            rowOfKind(
              "claude-code:ANTHROPIC_AUTH_TOKEN",
              "env_override",
              "ANTHROPIC_AUTH_TOKEN",
            ),
          ],
        }),
      ],
      acceptAnswers: [ACCEPTED],
    });
    await settle();

    const moves = screen.getByTestId("move-sheet-moves");
    fireEvent.click(within(moves).getByRole("button", { name: "Show all 1" }));
    const text = () =>
      within(moves).getByTestId("move-sheet-moves-row").textContent;
    expect(text()).toBe("ANTHROPIC_AUTH_TOKEN (Claude Code), as a secret");

    fireEvent.click(
      screen.getByRole("button", { name: "Leave as a variable" }),
    );
    expect(text()).toBe("ANTHROPIC_AUTH_TOKEN (Claude Code), as a variable");
    expect(screen.getByTestId("move-sheet-moves-summary").textContent).toBe(
      "1 Claude Code env setting",
    );
  });

  it("moves a key row left on this computer only from Moves to Stays", async () => {
    mount({
      plans: [
        plan("hash-ks", {
          moves: [row("EDITOR", "EDITOR", null)],
          looksLikeAKey: [row("TOKEN_X", "TOKEN_X", null)],
        }),
      ],
      acceptAnswers: [ACCEPTED],
    });
    await settle();
    expect(
      within(screen.getByTestId("move-sheet-moves")).getByRole("button", {
        name: "Show all 2",
      }),
    ).toBeTruthy();

    fireEvent.click(
      screen.getByRole("button", { name: "Leave on this computer only" }),
    );

    const moves = screen.getByTestId("move-sheet-moves");
    fireEvent.click(within(moves).getByRole("button", { name: "Show all 1" }));
    expect(moves.textContent).not.toContain("TOKEN_X");
    const stays = screen.getByTestId("move-sheet-staysOnThisComputer");
    expect(stays.textContent).toContain("TOKEN_X");
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
          looksLikeAKey: [row("TOKEN_X", "TOKEN_X", null)],
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
          name: "Show all 4",
        }),
      );
    }

    it("offers a variable both choices, a provider key only Leave, and a fallback policy neither", async () => {
      mount({ plans: [itemPlan(true)], acceptAnswers: [ACCEPTED] });
      await settle();
      openMoves();

      expect(rowButtons(0)).toEqual([
        "Mark as a secret",
        "Leave on this computer only",
      ]);
      expect(rowButtons(1)).toEqual(["Leave on this computer only"]);
      expect(rowButtons(2)).toEqual([]);
    });

    it("offers secret storage only for names the secret intake accepts", async () => {
      const overlongName = `A${"B".repeat(128)}`;
      const { accepts } = mount({
        plans: [
          planWith(
            "hash-secret-names",
            {
              moves: [
                row("region", "region", null),
                row("_PRIVATE", "_PRIVATE", null),
                row(overlongName, overlongName, null),
                rowOfKind(
                  "claude-code:region",
                  "env_override",
                  "Claude Code override",
                ),
                row("GITHUB_TOKEN", "GITHUB_TOKEN", null),
              ],
            },
            { personalHoldsSecrets: false, itemChoices: true },
          ),
        ],
        acceptAnswers: [ACCEPTED],
      });
      const showAll = await screen.findByRole("button", {
        name: "Show all 5",
      });
      fireEvent.click(showAll);

      const rows = await within(
        screen.getByTestId("move-sheet-moves"),
      ).findAllByTestId("move-sheet-moves-row");
      expect(rows).toHaveLength(5);
      for (const index of [0, 1, 2, 3]) {
        expect(
          within(rows[index]).queryByRole("button", {
            name: "Mark as a secret",
          }),
        ).toBeNull();
        expect(
          within(rows[index]).getByRole("button", {
            name: "Leave on this computer only",
          }),
        ).toBeTruthy();
      }
      expect(
        within(rows[4]).getByRole("button", {
          name: "Mark as a secret",
        }),
      ).toBeTruthy();

      fireEvent.click(
        within(rows[4]).getByRole("button", {
          name: "Leave on this computer only",
        }),
      );
      fireEvent.click(screen.getByTestId("move-sheet-accept"));
      await waitFor(() =>
        expect(accepts[0]?.keyChoices).toEqual([
          { key: "item:variable:GITHUB_TOKEN", choice: "stays" },
        ]),
      );
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
      expect(accepts[0]?.keyChoices).toEqual([
        { key: "TOKEN_X", choice: "secret" },
      ]);
    });

    it("lists a row marked as a secret by that name, counts it, and sends it under item:<kind>:<key> beside the key rows", async () => {
      const { accepts } = mount({
        plans: [itemPlan(true)],
        acceptAnswers: [ACCEPTED],
      });
      await settle();
      openMoves();

      fireEvent.click(screen.getByRole("button", { name: "Mark as a secret" }));
      expect(
        within(screen.getByTestId("move-sheet-moves")).getAllByTestId(
          "move-sheet-moves-row",
        )[0].textContent,
      ).toContain("EDITOR, as a secret");
      expect(screen.getByTestId("move-sheet-moves-summary").textContent).toBe(
        "2 secrets · 1 API key · Model routing",
      );
      fireEvent.click(screen.getByTestId("move-sheet-accept"));
      await settle();

      expect(accepts[0]?.keyChoices).toEqual([
        { key: "TOKEN_X", choice: "secret" },
        { key: "item:variable:EDITOR", choice: "secret" },
      ]);
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
        { key: "TOKEN_X", choice: "secret" },
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
          name: "Show all 4",
        }),
      ).toBeTruthy();
      fireEvent.click(screen.getByTestId("move-sheet-accept"));
      await settle();

      expect(accepts[0]?.keyChoices).toEqual([
        { key: "TOKEN_X", choice: "secret" },
      ]);
    });
  });
});
