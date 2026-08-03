import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import type { ManagedCommand } from "@traycer/protocol/host/managed-command/unary-schemas";
import type { ManagedCommandListStreamCallbacks } from "@traycer-clients/shared/host-transport/managed-command-list-stream-client";
import { ManagedCommandListStreamMount } from "@/providers/managed-command-list-stream-mount";
import { __setManagedCommandListStreamClientFactoryForTests } from "@/providers/managed-command-list-stream-factory-override";
import {
  managedCommandListRegistry,
  useManagedCommandList,
} from "@/stores/managed-commands/managed-command-list-registry";

/**
 * The directory half of "Monitors & Shells" (`UI.md` §1): one live view per
 * epic carrying every managed command in it regardless of which chat created
 * it, ordered running-first then by most recent activity (§9).
 */

function command(over: Partial<ManagedCommand>): ManagedCommand {
  return {
    id: "cmd-1",
    kind: "monitor",
    description: "deploy watcher",
    status: { state: "running", pid: 4410, startedAtMs: 10 },
    chatId: "chat-1",
    createdAtMs: 10,
    updatedAtMs: 10,
    ...over,
  };
}

function installStubFactory(): {
  emit: () => ManagedCommandListStreamCallbacks;
} {
  let captured: ManagedCommandListStreamCallbacks | null = null;
  __setManagedCommandListStreamClientFactoryForTests((_epicId, callbacks) => {
    captured = callbacks;
    return { close: () => undefined };
  });
  return {
    emit: () => {
      if (captured === null) throw new Error("stream callbacks not wired");
      return captured;
    },
  };
}

/** Stands in for the sidebar section reading the live list. */
function ListProbe() {
  const commands = useManagedCommandList("epic-1");
  return (
    <div data-testid="order">
      {commands === null ? "loading" : commands.map((c) => c.id).join(",")}
    </div>
  );
}

function renderList(): void {
  render(
    <>
      <ManagedCommandListStreamMount epicId="epic-1" />
      <ListProbe />
    </>,
  );
}

function readOrder(): string | null {
  return screen.getByTestId("order").textContent;
}

const runningOld = command({
  id: "running-old",
  status: { state: "running", pid: 1, startedAtMs: 100 },
  updatedAtMs: 100,
});
const runningNew = command({
  id: "running-new",
  kind: "shell",
  description: "db migration",
  status: { state: "running", pid: 2, startedAtMs: 300 },
  chatId: "chat-2",
  updatedAtMs: 300,
});
const exitedNewest = command({
  id: "exited-newest",
  status: { state: "exited", exitCode: 1, signal: null, exitedAtMs: 900 },
  updatedAtMs: 900,
});
const stoppedOldest = command({
  id: "stopped-oldest",
  status: { state: "stopped", stoppedAtMs: 50 },
  updatedAtMs: 50,
});

afterEach(() => {
  cleanup();
  __setManagedCommandListStreamClientFactoryForTests(null);
  managedCommandListRegistry.disposeAll();
});

describe("managed-command list store", () => {
  it("orders a snapshot running-first then by most recent activity", () => {
    const stub = installStubFactory();
    renderList();

    act(() => {
      stub
        .emit()
        .onSnapshot([stoppedOldest, exitedNewest, runningOld, runningNew]);
    });

    // Running commands lead in recency order, then everything else by
    // recency - so the 900ms-old exit sits BELOW a monitor last touched at
    // 100ms, and the chat that created a command never affects its place.
    expect(readOrder()).toBe(
      "running-new,running-old,exited-newest,stopped-oldest",
    );
  });

  it("re-places a command when a changed frame moves it out of running", () => {
    const stub = installStubFactory();
    renderList();

    act(() => {
      stub
        .emit()
        .onSnapshot([stoppedOldest, exitedNewest, runningOld, runningNew]);
    });
    act(() => {
      stub.emit().onChanged(
        command({
          ...runningNew,
          status: {
            state: "exited",
            exitCode: 0,
            signal: null,
            exitedAtMs: 1_000,
          },
          updatedAtMs: 1_000,
        }),
      );
    });

    expect(readOrder()).toBe(
      "running-old,running-new,exited-newest,stopped-oldest",
    );
  });

  it("drops a command on a removed frame", () => {
    const stub = installStubFactory();
    renderList();

    act(() => {
      stub.emit().onSnapshot([runningOld, runningNew, exitedNewest]);
    });
    act(() => {
      stub.emit().onRemoved("running-old");
    });

    expect(readOrder()).toBe("running-new,exited-newest");
  });

  it("reads as loading until the first snapshot lands", () => {
    installStubFactory();
    renderList();

    // An empty epic and an epic whose stream has not answered yet are
    // different states; the section must not claim "no monitors" before it
    // has heard from the host.
    expect(readOrder()).toBe("loading");
  });
});
