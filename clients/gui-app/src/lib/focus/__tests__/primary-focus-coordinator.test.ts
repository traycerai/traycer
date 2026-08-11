import { describe, expect, it, vi } from "vitest";
import {
  PrimaryFocusCoordinator,
  type PrimaryFocusEndpoint,
} from "../primary-focus-coordinator";

const COMPOSER = { kind: "composer", surfaceId: "draft-a" } as const;
const TERMINAL = { kind: "terminal", instanceId: "terminal-a" } as const;

function endpoint(input: {
  readonly focus: () => void;
  readonly activeElement: () => Element | null;
  readonly eligible: () => boolean;
}): PrimaryFocusEndpoint {
  return {
    focus: input.focus,
    containsActiveElement: (activeElement) =>
      activeElement !== null && activeElement === input.activeElement(),
    isEligible: input.eligible,
  };
}

describe("PrimaryFocusCoordinator", () => {
  it("parks an intent until its endpoint registers", () => {
    let activeElement: Element | null = null;
    const target = document.createElement("input");
    const coordinator = new PrimaryFocusCoordinator({
      activeElement: () => activeElement,
      documentVisible: () => true,
    });
    coordinator.request(TERMINAL);
    const focus = vi.fn(() => {
      activeElement = target;
    });

    coordinator.register(
      TERMINAL,
      endpoint({
        focus,
        activeElement: () => target,
        eligible: () => true,
      }),
    );

    expect(focus).toHaveBeenCalledTimes(1);
  });

  it("cancels a matching intent before its endpoint registers", () => {
    const target = document.createElement("input");
    const focus = vi.fn(() => target.focus());
    const coordinator = new PrimaryFocusCoordinator({
      activeElement: () => document.activeElement,
      documentVisible: () => true,
    });

    coordinator.request(COMPOSER);
    coordinator.cancel((intent) => intent.kind === "composer");
    coordinator.register(
      COMPOSER,
      endpoint({
        focus,
        activeElement: () => target,
        eligible: () => true,
      }),
    );

    expect(focus).not.toHaveBeenCalled();
  });

  it("keeps an intent when the cancel predicate does not match", () => {
    const target = document.createElement("input");
    const focus = vi.fn(() => target.focus());
    const coordinator = new PrimaryFocusCoordinator({
      activeElement: () => document.activeElement,
      documentVisible: () => true,
    });

    coordinator.request(COMPOSER);
    coordinator.cancel((intent) => intent.kind === "terminal");
    coordinator.register(
      COMPOSER,
      endpoint({
        focus,
        activeElement: () => target,
        eligible: () => true,
      }),
    );

    expect(focus).toHaveBeenCalledTimes(1);
  });

  it("keeps only the latest intent", () => {
    let activeElement: Element | null = null;
    const composer = document.createElement("div");
    const terminal = document.createElement("textarea");
    const coordinator = new PrimaryFocusCoordinator({
      activeElement: () => activeElement,
      documentVisible: () => true,
    });
    const focusComposer = vi.fn(() => {
      activeElement = composer;
    });
    const focusTerminal = vi.fn(() => {
      activeElement = terminal;
    });

    coordinator.request(COMPOSER);
    coordinator.request(TERMINAL);
    coordinator.register(
      COMPOSER,
      endpoint({
        focus: focusComposer,
        activeElement: () => composer,
        eligible: () => true,
      }),
    );
    coordinator.register(
      TERMINAL,
      endpoint({
        focus: focusTerminal,
        activeElement: () => terminal,
        eligible: () => true,
      }),
    );

    expect(focusComposer).not.toHaveBeenCalled();
    expect(focusTerminal).toHaveBeenCalledTimes(1);
  });

  it("waits while hidden and reconciles when visibility is restored", () => {
    let activeElement: Element | null = null;
    let visible = false;
    const target = document.createElement("input");
    const focus = vi.fn(() => {
      activeElement = target;
    });
    const coordinator = new PrimaryFocusCoordinator({
      activeElement: () => activeElement,
      documentVisible: () => visible,
    });
    coordinator.register(
      COMPOSER,
      endpoint({
        focus,
        activeElement: () => target,
        eligible: () => true,
      }),
    );

    coordinator.request(COMPOSER);
    expect(focus).not.toHaveBeenCalled();
    visible = true;
    expect(coordinator.reconcile()).toBe(true);
    expect(focus).toHaveBeenCalledTimes(1);
  });

  it("waits for an active pointer transaction to settle", () => {
    let activeElement: Element | null = null;
    const target = document.createElement("input");
    const focus = vi.fn(() => {
      activeElement = target;
    });
    const coordinator = new PrimaryFocusCoordinator({
      activeElement: () => activeElement,
      documentVisible: () => true,
    });
    coordinator.register(
      COMPOSER,
      endpoint({
        focus,
        activeElement: () => target,
        eligible: () => true,
      }),
    );

    coordinator.setInteractionActive(true);
    coordinator.request(COMPOSER);
    expect(focus).not.toHaveBeenCalled();
    coordinator.setInteractionActive(false);
    expect(focus).toHaveBeenCalledTimes(1);
  });

  it("cancels a fulfilled intent after pointer focus moves outside its owner", () => {
    let activeElement: Element | null = null;
    const target = document.createElement("input");
    const other = document.createElement("button");
    const focus = vi.fn(() => {
      activeElement = target;
    });
    const coordinator = new PrimaryFocusCoordinator({
      activeElement: () => activeElement,
      documentVisible: () => true,
    });
    coordinator.register(
      COMPOSER,
      endpoint({
        focus,
        activeElement: () => target,
        eligible: () => true,
      }),
    );

    coordinator.request(COMPOSER);
    expect(focus).toHaveBeenCalledTimes(1);
    coordinator.setInteractionActive(true);
    activeElement = other;
    coordinator.handleFocusIn(other);
    coordinator.setInteractionActive(false);

    expect(focus).toHaveBeenCalledTimes(1);
  });

  it("cancels a fulfilled intent when pointer interaction starts", () => {
    let activeElement: Element | null = null;
    const target = document.createElement("input");
    const other = document.createElement("button");
    const focus = vi.fn(() => {
      activeElement = target;
    });
    const coordinator = new PrimaryFocusCoordinator({
      activeElement: () => activeElement,
      documentVisible: () => true,
    });
    coordinator.register(
      COMPOSER,
      endpoint({
        focus,
        activeElement: () => target,
        eligible: () => true,
      }),
    );

    coordinator.request(COMPOSER);
    expect(focus).toHaveBeenCalledTimes(1);
    coordinator.setInteractionActive(true);
    activeElement = other;
    coordinator.setInteractionActive(false);

    expect(focus).toHaveBeenCalledTimes(1);
  });

  it("restores the semantic owner when its endpoint relocates", () => {
    let activeElement: Element | null = null;
    const first = document.createElement("textarea");
    const second = document.createElement("textarea");
    const coordinator = new PrimaryFocusCoordinator({
      activeElement: () => activeElement,
      documentVisible: () => true,
    });
    const unregister = coordinator.register(
      TERMINAL,
      endpoint({
        focus: () => {
          activeElement = first;
        },
        activeElement: () => first,
        eligible: () => true,
      }),
    );
    coordinator.request(TERMINAL);
    unregister();
    activeElement = null;

    const relocatedFocus = vi.fn(() => {
      activeElement = second;
    });
    coordinator.register(
      TERMINAL,
      endpoint({
        focus: relocatedFocus,
        activeElement: () => second,
        eligible: () => true,
      }),
    );

    expect(relocatedFocus).toHaveBeenCalledTimes(1);
  });

  it("lets deliberate competing focus supersede a pending intent", () => {
    const target = document.createElement("input");
    const other = document.createElement("button");
    const focus = vi.fn();
    const coordinator = new PrimaryFocusCoordinator({
      activeElement: () => other,
      documentVisible: () => true,
    });
    coordinator.register(
      COMPOSER,
      endpoint({
        focus,
        activeElement: () => target,
        eligible: () => false,
      }),
    );
    coordinator.request(COMPOSER);

    coordinator.handleFocusIn(other);
    coordinator.register(
      COMPOSER,
      endpoint({
        focus,
        activeElement: () => target,
        eligible: () => true,
      }),
    );

    expect(focus).not.toHaveBeenCalled();
  });
});
