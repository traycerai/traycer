import { useMemo, type ReactNode } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import type { ProjectProfile } from "@/lib/profiles/types";
import { useHistoryMembershipCacheStore } from "@/stores/profiles/history-membership-cache-store";
import { useProjectProfilesStore } from "@/stores/profiles/project-profiles-store";

/**
 * Bulk assignment for legacy epics: history rows with no linked workspace
 * ("unscoped") are visible in every profile until assigned. This section
 * assigns all of them to the edited project in one click. Scoped epics
 * (folder-linked) and already-assigned ones are never touched.
 */
export function UnscopedEpicsAssignSection(props: {
  readonly editing: ProjectProfile;
}): ReactNode {
  const itemsByEpicId = useHistoryMembershipCacheStore((s) => s.itemsByEpicId);
  const profiles = useProjectProfilesStore((s) => s.profiles);
  const assignEpicsToProfile = useProjectProfilesStore(
    (s) => s.assignEpicsToProfile,
  );

  const unscopedIds = useMemo(() => {
    const assigned = new Set(
      profiles.flatMap((profile) => profile.assignedEpicIds),
    );
    const ids: string[] = [];
    for (const item of itemsByEpicId.values()) {
      if (item.linkedWorkspaces.length > 0) continue;
      if (assigned.has(item.epicId)) continue;
      ids.push(item.epicId);
    }
    return ids.sort();
  }, [itemsByEpicId, profiles]);

  const cacheCold = itemsByEpicId.size === 0;

  return (
    <div
      className="flex flex-col gap-1.5 rounded-md border border-border px-3 py-2.5"
      data-testid="unscoped-assign-section"
    >
      <span className="text-ui-sm font-medium">Legacy epics</span>
      <p className="text-ui-xs text-muted-foreground">
        Epics with no linked folder show up in every project. Assign them here
        to make them belong to “{props.editing.name}” only.
      </p>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="mt-1 w-full justify-start"
        disabled={cacheCold || unscopedIds.length === 0}
        onClick={() => {
          assignEpicsToProfile(props.editing.id, unscopedIds);
          toast.success(
            `${unscopedIds.length} epic${unscopedIds.length === 1 ? "" : "s"} assigned to ${props.editing.name}`,
          );
        }}
        data-testid="unscoped-assign-button"
      >
        {cacheCold
          ? "Open the history list once to detect legacy epics"
          : unscopedIds.length === 0
            ? "No unassigned legacy epics"
            : `Assign ${unscopedIds.length} unscoped epic${unscopedIds.length === 1 ? "" : "s"} to ${props.editing.name}`}
      </Button>
    </div>
  );
}
