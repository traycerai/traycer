import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CommandSegment } from "@/components/chat/segments/command-segment";

// 40s now - 3s start = a stable floored "37s".
const NOW = 40_000;
const STARTED_AT = 3_000;

function renderRow(overrides: {
  readonly isStreaming: boolean;
  readonly exitCode: number | null;
  readonly progress: string | null;
}) {
  return render(
    <CommandSegment
      command="git status --short"
      cwd={null}
      exitCode={overrides.exitCode}
      isStreaming={overrides.isStreaming}
      endState={null}
      stopped={false}
      progress={overrides.progress}
      startedAt={STARTED_AT}
      variant="row"
      headerFindUnitId={null}
      initiallyOpen={false}
    />,
  );
}

describe("<CommandSegment /> elapsed placement", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  // The counter used to live in the streaming footer, pinned to the right of a
  // second line under the header. A command reports no progress, so that line
  // held nothing but the number - one activity rendered as two rows, with the
  // duration detached from the command it belonged to.
  it("keeps the running counter on the header row, not a line of its own", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    renderRow({ isStreaming: true, exitCode: null, progress: null });

    const trigger = screen.getByRole("button", { name: /git status --short/ });
    const elapsed = screen.getAllByText("37s");

    // EVERY occurrence is inside the header trigger. This is the assertion that
    // fails when the counter moves back to the footer, which sits outside it.
    expect(elapsed).toHaveLength(1);
    expect(elapsed[0].closest("button")).toBe(trigger);
  });

  // Elapsed, then the pulse - the order `GenericToolHeader` and the subagent
  // rows already use, so a group of mixed rows lines up down its right edge.
  it("puts the counter to the left of the live pulse", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    renderRow({ isStreaming: true, exitCode: null, progress: null });

    const elapsed = screen.getByText("37s");
    const pulse = screen.getByLabelText("Command running");
    // Node.DOCUMENT_POSITION_FOLLOWING === 4: the pulse comes after the counter.
    expect(elapsed.compareDocumentPosition(pulse) & 4).toBe(4);
  });

  // Ephemeral chrome the find projection never indexes - it indexes the command.
  // Inside the anchor without this, a query on the digits paints a highlight in
  // a unit that counted no match.
  it("excludes the counter from find highlighting", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    renderRow({ isStreaming: true, exitCode: null, progress: null });

    expect(screen.getByText("37s").closest("[data-find-skip]")).not.toBeNull();
    expect(
      screen.getByText("git status --short").closest("[data-find-skip]"),
    ).toBeNull();
  });

  // Unchanged, not newly dropped: the counter only ever existed while the
  // command ran. A density call for a list of finished rows - NOT a deferral to
  // the group header, whose summary counts commands and files and carries a
  // duration for thinking alone.
  it("shows no counter once the command has exited", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    renderRow({ isStreaming: false, exitCode: 0, progress: null });

    expect(screen.queryByText("37s")).toBeNull();
    expect(screen.queryByLabelText("Command running")).toBeNull();
    expect(screen.getByText("exit 0")).toBeTruthy();
  });
});
