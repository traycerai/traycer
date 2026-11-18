import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type ReactElement,
} from "react";
import type { BotSurfaceReference } from "@traycer/protocol/persistence/epic/messages";
import { artifactLinkPathRootAgnostic } from "@traycer/protocol/common/artifact-path";
import {
  ArtifactRowAnchor,
  LiveArtifactRow,
  type ArtifactReadScope,
  type LiveArtifactCardInput,
  type LiveArtifactReadyInput,
} from "@/components/chat/segments/artifact-row";
import {
  LiveArtifactPresentationContext,
  type ArtifactRaiseReport,
  type LiveArtifactPresentation,
} from "@/components/chat/segments/live-artifact-presentation-context";
import { usePaneVisible } from "@/components/epic-tabs/pane-visibility-context";
import {
  useBotArtifactOpen,
  type BotArtifactOpenTarget,
} from "@/hooks/bots/use-bot-surface-open";
import {
  artifactSourcePathsFor,
  artifactTreePath,
} from "@/lib/artifacts/artifact-object-paths";
import {
  assertArtifactReadLive,
  type ArtifactReadLifetime,
} from "@/lib/artifacts/artifact-read-lifetime";
import {
  isWindowOnScreen,
  subscribeDocumentVisibility,
} from "@/lib/dom/document-visibility";
import { readerAccessDenied } from "@/lib/epics/epic-access-verdict";
import { setEpicReaderPresented } from "@/lib/epics/epic-parking";
import { remoteAwareOwnerIdentityKey } from "@/lib/host/transport-key";
import { resolveManifestPath } from "@/lib/sandbox/artifact-serving";
import { cn } from "@/lib/utils";
import { anyAbortSignal } from "@traycer-clients/shared/auth/request-abort";
import {
  getEpicSessionController,
  type ArtifactReaderSnapshot,
} from "@/lib/registries/epic-session-controller";
import type { OpenEpicStoreHandle } from "@/stores/epics/open-epic/store";
import type {
  ArtifactProjection,
  ArtifactsSlice,
} from "@/stores/epics/open-epic/types";
import { useAuthStore } from "@/stores/auth/auth-store";

type ReadyReader = Extract<ArtifactReaderSnapshot, { kind: "ready" }>;

interface ReferenceView {
  readonly scopeKey: string;
  readonly artifact: LiveArtifactCardInput;
  readonly readScope: ArtifactReadScope;
  readonly target: BotArtifactOpenTarget | null;
}

type ArtifactSurface = Extract<BotSurfaceReference, { kind: "artifact" }>;

interface ReferenceAuthority {
  readonly readerGeneration: number;
  readonly key: string;
  readonly sourceGeneration: number;
  readonly controller: AbortController;
  readonly lifetime: ArtifactReadLifetime;
  readonly readScope: ArtifactReadScope;
}

/** Owner kinds whose bundle owns the paths beneath its folder. */
const BUNDLE_KINDS: ReadonlySet<ArtifactProjection["kind"]> = new Set([
  "html",
  "canvas",
]);

/** A current path reference; never a claim about the artifact present when posted. */
export function BotArtifactReferenceCard(props: {
  readonly surface: ArtifactSurface;
  readonly title: string;
  readonly rowKey: string;
}): ReactElement {
  const { surface, title, rowKey } = props;
  const { presented, root, setRoot, reportRaise, showPreview } =
    usePresentationDemand();
  const reader = useReferenceReader(surface, rowKey, presented);
  const presentation = useMemo<LiveArtifactPresentation>(
    () => ({
      reportRaise: reportRaise,
      reportEntryMissing: reader.reportEntryMissing,
    }),
    [reportRaise, reader.reportEntryMissing],
  );
  const current = presented ? reader.view : null;
  const framed = current?.artifact.kind === "ready";
  const anchorHeight = useAnchorHeight(root, framed);
  const open = useBotArtifactOpen(current?.target ?? null);
  let artifact = current?.artifact ?? { kind: "pending" as const, title };
  if (artifact.kind !== "ready" && artifact.title === "")
    artifact = { ...artifact, title };
  const anchored = !framed && anchorHeight !== null;
  const anchorStyle: CSSProperties & Record<string, string> = anchored
    ? { "--artifact-anchor-height": `${String(anchorHeight)}px` }
    : {};
  return (
    <div
      ref={setRoot}
      className={cn(
        "flex w-full flex-col",
        anchored && "min-h-(--artifact-anchor-height)",
      )}
      style={anchorStyle}
    >
      {presented ? (
        <LiveArtifactPresentationContext value={presentation}>
          <LiveArtifactRow
            artifact={artifact}
            readScope={
              current?.readScope ?? { hostId: surface.hostId, client: null }
            }
            onOpen={open}
            onRetry={reader.retry}
          />
        </LiveArtifactPresentationContext>
      ) : (
        <ArtifactRowAnchor title={title} onShowPreview={showPreview} />
      )}
    </div>
  );
}

