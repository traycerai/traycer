import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { folderSeedForNewProfile } from "@/lib/workspace/project-profile-seed";
import type { ProjectProfileSeed } from "@/lib/workspace/project-profile-seed";
import {
  PROJECT_PROFILE_COLORS,
  useProjectProfilesStore,
  type ProjectProfileColor,
} from "@/stores/workspace/project-profiles-store";
import {
  selectWorkspaceFoldersBucket,
  useWorkspaceFoldersStore,
} from "@/stores/workspace/workspace-folders-store";
import { useLandingDraftStore } from "@/stores/home/landing-draft-store";
import { PROJECT_PROFILE_COLOR_DOT } from "./project-profile-colors";

const SEED_OPTIONS: ReadonlyArray<{
  readonly id: ProjectProfileSeed;
  readonly label: string;
  readonly hint: string;
}> = [
  {
    id: "primary",
    label: "Primary folder",
    hint: "New chats only open this project's main folder",
  },
  {
    id: "all",
    label: "All current folders",
    hint: "Keep today's multi-repo set on this project",
  },
  {
    id: "empty",
    label: "Empty",
    hint: "Add folders after creating the project",
  },
];

export function ProjectProfileCreateDialog(props: {
  readonly hostId: string | null;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const { hostId, open, onOpenChange } = props;
  const [name, setName] = useState("");
  const [color, setColor] = useState<ProjectProfileColor>("orange");
  const [seed, setSeed] = useState<ProjectProfileSeed>("primary");

  const reset = () => {
    setName("");
    setColor("orange");
    setSeed("primary");
  };

  const submit = () => {
    if (hostId === null) return;
    const trimmed = name.trim();
    if (trimmed.length === 0) return;
    const catalog = selectWorkspaceFoldersBucket(
      useWorkspaceFoldersStore.getState(),
      hostId,
    );
    const folders = folderSeedForNewProfile(catalog, seed);
    const id = useProjectProfilesStore.getState().createProfile(hostId, {
      name: trimmed,
      color,
      folderPaths: folders.folderPaths,
      primaryPath: folders.primaryPath,
    });
    if (id === null) return;
    useProjectProfilesStore.getState().setActiveProfile(hostId, id);
    useLandingDraftStore.getState().replaceActiveDraftWorkspaceFromStores();
    reset();
    onOpenChange(false);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent
        className="sm:max-w-md"
        data-testid="project-profile-create-dialog"
      >
        <DialogHeader>
          <DialogTitle>New project</DialogTitle>
          <DialogDescription>
            Isolate this chat's folders so a new worktree is not created for
            every repo you have ever added.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1.5" htmlFor="project-profile-name">
            <span className="text-ui-sm font-medium">Name</span>
            <Input
              id="project-profile-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Titanos"
              data-testid="project-profile-name"
            />
          </label>
          <fieldset className="flex flex-col gap-1.5">
            <legend className="text-ui-sm font-medium">Color</legend>
            <div className="flex flex-wrap gap-1.5">
              {PROJECT_PROFILE_COLORS.map((option) => (
                <button
                  key={option}
                  type="button"
                  aria-label={option}
                  aria-pressed={option === color}
                  data-testid={`project-profile-color-${option}`}
                  onClick={() => setColor(option)}
                  className={cn(
                    "size-7 rounded-full ring-offset-background focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none",
                    PROJECT_PROFILE_COLOR_DOT[option],
                    option === color
                      ? "ring-2 ring-foreground"
                      : "opacity-70 hover:opacity-100",
                  )}
                />
              ))}
            </div>
          </fieldset>
          <fieldset className="flex flex-col gap-1.5">
            <legend className="text-ui-sm font-medium">Start with</legend>
            <div className="flex flex-col gap-1">
              {SEED_OPTIONS.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  data-testid={`project-profile-seed-${option.id}`}
                  aria-pressed={seed === option.id}
                  onClick={() => setSeed(option.id)}
                  className={cn(
                    "flex flex-col items-start rounded-md px-2.5 py-1.5 text-left",
                    seed === option.id
                      ? "bg-foreground/8"
                      : "hover:bg-foreground/5",
                  )}
                >
                  <span className="text-ui-sm font-medium">{option.label}</span>
                  <span className="text-ui-xs text-muted-foreground">
                    {option.hint}
                  </span>
                </button>
              ))}
            </div>
          </fieldset>
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            type="button"
            data-testid="project-profile-create-confirm"
            disabled={hostId === null || name.trim().length === 0}
            onClick={submit}
          >
            Create project
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
