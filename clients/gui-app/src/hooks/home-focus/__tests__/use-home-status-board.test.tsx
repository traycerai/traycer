import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import type { NotificationsStreamCallbacks } from "@traycer-clients/shared/host-transport/notifications-stream-client";
import { createHostReconnectEngine } from "@traycer-clients/shared/host-client/host-connection-reconnect-engine";
import {
  getHomeStatusMap,
  HOME_STATUS_ROW_TTL_MS,
  type HomeStatusRow,
} from "@traycer/protocol/notifications/home-status-room";
import { useHomeStatusBoard } from "@/hooks/home-focus/use-home-status-board";
import {
  __resetNotificationsStoreForTests,
  openNotificationsStream,
  useNotificationsStore,
} from "@/stores/notifications/notifications-store";
import { useSettingsStore } from "@/stores/settings/settings-store";

const reconnectEngine = createHostReconnectEngine();

/**
 * The host's side of one lane: its own replica of the room, which receives
 * everything the GUI sends and whose writes reach the GUI as stream updates.
 */
interface FakeHost {
  readonly doc: Y.Doc;
  readonly sent: Uint8Array[];
  write: (rows: ReadonlyArray<HomeStatusRow>) => void;
  writeRaw: (key: string, value: unknown) => void;
  dispose: () => void;
}

function openLane(): FakeHost {
  const hostDoc = new Y.Doc();
  const sent: Uint8Array[] = [];
  const opened: { callbacks: NotificationsStreamCallbacks | null } = {
    callbacks: null,
  };
  const dispose = openNotificationsStream(
    reconnectEngine,
    (callbacks) => {
      opened.callbacks = callbacks;
      return {
        applyUpdate: (bytes) => {
          sent.push(bytes);
          Y.applyUpdate(hostDoc, bytes, "gui");
        },
        close: () => {},
      };
    },
    null,
  );
  const lane = opened.callbacks;
  if (lane === null) throw new Error("factory not invoked");
  hostDoc.on("update", (update: Uint8Array, origin: unknown) => {
    if (origin === "gui") return;
    act(() => {
      lane.onUpdate(update);
    });
  });
  act(() => {
    lane.onSnapshot({ schemaVersion: "2" }, Y.encodeStateAsUpdate(hostDoc));
  });
  return {
    doc: hostDoc,
    sent,
    write: (rows) => {
      hostDoc.transact(() => {
        for (const { key, ...value } of rows) {
          getHomeStatusMap(hostDoc).set(key, value);
        }
      });
    },
    writeRaw: (key, value) => {
      getHomeStatusMap(hostDoc).set(key, value);
    },
    dispose,
  };
}

function row(overrides: Partial<HomeStatusRow>): HomeStatusRow {
  return {
    key: "row",
    status: "in-progress",
    item: "Item",
    note: "",
    agentId: "agent-1",
    agentName: "Opus impl",
    epicId: "epic-1",
    hostId: "host-1",
    harnessId: "claude",
    updatedAt: Date.now(),
    ...overrides,
  };
}

function keysOf(rows: ReadonlyArray<HomeStatusRow>): string[] {
  return rows.map((r) => r.key);
}

beforeEach(() => {
  __resetNotificationsStoreForTests();
  useSettingsStore.setState({ homeStatusDoneHideAfter: "24h" });
});

afterEach(() => {
  cleanup();
});