/**
 * Whether the card is presented: this window on screen, its pane visible, and
 * the card in the transcript's view or raised. A raised card in a hidden pane
 * or window is not presented. Where nothing can observe the view, only the
 * explicit button presents it.
 */
function usePresentationDemand(): {
  readonly presented: boolean;
  readonly root: HTMLDivElement | null;
  readonly setRoot: (element: HTMLDivElement | null) => void;
  readonly reportRaise: (report: ArtifactRaiseReport) => void;
  readonly showPreview: (() => void) | null;
} {
  const paneVisible = usePaneVisible();
  const windowOnScreen = useSyncExternalStore(
    subscribeDocumentVisibility,
    isWindowOnScreen,
    isWindowOnScreen,
  );
  const onScreen = paneVisible && windowOnScreen;
  const observable = typeof IntersectionObserver !== "undefined";
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  const [intersecting, setIntersecting] = useState(false);
  const [explicitDemand, setExplicitDemand] = useState(false);
  // `surfaceUp` is a surface raised right now; `raised` alone is a raise
  // remembered across a presentation loss that unmounted the surface.
  const [raise, setRaise] = useState<RaiseState>(NOT_RAISED);

  useEffect(() => {
    if (root === null || !observable) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const last = entries.at(-1);
        if (last === undefined) return;
        setIntersecting(last.isIntersecting);
        // A remembered raise lasts until the row's geometry is reported again
        // with no surface up to hold it.
        setRaise((previous) => (previous.surfaceUp ? previous : NOT_RAISED));
      },
      { root: nearestScroller(root) },
    );
    observer.observe(root);
    return () => observer.disconnect();
  }, [root, observable]);

  const reportRaise = useCallback((report: ArtifactRaiseReport) => {
    setRaise((previous) => {
      if (report === "raised") return { raised: true, surfaceUp: true };
      if (report === "lowered") return NOT_RAISED;
      return { raised: previous.raised, surfaceUp: false };
    });
  }, []);
  const showPreview = useCallback(() => setExplicitDemand(true), []);
  return {
    presented:
      onScreen &&
      (raise.raised || (observable ? intersecting : explicitDemand)),
    root,
    setRoot,
    reportRaise,
    showPreview: observable || !onScreen ? null : showPreview,
  };
}

interface RaiseState {
  readonly raised: boolean;
  readonly surfaceUp: boolean;
}

const NOT_RAISED: RaiseState = { raised: false, surfaceUp: false };

/** The last height the card measured while showing its frame. */
function useAnchorHeight(
  root: HTMLDivElement | null,
  framed: boolean,
): number | null {
  const [height, setHeight] = useState<number | null>(null);
  useEffect(() => {
    if (root === null || !framed || typeof ResizeObserver === "undefined")
      return;
    const observer = new ResizeObserver(() => {
      const measured = root.getBoundingClientRect().height;
      if (measured > 0) setHeight(measured);
    });
    observer.observe(root);
    return () => observer.disconnect();
  }, [root, framed]);
  return height;
}

/**
 * The card's reader, held only while the card is presented. The logical row
 * keeps its entry-miss latch across presentation leases and token turnover;
 * it is forgotten only with the row.
 */
