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
      const finalize = () => {
        const ungrouped = tasksUngroupedByClose([tab], organization);
        if (ungrouped.length === 0) {
          finalizeCloseTab(tab);
          return;
        }
        void removeTasksFromGroups(organization, ungrouped)
          .then(() => finalizeCloseTab(tab))
          .catch(() => undefined);
      };
      if (dialog.promptOrConfirm(tab, finalize)) return;
      finalize();
    },
    [dialog, finalizeCloseTab, organization],
  );

  const closeOtherTabs = useCallback(
    (target: HeaderTab) => {
      const skipped: string[] = [];
      const layout = readTabStripLayout();
      const targetItem = findStripItemForRef(layout, {
        kind: target.kind,
        id: target.id,
      });
      if (targetItem === null) return;
      const preserved = new Set(
        flattenStripItemRefs(targetItem).map((ref) => `${ref.kind}:${ref.id}`),
      );
      const closing: HeaderTab[] = [];
      for (const other of getHeaderTabs()) {
        if (preserved.has(`${other.kind}:${other.id}`)) continue;
        if (tabRequiresCloseConfirm(other)) skipped.push(other.name);
        else closing.push(other);
      }
      // Read before the closes: once the tabs are gone the strip cannot say
      // which tasks they were.
      const ungrouped = tasksUngroupedByClose(closing, organization);
      const commit = (): void => {
        // Asked again HERE, not only when `closing` was built: the ungroup
        // is awaited in between, and a tab the user typed into during that
        // wait would otherwise be closed without the confirmation its new
        // edits have earned.
        for (const other of [...closing]) {
          if (!tabRequiresCloseConfirm(other)) continue;
          closing.splice(closing.indexOf(other), 1);
          skipped.push(other.name);
        }
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
        if (skipped.length > 0) {
          const detail =
            skipped.length === 1 ? `"${skipped[0]}"` : `${skipped.length} tabs`;
          toast.warning(`Kept ${detail} open with unsynced edits`, {
            description:
              "Close those tabs individually to discard their edits.",
          });
        }
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
      const activeWasDirty =
        active !== undefined && tabRequiresCloseConfirm(active);
      const finalize = () => {
        const held = members.filter(
          (tab) => tab !== active && tabRequiresCloseConfirm(tab),
        );
        // Closing a task's last tab takes it out of the group, so closing the
        // whole group empties it - of everything but the tabs held back.
        const ungrouped = tasksUngroupedByClose(
          members.filter((tab) => !held.includes(tab)),
          organization,
        );
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
          const stillHeld = members.filter(
            (tab) =>
              tabRequiresCloseConfirm(tab) &&
              (tab !== active || !activeWasDirty),
          );
          // Do not keep a global batch open while the dialog waits: unrelated
          // closes must stay separate. Only confirmed group closes run here.
          batchHeaderTabRecovery(() => {
            for (const tab of members) {
              if (tab === active || stillHeld.includes(tab)) continue;
              closeTab(tab);
            }
            if (
              active !== undefined &&
              !stillHeld.includes(active) &&
              getHeaderTabs().some(
                (tab) => tabRefKey(tab) === tabRefKey(active),
              )
            ) {
              // Capture the neighbor after the other group members are gone.
              finalizeCloseTab(active);
            }
          }, readTabStripLayout());
          if (stillHeld.length > 0)
            toast.warning(
              `Kept ${stillHeld.length} tabs open with unsynced edits`,
              {
                description:
                  "Close those tabs individually to discard their edits.",
              },
            );
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
