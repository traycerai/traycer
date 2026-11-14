/**
 * The read-only shell output modal when the host directory does not yet name
 * the bot's bound host, and when it stops naming it under a window that is
 * already reading. The real modal, output session, output store, output body
 * and durable-stream opener run over a drivable host stream; only the host
 * directory, the host client's identity, the reachability read and the socket
 * the opener would dial (`openDurableStreamTransport`) are replaced.
 *
 * The real opener refuses a host the directory does not hold, so the window
 * must not ask it for one: an absent host opens no transport and creates no
 * stream, and the stream is created once the directory names the host.
 */
import { act, cleanup, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  managedCommandSchema,
  type ManagedCommand,
} from "@traycer/protocol/host/managed-command/unary-schemas";
import {
  FakeStreamClient,
  type FakeStreamSession,
} from "@traycer-clients/shared/host-transport/__testing__/fake-stream-client";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import type { StreamMethodSupport } from "@traycer/protocol/host-transport/stream-session";
import type { HostReachability } from "@/hooks/agent/use-host-reachability";
import type { AttributableDurableStreamTransport } from "@/lib/host/durable-stream-transport";

const BOT_ID = "bot_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const SESSION_CHAT_ID = "chat-thread-1";
const COMMAND_ID = "shell-deploy";
const BOUND_HOST = "host-bound";
const BOT_METHOD = "managedCommand.subscribeBotOutput";

class SupportScriptedClient extends FakeStreamClient {
  override getMethodSupport(): StreamMethodSupport {
    return "unknown";
  }
}

interface FakeDirectory {
  readonly findById: (hostId: string) => HostDirectoryEntry | null;
  readonly onChange: (listener: () => void) => { readonly dispose: () => void };
}

const harness = vi.hoisted(() => ({
  entries: new Map<string, HostDirectoryEntry>(),
  listeners: new Set<() => void>(),
  opens: [] as string[],
  closes: [] as string[],
}));

let hostClient = new SupportScriptedClient(true);
let queryClient = new QueryClient();

const directory: FakeDirectory = {
  findById: (hostId) => {
    return harness.entries.get(hostId) ?? null;
  },
  onChange: (listener) => {
    harness.listeners.add(listener);
    return { dispose: () => harness.listeners.delete(listener) };
  },
};

function entryFor(hostId: string): HostDirectoryEntry {
  return {
    hostId,
    label: hostId,
    kind: "remote",
    websocketUrl: `wss://${hostId}.example/rpc`,
    version: null,
    transportDialability: "dialable",
  };
}

function directoryNames(hostId: string): void {
  act(() => {
    harness.entries.set(hostId, entryFor(hostId));
    for (const listener of [...harness.listeners]) listener();
  });
}

function directoryDrops(hostId: string): void {
  act(() => {
    harness.entries.delete(hostId);
    for (const listener of [...harness.listeners]) listener();
  });
}

// The setup file replaces this module with a fake opener for every jsdom
// suite; this suite is about the real one.
vi.unmock("@/lib/host/use-durable-stream-transport");
vi.mock("@/lib/host/runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host/runtime")>()),
  useHostDirectory: () => directory,
  useHostClient: () => ({
    getRequestContextUserId: () => "user-a",
    getRequestContext: () => null,
    onBearerRotated: () => () => undefined,
    onCloudVerdictChanged: () => () => undefined,
    notifyHostAvailabilityRecovered: () => undefined,
  }),
}));
vi.mock("@/providers/use-runner-host", () => ({ useRunnerHost: () => null }));
vi.mock("@/lib/host/stream-auth-revalidator", () => ({
  useStreamAuthRevalidator: () => ({
    revalidateForReconnect: () => Promise.resolve("rotated"),
  }),
}));
vi.mock("@/hooks/agent/use-host-reachability", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/hooks/agent/use-host-reachability")
  >()),
  useHostReachability: (hostId: string): HostReachability => ({
    status: "reachable",
    hostLabel: hostId,
    unavailability: null,
    basis: "directory",
    hostKind: "remote",
  }),
}));

vi.mock("@/lib/host/durable-stream-transport", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/lib/host/durable-stream-transport")
  >()),
  openDurableStreamTransport: (input: {
    readonly target: { readonly hostId: string };
  }): AttributableDurableStreamTransport => {
    harness.opens.push(input.target.hostId);
    return {
      wsStreamClient: hostClient,
      close: () => {
        harness.closes.push(input.target.hostId);
      },
      closeWithReason: () => {
        harness.closes.push(input.target.hostId);
      },
    };
  },
}));

import { BotShellOutputModal } from "@/components/bots/bot-shell-output-modal";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  installLegendListTestClock,
  installLegendListViewportMetrics,
  settleLegendList,
} from "@/components/chat/__tests__/legend-list-test-environment";

function runningCommand(id: string): ManagedCommand {
  return managedCommandSchema.parse({
    id,
    monitoring: true,
    description: "deploy watcher",
    command: "tail -f deploy.log",
    cwd: "/work/repo",
    cadence: { debounceMs: 500, maxWaitMs: 15_000, throttleMs: 5_000 },
    status: { state: "running", pid: 42, startedAtMs: 2_000 },
    chatId: SESSION_CHAT_ID,
    relaunchOnHostRestart: false,
    createdAtMs: 2_000,
    updatedAtMs: 2_000,
  });
}

