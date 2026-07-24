import { use, useMemo, type ReactNode } from "react";
import type { OpenEpicState } from "@/stores/epics/open-epic/store";
import { useEpicStore } from "@/hooks/use-epic-store";
import { useReactiveActiveHostId } from "@/hooks/host/use-reactive-active-host-id";
import { useHostClientForHostId } from "@/hooks/host/use-host-client-for-host-id";
import {
  useEpicChatWorktreeMetadataForHost,
  type ChatRowWorktreeMetadata,
} from "@/hooks/worktree/use-epic-chat-worktree-metadata";
import { ChatRowWorktreeMetadataContext } from "@/components/epic-canvas/sidebar/chat-row-worktree-metadata-context";

const HOST_ID_SEPARATOR = "\u0000";
const EMPTY_HOST_IDS: readonly string[] = [];

/**
 * Mounts the row-2 worktree/PR batch ONCE for the sidebar's agent tree and
 * publishes it to every row through context.
 *
 * **Per-host, because rows span hosts.** A chat tab is bound to a host for
 * life, so one epic's rows can live on several. The visible rows are grouped by
 * their bound host id and each distinct host gets its own two-call batch: N
 * rows on one host still cost two RPCs, and a second host costs two more, never
 * two per row.
 *
 * **Why nested layers rather than a loop.** One host is one set of query hooks,
 * and hooks can't run in a loop over a dynamic list. Each host therefore gets
 * its own component, and the layers nest - each merging its host's owners into
 * the map it inherits - so the leaf tree reads a single flat `ownerId` map with
 * no idea how many hosts produced it. Owner ids are uuids, so merging can't
 * collide. The alternative (lifting per-host results into parent state) would
 * need an effect per host to sync a render-derived value, which is exactly the
 * pattern this workspace avoids.
 *
 * **Degradation is silence.** An unreachable or unknown host resolves to a null
 * client, its queries stay disabled, its owners never enter the map, and those
 * rows collapse to a single line. No error surface reaches a row.
 *
 * The one cost of the nesting: changing the host SET changes the tree depth, so
 * the rows below remount. That happens only when a row for a not-yet-seen host
 * appears (a chat created on a second host), never on data churn - and sidebar
 * expansion and selection both live in external stores, so a remount restores
 * them rather than resetting them.
 */
export function EpicChatWorktreeMetadataProvider(props: {
  readonly epicId: string;
  readonly children: ReactNode;
}): ReactNode {
  // A legacy chat (pre-`hostId`) and the optimistic create overlay both project
  // `hostId: null`, where the active host is the implied host - the same
  // resolution `useEpicArtifactRecords` applies to those rows. Grouping them
  // there costs nothing (the default host is almost always already in the set)
  // and is strictly better than skipping them: right answer when they did run
  // there, and the same collapsed row when they did not.
  const fallbackHostId = useReactiveActiveHostId();
  // Selected as a joined STRING, not an array: a primitive gives `Object.is`
  // stability straight from the store, so the layer chain below is rebuilt only
  // when the host set genuinely changes rather than on every projection tick.
  const hostIdsKey = useEpicStore((state) =>
    agentRowHostIds(state, fallbackHostId).join(HOST_ID_SEPARATOR),
  );
  const hostIds = useMemo(
    () =>
      hostIdsKey === "" ? EMPTY_HOST_IDS : hostIdsKey.split(HOST_ID_SEPARATOR),
    [hostIdsKey],
  );
  return hostIds.reduceRight<ReactNode>(
    (inner, hostId) => (
      <HostChatWorktreeMetadataLayer epicId={props.epicId} hostId={hostId}>
        {inner}
      </HostChatWorktreeMetadataLayer>
    ),
    props.children,
  );
}

/**
 * Distinct host ids across the epic's chat and terminal-agent rows, sorted so
 * the derived key (and therefore the layer chain) is order-independent.
 */
function agentRowHostIds(
  state: OpenEpicState,
  fallbackHostId: string | null,
): readonly string[] {
  const hostIds = new Set<string>();
  for (const id of state.chats.allIds) {
    if (!Object.hasOwn(state.chats.byId, id)) continue;
    const hostId = state.chats.byId[id].hostId ?? fallbackHostId;
    if (hostId !== null) hostIds.add(hostId);
  }
  for (const id of state.tuiAgents.allIds) {
    if (!Object.hasOwn(state.tuiAgents.byId, id)) continue;
    hostIds.add(state.tuiAgents.byId[id].hostId);
  }
  return [...hostIds].sort();
}

function HostChatWorktreeMetadataLayer(props: {
  readonly epicId: string;
  readonly hostId: string;
  readonly children: ReactNode;
}): ReactNode {
  const inherited = use(ChatRowWorktreeMetadataContext);
  const client = useHostClientForHostId(props.hostId);
  const metadata = useEpicChatWorktreeMetadataForHost({
    client,
    epicId: props.epicId,
    enabled: client !== null,
  });
  const merged = useMemo(
    () => mergeOwnerMetadata(inherited, metadata),
    [inherited, metadata],
  );
  return (
    <ChatRowWorktreeMetadataContext.Provider value={merged}>
      {props.children}
    </ChatRowWorktreeMetadataContext.Provider>
  );
}

// Returns the inherited map untouched when this host contributed nothing, so a
// single-host tree (the common case) publishes ONE map identity for the whole
// chain and rows never re-render for a neighbouring host's fetch.
function mergeOwnerMetadata(
  inherited: ReadonlyMap<string, ChatRowWorktreeMetadata>,
  addition: ReadonlyMap<string, ChatRowWorktreeMetadata>,
): ReadonlyMap<string, ChatRowWorktreeMetadata> {
  if (addition.size === 0) return inherited;
  if (inherited.size === 0) return addition;
  return new Map([...inherited, ...addition]);
}
