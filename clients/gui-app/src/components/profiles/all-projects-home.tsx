import { useMemo, useState, type ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Layers, Plus } from "lucide-react";
import type { HistoryItem } from "@/components/home/data/home-page.data";
import { Button } from "@/components/ui/button";
import { useHistoryQuery } from "@/hooks/home/use-history-query";
import { DEFAULT_HISTORY_SEARCH } from "@/lib/history-search";
import { profileOwnsEpic } from "@/lib/profiles/profile-membership";
import type { ProjectProfile } from "@/lib/profiles/types";
import { activateTabIntent, openOrFocusEpicIntent } from "@/lib/tab-navigation";
import { openNewEpicIntent } from "@/lib/commands/actions/new-epic";
import { useHistoryMembershipCacheStore } from "@/stores/profiles/history-membership-cache-store";
import { useProjectProfilesStore } from "@/stores/profiles/project-profiles-store";
import {
  ProfileHomeCard,
  UnassignedSection,
} from "./all-projects-home-sections";
import { ProjectProfileDialog } from "./project-profile-dialog";

const EPICS_PER_PROFILE = 5;
const UNASSIGNED_CAP = 10;

/**
 * Aggregate home for "All projects" (activeProfileId === null).
 * Per-profile cards of recent owned epics + unassigned rescue + New chat.
 */
export function AllProjectsHome(): ReactNode {
  const navigate = useNavigate();
  const profiles = useProjectProfilesStore((s) => s.profiles);
  const assignEpicsToProfile = useProjectProfilesStore(
    (s) => s.assignEpicsToProfile,
  );
  const itemsByEpicId = useHistoryMembershipCacheStore((s) => s.itemsByEpicId);
  // Keep the membership cache warm while this surface is mounted (shares
  // TanStack Query cache with HistoryMembershipCacheWarmer).
  useHistoryQuery({ search: DEFAULT_HISTORY_SEARCH, nowMs: null });

  const [createOpen, setCreateOpen] = useState(false);

  const allItems = useMemo(
    () => Array.from(itemsByEpicId.values()),
    [itemsByEpicId],
  );

  const profileCards = useMemo(
    () => buildProfileCards(profiles, allItems),
    [profiles, allItems],
  );

  const unassigned = useMemo(
    () => collectUnassignedEpics(profiles, allItems),
    [profiles, allItems],
  );

  const openEpic = (epicId: string): void => {
    activateTabIntent(
      navigate,
      openOrFocusEpicIntent({ epicId, focus: undefined }),
      undefined,
    );
  };

  const onAssign = (profileId: string, epicId: string): void => {
    assignEpicsToProfile(profileId, [epicId]);
  };

  if (profiles.length === 0) {
    return (
      <div
        className="mx-auto flex w-full max-w-2xl flex-col items-center gap-4 px-6 py-16 text-center"
        data-testid="all-projects-home-empty"
      >
        <Layers className="size-10 text-muted-foreground" aria-hidden />
        <div className="flex flex-col gap-1.5">
          <h1 className="text-lg font-medium text-foreground">All projects</h1>
          <p className="text-ui-sm text-muted-foreground">
            Create a project profile to keep workspaces, tabs and chats
            separate
          </p>
        </div>
        <Button
          type="button"
          onClick={() => {
            setCreateOpen(true);
          }}
          data-testid="all-projects-create-profile"
        >
          <Plus className="size-4" />
          Create project
        </Button>
        <ProjectProfileDialog
          open={createOpen}
          onOpenChange={setCreateOpen}
          editing={null}
        />
      </div>
    );
  }

  return (
    <div
      className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-6 py-10"
      data-testid="all-projects-home"
    >
      <header className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <Layers className="size-5 text-muted-foreground" aria-hidden />
          <h1 className="text-lg font-medium text-foreground">All projects</h1>
        </div>
        <p className="text-ui-sm text-muted-foreground" data-testid="all-projects-counts">
          {profiles.length} project{profiles.length === 1 ? "" : "s"} ·{" "}
          {unassigned.length} unassigned
        </p>
      </header>

      <div className="flex flex-col gap-3">
        {profileCards.map((card) => (
          <ProfileHomeCard
            key={card.profile.id}
            profile={card.profile}
            epics={card.epics}
            onOpenEpic={openEpic}
          />
        ))}
      </div>

      <UnassignedSection
        items={unassigned}
        profiles={profiles}
        onAssign={onAssign}
        initialCap={UNASSIGNED_CAP}
      />

      <div className="pt-2">
        <Button
          type="button"
          onClick={() => {
            // Mint + activate directly. The /draft/new resolver bounces to /
            // whenever the strip already owns a surface (e.g. a Settings tab
            // sitting in the all-projects bucket), which silently eats the
            // click and makes New chat look dead.
            activateTabIntent(navigate, openNewEpicIntent(), undefined);
          }}
          data-testid="all-projects-new-chat"
        >
          New chat
        </Button>
      </div>

      <ProjectProfileDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        editing={null}
      />
    </div>
  );
}

interface ProfileCardModel {
  readonly profile: ProjectProfile;
  readonly epics: ReadonlyArray<HistoryItem>;
  readonly mostRecentMs: number;
}

function buildProfileCards(
  profiles: ReadonlyArray<ProjectProfile>,
  allItems: ReadonlyArray<HistoryItem>,
): ReadonlyArray<ProfileCardModel> {
  // Use ownership (assignment OR folder match), not itemVisibleInProfile:
  // visibility is fail-open for unscoped epics and would list them under
  // every card. Aggregate home cards should show true ownership only.
  const cards: ProfileCardModel[] = profiles.map((profile) => {
    const owned = allItems
      .filter((item) =>
        profileOwnsEpic(profile, item.epicId, item.linkedWorkspaces),
      )
      .slice()
      .sort((a, b) => b.updatedAtMs - a.updatedAtMs);
    return {
      profile,
      epics: owned.slice(0, EPICS_PER_PROFILE),
      mostRecentMs: owned[0]?.updatedAtMs ?? 0,
    };
  });
  return cards.sort((a, b) => b.mostRecentMs - a.mostRecentMs);
}

/**
 * Epics owned by no profile (neither assignment nor folder match). Plan text
 * mentioned assignedEpicIds only; ownership via profileOwnsEpic matches the
 * rescue intent and the Task 5 test (folder-owned A/B stay out of Unassigned).
 */
function collectUnassignedEpics(
  profiles: ReadonlyArray<ProjectProfile>,
  allItems: ReadonlyArray<HistoryItem>,
): ReadonlyArray<HistoryItem> {
  return allItems
    .filter(
      (item) =>
        !profiles.some((profile) =>
          profileOwnsEpic(profile, item.epicId, item.linkedWorkspaces),
        ),
    )
    .slice()
    .sort((a, b) => b.updatedAtMs - a.updatedAtMs);
}
