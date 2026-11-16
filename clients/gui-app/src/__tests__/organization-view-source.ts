import type { OrganizationView } from "@traycer/protocol/host/organization/contracts";
import type { TaskOrganization } from "@traycer/protocol/host/organization/schemas";
import type { OrganizationTaskSlices } from "@/hooks/organization/organization-context";

/** A small external-store source for component tests that supply an organization view. */
export function organizationViewSource(
  initialView: OrganizationView | undefined,
) {
  let currentView = initialView;
  const listeners = new Set<() => void>();

  return {
    readView: () => currentView,
    subscribeView: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    publish: (view: OrganizationView | undefined) => {
      currentView = view;
      for (const listener of listeners) listener();
    },
  };
}

/** Hook substitutes for a test that stubs useOrganization without mounting its provider. */
export function organizationViewHookOverrides(
  readView: () => OrganizationView | undefined,
  selectTaskOrganization: (
    view: OrganizationView | undefined,
    taskId: string,
    fallback: TaskOrganization | undefined,
  ) => TaskOrganization | undefined,
) {
  return {
    useOrganizationView: <T>(
      select: (view: OrganizationView | undefined) => T,
      _isEqual: (a: T, b: T) => boolean,
    ): T => select(readView()),
    useTaskOrganization: (
      taskId: string,
      fallback: TaskOrganization | undefined,
    ) => selectTaskOrganization(readView(), taskId, fallback),
    useOrganizationTaskSlices: (): OrganizationTaskSlices | undefined => {
      const view = readView();
      return view === undefined
        ? undefined
        : {
            groups: view.groups,
            appearances: view.appearances,
            taskLabels: view.taskLabels,
          };
    },
  };
}
