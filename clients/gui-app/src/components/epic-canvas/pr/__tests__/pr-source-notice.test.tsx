import { describe, it, expect, afterEach } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { PrSourceNotice } from "@traycer/protocol/host/pr-schemas";
import { TooltipProvider } from "@/components/ui/tooltip";
import { PrSourceNoticeHint } from "@/components/epic-canvas/pr/pr-source-notice";
import { prSourceNoticeMessage } from "@/lib/pr/pr-source-notice-message";

afterEach(() => {
  cleanup();
});

function renderHint(notice: PrSourceNotice): void {
  render(
    <TooltipProvider>
      <PrSourceNoticeHint notice={notice} />
    </TooltipProvider>,
  );
}

describe("prSourceNoticeMessage", () => {
  it("names the rate limit rather than reporting a failure", () => {
    // The rows on screen are real - the host simply stopped refreshing them.
    // Copy that said "error" would send the user hunting for a broken thing.
    const message = prSourceNoticeMessage(
      { kind: "rate-limited", retryAt: 1_000 },
      "12m",
    );
    expect(message).toContain("rate limit");
    expect(message).toContain("12m");
    expect(message.toLowerCase()).not.toContain("error");
    expect(message.toLowerCase()).not.toContain("failed");
  });

  it("promises no resume time when the host has not learned one", () => {
    // `retryAt: null` is precisely the case where the host is holding back
    // BECAUSE it does not know when GitHub's window resets. Naming a time
    // there would present a guess as a fact.
    const message = prSourceNoticeMessage(
      { kind: "rate-limited", retryAt: null },
      null,
    );
    expect(message).toContain("automatically");
    expect(message).not.toMatch(/\d/u);
  });

  it("distinguishes an unreachable GitHub from a rate limit", () => {
    const backingOff = prSourceNoticeMessage(
      { kind: "backing-off", retryAt: 1_000 },
      "30s",
    );
    expect(backingOff).toContain("reach GitHub");
    expect(backingOff).not.toContain("rate limit");
    expect(backingOff).toContain("30s");
  });

  it("never claims what is on screen, whatever the kind", () => {
    // The pause says nothing about whether anything was ever fetched: a PR
    // rate-limited before its first successful sweep has no "last data" to be
    // showing, and the freshness stamp beside the icon is what answers that.
    // Claiming it here made the tooltip contradict "Not yet fetched" sitting
    // one element away.
    for (const notice of [
      { kind: "rate-limited", retryAt: null },
      { kind: "rate-limited", retryAt: 1_000 },
      { kind: "backing-off", retryAt: null },
      { kind: "backing-off", retryAt: 1_000 },
    ] satisfies PrSourceNotice[]) {
      for (const countdown of [null, "5m"]) {
        const message = prSourceNoticeMessage(notice, countdown);
        expect(message).not.toMatch(/last data|showing|cached/iu);
        // Still says the two things it IS entitled to say: refreshing has
        // stopped, and it comes back.
        expect(message).toContain("not refreshing");
        expect(message).toMatch(/resumes|retrying|keeps retrying/u);
      }
    }
  });
});

describe("PrSourceNoticeHint", () => {
  it("puts the sentence in the live region's TEXT, which is what gets announced", () => {
    // One dialect, one place: the host sends structure and no prose, so the
    // pointer affordance and the screen-reader affordance must not be able to
    // drift into saying different things.
    //
    // It has to be text content, not the region's `aria-label`. A live region
    // announces its accessible CONTENT when that content changes; an
    // `aria-label` on an otherwise-empty region leaves nothing to announce, so
    // the pause would appear on screen and say nothing at all.
    renderHint({ kind: "rate-limited", retryAt: null });
    const expected = prSourceNoticeMessage(
      { kind: "rate-limited", retryAt: null },
      null,
    );
    // Selected by ROLE, which is the accessible contract itself rather than a
    // proxy for it: if the live region stops being a `status`, this query
    // fails instead of a separate attribute assertion doing so.
    const region = screen.getByRole("status");
    expect(region.textContent).toContain(expected);
  });

  it("marks which pause it is, so the two are tellable apart in the DOM", () => {
    renderHint({ kind: "backing-off", retryAt: null });
    expect(
      screen.getByTestId("pr-source-notice").getAttribute("data-notice-kind"),
    ).toBe("backing-off");
  });

  it("announces itself as status, not as an alert", () => {
    // A pause is informational. `role="alert"` would interrupt a screen
    // reader mid-sentence every time a background window closed.
    renderHint({ kind: "rate-limited", retryAt: null });
    expect(screen.getByTestId("pr-source-notice").getAttribute("role")).toBe(
      "status",
    );
  });

  it("is reachable by keyboard, since the tooltip is the only place the full explanation exists", () => {
    // A hover-only trigger hands the explanation to pointer users while
    // leaving sighted keyboard users looking at an icon they cannot open. The
    // trigger is a real button rather than a focusable live region: the latter
    // is what `jsx-a11y/no-noninteractive-tabindex` rejects, and it is right -
    // a status region is not a control.
    renderHint({ kind: "rate-limited", retryAt: null });
    const trigger = screen.getByTestId("pr-source-notice-trigger");
    expect(trigger.tagName).toBe("BUTTON");
    expect(trigger.getAttribute("aria-label")).toBe(
      prSourceNoticeMessage({ kind: "rate-limited", retryAt: null }, null),
    );
  });
});
