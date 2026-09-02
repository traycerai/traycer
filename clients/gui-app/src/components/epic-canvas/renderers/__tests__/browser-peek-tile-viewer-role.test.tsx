import "../../../../../__tests__/test-browser-apis";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearScreencastOwner,
  FakeStreamClient,
  hostDirectoryEntryModule,
  hostStreamClientForWithAuthModule,
  liveStream as fixtureLiveStream,
  PEEK_NODE,
  runnerOpenExternalLinkModule,
  streamAuthRevalidatorModule,
  tabHostIdModule,
  tileBodyVisibleModule,
  type FakeStreamSession,
} from "@/components/epic-canvas/renderers/__tests__/browser-peek-tile-stream-fixture";
import { BrowserPeekTile } from "@/components/epic-canvas/renderers/browser-peek-tile";

const toast = vi.hoisted(() => vi.fn());

const hookState = vi.hoisted(() => ({
  streamClient: null as FakeStreamClient | null,
  visible: true,
  // What `screencastRoleForShell` reads: a shell with no `BrowserView` of its
  // own (the web bundle, the mobile shell) subscribes as a `viewer`.
  browserView: null as object | null,
}));

vi.mock("sonner", () => ({ toast }));

vi.mock("@/providers/use-runner-host", () => ({
  useRunnerHostOrNull: () => ({ browserView: hookState.browserView }),
}));

vi.mock("@/hooks/runner/use-open-external-link-mutation", () =>
  runnerOpenExternalLinkModule(),
);

vi.mock("@/components/epic-canvas/hooks/use-tab-host-id", () =>
  tabHostIdModule(),
);

vi.mock("@/components/epic-canvas/hooks/use-tile-body-visible", () =>
  tileBodyVisibleModule(hookState),
);

vi.mock("@/hooks/host/use-host-directory-entry", () =>
  hostDirectoryEntryModule(),
);

vi.mock("@/hooks/host/use-host-stream-client-for", () =>
  hostStreamClientForWithAuthModule(hookState),
);

vi.mock("@/lib/host/stream-auth-revalidator", () =>
  streamAuthRevalidatorModule(),
);

/** Every client frame the host refuses from a read-only tier (H07). */
const PASSIVE_FRAME_KINDS = [
  "arm",
  "preArm",
  "disarm",
  "pointer",
  "keyboard",
  "insertText",
  "dialogResponse",
  "navigate",
  "goBack",
  "goForward",
  "reload",
];

function renderPeekTile(): void {
  render(
    <BrowserPeekTile
      viewTabId="view-tab-1"
      paneId="pane-1"
      epicId="epic-1"
      node={PEEK_NODE}
      completeMeans="ended"
    />,
  );
}

function liveStream(): FakeStreamSession {
  return fixtureLiveStream(hookState);
}

function subscribedRole(): unknown {
  const subscribe = hookState.streamClient?.subscribes.at(-1);
  if (subscribe === undefined) throw new Error("expected a subscribe");
  const params = subscribe.params;
  if (typeof params !== "object" || params === null) {
    throw new Error("expected subscribe params");
  }
  return Reflect.get(params, "role");
}

function refusedFrames(stream: FakeStreamSession): unknown[] {
  return stream.sentFrames.filter((frame) =>
    PASSIVE_FRAME_KINDS.includes(String(frame.kind)),
  );
}

function readOnlySurface(): HTMLElement {
  return screen.getByTestId("browser-screencast-view");
}

describe("BrowserPeekTile viewer role", () => {
  beforeEach(() => {
    hookState.visible = true;
    hookState.browserView = null;
    hookState.streamClient = new FakeStreamClient(true);
    toast.mockClear();
    clearScreencastOwner();
  });

  afterEach(() => {
    cleanup();
    clearScreencastOwner();
    vi.restoreAllMocks();
  });

  it("renders no arm or input affordance", () => {
    renderPeekTile();

    expect(subscribedRole()).toBe("viewer");
    expect(
      screen.queryByRole("button", { name: "Browser screencast controls" }),
    ).toBeNull();
    expect(screen.queryByRole("textbox", { name: "Browser IME input" })).toBe(
      null,
    );
    expect(
      screen.getByRole("textbox", { name: "Browser address" }),
    ).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: "Reload" })).toHaveProperty(
      "disabled",
      true,
    );
    expect(screen.getByText("View only")).not.toBeNull();
  });

  it("sends nothing and shows nothing when a gesture lands on the surface", () => {
    renderPeekTile();
    const stream = liveStream();
    const surface = readOnlySurface();

    fireEvent.pointerEnter(surface);
    fireEvent.pointerDown(surface, { pointerId: 1, clientX: 10, clientY: 10 });
    fireEvent.pointerUp(surface, { pointerId: 1, clientX: 10, clientY: 10 });
    fireEvent.click(surface);
    fireEvent.keyDown(surface, { key: "a" });

    expect(refusedFrames(stream)).toEqual([]);
    expect(toast).not.toHaveBeenCalled();
    expect(screen.queryByText("Controlling")).toBeNull();
  });

  it("keeps the tile role's affordances and its arm claim", () => {
    hookState.browserView = {};
    renderPeekTile();
    const stream = liveStream();

    expect(subscribedRole()).toBe("tile");
    const overlay = screen.getByRole("button", {
      name: "Browser screencast controls",
    });
    expect(
      screen.getByRole("textbox", { name: "Browser IME input" }),
    ).not.toBeNull();
    expect(
      screen.getByRole("textbox", { name: "Browser address" }),
    ).toHaveProperty("disabled", false);
    expect(screen.getByRole("button", { name: "Reload" })).toHaveProperty(
      "disabled",
      false,
    );
    expect(screen.queryByText("View only")).toBeNull();

    fireEvent.focus(overlay);

    expect(
      stream.sentFrames.filter((frame) => frame.kind === "arm"),
    ).toHaveLength(1);
  });
});
