import { act, cleanup, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  HOME_STATUS_STALE_MS,
  type HomeStatusRow,
} from "@traycer/protocol/notifications/home-status-room";
import { HomeStatusTable } from "@/components/home-focus/home-status-table";
import {
  DEFAULT_HOME_STATUS_THRESHOLDS,
  resolveHomeStatusThresholds,
  type HomeStatusThresholds,
} from "@/lib/home-focus/home-status-thresholds";
import {
  __resetAgentActivityStoreForTests,
  __setAgentActivityPlaneAnsweringForTests,
  __setAgentActivityStateForTests,
} from "@/stores/agent-activity-store";

const NOW = Date.now();

function row(overrides: Partial<HomeStatusRow>): HomeStatusRow {
  return {
    key: "row",
    status: "in-progress",
    item: "Item",
    note: "",
    agentId: "agent-1",
    agentName: "Opus impl",
    epicId: "epic-1",
    hostId: "host-1",
    harnessId: null,
    updatedAt: NOW,
    ...overrides,
  };
}

function renderTable(rows: ReadonlyArray<HomeStatusRow>) {
  return renderTableWith(rows, DEFAULT_HOME_STATUS_THRESHOLDS);
}

function renderTableWith(
  rows: ReadonlyArray<HomeStatusRow>,
  thresholds: HomeStatusThresholds,
) {
  const onDismiss = vi.fn();
  const onOpenAgent = vi.fn();
  const view = render(
    // The note's links open through `useOpenLink`, which is a mutation.
    <QueryClientProvider client={new QueryClient()}>
      <HomeStatusTable
        rows={rows}
        now={NOW}
        thresholds={thresholds}
        onDismiss={onDismiss}
        onOpenAgent={onOpenAgent}
      />
    </QueryClientProvider>,
  );
  return { ...view, onDismiss, onOpenAgent };
}

function renderedRows(): HTMLElement[] {
  return screen.getAllByTestId("home-status-row");
}

function rowAt(index: number): HTMLElement {
  const found = renderedRows().at(index);
  if (found === undefined) throw new Error(`no row at ${String(index)}`);
  return found;
}

beforeEach(() => {
  __resetAgentActivityStoreForTests();
});

afterEach(() => {
  cleanup();
});

