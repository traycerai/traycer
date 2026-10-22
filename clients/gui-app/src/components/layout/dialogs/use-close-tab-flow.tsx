import {
  useOrganization,
  type OrganizationContextValue,
} from "@/hooks/organization/organization-context";
import { batchHeaderTabRecovery } from "@/lib/tab-recovery/history";
import { useCallback, useMemo, type ReactNode } from "react";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { toast } from "sonner";
import { navigateToTabIntent } from "@/lib/tab-navigation";
import { readTabStripLayout } from "@/stores/tabs/store";
import {
  findStripItemForRef,
  flattenStripItemRefs,
  tabRefKey,
} from "@/stores/tabs/layout";
import { getHeaderTabs } from "@/stores/tabs/use-header-tabs";
import {
  tabMatchesPath,
  tabResolveIntent,
  tabRequiresCloseConfirm,
} from "@/stores/tabs/registry";
import type { HeaderTab } from "@/stores/tabs/types";
import { useTabCloseCommand } from "@/components/layout/tabs/use-tab-close-command";
import { useNeighborTabPicker } from "@/components/layout/tabs/use-neighbor-tab-picker";
import { useUnsyncedCloseDialog } from "@/components/layout/dialogs/use-unsynced-close-dialog";
import { Analytics, AnalyticsEvent } from "@/lib/analytics";
import { useWindowsBridge } from "@/providers/windows-bridge-context";
import { useLandingDraftStore } from "@/stores/home/landing-draft-store";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { isEmptyLandingDraftContent } from "@/lib/composer/landing-draft-empty";

export interface CloseTabFlow {
  readonly requestCloseTab: (tab: HeaderTab) => void;
  readonly closeOtherTabs: (tab: HeaderTab) => void;
  readonly closeActiveTab: () => void;
  readonly closeGroup: (groupId: string) => void;
  readonly unsyncedDialog: ReactNode;
}

