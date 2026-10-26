import { useCallback } from "react";
import { usePreviewFeature } from "@/hooks/auth/use-preview-feature";
import {
  settingsSectionPreviewFeature,
  type SettingsSectionId,
} from "@/lib/settings-sections";

/**
 * Whether a section this build offers is offered to this person too: one
 * whose page needs a preview feature only while that feature is on. Unread
 * offers it to no one: a row or a page appears when the read lands on.
 */
export function useSettingsSectionOffered(): (
  sectionId: SettingsSectionId,
) => boolean {
  const environments = usePreviewFeature("environments");
  const sandboxes = usePreviewFeature("sandboxes");
  const bots = usePreviewFeature("bots");
  return useCallback(
    (sectionId) => {
      const feature = settingsSectionPreviewFeature(sectionId);
      if (feature === null) return true;
      const states = { environments, sandboxes, bots };
      return states[feature] === "on";
    },
    [environments, sandboxes, bots],
  );
}
