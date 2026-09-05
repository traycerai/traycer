import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { LandingTerminalTabRef } from "@/stores/home/landing-terminal-store";
import { LandingTerminalLegacyBootstrap } from "../landing-terminal-tile";

interface TestReachability {
  readonly status: string;
  readonly hostLabel: string;
  readonly basis: string;
  readonly unavailability: string | null;
}

const testState = vi.hoisted<{ reachability: TestReachability }>(() => ({
  reachability: {
    status: "reachable",
    hostLabel: "Host A",
    basis: "directory",
    unavailability: null,
  },
}));

vi.mock("@/hooks/agent/use-host-reachability", () => ({
  useHostReachability: () => testState.reachability,
  resolvedHostLabel: (r: { status: string; hostLabel: string | null }) =>
    r.status === "checking" ? null : r.hostLabel,
}));

vi.mock("@/hooks/agent/use-terminal-tile-bootstrap", () => ({
  TerminalXtermHost: () => null,
  useTerminalTileBootstrap: () => ({
    handle: null,
    createIsError: false,
    createError: null,
    retry: () => undefined,
    hostHasSession: false,
    hostSessionExited: false,
    reportMeasuredGrid: () => undefined,
  }),
}));

vi.mock(
  "@/components/epic-canvas/renderers/terminal-grid-measure-probe",
  () => ({ TerminalGridMeasureProbe: () => null }),
);

const TAB: LandingTerminalTabRef = {
  instanceId: "inst-landing-term-1",
  sessionId: "landing-term-1",
  hostId: "host-a",
  cwd: "/work/repo",
  name: "shell",
  titleSource: "manual",
};

beforeEach(() => {
  testState.reachability = {
    status: "reachable",
    hostLabel: "Host A",
    basis: "directory",
    unavailability: null,
  };
});

afterEach(cleanup);

/**
 * S5, the landing panel's terminal mirror of the canvas tiles' bounded
 * pre-bootstrap wait. Same wordless-skeleton-for-both-states defect the
 * canvas terminal tiles had (audit S5), fixed the same way, and asserted the
 * same way: on the rendered SENTENCE, never on the absence of a spinner.
 */
describe("<LandingTerminalTile /> S5 bounded pre-bootstrap wait", () => {
  it.each([
    ["checking", "the host"],
    ["host-starting", "Host A"],
  ] as const)(
    "names the host it is waiting on for reachability %s",
    (status, expectedNaming) => {
      testState.reachability = {
        status,
        hostLabel: "Host A",
        basis: "directory",
        unavailability: null,
      };

      // Renders the legacy bootstrap directly rather than the `<LandingTerminalTile>`
      // wrapper: the wrapper's capability switch treats a `null` authorityEntry
      // as neither "legacy" nor "capable" and falls through to the wordless
      // `<LandingTerminalWaiting />`, never reaching this suite's subject.
      // Same pattern as landing-terminal-error-retry.test.tsx.
      render(
        <LandingTerminalLegacyBootstrap
          landingPageId="landing-1"
          tab={TAB}
          active
          createEnabled={false}
          authorityEntry={null}
        />,
      );

      const load = screen.getByTestId("landing-terminal-load");
      expect(load.textContent).toContain(expectedNaming);
      expect(load.textContent).not.toBe("");
    },
  );
});