export function useCloseTabFlow(): CloseTabFlow {
  const navigate = useNavigate();
  const organization = useOrganization();
  const closeTab = useTabCloseCommand();
  const picker = useNeighborTabPicker();
  const dialog = useUnsyncedCloseDialog();
  const windowsBridge = useWindowsBridge();
  const activePathname = useRouterState({
    select: (s) => s.location.pathname,
  });

  const finalizeCloseTab = useCallback(
    (tab: HeaderTab) => {
      if (windowsBridge !== null && isOnlyBlankStartPage(tab)) {
        void windowsBridge.requestClose(windowsBridge.windowId);
        return;
      }
      const captured = picker.capture(tab);
      closeTab(tab);
      if (tab.kind === "epic") {
        Analytics.getInstance().track(AnalyticsEvent.TabClosed, {
          target: "task",
        });
      }
      picker.navigateToCaptured(captured);
    },
    [closeTab, picker, windowsBridge],
  );

  const requestCloseTab = useCallback(
    (tab: HeaderTab) => {
      // Read before the prompt, because the prompt is what turns a dirty tab
      // into a confirmed one.
      const confirmed = tabRequiresCloseConfirm(tab)
        ? new Set([tabRefKey(tab)])
        : new Set<string>();
      const finalize = () => {
        if (splitByUnsyncedEdits([tab], confirmed).held.length > 0) {
          warnAboutHeldTabs([tab], false);
          return;
        }
        const ungrouped = tasksUngroupedByClose([tab], organization);
        if (ungrouped.length === 0) {
          finalizeCloseTab(tab);
          return;
        }
        void removeTasksFromGroups(organization, ungrouped)
          .then(() => {
            const { held } = splitByUnsyncedEdits([tab], confirmed);
            if (held.length > 0) {
              warnAboutHeldTabs(held, true);
              return;
            }
            finalizeCloseTab(tab);
          })
          .catch(() => undefined);
      };
      if (dialog.promptOrConfirm(tab, finalize)) return;
      finalize();
    },
    [dialog, finalizeCloseTab, organization],
  );

  const closeOtherTabs = useCallback(
    (target: HeaderTab) => {
      const skipped: HeaderTab[] = [];
      const layout = readTabStripLayout();
      const targetItem = findStripItemForRef(layout, {
        kind: target.kind,
        id: target.id,
      });
      if (targetItem === null) return;
      const preserved = new Set(
        flattenStripItemRefs(targetItem).map((ref) => `${ref.kind}:${ref.id}`),
      );
      const candidates = getHeaderTabs().filter(
        (other) => !preserved.has(`${other.kind}:${other.id}`),
      );
      // Nothing here is ever prompted, so nothing here is ever confirmed.
      const confirmed = new Set<string>();
      const first = splitByUnsyncedEdits(candidates, confirmed);
      skipped.push(...first.held);
      // Read before the closes: once the tabs are gone the strip cannot say
      // which tasks they were. Read from the tabs that will ACTUALLY close,
      // so a tab already holding edits produces no removal at all.
      const ungrouped = tasksUngroupedByClose(first.closing, organization);
      const commit = (): void => {
        const { closing, held } = splitByUnsyncedEdits(
          first.closing,
          confirmed,
        );
        batchHeaderTabRecovery(() => {
          for (const other of closing) {
            closeTab(other);
            if (other.kind === "epic") {
              Analytics.getInstance().track(AnalyticsEvent.TabClosed, {
                target: "task",
              });
            }
          }
        }, layout);
        warnAboutHeldTabs(skipped, false);
        // Separate, because the reason differs: these lost their group
        // before their edits appeared.
        warnAboutHeldTabs(held, ungrouped.length > 0);
        navigateToTabIntent(navigate, tabResolveIntent(target), undefined);
      };
      // The ungroup is accepted before anything closes, exactly as it is for
      // a single tab: a refused removal would otherwise leave the account
      // holding memberships whose tabs are gone, and reopening one of them
      // would bring its siblings back with it.
      if (ungrouped.length === 0) {
        commit();
        return;
      }
      void removeTasksFromGroups(organization, ungrouped)
        .then(commit)
        .catch(() => undefined);
    },
    [closeTab, navigate, organization],
  );

  const closeGroup = useCallback(
    (groupId: string) => {
      const layout = readTabStripLayout();
      const members = getHeaderTabs().filter(
        (tab) => layout.customizations?.[tabRefKey(tab)]?.groupId === groupId,
      );
      const active = members.find((tab) => tabMatchesPath(tab, activePathname));
      // Read BEFORE the prompt below, because the prompt is what turns a
      // dirty active tab into a confirmed one. A tab that is clean here was
      // never asked about, so edits it gains later have been confirmed by
      // nobody.
      const confirmed =
        active !== undefined && tabRequiresCloseConfirm(active)
          ? new Set([tabRefKey(active)])
          : new Set<string>();
      const finalize = () => {
        const first = splitByUnsyncedEdits(members, confirmed);
        // Closing a task's last tab takes it out of the group, so closing the
        // whole group empties it - of everything but the tabs held back.
        const ungrouped = tasksUngroupedByClose(first.closing, organization);
        const commit = (): void => {
          // Asked again after the awaited ungroup, for the reason the single
          // and the other bulk path share: edits made while that request was
          // out must hold their tab back too.
          //
          // The active tab is in that too, but only when it was CLEAN at the
          // gesture - a dirty one was prompted and the user chose to discard,
          // and refusing that close would override an answer they gave. A
          // clean one was never asked, so edits it gained while the ungroup
          // was out are nobody's decision to discard.
          const { closing, held } = splitByUnsyncedEdits(
            first.closing,
            confirmed,
          );
          // Do not keep a global batch open while the dialog waits: unrelated
          // closes must stay separate. Only confirmed group closes run here.
          batchHeaderTabRecovery(() => {
            for (const tab of closing) {
              if (tab === active) continue;
              closeTab(tab);
            }
            if (
              active !== undefined &&
              closing.includes(active) &&
              getHeaderTabs().some(
                (tab) => tabRefKey(tab) === tabRefKey(active),
              )
            ) {
              // Capture the neighbor after the other group members are gone.
              finalizeCloseTab(active);
            }
          }, readTabStripLayout());
          warnAboutHeldTabs(first.held, false);
          warnAboutHeldTabs(held, ungrouped.length > 0);
        };
        if (ungrouped.length === 0) {
          commit();
          return;
        }
        void removeTasksFromGroups(organization, ungrouped)
          .then(commit)
          .catch(() => undefined);
      };
      if (active !== undefined && dialog.promptOrConfirm(active, finalize))
        return;
      finalize();
    },
    [activePathname, closeTab, dialog, finalizeCloseTab, organization],
  );

  const closeActiveTab = useCallback(() => {
    // Deliberately keyed off the route, NOT `selectHostFocusedRef`. A split
    // only moves `routeBackingSide` onto the focused side when that side holds
    // a tab, so focusing the fillable half leaves the two diverged and the
    // focused ref reading `null` - which is exactly where `createEmptySplit`
    // starts ("Add tab to new split view" focuses the empty side). Gating on
    // the focused ref made Cmd+W silently do nothing there. Whenever the
    // focused side does hold a tab the two agree, so the route-backed tab is
    // the right target in both cases.
    const active = getHeaderTabs().find((t) =>
      tabMatchesPath(t, activePathname),
    );
    if (active !== undefined) requestCloseTab(active);
  }, [activePathname, requestCloseTab]);

  // Stable identity: consumers list the whole flow in `useCallback` /
  // `useEffect` deps. A fresh object literal per render gave every derived
  // handler a new identity, which defeated the memoized strip items and
  // re-registered the split action handlers on each render.
  return useMemo(
    () => ({
      requestCloseTab,
      closeOtherTabs,
      closeActiveTab,
      closeGroup,
      unsyncedDialog: dialog.dialog,
    }),
    [
      closeActiveTab,
      closeGroup,
      closeOtherTabs,
      dialog.dialog,
      requestCloseTab,
    ],
  );
}

