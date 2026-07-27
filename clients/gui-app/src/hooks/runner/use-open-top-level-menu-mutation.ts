import { use } from "react";
import { useMutation, type UseMutationResult } from "@tanstack/react-query";
import { RunnerHostContext } from "@/providers/runner-host-context";
import { runnerMutationKeys } from "@/lib/query-keys";
import { toastFromRunnerError } from "@/lib/runner-error-toast";
import { resolveDesktopMenuPopupBridge } from "@/lib/windows/desktop-capabilities";
import type { DesktopTopLevelMenuId } from "@/lib/windows/types";

export interface OpenTopLevelMenuVariables {
  readonly menuId: DesktopTopLevelMenuId;
  readonly anchorX: number;
  readonly anchorY: number;
}

/**
 * Asks the desktop shell to pop up a native top-level submenu beneath the
 * Windows frameless title-bar menu strip. The mutation owns the query key and
 * the standard runner-error mapping so the menu bar never dispatches the popup
 * IPC or handles its failures ad hoc. A no-op off the desktop shell (no popup
 * bridge) rather than a surfaced error, since the strip only renders when the
 * bridge is present.
 */
export function useRunnerOpenTopLevelMenuMutation(): UseMutationResult<
  void,
  Error,
  OpenTopLevelMenuVariables
> {
  const runnerHost = use(RunnerHostContext);
  return useMutation<void, Error, OpenTopLevelMenuVariables>({
    mutationKey: runnerMutationKeys.openTopLevelMenu(),
    mutationFn: async ({ menuId, anchorX, anchorY }) => {
      const menu =
        runnerHost === null ? null : resolveDesktopMenuPopupBridge(runnerHost);
      if (menu === null) return;
      await menu.openTopLevel(menuId, anchorX, anchorY);
    },
    onError: (error) =>
      toastFromRunnerError(error, "Couldn't open the application menu"),
  });
}
