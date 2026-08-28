import "../../../../__tests__/test-browser-apis";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { TileSelectAllBridge } from "@/components/epic-canvas/tile-select-all-bridge";
import { selectAllInActiveTile } from "@/lib/commands/tile-select-all";
import { createUnavailableTileFindAdapter } from "@/stores/tile-find";
import { useTileFindStore } from "@/stores/tile-find/tile-find-store";
import type { TileFindOwnerBlockerReason } from "@/stores/tile-find/types";

const TILE_A = "inst-a";
const TILE_B = "inst-b";

/**
 * Two tiles plus app chrome, in the same shape the canvas renders: the tile
 * wrapper carries `data-tile-instance-id`, the content root carries
 * `data-selection-root`, and the tile header sits outside it.
 */
function mountCanvas(): void {
  document.body.innerHTML = `
    <div id="sidebar">Chat names and headings</div>
    <div data-tile-instance-id="${TILE_A}">
      <div id="header-a">src/index.ts</div>
      <div data-selection-root=""><pre>FILE A BODY</pre></div>
    </div>
    <div data-tile-instance-id="${TILE_B}">
      <div data-selection-root=""><pre>FILE B BODY</pre></div>
    </div>
    <div data-tile-instance-id="inst-rootless"><pre>NO ROOT DECLARED</pre></div>
  `;
}

function makeOwner(tileInstanceId: string): () => void {
  return useTileFindStore.getState().registerTarget({
    tileInstanceId,
    contentId: `content-${tileInstanceId}`,
    viewTabId: "tab-1",
    tileId: "tile-1",
    epicId: "epic-1",
    tileKind: "workspace-file",
    isEligible: true,
    adapter: createUnavailableTileFindAdapter({
      tileInstanceId,
      tileKind: "workspace-file",
      message: null,
    }),
  });
}

function block(reason: TileFindOwnerBlockerReason): void {
  useTileFindStore.getState().setOwnerBlocker({ reason, ownerId: "owner-1" });
}

function selectedText(): string {
  const selection = window.getSelection();
  if (selection === null || selection.rangeCount === 0) return "";
  return selection.getRangeAt(0).toString();
}

function pressSelectAll(target: EventTarget): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    key: "a",
    ctrlKey: true,
    metaKey: true,
    bubbles: true,
    cancelable: true,
  });
  target.dispatchEvent(event);
  return event;
}

beforeEach(() => {
  useTileFindStore.getState().resetForTests();
  window.getSelection()?.removeAllRanges();
  mountCanvas();
});

afterEach(() => {
  cleanup();
  useTileFindStore.getState().resetForTests();
  document.body.innerHTML = "";
});

describe("selectAllInActiveTile", () => {
  it("selects only the active tile's content root", () => {
    makeOwner(TILE_A);

    expect(selectAllInActiveTile()).toBe(true);
    const selected = selectedText();
    expect(selected).toContain("FILE A BODY");
    expect(selected).not.toContain("Chat names and headings");
    expect(selected).not.toContain("src/index.ts");
    expect(selected).not.toContain("FILE B BODY");
  });

  it("follows the owner when the active tile changes", () => {
    makeOwner(TILE_A);
    makeOwner(TILE_B);

    expect(selectAllInActiveTile()).toBe(true);
    expect(selectedText()).toContain("FILE B BODY");
    expect(selectedText()).not.toContain("FILE A BODY");
  });

  it("declines when no tile is eligible", () => {
    const release = makeOwner(TILE_A);
    release();

    expect(selectAllInActiveTile()).toBe(false);
  });

  it("declines while an overlay holds global keys", () => {
    makeOwner(TILE_A);
    block("command-palette");

    expect(selectAllInActiveTile()).toBe(false);
    expect(selectedText()).toBe("");
  });

  it("declines when the owning tile declares no selection root", () => {
    makeOwner("inst-rootless");

    expect(selectAllInActiveTile()).toBe(false);
  });
});

describe("TileSelectAllBridge", () => {
  beforeEach(() => {
    render(<TileSelectAllBridge />);
  });

  it("claims Ctrl/Cmd+A for the active tile", () => {
    makeOwner(TILE_A);

    const event = pressSelectAll(window);

    expect(event.defaultPrevented).toBe(true);
    expect(selectedText()).toContain("FILE A BODY");
  });

  it("leaves the browser default alone inside a text field", () => {
    makeOwner(TILE_A);
    const input = document.createElement("input");
    document.body.appendChild(input);

    expect(pressSelectAll(input).defaultPrevented).toBe(false);
    expect(selectedText()).toBe("");
  });

  it("leaves the browser default alone when there is no canvas at all", () => {
    expect(pressSelectAll(window).defaultPrevented).toBe(false);
  });

  // jsdom never runs Chromium's document-wide select-all, so this pins the
  // mechanism that suppresses it - preventDefault - plus the selection staying
  // put. The real default is covered by the CDP pass, not here.
  it("swallows the key when an overlay covers a live canvas", () => {
    makeOwner(TILE_A);
    block("app-dialog");

    expect(pressSelectAll(window).defaultPrevented).toBe(true);
    expect(selectedText()).toBe("");
  });

  it("still swallows it for a route-body overlay such as Settings", () => {
    makeOwner(TILE_A);
    block("non-canvas-route");

    expect(pressSelectAll(window).defaultPrevented).toBe(true);
    expect(selectedText()).toBe("");
  });

  it("leaves the default alone when a blocker covers nothing", () => {
    block("command-palette");

    expect(pressSelectAll(window).defaultPrevented).toBe(false);
  });

  it("ignores modified variants that are not select-all", () => {
    makeOwner(TILE_A);

    const shifted = new KeyboardEvent("keydown", {
      key: "a",
      metaKey: true,
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    window.dispatchEvent(shifted);

    expect(shifted.defaultPrevented).toBe(false);
    expect(selectedText()).toBe("");
  });
});
