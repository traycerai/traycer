import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import { setMobileApp } from "@/lib/mobile-app";
import {
  releaseForAppSuspend,
  subscribeAppSuspendRelease,
} from "@/lib/registries/app-suspend-release";

const calls = vi.hoisted(() => ({
  order: [] as string[],
  /** Planes whose release throws, by the name each records in `order`. */
  throwing: new Set<string>(),
}));

function record(plane: string, released: number): number {
  calls.order.push(plane);
  if (calls.throwing.has(plane)) throw new Error(`${plane} failed`);
  return released;
}

vi.mock("@/lib/epics/epic-parking", () => ({
  parkUnwatchedEpicsNow: () => record("park-epics", 2),
}));

vi.mock("@/lib/registries/chat-session-registry", () => ({
  getChatSessionRegistry: () => ({
    sleepIdleWarmSessions: () => record("sleep-chats", 3),
  }),
}));

vi.mock("@/lib/registries/terminal-session-registry", () => ({
  getTerminalSessionRegistry: () => ({
    disposeLingeringPlainTerminals: () => record("drop-terminals", 1),
  }),
}));

function makeRunnerHost(): MockRunnerHost {
  return new MockRunnerHost({
    signInUrl: "https://auth.traycer.invalid/sign-in",
    authnBaseUrl: "http://localhost:5005",
    localHost: null,
    hosts: [],
    workspaceFolderPickerPaths: undefined,
    hasLocalHost: undefined,
    traycerCli: undefined,
  });
}

describe("subscribeAppSuspendRelease", () => {
  beforeEach(() => {
    calls.order.length = 0;
    calls.throwing.clear();
  });

  afterEach(() => {
    setMobileApp(false);
  });

  it("releases on the installed mobile app's background edge, epics first", () => {
    setMobileApp(true);
    const runnerHost = makeRunnerHost();
    const dispose = subscribeAppSuspendRelease(runnerHost);

    runnerHost.emitSystemSuspended();

    expect(calls.order).toEqual([
      "park-epics",
      "sleep-chats",
      "drop-terminals",
    ]);
    dispose();
    runnerHost.emitSystemSuspended();
    expect(calls.order).toHaveLength(3);
  });

  it("does nothing off the mobile app, even if a shell reports a suspend", () => {
    const runnerHost = makeRunnerHost();
    const dispose = subscribeAppSuspendRelease(runnerHost);

    runnerHost.emitSystemSuspended();

    expect(calls.order).toEqual([]);
    dispose();
  });

  it("does nothing without a runner host", () => {
    setMobileApp(true);
    const dispose = subscribeAppSuspendRelease(null);
    expect(calls.order).toEqual([]);
    dispose();
  });

  // The last chance before the OS suspends the runtime: one plane failing
  // must not keep the others' memory resident for the whole background.
  it("still runs the later planes when an earlier one throws", () => {
    calls.throwing.add("park-epics");
    calls.throwing.add("sleep-chats");

    expect(releaseForAppSuspend()).toEqual({
      parkedEpics: 0,
      sleptChats: 0,
      disposedTerminals: 1,
    });
    expect(calls.order).toEqual([
      "park-epics",
      "sleep-chats",
      "drop-terminals",
    ]);
  });
});
