import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { getOpenEpicRegistry } from "@/lib/registries/epic-session-registry";
import {
  useRegistryUnsyncedEdits,
  type UnsyncedEditsEntry,
} from "@/stores/epics/open-epic/session-registry";
import { flushActiveDesktopPerWindowProjection } from "@/lib/windows/per-window-projection-debounce";
import { drainDesktopTabsPersistence } from "@/stores/tabs/desktop-tabs-persistence";
import { appLogger } from "@/lib/logger";
import { flushLiveReadingPositions } from "@/lib/reading-position";
import { fileEditRuntimeRegistry } from "@/lib/workspace/file-edit-runtime-registry";

/**
 * Terminal decision returned by the renderer to the Electron main process
 * after the quit-intercept modal resolves.
 *
 * `userCancelled` abandons the quit and leaves the app running. It exists
 * because the other two both quit, and the modal's termination guarantee used
 * to be "waiting always ends" - which stopped being true once a dirty session
 * could be retained across a host re-point with no transport to sync through
 * (F10). Without a third verb the only way out of that state is "Quit and
 * discard", i.e. destroying the work the retention exists to preserve.
 */
type QuitDecision = "proceed" | "userConfirmedDiscard" | "userCancelled";

interface AppLifecycleUnsyncedEditsEntry {
  readonly epicId: string;
  readonly title: string;
  readonly queueSize: number;
  readonly isDirty?: boolean;
  /**
   * Optional for the same reason `isDirty` is: this is a STRUCTURAL mirror of
   * what an Electron shell sends, feature-detected at runtime, so it describes
   * what may arrive rather than what this build emits. The live registry rows
   * merged against it always carry the field.
   */
  readonly unsyncable?: boolean;
}

interface FreshUnsyncedSnapshotRequest {
  readonly requestId: string;
}

interface FreshUnsyncedSnapshotResponse {
  readonly requestId: string;
  readonly snapshot: ReadonlyArray<UnsyncedEditsEntry>;
}

interface QuitRequest {
  readonly requestId: string | null;
  readonly snapshot: ReadonlyArray<AppLifecycleUnsyncedEditsEntry>;
}

interface QuitDecisionResponse {
  readonly requestId: string;
  readonly decision: QuitDecision;
}

type QuitDecisionPayload = QuitDecision | QuitDecisionResponse;

/**
 * Structural shape of the desktop-only `appLifecycle` namespace installed on
 * `window.runnerHost` by the Electron preload. Typed locally so gui-app does
 * not depend on the desktop package and can feature-detect at runtime -
 * mobile / gui-app-dev shells leave this undefined.
 */
interface AppLifecycleWindowBridge {
  setUnsyncedEditsSnapshot(
    snapshot: ReadonlyArray<UnsyncedEditsEntry>,
  ): Promise<void>;
  onQuitRequested(handler: (request: unknown) => void): { dispose: () => void };
  acknowledgeQuitRequest?: (requestId: string) => Promise<void>;
  respondToQuitRequest(decision: QuitDecisionPayload): Promise<void>;
  onGetFreshUnsyncedSnapshot?: (
    handler: (request: FreshUnsyncedSnapshotRequest) => void,
  ) => { dispose: () => void };
  respondFreshUnsyncedSnapshot?: (
    reply: FreshUnsyncedSnapshotResponse,
  ) => Promise<void>;
}

interface RunnerHostWindowShape {
  readonly appLifecycle?: AppLifecycleWindowBridge;
}

interface WindowWithRunnerHost {
  runnerHost?: RunnerHostWindowShape;
}

function readAppLifecycle(): AppLifecycleWindowBridge | null {
  if (typeof window === "undefined") return null;
  const host = (window as WindowWithRunnerHost).runnerHost;
  if (host === undefined) return null;
  const lifecycle = host.appLifecycle;
  if (lifecycle === undefined) return null;
  return lifecycle;
}

const SNAPSHOT_DEBOUNCE_MS = 100;

/**
 * Bridges the renderer's live Open-Epic registry with the Electron main
 * process so Cmd+Q / "Quit Traycer" can block on unsynced Tiptap edits and
 * the user can opt to wait-for-sync or quit-and-discard. Mounts once per
 * session, inside the post-auth providers in `AppShell`.
 *
 * Outside Electron the component is a no-op: `window.runnerHost.appLifecycle`
 * is not installed by mobile or gui-app-dev shells, so the feature-detect
 * below bails before any IPC work.
 */
