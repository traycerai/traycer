import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
  type RenderResult,
} from "@testing-library/react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import type { GuiHarnessId } from "@traycer/protocol/host/index";
import type {
  SessionImportCandidate,
  SessionImportCandidateState,
  SessionImportGroup,
} from "@traycer/protocol/host/session-import/candidate";
import type { SessionImportScanTotals } from "@traycer/protocol/host/session-import/scan";
import type { StreamCloseReason } from "@traycer-clients/shared/host-transport/i-stream-session";
import type {
  SessionImportScanCallbacks,
  SessionImportScanClientOptions,
} from "@traycer-clients/shared/host-transport/session-import-scan-client";
import type { SessionImportRunRequest } from "@/components/session-import/session-import-run-handle";
import { sessionImportGroupKey } from "@/components/session-import/session-import-model";

/**
 * Captures the callbacks the REAL `useSessionImportScan` hook hands to
 * `SessionImportScanClient`, so a test can play server frames straight into
 * the reducer via `onGroup` / `onProviderFailed` / `onComplete` - the same
 * seam `migration-run-controller.test.tsx` uses for the migration stream.
 * Mocking one level up (the hook itself) would skip the reducer entirely,
 * which is the thing this suite is meant to cover.
 */
interface ScanClientHarness {
  callbacks: SessionImportScanCallbacks | null;
  updatedAfter: number | null | undefined;
  readonly close: Mock<() => void>;
}

const scanClient = vi.hoisted((): ScanClientHarness => ({
  callbacks: null,
  updatedAfter: undefined,
  close: vi.fn(),
}));

const startSessionImportRunMock = vi.hoisted(() =>
  vi.fn<(request: SessionImportRunRequest) => void>(),
);
const analyticsTrackMock = vi.hoisted(() => vi.fn());

vi.mock(
  "@traycer-clients/shared/host-transport/session-import-scan-client",
  () => ({
    SessionImportScanClient: class {
      constructor(options: SessionImportScanClientOptions) {
        scanClient.callbacks = options.callbacks;
        scanClient.updatedAfter = options.updatedAfter;
      }

      close(): void {
        scanClient.close();
      }
    },
  }),
);

/**
 * Stands in for the app-wide stream binding. A non-null client is all
 * `useSessionImportScan` needs to proceed past its null-guard; the fake
 * `SessionImportScanClient` above never touches it. Its identity must be
 * STABLE: the real `useWsStreamClient` is a `useSyncExternalStore` read that
 * returns the same client across renders, and the scan effect keys its
 * subscription on that identity - a stub minted per render would re-subscribe
 * forever.
 *
 * Client and host live in one mutable value because the real binding carries
 * them that way, which is what lets a test replace the transport while naming
 * the same machine (a reconnect) or a different one (a host switch).
 */
interface StreamBindingHarness {
  client: object;
  hostId: string | null;
}

const streamBinding = vi.hoisted((): StreamBindingHarness => ({
  client: { stream: "test" },
  hostId: "host-a",
}));
vi.mock("@/lib/host/stream-runtime-context", () => ({
  useWsStreamClient: () => streamBinding.client,
  useStreamHostId: () => streamBinding.hostId,
}));

vi.mock("@/components/session-import/session-import-run-handle", () => ({
  startSessionImportRun: startSessionImportRunMock,
}));

vi.mock("@/lib/analytics", () => ({
  Analytics: { getInstance: () => ({ track: analyticsTrackMock }) },
  AnalyticsEvent: { SessionImportStarted: "session_import_started" },
}));

import { SessionImportWizard } from "@/components/session-import/session-import-wizard";
import { useSessionImportRunStore } from "@/stores/session-import/session-import-run-store";

const ZERO_TOTALS: SessionImportScanTotals = {
  groups: 0,
  sessions: 0,
  importable: 0,
  alreadyInTraycer: 0,
  unreadable: 0,
};

const IMPORTABLE_STATE: SessionImportCandidateState = { kind: "importable" };

function alreadyInTraycerState(): SessionImportCandidateState {
  return { kind: "already_in_traycer", epicId: "epic-1", chatId: "chat-1" };
}

function unreadableState(): SessionImportCandidateState {
  return {
    kind: "unreadable",
    reason: "source_unreadable",
    detail: "Corrupt session file",
  };
}

