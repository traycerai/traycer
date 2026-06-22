import { beforeEach, describe, expect, it, vi } from "vitest";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import { buildHostStreamClient } from "@/hooks/host/use-host-stream-client-for";

// `subscribeStreamWakeReconnect` registers the `window 'online'` listener first,
// then the OS-resume subscription. These tests pin that the first listener is
// rolled back if the second subscription throws (otherwise the disposer is never
// returned and the 'online' listener leaks), and that the happy-path disposer
// tears down both.
const mocks = vi.hoisted(() => ({
  onWakeReconnect: vi.fn(),
  offOnline: vi.fn(),
}));

vi.mock("@/lib/host/wake-reconnect", () => ({
  onWakeReconnect: mocks.onWakeReconnect,
}));

import { subscribeStreamWakeReconnect } from "@/lib/host/stream-wake-reconnect";

function makeClient() {
  // A real (inert) WsStreamClient: it dials nothing until `subscribe()` is
  // called, and `subscribeStreamWakeReconnect` only captures it in callbacks
  // that never fire here. Built via the real factory to avoid an unsafe cast.
  return buildHostStreamClient({
    endpoint: () => null,
    bearer: () => null,
    auth: null,
  });
}

function makeRunnerHost() {
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

beforeEach(() => {
  mocks.onWakeReconnect.mockReset();
  mocks.offOnline.mockReset();
  mocks.onWakeReconnect.mockReturnValue(mocks.offOnline);
});

describe("subscribeStreamWakeReconnect", () => {
  it("disposes the 'online' listener if onSystemResumed throws, then rethrows", () => {
    const runnerHost = makeRunnerHost();
    const resumeError = new Error("resume wiring failed");
    vi.spyOn(runnerHost, "onSystemResumed").mockImplementation(() => {
      throw resumeError;
    });

    expect(() =>
      subscribeStreamWakeReconnect(makeClient(), runnerHost),
    ).toThrow(resumeError);
    // The first listener must not leak when the second subscription fails.
    expect(mocks.offOnline).toHaveBeenCalledTimes(1);
  });

  it("tears down both subscriptions via the returned disposer on the happy path", () => {
    const runnerHost = makeRunnerHost();
    const resumeDispose = vi.fn();
    vi.spyOn(runnerHost, "onSystemResumed").mockReturnValue({
      dispose: resumeDispose,
    });

    const dispose = subscribeStreamWakeReconnect(makeClient(), runnerHost);
    expect(mocks.offOnline).not.toHaveBeenCalled();
    expect(resumeDispose).not.toHaveBeenCalled();

    dispose();
    expect(mocks.offOnline).toHaveBeenCalledTimes(1);
    expect(resumeDispose).toHaveBeenCalledTimes(1);
  });
});
