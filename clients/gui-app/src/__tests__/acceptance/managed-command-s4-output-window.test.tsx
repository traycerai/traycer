/**
 * Independent acceptance suite — seam S4: the managed-command output window.
 *
 * Expected behavior comes from the records (`traycer-host/src/domain/
 * managed-command/UI.md` §§3-4, 9, 9a and root `CONTEXT.md`), never from the
 * component code. The tile, its session hook, its zustand store and the epic
 * canvas store are all real; the one seam faked is the WebSocket stream
 * client, replaced through the production factory override. Every frame fed
 * in is first parsed through the wire contract's own server-frame schema, so
 * each fixture is a frame a host could actually have sent.
 *
 * jsdom limitation, handled explicitly: follow-mode and load-older read live
 * scroll geometry (`scrollHeight`/`clientHeight`) that jsdom never lays out.
 * Geometry is injected per element; the scroll DECISIONS under test remain
 * the component's own.
 */
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ManagedCommandOutputTile } from "@/components/epic-canvas/renderers/managed-command-output-tile";
import { EpicSessionContext } from "@/lib/registries/epic-session-registry";
import {
  createOpenEpicStore,
  type EpicStreamClientFactory,
  type OpenEpicStoreHandle,
} from "@/stores/epics/open-epic/store";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { findOpenArtifactInTab } from "@/stores/epics/canvas/canvas-selectors";
import { makeManagedCommandOutputTileRef } from "@/stores/epics/canvas/tile-schema/managed-command-output-tile";
import { __setManagedCommandOutputStreamClientFactoryForTests } from "@/providers/managed-command-output-stream-factory-override";
import type { ManagedCommandOutputStreamCallbacks } from "@traycer-clients/shared/host-transport/managed-command-output-stream-client";
import {
  managedCommandSubscribeOutputClientFrameSchema,
  managedCommandSubscribeOutputServerFrameSchema,
} from "@traycer/protocol/host/managed-command/subscribe";
import type {
  ManagedCommandLogLine,
  ManagedCommandLogPosition,
  ManagedCommandSubscribeOutputClientFrame,
  ManagedCommandSubscribeOutputServerFrame,
} from "@traycer/protocol/host/managed-command/subscribe";
import { managedCommandSchema } from "@traycer/protocol/host/managed-command/unary-schemas";
import type { ManagedCommand } from "@traycer/protocol/host/managed-command/unary-schemas";

const mocks = vi.hoisted(() => ({
  reachability: {
    value: "reachable",
  },
  startMutate: vi.fn(),
  stopMutate: vi.fn(),
  deleteMutate: vi.fn(),
}));

vi.mock("@/hooks/agent/use-host-reachability", () => ({
  useHostReachability: (hostId: string) => ({
    status: mocks.reachability.value,
    hostLabel: `host ${hostId}`,
  }),
}));

vi.mock(
  "@/hooks/managed-command/use-managed-command-lifecycle-mutations",
  () => ({
    useManagedCommandStart: () => ({
      mutate: mocks.startMutate,
      isPending: false,
    }),
    useManagedCommandStop: () => ({
      mutate: mocks.stopMutate,
      isPending: false,
    }),
    useManagedCommandDelete: () => ({
      mutate: mocks.deleteMutate,
      isPending: false,
    }),
    useManagedCommandStopAllIsPending: () => false,
  }),
);

// Dialing the real durable transport from a test would be a silent fall-through
// past the factory override; make it unmissable instead.
vi.mock("@/lib/host/use-durable-stream-transport", () => ({
  useDurableStreamTransportFactory: () => () => {
    throw new Error("acceptance: the real stream transport must not be dialed");
  },
}));

const EPIC_ID = "epic-s4";
const TAB_ID = "tab-s4";
const HOST_ID = "host-1";
const COMMAND_ID = "cmd-s4-0001";
const T0 = 1_722_000_000_000;

