import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import { setMobileApp } from "@/lib/mobile-app";
import { subscribeAppSuspendRelease } from "@/lib/registries/app-suspend-release";

const calls = vi.hoisted(() => ({ order: [] as string[] }));

vi.mock("@/lib/epics/epic-parking", () => ({
  parkUnwatchedEpicsNow: () => {
    calls.order.push("park-epics");
    return 2;
  },
}));

vi.mock("@/lib/registries/chat-session-registry", () => ({
  getChatSessionRegistry: () => ({
    sleepIdleWarmSessions: () => {
      calls.order.push("sleep-chats");
      return 3;
    },
  }),
}));

vi.mock("@/lib/registries/terminal-session-registry", () => ({
  getTerminalSessionRegistry: () => ({
    disposeLingeringPlainTerminals: () => {
      calls.order.push("drop-terminals");
      return 1;
    },
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
});