function useReferenceReader(
  surface: ArtifactSurface,
  rowKey: string,
  presented: boolean,
): {
  readonly view: ReferenceView | null;
  readonly retry: () => void;
  readonly reportEntryMissing: (artifact: LiveArtifactReadyInput) => void;
} {
  const userId = useAuthStore((state) => state.profile?.userId ?? null);
  const scopeKey = JSON.stringify([
    userId,
    surface.hostId,
    surface.epicId,
    surface.artifactPath,
    rowKey,
  ]);
  const presenterKey = useId();
  const [view, setView] = useState<ReferenceView | null>(null);
  const [attempt, setAttempt] = useState(0);
  const retryRef = useRef<(() => void) | null>(null);
  const retry = useCallback(() => retryRef.current?.(), []);
  const entryMissLatch = useRef<string | null>(null);
  const entryMissRef = useRef<
    ((artifact: LiveArtifactReadyInput) => void) | null
  >(null);
  const reportEntryMissing = useCallback(
    (artifact: LiveArtifactReadyInput) => entryMissRef.current?.(artifact),
    [],
  );
  const { hostId, epicId, artifactPath } = surface;

  useLayoutEffect(() => {
    if (!presented || userId === null || rowKey === "") return;
    let presentationPublished = false;
    const publishPresentation = (value: boolean): void => {
      if (presentationPublished === value) return;
      presentationPublished = value;
      setEpicReaderPresented(epicId, presenterKey, value);
    };
    // Before the acquisition, so a parked epic is unparked first.
    publishPresentation(true);
    const token = getEpicSessionController().acquireArtifactReader({
      hostId,
      epicId,
      rowKey,
    });
    let active = true;
    let released = false;
    let authority: ReferenceAuthority | null = null;
    let sourceGeneration = 0;
    let publishedLatchKey: string | null = null;
    let observedHandle: OpenEpicStoreHandle | null = null;
    let unsubscribeHandle: (() => void) | null = null;

    const retire = (): void => {
      authority?.controller.abort();
      authority = null;
      publishedLatchKey = null;
    };
    const publishAbsent = (kind: "pending" | "unavailable"): void => {
      retire();
      setView({
        scopeKey,
        artifact: { kind, title: "" },
        readScope: { hostId, client: null },
        target: null,
      });
    };
    const releaseForAccess = (): void => {
      if (released) return;
      released = true;
      retire();
      token.release();
      publishPresentation(false);
      retryRef.current = () => setAttempt((value) => value + 1);
    };
    const admit = (
      snapshot: ReadyReader,
      artifact: ArtifactProjection,
      treePath: string,
      entryPath: string,
    ): ReferenceAuthority => {
      const key = JSON.stringify([
        snapshot.generation,
        artifact.id,
        treePath,
        entryPath,
        artifact.kind,
      ]);
      if (authority !== null && authority.key === key) return authority;
      retire();
      const { handle, hostClient } = snapshot;
      const controller = new AbortController();
      const lifetime: ArtifactReadLifetime = {
        signal: controller.signal,
        isCurrent: () => !controller.signal.aborted,
      };
      const assertCurrent = (): void => {
        const now = token.read();
        if (
          !active ||
          released ||
          now.kind !== "ready" ||
          now.generation !== snapshot.generation ||
          now.handle !== handle ||
          useAuthStore.getState().profile?.userId !== userId ||
          readerVerdict(snapshot, userId) !== "admitted" ||
          !locationUnchanged(handle, artifact, treePath, entryPath)
        ) {
          controller.abort();
        }
        assertArtifactReadLive(lifetime);
      };
      sourceGeneration += 1;
      authority = {
        readerGeneration: snapshot.generation,
        key,
        sourceGeneration,
        controller,
        lifetime,
        readScope: {
          hostId,
          lifetime,
          client: {
            requestWithSignal: async (method, request, signal) => {
              assertCurrent();
              const requestSignal = anyAbortSignal([signal, lifetime.signal]);
              const answer = await hostClient.requestWithSignal(
                method,
                request,
                requestSignal,
              );
              requestSignal.throwIfAborted();
              assertCurrent();
              return answer;
            },
          },
        },
      };
      return authority;
    };
    const publishResolved = (
      snapshot: ReadyReader,
      resolved: ResolvedReference,
      latchKey: string | null,
    ): void => {
      const { artifact, treePath, entryPath } = resolved;
      const admitted = admit(snapshot, artifact, treePath, entryPath);
      const target: BotArtifactOpenTarget = {
        hostId,
        epicId,
        artifactId: artifact.id,
        title: artifact.title,
        kind: artifact.kind,
        lifetime: admitted.lifetime,
      };
      if (artifact.kind !== "html") {
        setView({
          scopeKey,
          artifact: { kind: "no-preview", title: artifact.title },
          readScope: admitted.readScope,
          target,
        });
        return;
      }
      const manifest = artifact.head;
      if (manifest === undefined) {
        publishAbsent("unavailable");
        return;
      }
      publishedLatchKey = latchKey;
      // A head save updates the manifest without changing reader or source
      // authority. A download already holding that reader exports its snapshot.
      setView({
        scopeKey,
        artifact: {
          kind: "ready",
          hostId,
          epicId,
          artifactId: artifact.id,
          title: artifact.title,
          manifest,
          treePath,
          entryPath,
          readerGeneration: admitted.readerGeneration,
          sourceGeneration: admitted.sourceGeneration,
        },
        readScope: admitted.readScope,
        target,
      });
    };
    const refreshWithoutReader = (snapshot: ArtifactReaderSnapshot): void => {
      unsubscribeHandle?.();
      unsubscribeHandle = null;
      observedHandle = null;
      const pending =
        snapshot.kind === "reserved" || snapshot.kind === "acquiring";
      // A refused, revoked or failed reader is not a way the epic is shown,
      // so it does not hold parking off.
      publishPresentation(pending || snapshot.kind === "revoking");
      if (pending && entryMissLatch.current === null) publishAbsent("pending");
      else publishAbsent("unavailable");
    };
    const refreshLoaded = (snapshot: ReadyReader): void => {
      const resolved = resolveReference(
        epicId,
        artifactPath,
        snapshot.handle.store.getState().artifacts,
      );
      if (resolved === null) {
        publishAbsent("unavailable");
        return;
      }
      const latchKey = entryLatchKey(
        snapshot,
        userId,
        { epicId, artifactPath },
        resolved,
      );
      if (entryMissLatch.current !== null) {
        if (entryMissLatch.current === latchKey) {
          publishAbsent("unavailable");
          return;
        }
        entryMissLatch.current = null;
      }
      publishResolved(snapshot, resolved, latchKey);
    };
    const refresh = (): void => {
      if (!active || released) return;
      const snapshot = token.read();
      if (useAuthStore.getState().profile?.userId !== userId) {
        publishAbsent("unavailable");
        releaseForAccess();
        return;
      }
      if (snapshot.kind !== "ready") {
        refreshWithoutReader(snapshot);
        return;
      }
      const { handle } = snapshot;
      if (observedHandle !== handle) {
        unsubscribeHandle?.();
        observedHandle = handle;
        unsubscribeHandle = handle.store.subscribe(refresh);
      }
      const verdict = readerVerdict(snapshot, userId);
      if (verdict === "identity") {
        publishAbsent("unavailable");
        releaseForAccess();
        return;
      }
      // A denial keeps the token: Retry re-reads authority through it.
      publishPresentation(verdict === "admitted");
      if (verdict === "denied") {
        publishAbsent("unavailable");
        return;
      }
      const state = handle.store.getState();
      if (state.snapshotLoaded) {
        refreshLoaded(snapshot);
        return;
      }
      publishAbsent(
        state.snapshotFetchError === null && entryMissLatch.current === null
          ? "pending"
          : "unavailable",
      );
    };

    entryMissRef.current = (artifact) => {
      if (
        !active ||
        released ||
        authority === null ||
        publishedLatchKey === null ||
        artifact.readerGeneration !== authority.readerGeneration ||
        artifact.sourceGeneration !== authority.sourceGeneration
      ) {
        return;
      }
      entryMissLatch.current = publishedLatchKey;
      refresh();
    };
    retryRef.current = () => {
      if (released) {
        setAttempt((value) => value + 1);
        return;
      }
      entryMissLatch.current = null;
      publishPresentation(true);
      token.retry();
      refresh();
    };
    const unsubscribeToken = token.subscribe(refresh);
    const unsubscribeAuth = useAuthStore.subscribe(refresh);
    refresh();
    return () => {
      active = false;
      retire();
      unsubscribeToken();
      unsubscribeAuth();
      unsubscribeHandle?.();
      token.release();
      publishPresentation(false);
      retryRef.current = null;
      entryMissRef.current = null;
    };
  }, [
    presented,
    presenterKey,
    userId,
    hostId,
    epicId,
    artifactPath,
    rowKey,
    scopeKey,
    attempt,
  ]);

  return {
    view: view?.scopeKey === scopeKey ? view : null,
    retry,
    reportEntryMissing,
  };
}