const noopEpicStreamClientFactory: EpicStreamClientFactory = () => ({
  applyUpdate: () => undefined,
  awareness: () => undefined,
  applyArtifactRoomUpdate: () => undefined,
  artifactRoomAwareness: () => undefined,
  retryMigration: () => undefined,
  close: () => undefined,
});

interface OutputWire {
  readonly callbacks: ManagedCommandOutputStreamCallbacks;
  readonly sentLoadOlder: ManagedCommandSubscribeOutputClientFrame[];
}

let wire: OutputWire | null = null;
let epicHandle: OpenEpicStoreHandle | null = null;

function installOutputWire(): void {
  __setManagedCommandOutputStreamClientFactoryForTests(
    (_epicId, _commandId, callbacks) => {
      const current: OutputWire = { callbacks, sentLoadOlder: [] };
      wire = current;
      return {
        loadOlder: (frame) => {
          // Everything the viewer sends must itself be a valid client frame.
          current.sentLoadOlder.push(
            managedCommandSubscribeOutputClientFrameSchema.parse(frame),
          );
        },
        close: () => undefined,
      };
    },
  );
}

function connectedWire(): OutputWire {
  if (wire === null) {
    throw new Error("acceptance: the output stream was never opened");
  }
  return wire;
}

function makeCommand(over: Partial<ManagedCommand>): ManagedCommand {
  return managedCommandSchema.parse({
    id: COMMAND_ID,
    kind: "monitor",
    description: "deploy watcher",
    status: { state: "running", pid: 4410, startedAtMs: T0 },
    chatId: "chat-owner",
    createdAtMs: T0,
    updatedAtMs: T0,
    ...over,
  });
}

function parseServerFrame(
  frame: unknown,
): ManagedCommandSubscribeOutputServerFrame {
  return managedCommandSubscribeOutputServerFrameSchema.parse(frame);
}

function emitSnapshot(input: {
  readonly command: ManagedCommand;
  readonly lines: readonly ManagedCommandLogLine[];
  readonly start: ManagedCommandLogPosition;
  readonly reachedStart: boolean;
}): void {
  const frame = parseServerFrame({
    kind: "snapshot",
    hasBinaryPayload: false,
    ...input,
  });
  if (frame.kind !== "snapshot") throw new Error("unreachable");
  act(() => {
    connectedWire().callbacks.onSnapshot({
      command: frame.command,
      lines: frame.lines,
      start: frame.start,
      reachedStart: frame.reachedStart,
    });
  });
}

function emitOutput(lines: readonly ManagedCommandLogLine[]): void {
  const frame = parseServerFrame({
    kind: "output",
    hasBinaryPayload: false,
    lines,
  });
  if (frame.kind !== "output") throw new Error("unreachable");
  act(() => {
    connectedWire().callbacks.onOutput(frame.lines);
  });
}

function emitOlder(input: {
  readonly requestId: string;
  readonly lines: readonly ManagedCommandLogLine[];
  readonly start: ManagedCommandLogPosition;
  readonly reachedStart: boolean;
}): void {
  const frame = parseServerFrame({
    kind: "older",
    hasBinaryPayload: false,
    ...input,
  });
  if (frame.kind !== "older") throw new Error("unreachable");
  act(() => {
    connectedWire().callbacks.onOlder({
      requestId: frame.requestId,
      lines: frame.lines,
      start: frame.start,
      reachedStart: frame.reachedStart,
    });
  });
}

function emitStatus(command: ManagedCommand): void {
  const frame = parseServerFrame({
    kind: "status",
    hasBinaryPayload: false,
    command,
  });
  if (frame.kind !== "status") throw new Error("unreachable");
  act(() => {
    connectedWire().callbacks.onStatus(frame.command);
  });
}

function emitDeleted(): void {
  const frame = parseServerFrame({ kind: "deleted", hasBinaryPayload: false });
  if (frame.kind !== "deleted") throw new Error("unreachable");
  act(() => {
    connectedWire().callbacks.onDeleted();
  });
}

