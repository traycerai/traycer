import { afterEach, describe, expect, it, onTestFinished } from "vitest";
import {
  HOSTED_TILE_INSTANCE_ID_ATTRIBUTE,
  HOSTED_TILE_PANE_ID_ATTRIBUTE,
  HOSTED_TILE_VIEW_TAB_ID_ATTRIBUTE,
} from "@/components/epic-canvas/surface-host/hosted-tile-dom";
import {
  findHostedTileElement,
  isTargetInsideHostedTile,
  resolveHostedTileOwnership,
} from "@/components/epic-canvas/surface-host/hosted-tile-resolver";

function buildHostedRecord(
  instanceId: string,
  paneId: string,
  viewTabId: string,
  innerHtml: string,
): HTMLDivElement {
  const record = document.createElement("div");
  record.setAttribute(HOSTED_TILE_INSTANCE_ID_ATTRIBUTE, instanceId);
  record.setAttribute(HOSTED_TILE_PANE_ID_ATTRIBUTE, paneId);
  record.setAttribute(HOSTED_TILE_VIEW_TAB_ID_ATTRIBUTE, viewTabId);
  record.innerHTML = innerHtml;
  return record;
}

let mountedRoot: HTMLElement | null = null;

function mount(...elements: ReadonlyArray<HTMLElement>): HTMLElement {
  const root = document.createElement("div");
  for (const element of elements) root.appendChild(element);
  document.body.appendChild(root);
  mountedRoot = root;
  return root;
}

afterEach(() => {
  mountedRoot?.remove();
  mountedRoot = null;
});

describe("findHostedTileElement (forward instanceId -> element, command-to-composer / route-focus shape)", () => {
  it("finds the record for a given instanceId scoped to root", () => {
    const record = buildHostedRecord(
      "chat-1",
      "p1",
      "tab-1",
      '<textarea data-testid="composer"></textarea>',
    );
    const root = mount(record);
    const found = findHostedTileElement(root, "chat-1");
    expect(found).toBe(record);
    expect(found?.querySelector('[data-testid="composer"]')).not.toBeNull();
  });

  it("returns null for an instanceId with no hosted record", () => {
    const root = mount(buildHostedRecord("chat-1", "p1", "tab-1", ""));
    expect(findHostedTileElement(root, "chat-missing")).toBeNull();
  });

  it("does not cross-match a record belonging to a different, unrelated root", () => {
    const otherRoot = document.createElement("div");
    otherRoot.appendChild(buildHostedRecord("chat-1", "p1", "tab-1", ""));
    document.body.appendChild(otherRoot);
    onTestFinished(() => otherRoot.remove());
    const root = mount(buildHostedRecord("chat-2", "p2", "tab-1", ""));
    expect(findHostedTileElement(root, "chat-1")).toBeNull();
  });

  it("escapes instanceIds containing quote/backslash characters instead of producing an invalid selector", () => {
    const trickyId = 'chat-"1\\2';
    const record = buildHostedRecord(trickyId, "p1", "tab-1", "");
    const root = mount(record);
    expect(findHostedTileElement(root, trickyId)).toBe(record);
  });
});

describe("resolveHostedTileOwnership (reverse target -> {instanceId, paneId, viewTabId}, chat-keyboard-scrolling shape)", () => {
  it("resolves ownership from a descendant several levels inside the record", () => {
    const record = buildHostedRecord(
      "chat-1",
      "p1",
      "tab-1",
      '<div><span data-testid="row">row</span></div>',
    );
    mount(record);
    const row = record.querySelector('[data-testid="row"]');
    expect(row).not.toBeNull();
    expect(resolveHostedTileOwnership(row)).toEqual({
      instanceId: "chat-1",
      paneId: "p1",
      viewTabId: "tab-1",
    });
  });

  it("resolves ownership from the record element itself", () => {
    const record = buildHostedRecord("chat-1", "p1", "tab-1", "");
    mount(record);
    expect(resolveHostedTileOwnership(record)).toEqual({
      instanceId: "chat-1",
      paneId: "p1",
      viewTabId: "tab-1",
    });
  });

  it("returns null for a target outside any hosted record", () => {
    const outside = document.createElement("div");
    mount(outside);
    expect(resolveHostedTileOwnership(outside)).toBeNull();
  });

  it("returns null for a null target", () => {
    expect(resolveHostedTileOwnership(null)).toBeNull();
  });

  it("returns null for a record whose environment has not published yet (no viewTabId attribute)", () => {
    const record = document.createElement("div");
    record.setAttribute(HOSTED_TILE_INSTANCE_ID_ATTRIBUTE, "chat-1");
    record.setAttribute(HOSTED_TILE_PANE_ID_ATTRIBUTE, "p1");
    mount(record);
    expect(resolveHostedTileOwnership(record)).toBeNull();
  });

  it("resolves the nearest record when hosted records are nested (does not walk past the closest ancestor)", () => {
    const inner = buildHostedRecord(
      "chat-inner",
      "p-inner",
      "tab-inner",
      '<span data-testid="leaf">leaf</span>',
    );
    const outer = buildHostedRecord("chat-outer", "p-outer", "tab-outer", "");
    outer.appendChild(inner);
    mount(outer);
    const leaf = inner.querySelector('[data-testid="leaf"]');
    expect(resolveHostedTileOwnership(leaf)).toEqual({
      instanceId: "chat-inner",
      paneId: "p-inner",
      viewTabId: "tab-inner",
    });
  });
});

describe("isTargetInsideHostedTile (deferred pane-activation containment shape, paneRoot.contains(target) generalized)", () => {
  it("is true for a target inside the named instance's record", () => {
    const record = buildHostedRecord(
      "chat-1",
      "p1",
      "tab-1",
      '<button data-testid="btn"></button>',
    );
    mount(record);
    const button = record.querySelector('[data-testid="btn"]');
    expect(isTargetInsideHostedTile("chat-1", button)).toBe(true);
  });

  it("is false for a target inside a DIFFERENT instance's record - the exact false-positive `paneRoot.contains` would need a hosted rewrite to avoid", () => {
    const recordA = buildHostedRecord("chat-a", "p-a", "tab-1", "");
    const recordB = buildHostedRecord(
      "chat-b",
      "p-b",
      "tab-1",
      '<button data-testid="btn"></button>',
    );
    mount(recordA, recordB);
    const button = recordB.querySelector('[data-testid="btn"]');
    expect(isTargetInsideHostedTile("chat-a", button)).toBe(false);
    expect(isTargetInsideHostedTile("chat-b", button)).toBe(true);
  });

  it("is false for a non-Element target (e.g. a null event target, or a non-Element EventTarget like window)", () => {
    expect(isTargetInsideHostedTile("chat-1", null)).toBe(false);
    expect(isTargetInsideHostedTile("chat-1", window)).toBe(false);
  });

  it("is false for a target outside any hosted record", () => {
    const outside = document.createElement("div");
    mount(outside);
    expect(isTargetInsideHostedTile("chat-1", outside)).toBe(false);
  });
});