interface ResolvedReference {
  readonly artifact: ArtifactProjection;
  readonly treePath: string;
  readonly entryPath: string;
}

/** The admitted artifact still has the kind and location its read began with. */
function locationUnchanged(
  handle: OpenEpicStoreHandle,
  artifact: ArtifactProjection,
  treePath: string,
  entryPath: string,
): boolean {
  const { artifacts } = handle.store.getState();
  if (!Object.hasOwn(artifacts.byId, artifact.id)) return false;
  const current = artifacts.byId[artifact.id];
  const paths = artifactSourcePathsFor(current, artifacts);
  return (
    current.kind === artifact.kind &&
    paths?.treePath === treePath &&
    paths.entryPath === entryPath
  );
}

/**
 * The transcript's scroller: the channel and the threads view keep their
 * scroll element to themselves, so it is the nearest scrolling ancestor.
 * `null` measures against the viewport.
 */
function nearestScroller(element: HTMLElement): HTMLElement | null {
  for (
    let node = element.parentElement;
    node !== null;
    node = node.parentElement
  ) {
    const { overflowY } = getComputedStyle(node);
    if (overflowY === "auto" || overflowY === "scroll") return node;
  }
  return null;
}

/**
 * What an entry miss is a verdict about: the viewer and the host owner they
 * read through, the reference, the artifact, its entry path and the entry's
 * own record. Any change re-reads the entry; a head save that leaves the
 * entry's record alone does not.
 */
