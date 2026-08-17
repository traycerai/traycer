import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  MockRunnerHost,
  MockTraycerCli,
} from "@traycer-clients/shared/host-client/mock/mock-runner-host";

import { LocalHostLoadingContent } from "@/components/local-host-loading";
import {
  buildHostProgressView,
  type HostProgressView,
} from "@/lib/host/host-progress-copy";
import { TooltipProvider } from "@/components/ui/tooltip";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { useAuthStore } from "@/stores/auth/auth-store";

/** Lane identity is irrelevant to the copy under test; fixed so it cannot drift. */
const LANE_STARTED_AT = "2026-01-01T00:00:00.000Z";

function buildHost(): MockRunnerHost {
  return new MockRunnerHost({
    signInUrl: "https://auth.traycer.invalid/sign-in",
    authnBaseUrl: "http://localhost:5005",
    localHost: null,
    hosts: [],
    workspaceFolderPickerPaths: undefined,
    hasLocalHost: undefined,
    traycerCli: undefined,
  });
}

function buildQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
}

function mountLoadingContent(
  host: MockRunnerHost,
  progress: HostProgressView | null,
): HTMLElement {
  const { container } = render(
    <QueryClientProvider client={buildQueryClient()}>
      <RunnerHostProvider runnerHost={host}>
        <TooltipProvider>
          <LocalHostLoadingContent
            progress={progress}
            onConfigureShell={() => undefined}
          />
        </TooltipProvider>
      </RunnerHostProvider>
    </QueryClientProvider>,
  );
  return container;
}

describe("<LocalHostLoadingContent />", () => {
  afterEach(() => {
    cleanup();
    useAuthStore.getState().setSignedOut();
  });

  it("renders spinner, heading, and no Retry or [host] logs hint", () => {
    // P3.4 deleted the `stage="slow"` arm outright (every surviving caller
    // passes a start that is still progressing), so this body no longer
    // branches - there is no slow copy or Retry to withhold, only to
    // structurally never have.
    const container = mountLoadingContent(buildHost(), null);

    // Spinner is visible.
    expect(screen.queryByTestId("local-host-loading-spinner")).not.toBeNull();

    // Primary heading.
    expect(container.textContent).toContain("Starting local Traycer Host…");

    expect(screen.queryByTestId("local-host-loading-slow-copy")).toBeNull();
    expect(screen.queryByTestId("local-host-retry")).toBeNull();
    expect(container.textContent).not.toContain("[host]");

    // The DISCLOSURE itself, not just its contents. The `[host]` assertion
    // above is about the log tail, which only renders once the disclosure is
    // OPEN - so it says nothing about whether the closed toggle should be
    // there at all, and deleting the `hasCli` guard sailed past it (measured).
    // This shell has no CLI, so there is no log to offer.
    expect(
      screen.queryByTestId("local-host-loading-toggle-details"),
    ).toBeNull();
  });

  it("offers the bootstrap-log disclosure on a shell that HAS the CLI", () => {
    // The positive control for the assertion above: without it, "no toggle"
    // would be satisfied by a body that can never draw one, which is the same
    // vacuity as proving an absence from an absent input.
    const host = new MockRunnerHost({
      signInUrl: "https://auth.traycer.invalid/sign-in",
      authnBaseUrl: "http://localhost:5005",
      localHost: null,
      hosts: [],
      workspaceFolderPickerPaths: undefined,
      hasLocalHost: undefined,
      traycerCli: new MockTraycerCli(),
    });

    mountLoadingContent(host, null);

    expect(
      screen.queryByTestId("local-host-loading-toggle-details"),
    ).not.toBeNull();
  });

  it("renders host download progress with percentage and byte count", () => {
    const container = mountLoadingContent(
      buildHost(),
      // Built through the REAL shared table, not a hand-written view:
      // the copy and the units are what this asserts, and a
      // hand-assembled view would supply the very thing under test.
      buildHostProgressView({
        kind: "ensure",
        startedAt: LANE_STARTED_AT,
        progress: {
          stage: "download",
          percent: 42,
          bytes: 104_857_600,
          totalBytes: 250_609_664,
          message: "downloading host 1.2.3",
        },
      }),
    );

    expect(container.textContent).toContain("Downloading Traycer Host…");
    expect(container.textContent).toContain("downloading host 1.2.3");
    expect(container.textContent).toContain("100 MB of 239 MB");
    expect(container.textContent).toContain("42%");
    const progress = screen.getByRole("progressbar");
    expect(progress.getAttribute("aria-valuenow")).toBe("42");
  });

  it("uses setup copy for non-download progress without byte counts", () => {
    const container = mountLoadingContent(
      buildHost(),
      buildHostProgressView({
        kind: "ensure",
        startedAt: LANE_STARTED_AT,
        progress: {
          stage: "extract",
          percent: 80,
          bytes: null,
          totalBytes: null,
          message: "extracting host runtime",
        },
      }),
    );

    expect(container.textContent).toContain("Setting up Traycer Host…");
    expect(container.textContent).toContain("Setting up…");
    expect(container.textContent).toContain("80%");
    expect(container.textContent).not.toContain("Downloading…");
  });

  /**
   * The disclosure toggle NAMES the region it expands, in both states.
   *
   * `aria-expanded` alone tells assistive tech that something expanded without
   * saying what, so the toggle also carries `aria-controls`. What that buys
   * depends entirely on the id RESOLVING: a dangling `aria-controls` is worse
   * than none, because it announces a control that operates nothing. The region
   * therefore stays in the DOM under `hidden` rather than unmounting, and the
   * closed state is the half of this that can silently rot - which is why it is
   * asserted first and by the same lookup the browser does.
   */
  it("names its region with an aria-controls that resolves both closed and open", () => {
    mountLoadingContent(
      new MockRunnerHost({
        signInUrl: "https://auth.traycer.invalid/sign-in",
        authnBaseUrl: "http://localhost:5005",
        localHost: null,
        hosts: [],
        workspaceFolderPickerPaths: undefined,
        hasLocalHost: undefined,
        traycerCli: new MockTraycerCli(),
      }),
      null,
    );

    const toggle = screen.getByTestId("local-host-loading-toggle-details");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    const regionId = toggle.getAttribute("aria-controls");
    // Non-empty before it is resolved: `getElementById("")` returns null, so a
    // missing attribute and a blank one would both fail the lookup below for
    // the wrong reason and read as the same defect.
    expect(regionId).not.toBeNull();
    expect(regionId).not.toBe("");
    // CLOSED. The state where an unmounted region would leave the id dangling.
    expect(document.getElementById(String(regionId))).not.toBeNull();

    fireEvent.click(toggle);

    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    // The SAME id, still resolving: a region that remounts under a fresh id
    // each time would satisfy a per-state lookup while breaking the reference
    // the toggle already published.
    expect(toggle.getAttribute("aria-controls")).toBe(regionId);
    const region = document.getElementById(String(regionId));
    expect(region).not.toBeNull();
    // And it is the region that actually holds the disclosed content, not an
    // empty node that happens to carry the id. Anchored on the "Configure
    // shell…" action rather than the log tail: the tail arrives with the status
    // query, so asserting through it would make this pass or fail on fetch
    // timing instead of on the reference under test.
    expect(
      region?.contains(screen.getByTestId("local-host-open-shell-settings")),
    ).toBe(true);
  });
});
