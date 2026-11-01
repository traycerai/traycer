import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SandboxFrameProps } from "@/components/sandbox/sandbox-frame";
import type { ArtifactManifest } from "@/lib/sandbox/artifact-serving";

/**
 * The page is a sandboxed iframe on a custom scheme, which jsdom will not
 * load, so this keeps the props the frame was last given and lets a test play
 * the part of the served document. Both halves of the contract are there: what
 * the document reports, and what the frame is asked for next — which is the
 * only way to see a retry, since the reader asks for the SAME page again and
 * the ask therefore shows up in `visit` rather than in `path`.
 */
const frames = vi.hoisted(() => ({ latest: null as SandboxFrameProps | null }));

vi.mock("@/components/sandbox/sandbox-frame", () => ({
  SandboxFrame: (props: SandboxFrameProps) => {
    frames.latest = props;
    return <div data-testid="page-frame" />;
  },
}));

import { ArtifactPagesFrame } from "@/components/html-artifact/artifact-pages-frame";

const MANIFEST: ArtifactManifest = {
  files: {
    "index.html": {
      sha256: "sha-index",
      byteLength: 10,
      mediaType: "text/html; charset=utf-8",
      status: "published",
    },
  },
};

function renderPages() {
  render(
    <ArtifactPagesFrame
      source={{
        kind: "artifact",
        artifactId: "artifact-a1",
        treePath: "site",
        entryPath: "index.html",
        manifest: MANIFEST,
        // Never called: the frame that would mount a server is the stand-in
        // above. What a refused read SERVES is the artifact server's own test.
        readSpan: () => Promise.resolve({ unavailable: "failed" }),
        resolveOutsideReference: () => null,
      }}
      title="Report"
      className=""
      height={null}
      pageZoom={false}
      onSize={() => undefined}
      onStatus={() => undefined}
      onBridge={null}
      onTextSelection={null}
      onFrame={null}
      renderOverlay={null}
      sourceEquivalent={undefined}
    />,
  );
  const navigation = (): NonNullable<SandboxFrameProps["pageNavigation"]> => {
    const value = frames.latest?.pageNavigation ?? null;
    if (value === null) throw new Error("expected a page navigation");
    return value;
  };
  /** What the served document reports, committed before the test looks. */
  const report = (
    what: (
      navigation: NonNullable<SandboxFrameProps["pageNavigation"]>,
    ) => void,
  ): void => {
    act(() => what(navigation()));
  };
  return { navigation, report };
}

const UNREACHABLE = "Couldn't load this page from the host that holds it.";
const MISSING = "This page is not in the artifact.";

afterEach(() => {
  cleanup();
  frames.latest = null;
});

describe("a served page the host would not hand over", () => {
  /**
   * The defect: the shell answers an unreadable artifact body with its error
   * status, whose body is the wire reason, and the frame renders that — the
   * reader is shown the bare word "failed" where the page should be.
   */
  it("says the page could not be loaded, and names where from", () => {
    const { report } = renderPages();

    report((navigation) => navigation.onPageUnreachable());

    expect(screen.getByText(UNREACHABLE)).toBeTruthy();
  });

  /**
   * Retry has to ask for the page the reader wanted, not send them home: the
   * page that failed is usually the entry page, so Home is the same broken
   * document. `visit` is what carries the ask, because `path` has not changed.
   */
  it("asks for the same page again on Retry, and clears the overlay", async () => {
    const user = userEvent.setup();
    const { navigation, report } = renderPages();
    report((page) => page.onPageUnreachable());
    const before = navigation();

    await user.click(screen.getByRole("button", { name: "Retry" }));

    expect(navigation().path).toBe(before.path);
    expect(navigation().visit).toBe(before.visit + 1);
    expect(screen.queryByText(UNREACHABLE)).toBeNull();
  });

  /**
   * A page the folder LACKS and a page whose bytes did not arrive are
   * different answers, and the reader gets a different sentence and a
   * different offer for each. One load has one answer, so the second report
   * must displace the first rather than stack a second overlay over it.
   */
  it("replaces the missing-page answer when a later load is unreachable instead", () => {
    const { report } = renderPages();

    report((page) => page.onPageMissing());
    expect(screen.getByText(MISSING)).toBeTruthy();

    report((page) => page.onPageUnreachable());

    expect(screen.getByText(UNREACHABLE)).toBeTruthy();
    expect(screen.queryByText(MISSING)).toBeNull();
    expect(screen.queryByRole("button", { name: "Go home" })).toBeNull();
  });

  it("clears the overlay once a page does load", () => {
    const { report } = renderPages();
    report((page) => page.onPageUnreachable());
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();

    report((page) => page.onNavigate("index.html"));

    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(screen.getByTestId("page-frame")).toBeTruthy();
  });
});
