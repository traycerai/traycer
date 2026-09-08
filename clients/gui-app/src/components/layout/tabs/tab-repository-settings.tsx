import { useState, type ReactNode } from "react";
import { TabRepositorySettingsDialog } from "./tab-repository-settings-dialog";
import { sessionCreatedEpicHostId } from "@/lib/epics/session-created-epics";
import type { HeaderTab } from "@/stores/tabs/types";

export interface TabRepositorySettings {
  /** `null` for a tab that is not an epic. */
  readonly onOpen: (() => void) | null;
  readonly dialog: ReactNode;
}

/**
 * "Repository settings…" for a header tab. Everything the dialog needs - the
 * epic's primary folder, its summary, a host client - is resolved by the
 * dialog, which mounts only once the item is chosen: this hook runs for EVERY
 * rendered tab, and a bindings + summary read per open tab would be a round
 * trip apiece for a menu item almost nobody clicks.
 */
export function useTabRepositorySettings(
  tab: HeaderTab,
): TabRepositorySettings {
  const [open, setOpen] = useState(false);
  return {
    onOpen: tab.kind === "epic" ? () => setOpen(true) : null,
    dialog:
      open && tab.kind === "epic" ? (
        <TabRepositorySettingsDialog
          epicId={tab.epicId}
          hostId={tab.hostId ?? sessionCreatedEpicHostId(tab.epicId)}
          identityPath={
            tab.repositoryIdentity?.scope?.canonicalSourceRoot ?? null
          }
          onClose={() => setOpen(false)}
        />
      ) : null,
  };
}
