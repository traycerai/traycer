import { useState, type ReactNode } from "react";
import {
  createFallbackConflictAnnouncements,
  FallbackConflictAnnouncementsContext,
} from "@/components/settings/panels/fallback/fallback-conflict-announcements";

/**
 * Holds one panel's announcement history. Mounted beside the policy editor
 * with the editor's own `key`, so the history lives exactly as long as that
 * editor: a host switch or a reset is a new editor over a new draft, and
 * starts a new history.
 */
export function FallbackConflictAnnouncementsProvider(props: {
  readonly children: ReactNode;
}): ReactNode {
  const [announcements] = useState(createFallbackConflictAnnouncements);
  return (
    <FallbackConflictAnnouncementsContext.Provider value={announcements}>
      {props.children}
    </FallbackConflictAnnouncementsContext.Provider>
  );
}
