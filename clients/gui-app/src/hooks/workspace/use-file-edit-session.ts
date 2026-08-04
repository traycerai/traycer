import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@traycer/protocol/host";
import { useWorkspaceWriteFile } from "@/hooks/workspace/use-workspace-write-file-mutation";
import {
  fileEditRuntimeRegistry,
  type FileEditRuntimeAttachment,
} from "@/lib/workspace/file-edit-runtime-registry";
import {
  fileEditIdentityKey,
  type FileEditDiskSnapshot,
  type FileEditIdentity,
  type FileEditRuntime,
  type FileEditRuntimeState,
} from "@/lib/workspace/file-edit-runtime";
import { fileContentRevision } from "@/lib/workspace/file-content-revision";
import type {
  DiffEditActivationRequest,
  DiffEditActivationResult,
} from "@/components/diff/use-diff-click-to-edit";

interface SessionAttachment extends FileEditRuntimeAttachment {
  readonly identityKey: string;
}

export interface FileEditSessionController {
  readonly runtime: FileEditRuntime | null;
  readonly state: FileEditRuntimeState | null;
  readonly activate: (
    request: DiffEditActivationRequest,
    diskContent: string,
  ) => Promise<DiffEditActivationResult>;
  readonly setDraft: (content: string) => void;
  readonly flush: () => void;
  readonly retry: () => void;
  readonly resolveKeepMine: (diskContent: string) => Promise<void>;
  readonly resolveUseDisk: (diskContent: string) => Promise<void>;
  readonly reportConflictResolutionError: (error: string) => void;
}