function candidate(input: {
  readonly harness: GuiHarnessId;
  readonly nativeSessionId: string;
  readonly title: string;
  readonly state: SessionImportCandidateState;
}): SessionImportCandidate {
  return {
    harness: input.harness,
    nativeSessionId: input.nativeSessionId,
    title: input.title,
    firstPrompt: null,
    createdAt: 1_000,
    updatedAt: 1_000,
    messageCount: null,
    hasSubagents: false,
    state: input.state,
  };
}

function importableCandidate(
  harness: GuiHarnessId,
  nativeSessionId: string,
  title: string,
): SessionImportCandidate {
  return candidate({
    harness,
    nativeSessionId,
    title,
    state: IMPORTABLE_STATE,
  });
}

function alreadyInTraycerCandidate(
  harness: GuiHarnessId,
  nativeSessionId: string,
  title: string,
): SessionImportCandidate {
  return candidate({
    harness,
    nativeSessionId,
    title,
    state: alreadyInTraycerState(),
  });
}

function unreadableCandidate(
  harness: GuiHarnessId,
  nativeSessionId: string,
  title: string,
): SessionImportCandidate {
  return candidate({
    harness,
    nativeSessionId,
    title,
    state: unreadableState(),
  });
}

function folderGroup(input: {
  readonly path: string;
  readonly sessions: ReadonlyArray<SessionImportCandidate>;
}): SessionImportGroup {
  return {
    location: { kind: "folder", path: input.path, workspaceId: null },
    gitBacked: false,
    sessions: [...input.sessions],
  };
}

function missingFolderGroup(input: {
  readonly path: string;
  readonly sessions: ReadonlyArray<SessionImportCandidate>;
}): SessionImportGroup {
  return {
    location: { kind: "missing_folder", path: input.path },
    gitBacked: false,
    sessions: [...input.sessions],
  };
}

function renderWizard(onImportStarted: () => void): RenderResult {
  return render(
    <SessionImportWizard
      surface="dialog"
      onImportStarted={onImportStarted}
      secondaryAction={null}
      registerSubmit={null}
    />,
  );
}

function findProviderPill(harness: GuiHarnessId): HTMLElement {
  const pill = screen
    .getAllByTestId("session-import-provider-pill")
    .find((element) => element.getAttribute("data-harness") === harness);
  if (pill === undefined) {
    throw new Error(`Expected a provider pill for harness ${harness}`);
  }
  return pill;
}

/**
 * Replays what the stream runtime does when its client is replaced: publishes
 * a new client (and whichever machine it now dials) and lets the wizard
 * re-render, which is the only thing that re-runs the scan effect.
 */
function replaceStreamClient(
  rerender: RenderResult["rerender"],
  hostId: string,
): void {
  streamBinding.client = { stream: hostId };
  streamBinding.hostId = hostId;
  rerender(
    <SessionImportWizard
      surface="dialog"
      onImportStarted={vi.fn()}
      secondaryAction={null}
      registerSubmit={null}
    />,
  );
}

const FATAL_CLOSE: StreamCloseReason = {
  kind: "fatalError",
  details: {
    code: "INTERNAL",
    reason: "The host stopped answering mid-scan.",
    incompatibleMethods: null,
    upgradeGuidance: null,
  },
};

function requireCallbacks(): SessionImportScanCallbacks {
  const callbacks = scanClient.callbacks;
  if (callbacks === null) {
    throw new Error("Expected the scan client's callbacks to be captured.");
  }
  return callbacks;
}

function requireGroupElement(groupKey: string): HTMLElement {
  const groups = screen.getAllByTestId("session-import-group");
  const match = groups.find(
    (element) => element.getAttribute("data-group-key") === groupKey,
  );
  if (match === undefined) {
    throw new Error(`Expected a group element for key ${groupKey}`);
  }
  return match;
}

beforeEach(() => {
  streamBinding.client = { stream: "host-a" };
  streamBinding.hostId = "host-a";
  scanClient.callbacks = null;
  scanClient.updatedAfter = undefined;
  scanClient.close.mockClear();
  startSessionImportRunMock.mockClear();
  analyticsTrackMock.mockClear();
  useSessionImportRunStore.getState().reset();
});

afterEach(() => {
  cleanup();
  useSessionImportRunStore.getState().reset();
});

