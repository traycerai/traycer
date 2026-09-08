import "../../../../../__tests__/test-browser-apis";
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useRemotePipSessions } from "../use-pip-epic-sessions";

const EPIC = "epic-1";

interface RecordedSession {
  readonly hostId: string;
  readonly method: string;
  readonly params: unknown;
  closed: boolean;
}

interface RecordedTransport {
  readonly hostId: string;
  closed: boolean;
  readonly sessions: RecordedSession[];
}

const transportFactory = vi.hoisted(() => {
  const transports: RecordedTransport[] = [];
  const failOnceFor = new Set<string>();
  const openTransport = (hostId: string) => {
    if (failOnceFor.delete(hostId)) {
      throw new Error(`No directory entry for host ${hostId}`);
    }
    const record: RecordedTransport = {
      hostId,
      closed: false,
      sessions: [],
    };
    transports.push(record);
    return {
      wsStreamClient: {
        subscribe: (method: string, params: unknown) => {
          const session: RecordedSession = {
            hostId,
            method,
            params,
            closed: false,
          };
          record.sessions.push(session);
          return {
            onServerFrame: (_handler: unknown) => undefined,
            onStatusChange: (_handler: unknown) => undefined,
            close: () => {
              session.closed = true;
            },
          };
        },
      },
      close: () => {
        record.closed = true;
      },
    };
  };
  return {
    transports,
    failOnceFor,
    openTransport,
    reset(): void {
      transports.length = 0;
      failOnceFor.clear();
    },
  };
});

const directoryEvents = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  const state = {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
    emit(): void {
      for (const listener of listeners) listener();
    },
    reset(): void {
      listeners.clear();
    },
  };
  return {
    ...state,
    directory: {
      onChange: (listener: () => void) => state.subscribe(listener),
    },
  };
});

vi.mock("@/lib/host", () => ({
  useHostDirectory: () => directoryEvents.directory,
}));

vi.mock("@/lib/host/use-durable-stream-transport", () => ({
  useDurableStreamTransportFactory: () => transportFactory.openTransport,
}));

vi.mock("@/lib/epic-selectors", () => ({
  useEpicChatRecords: () => [{ id: "chat-a" }],
}));

function allSessions(): RecordedSession[] {
  return transportFactory.transports.flatMap((transport) => transport.sessions);
}

function RemoteSessionsProbe(props: { readonly hostIds: readonly string[] }) {
  useRemotePipSessions(EPIC, props.hostIds);
  return null;
}

describe("useRemotePipSessions", () => {
  beforeEach(() => {
    transportFactory.reset();
    directoryEvents.reset();
  });

  afterEach(() => {
    cleanup();
    transportFactory.reset();
    directoryEvents.reset();
  });

  it("subscribes only the exact remote PiP target", () => {
    const remoteHostIds = ["host-b"];
    const { unmount } = render(<RemoteSessionsProbe hostIds={remoteHostIds} />);

    expect(transportFactory.transports.map((item) => item.hostId)).toEqual([
      "host-b",
    ]);
    const sessions = allSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      hostId: "host-b",
      method: "browser.sessions",
      params: { epicId: EPIC },
    });
    expect(transportFactory.transports.every((item) => !item.closed)).toBe(
      true,
    );
    expect(sessions.every((session) => !session.closed)).toBe(true);

    unmount();

    expect(transportFactory.transports.every((item) => item.closed)).toBe(true);
    expect(allSessions().every((session) => session.closed)).toBe(true);
  });

  it("closes a subscription immediately when the PiP no longer targets its host", () => {
    const remoteHostIds = ["host-b"];
    const noRemoteHosts: readonly string[] = [];
    const { rerender, unmount } = render(
      <RemoteSessionsProbe hostIds={remoteHostIds} />,
    );
    expect(transportFactory.transports).toHaveLength(1);

    rerender(<RemoteSessionsProbe hostIds={noRemoteHosts} />);

    const hostB = transportFactory.transports.find(
      (item) => item.hostId === "host-b",
    );
    expect(hostB?.closed).toBe(true);
    expect(hostB?.sessions.every((session) => session.closed)).toBe(true);
    expect(transportFactory.transports).toHaveLength(1);

    unmount();

    expect(hostB?.closed).toBe(true);
    expect(hostB?.sessions.every((session) => session.closed)).toBe(true);
  });

  it("retries a target on directory evidence after synchronous construction failure", () => {
    const remoteHostIds = ["host-b"];
    transportFactory.failOnceFor.add("host-b");
    render(<RemoteSessionsProbe hostIds={remoteHostIds} />);

    expect(transportFactory.transports).toHaveLength(0);
    directoryEvents.emit();

    expect(transportFactory.transports.map((item) => item.hostId)).toEqual([
      "host-b",
    ]);
  });
});
