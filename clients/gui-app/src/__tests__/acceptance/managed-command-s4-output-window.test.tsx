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
import type { StreamMethodSupportSource } from "@/lib/host/stream-runtime-context";
import type { ManagedCommandOutputStreamCallbacks } from "@traycer-clients/shared/host-transport/managed-command-output-stream-client";
import type { StreamMethodSupport } from "@traycer-clients/shared/host-transport/ws-stream-client";
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
import type { FatalErrorDetails } from "@traycer/protocol/framework/ws-protocol";
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
  resolvedHostLabel: (r: {
    readonly status: string;
    readonly hostLabel: string;
  }) => (r.status === "checking" ? null : r.hostLabel),
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
//
// Hoisted to ONE instance so the opener is referentially stable across renders,
// matching the real hook — see the note at
// `lib/registries/__tests__/chat-session-registry.test.ts` for what a
// fresh-closure-per-render mock does to the effects that depend on it.
const refuseDurableTransport = vi.hoisted(() => () => {
  throw new Error("acceptance: the real stream transport must not be dialed");
});
vi.mock("@/lib/host/use-durable-stream-transport", () => ({
  useDurableStreamTransportFactory: () => refuseDurableTransport,
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
// Counts every stream open, mount and Retry alike - a Retry test's proof that
// it opened a NEW stream rather than resuming the failed one.
let outputWireFactoryCalls = 0;

function methodSupportStub(
  support: StreamMethodSupport,
): StreamMethodSupportSource {
  return {
    getMethodSupport: () => support,
    subscribeMethodSupport: () => () => undefined,
  };
}

function installOutputWire(over: {
  readonly streamMethodSupport: StreamMethodSupportSource | null;
}): void {
  __setManagedCommandOutputStreamClientFactoryForTests(
    (_epicId, _commandId, callbacks) => {
      outputWireFactoryCalls += 1;
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
        streamMethodSupport: over.streamMethodSupport,
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

/** A close that is about the stream, not the shell - the host's own reader threw. */
function fatalErrorDetails(code: string, reason: string): FatalErrorDetails {
  return { code, reason, incompatibleMethods: null, upgradeGuidance: null };
}

function makeCommand(over: Partial<ManagedCommand>): ManagedCommand {
  return managedCommandSchema.parse({
    id: COMMAND_ID,
    monitoring: true,
    description: "deploy watcher",
    command: "tail -f deploy.log",
    cwd: "/work/repo",
    cadence: { debounceMs: 500, maxWaitMs: 15_000, throttleMs: 5_000 },
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
  outputWireFactoryCalls = 0;
  installOutputWire({ streamMethodSupport: null });
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

    // The window carries no title of its own: identity lives in the tab, and a
    // bar here would restate the tab's own "Monitor · deploy watcher" over the
    // one thing a reader came for. What floats over the log is live state.
    expect(screen.queryByTestId("managed-command-output-title")).toBeNull();
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

  it("S4d: a deleted command replaces the whole window with a terminal notice - no scrollback, no lifecycle actions, still closeable", () => {
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

    const panel = screen.getByTestId("managed-command-output-availability");
    expect(screen.getByText("This shell was deleted.")).toBeTruthy();
    expect(panel.getAttribute("data-availability")).toBe("gone");
    expect(panel.getAttribute("data-cause")).toBe("deleted");
    // The history went with the shell - no ghost of the retained log stays on
    // screen under the terminal notice.
    expect(screen.queryByText("last words")).toBeNull();
    expect(screen.queryByTestId("managed-command-output-timeline")).toBeNull();
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

    fireEvent.click(screen.getByRole("button", { name: "Close tab" }));
    expect(findOpenArtifactInTab(TAB_ID, COMMAND_ID)).toBeNull();
  });

  it("S4e: an unreachable host shows the connection overlay instead of a viewer — the stream is never dialed", () => {
    mocks.reachability.value = "unreachable";
    renderTile();

    const panel = screen.getByTestId("managed-command-output-availability");
    expect(
      screen.getByText(
        'Host "host host-1" is unreachable, so this output cannot be read. The shell and its log are kept on that host.',
      ),
    ).toBeTruthy();
    expect(panel.getAttribute("data-availability")).toBe("unreachable-host");
    expect(screen.queryByTestId("managed-command-output-timeline")).toBeNull();
    expect(wire).toBeNull();
  });

  it("S4f: a NOT_FOUND close before any snapshot reads as a shell the host no longer has", () => {
    renderTile();

    act(() => {
      connectedWire().callbacks.onConnectionStatus("closed", {
        kind: "fatalError",
        details: fatalErrorDetails(
          "MANAGED_COMMAND_NOT_FOUND",
          "MANAGED_COMMAND_NOT_FOUND: no such managed command in this epic",
        ),
      });
    });

    const panel = screen.getByTestId("managed-command-output-availability");
    expect(
      screen.getByText("This shell is no longer on this host."),
    ).toBeTruthy();
    expect(panel.getAttribute("data-cause")).toBe("not-found");
    expect(screen.getByRole("button", { name: "Close tab" })).toBeTruthy();
    expect(screen.queryByTestId("managed-command-output-timeline")).toBeNull();
  });

  it("S4f: an UNAUTHORIZED close after a snapshot drops the cached lines and the viewer's access", () => {
    renderTile();
    emitSnapshot({
      command: makeCommand({}),
      lines: [{ channel: "stdout", text: "last words", atMs: T0 }],
      start: START,
      reachedStart: true,
    });

    act(() => {
      connectedWire().callbacks.onConnectionStatus("closed", {
        kind: "fatalError",
        details: fatalErrorDetails(
          "UNAUTHORIZED",
          "UNAUTHORIZED: role revoked",
        ),
      });
    });

    expect(
      screen.getByText("You no longer have access to this epic's shells."),
    ).toBeTruthy();
    expect(screen.queryByText("last words")).toBeNull();
    expect(
      screen.queryByTestId(`managed-command-stop-${COMMAND_ID}`),
    ).toBeNull();
  });

  it("S4f: a stream failure after a snapshot keeps the scrollback and lifecycle actions, and Retry opens a fresh stream", () => {
    renderTile();
    emitSnapshot({
      command: makeCommand({}),
      lines: [{ channel: "stdout", text: "before the failure", atMs: T0 }],
      start: START,
      reachedStart: true,
    });
    const firstWire = connectedWire();
    const callsBeforeRetry = outputWireFactoryCalls;

    act(() => {
      firstWire.callbacks.onConnectionStatus("closed", {
        kind: "fatalError",
        details: fatalErrorDetails(
          "MANAGED_COMMAND_OUTPUT_FAILED",
          "MANAGED_COMMAND_OUTPUT_FAILED: log reader crashed",
        ),
      });
    });

    const banner = screen.getByTestId("managed-command-output-availability");
    expect(banner.getAttribute("data-availability")).toBe("stream-error");
    expect(banner.textContent).toContain("The output stream failed.");
    // The stream failed, not the shell - its own history and controls stay.
    expect(screen.getByText("before the failure")).toBeTruthy();
    expect(
      screen.getByTestId(`managed-command-stop-${COMMAND_ID}`),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    // Retry tears the failed store down and dials a brand new stream.
    expect(outputWireFactoryCalls).toBe(callsBeforeRetry + 1);
    expect(connectedWire()).not.toBe(firstWire);
    expect(screen.queryByText("before the failure")).toBeNull();
    expect(screen.getByText("Connecting…")).toBeTruthy();

    emitSnapshot({
      command: makeCommand({}),
      lines: [{ channel: "stdout", text: "after the retry", atMs: T0 + 1 }],
      start: START,
      reachedStart: true,
    });

    expect(screen.getByText("after the retry")).toBeTruthy();
  });

  it("S4g: reads 'Connecting…' as a centred panel until a snapshot lands whatever the transport says, then an empty tail as 'No output yet.'", () => {
    renderTile();

    // Before the opening snapshot there is nothing to keep in view, so the
    // window is a centred connecting panel - the timeline is not mounted yet,
    // and no strip sits along the top where a header bar used to.
    expect(screen.queryByTestId("managed-command-output-timeline")).toBeNull();
    expect(screen.getByText("Connecting…")).toBeTruthy();

    // The socket declaring itself open is not the snapshot landing.
    act(() => {
      connectedWire().callbacks.onConnectionStatus("open", null);
    });
    expect(screen.getByText("Connecting…")).toBeTruthy();

    emitSnapshot({
      command: makeCommand({}),
      lines: [],
      start: START,
      reachedStart: true,
    });

    expect(screen.queryByText("Connecting…")).toBeNull();
    const timelineEl = screen.getByTestId("managed-command-output-timeline");
    expect(within(timelineEl).getByText("No output yet.")).toBeTruthy();
    expect(screen.getByTestId("managed-command-output-status")).toBeTruthy();
  });

  it("S4h: a fatal close during an in-flight older-page request clears the spinner and stops paging", () => {
    renderTile();
    emitSnapshot({
      command: makeCommand({}),
      lines: [{ channel: "stdout", text: "recent tail line", atMs: T0 }],
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

    expect(connectedWire().sentLoadOlder).toHaveLength(1);
    expect(
      screen.getByTestId("managed-command-output-loading-older"),
    ).toBeTruthy();

    act(() => {
      connectedWire().callbacks.onConnectionStatus("closed", {
        kind: "fatalError",
        details: fatalErrorDetails(
          "MANAGED_COMMAND_OUTPUT_FAILED",
          "MANAGED_COMMAND_OUTPUT_FAILED: log reader crashed",
        ),
      });
    });

    expect(
      screen.queryByTestId("managed-command-output-loading-older"),
    ).toBeNull();

    setScrollGeometry(view, {
      scrollTop: 0,
      scrollHeight: 1_000,
      clientHeight: 200,
    });
    fireEvent.scroll(view);
    expect(connectedWire().sentLoadOlder).toHaveLength(1);
  });

  it("S4i: a bound host that cannot serve the stream reads as too old, with no timeline - read through the wire's own capability, not the app default", () => {
    installOutputWire({
      streamMethodSupport: methodSupportStub("unsupported"),
    });
    renderTile();

    const panel = screen.getByTestId("managed-command-output-availability");
    expect(
      screen.getByText("This host is too old to show shells."),
    ).toBeTruthy();
    expect(panel.getAttribute("data-availability")).toBe("unsupported-host");
    expect(screen.queryByTestId("managed-command-output-timeline")).toBeNull();
    expect(screen.queryByRole("button", { name: "Close tab" })).toBeNull();
  });
});
