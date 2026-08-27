import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import {
  managedCommandSubscribeOutputServerFrameSchema,
  type ManagedCommandLogLine,
} from "@traycer/protocol/host/managed-command/subscribe";
import type { ManagedCommand } from "@traycer/protocol/host/managed-command/unary-schemas";
import type { HostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import type { ManagedCommandOutputStreamCallbacks } from "@traycer-clients/shared/host-transport/managed-command-output-stream-client";
import type { StreamMethodSupport } from "@traycer-clients/shared/host-transport/ws-stream-client";
import { TooltipProvider } from "@/components/ui/tooltip";
import { TileFindScope } from "@/components/epic-canvas/tile-find/tile-find-scope";
import {
  DEFAULT_CODE_FONT_SIZE,
  useSettingsStore,
} from "@/stores/settings/settings-store";
import type { StreamMethodSupportSource } from "@/lib/host/stream-runtime-context";
import {
  useTileFindStore,
  type TileFindStateSnapshot,
} from "@/stores/tile-find";
import { MANAGED_COMMAND_OUTPUT_FIND_COVERAGE_MESSAGE } from "../managed-command-output-find-adapter";

const reachability = vi.hoisted<{ value: string }>(() => ({
  value: "reachable",
}));

const defaultHostSupport = vi.hoisted<{ value: StreamMethodSupport }>(() => ({
  value: "supported",
}));

const boundHostSupport = vi.hoisted<{ value: StreamMethodSupport }>(() => ({
  value: "supported",
}));

vi.mock("@/hooks/agent/use-host-reachability", () => ({
  useHostReachability: () => ({
    status: reachability.value,
    hostLabel: "Work laptop",
  }),
  resolvedHostLabel: (r: { status: string; hostLabel: string | null }) =>
    r.status === "checking" ? null : r.hostLabel,
}));

vi.mock(
  "@/hooks/managed-command/use-managed-command-lifecycle-mutations",
  () => ({
    useManagedCommandStart: () => ({ mutate: vi.fn(), isPending: false }),
    useManagedCommandStop: () => ({ mutate: vi.fn(), isPending: false }),
    useManagedCommandDelete: () => ({ mutate: vi.fn(), isPending: false }),
    useManagedCommandStopAllIsPending: () => false,
  }),
);

vi.mock("@/lib/host/stream-runtime-context", () => ({
  useWsStreamClient: () => null,
  useStreamMethodSupport: () => defaultHostSupport.value,
  useStreamMethodSupportFor: (
    client: StreamMethodSupportSource | null,
    method: keyof HostStreamRpcRegistry & string,
  ) => (client === null ? null : client.getMethodSupport(method)),
  useStreamMethodSchemaVersion: () => null,
}));

const refuseDurableTransport = vi.hoisted(() => () => {
  throw new Error("no durable transport in tests");
});
vi.mock("@/lib/host/use-durable-stream-transport", () => ({
  useDurableStreamTransportFactory: () => refuseDurableTransport,
}));

import { EpicSessionContext } from "@/lib/registries/epic-session-registry";
import {
  createOpenEpicStore,
  type EpicStreamClientFactory,
  type OpenEpicStoreHandle,
} from "@/stores/epics/open-epic/store";
import { __setManagedCommandOutputStreamClientFactoryForTests } from "@/providers/managed-command-output-stream-factory-override";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { findOpenArtifactInTab } from "@/stores/epics/canvas/canvas-selectors";
import { makeManagedCommandOutputTileRef } from "@/stores/epics/canvas/tile-schema/managed-command-output-tile";
import type { ManagedCommandOutputTileRef } from "@/stores/epics/canvas/types";
import { ManagedCommandOutputTile } from "../managed-command-output-tile";

const EPIC_ID = "epic-1";
const TAB_ID = "tab-1";
const COMMAND_ID = "cmd-1";

const COMMAND: ManagedCommand = {
  id: COMMAND_ID,
  monitoring: true,
  description: "deploy watcher",
  command: "tail -f deploy.log",
  cwd: "/work/repo",
  cadence: { debounceMs: 500, maxWaitMs: 15_000, throttleMs: 5_000 },
  status: { state: "running", pid: 4410, startedAtMs: 10 },
  chatId: "chat-1",
  createdAtMs: 10,
  updatedAtMs: 10,
};

const AT_MS = Date.UTC(2024, 0, 1, 9, 30, 5);

function line(
  channel: ManagedCommandLogLine["channel"],
  text: string,
): ManagedCommandLogLine {
  return { channel, text, atMs: AT_MS };
}

/**
 * The jump-live control carries whichever of three labels its state calls for,
 * so proving it is ABSENT has to rule out all three: a name-scoped query for
 * one of them passes while the button sits there wearing another.
 */
const ANY_JUMP_LIVE_LABEL =
  /^(Jump to live|New output available|Loading live output…)$/;

function queryJumpLive(): HTMLElement | null {
  return screen.queryByRole("button", { name: ANY_JUMP_LIVE_LABEL });
}

const noopStreamClientFactory: EpicStreamClientFactory = () => ({
  applyUpdate: () => undefined,
  awareness: () => undefined,
  applyArtifactRoomUpdate: () => undefined,
  artifactRoomAwareness: () => undefined,
  retryMigration: () => undefined,
  close: () => undefined,
});

let epicHandle: OpenEpicStoreHandle;
let restoreLayoutGeometry: () => void;

function installOutputStub(): {
  readonly emit: () => ManagedCommandOutputStreamCallbacks;
} {
  let captured: ManagedCommandOutputStreamCallbacks | null = null;
  const boundStreamMethodSupport: StreamMethodSupportSource = {
    getMethodSupport: () => boundHostSupport.value,
    subscribeMethodSupport: () => () => undefined,
  };
  __setManagedCommandOutputStreamClientFactoryForTests(
    (_epicId, _commandId, callbacks) => {
      captured = callbacks;
      return {
        loadOlder: () => undefined,
        resnapshot: () => undefined,
        close: () => undefined,
        streamMethodSupport: boundStreamMethodSupport,
      };
    },
  );
  return {
    emit: () => {
      if (captured === null) throw new Error("output callbacks not wired");
      return captured;
    },
  };
}

function renderTile(): ManagedCommandOutputTileRef {
  const node = makeManagedCommandOutputTileRef({
    commandId: COMMAND_ID,
    hostId: "host-1",
  });
  useEpicCanvasStore.getState().openTileInTab(TAB_ID, node);
  const opened = findOpenArtifactInTab(TAB_ID, COMMAND_ID);
  if (opened === null) throw new Error("tile did not open");
  render(
    <EpicSessionContext.Provider value={epicHandle}>
      <TooltipProvider>
        <TileFindScope
          node={node}
          viewTabId={TAB_ID}
          tileId={opened.paneId}
          epicId={EPIC_ID}
          isActive
        >
          <ManagedCommandOutputTile
            node={node}
            viewTabId={TAB_ID}
            tileId={opened.paneId}
            epicId={EPIC_ID}
          />
        </TileFindScope>
      </TooltipProvider>
    </EpicSessionContext.Provider>,
  );
  return node;
}

function snapshotFrame(
  lines: readonly ManagedCommandLogLine[],
  reachedStart: boolean,
) {
  const frame = managedCommandSubscribeOutputServerFrameSchema.parse({
    kind: "snapshot",
    hasBinaryPayload: false,
    command: COMMAND,
    lines,
    start: { segmentId: "seg-2", byteOffset: 40 },
    reachedStart,
  });
  if (frame.kind !== "snapshot") throw new Error("expected a snapshot frame");
  return frame;
}

function openAtTail(
  emit: () => ManagedCommandOutputStreamCallbacks,
  lines: readonly ManagedCommandLogLine[],
  reachedStart: boolean,
): void {
  const frame = snapshotFrame(lines, reachedStart);
  act(() => {
    emit().onSnapshot({
      command: frame.command,
      lines: frame.lines,
      start: frame.start,
      reachedStart: frame.reachedStart,
    });
  });
}

beforeEach(() => {
  const heightSpy = vi
    .spyOn(HTMLElement.prototype, "offsetHeight", "get")
    .mockImplementation(function (this: HTMLElement) {
      return this.dataset.index === undefined ? 600 : 24;
    });
  const widthSpy = vi
    .spyOn(HTMLElement.prototype, "offsetWidth", "get")
    .mockReturnValue(800);
  restoreLayoutGeometry = () => {
    heightSpy.mockRestore();
    widthSpy.mockRestore();
  };
  reachability.value = "reachable";
  defaultHostSupport.value = "supported";
  boundHostSupport.value = "supported";
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  useEpicCanvasStore.setState({
    tabsById: { [TAB_ID]: { tabId: TAB_ID, epicId: EPIC_ID, name: "Epic 1" } },
    openTabOrder: [TAB_ID],
    activeTabId: TAB_ID,
  });
  epicHandle = createOpenEpicStore({
    epicId: EPIC_ID,
    streamClientFactory: noopStreamClientFactory,
    userId: null,
    onAuthError: null,
  });
});

afterEach(() => {
  cleanup();
  restoreLayoutGeometry();
  __setManagedCommandOutputStreamClientFactoryForTests(null);
  epicHandle.dispose();
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  useTileFindStore.getState().resetForTests();
  useSettingsStore.setState({
    terminalFontFamily: null,
    terminalFontSize: null,
    codeFontFamily: null,
    codeFontSize: DEFAULT_CODE_FONT_SIZE,
  });
});

describe("<ManagedCommandOutputTile /> tile find", () => {
  it("registers a searchable adapter once the log is readable", async () => {
    const stub = installOutputStub();
    const node = renderTile();
    openAtTail(stub.emit, [line("stdout", "watching src/")], true);

    await waitForSearchable(node);
    expect(tileSnapshot(node)).toMatchObject({
      status: "idle",
      coverageMessage: null,
    });
    expect(tileSnapshot(node).capabilities.has("find")).toBe(true);
  });

  it("paints distinct active and inactive matches and disables follow on reveal", async () => {
    const stub = installOutputStub();
    const node = renderTile();
    openAtTail(
      stub.emit,
      [line("stdout", "ab cd ab"), line("stdout", "ab later")],
      true,
    );

    await waitForSearchable(node);
    // The precondition the rest of this test rests on: the tile opens at the
    // tail following live output, so the jump-live button is absent. Without
    // this, the assertion below proves only that the button is present, not
    // that the search is what turned following off.
    expect(queryJumpLive()).toBeNull();
    searchTile(node, "ab", false);

    await waitFor(() => {
      expect(tileSnapshot(node).total).toBe(3);
    });
    expect(tileSnapshot(node)).toMatchObject({
      status: "ready",
      current: 1,
      activeUnitId: `${node.instanceId}:line-0`,
      exactHighlight: "painted",
    });
    expect(
      screen.getByTestId("managed-command-output-find-match-active")
        .textContent,
    ).toBe("ab");
    expect(
      screen
        .getByTestId("managed-command-output-find-match-active")
        .getAttribute("data-start-col"),
    ).toBe("0");
    expect(
      screen
        .getAllByTestId("managed-command-output-find-match")
        .map((el) => el.getAttribute("data-start-col")),
    ).toEqual(["6", "0"]);
    expect(screen.getByRole("button", { name: "Jump to live" })).toBeTruthy();

    act(() => {
      useTileFindStore.getState().next(node.instanceId);
    });

    expect(tileSnapshot(node).current).toBe(2);
    await waitFor(() => {
      expect(
        screen
          .getByTestId("managed-command-output-find-match-active")
          .getAttribute("data-start-col"),
      ).toBe("6");
    });
  });

  it("keeps following live output when a rebase re-clamps the active match", async () => {
    const stub = installOutputStub();
    const node = renderTile();
    openAtTail(
      stub.emit,
      [line("stdout", "alpha one"), line("stdout", "alpha two")],
      true,
    );

    await waitForSearchable(node);
    searchTile(node, "alpha", false);
    await waitFor(() => {
      expect(tileSnapshot(node).total).toBe(2);
    });
    expect(screen.getByRole("button", { name: "Jump to live" })).toBeTruthy();

    // A replacement snapshot renumbers every line, so the seq holding the
    // active match is gone and the adapter clamps to a different one. That is a
    // re-scan, not a find command: it must not reveal, because the tile drops
    // follow mode on reveal and the rebase has just restored it.
    openAtTail(
      stub.emit,
      [line("stdout", "alpha three"), line("stdout", "alpha four")],
      true,
    );

    await waitFor(() => {
      expect(tileSnapshot(node).total).toBe(2);
    });
    expect(queryJumpLive()).toBeNull();
    expect(tileSnapshot(node)).toMatchObject({
      status: "ready",
      current: 1,
      exactHighlight: "painted",
    });
  });

  it("reports partial coverage while older history is not loaded", async () => {
    const stub = installOutputStub();
    const node = renderTile();
    openAtTail(stub.emit, [line("stdout", "needle")], false);

    await waitForSearchable(node);
    searchTile(node, "needle", false);

    expect(tileSnapshot(node)).toMatchObject({
      status: "partial",
      coverageMessage: MANAGED_COMMAND_OUTPUT_FIND_COVERAGE_MESSAGE,
      total: 1,
      current: 1,
    });
  });

  it("reports loading output as unavailable", async () => {
    installOutputStub();
    const node = renderTile();

    await waitFor(() => {
      expect(tileSnapshot(node).coverageMessage).toBe(
        "Output is still loading.",
      );
    });
    searchTile(node, "needle", false);
    expect(tileSnapshot(node)).toMatchObject({
      status: "unavailable",
      coverageMessage: "Output is still loading.",
      total: 0,
    });
    expect(tileSnapshot(node).capabilities.has("find")).toBe(false);
  });
});

async function waitForSearchable(
  node: ManagedCommandOutputTileRef,
): Promise<void> {
  await waitFor(() => {
    expect(tileSnapshot(node).capabilities.has("find")).toBe(true);
  });
}

function searchTile(
  node: ManagedCommandOutputTileRef,
  query: string,
  matchCase: boolean,
): void {
  act(() => {
    const store = useTileFindStore.getState();
    store.openForTile(node.instanceId);
    store.setMatchCase(node.instanceId, matchCase);
    store.setQuery(node.instanceId, query);
    store.search(node.instanceId);
  });
}

function tileSnapshot(
  node: ManagedCommandOutputTileRef,
): TileFindStateSnapshot {
  const snapshot =
    useTileFindStore.getState().uiByTileInstanceId[node.instanceId]
      ?.lastSnapshot;
  if (snapshot === undefined) {
    throw new Error(`Missing tile find snapshot for ${node.instanceId}`);
  }
  return snapshot;
}