export function QuitInterceptBridge(): null | React.ReactElement {
  const registry = getOpenEpicRegistry();
  const liveUnsynced = useRegistryUnsyncedEdits(registry);
  const appLifecycle = useMemo(() => readAppLifecycle(), []);
  const quitDecisionResolvedRef = useRef(false);
  const quitRequestIdRef = useRef<string | null>(null);
  const cancelButtonRef = useRef<HTMLButtonElement | null>(null);

  // Freeze the snapshot that was in flight when `quitRequested` fired. The
  // dialog renders a union of this set with the live registry so titles do
  // not vanish mid-dialog if the underlying session disposes.
  const [quitSnapshot, setQuitSnapshot] =
    useState<ReadonlyArray<AppLifecycleUnsyncedEditsEntry> | null>(null);

  const cancelAmbientPushRef = useRef<() => void>(() => undefined);

  useDebouncedPushSnapshot(appLifecycle, liveUnsynced, cancelAmbientPushRef);

  // Respond to main's fresh-snapshot query from the live registry. This is the
  // authoritative source of truth during `before-quit` - cancel any in-flight
  // ambient debounce so main does not observe a stale push right after our fresh
  // reply.
  //
  // Crucially, AWAIT both projection and file-recovery flushes before replying.
  // The projection resolves only after its `perWindowState.update` IPC reaches
  // main; the recovery flush resolves only after the latest editor draft is in
  // IndexedDB. Reply even if either rejects so main does not wait out its fresh
  // snapshot timeout and fall back to stale state.
  //
  // The registry is read INSIDE `reply`, after those flushes have settled,
  // rather than when the request arrives. Reading it up front opened a window
  // with the same shape as the ambient-cache staleness this whole round trip
  // exists to close, only narrower: a re-point in this window that retains a
  // buffer while the flushes are in flight would be absent from a reply main
  // then treats as CURRENT - and the update door, which reads that reply to
  // decide whether destroying work is authorized, would install over it. The
  // captured-early value was never load-bearing; nothing between here and the
  // reply depends on the two agreeing, so the later read is strictly more
  // current and answers the question actually being asked.
  useEffect(() => {
    if (appLifecycle === null) return;
    const onGet = appLifecycle.onGetFreshUnsyncedSnapshot;
    const respond = appLifecycle.respondFreshUnsyncedSnapshot;
    if (onGet === undefined || respond === undefined) return;
    const subscription = onGet((request) => {
      cancelAmbientPushRef.current();
      flushLiveReadingPositions(null);
      const reply = (): Promise<void> =>
        respond({
          requestId: request.requestId,
          snapshot: registry.getUnsyncedEdits(),
        });
      void Promise.allSettled([
        flushActiveDesktopPerWindowProjection(),
        drainDesktopTabsPersistence(),
        fileEditRuntimeRegistry.flushRecovery(),
      ])
        .then(reply)
        .catch((error: unknown) => {
          // `reply()` itself is an `ipcRenderer.invoke` that can reject (main
          // handler removed / sender gone). Never rethrow - main's own
          // fresh-snapshot timeout is the fallback.
          appLogger.error(
            "[quit-intercept] fresh-snapshot reply failed",
            { requestId: request.requestId },
            error,
          );
        });
    });
    return () => {
      subscription.dispose();
    };
  }, [appLifecycle, registry]);

  useEffect(() => {
    if (appLifecycle === null) return;
    const subscription = appLifecycle.onQuitRequested((incoming) => {
      const request = parseQuitRequest(incoming);
      if (request.requestId !== null) {
        void appLifecycle.acknowledgeQuitRequest?.(request.requestId);
      }
      if (request.snapshot.length === 0) {
        // Defensive: main should have filtered empty snapshots, but if one
        // slips through just let the quit proceed.
        void appLifecycle.respondToQuitRequest(
          buildQuitDecisionPayload(request.requestId, "proceed"),
        );
        return;
      }
      quitRequestIdRef.current = request.requestId;
      quitDecisionResolvedRef.current = false;
      setQuitSnapshot(request.snapshot);
    });
    return () => {
      subscription.dispose();
    };
  }, [appLifecycle]);

  // While waiting, auto-resolve `proceed` the moment every affected session
  // has drained. We subscribe directly to the registry so the state flip
  // happens from an external-event callback rather than inside a
  // snapshot-derived effect body.
  //
  // The gate stays "no rows at all" and deliberately does NOT skip rows that
  // cannot sync. Skipping them would auto-quit while a retained buffer still
  // held unsynced work, destroying it with no decision from anyone - the
  // original F10 data loss reached through a third door. An un-syncable row
  // therefore holds this gate open for ever by construction, which is exactly
  // why the dialog below has to offer a real way out instead of a wait.
  useEffect(() => {
    if (quitSnapshot === null || appLifecycle === null) return;
    const check = () => {
      if (quitDecisionResolvedRef.current) return;
      if (registry.getUnsyncedEdits().length > 0) return;
      quitDecisionResolvedRef.current = true;
      void appLifecycle.respondToQuitRequest(
        buildQuitDecisionPayload(quitRequestIdRef.current, "proceed"),
      );
      quitRequestIdRef.current = null;
      setQuitSnapshot(null);
    };
    const unsubscribe = registry.subscribe(check);
    check();
    return () => {
      unsubscribe();
    };
  }, [appLifecycle, quitSnapshot, registry]);

  const handleDiscard = useCallback(() => {
    if (appLifecycle === null || quitDecisionResolvedRef.current) return;
    quitDecisionResolvedRef.current = true;
    // Drain in-memory edits on every dirty session before responding so main
    // does not race the teardown and so the next mount sees a clean slate.
    for (const entry of registry.getUnsyncedEdits()) {
      try {
        // Per epic, not per handle. A row can cover a live session AND
        // buffers retained across a host re-point; `get(epicId)` returns only
        // the live one, so draining through it would leave the retained edits
        // behind after a Discard the user believes covered the whole row.
        registry.drainUnsyncedEdits(entry.epicId);
      } catch {
        // Ignore per-session failures - the quit must continue either way.
      }
    }
    void appLifecycle.respondToQuitRequest(
      buildQuitDecisionPayload(
        quitRequestIdRef.current,
        "userConfirmedDiscard",
      ),
    );
    quitRequestIdRef.current = null;
    setQuitSnapshot(null);
  }, [appLifecycle, registry]);

  /**
   * Abandon the quit: the app keeps running and every unsynced edit, retained
   * buffers included, is left exactly as it was.
   *
   * Main resolves its `requestQuitDecision` promise with this and calls
   * `resetQuitting()`; it is deliberately not expressed as a rejection, because
   * rejection already means "the window died" there and the two must stay
   * distinguishable. Clearing `quitSnapshot` here is what actually releases the
   * user - main staying alive is not enough on its own, since this modal is
   * what is covering the app.
   */
  const handleCancel = useCallback(() => {
    if (appLifecycle === null || quitDecisionResolvedRef.current) return;
    quitDecisionResolvedRef.current = true;
    void appLifecycle.respondToQuitRequest(
      buildQuitDecisionPayload(quitRequestIdRef.current, "userCancelled"),
    );
    quitRequestIdRef.current = null;
    // Both refs are re-armed by `onQuitRequested`, so a later Cmd+Q still gets
    // a fresh decision rather than being swallowed by this one.
    setQuitSnapshot(null);
  }, [appLifecycle]);

  if (appLifecycle === null || quitSnapshot === null) {
    return null;
  }

  const displayedEntries = mergeEntries(quitSnapshot, liveUnsynced);
  const epicCount = displayedEntries.length;

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        // Escape, the close button and an overlay dismissal all land here.
        // They now abandon the quit instead of being swallowed: refusing every
        // close was correct only while both available decisions quit the app,
        // and `userCancelled` is what retires that premise.
        if (!next) {
          handleCancel();
        }
      }}
    >
      <DialogContent
        data-testid="quit-intercept-dialog"
        onOpenAutoFocus={(event) => {
          // Radix's `FocusScope` focuses the first tabbable descendant, and in
          // this footer that is "Quit and discard". Measured in the browser
          // regression before this existed:
          //
          //   FOCUS_ON_OPEN = quit-intercept-discard
          //   TAB_ORDER     = discard > cancel > wait > close-x
          //
          // This dialog opens in response to a KEYBOARD gesture (Cmd+Q), so
          // the hand that summoned it is already on the keys: one Enter or
          // Space destroyed every unsynced edit, retained buffers included. A
          // destructive confirmation must not default to its destructive
          // control, and adding a safe exit does not help a keyboard user if
          // the focused control is still the unsafe one.
          //
          // DO NOT DELETE THIS AS REDUNDANT once the footer's order is read.
          // The footer has since been reordered - but only its two
          // non-destructive controls, to put the acting safe action rightmost.
          // "Quit and discard" is deliberately still FIRST in DOM order, so the
          // first tabbable descendant is still the destructive one and this
          // handler is the only thing standing between Cmd+Q and data loss. The
          // reorder made it more load-bearing, not less.
          const cancel = cancelButtonRef.current;
          // Fail safe: with nothing to move focus to, let Radix's own default
          // run rather than preventing it and leaving focus outside the trap.
          if (cancel === null) return;
          event.preventDefault();
          cancel.focus();
        }}
      >
        <DialogHeader>
          {/*
            Not "Saving - please wait", which this said until the retained
            buffer arrived and made it false twice over: nothing may be saving
            (a buffer retained across a host re-point has no transport at all,
            so it can never sync), and the user is no longer required to wait
            (`userCancelled` is a real exit). Wording follows the rest of the
            unsynced-edits family - `unsynced-close-dialog` and
            `unsynced-epic-move-dialog` both open "You have unsynced changes".
          */}
          <DialogTitle>You have unsynced changes.</DialogTitle>
          <DialogDescription>
            {`${epicCount} Epic(s) have not finished syncing. Quitting continues on its own if they do, but some never will. Cancel to stay in the app, or quit and discard them.`}
          </DialogDescription>
        </DialogHeader>
        {displayedEntries.length > 0 ? (
          <ul
            data-testid="quit-intercept-epic-list"
            className="max-h-40 list-disc overflow-y-auto pl-5 text-ui-sm text-muted-foreground"
          >
            {displayedEntries.map((entry) => (
              <li key={entry.epicId}>{entry.title}</li>
            ))}
          </ul>
        ) : null}
        <DialogFooter>
          <Button
            variant="destructive"
            onClick={handleDiscard}
            data-testid="quit-intercept-discard"
          >
            Quit and discard
          </Button>
          {/*
            Inert by design - it carries no `onClick` at all. The dialog closes
            from the auto-proceed gate above once every affected session drains,
            so there is nothing for a click to do. It stays a distinct
            affordance from Cancel because the two mean opposite things about
            the quit: Wait keeps it pending, Cancel abandons it.

            `ghost`, and ranked below Cancel, because "keeps it pending" is not
            an outcome on the path that matters: a RETAINED buffer never drains,
            so the gate above holds open for ever by construction and waiting
            resolves nothing. This control used to carry `variant="default"` -
            the strongest weight in the footer on the one action that cannot
            complete.
          */}
          <Button variant="ghost" data-testid="quit-intercept-wait">
            Wait
          </Button>
          {/*
            Unconditional, and not a function of whether anything can still
            sync: a quit confirmation should always let the user not quit. Its
            absence is what made every other exit from this dialog destructive.

            Primary weight and last in DOM order - so it paints rightmost on
            `sm:` - because it is the only non-destructive action that acts.
            That is where this dialog family already puts the safe action:
            `unsynced-close-dialog` and `unsynced-epic-move-dialog` both order
            [destructive, safe] for exactly this reason, and
            `ui/confirm-destructive-dialog.tsx:69-98` reserves the same slot for
            the action its dialog is asking about.
          */}
          <Button
            ref={cancelButtonRef}
            variant="default"
            onClick={handleCancel}
            data-testid="quit-intercept-cancel"
          >
            Cancel
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function toRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return { ...value };
}

