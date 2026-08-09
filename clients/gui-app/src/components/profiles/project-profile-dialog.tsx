import { useEffect, useState, type ReactNode } from "react";
import { Folder, Plus, X } from "lucide-react";
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
import { useWorkspaceFolderActions } from "@/hooks/workspace/use-workspace-folder-actions";
import type {
  ProjectProfile,
  ProjectProfileFolder,
} from "@/lib/profiles/types";
import { cn } from "@/lib/utils";
import { useActiveProjectProfileStore } from "@/stores/profiles/active-project-profile-store";
import { useProjectProfilesStore } from "@/stores/profiles/project-profiles-store";
import {
  PROFILE_COLORS,
  PROFILE_ICONS,
  profileColorHex,
} from "./profile-options";

export interface ProjectProfileDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly editing: ProjectProfile | null;
}

export function ProjectProfileDialog(
  props: ProjectProfileDialogProps,
): ReactNode {
  const createProfile = useProjectProfilesStore((s) => s.createProfile);
  const updateProfile = useProjectProfilesStore((s) => s.updateProfile);
  const deleteProfile = useProjectProfilesStore((s) => s.deleteProfile);
  const activeProfileId = useActiveProjectProfileStore(
    (s) => s.activeProfileId,
  );
  const setActiveProfile = useActiveProjectProfileStore(
    (s) => s.setActiveProfile,
  );
  const { pickAndPrepareFolders } = useWorkspaceFolderActions();

  const [name, setName] = useState("");
  const [icon, setIcon] = useState("folder");
  const [color, setColor] = useState("blue");
  const [folders, setFolders] = useState<ReadonlyArray<ProjectProfileFolder>>(
    [],
  );
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [isPicking, setIsPicking] = useState(false);

  useEffect(() => {
    if (!props.open) return;
    if (props.editing === null) {
      setName("");
      setIcon("folder");
      setColor("blue");
      setFolders([]);
    } else {
      setName(props.editing.name);
      setIcon(props.editing.icon);
      setColor(props.editing.color);
      setFolders(props.editing.folders);
    }
    setConfirmDelete(false);
  }, [props.open, props.editing]);

  const canSubmit = name.trim().length > 0 && folders.length >= 1;
  const isEdit = props.editing !== null;

  const handleAddFolder = (): void => {
    if (isPicking) return;
    setIsPicking(true);
    void pickAndPrepareFolders()
      .then((result) => {
        if (result === null) return;
        setFolders((prev) => {
          const next = [...prev];
          for (const folder of result.folders) {
            if (next.some((entry) => entry.path === folder.workspacePath)) {
              continue;
            }
            next.push({
              path: folder.workspacePath,
              hostId: result.hostId,
            });
          }
          return next;
        });
      })
      .finally(() => {
        setIsPicking(false);
      });
  };

  const handleRemoveFolder = (path: string): void => {
    setFolders((prev) => prev.filter((folder) => folder.path !== path));
  };

  const handleSubmit = (): void => {
    if (!canSubmit) return;
    if (props.editing === null) {
      const created = createProfile({
        name: name.trim(),
        icon,
        color,
        folders,
      });
      setActiveProfile(created.id);
    } else {
      updateProfile(props.editing.id, {
        name: name.trim(),
        icon,
        color,
        folders,
      });
    }
    props.onOpenChange(false);
  };

  const handleDelete = (): void => {
    if (props.editing === null) return;
    if (activeProfileId === props.editing.id) {
      setActiveProfile(null);
    }
    deleteProfile(props.editing.id);
    props.onOpenChange(false);
  };

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent
        className="sm:max-w-md"
        data-testid="project-profile-dialog"
      >
        <DialogHeader>
          <DialogTitle>
            {isEdit ? "Edit project" : "New project"}
          </DialogTitle>
          <DialogDescription>
            {isEdit
              ? "Update this project's name, appearance, and folders."
              : "Group workspace folders into a project for scoped epics and composer."}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <label className="flex flex-col gap-1.5">
            <span className="text-ui-sm font-medium">Name</span>
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Project name"
              data-testid="project-profile-name"
              autoFocus
            />
          </label>

          <div className="flex flex-col gap-1.5">
            <span className="text-ui-sm font-medium">Icon</span>
            <div className="grid grid-cols-8 gap-1.5">
              {PROFILE_ICONS.map((entry) => {
                const Icon = entry.Icon;
                const selected = icon === entry.id;
                return (
                  <button
                    key={entry.id}
                    type="button"
                    aria-label={`Icon ${entry.id}`}
                    aria-pressed={selected}
                    className={cn(
                      "flex size-8 items-center justify-center rounded-md border border-transparent text-muted-foreground transition-colors hover:bg-muted",
                      selected && "border-ring ring-1 ring-ring",
                    )}
                    onClick={() => setIcon(entry.id)}
                  >
                    <Icon className="size-4" aria-hidden />
                  </button>
                );
              })}
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <span className="text-ui-sm font-medium">Color</span>
            <div className="grid grid-cols-8 gap-1.5">
              {PROFILE_COLORS.map((entry) => {
                const selected = color === entry.id;
                return (
                  <button
                    key={entry.id}
                    type="button"
                    aria-label={`Color ${entry.id}`}
                    aria-pressed={selected}
                    className={cn(
                      "size-8 rounded-full border border-transparent transition-shadow",
                      selected && "ring-2 ring-ring ring-offset-2 ring-offset-background",
                    )}
                    style={{ backgroundColor: entry.hex }}
                    onClick={() => setColor(entry.id)}
                  />
                );
              })}
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <span className="text-ui-sm font-medium">Folders</span>
            <ul className="flex flex-col gap-1">
              {folders.map((folder, index) => (
                <li
                  key={folder.path}
                  className="flex min-w-0 items-center gap-2 rounded-md border border-border px-2 py-1.5"
                  data-testid="project-profile-folder-row"
                >
                  <Folder
                    className="size-3.5 shrink-0"
                    style={{ color: profileColorHex(color) }}
                    aria-hidden
                  />
                  <span
                    className="min-w-0 flex-1 truncate text-ui-sm"
                    title={folder.path}
                  >
                    {folder.path}
                  </span>
                  {index === 0 ? (
                    <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-ui-xs text-muted-foreground">
                      Primary
                    </span>
                  ) : null}
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Remove folder ${folder.path}`}
                    onClick={() => handleRemoveFolder(folder.path)}
                  >
                    <X className="size-3.5" aria-hidden />
                  </Button>
                </li>
              ))}
            </ul>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="w-full justify-start"
              onClick={handleAddFolder}
              disabled={isPicking}
              data-testid="project-profile-add-folder"
            >
              <Plus className="size-3.5" aria-hidden />
              Add folder…
            </Button>
          </div>
        </div>

        <DialogFooter className="flex-col gap-2 sm:flex-col">
          <div className="flex w-full flex-wrap items-center justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => props.onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              onClick={handleSubmit}
              disabled={!canSubmit}
              data-testid="project-profile-submit"
            >
              {isEdit ? "Save" : "Create project"}
            </Button>
          </div>

          {isEdit ? (
            confirmDelete ? (
              <div
                className="flex w-full flex-col gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3"
                data-testid="project-profile-delete-confirm"
              >
                <p className="text-ui-sm">
                  Delete this project? Epics are not deleted.
                </p>
                <div className="flex justify-end gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setConfirmDelete(false)}
                  >
                    Cancel
                  </Button>
                  <Button
                    type="button"
                    variant="destructive"
                    size="sm"
                    onClick={handleDelete}
                    data-testid="project-profile-delete-confirm-button"
                  >
                    Confirm
                  </Button>
                </div>
              </div>
            ) : (
              <Button
                type="button"
                variant="ghost"
                className="w-full text-destructive hover:text-destructive"
                onClick={() => setConfirmDelete(true)}
                data-testid="project-profile-delete"
              >
                Delete project
              </Button>
            )
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
