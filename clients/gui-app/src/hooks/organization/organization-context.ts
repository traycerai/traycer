import { cloudVerdictPreflight } from "@/lib/host/cloud-verdict-preflight";
import { useAuthStore } from "@/stores/auth/auth-store";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@traycer/protocol/host/index";
import { createContext, use, useEffect, useId, useMemo } from "react";
import type { StoreApi } from "zustand";
import { useStoreWithEqualityFn } from "zustand/traditional";
import type {
  OrganizationAction,
  OrganizationView,
} from "@traycer/protocol/host/organization/contracts";
import type { TaskOrganization } from "@traycer/protocol/host/organization/schemas";
import type { OrganizationDialog } from "@/components/organization/organization-dialogs";
export interface OrganizationContextValue {
  readonly client: HostClient<HostRpcRegistry>;
  readonly supported: boolean;
  /**
   * Whether this host advertised `organization.command` at its last
   * handshake, with `null` for "no handshake yet".
   *
   * Separate from {@link supported}, which also folds in the account's cloud
   * authorization and identity. Only a positive `false` means the host is too
   * old to organize tasks; `null` is a transient unknown, and offering an
   * update on it would name a problem the user does not have.
   */
  readonly hostSupport: boolean | null;
  readonly userId: string | null;
  /**
   * The host's projection for this host and account, from cache when the
   * subscription is between frames. It is deliberately NOT cleared while
   * {@link supported} is false: a readiness or authorization flap must not
   * empty a menu whose groups are still this account's. Use `supported` to
   * decide whether an edit may be sent, never to decide what to show.
   *
   * Read here, in a handler, and never in render: a render reads its own
   * slice through {@link useOrganizationView}. The view is not part of this
   * value because every frame replaces it, and a frame that moved only the
   * History token or another task's metadata must not re-render a consumer
   * whose slice it left alone.
   */
  readonly readView: () => OrganizationView | undefined;
  /** Calls `listener` after each new view; returns the unsubscribe. */
  readonly subscribeView: (listener: () => void) => () => void;
  readonly register: (key: string, taskIds: readonly string[]) => () => void;
  readonly openDialog: (dialog: OrganizationDialog) => void;
  /**
   * Sends one edit. An appearance edit is drawn in {@link view} at once and
   * sent one at a time per task: one made while another is out waits for it,
   * and the promise settles with the command that carried it.
   */
  readonly command: (action: OrganizationAction) => Promise<void>;
  readonly refresh: () => Promise<void>;
}
export const OrganizationContext =
  createContext<OrganizationContextValue | null>(null);
const EMPTY_IDS: readonly string[] = [];

export function useOrganization() {
  return use(OrganizationContext);
}
export function useOrganizationTasks(taskIds: readonly string[]) {
  const organization = useOrganization();
  const register = organization?.register;
  const id = useId();
  const identity = [...new Set(taskIds)].sort().join(",");
  useEffect(
    () => register?.(id, identity ? identity.split(",") : EMPTY_IDS),
    [register, id, identity],
  );
  return organization;
}

const NO_VIEW_SOURCE: Pick<
  OrganizationContextValue,
  "readView" | "subscribeView"
> = {
  readView: () => undefined,
  subscribeView: () => () => undefined,
};

/**
 * The part of the organization view `select` picks, re-rendering only when
 * `isEqual` says the picked value changed. The host replaces the whole view
 * on every frame, so `isEqual` is what keeps a frame that left this slice
 * alone from reaching the component.
 */
export function useOrganizationView<T>(
  select: (view: OrganizationView | undefined) => T,
  isEqual: (a: T, b: T) => boolean,
): T {
  const source = useOrganization() ?? NO_VIEW_SOURCE;
  const store = useMemo(
    (): Pick<
      StoreApi<OrganizationView | undefined>,
      "getState" | "getInitialState" | "subscribe"
    > => ({
      getState: source.readView,
      getInitialState: source.readView,
      subscribe: (listener) => {
        let previous = source.readView();
        return source.subscribeView(() => {
          const next = source.readView();
          listener(next, previous);
          previous = next;
        });
      },
    }),
    [source],
  );
  return useStoreWithEqualityFn(store, select, isEqual);
}

/** One task's organization, re-rendering only when that task's own changes. */
export function useTaskOrganization(
  taskId: string,
  fallback: TaskOrganization | undefined,
): TaskOrganization | undefined {
  return useOrganizationView(
    (view) => taskOrganization(view, taskId, fallback),
    sameTaskOrganization,
  );
}

function sameTaskOrganization(
  a: TaskOrganization | undefined,
  b: TaskOrganization | undefined,
): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  return (
    a.group === b.group &&
    (a.labels === b.labels ||
      (a.labels.length === 0 && b.labels.length === 0)) &&
    (a.appearance === b.appearance ||
      (a.appearance.taskId === b.appearance.taskId &&
        a.appearance.version === b.appearance.version &&
        a.appearance.color === b.appearance.color &&
        a.appearance.icon === b.appearance.icon))
  );
}

/** The parts of a view {@link taskOrganization} reads. */
export type OrganizationTaskSlices = Pick<
  OrganizationView,
  "groups" | "appearances" | "taskLabels"
>;

function selectTaskSlices(
  view: OrganizationView | undefined,
): OrganizationTaskSlices | undefined {
  if (view === undefined) return undefined;
  return {
    groups: view.groups,
    appearances: view.appearances,
    taskLabels: view.taskLabels,
  };
}

function sameTaskSlices(
  a: OrganizationTaskSlices | undefined,
  b: OrganizationTaskSlices | undefined,
): boolean {
  if (a === undefined || b === undefined) return a === b;
  return (
    a.groups === b.groups &&
    a.appearances === b.appearances &&
    a.taskLabels === b.taskLabels
  );
}

/**
 * Every task's groups, appearance and labels, for a list that draws many
 * tasks. A frame that moved only the History token, the catalog or the
 * pending queue leaves all three untouched (the view cache shares unchanged
 * structure across frames), so it does not reach the list.
 */
export function useOrganizationTaskSlices():
  | OrganizationTaskSlices
  | undefined {
  return useOrganizationView(selectTaskSlices, sameTaskSlices);
}

export function taskOrganization(
  view: OrganizationTaskSlices | undefined,
  taskId: string,
  fallback: TaskOrganization | undefined,
): TaskOrganization | undefined {
  if (view === undefined) return fallback;
  const groupId = view.groups.memberships.find(
    (m) => m.taskId === taskId,
  )?.groupId;
  const group = view.groups.groups.find((g) => g.groupId === groupId) ?? null;
  const appearance =
    view.appearances.find((a) => a.taskId === taskId) ?? fallback?.appearance;
  const labels =
    (Object.hasOwn(view.taskLabels, taskId)
      ? view.taskLabels[taskId]?.labels
      : undefined) ?? fallback?.labels;
  if (appearance === undefined && labels === undefined && group === null)
    return fallback;
  return {
    group,
    appearance: appearance ?? { taskId, version: "0", color: null, icon: null },
    labels: labels ?? [],
  };
}

export function organizationPreflight(
  client: HostClient<HostRpcRegistry> | null,
  userId: string | null,
  method:
    | "organization.command"
    | "organization.refresh"
    | "organization.history",
): () => void {
  return () => {
    cloudVerdictPreflight(method)();
    if (
      userId === null ||
      client?.getRequestContextUserId() !== userId ||
      useAuthStore.getState().contextMetadata?.userId !== userId
    )
      throw new Error(
        "Organization account changed. Reopen this control to try again.",
      );
  };
}
