import { useCallback } from "react";
import {
  sandboxConfigurationOf,
  useSandboxConfigurations,
} from "@/hooks/sandboxes/use-sandbox-configurations";
import { useSandboxList } from "@/hooks/sandboxes/use-sandbox-list-query";
import { useSystemTabModalActions } from "@/stores/tabs/use-system-tab-modal";
import {
  revealSandboxOnPage,
  type SandboxesPageConfigurationId,
} from "@/stores/sandboxes/sandboxes-page-store";

/**
 * Opens Settings › Sandboxes with one row revealed despite any filter: on the
 * configuration the row belongs to, read from the sandbox list (a push
 * carries only its entry key), or on Personal once the row has left the list.
 */
export function useOpenSandboxesPage(): (sandboxId: string) => void {
  const list = useSandboxList();
  const { configurations } = useSandboxConfigurations();
  const { openSettings } = useSystemTabModalActions();
  const rows = list.data?.sandboxes ?? null;
  return useCallback(
    (sandboxId: string) => {
      const row = rows?.find((summary) => summary.id === sandboxId) ?? null;
      const configuration =
        row === null ? null : sandboxConfigurationOf(row, configurations);
      const target: SandboxesPageConfigurationId =
        configuration?.kind === "team"
          ? { kind: "team", teamId: configuration.teamId }
          : { kind: "personal" };
      revealSandboxOnPage(target, sandboxId);
      openSettings({
        section: "sandboxes",
        resetToGeneral: false,
        tab: null,
        draft: null,
        hostId: null,
      });
    },
    [rows, configurations, openSettings],
  );
}
