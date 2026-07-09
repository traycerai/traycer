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
import { appLogger } from "@/lib/logger";

/**
 * Terminal decision returned by the renderer to the Electron main process
 * after the "Saving - please wait" modal resolves.
 */
type QuitDecision = "proceed" | "userConfirmedDiscard";

interface AppLifecycleUnsyncedEditsEntry {
  readonly epicId: string;
  readonly title: string;
  readonly queueSize: number;
  readonly isDirty?: boolean;
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
  // Crucially, AWAIT the per-window projection flush before replying: the flush
  // resolves only once its `perWindowState.update` IPC has been processed by
  // main, so main's `PerWindowState` (and the `desktopStateStore.flush()` it
  // runs right after this query resolves) already reflects the latest tabs /
  // canvas / drafts. Because we await the projection IPC before sending the
  // reply IPC, main processes them in order and the layout can't be lost to the
  // quit. Reply even if the flush rejects - a failed projection write must not
  // make main wait out its fresh-snapshot timeout and fall back to stale state.
  useEffect(() => {
    if (appLifecycle === null) return;
    const onGet = appLifecycle.onGetFreshUnsyncedSnapshot;
    const respond = appLifecycle.respondFreshUnsyncedSnapshot;
    if (onGet === undefined || respond === undefined) return;
    const subscription = onGet((request) => {
      cancelAmbientPushRef.current();
      const snapshot = registry.getUnsyncedEdits();
      const reply = (): Promise<void> =>
        respond({ requestId: request.requestId, snapshot });
      void flushActiveDesktopPerWindowProjection()
        .then(reply, reply)
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
      const handle = registry.get(entry.epicId);
      if (handle === null) continue;
      try {
        handle.store.getState().discardUnsyncedEdits();
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

  if (appLifecycle === null || quitSnapshot === null) {
    return null;
  }

  const displayedEntries = mergeEntries(quitSnapshot, liveUnsynced);
  const epicCount = displayedEntries.length;

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) {
          return;
        }
      }}
    >
      <DialogContent
        showCloseButton={false}
        data-testid="quit-intercept-dialog"
      >
        <DialogHeader>
          <DialogTitle>Saving - please wait</DialogTitle>
          <DialogDescription>
            {`${epicCount} Epic(s) have unsynced changes. Wait for them to sync, or quit and discard.`}
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
          <Button variant="default" data-testid="quit-intercept-wait">
            Wait
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
      },
    ];
  });
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
