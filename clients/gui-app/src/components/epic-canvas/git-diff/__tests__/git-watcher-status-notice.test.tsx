import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { GitWatcherStatus } from "@traycer/protocol/host/git-schemas";
import { TooltipProvider } from "@/components/ui/tooltip";
import { GitWatcherStatusNotice } from "../git-watcher-status-notice";

function renderNotice(status: GitWatcherStatus | null): void {
  render(
    <TooltipProvider>
      <GitWatcherStatusNotice status={status} className={undefined} />
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