function parseQuitRequest(value: unknown): QuitRequest {
  if (Array.isArray(value)) {
    return { requestId: null, snapshot: parseQuitSnapshot(value) };
  }
  const obj = toRecord(value);
  if (obj === null) {
    return { requestId: null, snapshot: [] };
  }
  if (!Array.isArray(obj.snapshot)) {
    return { requestId: null, snapshot: [] };
  }
  return {
    requestId:
      typeof obj.requestId === "string" && obj.requestId.length > 0
        ? obj.requestId
        : null,
    snapshot: parseQuitSnapshot(obj.snapshot),
  };
}

function parseQuitSnapshot(
  value: unknown,
): ReadonlyArray<AppLifecycleUnsyncedEditsEntry> {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((entry) => {
    const obj = toRecord(entry);
    if (obj === null) {
      return [];
    }
    if (
      typeof obj.epicId !== "string" ||
      typeof obj.title !== "string" ||
      typeof obj.queueSize !== "number"
    ) {
      return [];
    }
    return [
      {
        epicId: obj.epicId,
        title: obj.title,
        queueSize: obj.queueSize,
        isDirty: typeof obj.isDirty === "boolean" ? obj.isDirty : undefined,
        // An absent field is an unknown durability, not a known-safe one -
        // main (ipc-parsers.ts parseUnsyncedSnapshot) refuses to answer for
        // it either, dropping the whole row rather than guessing. `true`
        // ("cannot claim it is safe to destroy") is the only reading that
        // can't be wrong in the direction that loses work.
        unsyncable: typeof obj.unsyncable === "boolean" ? obj.unsyncable : true,
      },
    ];
  });
}

