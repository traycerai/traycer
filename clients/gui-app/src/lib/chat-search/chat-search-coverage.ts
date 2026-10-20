import type { QueryClient } from "@tanstack/react-query";
import type {
  CloudChatSummary,
  ListCloudChatsResponse,
} from "@traycer/protocol/host/epic/cloud-chat";
import type { EnvironmentListResponse } from "@traycer/protocol/host/environment/contracts";
import { uniteTaskChats } from "@/lib/chats/compose-task-chat-list";
import { hostQueryKeys } from "@/lib/query-keys/host-query-keys";

/**
 * How much of what the person could be looking for one `chat.search` answer
 * covers. The host searches only the chats it holds itself, so the question
 * is which of the task's chats live somewhere else - and the client already
 * knows that from the chat lists it holds.
 *
 * - `complete` - every chat this client knows of in the task is on the
 *   searched host.
 * - `elsewhere` - `count` of them are not, so a match in one cannot appear.
 * - `unknown` - the client does not hold enough to say (every task, or a
 *   task whose lists have not answered), which reads as "this device only".
 *
 * Built from records already in hand and never by a read of its own: it
 * understates coverage whenever that evidence is incomplete.
 */
export type ChatSearchCoverage =
  | { readonly kind: "complete" }
  | { readonly kind: "elsewhere"; readonly count: number }
  | { readonly kind: "unknown" };

export interface ChatSearchCoverageInput {
  readonly searchHostId: string | null;
  readonly viewerId: string;
  /** The searched task, or `null` for every task. */
  readonly epicId: string | null;
  /** The viewer's settled chat list for the task, or `null` if none is held. */
  readonly viewerChats: readonly CloudChatSummary[] | null;
  /**
   * The environment arms for the task: `null` in a build with no server pool
   * (no arm exists); otherwise the viewer's team environments as held (`null`
   * when that list is not held) and what their settled arms carry.
   */
  readonly arms: {
    readonly teamEnvironmentIds: readonly string[] | null;
    readonly settledEnvironmentIds: ReadonlySet<string>;
    readonly chats: readonly CloudChatSummary[];
  } | null;
}

export function chatSearchCoverage(
  input: ChatSearchCoverageInput,
): ChatSearchCoverage {
  const { arms, searchHostId, viewerChats } = input;
  if (input.epicId === null || searchHostId === null || viewerChats === null) {
    return UNKNOWN;
  }
  let armChats: readonly CloudChatSummary[] = [];
  if (arms !== null) {
    if (
      arms.teamEnvironmentIds === null ||
      arms.teamEnvironmentIds.some((id) => !arms.settledEnvironmentIds.has(id))
    ) {
      return UNKNOWN;
    }
    armChats = arms.chats;
  }
  // The searched host's index holds that host's own chats of the person
  // signed in to it; anything else in the task is outside it.
  const count = uniteTaskChats(viewerChats, armChats).filter(
    (chat) =>
      chat.ownerHostId !== searchHostId ||
      chat.identity.ownerUserId !== input.viewerId,
  ).length;
  return count === 0 ? COMPLETE : { kind: "elsewhere", count };
}

const UNKNOWN: ChatSearchCoverage = { kind: "unknown" };
const COMPLETE: ChatSearchCoverage = { kind: "complete" };

const LIST_CLOUD_CHATS_METHOD = "epic.listCloudChats";
const ENVIRONMENT_LIST_METHOD = "environment.list";

function methodIndex(queryKey: readonly unknown[], method: string): number {
  if (!hostQueryKeys.matchesMethodOnAnyHost(queryKey, method)) return -1;
  return queryKey[1] === method ? 1 : 2;
}

/**
 * The viewer's settled `epic.listCloudChats` answer for `taskId`, read from
 * the query cache under whichever host carried it. Nothing is fetched.
 */
export function heldViewerTaskChats(
  queryClient: QueryClient,
  viewerId: string,
  taskId: string,
): readonly CloudChatSummary[] | null {
  for (const query of queryClient.getQueryCache().getAll()) {
    const key = query.queryKey;
    const index = methodIndex(key, LIST_CLOUD_CHATS_METHOD);
    if (index < 0 || key[index + 2] !== viewerId) continue;
    const params = key[index + 1];
    if (
      typeof params !== "object" ||
      params === null ||
      !("taskId" in params) ||
      params.taskId !== taskId
    ) {
      continue;
    }
    if (query.state.status !== "success") continue;
    const data = queryClient.getQueryData<ListCloudChatsResponse>(key);
    if (data !== undefined) return data.chats;
  }
  return null;
}

/** The viewer's team environment ids from the cached `environment.list`. */
export function heldTeamEnvironmentIds(
  queryClient: QueryClient,
  viewerId: string,
): readonly string[] | null {
  for (const query of queryClient.getQueryCache().getAll()) {
    const key = query.queryKey;
    const index = methodIndex(key, ENVIRONMENT_LIST_METHOD);
    if (index < 0 || key[index + 2] !== viewerId) continue;
    if (query.state.status !== "success") continue;
    const data = queryClient.getQueryData<EnvironmentListResponse>(key);
    if (data === undefined) continue;
    return data.environments
      .filter((environment) => environment.ownerKind === "organization")
      .map((environment) => environment.environmentId);
  }
  return null;
}
