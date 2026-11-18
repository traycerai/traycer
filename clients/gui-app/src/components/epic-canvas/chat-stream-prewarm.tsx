import { useEffect, useMemo, useState } from "react";
import { sessionKeyOf } from "@traycer-clients/shared/replica-runtime";
import { usePaneVisible } from "@/components/epic-tabs/pane-visibility-context";
import { selectChatPrewarmRefs } from "@/components/epic-canvas/chat-prewarm-selection";
import { subscribeChatTileSessionAcquired } from "@/components/epic-canvas/chat-prewarm-handoff";
import { useIsMobileViewport } from "@/hooks/ui/use-mobile-viewport";
import { useEpicParked } from "@/lib/epics/epic-parking";
import { useChatSessionHandle } from "@/lib/registries/chat-session-registry";
import { useEpicCanvas, useEpicCanvasStore } from "@/stores/epics/canvas/store";

/**
 * The persisted canvas already identifies the selected chat before the task
 * state frame arrives. Acquire its stream while that frame is in flight; the
 * tile still waits for task authority before painting and uses the same chat
 * registry entry when it mounts. A newly created chat has a pending-create
 * marker, and an initial-chat handoff uses the live canvas path instead.
 */
export function ChatStreamPrewarm(props: {
  readonly epicId: string;
  readonly tabId: string;
  readonly snapshotLoaded: boolean;
}) {
  // A task already hydrated before this shell mounted has no relay wait to
  // overlap. Keep this decision for the mount so a real prewarm survives the
  // later false→true snapshot transition and can hand its lease to the tile.
  const [openedBeforeSnapshot] = useState(() => !props.snapshotLoaded);
  return openedBeforeSnapshot ? <ActiveChatStreamPrewarm {...props} /> : null;
}

function sameKeys(
  left: ReadonlySet<string>,
  right: ReadonlySet<string>,
): boolean {
  return left.size === right.size && [...left].every((key) => right.has(key));
}

function ActiveChatStreamPrewarm(props: {
  readonly epicId: string;
  readonly tabId: string;
  readonly snapshotLoaded: boolean;
}) {
  const visible = usePaneVisible();
  const parked = useEpicParked(props.epicId);
  const mobile = useIsMobileViewport();
  const canvas = useEpicCanvas(props.tabId);
  const pendingCreateIds = useEpicCanvasStore(
    (s) => s.pendingCreateArtifactIds,
  );
  const selfDeletedIds = useEpicCanvasStore((s) => s.selfDeletedArtifactIds);
  const refs = useMemo(
    () =>
      selectChatPrewarmRefs(canvas, mobile, pendingCreateIds, selfDeletedIds),
    [canvas, mobile, pendingCreateIds, selfDeletedIds],
  );
  // A tab can become hidden while its state frame is in flight. Keep leases
  // that already started while visible through that brief handoff; releasing
  // them into the bounded warm pool can evict the transcript before its tile
  // acquires it. Never start a new speculative lease in a hidden pane.
  const selectedKeys = useMemo(
    () =>
      new Set(
        refs.map((ref) => sessionKeyOf([ref.instanceId, ref.hostId, ref.id])),
      ),
    [refs],
  );
  const [selection, setSelection] = useState(() => ({
    selectedKeys,
    startedWhileVisible: visible && !parked ? selectedKeys : new Set<string>(),
    visible,
    parked,
  }));
  if (
    visible !== selection.visible ||
    parked !== selection.parked ||
    !sameKeys(selectedKeys, selection.selectedKeys)
  ) {
    // Adjust the remembered leases during this render so React retries before
    // committing children; a hide must never briefly unmount an active lease.
    let startedWhileVisible: Set<string>;
    if (parked) {
      startedWhileVisible = new Set();
    } else if (visible) {
      startedWhileVisible = selectedKeys;
    } else {
      startedWhileVisible = new Set(
        [...selection.startedWhileVisible].filter((key) =>
          selectedKeys.has(key),
        ),
      );
    }
    setSelection({ selectedKeys, startedWhileVisible, visible, parked });
  }
  if (parked) {
    return null;
  }
  const eligibleRefs = refs.filter((ref) => {
    const key = sessionKeyOf([ref.instanceId, ref.hostId, ref.id]);
    return visible || selection.startedWhileVisible.has(key);
  });
  return eligibleRefs.map((ref) => (
    <ChatStreamPrewarmLease
      key={sessionKeyOf([ref.instanceId, ref.hostId, ref.id])}
      epicId={props.epicId}
      chatId={ref.id}
      hostId={ref.hostId}
      instanceId={ref.instanceId}
      snapshotLoaded={props.snapshotLoaded}
    />
  ));
}

function ChatStreamPrewarmLease(props: {
  readonly epicId: string;
  readonly chatId: string;
  readonly hostId: string;
  readonly instanceId: string;
  readonly snapshotLoaded: boolean;
}) {
  const [startedBeforeSnapshot] = useState(() => !props.snapshotLoaded);
  const [handedOff, setHandedOff] = useState(false);
  useEffect(() => {
    if (!startedBeforeSnapshot || handedOff) return;
    return subscribeChatTileSessionAcquired(
      {
        epicId: props.epicId,
        hostId: props.hostId,
        chatId: props.chatId,
        instanceId: props.instanceId,
      },
      () => setHandedOff(true),
    );
  }, [
    props.epicId,
    props.hostId,
    props.chatId,
    props.instanceId,
    startedBeforeSnapshot,
    handedOff,
  ]);
  useEffect(() => {
    if (!props.snapshotLoaded || handedOff || !startedBeforeSnapshot) return;
    // A stale/missing tile must not keep a speculative chat leased forever.
    const timer = setTimeout(() => setHandedOff(true), 30_000);
    return () => clearTimeout(timer);
  }, [props.snapshotLoaded, handedOff, startedBeforeSnapshot]);
  useChatSessionHandle(
    props.chatId,
    props.hostId,
    startedBeforeSnapshot && !handedOff,
  );
  return null;
}
