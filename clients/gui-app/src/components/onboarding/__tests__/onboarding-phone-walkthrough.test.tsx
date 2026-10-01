import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { OnboardingWorkspaceIllustration } from "@/components/onboarding/onboarding-workspace-illustration";
import { PHONE_SCENES } from "@/components/onboarding/onboarding-diorama-chapters";

/**
 * Act 1 at phone width: three full-bleed scenes of the real app, a caption and
 * an iOS-style page control. What is worth pinning here is the part a reader of
 * the component cannot see: that the dots are real navigation with real names,
 * and that the scene is a picture rather than a frame with an app drawn inside.
 */

const DESKTOP_VIEWPORT_WIDTH = window.innerWidth;

function setViewportWidth(width: number): void {
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    writable: true,
    value: width,
  });
}

function currentCaption(): string {
  const line = document.querySelector(".diorama-phone-caption-line");
  return line?.textContent ?? "";
}

function dots(): readonly HTMLElement[] {
  return screen.getAllByRole("button");
}

describe("act one at phone width", () => {
  beforeEach(() => {
    setViewportWidth(393);
  });

  afterEach(() => {
    cleanup();
    setViewportWidth(DESKTOP_VIEWPORT_WIDTH);
  });

  it("renders the scene full-bleed, as a picture rather than a phone in a phone", () => {
    const { container } = render(
      <OnboardingWorkspaceIllustration onPassLastScene={vi.fn()} />,
    );

    const scene = container.querySelector(".diorama-phone");
    expect(scene).not.toBeNull();
    // A picture: no pointer events reach it and nothing in it is announced.
    expect(scene?.getAttribute("aria-hidden")).toBe("true");
    // The frame, the bezel and the 9/16 box are gone with it.
    expect(container.querySelector(".diorama-mobile")).toBeNull();
    expect(container.querySelector(".diorama-mobile-stage")).toBeNull();
    // And so is the labelled chapter strip: the dots are the only progress.
    expect(container.querySelector(".diorama-chapters")).toBeNull();
  });

  it("names every dot as a scene and moves between them", () => {
    render(<OnboardingWorkspaceIllustration onPassLastScene={vi.fn()} />);

    expect(dots().map((dot) => dot.getAttribute("aria-label"))).toEqual([
      "Menu, scene 1 of 3",
      "Task, scene 2 of 3",
      "Tabs, scene 3 of 3",
    ]);
    expect(currentCaption()).toBe(PHONE_SCENES[0].caption);
    expect(dots()[0].getAttribute("aria-current")).toBe("true");

    fireEvent.click(dots()[2]);

    expect(currentCaption()).toBe(PHONE_SCENES[2].caption);
    expect(dots()[2].getAttribute("aria-current")).toBe("true");
    expect(dots()[0].getAttribute("aria-current")).toBeNull();

    // The control wraps, the way the autoplay does.
    fireEvent.keyDown(dots()[2], { key: "ArrowRight" });
    expect(currentCaption()).toBe(PHONE_SCENES[0].caption);
  });

  it("shows the scene the dot names, surface and turn together", () => {
    const { container } = render(
      <OnboardingWorkspaceIllustration onPassLastScene={vi.fn()} />,
    );
    const page = (): Element | null =>
      container.querySelector(".diorama-phone-page");

    // Every scene opens on the task with its own control spotlit; the surface
    // arrives a beat later, which no click can skip to. The glyphs are the
    // header's, in order: menu, notifications, tab switcher.
    expect(page()?.getAttribute("data-surface")).toBe("task");
    const glyphRings = (): readonly (string | null)[] =>
      [...container.querySelectorAll(".diorama-phone-glyph")].map((glyph) =>
        glyph.getAttribute("data-ring"),
      );
    expect(glyphRings()).toEqual(["true", null, null]);

    fireEvent.click(dots()[2]);
    expect(glyphRings()).toEqual([null, null, "true"]);

    fireEvent.click(dots()[1]);
    expect(glyphRings()).toEqual([null, null, null]);
    // The Task scene starts with the ask alone: the reply has not streamed yet.
    const reply = container.querySelector('[data-stagger="0"]');
    expect(reply?.getAttribute("data-shown")).toBe("false");
  });
});
