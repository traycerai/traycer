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
    void fileContentRevision(diskContent).then((revision) => {
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
