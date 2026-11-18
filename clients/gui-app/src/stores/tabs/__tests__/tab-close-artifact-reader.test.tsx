/**
 * Closing the last tab of a task through the REAL tab command coordinator
 * while a REAL artifact reference card (`BotArtifactReferenceCard`, over the
 * real controller token) is mounted on it, and what the card's Retry may do to
 * the session it shares with that tab.
 *
 * Closing: the card's reader is demand on the task's session, so a clean close
 * keeps the very same handle for it; a close that discards unsynced work
 * retires that handle and the surviving reader gets one fresh read source that
 * shows the server's version. Retry: the card never resets a shared session.
 */
import userEvent from "@testing-library/user-event";
import { screen, waitFor } from "@testing-library/react";
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
  EPIC_ID,
  MISSING_PATH,
  SERVER_TITLE,
  SURFACE,
  ROW_KEY,
  admittedHandle,
  closeTab,
  deliverSnapshot,
  failStream,
  firstToken,
  figureLabel,
  installReaderCardHarness,
  localTitleEdit,
  openShownTabs,
  seen,
  showCardAlone,
  showCardAndFrame,
  showCardOnTask,
  openShownTaskTab,
} from "@/components/bots/__tests__/artifact-reader-card-harness-support";
import { getEpicSessionController } from "@/lib/registries/epic-session-controller";
import { __getOpenEpicRegistryForTests } from "@/lib/registries/epic-session-registry";
import { DEFAULT_MAX_LIVE_EPICS } from "@/stores/replica-memory/budget-limits";
import { seedLocalRootEdit } from "@/lib/registries/test-support/epic-session-controller-test-support";

installReaderCardHarness();

function status() {
  return getEpicSessionController().readEntryStatusForTests(EPIC_ID);
}

/** The real session finishing a fresh construction: a new subscribe, then the served task. */
async function awaitFreshConstruction(subscribesBefore: number): Promise<void> {
  await waitFor(() =>
    expect(seen.subscribes).toBeGreaterThan(subscribesBefore),
  );
  deliverSnapshot();
}

