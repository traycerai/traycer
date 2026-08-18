import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { confirmAppUpdateInstall } from "@/lib/app-update/request-app-update-install";
import type {
  DesktopAppUpdateCheckIntent,
  DesktopAppUpdateSnapshot,
  DesktopAppUpdatesBridge,
} from "@/lib/windows/types";
import type { UnsyncedEditsEntry } from "@/stores/epics/open-epic/session-registry";
import {
  useDesktopDialogStore,
  type UpdateUnsyncedConfirmation,
} from "@/stores/dialogs/desktop-dialog-store";

/**
 * `confirmAppUpdateInstall` - the confirmation's Confirm.
 *
 * The claim under test: Confirm installs off a FRESH app-wide check, not off
 * the rows captured when the dialog opened. Between open and Confirm another
 * window can retain a new Epic; the update quit bypasses the unsynced-edits
 * interception, so a Confirm that installed off the stale list destroyed a
 * buffer the user was never shown. The cross-window answer is stubbed at the
 * same seam the module reads it from (`window.runnerHost.appLifecycle`), so
 * these arms drive the real desktop path, not the single-window fallback.
 */

const SNAPSHOT: DesktopAppUpdateSnapshot = {
  sequence: 0,
  status: "idle",
  currentVersion: "1.0.0",
  allowPrerelease: false,
  latestVersion: null,
  downloadProgress: null,
  installBlockedReason: null,
  installGuidance: null,
  installInFlight: false,
  errorMessage: null,
  lastCheckedAt: null,
  lastCheckIntent: null,
};

class FakeBridge implements DesktopAppUpdatesBridge {
  readonly installUpdate = vi.fn(() => Promise.resolve(SNAPSHOT));
  getSnapshot(): Promise<DesktopAppUpdateSnapshot> {
    return Promise.resolve(SNAPSHOT);
  }
  checkForUpdates(
    _intent: DesktopAppUpdateCheckIntent,
  ): Promise<DesktopAppUpdateSnapshot> {
    return Promise.resolve(SNAPSHOT);
  }
  setAllowPrerelease(_allow: boolean): Promise<DesktopAppUpdateSnapshot> {
    return Promise.resolve(SNAPSHOT);
  }
  downloadUpdate(): Promise<DesktopAppUpdateSnapshot> {
    return Promise.resolve(SNAPSHOT);
  }
  onChange(): { dispose(): void } {
    return { dispose: () => undefined };
  }
}

interface CrossWindowReport {
  readonly epics: ReadonlyArray<UnsyncedEditsEntry>;
  readonly otherWindowsUnknown: boolean;
}

interface WindowWithLifecycle {
  runnerHost?: {
    appLifecycle?: {
      unsyncableWorkAcrossWindows(): Promise<CrossWindowReport>;
    };
  };
}

function entry(epicId: string): UnsyncedEditsEntry {
  return {
    epicId,
    title: `Epic ${epicId}`,
    queueSize: 1,
    isDirty: true,
    unsyncable: true,
  };
}

/** Installs the cross-window answer main would give on the NEXT check. */
function mainAnswers(report: CrossWindowReport): () => number {
  const read = vi.fn(() => Promise.resolve(report));
  (window as WindowWithLifecycle).runnerHost = {
    appLifecycle: { unsyncableWorkAcrossWindows: read },
  };
  return () => read.mock.calls.length;
}

const shownA: UpdateUnsyncedConfirmation = {
  epics: [entry("a")],
  otherWindowsUnknown: false,
};

function openDialogWith(shown: UpdateUnsyncedConfirmation): void {
  useDesktopDialogStore.getState().openUpdateUnsyncedConfirm(shown);
  expect(useDesktopDialogStore.getState().activeDialog).toBe(
    "update-unsynced-confirm",
  );
}

beforeEach(() => {
  useDesktopDialogStore.getState().close();
});

afterEach(() => {
  delete (window as WindowWithLifecycle).runnerHost;
});

