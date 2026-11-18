import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  renderHook,
  type RenderHookResult,
} from "@testing-library/react";
import {
  MANAGED_COMMAND_MAX_WINDOW_LINES,
  type ManagedCommandLogLine,
} from "@traycer/protocol/host/managed-command/subscribe";
import type { StreamMethodSupport } from "@traycer/protocol/host-transport/stream-session";
import type { ManagedCommand } from "@traycer/protocol/host/managed-command/unary-schemas";
import type { DurableStreamTransport } from "@/lib/host/durable-stream-transport";
import {
  FakeStreamClient,
  type FakeStreamSession,
} from "@traycer-clients/shared/host-transport/__testing__/fake-stream-client";

// The real hook, client and store run; only the transport is replaced, by a
// drivable host stream. The factory override seam is deliberately NOT used:
// it bypasses the very host routing these tests prove.
const transportOpens: string[] = [];
let hostClients = new Map<string, FakeStreamClient>();

// The bot session waits for the bound host's directory entry before it creates
// a stream, so the directory handed to it is a fixture: every host is named,
// and nothing changes.
const namedHostDirectory = {
  findById: (hostId: string) => ({
    hostId,
    label: hostId,
    kind: "remote" as const,
    websocketUrl: `wss://${hostId}.example/rpc`,
    version: null,
    transportDialability: "dialable" as const,
  }),
  onChange: () => ({ dispose: () => undefined }),
};
vi.mock("@/lib/host/use-durable-stream-transport", () => ({
  useDurableStreamTransportFactory:
    () =>
    (hostId: string): DurableStreamTransport => {
      transportOpens.push(hostId);
      const client = hostClients.get(hostId);
      if (client === undefined) {
        throw new Error(`no scripted host ${hostId}`);
      }
      return { wsStreamClient: client, close: () => undefined };
    },
}));

import {
  useManagedCommandOutputSession,
  type ManagedCommandOutputSession,
} from "../use-managed-command-output-session";

type BotWindow = RenderHookResult<ManagedCommandOutputSession, unknown>;

const BOT_METHOD = "managedCommand.subscribeBotOutput";
const EPIC_METHOD = "managedCommand.subscribeOutput";
const SANDBOX_HOST = "sbx-host";
const OTHER_HOST = "default-host";

const COMMAND: ManagedCommand = {
  id: "cmd-1",
  monitoring: true,
  description: "deploy watcher",
  command: "tail -f deploy.log",
  cwd: "/work/repo",
  cadence: { debounceMs: 500, maxWaitMs: 15_000, throttleMs: 5_000 },
  relaunchOnHostRestart: false,
  status: { state: "running", pid: 4410, startedAtMs: 10 },
  chatId: "chat-1",
  createdAtMs: 10,
  updatedAtMs: 10,
};

const START = { segmentId: "seg-1", byteOffset: 0 };

function line(text: string): ManagedCommandLogLine {
  return { channel: "stdout", text, atMs: 1_000 };
}

/** A host whose method support the test decides, as an older host's is. */
class SupportScriptedClient extends FakeStreamClient {
  support: StreamMethodSupport = "unknown";

  override getMethodSupport(): StreamMethodSupport {
    return this.support;
  }
}

function install(hostId: string): SupportScriptedClient {
  const client = new SupportScriptedClient(true);
  hostClients.set(hostId, client);
  return client;
}

function botSession(hostId: string): BotWindow {
  return renderHook(() =>
    useManagedCommandOutputSession(
      {
        target: { kind: "bot", botId: "bot-1", sessionChatId: "chat-thread-1" },
        commandId: "cmd-1",
        hostId,
      },
      namedHostDirectory,
    ),
  );
}

function snapshot(session: FakeStreamSession, texts: string[]): void {
  act(() => {
    session.emit(
      {
        kind: "snapshot",
        command: COMMAND,
        lines: texts.map(line),
        start: START,
        reachedStart: false,
        hasBinaryPayload: false,
      },
      null,
    );
  });
}

function liveness(session: FakeStreamSession, state: "live" | "holding"): void {
  act(() => {
    session.emit({ kind: "liveness", state, hasBinaryPayload: false }, null);
  });
}

function state(view: BotWindow) {
  const handle = view.result.current.session;
  if (handle === null) throw new Error("the session has not opened");
  return handle.store.getState();
}

function texts(view: BotWindow): string[] {
  return state(view).lines.map((entry) => entry.text);
}

function onlySession(hostId: string): FakeStreamSession {
  const client = hostClients.get(hostId);
  if (client === undefined) throw new Error(`no scripted host ${hostId}`);
  expect(client.sessions).toHaveLength(1);
  return client.sessions[0];
}

