import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
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
  EnvironmentMovePlanResponseV11,
} from "@traycer/protocol/host/environment/move-contracts";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@/lib/host";
import { MoveSheet } from "@/components/settings/move-sheet";
import { buildEnvironmentClient } from "@/lib/environment/__tests__/environment-test-support";
import { useMoveSheetStore } from "@/stores/settings/move-sheet-store";

const HOST_ID = "old";

const clientMock = vi.hoisted(
  (): { current: HostClient<HostRpcRegistry> | null } => ({ current: null }),
);
vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: () => clientMock.current,
}));

// The computers the Environment dropdown reads as running Personal.
const runningPersonalMock = vi.hoisted(
  (): { current: readonly { hostId: string; name: string }[] } => ({
    current: [],
  }),
);
vi.mock(
  "@/components/settings/environment/use-environment-status-model",
  () => ({
    useHostsRunningPersonal: () => runningPersonalMock.current,
  }),
);
vi.mock("@/components/settings/host-scope/use-host-scope", () => ({
  useHostScope: () => null,
}));

type PlanRows = EnvironmentMovePlanResponseV11["rows"];

function row(key: string, label: string, detail: string | null) {
  return { kind: "variable" as const, key, os: null, label, detail };
}

function rowOfKind(key: string, kind: string, label: string) {
  return { kind, key, os: null, label, detail: null };
}

function plan(
  planHash: string,
  rows: Partial<PlanRows>,
): EnvironmentMovePlanResponseV11 {
  return {
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
  readonly plans: readonly EnvironmentMovePlanResponseV11[];
  readonly acceptAnswers: readonly EnvironmentMoveAcceptResponse[];
}

function mount(options: MountOptions): Harness {
  return mountReaching(options, []);
}

function mountReaching(
  options: MountOptions,
  runningPersonal: readonly { hostId: string; name: string }[],
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
  runningPersonalMock.current = runningPersonal;
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
    expect(moves.textContent).toContain("4 items");
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
    fireEvent.click(within(moves).getByRole("button", { name: "1 item" }));
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
      "Your settings then reach every computer and sandbox running Personal, which today is MacBook Pro. Old laptop keeps working either way. Every row opens to its items.",
    );
    expect(await reach(["MacBook Pro", "dev-box"])).toBe(
      "Your settings then reach every computer and sandbox running Personal, which today is MacBook Pro and dev-box. Old laptop keeps working either way. Every row opens to its items.",
    );
    expect(await reach(["MacBook Pro", "dev-box", "build-1"])).toContain(
      "which today is MacBook Pro, dev-box and build-1.",
    );

    cleanup();
    mountReaching({ plans: [FIRST_PLAN], acceptAnswers: [ACCEPTED] }, [
      { hostId: HOST_ID, name: "Old laptop" },
      { hostId: "mac", name: "MacBook Pro" },
    ]);
    await settle();
    expect(screen.getByTestId("move-sheet-description").textContent).toContain(
      "which today is MacBook Pro. Old laptop keeps",
    );
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
    fireEvent.click(within(moves).getByRole("button", { name: "3 items" }));
    expect(moves.textContent).toContain("Browser agent access");
    expect(moves.textContent).toContain("Claude Code: ANTHROPIC_BASE_URL");
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
      `${custody} Today that is MacBook Pro and dev-box, and any computer that joins Personal later. ${accepts}`,
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
      "Traycer's cloud broker stores the value encrypted. The sandboxes running this configuration use the value without seeing it.",
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

    expect(moves().textContent).toContain("2 items");
    openMoves("2 items");
    expect(moves().textContent).toContain("ENV_E2E_API_TOKEN, as a secret");
    expect(moves().textContent).toContain("EDITOR");
    expect(disclosure()).toContain(custody);

    fireEvent.click(
      screen.getByRole("button", { name: "Leave as a variable" }),
    );
    expect(moves().textContent).toContain("2 items");
    expect(moves().textContent).toContain("ENV_E2E_API_TOKEN, as a variable");
    expect(moves().textContent).not.toContain("as a secret");
    expect(disclosure()).not.toContain(custody);

    fireEvent.click(
      screen.getByRole("button", { name: "Leave on this computer only" }),
    );
    expect(moves().textContent).toContain("1 item");
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
    expect(moves.textContent).toContain("1 item");
    fireEvent.click(within(moves).getByRole("button", { name: "1 item" }));
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
    fireEvent.click(within(stays).getByRole("button", { name: "2 items" }));
    const text = stays.textContent;
    expect(text).toContain(detail);
    expect(text.split("github").length - 1).toBe(
      detail.split("github").length - 1,
    );
    expect(text).not.toContain("github · ");
    expect(text).not.toContain("github: ");
    expect(text).toContain("SSH sign-in");
  });

  it("opens a section to its items", async () => {
    mount({ plans: [FIRST_PLAN], acceptAnswers: [ACCEPTED] });
    await settle();

    fireEvent.click(
      within(screen.getByTestId("move-sheet-moves")).getByRole("button", {
        name: "4 items",
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
});