function emitSnapshot(stream: FakeStreamSession, texts: readonly string[]) {
  act(() => {
    stream.emit(
      {
        kind: "snapshot",
        command: runningCommand(COMMAND_ID),
        lines: texts.map((text) => ({
          channel: "stdout" as const,
          text,
          atMs: 3_000,
        })),
        start: { segmentId: "seg-1", byteOffset: 0 },
        reachedStart: true,
        hasBinaryPayload: false,
      },
      null,
    );
    stream.emit(
      { kind: "liveness", state: "live", hasBinaryPayload: false },
      null,
    );
  });
}

function openStreams(): FakeStreamSession[] {
  return hostClient.sessions.filter((stream) => !stream.closed);
}

function modalTree(boundHostId: string | null) {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <BotShellOutputModal
          botId={BOT_ID}
          sessionChatId={SESSION_CHAT_ID}
          hostId={BOUND_HOST}
          boundHostId={boundHostId}
          commandId={COMMAND_ID}
          onClose={() => undefined}
          restoreFocus={() => undefined}
        />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

function mountModal() {
  return render(modalTree(BOUND_HOST));
}

beforeEach(() => {
  installLegendListTestClock();
  installLegendListViewportMetrics();
  hostClient = new SupportScriptedClient(true);
  queryClient = new QueryClient();
  harness.entries.clear();
  harness.listeners.clear();
  harness.opens.length = 0;
  harness.closes.length = 0;
});

afterEach(() => {
  cleanup();
});

describe("the read-only shell output modal over a host directory that does not name the bound host", () => {
  it("opens no transport and creates no stream while the directory lacks the bound host, and still shows the window", () => {
    mountModal();

    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(
      within(screen.getByRole("dialog")).getByText("Shell output"),
    ).toBeTruthy();
    const unavailable = within(screen.getByRole("dialog")).getByTestId(
      "bot-shell-output-unavailable",
    );
    expect(unavailable.textContent).toBe("Output unavailable");
    expect(harness.opens).toEqual([]);
    expect(hostClient.sessions).toEqual([]);
    expect(hostClient.subscribes).toEqual([]);
  });

  it("opens the real transport for the bound host and subscribes to the bot stream once the directory names it, and reads the lines", async () => {
    mountModal();

    directoryNames(BOUND_HOST);

    expect(harness.opens.length).toBeGreaterThan(0);
    expect(harness.opens.every((hostId) => hostId === BOUND_HOST)).toBe(true);
    expect(hostClient.subscribes.length).toBeGreaterThan(0);
    for (const open of hostClient.subscribes) {
      expect(open).toEqual({
        method: BOT_METHOD,
        params: {
          botId: BOT_ID,
          sessionChatId: SESSION_CHAT_ID,
          commandId: COMMAND_ID,
        },
      });
    }
    const streams = openStreams();
    expect(streams).toHaveLength(1);
    emitSnapshot(streams[0], ["listening on 3000"]);
    await settleLegendList();
    expect(
      within(screen.getByRole("dialog")).getByText(/listening on 3000/),
    ).toBeTruthy();
  });

  it("keeps the lines, the open stream and its transport when the directory stops naming the host under a window that is reading", async () => {
    directoryNames(BOUND_HOST);
    mountModal();
    const [stream] = openStreams();
    emitSnapshot(stream, ["pinned-1"]);
    await settleLegendList();
    const opensBefore = harness.opens.length;

    directoryDrops(BOUND_HOST);

    expect(
      within(screen.getByRole("dialog")).getByText(/pinned-1/),
    ).toBeTruthy();
    expect(stream.closed).toBe(false);
    expect(harness.closes).toEqual([]);
    expect(harness.opens).toHaveLength(opensBefore);
  });

  it("resumes on the same stream when the directory names the host again after it dropped, and opens no second transport", async () => {
    directoryNames(BOUND_HOST);
    mountModal();
    const [stream] = openStreams();
    emitSnapshot(stream, ["pinned-1"]);
    await settleLegendList();
    const opensBefore = harness.opens.length;

    directoryDrops(BOUND_HOST);
    directoryNames(BOUND_HOST);

    expect(openStreams()).toEqual([stream]);
    expect(harness.opens).toHaveLength(opensBefore);
    expect(
      within(screen.getByRole("dialog")).getByText(/pinned-1/),
    ).toBeTruthy();
  });

  it("stays frozen and takes no later frame when the binding moved to another host and back while the directory still lacked the host, and the entry then appears", async () => {
    const mounted = mountModal();

    mounted.rerender(modalTree("host-rebound"));
    mounted.rerender(modalTree(BOUND_HOST));
    directoryNames(BOUND_HOST);
    for (const stream of hostClient.sessions) {
      emitSnapshot(stream, ["stale-first"]);
    }
    await settleLegendList();

    const dialog = within(screen.getByRole("dialog"));
    expect(dialog.queryByText(/stale-first/)).toBeNull();
    expect(dialog.queryByText(/Loading output/)).toBeNull();
    expect(dialog.queryByTestId("bot-shell-output-not-live")).not.toBeNull();
  });
});
