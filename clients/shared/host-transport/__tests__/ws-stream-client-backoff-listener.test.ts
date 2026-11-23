import { afterEach, describe, expect, it, vi } from "vitest";
import { hostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import {
  completeHandshake,
  makeStubSocketFactory,
  makeStubSocketStreamClient,
} from "../__testing__/stub-stream-socket";
import { signalsBackoff, type IStreamSession } from "../i-stream-session";
import type { WsStreamClient } from "../ws-stream-client";

/**
 * A listener told of a backoff is the caller's code. One that throws must not
 * stop the stream's reconnect, nor keep the listeners after it from hearing.
 */

const WAIT = { interval: 10 };

describe("a backoff listener that throws", () => {
  const sessions: IStreamSession[] = [];
  const clients: Array<WsStreamClient<typeof hostStreamRpcRegistry>> = [];

  afterEach(() => {
    for (const session of sessions.splice(0)) session.close();
    for (const client of clients.splice(0)) client.close("test-done");
    vi.useRealTimers();
  });

  it("neither stops the stream's redial after a socket loss nor keeps a later listener from hearing the backoff", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { factory, sockets } = makeStubSocketFactory();
    const client = makeStubSocketStreamClient(factory);
    clients.push(client);
    const session = client.subscribe("git.subscribeStatus", {
      hostId: "local-computer",
      runningDir: "/repo",
      ignoreWhitespace: false,
      freshNonce: null,
    });
    sessions.push(session);
    if (!signalsBackoff(session)) throw new Error("a stream tells of backoff");
    const heard: string[] = [];
    session.onBackoffEntered(() => {
      heard.push("throwing");
      throw new Error("the listener's own fault");
    });
    session.onBackoffEntered(() => {
      heard.push("later");
    });
    await vi.waitFor(() => expect(sockets).toHaveLength(1), WAIT);
    completeHandshake(sockets[0]);

    expect(() => sockets[0].fireClose(1006, "connection lost")).not.toThrow();

    await vi.waitFor(() => expect(sockets).toHaveLength(2), WAIT);
    expect(heard).toEqual(["throwing", "later"]);
  });
});