function renderTile(): void {
  epicHandle = createOpenEpicStore({
    epicId: EPIC_ID,
    streamClientFactory: noopEpicStreamClientFactory,
    userId: null,
    onAuthError: null,
  });
  const node = makeManagedCommandOutputTileRef({
    commandId: COMMAND_ID,
    hostId: HOST_ID,
  });
  useEpicCanvasStore.getState().openTileInTab(TAB_ID, node);
  const opened = findOpenArtifactInTab(TAB_ID, COMMAND_ID);
  if (opened === null) throw new Error("acceptance: tile did not open");
  render(
    <EpicSessionContext.Provider value={epicHandle}>
      <TooltipProvider>
        <ManagedCommandOutputTile
          node={node}
          viewTabId={TAB_ID}
          tileId={opened.paneId}
          epicId={EPIC_ID}
        />
      </TooltipProvider>
    </EpicSessionContext.Provider>,
  );
}

function timelineRows(): HTMLElement[] {
  const timeline = screen.getByTestId("managed-command-output-timeline");
  return Array.from(
    timeline.querySelectorAll<HTMLElement>(
      '[data-testid^="managed-command-output-line-"]',
    ),
  );
}

function setScrollGeometry(
  element: HTMLElement,
  geometry: {
    readonly scrollTop: number;
    readonly scrollHeight: number;
    readonly clientHeight: number;
  },
): void {
  Object.defineProperty(element, "scrollHeight", {
    configurable: true,
    value: geometry.scrollHeight,
  });
  Object.defineProperty(element, "clientHeight", {
    configurable: true,
    value: geometry.clientHeight,
  });
  element.scrollTop = geometry.scrollTop;
}

const START: ManagedCommandLogPosition = { segmentId: "seg-2", byteOffset: 0 };

beforeEach(() => {
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  useEpicCanvasStore.setState({
    tabsById: { [TAB_ID]: { tabId: TAB_ID, epicId: EPIC_ID, name: "Epic" } },
    openTabOrder: [TAB_ID],
    activeTabId: TAB_ID,
  });
  mocks.reachability.value = "reachable";
  installOutputWire();
});

afterEach(() => {
  cleanup();
  __setManagedCommandOutputStreamClientFactoryForTests(null);
  epicHandle?.dispose();
  epicHandle = null;
  wire = null;
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  vi.clearAllMocks();
});

