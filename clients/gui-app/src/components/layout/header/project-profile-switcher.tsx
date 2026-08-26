import { Check, ChevronDown, FolderKanban, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { ConfirmDestructiveDialog } from "@/components/ui/confirm-destructive-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { cn } from "@/lib/utils";
import { useAddressableHostId } from "@/hooks/host/use-addressable-host-id";
import {
  selectActiveProjectProfile,
  selectProjectProfilesBucket,
  useProjectProfilesStore,
} from "@/stores/workspace/project-profiles-store";
import { useLandingDraftStore } from "@/stores/home/landing-draft-store";
import { deleteActiveProjectProfile } from "@/lib/workspace/delete-project-profile";
import { ProjectProfileCreateDialog } from "./project-profile-create-dialog";
import { PROJECT_PROFILE_COLOR_DOT } from "./project-profile-colors";

/**
 * Header switcher for Project Profiles (#1113 v1).
 *
 * Zero profiles keeps today's global folder list. Activating a profile
 * re-snapshots the landing draft so the next send only worktrees that
 * project's folders.
 */
export function ProjectProfileSwitcher() {
  const hostId = useAddressableHostId();
  const bucket = useProjectProfilesStore((state) =>
    selectProjectProfilesBucket(state, hostId),
  );
  const active = useProjectProfilesStore((state) =>
    selectActiveProjectProfile(state, hostId),
  );
  const [createOpen, setCreateOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const disabled = hostId === null;
  const label = active === null ? "All projects" : active.name;

  return (
    <>
      <DropdownMenu>
        <TooltipWrapper
          label="Project"
          side="top"
          sideOffset={6}
          align={undefined}
        >
          {/* Span keeps TooltipTrigger from composing onto DropdownMenuTrigger.
              Nested asChild slots drop the button children and leave a blank
              hole in the frameless title bar. Same pattern as HistoryNavButtons. */}
          <span className="inline-flex">
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={disabled}
                aria-label={`Project: ${label}`}
                data-testid="project-profile-switcher"
                className="max-w-[min(40vw,12rem)] border border-border/70 bg-foreground/8 text-canvas-foreground hover:bg-foreground/12 hover:text-foreground"
              >
                <FolderKanban className="size-3.5 shrink-0" />
                {active !== null ? (
                  <span
                    aria-hidden
                    className={cn(
                      "size-2 shrink-0 rounded-full",
                      PROJECT_PROFILE_COLOR_DOT[active.color],
                    )}
                  />
                ) : null}
                <span className="min-w-0 truncate">{label}</span>
                <ChevronDown className="size-3 shrink-0 opacity-70" />
              </Button>
            </DropdownMenuTrigger>
          </span>
        </TooltipWrapper>
        <DropdownMenuContent
          align="end"
          className="min-w-[min(12rem,92vw)] max-w-[min(92vw,20rem)]"
        >
          <DropdownMenuItem
            data-testid="project-profile-all"
            onSelect={() => activateProfile(hostId, null)}
          >
            <Check
              className={cn(
                "size-3.5",
                active === null ? "opacity-100" : "opacity-0",
              )}
            />
            All projects
          </DropdownMenuItem>
          {bucket.profiles.map((profile) => (
            <DropdownMenuItem
              key={profile.id}
              data-testid={`project-profile-${profile.id}`}
              onSelect={() => activateProfile(hostId, profile.id)}
            >
              <Check
                className={cn(
                  "size-3.5",
                  profile.id === active?.id ? "opacity-100" : "opacity-0",
                )}
              />
              <span
                aria-hidden
                className={cn(
                  "size-2 shrink-0 rounded-full",
                  PROJECT_PROFILE_COLOR_DOT[profile.color],
                )}
              />
              <span className="min-w-0 truncate">{profile.name}</span>
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            data-testid="project-profile-create"
            onSelect={() => setCreateOpen(true)}
          >
            <Plus className="size-3.5" />
            New project
          </DropdownMenuItem>
          {active !== null ? (
            <DropdownMenuItem
              variant="destructive"
              data-testid="project-profile-delete"
              onSelect={() => setDeleteOpen(true)}
            >
              <Trash2 className="size-3.5" />
              <span className="min-w-0 truncate">Delete {active.name}</span>
            </DropdownMenuItem>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
      {createOpen ? (
        <ProjectProfileCreateDialog
          hostId={hostId}
          open={createOpen}
          onOpenChange={setCreateOpen}
        />
      ) : null}
      {active !== null ? (
        <ConfirmDestructiveDialog
          open={deleteOpen}
          onOpenChange={setDeleteOpen}
          title={`Delete ${active.name}?`}
          description="This only removes the project shortcut. Chats and folders stay. If another project exists, Traycer switches to it instead of All projects."
          cascadeSummary={null}
          actionLabel="Delete project"
          isPending={false}
          onConfirm={() => {
            deleteActiveProfile(hostId, active.id);
            setDeleteOpen(false);
          }}
        />
      ) : null}
    </>
  );
}

function activateProfile(
  hostId: string | null,
  profileId: string | null,
): void {
  if (hostId === null) return;
  useProjectProfilesStore.getState().setActiveProfile(hostId, profileId);
  useLandingDraftStore.getState().replaceActiveDraftWorkspaceFromStores();
}

function deleteActiveProfile(hostId: string | null, profileId: string): void {
  deleteActiveProjectProfile(hostId, profileId);
}
