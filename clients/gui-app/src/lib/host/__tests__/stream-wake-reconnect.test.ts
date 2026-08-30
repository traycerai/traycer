import { beforeEach, describe, expect, it, vi } from "vitest";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
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

import {
  resetRemoteResumeSweepForTest,
  subscribeStreamWakeReconnect,
  wakeReconnectOptions,
} from "@/lib/host/stream-wake-reconnect";
import {
  RELAY_WAKE_PROBE_TIMEOUT_BACKGROUNDED_MS,
  WAKE_FORCE_RECONNECT_AFTER_BACKGROUND_MS,
} from "@traycer-clients/shared/host-transport/remote/index";

const LOCAL_TARGET: HostDirectoryEntry = {
  hostId: "host-a",
  label: "host-a",
  kind: "local",
  websocketUrl: null,
  version: null,
  transportDialability: "dialable",
};

function makeClient() {
  // A real (inert) WsStreamClient: it dials nothing until `subscribe()` is
  // called, and `subscribeStreamWakeReconnect` only captures it in callbacks
  // that never fire here. Built via the real factory to avoid an unsafe cast.
  const client = buildHostStreamClient({
    target: LOCAL_TARGET,
    userId: "user-a",
    endpoint: () => null,
    bearer: () => null,
    authnBaseUrl: "http://localhost:5005",
    auth: null,
    // Local (plain-WS) target: sweep eligibility only gates the remote-session
    // cache, so this is inert here.
    proactiveWakeEligible: true,
    // Local (plain-WS) target: `autoStart` only gates the remote session, so
    // this stays inert either way.
    autoStart: false,
  });
  if (client === null) {
    throw new Error("expected a local WsStreamClient, got null");
  }
  return client;
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
  // The sweep's install flag is module-level and would otherwise survive from
  // whichever test subscribed first, making every later case here see one
  // fewer registration than production has.
  resetRemoteResumeSweepForTest();
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

  it("rolls back the 'online' AND resume listeners if onNetworkPathChanged throws, then rethrows", () => {
    const runnerHost = makeRunnerHost();
    const resumeDispose = vi.fn();
    vi.spyOn(runnerHost, "onSystemResumed").mockReturnValue({
      dispose: resumeDispose,
    });
    const networkError = new Error("network wiring failed");
    vi.spyOn(runnerHost, "onNetworkPathChanged").mockImplementation(() => {
      throw networkError;
    });

    expect(() =>
      subscribeStreamWakeReconnect(makeClient(), runnerHost),
    ).toThrow(networkError);
    expect(mocks.offOnline).toHaveBeenCalledTimes(1);
    expect(resumeDispose).toHaveBeenCalledTimes(1);
  });

  it("tears down all three subscriptions via the returned disposer on the happy path", () => {
    const runnerHost = makeRunnerHost();
    const resumeDispose = vi.fn();
    vi.spyOn(runnerHost, "onSystemResumed").mockReturnValue({
      dispose: resumeDispose,
    });
    const networkDispose = vi.fn();
    vi.spyOn(runnerHost, "onNetworkPathChanged").mockReturnValue({
      dispose: networkDispose,
    });

    const dispose = subscribeStreamWakeReconnect(makeClient(), runnerHost);
    expect(mocks.offOnline).not.toHaveBeenCalled();
    expect(resumeDispose).not.toHaveBeenCalled();
    expect(networkDispose).not.toHaveBeenCalled();

    dispose();
    expect(mocks.offOnline).toHaveBeenCalledTimes(1);
    expect(resumeDispose).toHaveBeenCalledTimes(1);
    expect(networkDispose).toHaveBeenCalledTimes(1);
  });

  it("maps a brief measured background to the short probe and a long one to a forced redial", () => {
    const client = makeClient();
    const reconnectAll = vi
      .spyOn(client, "reconnectAll")
      .mockImplementation(() => undefined);
    const runnerHost = makeRunnerHost();
    subscribeStreamWakeReconnect(client, runnerHost);

    // Brief background: probe, but on the mobile deadline, and a failed
    // probe redials immediately.
    runnerHost.emitSystemResumed({
      backgroundedForMs: WAKE_FORCE_RECONNECT_AFTER_BACKGROUND_MS - 1,
    });
    expect(reconnectAll).toHaveBeenLastCalledWith("wake-resume", {
      probeFirst: true,
      wakeProbe: {
        timeoutMs: RELAY_WAKE_PROBE_TIMEOUT_BACKGROUNDED_MS,
        immediateRedialOnFailure: true,
      },
    });

    // At the gate: the socket did not survive that background; the probe is
    // skipped outright. The two arms MUST map differently - a deleted gate
    // collapses them into one reading and this pair fails.
    runnerHost.emitSystemResumed({
      backgroundedForMs: WAKE_FORCE_RECONNECT_AFTER_BACKGROUND_MS,
    });
    expect(reconnectAll).toHaveBeenLastCalledWith("wake-resume", {
      probeFirst: false,
      wakeProbe: null,
    });
  });

  it("keeps the default probe for a resume that cannot state its dwell, and forces on a network-path change", () => {
    const client = makeClient();
    const reconnectAll = vi
      .spyOn(client, "reconnectAll")
      .mockImplementation(() => undefined);
    const runnerHost = makeRunnerHost();
    subscribeStreamWakeReconnect(client, runnerHost);

    // Desktop/web resume (no measured dwell): byte-identical to the old
    // behavior - default probe, default deadline.
    runnerHost.emitSystemResumed({ backgroundedForMs: null });
    expect(reconnectAll).toHaveBeenLastCalledWith("wake-resume", {
      probeFirst: true,
      wakeProbe: null,
    });

    // The network moved under live sockets: no probe answer can vouch for
    // the old path, so replace.
    runnerHost.emitNetworkPathChanged();
    expect(reconnectAll).toHaveBeenLastCalledWith("wake-network", {
      probeFirst: false,
      wakeProbe: null,
    });
  });

  it("maps wake-online to the default probe - the network returning says nothing about a measured background", () => {
    expect(wakeReconnectOptions("wake-online", null)).toEqual({
      probeFirst: true,
      wakeProbe: null,
    });
  });

  it("installs the process-wide resume sweep once, however many clients subscribe", () => {
    const runnerHost = makeRunnerHost();
    const resumeSpy = vi
      .spyOn(runnerHost, "onSystemResumed")
      .mockReturnValue({ dispose: vi.fn() });

    subscribeStreamWakeReconnect(makeClient(), runnerHost);
    // One per-client subscription, plus the sweep on its first install.
    expect(resumeSpy).toHaveBeenCalledTimes(2);

    subscribeStreamWakeReconnect(makeClient(), runnerHost);
    // The second client brings its OWN subscription - per-client wake stays
    // per-client, because the local transport's re-dial belongs to the client
    // that owns it - but the sweep is not installed again. Three, not four:
    // the invariant is one sweep, not one subscription.
    expect(resumeSpy).toHaveBeenCalledTimes(3);
  });
});
