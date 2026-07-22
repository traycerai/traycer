import { useEffect, useMemo, type ReactNode } from "react";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { useShallow } from "zustand/react/shallow";
import { usePhaseMigrateToEpic } from "@/hooks/migration/use-phase-migrate-to-epic-mutation";
import {
  activateTabIntent,
  existingEpicTabIntentWithNestedFocus,
} from "@/lib/tab-navigation";
import { parseNestedFocusTargetFromSearch } from "@/lib/epic-nested-focus-route";
import { normalizeEpicFocusSearch } from "@/routes/epic-route-search";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { selectHostFocusedRef } from "@/stores/tabs/selectors";
import { useTabsStore } from "@/stores/tabs/store";
import { phaseMigrationController } from "./phase-migration-controller";

interface PhaseMigrationRunnerProps {
  readonly tabId: string;
  readonly phaseId: string;
}

/**
 * Owns every live migration runner independently from the five-surface LRU.
 * A slot can disappear or be evicted without affecting its exact mutation.
 */
export function PhaseMigrationControllerHost(): ReactNode {
  const { openTabOrder, tabsById } = useEpicCanvasStore(
    useShallow((state) => ({
      openTabOrder: state.openTabOrder,
      tabsById: state.tabsById,
    })),
  );
  const phaseTabs = useMemo(
    () =>
      openTabOrder.flatMap((tabId) => {
        const tab = tabsById[tabId];
        return tab?.surfaceMode?.kind === "phase-migration"
          ? [{ tabId, phaseId: tab.surfaceMode.phaseId }]
          : [];
      }),
    [openTabOrder, tabsById],
  );

  return (
    <>
      {phaseTabs.map((tab) => (
        <PhaseMigrationRunner
          key={tab.tabId}
          phaseId={tab.phaseId}
          tabId={tab.tabId}
        />
      ))}
      {phaseTabs.length > 0 ? <PhaseMigrationRouteBridge /> : null}
    </>
  );
}

function PhaseMigrationRunner(props: PhaseMigrationRunnerProps): ReactNode {
  const { mutate } = usePhaseMigrateToEpic(props.phaseId);

  useEffect(
    () =>
      phaseMigrationController.attach(
        props.tabId,
        props.phaseId,
        (attemptId) => {
          mutate(
            { phaseId: props.phaseId },
            {
              onError: (error) =>
                phaseMigrationController.fail(
                  props.tabId,
                  props.phaseId,
                  attemptId,
                  error.message,
                ),
              onSuccess: (data) =>
                phaseMigrationController.succeed(
                  props.tabId,
                  props.phaseId,
                  attemptId,
                  data.epicId,
                ),
            },
          );
        },
      ),
    [mutate, props.phaseId, props.tabId],
  );

  return null;
}

function PhaseMigrationRouteBridge(): ReactNode {
  const navigate = useNavigate();
  const location = useRouterState({ select: (state) => state.location });

  useEffect(
    () =>
      phaseMigrationController.subscribeCompletion((completion) => {
        const focused = selectHostFocusedRef(useTabsStore.getState());
        if (focused?.kind !== "epic" || focused.id !== completion.tabId) {
          return;
        }
        const search = normalizeEpicFocusSearch(location.search);
        activateTabIntent(
          navigate,
          existingEpicTabIntentWithNestedFocus({
            epicId: completion.epicId,
            tabId: completion.tabId,
            focus: { ...search, migrationSource: undefined },
            nestedFocus: parseNestedFocusTargetFromSearch(location.search),
          }),
          { replace: true },
        );
      }),
    [location.search, navigate],
  );

  return null;
}
