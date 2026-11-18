import { afterEach, describe, expect, it } from "vitest";
import {
  focusGuideTarget,
  interactWithGuideTarget,
} from "@/components/onboarding/guide-target";

function appendButton(parent: HTMLElement, id: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.id = id;
  button.textContent = id;
  parent.append(button);
  return button;
}

/**
 * A target with three unreachable controls ahead of the one reachable one, in
 * document order: hidden, inert, and `checkVisibility`-false (the breakpoint
 * case `guideTargetControl`'s own doc comment names - a control mounted for a
 * width the page is not drawing).
 */
function buildUnreachableTriple(target: HTMLElement): void {
  const hiddenWrap = document.createElement("div");
  hiddenWrap.hidden = true;
  appendButton(hiddenWrap, "hidden-btn");
  target.append(hiddenWrap);

  const inertWrap = document.createElement("div");
  inertWrap.setAttribute("inert", "");
  appendButton(inertWrap, "inert-btn");
  target.append(inertWrap);

  const invisible = appendButton(target, "invisible-btn");
  // jsdom has no `checkVisibility`; `guideTargetControl` treats its absence
  // as "no opinion" and only skips a control that has one and says false.
  Object.defineProperty(invisible, "checkVisibility", {
    configurable: true,
    value: () => false,
  });
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("guideTargetControl (via focusGuideTarget / interactWithGuideTarget)", () => {
  it("skips a hidden, an inert, and a checkVisibility-false control, and focuses the one reachable control after them", () => {
    const target = document.createElement("div");
    buildUnreachableTriple(target);
    const visible = appendButton(target, "visible-btn");
    document.body.append(target);

    expect(focusGuideTarget(target)).toBe(true);
    expect(document.activeElement).toBe(visible);
  });

  it("returns false, and focuses nothing, when every control in the target is unreachable", () => {
    const target = document.createElement("div");
    buildUnreachableTriple(target);
    document.body.append(target);
    const before = document.activeElement;

    expect(focusGuideTarget(target)).toBe(false);
    expect(document.activeElement).toBe(before);
  });

  it("interactWithGuideTarget focuses and clicks the one reachable control, skipping the same three", () => {
    const target = document.createElement("div");
    buildUnreachableTriple(target);
    const visible = appendButton(target, "visible-btn");
    document.body.append(target);
    let clicked = false;
    visible.addEventListener("click", () => {
      clicked = true;
    });

    expect(interactWithGuideTarget(target)).toBe(true);
    expect(document.activeElement).toBe(visible);
    expect(clicked).toBe(true);
  });

  it("returns the target itself when it is its own control, without walking its descendants", () => {
    const target = document.createElement("button");
    target.id = "self-control";
    // A descendant that would otherwise win, to prove it is never reached.
    const decoy = document.createElement("button");
    decoy.id = "decoy";
    target.append(decoy);
    document.body.append(target);

    expect(focusGuideTarget(target)).toBe(true);
    expect(document.activeElement).toBe(target);
  });

  it("resolves a reachable tablist to its selected tab rather than the list itself", () => {
    const target = document.createElement("div");
    const tablist = document.createElement("div");
    tablist.setAttribute("role", "tablist");
    // `firstReachable`'s selector requires a `tabindex="0"` match; Radix's
    // roving-focus-group puts that on the list itself when nothing inside it
    // is the current tab stop yet.
    tablist.setAttribute("tabindex", "0");
    target.append(tablist);

    // Plain `div`s, not `button`s: jsdom's `querySelectorAll` does not sort a
    // grouped selector's matches into document order the way a real browser
    // does, so a tab that also matched `button:not(:disabled)` could sort
    // ahead of its own tablist and mask the branch this test exists to
    // cover. A `role="tab"` is enough for `firstReachable`'s own lookup,
    // which is a plain attribute selector.
    for (const [index, id] of [
      "first-tab",
      "second-tab",
      "third-tab",
    ].entries()) {
      const tab = document.createElement("div");
      tab.id = id;
      tab.setAttribute("role", "tab");
      tab.setAttribute("aria-selected", index === 2 ? "true" : "false");
      // Radix's own roving tabindex: -1 on every tab but the current one, so
      // each is still programmatically focusable.
      tab.setAttribute("tabindex", "-1");
      tablist.append(tab);
    }
    document.body.append(target);

    const selectedTab = document.getElementById("third-tab");
    expect(focusGuideTarget(target)).toBe(true);
    expect(document.activeElement).toBe(selectedTab);
  });
});