export function useFileEditSession(props: {
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly identity: FileEditIdentity;
  readonly diskContent: string | null;
  readonly surfaceId: string;
  readonly autoAttach: boolean;
}): FileEditSessionController {
  const identityKey = useMemo(
    () => fileEditIdentityKey(props.identity),
    [props.identity],
  );
  const { mutateAsync } = useWorkspaceWriteFile(props.client);
  const writer = useCallback(
    (request: Parameters<typeof mutateAsync>[0]) => mutateAsync(request),
    [mutateAsync],
  );
  const [attachment, setAttachment] = useState<SessionAttachment | null>(null);
  const attachmentRef = useRef<SessionAttachment | null>(null);
  const generationRef = useRef(0);
  const activeAttachment =
    attachment?.identityKey === identityKey ? attachment : null;
  const state = useFileEditRuntimeState(activeAttachment?.runtime ?? null);

  useEffect(() => {
    const current = attachmentRef.current;
    if (current?.identityKey === identityKey) {
      current.updateWriter(writer);
    }
  }, [identityKey, writer]);

  useEffect(() => {
    const current = attachmentRef.current;
    if (current?.identityKey !== identityKey || props.diskContent === null) {
      return;
    }
    const diskContent = props.diskContent;
    let cancelled = false;
    // A runtime this effect just auto-attached can still be "recovering" -
    // `refreshCleanDisk` no-ops outside `status === "clean"`, and nothing
    // else re-checks the freshest disk content once recovery settles. Wait
    // for `whenRecovered()` (the same primitive `activate()` already awaits
    // above) alongside the revision hash so a reconciliation that lands
    // mid-recovery isn't silently dropped instead of merely deferred.
    void Promise.all([
      current.runtime.whenRecovered(),
      fileContentRevision(diskContent),
    ]).then(([, revision]) => {
      if (!cancelled && attachmentRef.current === current) {
        current.runtime.refreshCleanDisk({
          content: diskContent,
          revision,
        });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [identityKey, props.diskContent]);

  useEffect(() => {
    return () => {
      generationRef.current += 1;
      const current = attachmentRef.current;
      if (current?.identityKey === identityKey) {
        current.detach();
        attachmentRef.current = null;
      }
    };
  }, [identityKey]);

  // A surface that auto-attached (e.g. a workspace-file tab) can become
  // ineligible to edit while still mounted - an LRU keep-alive tab hides an
  // inactive body instead of unmounting it. Without this, an attachment (and
  // any ownership it claimed) would linger on the hidden surface forever, so a
  // freshly opened visible tab for the same file would keep hitting
  // `focus-owner` against a body the user can no longer see or release. Only
  // fires for THIS effect's own auto-attach path: `identityKey` gates it to
  // the attachment this hook created, so it never touches an attachment an
  // explicit `activate()` call owns (the Git-diff path always passes
  // `autoAttach: false` and never changes it, so this never re-runs there).
  useEffect(() => {
    if (props.autoAttach) return;
    const current = attachmentRef.current;
    if (current?.identityKey !== identityKey) return;
    current.detach();
    attachmentRef.current = null;
    setAttachment(null);
  }, [identityKey, props.autoAttach]);

  useEffect(() => {
    if (!props.autoAttach || props.diskContent === null) return;
    const diskContent = props.diskContent;
    const current = attachmentRef.current;
    if (current?.identityKey === identityKey) {
      current.updateWriter(writer);
      return;
    }
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    let cancelled = false;
    void fileContentRevision(diskContent)
      .then((revision) => {
        if (cancelled || generationRef.current !== generation) return;
        const attached = fileEditRuntimeRegistry.attach({
          identity: props.identity,
          initialDisk: { content: diskContent, revision },
          surfaceId: props.surfaceId,
          writer,
        });
        const sessionAttachment = { ...attached, identityKey };
        attachmentRef.current = sessionAttachment;
        setAttachment(sessionAttachment);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [
    identityKey,
    props.autoAttach,
    props.diskContent,
    props.identity,
    props.surfaceId,
    writer,
  ]);

  const activate = useCallback(
    async (
      request: DiffEditActivationRequest,
      diskContent: string,
    ): Promise<DiffEditActivationResult> => {
      const generation = generationRef.current + 1;
      generationRef.current = generation;
      let current = attachmentRef.current;
      if (current?.identityKey !== identityKey) {
        current?.detach();
        // Null the ref right away, before the await below: if this request
        // stops being current while awaiting `fileContentRevision`, the
        // rejected branch below returns without ever reassigning
        // `attachmentRef.current`, which would otherwise keep pointing at
        // the just-detached attachment. `setDraft`/`flush`/`retry` read
        // `attachmentRef.current` directly (not gated by `identityKey`), so
        // a stale ref would route them at a runtime that no longer holds a
        // surface lease for this component.
        if (attachmentRef.current === current) {
          attachmentRef.current = null;
        }
        const revision = await fileContentRevision(diskContent);
        if (!request.isCurrent() || generationRef.current !== generation) {
          return { kind: "rejected" };
        }
        const attached = fileEditRuntimeRegistry.attach({
          identity: props.identity,
          initialDisk: { content: diskContent, revision },
          surfaceId: props.surfaceId,
          writer,
        });
        current = { ...attached, identityKey };
        attachmentRef.current = current;
        setAttachment(current);
      } else {
        current.updateWriter(writer);
      }

      await current.runtime.whenRecovered();
      if (
        !request.isCurrent() ||
        generationRef.current !== generation ||
        attachmentRef.current !== current
      ) {
        return { kind: "rejected" };
      }

      const ownerSurfaceId = current.runtime.store.getState().ownerSurfaceId;
      if (ownerSurfaceId !== null && ownerSurfaceId !== props.surfaceId) {
        return { kind: "focus-owner", ownerSurfaceId };
      }
      return current.runtime.claimOwnership(props.surfaceId)
        ? { kind: "activated" }
        : { kind: "rejected" };
    },
    [identityKey, props.identity, props.surfaceId, writer],
  );

  const setDraft = useCallback(
    (content: string): void => {
      attachmentRef.current?.runtime.setDraft(props.surfaceId, content);
    },
    [props.surfaceId],
  );
  const flush = useCallback((): void => {
    void attachmentRef.current?.runtime.flush();
  }, []);
  const retry = useCallback((): void => {
    void attachmentRef.current?.runtime.retry();
  }, []);
  const resolveKeepMine = useCallback(async (diskContent: string) => {
    const runtime = attachmentRef.current?.runtime;
    if (runtime === undefined) return;
    const disk: FileEditDiskSnapshot = {
      content: diskContent,
      revision: await fileContentRevision(diskContent),
    };
    await runtime.resolveKeepMine(disk);
  }, []);
  const resolveUseDisk = useCallback(
    async (diskContent: string) => {
      const runtime = attachmentRef.current?.runtime;
      if (runtime === undefined) return;
      const disk: FileEditDiskSnapshot = {
        content: diskContent,
        revision: await fileContentRevision(diskContent),
      };
      runtime.resolveUseDisk(disk);
      runtime.releaseOwnership(props.surfaceId);
    },
    [props.surfaceId],
  );
  const reportConflictResolutionError = useCallback((error: string): void => {
    attachmentRef.current?.runtime.setConflictResolutionError(error);
  }, []);

  return {
    runtime: activeAttachment?.runtime ?? null,
    state,
    activate,
    setDraft,
    flush,
    retry,
    resolveKeepMine,
    resolveUseDisk,
    reportConflictResolutionError,
  };
}

function useFileEditRuntimeState(
  runtime: FileEditRuntime | null,
): FileEditRuntimeState | null {
  const subscribe = useCallback(
    (onStoreChange: () => void): (() => void) =>
      runtime?.store.subscribe(onStoreChange) ?? (() => undefined),
    [runtime],
  );
  const getSnapshot = useCallback(
    (): FileEditRuntimeState | null => runtime?.store.getState() ?? null,
    [runtime],
  );
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