/**
 * Test-only escape hatch onto `parseQuitSnapshot`. The dialog never renders
 * `unsyncable` on its own - it only reaches `mergeEntries` and, from there,
 * whatever later consumes `quitSnapshot` - so a DOM-level assertion in this
 * component's tests cannot see the exact defect this parser fixes (the field
 * being declared but always dropped).
 */
// eslint-disable-next-line react-refresh/only-export-components -- test-only parser export; see the doc comment above for why a DOM assertion can't reach this field.
export function __parseQuitSnapshotForTests(
  value: unknown,
): ReadonlyArray<AppLifecycleUnsyncedEditsEntry> {
  return parseQuitSnapshot(value);
}

function buildQuitDecisionPayload(
  requestId: string | null,
  decision: QuitDecision,
): QuitDecisionPayload {
  return requestId === null ? decision : { requestId, decision };
}

function mergeEntries(
  frozen: ReadonlyArray<AppLifecycleUnsyncedEditsEntry>,
  live: ReadonlyArray<UnsyncedEditsEntry>,
): ReadonlyArray<AppLifecycleUnsyncedEditsEntry> {
  const byId = new Map<string, AppLifecycleUnsyncedEditsEntry>();
  for (const entry of frozen) byId.set(entry.epicId, entry);
  // Prefer live values when both sides carry the same Epic - titles may have
  // been edited since the quit intercept fired, and queue sizes shift as
  // flushes land.
  for (const entry of live) byId.set(entry.epicId, entry);
  return Array.from(byId.values());
}

