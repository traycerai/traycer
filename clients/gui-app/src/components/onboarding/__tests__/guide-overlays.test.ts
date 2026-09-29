import { afterEach, describe, expect, it } from "vitest";
import {
  CLOSING_OVERLAY_SELECTOR,
  escapeOwnedElsewhere,
  MODAL_OVERLAY_SELECTOR,
  OPEN_OVERLAY_SELECTOR,
  OVERLAY_SELECTOR,
} from "@/components/onboarding/guide-overlays";

/**
 * Direct DOM coverage of guide-overlays.ts's exported selectors and
 * escapeOwnedElsewhere() - a pure querySelector module, no paint/animation
 * dependency, so jsdom against constructed elements is exact, not an
 * approximation. Each named slot matches a real `data-slot` this migrated
 * app's own primitives render (dialog.tsx, popover.tsx, select.tsx, ...).
 */

afterEach(() => {
  document.body.replaceChildren();
});

function slot(name: string, attrs: Record<string, string>): HTMLElement {
  const el = document.createElement("div");
  el.dataset.slot = name;
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value);
  document.body.appendChild(el);
  return el;
}

describe("OVERLAY_SELECTOR", () => {
  it("matches every named slot regardless of open/closed state", () => {
    for (const name of [
      "dialog-content",
      "popover-content",
      "dropdown-menu-content",
      "sheet-content",
    ]) {
      document.body.replaceChildren();
      const el = slot(name, {});
      expect(document.querySelector(OVERLAY_SELECTOR)).toBe(el);
    }
  });

  it("matches the hand-rolled data-overlay-surface attribute", () => {
    const el = document.createElement("div");
    el.setAttribute("data-overlay-surface", "open");
    document.body.appendChild(el);
    expect(document.querySelector(OVERLAY_SELECTOR)).toBe(el);
  });

  it("does not match an unrelated element", () => {
    document.body.appendChild(document.createElement("div"));
    expect(document.querySelector(OVERLAY_SELECTOR)).toBeNull();
  });
});

describe("OPEN_OVERLAY_SELECTOR", () => {
  it("matches a named slot only once it carries data-open", () => {
    const el = slot("dialog-content", {});
    expect(document.querySelector(OPEN_OVERLAY_SELECTOR)).toBeNull();
    el.setAttribute("data-open", "");
    expect(document.querySelector(OPEN_OVERLAY_SELECTOR)).toBe(el);
  });

  it("matches the hand-rolled surface only in its open state", () => {
    const el = document.createElement("div");
    el.setAttribute("data-overlay-surface", "closed");
    document.body.appendChild(el);
    expect(document.querySelector(OPEN_OVERLAY_SELECTOR)).toBeNull();
    el.setAttribute("data-overlay-surface", "open");
    expect(document.querySelector(OPEN_OVERLAY_SELECTOR)).toBe(el);
  });
});

describe("CLOSING_OVERLAY_SELECTOR", () => {
  it("matches a named slot carrying data-closed, not one carrying data-open", () => {
    const el = slot("popover-content", { "data-open": "" });
    expect(document.querySelector(CLOSING_OVERLAY_SELECTOR)).toBeNull();
    el.removeAttribute("data-open");
    el.setAttribute("data-closed", "");
    expect(document.querySelector(CLOSING_OVERLAY_SELECTOR)).toBe(el);
  });

  it("matches the hand-rolled surface only in its closed state", () => {
    const el = document.createElement("div");
    el.setAttribute("data-overlay-surface", "closed");
    document.body.appendChild(el);
    expect(document.querySelector(CLOSING_OVERLAY_SELECTOR)).toBe(el);
  });
});

describe("MODAL_OVERLAY_SELECTOR", () => {
  it("matches dialog and sheet content", () => {
    for (const name of ["dialog-content", "sheet-content"]) {
      document.body.replaceChildren();
      const el = slot(name, {});
      expect(document.querySelector(MODAL_OVERLAY_SELECTOR)).toBe(el);
    }
  });

  it("matches the hand-rolled surface only while open", () => {
    const el = document.createElement("div");
    el.setAttribute("data-overlay-surface", "closed");
    document.body.appendChild(el);
    expect(document.querySelector(MODAL_OVERLAY_SELECTOR)).toBeNull();
    el.setAttribute("data-overlay-surface", "open");
    expect(document.querySelector(MODAL_OVERLAY_SELECTOR)).toBe(el);
  });

  it("excludes popover and dropdown-menu content from the selector text", () => {
    slot("popover-content", { "data-open": "" });
    slot("dropdown-menu-content", { "data-open": "" });
    expect(document.querySelector(MODAL_OVERLAY_SELECTOR)).toBeNull();
  });
});

describe("escapeOwnedElsewhere", () => {
  it("is false with nothing open", () => {
    expect(escapeOwnedElsewhere([])).toBe(false);
  });

  it("is true when an open named overlay exists elsewhere in the document", () => {
    slot("dialog-content", { "data-open": "" });
    expect(escapeOwnedElsewhere([])).toBe(true);
  });

  it("is false when every open overlay contains all of `within`", () => {
    const dialog = slot("dialog-content", { "data-open": "" });
    const step = document.createElement("div");
    dialog.appendChild(step);
    expect(escapeOwnedElsewhere([step])).toBe(false);
  });

  it("is true when `within` sits outside the open overlay", () => {
    slot("dialog-content", { "data-open": "" });
    const step = document.createElement("div");
    document.body.appendChild(step);
    expect(escapeOwnedElsewhere([step])).toBe(true);
  });

  it("treats a null entry in `within` as containment-satisfied, not a wildcard exclusion", () => {
    // node === null short-circuits `.every()` true for that entry, it does
    // not remove the surface from consideration - an open overlay still
    // counts as owning Escape.
    slot("dialog-content", { "data-open": "" });
    expect(escapeOwnedElsewhere([null])).toBe(true);
  });

  it("owns Escape for the three hand-rolled slots by mere presence, no data-state", () => {
    for (const name of [
      "composer-menu",
      "mention-suggestion",
      "artifact-link-popover",
    ]) {
      document.body.replaceChildren();
      slot(name, {});
      expect(escapeOwnedElsewhere([])).toBe(true);
    }
  });

  it("owns Escape for select/context-menu/drawer via the generic role+data-open fallback", () => {
    for (const attrs of [
      { role: "listbox", "data-open": "" }, // select's real ARIA role
      { role: "menu", "data-open": "" }, // context-menu's real ARIA role
      { role: "dialog", "data-open": "" }, // drawer's real ARIA role
    ]) {
      document.body.replaceChildren();
      const el = document.createElement("div");
      for (const [key, value] of Object.entries(attrs))
        el.setAttribute(key, value);
      document.body.appendChild(el);
      expect(escapeOwnedElsewhere([])).toBe(true);
    }
  });

  it("does not own Escape for the generic fallback role without data-open", () => {
    const el = document.createElement("div");
    el.setAttribute("role", "menu");
    document.body.appendChild(el);
    expect(escapeOwnedElsewhere([])).toBe(false);
  });

  it("also covers select-content by slot even without a matching role", () => {
    slot("select-content", { "data-open": "" });
    expect(escapeOwnedElsewhere([])).toBe(true);
  });
});
