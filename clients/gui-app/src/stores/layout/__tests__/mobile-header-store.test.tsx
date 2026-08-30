import { afterEach, describe, expect, it } from "vitest";
import {
  epicTabRightActionsKey,
  landingTerminalRightActionsKey,
  useMobileHeaderStore,
} from "@/stores/layout/mobile-header-store";
import { resolveMobileHeaderRightActionsKey } from "@/stores/layout/mobile-header-right-actions";

/**
 * Registration is availability; display is resolution. Surfaces register their
 * controls under their own key for as long as they can serve them, and which
 * entry the header shows is a pure function of the presented surface - so
 * writes on different keys cannot race, and a surface presented again after
 * being backgrounded needs no re-publish.
 */
describe("useMobileHeaderStore right-actions registry", () => {
  afterEach(() => {
    useMobileHeaderStore.setState({ rightActionEntries: new Map() });
  });

  it("holds one entry per key, last write per key winning", () => {
    const first = <button type="button" data-testid="first" />;
    const second = <button type="button" data-testid="second" />;
    const rebaked = <button type="button" data-testid="rebaked" />;

    useMobileHeaderStore.getState().registerRightActions("surface-a", first);
    useMobileHeaderStore.getState().registerRightActions("surface-b", second);
    useMobileHeaderStore.getState().registerRightActions("surface-a", rebaked);

    const entries = useMobileHeaderStore.getState().rightActionEntries;
    expect(entries.get("surface-a")).toBe(rebaked);
    expect(entries.get("surface-b")).toBe(second);
  });

  // The property the old single-cell model could not give: a departing
  // surface's teardown, however late it lands, can only remove its OWN entry.
  it("unregisters only the named key, leaving other surfaces' entries", () => {
    const kept = <button type="button" data-testid="kept" />;
    useMobileHeaderStore
      .getState()
      .registerRightActions("surface-a", <button type="button" />);
    useMobileHeaderStore.getState().registerRightActions("surface-b", kept);

    useMobileHeaderStore.getState().unregisterRightActions("surface-a");

    const entries = useMobileHeaderStore.getState().rightActionEntries;
    expect(entries.has("surface-a")).toBe(false);
    expect(entries.get("surface-b")).toBe(kept);
  });

  it("ignores an unregister for a key that is not registered", () => {
    const before = useMobileHeaderStore.getState().rightActionEntries;
    useMobileHeaderStore.getState().unregisterRightActions("surface-a");
    // Identity preserved, so subscribers see no phantom change.
    expect(useMobileHeaderStore.getState().rightActionEntries).toBe(before);
  });
});

/**
 * The display policy: the presented surface picks the entry. A focused draft
 * owns ITS landing terminal entry - keyed per hosting page, so a focus move
 * between two start pages never resolves the departing page's toggle; an epic
 * tab owns its own keyed entry; History and Settings present no surface
 * actions, which is what keeps a retained surface's registration from leaking
 * into their header; no focus at all presents nothing.
 */
describe("resolveMobileHeaderRightActionsKey", () => {
  it("resolves a draft to that draft's landing terminal entry", () => {
    expect(
      resolveMobileHeaderRightActionsKey({ kind: "draft", id: "page-1" }),
    ).toBe(landingTerminalRightActionsKey("page-1"));
    expect(
      resolveMobileHeaderRightActionsKey({ kind: "draft", id: "page-2" }),
    ).not.toBe(landingTerminalRightActionsKey("page-1"));
  });

  it("resolves no focus to no entry", () => {
    expect(resolveMobileHeaderRightActionsKey(null)).toBeNull();
  });

  it("resolves an epic tab to that tab's entry", () => {
    expect(
      resolveMobileHeaderRightActionsKey({ kind: "epic", id: "tab-1" }),
    ).toBe(epicTabRightActionsKey("tab-1"));
  });

  it("resolves History and Settings to no entry", () => {
    expect(
      resolveMobileHeaderRightActionsKey({ kind: "history", id: "history" }),
    ).toBeNull();
    expect(
      resolveMobileHeaderRightActionsKey({ kind: "settings", id: "settings" }),
    ).toBeNull();
  });
});
