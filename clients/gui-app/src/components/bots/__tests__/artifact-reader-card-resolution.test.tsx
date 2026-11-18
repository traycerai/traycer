/**
 * Which artifact a path reference names: an html bundle owns the paths under
 * its folder, so a page deeper inside it resolves to the bundle (the frame still
 * opens the bundle's own entry), while a path outside the admitted root stays
 * unresolved.
 */
import { screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn(),
  useRouter: () => null,
}));
vi.mock("@/components/sandbox/sandbox-frame", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/components/sandbox/sandbox-frame")
  >()),
  SandboxFrame: (
    await import("@/components/sandbox/__tests__/artifact-frame-browser-driver")
  ).ArtifactFrameBrowserDriver,
}));
vi.mock(
  "@/components/epic-tabs/pane-visibility-context",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/components/epic-tabs/pane-visibility-context")
    >()),
    usePaneVisible: () => true,
    usePaneFocused: () => true,
    usePaneFocusProbe: () => () => true,
  }),
);

import {
  SERVER_TITLE,
  SURFACE,
  figureLabel,
  installReaderCardHarness,
  seen,
  showCardOnTask,
} from "@/components/bots/__tests__/artifact-reader-card-harness-support";

installReaderCardHarness();

describe("a path reference deeper than its bundle", () => {
  it("resolves to the html bundle that owns it and shows the bundle's own entry", async () => {
    await showCardOnTask({
      ...SURFACE,
      artifactPath: "rollout/pages/detail.html",
    });

    await screen.findByTestId("artifact-frame-driver");
    expect(figureLabel()).toBe(`Artifact: ${SERVER_TITLE}`);
    expect(seen.objectReads).toBeGreaterThan(0);
  });

  it("stays unresolved when no bundle in the admitted root owns it", async () => {
    await showCardOnTask({
      ...SURFACE,
      artifactPath: "elsewhere/pages/detail.html",
    });

    await screen.findByText("Artifact unavailable.");
    expect(screen.queryByTestId("artifact-frame-driver")).toBeNull();
    expect(seen.objectReads).toBe(0);
  });
});