describe("closing the last task tab under a mounted artifact card", () => {
  it("a clean close keeps the same handle and the same content, and starts nothing again", async () => {
    const { tabId } = await showCardAndFrame();
    const handle = admittedHandle();
    const frame = screen.getByTestId("artifact-frame-driver");
    const label = figureLabel();
    const disposeHandle = vi.spyOn(handle, "dispose");
    const readsBefore = seen.objectReads;
    const constructionsBefore = seen.constructions;
    expect(status()).toMatchObject({ hasSession: true, suspended: false });

    closeTab(tabId);

    expect(__getOpenEpicRegistryForTests().peek(EPIC_ID)).toBe(handle);
    expect(status()).toMatchObject({ hasSession: true, suspended: false });
    expect(disposeHandle).not.toHaveBeenCalled();
    // The same version of the same task, in the same frame.
    expect(figureLabel()).toBe(label);
    expect(label).toBe(`Artifact: ${SERVER_TITLE}`);
    expect(screen.getByTestId("artifact-frame-driver")).toBe(frame);
    expect(seen.objectReads).toBe(readsBefore);
    expect(seen.constructions).toBe(constructionsBefore);
    expect(seen.tokens[0]?.read().kind).toBe("ready");

    // After the close the card's demand is what keeps the session: a tab
    // acquisition over the cap leaves it alone.
    openShownTabs(DEFAULT_MAX_LIVE_EPICS, "other");
    openShownTabs(1, "one-more");
    expect(disposeHandle).not.toHaveBeenCalled();
    expect(__getOpenEpicRegistryForTests().peek(EPIC_ID)).toBe(handle);
    expect(screen.getByTestId("artifact-frame-driver")).toBe(frame);
  });

  it("a close that discards unsynced work retires the handle once, and the card shows the server's version from one fresh construction", async () => {
    const { tabId } = await showCardAndFrame();
    const handle = admittedHandle();
    await handle.applyRootUpdate(localTitleEdit("Edited locally"), true);
    await waitFor(() => expect(figureLabel()).toBe("Artifact: Edited locally"));
    const registry = __getOpenEpicRegistryForTests();
    expect(registry.hasUnsyncedEdits(EPIC_ID)).toBe(true);
    const disposeHandle = vi.spyOn(handle, "dispose");
    const constructionsBefore = seen.constructions;
    const subscribesBefore = seen.subscribes;

    closeTab(tabId);

    // The discard is the ordinary retirement; the reader is then given one
    // fresh read source, which has the server's task and none of the edit.
    expect(disposeHandle).toHaveBeenCalledTimes(1);
    await awaitFreshConstruction(subscribesBefore);
    await waitFor(() =>
      expect(figureLabel()).toBe(`Artifact: ${SERVER_TITLE}`),
    );
    expect(seen.constructions).toBe(constructionsBefore + 1);
    expect(registry.peek(EPIC_ID)).not.toBe(handle);
    expect(registry.hasUnsyncedEdits(EPIC_ID)).toBe(false);
    expect(screen.getByTestId("artifact-frame-driver")).toBeTruthy();
    expect(status()).toMatchObject({ hasSession: true, suspended: false });
  });

  it("the last card letting go leaves the session warm, and a repeated release changes nothing", async () => {
    const { tabId, view } = await showCardAndFrame();
    const handle = admittedHandle();
    const disposeHandle = vi.spyOn(handle, "dispose");
    closeTab(tabId);
    const token = firstToken();

    view.unmount();

    // No tabs and no readers: the demand is gone, the handle is only warm.
    const registry = __getOpenEpicRegistryForTests();
    expect(registry.hasReaderDemand(EPIC_ID)).toBe(false);
    expect(registry.peek(EPIC_ID)).toBe(handle);
    expect(disposeHandle).not.toHaveBeenCalled();
    token.release();
    token.release();
    expect(registry.hasReaderDemand(EPIC_ID)).toBe(false);
    expect(registry.peek(EPIC_ID)).toBe(handle);
    expect(disposeHandle).not.toHaveBeenCalled();
    expect(token.read().kind).toBe("closed");
  });

  it("closes the tab's session at the close when no card holds it", () => {
    const { tabId } = openShownTaskTab();
    const registry = __getOpenEpicRegistryForTests();
    expect(registry.peek(EPIC_ID)).not.toBeNull();

    closeTab(tabId);

    expect(registry.peek(EPIC_ID)).toBeNull();
  });

  it("keeps work that arrives after the close when the last card then lets go: the warm handle still holds the edit", async () => {
    const { tabId, view } = await showCardAndFrame();
    const handle = admittedHandle();
    closeTab(tabId);
    await seedLocalRootEdit(handle, "title", "Edited after the close");
    const registry = __getOpenEpicRegistryForTests();
    expect(registry.hasUnsyncedEdits(EPIC_ID)).toBe(true);

    const disposeHandle = vi.spyOn(handle, "dispose");

    view.unmount();

    expect(registry.hasReaderDemand(EPIC_ID)).toBe(false);
    expect(registry.peek(EPIC_ID)).toBe(handle);
    expect(disposeHandle).not.toHaveBeenCalled();
    expect(registry.hasUnsyncedEdits(EPIC_ID)).toBe(true);
  });
});

/** What a Retry on the shared handle would lose or restart, read from the real store and stream. */
function captureSharedState() {
  const handle = admittedHandle();
  const state = handle.store.getState();
  return {
    handle,
    queued: state.unsyncedQueueSize,
    dirty: state.isDirty,
    subscribes: seen.subscribes,
  };
}

