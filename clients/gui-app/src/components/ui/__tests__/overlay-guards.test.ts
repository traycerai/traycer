import { afterEach, describe, expect, it } from "vitest";
import {
  isOwnPaneTriggerEvent,
  isToastEvent,
} from "@/components/ui/overlay-guards";

/**
 * Direct unit coverage of `isOwnPaneTriggerEvent` - the guard that decides
 * whether a cold (visible-but-unfocused) pane's own trigger gesture may
 * activate its Popover/Menu logical state. Exercised as a pure function
 * against constructed DOM, rather than through a full Popover/Select mount,
 * so each branch (gesture kind, containment, connectedness, pane adjacency)
 * is provable in isolation against the exact source in overlay-guards.ts.
 */

function connectedTrigger(): HTMLButtonElement {
  const trigger = document.createElement("button");
  document.body.appendChild(trigger);
  return trigger;
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("isOwnPaneTriggerEvent", () => {
  it("accepts a trigger-press whose target is inside a connected trigger", () => {
    const trigger = connectedTrigger();
    const event = new MouseEvent("click");
    Object.defineProperty(event, "target", { value: trigger });
    expect(
      isOwnPaneTriggerEvent({ reason: "trigger-press", event, trigger }, null),
    ).toBe(true);
  });

  it("accepts list-navigation only when the event is a real KeyboardEvent", () => {
    const trigger = connectedTrigger();
    const keyboardEvent = new KeyboardEvent("keydown", { key: "ArrowDown" });
    Object.defineProperty(keyboardEvent, "target", { value: trigger });
    expect(
      isOwnPaneTriggerEvent(
        { reason: "list-navigation", event: keyboardEvent, trigger },
        null,
      ),
    ).toBe(true);
  });

  it("rejects list-navigation raised via a non-KeyboardEvent", () => {
    const trigger = connectedTrigger();
    const mouseEvent = new MouseEvent("click");
    Object.defineProperty(mouseEvent, "target", { value: trigger });
    expect(
      isOwnPaneTriggerEvent(
        { reason: "list-navigation", event: mouseEvent, trigger },
        null,
      ),
    ).toBe(false);
  });

  it("rejects a reason that is neither trigger-press nor list-navigation", () => {
    const trigger = connectedTrigger();
    const event = new MouseEvent("click");
    Object.defineProperty(event, "target", { value: trigger });
    expect(
      isOwnPaneTriggerEvent({ reason: "outside-press", event, trigger }, null),
    ).toBe(false);
  });

  it("rejects a trigger that is no longer connected to the document", () => {
    const trigger = document.createElement("button");
    const event = new MouseEvent("click");
    Object.defineProperty(event, "target", { value: trigger });
    expect(
      isOwnPaneTriggerEvent({ reason: "trigger-press", event, trigger }, null),
    ).toBe(false);
  });

  it("rejects when the event target is not inside the trigger", () => {
    const trigger = connectedTrigger();
    const elsewhere = document.createElement("div");
    document.body.appendChild(elsewhere);
    const event = new MouseEvent("click");
    Object.defineProperty(event, "target", { value: elsewhere });
    expect(
      isOwnPaneTriggerEvent({ reason: "trigger-press", event, trigger }, null),
    ).toBe(false);
  });

  it("rejects when trigger is undefined", () => {
    const event = new MouseEvent("click");
    expect(
      isOwnPaneTriggerEvent(
        { reason: "trigger-press", event, trigger: undefined },
        null,
      ),
    ).toBe(false);
  });

  it("accepts when the pane portal directly contains the trigger", () => {
    const panePortal = document.createElement("div");
    document.body.appendChild(panePortal);
    const trigger = document.createElement("button");
    panePortal.appendChild(trigger);
    const event = new MouseEvent("click");
    Object.defineProperty(event, "target", { value: trigger });
    expect(
      isOwnPaneTriggerEvent(
        { reason: "trigger-press", event, trigger },
        panePortal,
      ),
    ).toBe(true);
  });

  it("accepts a trigger whose own pane probe sits right before this same panePortal", () => {
    // Mirrors SurfacePresentationBoundary's actual DOM shape: a
    // `[data-pane-focused]` probe div immediately followed by its own
    // `data-slot="pane-portal-host"` sibling. The trigger lives inside the
    // probe (in-pane content), not inside the portal host itself.
    const probe = document.createElement("div");
    probe.dataset.paneFocused = "false";
    const panePortal = document.createElement("div");
    document.body.append(probe, panePortal);
    const trigger = document.createElement("button");
    probe.appendChild(trigger);
    const event = new MouseEvent("click");
    Object.defineProperty(event, "target", { value: trigger });
    expect(
      isOwnPaneTriggerEvent(
        { reason: "trigger-press", event, trigger },
        panePortal,
      ),
    ).toBe(true);
  });

  it("rejects a trigger that belongs to a different pane's boundary", () => {
    // Two independent SurfacePresentationBoundary-shaped subtrees. The
    // trigger lives in pane A; the Popover/Menu being asked about resolved
    // its own panePortal from pane B. Neither containment nor the
    // probe-adjacency check should match across that boundary.
    const probeA = document.createElement("div");
    probeA.dataset.paneFocused = "true";
    const portalA = document.createElement("div");
    document.body.append(probeA, portalA);
    const trigger = document.createElement("button");
    probeA.appendChild(trigger);

    const probeB = document.createElement("div");
    probeB.dataset.paneFocused = "false";
    const portalB = document.createElement("div");
    document.body.append(probeB, portalB);

    const event = new MouseEvent("click");
    Object.defineProperty(event, "target", { value: trigger });
    expect(
      isOwnPaneTriggerEvent(
        { reason: "trigger-press", event, trigger },
        portalB,
      ),
    ).toBe(false);
  });
});

function toasterTarget(): HTMLButtonElement {
  const toaster = document.createElement("div");
  toaster.dataset.sonnerToaster = "";
  document.body.appendChild(toaster);
  const target = document.createElement("button");
  toaster.appendChild(target);
  return target;
}

describe("isToastEvent", () => {
  it("accepts reason cancel-open when the target is inside the toaster", () => {
    // Select's own outside-dismiss reason is "cancel-open", not
    // "outside-press" (root cause of the toaster-target regression this
    // widening fixes) - see overlay-guards.ts.
    const target = toasterTarget();
    const event = new MouseEvent("mouseup");
    Object.defineProperty(event, "target", { value: target });
    expect(isToastEvent({ reason: "cancel-open", event })).toBe(true);
  });

  it("rejects reason cancel-open when the target is outside the toaster", () => {
    const target = document.createElement("button");
    document.body.appendChild(target);
    const event = new MouseEvent("mouseup");
    Object.defineProperty(event, "target", { value: target });
    expect(isToastEvent({ reason: "cancel-open", event })).toBe(false);
  });

  it("rejects reason outside-press when the target is outside the toaster", () => {
    const target = document.createElement("button");
    document.body.appendChild(target);
    const event = new MouseEvent("mouseup");
    Object.defineProperty(event, "target", { value: target });
    expect(isToastEvent({ reason: "outside-press", event })).toBe(false);
  });
});
