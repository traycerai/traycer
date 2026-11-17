import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
} from "react";
import type { BotSurfaceReference } from "@traycer/protocol/persistence/epic/messages";
import { artifactLinkPathRootAgnostic } from "@traycer/protocol/common/artifact-path";
import {
  LiveArtifactRow,
  type ArtifactReadScope,
  type LiveArtifactCardInput,
} from "@/components/chat/segments/artifact-row";
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
import { anyAbortSignal } from "@traycer-clients/shared/auth/request-abort";
import {
  getEpicSessionController,
  type ArtifactReaderSnapshot,
} from "@/lib/registries/epic-session-controller";
import type { OpenEpicStoreHandle } from "@/stores/epics/open-epic/store";
type ReadyReader = Extract<ArtifactReaderSnapshot, { kind: "ready" }>;
import type {
  ArtifactProjection,
  ArtifactsSlice,
} from "@/stores/epics/open-epic/types";
import { useAuthStore } from "@/stores/auth/auth-store";

interface ReferenceView {
  readonly scopeKey: string;
  readonly artifact: LiveArtifactCardInput;
  readonly readScope: ArtifactReadScope;
  readonly target: BotArtifactOpenTarget | null;
}

interface ReferenceAuthority {
  readonly readerGeneration: number;
  readonly key: string;
  readonly sourceGeneration: number;
  readonly controller: AbortController;
  readonly lifetime: ArtifactReadLifetime;
  readonly readScope: ArtifactReadScope;
}

