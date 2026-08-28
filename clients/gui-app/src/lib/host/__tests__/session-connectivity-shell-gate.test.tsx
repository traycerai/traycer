/**
 * Which shells announce an interrupted session, and what the strip does across
 * one interruption on a shell that does.
 *
 * The gate used to key on the mobile PRODUCT flag, which coincided with the
 * honest key - no local host, so every reachable host is another machine and
 * the transport crosses a relay - for exactly as long as the phone was the
 * only shell without one. A browser tab has the phone's capabilities and the
 * desktop's product flag, so the coincidence breaks there: a frozen or
 * discarded tab is precisely the case where a session stops carrying frames
 * with nothing on screen to say so.
 *
 * Every surface is asserted separately, and the expected answers are written
 * out per shell rather than derived from the fixture's capability fields - a
 * table computed from the gate's own input would agree with whatever the gate
 * does.
 */
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setMobileApp } from "@/lib/mobile-app";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { SessionConnectivityStrip } from "@/components/layout/session-connectivity-strip";
import {
  SESSION_CONNECTIVITY_ANNOUNCE_AFTER_MS,
  SESSION_CONNECTIVITY_POLL_MS,
} from "@/lib/host/session-connectivity";
import {
  StreamRuntimeContext,
  type StreamRuntimeBinding,
} from "@/lib/host/stream-runtime-context";
import {
  createFakeHostStreamClient,
  createReadyControl,
} from "@/lib/host/__tests__/fake-host-stream-client";
import { shellSurfaces } from "../../../../__tests__/shell-surfaces";
import type { ReactNode } from "react";
import type { IRunnerHost } from "@traycer-clients/shared/platform/runner-host";

const ANNOUNCES_INTERRUPTIONS: ReadonlyMap<string, boolean> = new Map([
  ["desktop", false],
  ["installed mobile", true],
  ["webapp", true],
  ["browser dev", true],
]);

/**
 * Enough past the announce deadline that the poll has certainly noticed and
 * the episode timer has certainly fired - this suite is about the GATE, not
 * about where either boundary sits.
 */
const PAST_ANNOUNCE_MS =
  SESSION_CONNECTIVITY_ANNOUNCE_AFTER_MS + SESSION_CONNECTIVITY_POLL_MS * 4;

function mountStrip(args: {
  readonly runnerHost: IRunnerHost;
  readonly isReady: () => boolean;
}): ReactNode {
  const binding: StreamRuntimeBinding = {
    wsStreamClient: createFakeHostStreamClient(args.isReady),
    hostId: "host-a",
  };
  return (
    <RunnerHostProvider runnerHost={args.runnerHost}>
      <StreamRuntimeContext value={binding}>
        <SessionConnectivityStrip />
      </StreamRuntimeContext>
    </RunnerHostProvider>
  );
}

function stripIsShown(): boolean {
  return screen.queryByTestId("session-connectivity-strip") !== null;
}

function advance(ms: number): void {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  setMobileApp(false);
});

describe("session connectivity across the shells that mount the app", () => {
  it("has an expectation for every shell that mounts the app", () => {
    expect(
      shellSurfaces()
        .map((surface) => surface.name)
        .sort(),
    ).toEqual([...ANNOUNCES_INTERRUPTIONS.keys()].sort());
  });

  describe.each(shellSurfaces())("on $name", (surface) => {
    it("announces a down session only where every host is another machine", () => {
      setMobileApp(surface.mobileApp);
      const ready = createReadyControl(true);
      render(
        mountStrip({ runnerHost: surface.runnerHost, isReady: ready.isReady }),
      );
      // Ready first, so the outage below is a DROP rather than a first dial -
      // the store deliberately never announces a session that has never been
      // attached, and a case that skipped this would read "quiet" on every
      // shell for the wrong reason.
      expect(stripIsShown()).toBe(false);

      ready.setReady(false);
      advance(PAST_ANNOUNCE_MS);

      expect(stripIsShown()).toBe(ANNOUNCES_INTERRUPTIONS.get(surface.name));
    });
  });
});

describe("the strip across one interruption on a browser shell", () => {
  /** The webapp row: no local host, no mobile product flag. */
  function browserShell(): IRunnerHost {
    const surface = shellSurfaces().find((entry) => entry.name === "webapp");
    if (surface === undefined) {
      throw new Error("the webapp shell surface is missing from the fixture");
    }
    return surface.runnerHost;
  }

  it("shows while the session is reattaching and clears on the ready edge", () => {
    const ready = createReadyControl(true);
    render(mountStrip({ runnerHost: browserShell(), isReady: ready.isReady }));
    expect(stripIsShown()).toBe(false);

    // The frozen-tab shape: the socket is gone, the wake path is re-dialing,
    // and until it reattaches this line is the only thing on screen saying so.
    ready.setReady(false);
    advance(PAST_ANNOUNCE_MS);
    expect(stripIsShown()).toBe(true);
    expect(
      screen.getByTestId("session-connectivity-strip").textContent,
    ).toContain("Connection interrupted - reconnecting…");

    // Dismissed by the bound session's own ready edge and nothing else: an
    // announcement that outlived the outage would train people to ignore it.
    ready.setReady(true);
    advance(SESSION_CONNECTIVITY_POLL_MS);
    expect(stripIsShown()).toBe(false);
  });
});
