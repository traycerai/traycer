import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  recordNegotiatedHostMethods,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import type {
  EnvironmentMoveAcceptRequest,
  EnvironmentMoveAcceptResponse,
  EnvironmentMovePlanResponse,
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

type PlanRows = EnvironmentMovePlanResponse["rows"];

function row(key: string, label: string, detail: string | null) {
  return { kind: "variable" as const, key, os: null, label, detail };
}

function plan(
  planHash: string,
  rows: Partial<PlanRows>,
): EnvironmentMovePlanResponse {
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
      ...rows,
    },
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

function mount(options: {
  readonly plans: readonly EnvironmentMovePlanResponse[];
  readonly acceptAnswers: readonly EnvironmentMoveAcceptResponse[];
}): Harness {
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
    expect(moves.textContent).toContain("2 items");
    expect(
      screen.getByTestId("move-sheet-staysOnThisComputer").textContent,
    ).toContain("Stays on this computer");
    expect(
      screen.getByTestId("move-sheet-alreadyInPersonal").textContent,
    ).toContain("Nothing yet.");
    // Differs, masked is drawn only when the plan has any.
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

  it("opens a section to its items", async () => {
    mount({ plans: [FIRST_PLAN], acceptAnswers: [ACCEPTED] });
    await settle();

    fireEvent.click(screen.getByRole("button", { name: "2 items" }));
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
});
