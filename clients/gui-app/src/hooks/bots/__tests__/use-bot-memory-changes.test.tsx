/**
 * The changes a bot's memory snapshot carries (`bot.memory.subscribe@1.1`)
 * reach the reading only from a session negotiated at 1.1 or later: a session
 * at 1.0, or one with no negotiated version, reads as no changes, whatever
 * its frame carries.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FakeStreamClient,
  type FakeStreamSession,
} from "@traycer-clients/shared/host-transport/__testing__/fake-stream-client";
import type { SchemaVersion } from "@traycer/protocol/framework/versioned-stream-rpc";
import type {
  BotMemory,
  BotMemoryChange,
} from "@traycer/protocol/host/bot/schemas";
import {
  __resetBotMemorySessionsForTesting,
  useBotMemory,
  type BotMemoryReading,
} from "@/hooks/bots/use-bot-memory";

const HOST_ID = "host-1";
const BOT_ID = "bot-1";
const ENVIRONMENT_ID = "env-1";

const mocks = vi.hoisted(() => ({
  client: null as FakeStreamClient | null,
}));

vi.mock("@/hooks/host/use-host-stream-client-for", () => ({
  useHostStreamClientFor: () => mocks.client,
}));
vi.mock("@/lib/host/stream-auth-revalidator", () => ({
  useStreamAuthRevalidator: () => null,
}));
vi.mock("@/hooks/host/use-host-directory-entry", () => ({
  useHostDirectoryEntry: () => null,
}));

const CHANGES: ReadonlyArray<BotMemoryChange> = [
  {
    id: "change-1",
    at: 1_000,
    action: "add",
    memory: "shared",
    entryId: "entry-1",
    threadId: null,
  },
  {
    id: "change-2",
    at: 2_000,
    action: "remove",
    memory: "own",
    entryId: "entry-2",
    threadId: "thread-1",
  },
];

const MEMORY: BotMemory = {
  entries: [],
  own: { entries: 0, chars: 0, ceiling: 8_000 },
  shared: { entries: 0, chars: 0, ceiling: 8_000 },
  changes: [...CHANGES],
};

function wrapper(queryClient: QueryClient) {
  return function Wrapper(props: { readonly children: ReactNode }): ReactNode {
    return (
      <QueryClientProvider client={queryClient}>
        {props.children}
      </QueryClientProvider>
    );
  };
}

function openSession(): FakeStreamSession {
  const session = mocks.client?.sessions[0];
  if (session === undefined) throw new Error("bot.memory.subscribe not open");
  return session;
}

async function readingAfterSnapshot(
  negotiated: SchemaVersion | null,
): Promise<BotMemoryReading> {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const { result } = renderHook(
    () =>
      useBotMemory({
        hostId: HOST_ID,
        botId: BOT_ID,
        environmentId: ENVIRONMENT_ID,
        enabled: true,
      }),
    { wrapper: wrapper(queryClient) },
  );
  await waitFor(() => expect(mocks.client?.sessions).toHaveLength(1));
  const session = openSession();
  session.negotiatedSchemaVersion = negotiated;
  act(() => {
    session.emit(
      { kind: "snapshot", memory: MEMORY, hasBinaryPayload: false },
      null,
    );
  });
  await waitFor(() => expect(result.current.kind).toBe("ready"));
  return result.current;
}

beforeEach(() => {
  __resetBotMemorySessionsForTesting();
  const client = new FakeStreamClient(true);
  client.methodSupport = "supported";
  mocks.client = client;
});

afterEach(() => {
  cleanup();
  __resetBotMemorySessionsForTesting();
});

describe("useBotMemory changes by negotiated version", () => {
  it("delivers the snapshot's changes from a session negotiated at 1.1", async () => {
    const reading = await readingAfterSnapshot({ major: 1, minor: 1 });

    if (reading.kind !== "ready") throw new Error("reading is not ready");
    expect(reading.memory.changes).toEqual(CHANGES);
  });

  it("reads no changes from a session negotiated at 1.0, though the frame carries them", async () => {
    const reading = await readingAfterSnapshot({ major: 1, minor: 0 });

    if (reading.kind !== "ready") throw new Error("reading is not ready");
    expect(reading.memory.changes).toEqual([]);
  });

  it("reads no changes from a session with no negotiated version, though the frame carries them", async () => {
    const reading = await readingAfterSnapshot(null);

    if (reading.kind !== "ready") throw new Error("reading is not ready");
    expect(reading.memory.changes).toEqual([]);
  });

  it("shows the memory it last read when opened again, then what the new read says", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const mount = () => {
      const readings: BotMemoryReading[] = [];
      const rendered = renderHook(
        () => {
          const reading = useBotMemory({
            hostId: HOST_ID,
            botId: BOT_ID,
            environmentId: ENVIRONMENT_ID,
            enabled: true,
          });
          readings.push(reading);
          return reading;
        },
        { wrapper: wrapper(queryClient) },
      );
      return { readings, ...rendered };
    };

    const first = mount();
    await waitFor(() => expect(mocks.client?.sessions).toHaveLength(1));
    const firstSession = openSession();
    firstSession.negotiatedSchemaVersion = { major: 1, minor: 1 };
    act(() => {
      firstSession.emit(
        { kind: "snapshot", memory: MEMORY, hasBinaryPayload: false },
        null,
      );
    });
    await waitFor(() => expect(first.result.current.kind).toBe("ready"));
    first.unmount();
    await waitFor(() => expect(firstSession.closed).toBe(true));

    const second = mount();
    const firstReading = second.readings[0];
    if (firstReading.kind !== "ready") throw new Error("not ready at once");
    expect(firstReading.memory.changes).toEqual(CHANGES);
    await waitFor(() => expect(mocks.client?.sessions).toHaveLength(2));

    const nextChanges: ReadonlyArray<BotMemoryChange> = [
      {
        id: "change-3",
        at: 3_000,
        action: "add",
        memory: "own",
        entryId: "entry-3",
        threadId: null,
      },
    ];
    const secondSession = mocks.client?.sessions[1];
    if (secondSession === undefined) throw new Error("no second session");
    secondSession.negotiatedSchemaVersion = { major: 1, minor: 1 };
    act(() => {
      secondSession.emit(
        {
          kind: "snapshot",
          memory: { ...MEMORY, changes: [...nextChanges] },
          hasBinaryPayload: false,
        },
        null,
      );
    });
    await waitFor(() => {
      const reading = second.result.current;
      if (reading.kind !== "ready") throw new Error("reading is not ready");
      expect(reading.memory.changes).toEqual(nextChanges);
    });
  });
});
