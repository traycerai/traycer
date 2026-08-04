import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import type { GitWatcherStatus } from "@traycer/protocol/host/git-schemas";
import { TooltipProvider } from "@/components/ui/tooltip";
import { GitWatcherStatusNotice } from "../git-watcher-status-notice";

function renderNotice(status: GitWatcherStatus | null): void {
  render(
    <TooltipProvider>
      <GitWatcherStatusNotice
        status={status}
        className={undefined}
        compact={false}
      />
    </TooltipProvider>,
  );
}

/** Icon-only form used in the narrow diff-tile toolbar. */
function renderCompactNotice(status: GitWatcherStatus | null): void {
  render(
    <TooltipProvider>
      <GitWatcherStatusNotice status={status} className={undefined} compact />
    </TooltipProvider>,
  );
}

const NOTICE = "git-watcher-status-notice";

describe("<GitWatcherStatusNotice />", () => {
  afterEach(() => {
    cleanup();
  });

  it("says nothing when the host never reported watcher health", () => {
    // `null` is UNKNOWN - an older host, or no frame yet. Rendering anything
    // here would assert something this client has no evidence for.
    renderNotice(null);
    expect(screen.queryByTestId(NOTICE)).toBeNull();
  });

  it("says nothing while the watcher is healthy or still arming", () => {
    // "starting" is on the path of EVERY subscription (the host cannot arm
    // until the first poll resolves the repo root), so rendering it would
    // flash a notice on every tab open.
    for (const state of ["watching", "starting"] as const) {
      renderNotice({ state, detail: null });
      expect(screen.queryByTestId(NOTICE)).toBeNull();
      cleanup();
    }
  });

  it("marks both degraded states, distinguishably", () => {
    for (const state of ["degraded-capacity", "degraded-error"] as const) {
      renderNotice({ state, detail: null });
      expect(
        screen.getByTestId(NOTICE).getAttribute("data-watcher-state"),
      ).toBe(state);
      cleanup();
    }
  });

  it("renders without a detail string", () => {
    // `detail` is nullable on the wire; the notice must not depend on it.
    renderNotice({ state: "degraded-error", detail: null });
    expect(screen.getByTestId(NOTICE).textContent).toContain(
      "Periodic refresh",
    );
  });

  it("keeps the tooltip body in one block so the diagnostic stacks under the explanation", async () => {
    // `TooltipContent` is an `inline-flex` ROW. Two bare <p> siblings become
    // side-by-side columns inside `max-w-xs`, so a host diagnostic - the line
    // that carries the actual remedy - wraps into an unreadable ribbon.
    const user = userEvent.setup();
    renderNotice({
      state: "degraded-capacity",
      detail:
        "raise fs.inotify.max_user_watches to restore watcher-driven git status",
    });
    await user.hover(screen.getByTestId(NOTICE));

    const detail = await screen.findByText(/max_user_watches/u);
    const explanation = screen.getByText(/Periodic refresh|watch limit/u, {
      selector: "p",
    });
    // Same parent, and that parent is a single flex ITEM rather than the flex
    // CONTAINER. Asserting only "same parent" would be vacuous - two bare
    // siblings share the content element too - so pin that the shared parent
    // is not the content element itself.
    expect(detail.parentElement).toBe(explanation.parentElement);
    expect(detail.parentElement?.getAttribute("data-slot")).toBeNull();
    expect(detail.closest("[data-slot='tooltip-content']")).not.toBeNull();
  });

  it("drops the label but not the accessible name in compact form", async () => {
    // A diff tile can be dragged to a 240px pane and `DiffTabShell` marks the
    // whole toolbar `shrink-0`, so a non-shrinking two-word label next to three
    // or four icon controls pushes them out of the pane. Icon-only there - but
    // the button must still NAME itself, or the compact form is an unlabelled
    // control to assistive tech and the explanation becomes pointer-only.
    const user = userEvent.setup();
    renderCompactNotice({ state: "degraded-capacity", detail: null });

    const trigger = screen.getByTestId(NOTICE);
    expect(trigger.textContent).not.toContain("Periodic refresh");
    expect(trigger.getAttribute("aria-label")).toBe("Periodic refresh");
    expect(trigger.tagName).toBe("BUTTON");

    // And the full explanation is still one hover/focus away.
    await user.hover(trigger);
    expect(
      await screen.findByText(/watch limit|refresh on a timer/u),
    ).toBeTruthy();
  });

  it("exposes a keyboard-focusable trigger", () => {
    // The tooltip carries the entire explanation AND the remedy, so the
    // trigger has to be reachable without a pointer. An `asChild` <span>
    // renders identically and silently fails this.
    renderNotice({ state: "degraded-capacity", detail: "over budget" });
    const trigger = screen.getByTestId(NOTICE);
    expect(trigger.tagName).toBe("BUTTON");
    trigger.focus();
    expect(document.activeElement).toBe(trigger);
  });
});