describe("card Retry never resets a dirty shared tab", () => {
  it("leaves the tab's unsynced work, handle and stream alone when the reference resolves to nothing", async () => {
    await showCardOnTask(MISSING_PATH);
    const retry = await screen.findByRole("button", { name: "Retry" });
    const handle = admittedHandle();
    await seedLocalRootEdit(handle, "title", "Unsynced tab work");
    const refresh = vi.spyOn(handle, "requestFreshSnapshot");
    const before = captureSharedState();
    expect(before.dirty).toBe(true);
    expect(__getOpenEpicRegistryForTests().hasUnsyncedEdits(EPIC_ID)).toBe(
      true,
    );

    await userEvent.setup().click(retry);

    expect(refresh).not.toHaveBeenCalled();
    const after = captureSharedState();
    expect(after.handle).toBe(before.handle);
    expect(after.queued).toBe(before.queued);
    expect(after.dirty).toBe(true);
    expect(after.subscribes).toBe(before.subscribes);
    expect(__getOpenEpicRegistryForTests().hasUnsyncedEdits(EPIC_ID)).toBe(
      true,
    );
  });

  it("re-reads a failed entry object on Retry without touching the tab's unsynced work", async () => {
    seen.objectReadsToFail = 1;
    await showCardOnTask(SURFACE);
    const retry = await screen.findByRole("button", { name: "Retry" });
    const handle = admittedHandle();
    await seedLocalRootEdit(handle, "title", "Unsynced tab work");
    const refresh = vi.spyOn(handle, "requestFreshSnapshot");
    const before = captureSharedState();
    const readsBefore = seen.objectReads;
    expect(before.dirty).toBe(true);

    await userEvent.setup().click(retry);

    await waitFor(() => expect(seen.objectReads).toBeGreaterThan(readsBefore));
    await screen.findByTestId("artifact-frame-driver");
    expect(refresh).not.toHaveBeenCalled();
    const after = captureSharedState();
    expect(after.handle).toBe(before.handle);
    expect(after.queued).toBe(before.queued);
    expect(after.dirty).toBe(true);
    expect(after.subscribes).toBe(before.subscribes);
    expect(__getOpenEpicRegistryForTests().hasUnsyncedEdits(EPIC_ID)).toBe(
      true,
    );
  });
});

describe("card Retry on a session only the reader built", () => {
  it("a never-loaded handle with a retryable code is re-opened: one new construction, the old handle disposed, no fresh-snapshot request", async () => {
    await showCardAlone(SURFACE, ROW_KEY);
    failStream("EPIC_INIT_FAILED");
    const handle = admittedHandle();
    await waitFor(() =>
      expect(handle.store.getState().snapshotFetchError).not.toBeNull(),
    );
    expect(handle.store.getState().snapshotLoaded).toBe(false);
    const retry = await screen.findByRole("button", { name: "Retry" });
    const refresh = vi.spyOn(handle, "requestFreshSnapshot");
    const disposeOld = vi.spyOn(handle, "dispose");
    const constructionsBefore = seen.constructions;

    await userEvent.setup().click(retry);

    expect(refresh).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(seen.constructions).toBe(constructionsBefore + 1),
    );
    expect(disposeOld).toHaveBeenCalledTimes(1);
    expect(__getOpenEpicRegistryForTests().peek(EPIC_ID)).not.toBe(handle);
  });

  it("a FORBIDDEN never-loaded handle is not re-opened by Retry", async () => {
    // Access is still refused when the card asks the host again.
    seen.authority = "forbidden";
    await showCardAlone(SURFACE, ROW_KEY);
    failStream("FORBIDDEN");
    const handle = admittedHandle();
    await waitFor(() =>
      expect(handle.store.getState().snapshotFetchError).not.toBeNull(),
    );
    const retry = await screen.findByRole("button", { name: "Retry" });
    const refresh = vi.spyOn(handle, "requestFreshSnapshot");
    const constructionsBefore = seen.constructions;
    const subscribesBefore = seen.subscribes;

    await userEvent.setup().click(retry);

    expect(refresh).not.toHaveBeenCalled();
    expect(seen.constructions).toBe(constructionsBefore);
    expect(seen.subscribes).toBe(subscribesBefore);
    expect(__getOpenEpicRegistryForTests().peek(EPIC_ID)).toBe(handle);
  });
});