beforeEach(() => {
  install(SANDBOX_HOST);
});

afterEach(() => {
  cleanup();
  transportOpens.length = 0;
  hostClients = new Map();
});

describe("a bot's shell output window", () => {
  it("subscribes on the bound host with the bot, the viewed session and the command, never as an epic", () => {
    const bound = install(SANDBOX_HOST);
    const other = install(OTHER_HOST);

    botSession(SANDBOX_HOST);

    expect(transportOpens).toEqual([SANDBOX_HOST]);
    expect(bound.subscribes).toEqual([
      {
        method: BOT_METHOD,
        params: {
          botId: "bot-1",
          sessionChatId: "chat-thread-1",
          commandId: "cmd-1",
        },
      },
    ]);
    expect(other.subscribes).toEqual([]);
    expect(bound.subscribes.some((open) => open.method === EPIC_METHOD)).toBe(
      false,
    );
  });

  it("keeps the epic window on its own method and request", () => {
    const bound = install(SANDBOX_HOST);

    renderHook(() =>
      useManagedCommandOutputSession(
        {
          target: { kind: "epic", epicId: "epic-1" },
          commandId: "cmd-1",
          hostId: SANDBOX_HOST,
        },
        null,
      ),
    );

    expect(bound.subscribes).toEqual([
      {
        method: EPIC_METHOD,
        params: { epicId: "epic-1", commandId: "cmd-1" },
      },
    ]);
  });

  it("is not live on the snapshot alone: it becomes live once the host's live word has also arrived", () => {
    const view = botSession(SANDBOX_HOST);
    const stream = onlySession(SANDBOX_HOST);

    expect(state(view).live).toBe(false);
    snapshot(stream, ["tail-1"]);
    expect(texts(view)).toEqual(["tail-1"]);
    expect(state(view).live).toBe(false);

    liveness(stream, "live");
    expect(state(view).live).toBe(true);
  });

  it("lets the epic window be live on its open snapshot, with no liveness frame", () => {
    const bound = install(SANDBOX_HOST);
    const view = renderHook(() =>
      useManagedCommandOutputSession(
        {
          target: { kind: "epic", epicId: "epic-1" },
          commandId: "cmd-1",
          hostId: SANDBOX_HOST,
        },
        null,
      ),
    );
    expect(view.result.current.session?.store.getState().live).toBe(false);

    snapshot(bound.sessions[0], ["tail-1"]);

    expect(view.result.current.session?.store.getState().live).toBe(true);
  });

  it("is not live on the live word alone, before any snapshot has been authorized", () => {
    const view = botSession(SANDBOX_HOST);
    const stream = onlySession(SANDBOX_HOST);

    liveness(stream, "live");

    expect(state(view).live).toBe(false);
    expect(texts(view)).toEqual([]);
  });

  it("keeps the lines and stops being live while the host holds, then resumes", () => {
    const view = botSession(SANDBOX_HOST);
    const stream = onlySession(SANDBOX_HOST);
    snapshot(stream, ["tail-1", "tail-2"]);
    liveness(stream, "live");

    liveness(stream, "holding");

    expect(state(view).live).toBe(false);
    expect(texts(view)).toEqual(["tail-1", "tail-2"]);
    expect(state(view).command).not.toBeNull();

    liveness(stream, "live");
    expect(state(view).live).toBe(true);
    expect(texts(view)).toEqual(["tail-1", "tail-2"]);
  });

  it("keeps the lines and stops being live when the connection drops, and a reconnect snapshot replaces them", () => {
    const view = botSession(SANDBOX_HOST);
    const stream = onlySession(SANDBOX_HOST);
    snapshot(stream, ["tail-1", "tail-2"]);
    liveness(stream, "live");

    act(() => stream.emitStatus("reconnecting"));

    expect(state(view).live).toBe(false);
    expect(texts(view)).toEqual(["tail-1", "tail-2"]);

    act(() => stream.emitStatus("open"));
    // An open socket alone is not the host's word that delivery is live.
    expect(state(view).live).toBe(false);

    snapshot(stream, ["tail-2", "tail-3"]);
    // The live word of the earlier connection does not carry over.
    expect(state(view).live).toBe(false);
    liveness(stream, "live");
    expect(texts(view)).toEqual(["tail-2", "tail-3"]);
    expect(state(view).live).toBe(true);
  });

  it("clears the lines and the command when the host closes the stream as unavailable, which is the denial", () => {
    const view = botSession(SANDBOX_HOST);
    const stream = onlySession(SANDBOX_HOST);
    snapshot(stream, ["secret-1", "secret-2"]);
    liveness(stream, "live");

    act(() =>
      stream.emitFatalWithCode("MANAGED_COMMAND_UNAVAILABLE", "access denied"),
    );

    expect(texts(view)).toEqual([]);
    expect(state(view).command).toBeNull();
    expect(state(view).live).toBe(false);
    expect(state(view).fatalClose?.code).toBe("MANAGED_COMMAND_UNAVAILABLE");
  });

  it("shows only the unavailable state when a reopened stream reports the command gone, keeping the earlier lines not live, until a later denial clears them", () => {
    const view = botSession(SANDBOX_HOST);
    const stream = onlySession(SANDBOX_HOST);
    snapshot(stream, ["tail-1", "tail-2"]);
    liveness(stream, "live");
    act(() => stream.emitStatus("reconnecting"));
    act(() => stream.emitStatus("open"));

    // The reconnect answers with the gone outcome: no snapshot, only `deleted`.
    act(() => stream.emit({ kind: "deleted", hasBinaryPayload: false }, null));

    expect(state(view).deleted).toBe(true);
    expect(texts(view)).toEqual(["tail-1", "tail-2"]);
    expect(state(view).live).toBe(false);

    act(() =>
      stream.emitFatalWithCode("MANAGED_COMMAND_UNAVAILABLE", "denied"),
    );

    expect(texts(view)).toEqual([]);
    expect(state(view).command).toBeNull();
    expect(state(view).deleted).toBe(false);
  });

  it("opens with no lines and no command on a first open the host refuses or reports gone", () => {
    const refused = botSession(SANDBOX_HOST);
    const refusedStream = hostClients.get(SANDBOX_HOST)?.sessions.at(-1);
    if (refusedStream === undefined) throw new Error("no stream opened");
    act(() =>
      refusedStream.emitFatalWithCode("MANAGED_COMMAND_UNAVAILABLE", "denied"),
    );
    expect(texts(refused)).toEqual([]);
    expect(state(refused).command).toBeNull();
    expect(state(refused).live).toBe(false);
    refused.unmount();

    const gone = botSession(SANDBOX_HOST);
    const goneStream = hostClients.get(SANDBOX_HOST)?.sessions.at(-1);
    if (goneStream === undefined) throw new Error("no stream opened");
    act(() =>
      goneStream.emit({ kind: "deleted", hasBinaryPayload: false }, null),
    );
    expect(texts(gone)).toEqual([]);
    expect(state(gone).command).toBeNull();
    expect(state(gone).deleted).toBe(true);
    expect(state(gone).live).toBe(false);
  });

  it("keeps the lines, not live, when the stream fails for a reason that is not a denial", () => {
    const view = botSession(SANDBOX_HOST);
    const stream = onlySession(SANDBOX_HOST);
    snapshot(stream, ["tail-1", "tail-2"]);
    liveness(stream, "live");

    act(() =>
      stream.emitFatalWithCode(
        "MANAGED_COMMAND_OUTPUT_FAILED",
        "log reader crashed",
      ),
    );

    expect(texts(view)).toEqual(["tail-1", "tail-2"]);
    expect(state(view).command).not.toBeNull();
    expect(state(view).live).toBe(false);
    expect(state(view).fatalClose?.code).toBe("MANAGED_COMMAND_OUTPUT_FAILED");
  });

  it("keeps the lines when the command is deleted after open, and reads as unavailable", () => {
    const view = botSession(SANDBOX_HOST);
    const stream = onlySession(SANDBOX_HOST);
    snapshot(stream, ["tail-1"]);
    liveness(stream, "live");

    act(() => stream.emit({ kind: "deleted", hasBinaryPayload: false }, null));

    expect(state(view).deleted).toBe(true);
    expect(texts(view)).toEqual(["tail-1"]);
    expect(state(view).live).toBe(false);
  });

  it("never sends a bot id as an epic id to a host that lacks the bot stream", () => {
    const old = install(SANDBOX_HOST);
    old.support = "unsupported";

    const view = botSession(SANDBOX_HOST);

    expect(
      view.result.current.session?.streamMethodSupport?.getMethodSupport(
        BOT_METHOD,
      ),
    ).toBe("unsupported");
    expect(old.subscribes.some((open) => open.method === EPIC_METHOD)).toBe(
      false,
    );
    expect(
      old.subscribes.every(
        (open) => !JSON.stringify(open.params).includes("epicId"),
      ),
    ).toBe(true);
    expect(state(view).live).toBe(false);
    expect(texts(view)).toEqual([]);
  });

  it("shows the unavailable state, with no lines, when an old host closes the bot stream as incompatible, and never retries it as an epic stream", () => {
    const old = install(SANDBOX_HOST);
    old.support = "unsupported";
    const view = botSession(SANDBOX_HOST);
    const stream = onlySession(SANDBOX_HOST);

    act(() =>
      stream.emitIncompatible(BOT_METHOD, "the host does not serve the method"),
    );

    expect(state(view).fatalClose?.code).toBe("INCOMPATIBLE");
    expect(texts(view)).toEqual([]);
    expect(state(view).command).toBeNull();
    expect(state(view).live).toBe(false);
    expect(old.subscribes.map((open) => open.method)).toEqual([BOT_METHOD]);
  });

  describe("while the host holds delivery", () => {
    function output(stream: FakeStreamSession, text: string): void {
      act(() => {
        stream.emit(
          {
            kind: "output",
            lines: [line(text)],
            start: { segmentId: "seg-1", byteOffset: 99 },
            hasBinaryPayload: false,
          },
          null,
        );
      });
    }

    function openLive(): {
      readonly view: BotWindow;
      readonly stream: FakeStreamSession;
    } {
      const view = botSession(SANDBOX_HOST);
      const stream = onlySession(SANDBOX_HOST);
      snapshot(stream, ["tail-1"]);
      liveness(stream, "live");
      return { view, stream };
    }

    it("drops an older page in flight at the hold, and a window that arrives for it later", () => {
      const { view, stream } = openLive();
      act(() => state(view).loadOlder());
      expect(state(view).loadingOlder).toBe(true);
      const requestId = String(stream.framesOfKind("loadOlder")[0].requestId);

      liveness(stream, "holding");

      expect(state(view).loadingOlder).toBe(false);
      act(() => {
        stream.emit(
          {
            kind: "older",
            requestId,
            lines: [line("older-1")],
            start: { segmentId: "seg-0", byteOffset: 0 },
            reachedStart: false,
            hasBinaryPayload: false,
          },
          null,
        );
      });
      expect(texts(view)).toEqual(["tail-1"]);
      expect(state(view).loadingOlder).toBe(false);
    });

    it("sends no page request while held and leaves no spinner behind", () => {
      const { view, stream } = openLive();
      liveness(stream, "holding");

      act(() => state(view).loadOlder());

      expect(stream.framesOfKind("loadOlder")).toHaveLength(0);
      expect(state(view).loadingOlder).toBe(false);
    });

    it("sends no resnapshot while held, and asks for one when delivery resumes", () => {
      const { view, stream } = openLive();
      act(() => state(view).setFollowing(false));
      output(stream, "live-2");
      expect(state(view).detached).toBe(true);
      liveness(stream, "holding");

      act(() => state(view).setFollowing(true));

      expect(stream.framesOfKind("resnapshot")).toHaveLength(0);
      expect(state(view).resyncPending).toBe(false);

      liveness(stream, "live");
      expect(stream.framesOfKind("resnapshot")).toHaveLength(1);
      expect(state(view).resyncPending).toBe(true);

      snapshot(stream, ["tail-1", "live-2"]);
      expect(state(view).resyncPending).toBe(false);
      expect(state(view).detached).toBe(false);
    });

    it("drops a resnapshot in flight at the hold and asks again on resume", () => {
      const { view, stream } = openLive();
      act(() => state(view).setFollowing(false));
      output(stream, "live-2");
      act(() => state(view).setFollowing(true));
      expect(stream.framesOfKind("resnapshot")).toHaveLength(1);
      expect(state(view).resyncPending).toBe(true);

      liveness(stream, "holding");
      expect(state(view).resyncPending).toBe(false);

      liveness(stream, "live");
      expect(stream.framesOfKind("resnapshot")).toHaveLength(2);
      expect(state(view).resyncPending).toBe(true);
    });
  });

  it("pages older output within the wire bound, through the bot stream", () => {
    const view = botSession(SANDBOX_HOST);
    const stream = onlySession(SANDBOX_HOST);
    snapshot(stream, ["tail-1"]);
    liveness(stream, "live");

    act(() => state(view).loadOlder());

    const older = stream.framesOfKind("loadOlder");
    expect(older).toHaveLength(1);
    expect(older[0]).toMatchObject({ before: START });
    const maxLines = older[0].maxLines;
    expect(typeof maxLines === "number" && maxLines > 0).toBe(true);
    expect(Number(maxLines)).toBeLessThanOrEqual(
      MANAGED_COMMAND_MAX_WINDOW_LINES,
    );
  });
});