describe("confirmAppUpdateInstall", () => {
  it("re-checks every window on Confirm and installs when the fresh set is exactly what was shown", async () => {
    const bridge = new FakeBridge();
    const checks = mainAnswers({
      epics: [entry("a")],
      otherWindowsUnknown: false,
    });
    openDialogWith(shownA);

    const outcome = await confirmAppUpdateInstall(bridge, shownA);

    expect(outcome).toBe("installed");
    // The proof that Confirm asked again rather than trusting the capture.
    expect(checks()).toBe(1);
    expect(bridge.installUpdate).toHaveBeenCalledTimes(1);
    expect(useDesktopDialogStore.getState().activeDialog).toBeNull();
  });

  it("does NOT install when another window retained a NEW epic since the dialog opened: it re-asks with the fresh rows", async () => {
    const bridge = new FakeBridge();
    const fresh: CrossWindowReport = {
      epics: [entry("a"), entry("b")],
      otherWindowsUnknown: false,
    };
    mainAnswers(fresh);
    openDialogWith(shownA);

    const outcome = await confirmAppUpdateInstall(bridge, shownA);

    expect(outcome).toBe("reconfirm");
    // OLD code: `installUpdate` fired here off the captured list and "b" was
    // destroyed without ever being named in the confirmation.
    expect(bridge.installUpdate).not.toHaveBeenCalled();
    const state = useDesktopDialogStore.getState();
    expect(state.activeDialog).toBe("update-unsynced-confirm");
    expect(state.updateUnsyncedEpics.map((epic) => epic.epicId)).toEqual([
      "a",
      "b",
    ]);
    expect(state.updateUnsyncedOtherWindowsUnknown).toBe(false);
  });

  it("does NOT install when the other windows became UNKNOWN since the dialog opened", async () => {
    // The dialog said "other windows checked, only 'a' is at risk"; by Confirm
    // main can no longer vouch for them. Whatever the user consented to, it
    // was not "and anything in the windows we could not check".
    const bridge = new FakeBridge();
    mainAnswers({ epics: [entry("a")], otherWindowsUnknown: true });
    openDialogWith(shownA);

    const outcome = await confirmAppUpdateInstall(bridge, shownA);

    expect(outcome).toBe("reconfirm");
    expect(bridge.installUpdate).not.toHaveBeenCalled();
    const state = useDesktopDialogStore.getState();
    expect(state.activeDialog).toBe("update-unsynced-confirm");
    expect(state.updateUnsyncedOtherWindowsUnknown).toBe(true);
  });

  it("installs when the set SHRANK: a retention reclaimed while the dialog was up is less to lose, not more", async () => {
    const bridge = new FakeBridge();
    mainAnswers({ epics: [], otherWindowsUnknown: false });
    const shown: UpdateUnsyncedConfirmation = {
      epics: [entry("a"), entry("b")],
      otherWindowsUnknown: false,
    };
    openDialogWith(shown);

    const outcome = await confirmAppUpdateInstall(bridge, shown);

    expect(outcome).toBe("installed");
    expect(bridge.installUpdate).toHaveBeenCalledTimes(1);
    expect(useDesktopDialogStore.getState().activeDialog).toBeNull();
  });

  it("installs when the user already consented to unknown other windows and the fresh check is no worse", async () => {
    // Shown: "could not check other windows" + 'a'. Fresh: still unknown,
    // still only 'a' locally. Nothing new is on the table.
    const bridge = new FakeBridge();
    mainAnswers({ epics: [entry("a")], otherWindowsUnknown: true });
    const shown: UpdateUnsyncedConfirmation = {
      epics: [entry("a")],
      otherWindowsUnknown: true,
    };
    openDialogWith(shown);

    const outcome = await confirmAppUpdateInstall(bridge, shown);

    expect(outcome).toBe("installed");
    expect(bridge.installUpdate).toHaveBeenCalledTimes(1);
  });

  it("compares by epicId, not row identity: a row whose title moved is the same consented-to buffer", async () => {
    const bridge = new FakeBridge();
    mainAnswers({
      epics: [{ ...entry("a"), title: "Renamed", queueSize: 7 }],
      otherWindowsUnknown: false,
    });
    openDialogWith(shownA);

    const outcome = await confirmAppUpdateInstall(bridge, shownA);

    expect(outcome).toBe("installed");
    expect(bridge.installUpdate).toHaveBeenCalledTimes(1);
  });

  it("a fresh check that REJECTS fails closed like the opening check: other windows unknown, so re-ask rather than install", async () => {
    const bridge = new FakeBridge();
    (window as WindowWithLifecycle).runnerHost = {
      appLifecycle: {
        unsyncableWorkAcrossWindows: () =>
          Promise.reject(new Error("ipc down")),
      },
    };
    openDialogWith(shownA);

    const outcome = await confirmAppUpdateInstall(bridge, shownA);

    expect(outcome).toBe("reconfirm");
    expect(bridge.installUpdate).not.toHaveBeenCalled();
    expect(
      useDesktopDialogStore.getState().updateUnsyncedOtherWindowsUnknown,
    ).toBe(true);
  });
});