/**
 * Pushes the latest unsynced snapshot to main, debounced to avoid saturating
 * the IPC channel during rapid Y.Doc bursts. Fires on mount (100ms after the
 * provider wires up) and on every registry change. Exposes a cancellation
 * hook via `cancelRef` so the fresh-query responder can drop any in-flight
 * ambient push before replying - otherwise a debounced push firing right
 * after the fresh reply would overwrite the authoritative snapshot in main.
 */
function useDebouncedPushSnapshot(
  appLifecycle: AppLifecycleWindowBridge | null,
  snapshot: ReadonlyArray<UnsyncedEditsEntry>,
  cancelRef: React.RefObject<() => void>,
): void {
  const pendingRef = useRef<ReadonlyArray<UnsyncedEditsEntry>>(snapshot);

  useEffect(() => {
    pendingRef.current = snapshot;
  }, [snapshot]);

  useEffect(() => {
    if (appLifecycle === null) {
      cancelRef.current = () => undefined;
      return;
    }
    const timer = setTimeout(() => {
      void appLifecycle.setUnsyncedEditsSnapshot(pendingRef.current);
    }, SNAPSHOT_DEBOUNCE_MS);
    cancelRef.current = () => {
      clearTimeout(timer);
    };
    return () => {
      clearTimeout(timer);
      cancelRef.current = () => undefined;
    };
  }, [appLifecycle, snapshot, cancelRef]);
}