function entryLatchKey(
  snapshot: ReadyReader,
  userId: string,
  reference: { readonly epicId: string; readonly artifactPath: string },
  resolved: ResolvedReference,
): string | null {
  const { artifact, entryPath } = resolved;
  if (artifact.kind !== "html" || artifact.head === undefined) return null;
  const record = resolveManifestPath(
    artifact.head,
    entryPath === "" ? "index.html" : entryPath,
  );
  return JSON.stringify([
    userId,
    remoteAwareOwnerIdentityKey(
      snapshot.hostClient.getActiveHost(),
      snapshot.hostClient.getRequestContextUserId(),
    ),
    reference.epicId,
    reference.artifactPath,
    artifact.id,
    entryPath,
    record?.sha256 ?? null,
  ]);
}

/**
 * Match only the admitted root projection, longest prefix first: the exact
 * path (or a folder's index page) names its artifact, and otherwise the
 * deepest artifact on the path owns it when it is an html or canvas bundle.
 * Unknown and ambiguous paths fail closed. The frame still opens the owner's
 * own entry.
 */
function resolveReference(
  epicId: string,
  path: string,
  artifacts: ArtifactsSlice,
): ResolvedReference | null {
  const marked = artifactLinkPathRootAgnostic(path, null);
  if (marked !== null && marked.epicId !== epicId) return null;
  const layout =
    marked ??
    artifactLinkPathRootAgnostic(
      `epics/${epicId}/artifacts/${path.replace(/^[\\\\/]+/u, "")}`,
      epicId,
    );
  if (layout === null) return null;
  const trees: Array<{ artifact: ArtifactProjection; tree: string }> = [];
  for (const id of artifacts.allIds) {
    const tree = artifactTreePath(artifacts, id);
    if (tree !== null) trees.push({ artifact: artifacts.byId[id], tree });
  }
  const { segments } = layout;
  for (let length = segments.length; length > 0; length -= 1) {
    const prefix = segments.slice(0, length).join("/");
    const exact = length === segments.length;
    const matches = trees.filter(
      ({ artifact, tree }) =>
        prefix === tree ||
        (exact &&
          artifact.layout !== "file" &&
          (prefix === `${tree}/index.md` || prefix === `${tree}/index.html`)),
    );
    if (matches.length === 0) continue;
    if (matches.length > 1) return null;
    const match = matches[0];
    if (!exact && !BUNDLE_KINDS.has(match.artifact.kind)) return null;
    const paths = artifactSourcePathsFor(match.artifact, artifacts);
    return paths === null ? null : { artifact: match.artifact, ...paths };
  }
  return null;
}

/**
 * A populated cache never substitutes for the admitted request identity or
 * access verdict. `identity` is a different viewer; `denied` is the epic
 * withdrawn from this one.
 */
function readerVerdict(
  snapshot: ReadyReader,
  userId: string,
): "admitted" | "identity" | "denied" {
  const { handle, hostClient } = snapshot;
  if (
    handle.userId !== userId ||
    hostClient.getRequestContextUserId() !== userId
  ) {
    return "identity";
  }
  const state = handle.store.getState();
  if (
    readerAccessDenied(state) ||
    (state.snapshotLoaded && state.permissionRole === null)
  ) {
    return "denied";
  }
  return "admitted";
}
