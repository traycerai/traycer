/**
 * The host-hook stubs the chat tree reads, as `vi.mock` factories. Kept apart
 * from `chat-tree-test-support` because a factory runs while the tree itself
 * is still importing, and must not import the tree back.
 */
import type { CloudChatSummary } from "@traycer/protocol/host/epic/cloud-chat";

const USER_ID = "user-1";

const EMPTY_CLOUD_LIST = { chats: [] as readonly CloudChatSummary[] };
const cloudList = { current: EMPTY_CLOUD_LIST };

/**
 * The cloud chats `useCloudChatList` answers with. The answer keeps its
 * identity between renders, as a settled query's data does.
 */
export function setCloudChats(chats: readonly CloudChatSummary[]): void {
  cloudList.current = { chats };
}

/** `vi.mock` factories for the host hooks the tree reads. */
type Importer<T> = () => Promise<T>;

export async function hostClientForHostIdMock(
  importOriginal: Importer<
    typeof import("@/hooks/host/use-host-client-for-host-id")
  >,
) {
  const actual = await importOriginal();
  return { ...actual, useHostClientForHostId: () => null };
}

export const taskHostsViewMock = {
  useTaskHostsView: () => ({ kind: "none" as const }),
};

const OWNER_PR_REFERENCES = Object.freeze({
  references: [],
  isPending: false,
  error: false,
  sendRefresh: () => undefined,
});

export const ownerPrReferencesMock = {
  useOwnerListPrReferences: () => OWNER_PR_REFERENCES,
};

export async function notificationIndicatorsMock(
  importOriginal: Importer<
    typeof import("@/hooks/notifications/use-host-notification-indicators-query")
  >,
) {
  const actual = await importOriginal();
  const { EMPTY_INDICATOR_STATE_RESPONSE } =
    await import("@/stores/notifications/notification-indicator-state");
  const frozen = {
    data: EMPTY_INDICATOR_STATE_RESPONSE,
    isPending: false,
    isFetching: false,
    error: null,
    refetch: (): Promise<void> => Promise.resolve(),
  } as const;
  return { ...actual, useHostNotificationIndicators: () => frozen };
}

export async function hostReachabilityMock(
  importOriginal: Importer<
    typeof import("@/hooks/agent/use-host-reachability")
  >,
) {
  const actual = await importOriginal();
  return {
    ...actual,
    useHostReachability: () => ({
      status: "reachable" as const,
      hostLabel: "This machine",
      unavailability: null,
      basis: "directory" as const,
      hostKind: "local" as const,
    }),
  };
}

export async function cloudChatQueriesMock(
  importOriginal: Importer<
    typeof import("@/hooks/chats/use-cloud-chat-queries")
  >,
) {
  const actual = await importOriginal();
  return {
    ...actual,
    useCloudChatList: () => ({
      data: cloudList.current,
      isError: false,
      isPending: false,
      isFetching: false,
      isSuccess: true,
      isEnabled: true,
    }),
    useCloudChatPayload: () => ({ data: undefined, isError: false }),
    useCloudChatViewerId: () => USER_ID,
  };
}

const runningAgents = { ids: [] as readonly string[] };

/** Marks these chats as having a turn in progress, as awareness would. */
export function setRunningChats(ids: readonly string[]): void {
  runningAgents.ids = ids;
}

/** The activity tiers a task's agents report, from `setRunningChats`. */
export async function epicSelectorsMock(
  importOriginal: Importer<typeof import("@/lib/epic-selectors")>,
) {
  const actual = await importOriginal();
  const tiers = (): ReadonlyMap<string, "turn" | "background"> =>
    new Map(runningAgents.ids.map((id) => [id, "turn" as const]));
  return {
    ...actual,
    useEpicAgentActivityTiers: tiers,
    useRegisteredEpicAgentActivityTiers: tiers,
  };
}