describe("S4 · output window", () => {
  it("S4a: renders one interleaved timeline — stdout, tinted stderr, distinct lifecycle rows, timestamps on every line", () => {
    renderTile();
    emitSnapshot({
      command: makeCommand({}),
      lines: [
        {
          channel: "lifecycle",
          text: "started (pid 4410, manual, shell: /bin/sh)",
          atMs: T0,
        },
        { channel: "stdout", text: "building bundle 1/3", atMs: T0 + 1_000 },
        { channel: "stderr", text: "warning: low disk", atMs: T0 + 2_000 },
        // A partial record left by a crash: no timestamp, still shown.
        { channel: "stdout", text: "half-written record", atMs: null },
      ],
      start: START,
      reachedStart: true,
    });

    // Kind-explicit naming (UI.md §3): the record's own example copy.
    expect(screen.getByTestId("managed-command-output-title").textContent).toBe(
      "Monitor · deploy watcher",
    );
    expect(
      screen.getByTestId("managed-command-output-status").textContent,
    ).toMatch(/running/i);

    const rows = timelineRows();
    expect(rows.map((row) => row.getAttribute("data-channel"))).toEqual([
      "lifecycle",
      "stdout",
      "stderr",
      "stdout",
    ]);
    expect(rows[0].textContent).toContain(
      "started (pid 4410, manual, shell: /bin/sh)",
    );
    expect(rows[1].textContent).toContain("building bundle 1/3");
    expect(rows[2].textContent).toContain("warning: low disk");
    expect(rows[3].textContent).toContain("half-written record");

    // "Tinted stderr" and "visually distinct" lifecycle rows (UI.md §4): the
    // three channels must not share one presentation.
    const textSpanOf = (row: HTMLElement): string => {
      const spans = row.querySelectorAll("span");
      return spans[spans.length - 1].className;
    };
    expect(textSpanOf(rows[2])).not.toBe(textSpanOf(rows[1]));
    expect(textSpanOf(rows[0])).not.toBe(textSpanOf(rows[1]));

    // Timestamps shown by default on every line (UI.md §4). A line the host
    // could not date still gets a visible placeholder, not a missing cell.
    for (const [index, row] of rows.entries()) {
      const time = within(row).getByTestId(
        `managed-command-output-time-${index}`,
      );
      expect(time.textContent).not.toBe("");
    }
    expect(
      within(rows[1]).getByTestId("managed-command-output-time-1").textContent,
    ).toMatch(/\d{1,2}:\d{2}:\d{2}/);

    // Live lines append to the same single timeline — no separate panel.
    emitOutput([
      { channel: "stdout", text: "deploy ok", atMs: T0 + 3_000 },
      { channel: "lifecycle", text: "exited (code 0)", atMs: T0 + 4_000 },
    ]);
    const grown = timelineRows();
    expect(grown).toHaveLength(6);
    expect(grown[4].textContent).toContain("deploy ok");
    expect(grown[5].getAttribute("data-channel")).toBe("lifecycle");
    expect(grown[5].textContent).toContain("exited (code 0)");

    // A status frame moves the header, kind copy intact.
    emitStatus(
      makeCommand({
        status: {
          state: "exited",
          exitCode: 1,
          signal: null,
          exitedAtMs: T0 + 4_000,
        },
      }),
    );
    expect(
      screen.getByTestId("managed-command-output-status").textContent,
    ).toMatch(/exited/i);
  });

  it("S4b: follows by default, pauses when the human scrolls up, and offers jump-to-live", () => {
    renderTile();
    emitSnapshot({
      command: makeCommand({}),
      lines: [{ channel: "stdout", text: "line 0", atMs: T0 }],
      start: START,
      reachedStart: true,
    });
    const view = screen.getByTestId("managed-command-output-timeline");
    setScrollGeometry(view, {
      scrollTop: 0,
      scrollHeight: 1_000,
      clientHeight: 200,
    });

    // Follow mode by default: a new line pins the view back to the newest.
    emitOutput([{ channel: "stdout", text: "line 1", atMs: T0 + 1 }]);
    expect(view.scrollTop).toBe(1_000);
    expect(screen.queryByTestId("managed-command-output-jump-live")).toBeNull();

    // Scrolling up pauses following...
    setScrollGeometry(view, {
      scrollTop: 100,
      scrollHeight: 1_000,
      clientHeight: 200,
    });
    fireEvent.scroll(view);
    expect(screen.getByTestId("managed-command-output-jump-live")).toBeTruthy();

    // ...so new lines no longer move the view.
    emitOutput([{ channel: "stdout", text: "line 2", atMs: T0 + 2 }]);
    expect(view.scrollTop).toBe(100);

    // The jump-to-live affordance resumes following.
    fireEvent.click(screen.getByTestId("managed-command-output-jump-live"));
    expect(view.scrollTop).toBe(1_000);
    expect(screen.queryByTestId("managed-command-output-jump-live")).toBeNull();
    emitOutput([{ channel: "stdout", text: "line 3", atMs: T0 + 3 }]);
    expect(view.scrollTop).toBe(1_000);
  });

  it("S4c: scrolling to the top loads older lines on demand, drops outrun pages, and stops at the start of the retained log", () => {
    renderTile();
    emitSnapshot({
      command: makeCommand({}),
      lines: [
        { channel: "stdout", text: "recent tail line", atMs: T0 + 10_000 },
      ],
      start: START,
      reachedStart: false,
    });
    const view = screen.getByTestId("managed-command-output-timeline");
    setScrollGeometry(view, {
      scrollTop: 10,
      scrollHeight: 1_000,
      clientHeight: 200,
    });
    fireEvent.scroll(view);

    const sent = connectedWire().sentLoadOlder;
    expect(sent).toHaveLength(1);
    const request = sent[0];
    if (request.kind !== "loadOlder") throw new Error("unreachable");
    // The viewer pages from exactly where its held lines begin, in windows the
    // wire contract allows.
    expect(request.before).toEqual(START);
    expect(request.requestId).not.toBe("");
    expect(request.maxLines).toBeGreaterThan(0);
    expect(request.maxLines).toBeLessThanOrEqual(2_000);
    expect(
      screen.getByTestId("managed-command-output-loading-older"),
    ).toBeTruthy();

    // A page for a request this one outran is dropped, not spliced in.
    emitOlder({
      requestId: "stale-request",
      lines: [{ channel: "stdout", text: "stale page line", atMs: T0 }],
      start: { segmentId: "seg-0", byteOffset: 0 },
      reachedStart: false,
    });
    expect(screen.queryByText("stale page line")).toBeNull();

    emitOlder({
      requestId: request.requestId,
      lines: [
        { channel: "stdout", text: "older line A", atMs: T0 + 1_000 },
        { channel: "stderr", text: "older line B", atMs: T0 + 2_000 },
      ],
      start: { segmentId: "seg-1", byteOffset: 0 },
      reachedStart: true,
    });

    // Prepended above the tail it already held, oldest first.
    const rows = timelineRows();
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining("older line A"),
      expect.stringContaining("older line B"),
      expect.stringContaining("recent tail line"),
    ]);
    expect(screen.getByText("Start of the retained log")).toBeTruthy();

    // Nothing older is retained; the viewer stops asking.
    setScrollGeometry(view, {
      scrollTop: 0,
      scrollHeight: 1_000,
      clientHeight: 200,
    });
    fireEvent.scroll(view);
    expect(connectedWire().sentLoadOlder).toHaveLength(1);
  });

  it("S4d: a deleted command shows the dead-state banner over the retained scrollback, loses its lifecycle actions, and stays closeable", () => {
    renderTile();
    emitSnapshot({
      command: makeCommand({}),
      lines: [
        { channel: "stdout", text: "last words", atMs: T0 },
        { channel: "lifecycle", text: "exited (code 0)", atMs: T0 + 1 },
      ],
      start: START,
      reachedStart: true,
    });
    expect(
      screen.getByTestId(`managed-command-stop-${COMMAND_ID}`),
    ).toBeTruthy();

    emitDeleted();

    const banner = screen.getByTestId("managed-command-output-deleted");
    expect(banner).toBeTruthy();
    // Scrollback survives under the banner — the last trace of a destroyed
    // history stays readable.
    expect(screen.getByText("last words")).toBeTruthy();
    // The command is gone, not merely stopped: no lifecycle action remains.
    expect(
      screen.queryByTestId(`managed-command-stop-${COMMAND_ID}`),
    ).toBeNull();
    expect(
      screen.queryByTestId(`managed-command-start-${COMMAND_ID}`),
    ).toBeNull();
    expect(
      screen.queryByTestId(`managed-command-delete-${COMMAND_ID}`),
    ).toBeNull();

    // The window remains closeable from the banner itself.
    fireEvent.click(within(banner).getByRole("button"));
    expect(findOpenArtifactInTab(TAB_ID, COMMAND_ID)).toBeNull();
  });

  it("S4e: an unreachable host shows the connection overlay instead of a viewer — the stream is never dialed", () => {
    mocks.reachability.value = "unreachable";
    renderTile();
    expect(
      screen.getByTestId("managed-command-output-unreachable"),
    ).toBeTruthy();
    expect(screen.queryByTestId("managed-command-output-timeline")).toBeNull();
    expect(wire).toBeNull();
  });
});