describe("<SessionImportWizard />", () => {
  it("fills in progressively as group frames arrive and clears the spinner on complete", () => {
    renderWizard(vi.fn());
    const callbacks = requireCallbacks();

    expect(screen.getByTestId("session-import-scan-spinner")).toBeTruthy();
    expect(screen.queryAllByTestId("session-import-group")).toHaveLength(0);

    act(() => {
      callbacks.onGroup(
        folderGroup({
          path: "/repo/a",
          sessions: [importableCandidate("claude", "s1", "First session")],
        }),
      );
    });

    expect(screen.queryAllByTestId("session-import-group")).toHaveLength(1);
    expect(screen.getByTestId("session-import-scan-spinner")).toBeTruthy();

    act(() => {
      callbacks.onComplete(ZERO_TOTALS);
    });

    expect(screen.queryByTestId("session-import-scan-spinner")).toBeNull();
  });

  it("keeps a group's rows collapsed until its toggle is clicked, twice", () => {
    renderWizard(vi.fn());
    const callbacks = requireCallbacks();

    act(() => {
      callbacks.onGroup(
        folderGroup({
          path: "/repo/a",
          sessions: [
            importableCandidate("claude", "s1", "Session one"),
            importableCandidate("claude", "s2", "Session two"),
            importableCandidate("claude", "s3", "Session three"),
          ],
        }),
      );
    });

    expect(screen.queryAllByTestId("session-import-row")).toHaveLength(0);

    fireEvent.click(screen.getByTestId("session-import-group-toggle"));
    expect(screen.getAllByTestId("session-import-row")).toHaveLength(3);

    fireEvent.click(screen.getByTestId("session-import-group-toggle"));
    expect(screen.queryAllByTestId("session-import-row")).toHaveLength(0);
  });

  it("pre-selects every importable candidate, including a missing-folder group's", () => {
    renderWizard(vi.fn());
    const callbacks = requireCallbacks();

    act(() => {
      callbacks.onGroup(
        folderGroup({
          path: "/repo/a",
          sessions: [
            importableCandidate("claude", "s1", "Session one"),
            importableCandidate("claude", "s2", "Session two"),
          ],
        }),
      );
    });
    act(() => {
      callbacks.onGroup(
        missingFolderGroup({
          path: "/repo/gone",
          sessions: [importableCandidate("codex", "s3", "Orphaned session")],
        }),
      );
    });

    expect(screen.getByTestId("session-import-submit").textContent).toBe(
      "Import 3 sessions",
    );
    expect(screen.getByTestId("session-import-missing-folder")).toBeTruthy();
  });

  it("marks the unreadable row disabled and unticked, the importable one ticked", () => {
    renderWizard(vi.fn());
    const callbacks = requireCallbacks();

    act(() => {
      callbacks.onGroup(
        folderGroup({
          path: "/repo/a",
          sessions: [
            importableCandidate("claude", "s1", "Importable session"),
            unreadableCandidate("claude", "s3", "Broken session"),
          ],
        }),
      );
    });
    fireEvent.click(screen.getByTestId("session-import-group-toggle"));

    const rows = screen.getAllByTestId("session-import-row");
    expect(rows).toHaveLength(2);

    const unavailableRows = rows.filter(
      (row) => row.getAttribute("data-selectable") === "false",
    );
    expect(unavailableRows).toHaveLength(1);
    for (const row of unavailableRows) {
      expect(row.getAttribute("aria-checked")).not.toBe("true");
    }

    const selectableRows = rows.filter(
      (row) => row.getAttribute("data-selectable") === "true",
    );
    expect(selectableRows).toHaveLength(1);
    expect(selectableRows[0].getAttribute("aria-checked")).toBe("true");
  });

  it("keeps an unavailable row's tooltip reachable and refuses to toggle it", () => {
    renderWizard(vi.fn());
    const callbacks = requireCallbacks();

    act(() => {
      callbacks.onGroup(
        folderGroup({
          path: "/repo/a",
          sessions: [
            importableCandidate("claude", "s1", "Importable session"),
            unreadableCandidate("claude", "s2", "Broken session"),
          ],
        }),
      );
    });
    fireEvent.click(screen.getByTestId("session-import-group-toggle"));

    const row = screen.getByRole("checkbox", { name: "Broken session" });
    // A DOM-disabled button emits no pointer events in a real browser, which
    // is exactly what used to silence this tooltip. jsdom dispatches to
    // disabled nodes anyway, so the absent attribute is the honest proxy.
    expect(row.hasAttribute("disabled")).toBe(false);
    expect(row.getAttribute("aria-disabled")).toBe("true");

    fireEvent.focus(row);
    expect(screen.getByRole("tooltip").textContent).toContain(
      "Corrupt session file",
    );

    fireEvent.click(row);
    expect(screen.getByTestId("session-import-submit").textContent).toBe(
      "Import 1 session",
    );
  });

  it("never renders an already-imported session, whichever host sent it", () => {
    // A current host hides these at the scan; this is the client-side backstop
    // for an older host that still streams them.
    renderWizard(vi.fn());
    const callbacks = requireCallbacks();

    act(() => {
      callbacks.onGroup(
        folderGroup({
          path: "/repo/a",
          sessions: [
            importableCandidate("claude", "s1", "New session"),
            alreadyInTraycerCandidate("claude", "s2", "Already there"),
          ],
        }),
      );
    });
    fireEvent.click(screen.getByTestId("session-import-group-toggle"));

    expect(screen.getAllByTestId("session-import-row")).toHaveLength(1);
    expect(screen.queryByText("Already there")).toBeNull();
    expect(screen.queryByText("In Traycer")).toBeNull();
  });

  it("opens the scan bounded to the default two-week window", () => {
    const before = Date.now();
    renderWizard(vi.fn());
    const after = Date.now();

    const twoWeeksMs = 14 * 24 * 60 * 60 * 1000;
    const bound = scanClient.updatedAfter;
    if (typeof bound !== "number") {
      throw new Error("scan opened with no updatedAfter bound");
    }
    expect(bound).toBeGreaterThanOrEqual(before - twoWeeksMs);
    expect(bound).toBeLessThanOrEqual(after - twoWeeksMs);
  });

  it("counts only pickable sessions in the footer's denominator", () => {
    renderWizard(vi.fn());
    const callbacks = requireCallbacks();

    act(() => {
      callbacks.onGroup(
        folderGroup({
          path: "/repo/a",
          sessions: [
            importableCandidate("claude", "s1", "Importable session"),
            alreadyInTraycerCandidate("claude", "s2", "Already there"),
            unreadableCandidate("claude", "s3", "Broken session"),
          ],
        }),
      );
    });

    expect(
      screen.getByTestId("session-import-selection-count").textContent,
    ).toBe("1 of 1 selected");
  });

  it("shows the scan's own failure inline, with the groups it already delivered still on screen", () => {
    renderWizard(vi.fn());
    const callbacks = requireCallbacks();

    act(() => {
      callbacks.onGroup(
        folderGroup({
          path: "/repo/a",
          sessions: [importableCandidate("claude", "s1", "Claude session")],
        }),
      );
    });
    act(() => {
      callbacks.onConnectionStatus("closed", FATAL_CLOSE);
    });

    expect(
      screen.getByTestId("session-import-scan-error").textContent,
    ).toContain("The host stopped answering mid-scan.");
    expect(screen.getAllByTestId("session-import-group")).toHaveLength(1);
    expect(screen.queryByTestId("session-import-empty")).toBeNull();
  });

  it("clears and restores one group's selection via its own checkbox, leaving the other group alone", () => {
    renderWizard(vi.fn());
    const callbacks = requireCallbacks();

    act(() => {
      callbacks.onGroup(
        folderGroup({
          path: "/repo/a",
          sessions: [
            importableCandidate("claude", "s1", "Session one"),
            importableCandidate("claude", "s2", "Session two"),
          ],
        }),
      );
    });
    act(() => {
      callbacks.onGroup(
        folderGroup({
          path: "/repo/b",
          sessions: [importableCandidate("codex", "s3", "Session three")],
        }),
      );
    });

    expect(screen.getByTestId("session-import-submit").textContent).toBe(
      "Import 3 sessions",
    );

    const groupAKey = sessionImportGroupKey({
      kind: "folder",
      path: "/repo/a",
      workspaceId: null,
    });
    const groupASelect = within(requireGroupElement(groupAKey)).getByTestId(
      "session-import-group-select",
    );

    fireEvent.click(groupASelect);
    expect(screen.getByTestId("session-import-submit").textContent).toBe(
      "Import 1 session",
    );

    fireEvent.click(groupASelect);
    expect(screen.getByTestId("session-import-submit").textContent).toBe(
      "Import 3 sessions",
    );
  });

  it("narrows visible groups on search without changing the submit count", () => {
    renderWizard(vi.fn());
    const callbacks = requireCallbacks();

    act(() => {
      callbacks.onGroup(
        folderGroup({
          path: "/repo/alpha",
          sessions: [importableCandidate("claude", "s1", "Alpha work")],
        }),
      );
    });
    act(() => {
      callbacks.onGroup(
        folderGroup({
          path: "/repo/beta",
          sessions: [importableCandidate("claude", "s2", "Beta work")],
        }),
      );
    });

    expect(screen.getAllByTestId("session-import-group")).toHaveLength(2);
    expect(screen.getByTestId("session-import-submit").textContent).toBe(
      "Import 2 sessions",
    );

    fireEvent.change(screen.getByTestId("session-import-search"), {
      target: { value: "alpha" },
    });

    expect(screen.getAllByTestId("session-import-group")).toHaveLength(1);
    expect(screen.getByTestId("session-import-submit").textContent).toBe(
      "Import 2 sessions",
    );

    fireEvent.change(screen.getByTestId("session-import-search"), {
      target: { value: "" },
    });

    expect(screen.getAllByTestId("session-import-group")).toHaveLength(2);
  });

  it("shows a pill per harness with live counts, and switching one off hides its group and drops it from the submission", () => {
    renderWizard(vi.fn());
    const callbacks = requireCallbacks();

    act(() => {
      callbacks.onGroup(
        folderGroup({
          path: "/repo/a",
          sessions: [importableCandidate("claude", "s1", "Claude session")],
        }),
      );
    });

    expect(screen.getAllByTestId("session-import-provider-pill")).toHaveLength(
      1,
    );

    act(() => {
      callbacks.onGroup(
        folderGroup({
          path: "/repo/b",
          sessions: [
            importableCandidate("codex", "s2", "Codex session"),
            importableCandidate("codex", "s3", "Second codex session"),
          ],
        }),
      );
    });

    // The app's provider order puts codex ahead of claude regardless of which
    // one the scan happened to report first.
    const pills = screen.getAllByTestId("session-import-provider-pill");
    expect(pills.map((pill) => pill.getAttribute("data-harness"))).toEqual([
      "codex",
      "claude",
    ]);
    expect(findProviderPill("codex").textContent).toContain("2");
    expect(findProviderPill("claude").textContent).toContain("1");
    expect(screen.getAllByTestId("session-import-group")).toHaveLength(2);

    fireEvent.click(findProviderPill("codex"));

    expect(screen.getAllByTestId("session-import-group")).toHaveLength(1);
    expect(findProviderPill("codex").getAttribute("aria-checked")).toBe(
      "false",
    );
    // The pill still reports what the scan actually found - switching a
    // provider out is scope, not amnesia about its count.
    expect(findProviderPill("codex").textContent).toContain("2");

    fireEvent.click(screen.getByTestId("session-import-submit"));

    expect(startSessionImportRunMock).toHaveBeenCalledTimes(1);
    expect(startSessionImportRunMock.mock.calls[0][0].selections).toEqual([
      { harness: "claude", nativeSessionId: "s1" },
    ]);
  });

  it("shows an inline provider-failure notice without blocking groups delivered after it", () => {
    renderWizard(vi.fn());
    const callbacks = requireCallbacks();

    act(() => {
      callbacks.onProviderFailed({
        harness: "codex",
        reason: "source_unreadable",
        detail: "Could not read ~/.codex/sessions",
      });
    });

    const notice = screen.getByTestId("session-import-provider-failure");
    expect(notice.textContent).toContain("Could not read ~/.codex/sessions");

    act(() => {
      callbacks.onGroup(
        folderGroup({
          path: "/repo/a",
          sessions: [importableCandidate("claude", "s1", "Claude session")],
        }),
      );
    });

    expect(screen.getAllByTestId("session-import-group")).toHaveLength(1);
    expect(screen.getByTestId("session-import-provider-failure")).toBeTruthy();
  });

  it("submits ticked candidates with a titles map keyed by harness:nativeSessionId and notifies the caller", () => {
    const onImportStarted = vi.fn();
    renderWizard(onImportStarted);
    const callbacks = requireCallbacks();

    act(() => {
      callbacks.onGroup(
        folderGroup({
          path: "/repo/a",
          sessions: [
            importableCandidate("claude", "s1", "Alpha session"),
            alreadyInTraycerCandidate("claude", "s2", "Already there"),
          ],
        }),
      );
    });

    fireEvent.click(screen.getByTestId("session-import-submit"));

    expect(startSessionImportRunMock).toHaveBeenCalledTimes(1);
    const request = startSessionImportRunMock.mock.calls[0][0];
    expect(request.selections).toEqual([
      { harness: "claude", nativeSessionId: "s1" },
    ]);
    expect(request.titles.size).toBe(1);
    expect(request.titles.get("claude:s1")).toBe("Alpha session");
    expect(onImportStarted).toHaveBeenCalledTimes(1);
    expect(analyticsTrackMock).toHaveBeenCalledTimes(1);
  });

  it("keeps the groups and the user's ticks when the transport comes back on the same host", () => {
    const { rerender } = renderWizard(vi.fn());
    const callbacks = requireCallbacks();

    act(() => {
      callbacks.onGroup(
        folderGroup({
          path: "/repo/a",
          sessions: [
            importableCandidate("claude", "s1", "Session one"),
            importableCandidate("claude", "s2", "Session two"),
          ],
        }),
      );
    });
    fireEvent.click(screen.getByTestId("session-import-group-toggle"));
    fireEvent.click(screen.getByRole("checkbox", { name: "Session two" }));

    expect(screen.getByTestId("session-import-submit").textContent).toBe(
      "Import 1 session",
    );

    replaceStreamClient(rerender, "host-a");

    expect(screen.getAllByTestId("session-import-group")).toHaveLength(1);
    // The deliberate untick is the point: a reconnect that re-delivered the
    // group and re-applied the pre-select-on-arrival rule would silently put
    // "Session two" back.
    expect(screen.getByTestId("session-import-submit").textContent).toBe(
      "Import 1 session",
    );
  });

  it("drops the previous host's groups and selection when the stream switches machines", () => {
    const { rerender } = renderWizard(vi.fn());
    const callbacks = requireCallbacks();

    act(() => {
      callbacks.onGroup(
        folderGroup({
          path: "/repo/a",
          sessions: [importableCandidate("claude", "s1", "Session one")],
        }),
      );
    });

    expect(screen.getByTestId("session-import-submit").textContent).toBe(
      "Import 1 session",
    );

    replaceStreamClient(rerender, "host-b");

    // Host B has never heard of `claude:s1`, and its own `/repo/a` - if it has
    // one at all - is a different directory. Carrying either across would
    // submit one machine's sessions to another.
    expect(screen.queryAllByTestId("session-import-group")).toHaveLength(0);
    expect(screen.getByTestId("session-import-submit").textContent).toBe(
      "Import 0 sessions",
    );
    expect(screen.getByTestId("session-import-scan-spinner")).toBeTruthy();
  });

  it("keeps a switched-off harness's pill after a rescan returns nothing for it, and restores its rows once switched back on", () => {
    const { rerender } = renderWizard(vi.fn());
    const callbacks = requireCallbacks();

    act(() => {
      callbacks.onGroup(
        folderGroup({
          path: "/repo/a",
          sessions: [importableCandidate("claude", "s1", "Claude session")],
        }),
      );
    });
    act(() => {
      callbacks.onGroup(
        folderGroup({
          path: "/repo/b",
          sessions: [importableCandidate("codex", "s2", "Codex session")],
        }),
      );
    });

    fireEvent.click(findProviderPill("codex"));
    expect(screen.getAllByTestId("session-import-group")).toHaveLength(1);

    // A fresh scan (a host switch) keeps disabledHarnesses and nothing else,
    // so this one lands with codex still switched out and no codex session in
    // sight - yet the pill has to survive with no group left to read a count
    // off, because it is the only way back to turning codex on again.
    replaceStreamClient(rerender, "host-b");
    const rescanned = requireCallbacks();
    act(() => {
      rescanned.onGroup(
        folderGroup({
          path: "/repo/a",
          sessions: [importableCandidate("claude", "s3", "Claude session")],
        }),
      );
    });
    act(() => {
      rescanned.onComplete(ZERO_TOTALS);
    });

    const codexPillAfterRescan = findProviderPill("codex");
    expect(codexPillAfterRescan.getAttribute("aria-checked")).toBe("false");
    // The scan settled with nothing for codex, so the pill says 0 plainly -
    // the old "—" placeholder read as a minus control.
    expect(codexPillAfterRescan.textContent).toContain("0");

    fireEvent.click(codexPillAfterRescan);
    act(() => {
      rescanned.onGroup(
        folderGroup({
          path: "/repo/c",
          sessions: [
            importableCandidate("codex", "s4", "Codex session restored"),
          ],
        }),
      );
    });

    expect(screen.getAllByTestId("session-import-group")).toHaveLength(2);
    const restoredGroupKey = sessionImportGroupKey({
      kind: "folder",
      path: "/repo/c",
      workspaceId: null,
    });
    fireEvent.click(
      within(requireGroupElement(restoredGroupKey)).getByTestId(
        "session-import-group-toggle",
      ),
    );
    expect(
      screen
        .getByRole("checkbox", { name: "Codex session restored" })
        .getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("reports the groups the submission covers, not every group the scan found", () => {
    renderWizard(vi.fn());
    const callbacks = requireCallbacks();

    act(() => {
      callbacks.onGroup(
        folderGroup({
          path: "/repo/kept",
          sessions: [importableCandidate("claude", "s1", "Kept session")],
        }),
      );
    });
    act(() => {
      callbacks.onGroup(
        folderGroup({
          path: "/repo/cleared",
          sessions: [importableCandidate("claude", "s2", "Cleared session")],
        }),
      );
    });
    act(() => {
      callbacks.onGroup(
        folderGroup({
          path: "/repo/unusable",
          sessions: [
            alreadyInTraycerCandidate("claude", "s3", "Already there"),
            unreadableCandidate("claude", "s4", "Broken session"),
          ],
        }),
      );
    });

    const clearedKey = sessionImportGroupKey({
      kind: "folder",
      path: "/repo/cleared",
      workspaceId: null,
    });
    fireEvent.click(
      within(requireGroupElement(clearedKey)).getByTestId(
        "session-import-group-select",
      ),
    );

    fireEvent.click(screen.getByTestId("session-import-submit"));

    // Two groups the user is not importing from: one they cleared, one that
    // never offered anything pickable.
    expect(analyticsTrackMock).toHaveBeenCalledWith("session_import_started", {
      surface: "dialog",
      session_count: 1,
      group_count: 1,
    });
  });

  it("renders the empty state when the scan completes with nothing found", () => {
    renderWizard(vi.fn());
    const callbacks = requireCallbacks();

    act(() => {
      callbacks.onComplete(ZERO_TOTALS);
    });

    expect(screen.getByTestId("session-import-empty")).toBeTruthy();
    expect(screen.queryAllByTestId("session-import-group")).toHaveLength(0);
  });

  it("on the onboarding surface, renders no submit button and lets the caller's registered submit start the run", () => {
    const registerSubmit = vi.fn<(submit: () => void) => void>();
    render(
      <SessionImportWizard
        surface="onboarding"
        onImportStarted={vi.fn()}
        secondaryAction={null}
        registerSubmit={registerSubmit}
      />,
    );
    const callbacks = requireCallbacks();

    act(() => {
      callbacks.onGroup(
        folderGroup({
          path: "/repo/a",
          sessions: [importableCandidate("claude", "s1", "Onboarding session")],
        }),
      );
    });

    // The tour has one forward control; a second Import button here would be
    // a second way to do the same thing.
    expect(screen.queryByTestId("session-import-submit")).toBeNull();
    expect(
      screen.getByTestId("session-import-selection-count").textContent,
    ).toBe("1 of 1 selected");

    // Re-registered on every render, so Continue always presses whichever
    // submit closed over the latest selection.
    expect(registerSubmit).toHaveBeenCalled();
    const latestSubmit = registerSubmit.mock.calls.at(-1)?.[0];
    if (latestSubmit === undefined) {
      throw new Error("Expected registerSubmit to have been called");
    }
    act(() => {
      latestSubmit();
    });

    expect(startSessionImportRunMock).toHaveBeenCalledTimes(1);
    expect(startSessionImportRunMock.mock.calls[0][0].selections).toEqual([
      { harness: "claude", nativeSessionId: "s1" },
    ]);
  });
});
