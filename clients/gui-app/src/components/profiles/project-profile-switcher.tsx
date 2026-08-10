import { useState, type ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Check, Layers, Pencil, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { buildProfileLandingEpicIntent } from "@/lib/profiles/profile-landing";
import { useActiveProjectProfile } from "@/lib/profiles/use-active-project-profile";
import type { ProjectProfile } from "@/lib/profiles/types";
import { openNewEpicIntent } from "@/lib/commands/actions/new-epic";
import { activateTabIntent } from "@/lib/tab-navigation";
import { cn } from "@/lib/utils";
import { useActiveProjectProfileStore } from "@/stores/profiles/active-project-profile-store";
import { useHistoryMembershipCacheStore } from "@/stores/profiles/history-membership-cache-store";
import {
  profileTabBucket,
  useProfileTabWorkspacesStore,
} from "@/stores/profiles/profile-tab-workspaces-store";
import { useProjectProfilesStore } from "@/stores/profiles/project-profiles-store";
import { flattenLayoutRefs } from "@/stores/tabs/layout";
import { useTabsStore } from "@/stores/tabs/store";
import { profileColorHex, profileIcon } from "./profile-options";
import { ProjectProfileBadge } from "./project-profile-badge";
import { ProjectProfileDialog } from "./project-profile-dialog";

type DialogMode =
  | { readonly mode: "closed" }
  | { readonly mode: "create" }
  | { readonly mode: "edit"; readonly profile: ProjectProfile };

export function ProjectProfileSwitcher(): ReactNode {
  const navigate = useNavigate();
  const activeProfile = useActiveProjectProfile();
  const profiles = useProjectProfilesStore((s) => s.profiles);
  const setActiveProfile = useActiveProjectProfileStore(
    (s) => s.setActiveProfile,
  );
  const [dialog, setDialog] = useState<DialogMode>({ mode: "closed" });

  // Entering a project jumps straight to its working surface: the most
  // recently updated epic the project owns (when that epic is still open in
  // the profile's restored strip). Fresh / empty profiles open a draft
  // composer — standing on `/` after the strip swap is a black void.
  //
  // Anti-zombie rule: the profile's restored tab strip is the work-surface
  // authority. Only an epic whose tab is still OPEN may be a landing target —
  // otherwise switching into the profile reopens a tab the user deliberately
  // closed and the write-through persists it again. A missing bucket (fresh
  // profile) allows the cold-open jump; an existing strip — even an EMPTY
  // one (all tabs closed) — still needs a draft home, not a black page.
  const selectProfile = (profile: ProjectProfile): void => {
    setActiveProfile(profile.id);
    const restored =
      useProfileTabWorkspacesStore.getState().layoutsByBucket[
        profileTabBucket(profile.id)
      ];
    const openEpicIds =
      restored === undefined
        ? null
        : new Set(
            flattenLayoutRefs(restored)
              .filter((ref) => ref.kind === "epic")
              .map((ref) => ref.id),
          );
    const intent = buildProfileLandingEpicIntent(
      profile,
      Array.from(
        useHistoryMembershipCacheStore.getState().itemsByEpicId.values(),
      ),
      openEpicIds,
    );
    if (intent !== null) {
      activateTabIntent(navigate, intent, undefined);
      return;
    }
    // After the sync strip swap, empty project → mint a draft composer.
    if (useTabsStore.getState().stripOrder.length === 0) {
      activateTabIntent(navigate, openNewEpicIntent(), { replace: true });
    }
  };

  const TriggerIcon =
    activeProfile === null ? Layers : profileIcon(activeProfile.icon);
  const triggerColor =
    activeProfile === null ? undefined : profileColorHex(activeProfile.color);
  const triggerLabel =
    activeProfile === null ? "All projects" : activeProfile.name;

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="max-w-48 shrink-0 gap-1.5 text-muted-foreground hover:text-foreground"
            data-testid="project-profile-switcher"
            aria-label="Switch project"
          >
            <TriggerIcon
              className="size-3.5 shrink-0"
              style={
                triggerColor === undefined ? undefined : { color: triggerColor }
              }
              aria-hidden
            />
            <span className="min-w-0 truncate">{triggerLabel}</span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          className="min-w-56"
          data-testid="project-profile-switcher-menu"
        >
          <DropdownMenuItem
            onSelect={() => setActiveProfile(null)}
            data-testid="project-profile-option-all"
          >
            <Layers className="size-3.5" aria-hidden />
            <span className="flex-1">All projects</span>
            {activeProfile === null ? (
              <Check className="size-3.5 text-foreground" aria-hidden />
            ) : null}
          </DropdownMenuItem>

          {profiles.length > 0 ? <DropdownMenuSeparator /> : null}

          {profiles.map((profile) => {
            const isActive = activeProfile?.id === profile.id;
            return (
              <DropdownMenuItem
                key={profile.id}
                onSelect={() => selectProfile(profile)}
                className="group/profile-row pr-1"
                data-testid={`project-profile-option-${profile.id}`}
              >
                <ProjectProfileBadge
                  profile={profile}
                  className="min-w-0 flex-1"
                  trailing={
                    isActive ? (
                      <Check
                        className="size-3.5 shrink-0 text-foreground"
                        aria-hidden
                      />
                    ) : undefined
                  }
                />
                <button
                  type="button"
                  className={cn(
                    "ml-1 flex size-6 shrink-0 items-center justify-center rounded-sm text-muted-foreground opacity-0 transition-opacity hover:bg-muted hover:text-foreground group-hover/profile-row:opacity-100 focus-visible:opacity-100",
                  )}
                  aria-label={`Edit project ${profile.name}`}
                  data-testid={`project-profile-edit-${profile.id}`}
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    setDialog({ mode: "edit", profile });
                  }}
                  onPointerDown={(event) => {
                    // Keep the row from selecting/closing before edit opens.
                    event.preventDefault();
                    event.stopPropagation();
                  }}
                >
                  <Pencil className="size-3.5" aria-hidden />
                </button>
              </DropdownMenuItem>
            );
          })}

          <DropdownMenuSeparator />
          <DropdownMenuItem
            onSelect={() => setDialog({ mode: "create" })}
            data-testid="project-profile-option-new"
          >
            <Plus className="size-3.5" aria-hidden />
            New project…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {dialog.mode !== "closed" ? (
        <ProjectProfileDialog
          open
          onOpenChange={(open) => {
            if (!open) setDialog({ mode: "closed" });
          }}
          editing={dialog.mode === "edit" ? dialog.profile : null}
        />
      ) : null}
    </>
  );
}
