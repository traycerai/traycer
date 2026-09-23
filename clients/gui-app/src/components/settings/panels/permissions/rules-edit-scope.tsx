/**
 * Docs: see ../../SETTINGS.md (Permissions ▸ Rules).
 * Update that file whenever this settings surface changes.
 */
import type { ReactNode } from "react";
import {
  RulesEditContext,
  useRulesEditState,
} from "@/components/settings/panels/permissions/rules-edit-context";

/**
 * Holds the Rules edit for as long as the Settings instance it wraps. Mounted
 * at the root of each Settings surface (the modal and the routed tab), above
 * the section switch, so a visit to another section - Providers, from Judge's
 * own "Open Providers" link - keeps the unsaved edit and the drafts already
 * taken, and closing Settings drops them.
 */
export function RulesEditScope(props: {
  readonly children: ReactNode;
}): ReactNode {
  const handle = useRulesEditState();
  return (
    <RulesEditContext.Provider value={handle}>
      {props.children}
    </RulesEditContext.Provider>
  );
}
