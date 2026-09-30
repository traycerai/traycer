import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { StripAgentRow } from "../strip-agent-row";
import type { StripAgent } from "../strip-task-agents";

const NOW = Date.UTC(2026, 8, 30, 12, 0, 0);
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function runningAgent(since: number): StripAgent {
  return {
    id: "a1",
    title: "Runs",
    status: "turn",
    kind: "running",
    since,
  };
}

/** The row's name and, when it has one, its elapsed time: everything after the glyph. */
function shownAfterGlyph(since: number): ReadonlyArray<string | null> {
  render(
    <StripAgentRow
      agent={runningAgent(since)}
      onScreen={false}
      onClick={undefined}
      onHoverChange={undefined}
    />,
  );
  return Array.from(screen.getByTestId("strip-agent-a1").children)
    .slice(1)
    .map((node) => node.textContent);
}

describe("StripAgentRow's elapsed time", () => {
  it.each([
    ["under a minute", 30_000, "<1m"],
    ["minutes", 12 * MINUTE_MS, "12m"],
    ["hours and minutes", 2 * HOUR_MS + 5 * MINUTE_MS, "2h 5m"],
    ["a day, not 24 hours", 24 * HOUR_MS, "1d"],
    ["days, the minutes dropped", 3 * 24 * HOUR_MS + 5 * HOUR_MS, "3d"],
  ])("reads %s as %s", (_name, elapsedMs, expected) => {
    expect(shownAfterGlyph(NOW - elapsedMs)).toEqual(["Runs", expected]);
  });

  it("shows no time when the agent has no start time, not an epoch's worth of hours", () => {
    expect(shownAfterGlyph(0)).toEqual(["Runs"]);
  });
});