describe("useHomeStatusBoard", () => {
  it("re-renders with the board's rows, in board order, as the map changes", () => {
    const host = openLane();
    const { result } = renderHook(() => useHomeStatusBoard());
    expect(result.current.rows).toEqual([]);

    host.write([
      row({ key: "done", status: "done" }),
      row({ key: "needs", status: "needs-you" }),
    ]);
    expect(keysOf(result.current.rows)).toEqual(["needs", "done"]);

    host.write([row({ key: "work", status: "in-progress" })]);
    expect(keysOf(result.current.rows)).toEqual(["needs", "work", "done"]);

    // A rewrite of an existing key replaces the whole value.
    host.write([row({ key: "work", status: "done", item: "Shipped" })]);
    expect(result.current.rows.find((r) => r.key === "work")?.item).toBe(
      "Shipped",
    );
    host.dispose();
  });

  it("keeps the same rows identity when nothing on the board changed", () => {
    const host = openLane();
    host.write([row({ key: "a" })]);
    const { result, rerender } = renderHook(() => useHomeStatusBoard());
    const first = result.current.rows;
    rerender();
    expect(result.current.rows).toBe(first);
    host.dispose();
  });

  it("hides expired rows and drops invalid ones", () => {
    const host = openLane();
    host.write([
      row({ key: "old-done", status: "done", updatedAt: 0 }),
      row({
        key: "fresh-done",
        status: "done",
        updatedAt: Date.now() - 12 * 60 * 60 * 1000,
      }),
    ]);
    host.writeRaw("bad", { status: "nope" });
    const { result } = renderHook(() => useHomeStatusBoard());
    expect(keysOf(result.current.rows)).toEqual(["fresh-done"]);
    host.dispose();
  });

  it("hides done rows past this device's Done setting, re-filtering when it changes", () => {
    const host = openLane();
    host.write([
      row({
        key: "done-90m",
        status: "done",
        updatedAt: Date.now() - 90 * 60 * 1000,
      }),
      row({ key: "work", status: "in-progress" }),
    ]);
    const { result } = renderHook(() => useHomeStatusBoard());
    expect(keysOf(result.current.rows)).toEqual(["work", "done-90m"]);

    act(() => {
      useSettingsStore.getState().setHomeStatusDoneHideAfter("1h");
    });
    expect(keysOf(result.current.rows)).toEqual(["work"]);
    expect(result.current.thresholds.doneHideAfterMs).toBe(60 * 60 * 1000);
    host.dispose();
  });

  it("keeps a days-old done row at Never, until the 7-day row TTL", () => {
    const host = openLane();
    host.write([
      row({
        key: "done-3d",
        status: "done",
        updatedAt: Date.now() - 3 * 24 * 60 * 60 * 1000,
      }),
      row({
        key: "done-8d",
        status: "done",
        updatedAt: Date.now() - HOME_STATUS_ROW_TTL_MS - 60 * 60 * 1000,
      }),
    ]);
    const { result } = renderHook(() => useHomeStatusBoard());
    expect(keysOf(result.current.rows)).toEqual([]);

    act(() => {
      useSettingsStore.getState().setHomeStatusDoneHideAfter("never");
    });
    expect(keysOf(result.current.rows)).toEqual(["done-3d"]);
    host.dispose();
  });

  it("shows nothing while no lane feeds the replica, even with rows in the doc", () => {
    const host = openLane();
    host.write([row({ key: "a" })]);
    const { result } = renderHook(() => useHomeStatusBoard());
    expect(keysOf(result.current.rows)).toEqual(["a"]);

    act(() => {
      host.dispose();
    });
    expect(
      getHomeStatusMap(useNotificationsStore.getState().doc).has("a"),
    ).toBe(true);
    expect(result.current.rows).toEqual([]);
  });

  it("follows the doc a reset swaps in", () => {
    const host = openLane();
    host.write([row({ key: "a" })]);
    const { result } = renderHook(() => useHomeStatusBoard());
    expect(keysOf(result.current.rows)).toEqual(["a"]);
    act(() => {
      __resetNotificationsStoreForTests();
    });
    expect(result.current.rows).toEqual([]);
    host.dispose();
  });

  it("dismiss deletes the row locally and on the host's replica", () => {
    const host = openLane();
    host.write([row({ key: "a" }), row({ key: "b" })]);
    const { result } = renderHook(() => useHomeStatusBoard());

    act(() => {
      result.current.dismiss("a");
    });
    expect(keysOf(result.current.rows)).toEqual(["b"]);
    expect(host.sent).toHaveLength(1);
    expect(getHomeStatusMap(host.doc).has("a")).toBe(false);
    expect(getHomeStatusMap(host.doc).has("b")).toBe(true);
    host.dispose();
  });

  it("dismissing an absent key sends nothing", () => {
    const host = openLane();
    const { result } = renderHook(() => useHomeStatusBoard());
    act(() => {
      result.current.dismiss("missing");
    });
    expect(host.sent).toEqual([]);
    host.dispose();
  });
});
