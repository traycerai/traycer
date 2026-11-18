import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { StatusGlyph, type StatusGlyphStatus } from "../status-glyph";
import {
  APPROVAL_TONE,
  DONE_TONE,
  FAILURE_TONE,
  FORK_TONE,
  INTERVIEW_TONE,
  NOTIFICATION_STATUS_TONES,
  type IndicatorTone,
} from "../notification-indicator-tones";

afterEach(() => cleanup());

const TONE_CASES: ReadonlyArray<readonly [string, IndicatorTone, string]> = [
  ["done", DONE_TONE, "lucide-message-square-check"],
  ["failure", FAILURE_TONE, "lucide-message-square-x"],
  ["fork", FORK_TONE, "lucide-git-fork"],
  ["interview", INTERVIEW_TONE, "lucide-message-square-question-mark"],
  ["approval", APPROVAL_TONE, "lucide-message-square-warning"],
  ["browser", NOTIFICATION_STATUS_TONES.browser, "lucide-globe-alert"],
];

/** Every branch, keyed by the `data-status-glyph` value it draws. */
const STATUS_CASES: ReadonlyArray<readonly [string, StatusGlyphStatus]> = [
  ...TONE_CASES.map(([, tone]) => [tone.testId, tone] as const),
  ["running", "running"],
  ["background", "background"],
];

describe("StatusGlyph", () => {
  it.each(TONE_CASES)(
    "renders the %s tone's own lucide icon and colour class",
    (_name, tone, lucideClass) => {
      render(
        <StatusGlyph
          status={tone}
          className="size-3"
          testId={undefined}
          label={null}
        />,
      );
      const glyph = document.querySelector(
        `[data-status-glyph="${tone.testId}"]`,
      );
      expect(glyph).not.toBeNull();
      expect(glyph?.classList.contains(lucideClass)).toBe(true);
      expect(glyph?.classList.contains(tone.className)).toBe(true);
    },
  );

  it.each(STATUS_CASES)(
    "hides the %s glyph from assistive tech when label is null",
    (glyphId, status) => {
      render(
        <StatusGlyph
          status={status}
          className="size-3"
          testId={undefined}
          label={null}
        />,
      );
      const glyph = document.querySelector(`[data-status-glyph="${glyphId}"]`);
      expect(glyph?.getAttribute("aria-hidden")).toBe("true");
      expect(glyph?.getAttribute("role")).toBeNull();
    },
  );

  it.each(STATUS_CASES)(
    "exposes an accessible name for the %s glyph when a label is given",
    (glyphId, status) => {
      render(
        <StatusGlyph
          status={status}
          className="size-3"
          testId={undefined}
          label="Status label"
        />,
      );
      const glyph = screen.getByRole("img", { name: "Status label" });
      expect(glyph.getAttribute("data-status-glyph")).toBe(glyphId);
    },
  );

  it("carries a testId onto the tone icon", () => {
    render(
      <StatusGlyph
        status={FAILURE_TONE}
        className="size-3"
        testId="failure-glyph"
        label={null}
      />,
    );
    expect(screen.getByTestId("failure-glyph")).toBe(
      document.querySelector('[data-status-glyph="failure"]'),
    );
  });

  it("marks the running glyph on its wrapping span, with the spinner inside", () => {
    render(
      <StatusGlyph
        status="running"
        className="size-3"
        testId="running-spinner"
        label={null}
      />,
    );
    const glyph = document.querySelector('[data-status-glyph="running"]');
    expect(glyph).not.toBeNull();
    expect(glyph?.tagName).toBe("SPAN");
    expect(
      glyph?.querySelector('[data-testid="running-spinner"]'),
    ).not.toBeNull();
  });

  it("renders the background glyph as the muted message-square-clock icon", () => {
    render(
      <StatusGlyph
        status="background"
        className="size-3"
        testId="background-glyph"
        label={null}
      />,
    );
    const glyph = document.querySelector('[data-status-glyph="background"]');
    expect(glyph).not.toBeNull();
    expect(glyph?.classList.contains("lucide-message-square-clock")).toBe(true);
    expect(glyph?.classList.contains("text-muted-foreground")).toBe(true);
    expect(glyph).toBe(screen.getByTestId("background-glyph"));
  });
});