/**
 * Splits a close into the tabs it may take and the tabs their own unsynced
 * edits hold back.
 *
 * Asked TWICE on every path, which is the whole of the rule. Once before the
 * membership removal is computed, so a tab already carrying edits produces
 * no removal at all. Once again at the close, because the removal is awaited
 * in between and a tab typed into during that wait has edits nobody agreed
 * to discard.
 *
 * `confirmed` is the tabs that were already dirty when the gesture began and
 * whose discard the user then confirmed. They are never held: refusing those
 * would overrule the answer they just gave. A tab that was CLEAN at the
 * gesture was never asked about, so edits it gains later belong to no
 * answer at all - which is the case the single and group paths each missed,
 * in their own way, before this was one rule.
 */
function splitByUnsyncedEdits(
  tabs: readonly HeaderTab[],
  confirmed: ReadonlySet<string>,
): { readonly closing: HeaderTab[]; readonly held: HeaderTab[] } {
  const closing: HeaderTab[] = [];
  const held: HeaderTab[] = [];
  for (const tab of tabs) {
    if (confirmed.has(tabRefKey(tab)) || !tabRequiresCloseConfirm(tab))
      closing.push(tab);
    else held.push(tab);
  }
  return { closing, held };
}

/**
 * What the user is told about tabs kept open.
 *
 * `afterRemoval` says a removal went out for this close, not that it named
 * every held tab: it is one answer for the whole batch, and the held set is
 * whichever tabs gained edits during the wait. So the copy speaks of some
 * tasks rather than theirs. This host is not putting any of them back -
 * guessing at that could undo a move made in the meantime - and it claims
 * nothing about the cloud beyond the removal having been accepted.
 */
function warnAboutHeldTabs(
  held: readonly HeaderTab[],
  afterRemoval: boolean,
): void {
  if (held.length === 0) return;
  const detail =
    held.length === 1 ? `"${held[0]?.name ?? ""}"` : `${held.length} tabs`;
  toast.warning(`Kept ${detail} open with unsynced edits`, {
    description: afterRemoval
      ? "Some tasks were taken out of their groups during this close. Add them back if you still want them grouped."
      : "Close those tabs individually to discard their edits.",
  });
}

/**
 * The tasks this close takes out of their group.
 *
 * Closing a task's last open tab ungroups it - that is what a group means on
 * the strip - so every close path answers the question the same way, and a
 * task with another tab still open keeps its membership whichever path runs.
 * Read before the tabs are closed: afterwards the strip cannot say which
 * tasks they were.
 */
function tasksUngroupedByClose(
  closing: readonly HeaderTab[],
  organization: OrganizationContextValue | null,
): string[] {
  const memberships = organization?.view?.groups.memberships ?? [];
  if (memberships.length === 0) return [];
  const canvas = useEpicCanvasStore.getState();
  const closingTabIds = new Set(
    closing.flatMap((tab) => (tab.kind === "epic" ? [tab.id] : [])),
  );
  if (closingTabIds.size === 0) return [];
  const taskOf = (tabId: string): string | undefined =>
    canvas.tabsById[tabId]?.epicId;
  const stillOpen = new Set(
    canvas.openTabOrder
      .filter((tabId) => !closingTabIds.has(tabId))
      .flatMap((tabId) => {
        const epicId = taskOf(tabId);
        return epicId === undefined ? [] : [epicId];
      }),
  );
  return [
    ...new Set(
      [...closingTabIds].flatMap((tabId) => {
        const epicId = taskOf(tabId);
        return epicId === undefined || stillOpen.has(epicId) ? [] : [epicId];
      }),
    ),
  ].filter((taskId) => memberships.some((member) => member.taskId === taskId));
}

/**
 * Takes the tasks out of their groups. The rejection is NOT swallowed here:
 * an individual close waits for this and must not close the tab when the
 * membership could not be removed, which would lose the group it was in.
 *
 * An account that cannot take edits at all is refused before anything is
 * sent. Closing anyway would leave the account believing the task is still
 * grouped, and sending anyway would wait out a request the preflight is
 * certain to reject - so the close is held and SAYS why, rather than
 * borrowing the command's own "couldn't save" toast for a command that was
 * never attempted.
 */
function removeTasksFromGroups(
  organization: OrganizationContextValue | null,
  taskIds: readonly string[],
): Promise<void> {
  if (organization === null || taskIds.length === 0) return Promise.resolve();
  if (!organization.supported) {
    toast.error("This tab can't be closed right now", {
      description:
        "Closing it takes the task out of its group, and your account's organization can't be reached from this device yet.",
    });
    return Promise.reject(
      new Error("Organization edits are unavailable on this device."),
    );
  }
  return organization.command({
    kind: "groups",
    operations: taskIds.map((taskId) => ({
      operation: "removeTask",
      taskId,
    })),
  });
}

function isOnlyBlankStartPage(tab: HeaderTab): boolean {
  if (tab.kind !== "draft") return false;
  const tabs = getHeaderTabs();
  if (tabs.length !== 1 || tabs[0]?.kind !== "draft" || tabs[0].id !== tab.id) {
    return false;
  }
  const draft = useLandingDraftStore
    .getState()
    .drafts.find((candidate) => candidate.id === tab.id);
  return draft !== undefined && isEmptyLandingDraftContent(draft.content);
}