describe("HomeStatusTable", () => {
  it("renders nothing for an empty board", () => {
    renderTable([]);
    expect(screen.queryByTestId("home-status-table")).toBeNull();
  });

  it("renders rows in the order given, with status, item, note and agent", () => {
    renderTable([
      row({ key: "a", status: "needs-you", item: "Pricing realign" }),
      row({ key: "b", status: "in-progress", item: "Host restart fix" }),
      row({ key: "c", status: "done", item: "Port-forward drain" }),
    ]);
    expect(renderedRows().map((tr) => tr.dataset["rowKey"])).toEqual([
      "a",
      "b",
      "c",
    ]);
    expect(
      screen.getAllByTestId("home-status-item").map((td) => td.textContent),
    ).toEqual(["Pricing realign", "Host restart fix", "Port-forward drain"]);
    expect(
      screen.getAllByTestId("home-status-chip").map((chip) => chip.textContent),
    ).toEqual(["Needs you", "In progress", "Done"]);
    expect(
      screen.getByRole("columnheader", { name: "Last update" }),
    ).toBeTruthy();
  });

  it("summarises the counts per status, omitting empty ones", () => {
    renderTable([
      row({ key: "a", status: "needs-you" }),
      row({ key: "b", status: "needs-you" }),
      row({ key: "c", status: "done" }),
    ]);
    expect(screen.getByTestId("home-status-summary").textContent).toBe(
      "2 need you·1 done",
    );
  });

  it("agrees the verb with a single row waiting on the user", () => {
    renderTable([
      row({ key: "a", status: "needs-you" }),
      row({ key: "b", status: "in-progress" }),
    ]);
    expect(screen.getByTestId("home-status-summary").textContent).toBe(
      "1 needs you·1 in progress",
    );
  });

  // Layout is asserted by class: jsdom does no table layout, so this pins the
  // sizing contract the render relies on rather than a measured width.
  it("gives the note the slack and sizes the item to its own text", () => {
    renderTable([row({ key: "a", item: "Port-forward drain" })]);
    const note = screen.getByTestId("home-status-note");
    expect(note.classList.contains("w-full")).toBe(true);
    expect(
      screen
        .getByRole("columnheader", { name: "Note" })
        .classList.contains("w-full"),
    ).toBe(true);
    const itemText = screen.getByText("Port-forward drain");
    expect(itemText.classList.contains("w-max")).toBe(true);
    expect(itemText.classList.contains("max-w-56")).toBe(true);
  });

  it("renders the note as markdown with a clickable link", () => {
    renderTable([
      row({
        key: "a",
        note: "Fixing **two** threads on [#5938](https://github.com/traycerai/traycer/pull/5938)",
      }),
    ]);
    const note = screen.getByTestId("home-status-note");
    expect(
      within(note).getByRole("link", { name: "#5938" }).getAttribute("href"),
    ).toBe("https://github.com/traycerai/traycer/pull/5938");
    expect(note.querySelector("strong")?.textContent).toBe("two");
  });

  it("strips script from a note rather than rendering it", () => {
    renderTable([
      row({ key: "a", note: "hi <script>window.pwned = true</script>" }),
    ]);
    const note = screen.getByTestId("home-status-note");
    expect(note.querySelector("script")).toBeNull();
  });

  it("dims a stale in-progress row and says so; needs-you never goes stale", () => {
    const old = NOW - HOME_STATUS_STALE_MS - 1;
    renderTable([
      row({ key: "needs", status: "needs-you", updatedAt: old }),
      row({ key: "stale", status: "in-progress", updatedAt: old }),
      row({ key: "fresh", status: "in-progress" }),
    ]);
    const needs = rowAt(0);
    const stale = rowAt(1);
    const fresh = rowAt(2);
    expect(needs.dataset["stale"]).toBeUndefined();
    expect(within(needs).queryByTestId("home-status-stale")).toBeNull();
    expect(stale.dataset["stale"]).toBe("true");
    expect(stale.classList.contains("opacity-60")).toBe(true);
    expect(within(stale).getByTestId("home-status-stale").textContent).toBe(
      "stale",
    );
    expect(fresh.dataset["stale"]).toBeUndefined();
    expect(fresh.classList.contains("opacity-60")).toBe(false);
  });

  it("uses the configured in-progress threshold: 1 h makes a 90-minute-old row stale", () => {
    const ninetyMinutesAgo = NOW - 90 * 60 * 1000;
    renderTableWith(
      [row({ key: "a", status: "in-progress", updatedAt: ninetyMinutesAgo })],
      resolveHomeStatusThresholds("1h", "never", "24h"),
    );
    expect(rowAt(0).dataset["stale"]).toBe("true");
    cleanup();

    renderTable([
      row({ key: "a", status: "in-progress", updatedAt: ninetyMinutesAgo }),
    ]);
    expect(rowAt(0).dataset["stale"]).toBeUndefined();
  });

  it("marks nothing stale when both thresholds are Never", () => {
    const weekOld = NOW - 6 * 24 * 60 * 60 * 1000;
    renderTableWith(
      [
        row({ key: "a", status: "in-progress", updatedAt: weekOld }),
        row({ key: "b", status: "needs-you", updatedAt: weekOld }),
      ],
      resolveHomeStatusThresholds("never", "never", "24h"),
    );
    expect(screen.queryByTestId("home-status-stale")).toBeNull();
    expect(
      renderedRows().filter((tr) => tr.dataset["stale"] === "true"),
    ).toEqual([]);
  });

  it("dims a needs-you row past its own configured threshold", () => {
    renderTableWith(
      [
        row({
          key: "a",
          status: "needs-you",
          updatedAt: NOW - 90 * 60 * 1000,
        }),
      ],
      resolveHomeStatusThresholds("2h", "1h", "24h"),
    );
    expect(rowAt(0).dataset["stale"]).toBe("true");
    expect(within(rowAt(0)).getByTestId("home-status-stale").textContent).toBe(
      "stale",
    );
  });

  it("opens the writing agent's chat on its own host", async () => {
    const user = userEvent.setup();
    const { onOpenAgent } = renderTable([
      row({
        key: "a",
        epicId: "epic-9",
        agentId: "agent-9",
        hostId: "host-remote",
        agentName: "Fable impl",
      }),
    ]);
    await user.click(screen.getByRole("button", { name: "Fable impl" }));
    expect(onOpenAgent).toHaveBeenCalledWith(
      "epic-9",
      "agent-9",
      "host-remote",
    );
  });

  it("caps and truncates a long agent name, keeping the whole name reachable", async () => {
    const user = userEvent.setup();
    renderTable([row({ key: "a", agentName: "Update Home Status Board" })]);
    const chip = screen.getByTestId("home-status-agent");
    expect(chip.classList.contains("max-w-48")).toBe(true);
    const name = screen.getByTestId("home-status-agent-name");
    expect(name.classList.contains("truncate")).toBe(true);
    expect(name.textContent).toBe("Update Home Status Board");

    await user.hover(chip);
    expect((await screen.findByRole("tooltip")).textContent).toContain(
      "Update Home Status Board",
    );
  });

  it("draws the writing agent's harness icon before its name", () => {
    renderTable([row({ key: "a", harnessId: "codex", agentName: "Fable" })]);
    const chip = screen.getByTestId("home-status-agent");
    const icon = within(chip).getByTestId("home-status-agent-harness");
    expect(icon.dataset["harnessId"]).toBe("codex");
    expect(icon.querySelector("svg")).not.toBeNull();
    // Leading, and outside the accessible name.
    expect(chip.firstElementChild).toBe(icon);
    expect(screen.getByRole("button", { name: "Fable" })).toBe(chip);
  });

  it("draws no icon for a row with no harness or one this build doesn't know", () => {
    renderTable([
      row({ key: "a", harnessId: null }),
      row({ key: "b", harnessId: "not-a-harness" }),
    ]);
    expect(screen.queryByTestId("home-status-agent-harness")).toBeNull();
  });

  it("falls back to a generic name when the agent has none", () => {
    renderTable([row({ key: "a", agentName: "  " })]);
    expect(screen.getByTestId("home-status-agent").textContent).toBe("Agent");
  });

  it("marks the agent live only while it is mid-turn", () => {
    renderTable([
      row({ key: "a", epicId: "epic-1", agentId: "agent-turn" }),
      row({ key: "b", epicId: "epic-1", agentId: "agent-bg" }),
    ]);
    expect(screen.queryByTestId("home-status-agent-live")).toBeNull();

    act(() => {
      __setAgentActivityPlaneAnsweringForTests();
      __setAgentActivityStateForTests(
        {
          "epic-1": {
            working: ["agent-turn", "agent-bg"],
            turn: ["agent-turn"],
          },
        },
        "local",
        "connected",
      );
    });

    const turnRow = rowAt(0);
    const bgRow = rowAt(1);
    expect(within(turnRow).queryByTestId("home-status-agent-live")).not.toBe(
      null,
    );
    expect(within(bgRow).queryByTestId("home-status-agent-live")).toBeNull();
  });

  it("dismisses a row by its key", async () => {
    const user = userEvent.setup();
    const { onDismiss } = renderTable([
      row({ key: "a", item: "Pricing realign" }),
    ]);
    await user.click(
      screen.getByRole("button", { name: "Dismiss Pricing realign" }),
    );
    expect(onDismiss).toHaveBeenCalledWith("a");
  });
});