/** A current path reference; never a claim about the artifact present when posted. */
export function BotArtifactReferenceCard(props: {
  readonly surface: Extract<BotSurfaceReference, { kind: "artifact" }>;
  readonly title: string;
  readonly rowKey: string;
}): ReactElement {
  const { surface, title, rowKey } = props;
  const userId = useAuthStore((state) => state.profile?.userId ?? null);
  const scopeKey = JSON.stringify([
    userId,
    surface.hostId,
    surface.epicId,
    surface.artifactPath,
    rowKey,
  ]);
  const [view, setView] = useState<ReferenceView | null>(null);
  const [attempt, setAttempt] = useState(0);
  const retryRef = useRef<(() => void) | null>(null);
  const retry = useCallback(() => retryRef.current?.(), []);

  useLayoutEffect(() => {
    if (userId === null || rowKey === "") return;
    const token = getEpicSessionController().acquireArtifactReader({
      hostId: surface.hostId,
      epicId: surface.epicId,
      rowKey,
    });
    let active = true;
    let released = false;
    let authority: ReferenceAuthority | null = null;
    let sourceGeneration = 0;
    let observedHandle: OpenEpicStoreHandle | null = null;
    let unsubscribeHandle: (() => void) | null = null;

    const retire = (): void => {
      authority?.controller.abort();
      authority = null;
    };
    const publishAbsent = (kind: "pending" | "unavailable"): void => {
      retire();
      setView({
        scopeKey,
        artifact: { kind, title: "" },
        readScope: { hostId: surface.hostId, client: null },
        target: null,
      });
    };
    const releaseForAccess = (): void => {
      if (released) return;
      released = true;
      retire();
      token.release();
      retryRef.current = () => setAttempt((value) => value + 1);
    };
    const publishResolved = (
      snapshot: ReadyReader,
      resolved: {
        artifact: ArtifactProjection;
        treePath: string;
        entryPath: string;
      },
    ): void => {
      const { artifact, treePath, entryPath } = resolved;
      const { handle, hostClient } = snapshot;
      const key = JSON.stringify([
        snapshot.generation,
        artifact.id,
        treePath,
        entryPath,
        artifact.kind,
      ]);
      if (authority === null || authority.key !== key) {
        retire();
        const controller = new AbortController();
        const lifetime: ArtifactReadLifetime = {
          signal: controller.signal,
          isCurrent: () => !controller.signal.aborted,
        };
        const assertCurrent = (): void => {
          const now = token.read();
          const current = handle.store.getState();
          const currentArtifact = Object.hasOwn(
            current.artifacts.byId,
            artifact.id,
          )
            ? current.artifacts.byId[artifact.id]
            : null;
          const currentPaths =
            currentArtifact === null
              ? null
              : artifactSourcePathsFor(currentArtifact, current.artifacts);
          if (
            !active ||
            released ||
            now.kind !== "ready" ||
            now.generation !== snapshot.generation ||
            now.handle !== handle ||
            useAuthStore.getState().profile?.userId !== userId ||
            !readerAdmits(snapshot, userId) ||
            currentArtifact?.kind !== artifact.kind ||
            currentPaths?.treePath !== treePath ||
            currentPaths.entryPath !== entryPath
          ) {
            controller.abort();
          }
          assertArtifactReadLive(lifetime);
        };
        const readScope: ArtifactReadScope = {
          hostId: surface.hostId,
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
        };
        sourceGeneration += 1;
        authority = {
          readerGeneration: snapshot.generation,
          key,
          sourceGeneration,
          controller,
          lifetime,
          readScope,
        };
      }
      const admitted = authority;
      const target: BotArtifactOpenTarget = {
        hostId: surface.hostId,
        epicId: surface.epicId,
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
      // A head save updates the manifest without changing reader or source
      // authority. A download already holding that reader exports its snapshot.
      setView({
        scopeKey,
        artifact: {
          kind: "ready",
          hostId: surface.hostId,
          epicId: surface.epicId,
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
    const refresh = (): void => {
      if (!active || released) return;
      const snapshot = token.read();
      if (useAuthStore.getState().profile?.userId !== userId) {
        publishAbsent("unavailable");
        releaseForAccess();
        return;
      }
      if (snapshot.kind !== "ready") {
        unsubscribeHandle?.();
        unsubscribeHandle = null;
        observedHandle = null;
        const pending =
          snapshot.kind === "reserved" || snapshot.kind === "acquiring";
        publishAbsent(pending ? "pending" : "unavailable");
        return;
      }
      const { handle } = snapshot;
      if (observedHandle !== handle) {
        unsubscribeHandle?.();
        observedHandle = handle;
        unsubscribeHandle = handle.store.subscribe(refresh);
      }
      const state = handle.store.getState();
      if (!readerAdmits(snapshot, userId)) {
        publishAbsent("unavailable");
        releaseForAccess();
        return;
      }
      if (!state.snapshotLoaded) {
        publishAbsent(
          state.snapshotFetchError === null ? "pending" : "unavailable",
        );
        return;
      }
      const resolved = resolveReference(
        surface.epicId,
        surface.artifactPath,
        state.artifacts,
      );
      if (resolved === null) {
        publishAbsent("unavailable");
        return;
      }
      publishResolved(snapshot, resolved);
    };

    retryRef.current = () => {
      if (released) setAttempt((value) => value + 1);
      else {
        token.retry();
        observedHandle?.requestFreshSnapshot();
      }
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
      retryRef.current = null;
    };
  }, [
    userId,
    surface.hostId,
    surface.epicId,
    surface.artifactPath,
    rowKey,
    scopeKey,
    attempt,
  ]);

  const current = view?.scopeKey === scopeKey ? view : null;
  const open = useBotArtifactOpen(current?.target ?? null);
  let artifact = current?.artifact ?? { kind: "pending" as const, title };
  if (artifact.kind === "pending" || artifact.kind === "unavailable")
    artifact = { ...artifact, title };
  return (
    <LiveArtifactRow
      artifact={artifact}
      readScope={current?.readScope ?? { hostId: surface.hostId, client: null }}
      onOpen={open}
      onRetry={retry}
    />
  );
}

/** Match only the admitted root projection. Unknown and ambiguous paths fail closed. */
function resolveReference(
  epicId: string,
  path: string,
  artifacts: ArtifactsSlice,
): {
  artifact: ArtifactProjection;
  treePath: string;
  entryPath: string;
} | null {
  const marked = artifactLinkPathRootAgnostic(path, null);
  if (marked !== null && marked.epicId !== epicId) return null;
  const layout =
    marked ??
    artifactLinkPathRootAgnostic(
      `epics/${epicId}/artifacts/${path.replace(/^[\\\\/]+/u, "")}`,
      epicId,
    );
  if (layout === null) return null;
  const wanted = layout.segments.join("/");
  let found: ArtifactProjection | null = null;
  for (const id of artifacts.allIds) {
    const artifact = artifacts.byId[id];
    const tree = artifactTreePath(artifacts, id);
    if (tree === null) continue;
    const matches =
      wanted === tree ||
      (artifact.layout !== "file" &&
        (wanted === `${tree}/index.md` || wanted === `${tree}/index.html`));
    if (!matches) continue;
    if (found !== null) return null;
    found = artifact;
  }
  if (found === null) return null;
  const paths = artifactSourcePathsFor(found, artifacts);
  return paths === null ? null : { artifact: found, ...paths };
}

/** A populated cache never substitutes for the admitted request identity or access verdict. */
function readerAdmits(snapshot: ReadyReader, userId: string): boolean {
  const { handle, hostClient } = snapshot;
  const state = handle.store.getState();
  return (
    handle.userId === userId &&
    hostClient.getRequestContextUserId() === userId &&
    !state.accessLost &&
    state.epicDeleted === null &&
    (!state.snapshotLoaded || state.permissionRole !== null)
  );
}
