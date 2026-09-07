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

/** Without a third verb the only way out of that state is "Quit and discard", i.e. destroying the work the
 * retention exists to preserve. */
type QuitDecision = "proceed" | "userConfirmedDiscard" | "userCancelled";

interface AppLifecycleUnsyncedEditsEntry {
  readonly epicId: string;
  readonly title: string;
  readonly queueSize: number;
  readonly isDirty?: boolean;
  /** Optional for the same reason `isDirty` is: this is a structural mirror of what an Electron shell sends,
   * feature-detected at runtime, so it describes what may arrive rather than what this build emits. */
  readonly unsyncable?: boolean;
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

/** Typed locally so gui-app does not depend on the desktop package and can feature-detect at runtime - mobile /
 * gui-app-dev shells leave this undefined. */
interface AppLifecycleWindowBridge {
  setUnsyncedEditsSnapshot(
    snapshot: ReadonlyArray<UnsyncedEditsEntry>,
  ): Promise<void>;
  onQuitRequested(handler: (request: unknown) => void): { dispose: () => void };
  acknowledgeQuitRequest?: (requestId: string) => Promise<void>;
  respondToQuitRequest(decision: QuitDecisionPayload): Promise<void>;
  onGetFreshUnsyncedSnapshot?: (
    handler: (request: { readonly requestId: string }) => void,
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

/** Bridges the renderer's live Open-Epic registry with the Electron main process so Cmd+Q / "Quit Traycer" can
 * block on unsynced Tiptap edits and the user can opt to wait-for-sync or quit-and-discard. */
export function QuitInterceptBridge(): null | React.ReactElement {
  const registry = getOpenEpicRegistry();
  const liveUnsynced = useRegistryUnsyncedEdits(registry);
  const appLifecycle = useMemo(() => readAppLifecycle(), []);
  const quitDecisionResolvedRef = useRef(false);
  const quitRequestIdRef = useRef<string | null>(null);
  const cancelButtonRef = useRef<HTMLButtonElement | null>(null);

  // The dialog renders a union of this set with the live registry so titles do not vanish mid-dialog if the
  // underlying session disposes.
  const [quitSnapshot, setQuitSnapshot] =
    useState<ReadonlyArray<AppLifecycleUnsyncedEditsEntry> | null>(null);

  const cancelAmbientPushRef = useRef<() => void>(() => undefined);

  useDebouncedPushSnapshot(appLifecycle, liveUnsynced, cancelAmbientPushRef);

  // The captured-early value was never load-bearing; nothing between here and the reply depends on the two
  // agreeing, so the later read is strictly more current and answers the question actually being asked.
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
          // Never rethrow - main's own fresh-snapshot timeout is the fallback.
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

  // The gate stays "no rows at all" and deliberately does not skip rows that cannot sync.
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
        // A row can cover a live session and buffers retained across a host re-point.
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

  /** Main resolves its `requestQuitDecision` promise with this and calls `resetQuitting`. */
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
        // They now abandon the quit instead of being swallowed: refusing every close was correct only while both
        // available decisions quit the app, and `userCancelled` is what retires that premise.
        if (!next) {
          handleCancel();
        }
      }}
    >
      <DialogContent
        data-testid="quit-intercept-dialog"
        onOpenAutoFocus={(event) => {
          // A destructive confirmation must not default to its destructive control, and adding a safe exit does not help
          // a keyboard user if the focused control is still the unsafe one.
          const cancel = cancelButtonRef.current;
          // Fail safe: with nothing to move focus to, let Radix's own default
          // run rather than preventing it and leaving focus outside the trap.
          if (cancel === null) return;
          event.preventDefault();
          cancel.focus();
        }}
      >
        <DialogHeader>
          {/* Not "Saving - please wait", which this said until the retained buffer arrived and made it false twice over. */}
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
          {/* `ghost`, and ranked below Cancel, because "keeps it pending" is not an outcome on the path that matters. */}
          <Button variant="ghost" data-testid="quit-intercept-wait">
            Wait
          </Button>
          {/* Unconditional, and not a function of whether anything can still sync: a quit confirmation should always let
             the user not quit. */}
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
        // `true` ("cannot claim it is safe to destroy") is the only reading that can't be wrong in the direction that
        // loses work.
        unsyncable: typeof obj.unsyncable === "boolean" ? obj.unsyncable : true,
      },
    ];
  });
}

/** The dialog never renders `unsyncable` on its own - it only reaches `mergeEntries` and, from there, whatever
 * later consumes `quitSnapshot`. */
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
  // Prefer live values when both sides carry the same Epic - titles may have been edited since the quit
  // intercept fired, and queue sizes shift as flushes land.
  for (const entry of live) byId.set(entry.epicId, entry);
  return Array.from(byId.values());
}

/** Exposes a cancellation hook via `cancelRef` so the fresh-query responder can drop any in-flight ambient push
 * before replying. */
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
