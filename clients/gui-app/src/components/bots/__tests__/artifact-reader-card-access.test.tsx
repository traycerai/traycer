/**
 * When the host stops serving a task to the artifact card's reader: a terminal
 * denial withdraws everything the card showed and everything it was doing, a
 * reconnect does not, and an explicit Retry after a refusal asks the host
 * whether access is back before the card builds anything.
 */
import userEvent from "@testing-library/user-event";
import { act, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const save = vi.hoisted(() => ({
  downloadFile: vi.fn(),
  savedToast: vi.fn(),
}));

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
vi.mock("@/hooks/files/use-file-save-host", () => ({
  useFileSaveHost: () => ({
    saveFile: vi.fn(),
    openSavedFile: null,
    downloadFile: save.downloadFile,
  }),
}));
vi.mock("@/lib/files/saved-file-toast", () => ({
  toastSavedFile: save.savedToast,
}));

import {
  AUTHORED_TITLE,
  EPIC_ID,
  SERVER_TITLE,
  SURFACE,
  admittedHandle,
  deliverSnapshot,
  failStream,
  figureLabel,
  installReaderCardHarness,
  downloadsInFlight,
  heldObjectReadCount,
  reconnectStream,
  releaseHeldObjectReads,
  seen,
  showCardAlone,
} from "@/components/bots/__tests__/artifact-reader-card-harness-support";
import { __getOpenEpicRegistryForTests } from "@/lib/registries/epic-session-registry";

installReaderCardHarness();

/** A loaded reader-only session showing its frame. */
async function showLoadedCard() {
  const view = await showCardAlone(SURFACE, "row-1");
  deliverSnapshot();
  await screen.findByTestId("artifact-frame-driver");
  return view;
}

function openButton() {
  return screen.queryByRole("button", { name: "Open in panel" });
}

describe.each(["NOT_FOUND", "FORBIDDEN"] as const)(
  "a terminal %s on a loaded reader-only session",
  (code) => {
    it("withdraws the frame and the Open, and a ZIP started earlier writes nothing", async () => {
      await showLoadedCard();
      expect(openButton()).not.toBeNull();
      // A ZIP the person started: its object reads are still in flight.
      seen.holdObjectReads = true;
      await userEvent
        .setup()
        .click(screen.getByRole("button", { name: /download/i }));
      // The ZIP really began: an object read is parked and the download is
      // in flight, so the release below has something to let through.
      await waitFor(() => expect(heldObjectReadCount()).toBeGreaterThan(0));
      expect(downloadsInFlight()).toBe(1);

      failStream(code);

      await waitFor(() =>
        expect(screen.queryByTestId("artifact-frame-driver")).toBeNull(),
      );
      expect(openButton()).toBeNull();
      // The transcript's own title stays; nothing projected from the task does.
      expect(screen.getByText(AUTHORED_TITLE)).toBeTruthy();
      expect(screen.queryByText(SERVER_TITLE)).toBeNull();
      expect(figureLabel()).not.toContain(SERVER_TITLE);
      releaseHeldObjectReads();
      // The download settles: the held reads answered and the ZIP's attempt
      // to finish is over.
      await waitFor(() => expect(downloadsInFlight()).toBe(0));
      expect(save.downloadFile).not.toHaveBeenCalled();
      expect(save.savedToast).not.toHaveBeenCalled();
    });
  },
);

describe("a reconnecting session", () => {
  it("keeps the card's content and its Open", async () => {
    await showLoadedCard();
    const frame = screen.getByTestId("artifact-frame-driver");

    reconnectStream();

    expect(screen.getByTestId("artifact-frame-driver")).toBe(frame);
    expect(openButton()).not.toBeNull();
  });
});

describe("Retry after a refusal", () => {
  it("builds nothing until the host's authority answer says access is back, then re-admits", async () => {
    await showLoadedCard();
    seen.authority = "forbidden";
    failStream("FORBIDDEN");
    await waitFor(() =>
      expect(screen.queryByTestId("artifact-frame-driver")).toBeNull(),
    );
    const constructionsBefore = seen.constructions;
    const subscribesBefore = seen.subscribes;
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "Retry" }));

    await waitFor(() => expect(seen.authorityProbes).toBe(1));
    expect(seen.lastProbe).toEqual({
      epicId: EPIC_ID,
      hasDocReplica: false,
      knownRevision: null,
    });
    expect(seen.constructions).toBe(constructionsBefore);
    expect(seen.subscribes).toBe(subscribesBefore);
    expect(screen.queryByTestId("artifact-frame-driver")).toBeNull();

    seen.authority = "permitted";
    await user.click(await screen.findByRole("button", { name: "Retry" }));

    await waitFor(() => expect(seen.authorityProbes).toBe(2));
    await waitFor(() =>
      expect(seen.subscribes).toBeGreaterThan(subscribesBefore),
    );
    deliverSnapshot();
    await screen.findByTestId("artifact-frame-driver");
    expect(openButton()).not.toBeNull();
  });

  it("does not re-admit a denied warm snapshot by re-attaching a new card", async () => {
    const first = await showLoadedCard();
    seen.authority = "forbidden";
    failStream("FORBIDDEN");
    await waitFor(() =>
      expect(screen.queryByTestId("artifact-frame-driver")).toBeNull(),
    );
    const handle = admittedHandle();
    const constructionsBefore = seen.constructions;
    first.unmount();

    await showCardAlone(SURFACE, "row-2");

    expect(screen.queryByTestId("artifact-frame-driver")).toBeNull();
    expect(openButton()).toBeNull();
    expect(seen.constructions).toBe(constructionsBefore);
    expect(__getOpenEpicRegistryForTests().peek(EPIC_ID)).toBe(handle);
  });
});

describe("a terminal UNAUTHORIZED on a loaded reader-only session", () => {
  it("withdraws the frame and the Open, and keeps the transcript's own title", async () => {
    await showLoadedCard();
    expect(openButton()).not.toBeNull();

    failStream("UNAUTHORIZED");

    await waitFor(() =>
      expect(screen.queryByTestId("artifact-frame-driver")).toBeNull(),
    );
    expect(openButton()).toBeNull();
    expect(screen.getByText(AUTHORED_TITLE)).toBeTruthy();
    expect(screen.queryByText(SERVER_TITLE)).toBeNull();
    expect(figureLabel()).not.toContain(SERVER_TITLE);
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });

  it("Retry asks the host once per press and stays withdrawn while it refuses", async () => {
    await showLoadedCard();
    // The host's authority answer is held, then refuses.
    const answer = Promise.withResolvers<void>();
    seen.authority = "forbidden";
    seen.authorityGate = answer.promise;
    failStream("UNAUTHORIZED");
    await waitFor(() =>
      expect(screen.queryByTestId("artifact-frame-driver")).toBeNull(),
    );
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "Retry" }));

    // Exactly one authority probe, and it is waiting on the host.
    await waitFor(() => expect(seen.authorityProbes).toBe(1));
    answer.resolve();
    // The refusal lands: the first probe has settled once a second press may
    // issue its own, and that is the only way a second one is sent.
    await user.click(await screen.findByRole("button", { name: "Retry" }));
    await waitFor(() => expect(seen.authorityProbes).toBe(2));
    await act(async () => {
      await Promise.resolve();
    });
    expect(seen.authorityProbes).toBe(2);
    expect(screen.queryByTestId("artifact-frame-driver")).toBeNull();
    expect(openButton()).toBeNull();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });
});
