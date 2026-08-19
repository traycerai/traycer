import { useState } from "react";
import { FolderPlus } from "lucide-react";
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
import {
  canConfirmNewProject,
  folderSeedForNewProfile,
  type ProjectProfileSeed,
} from "@/lib/workspace/project-profile-seed";
import { workspaceFolderName } from "@/lib/worktree/workspace-folder-name";
import {
  PROJECT_PROFILE_COLORS,
  useProjectProfilesStore,
  type ProjectProfileColor,
} from "@/stores/workspace/project-profiles-store";
import {
  selectWorkspaceFoldersBucket,
  useWorkspaceFoldersStore,
  type WorkspaceFolderInfo,
} from "@/stores/workspace/workspace-folders-store";
import { useLandingDraftStore } from "@/stores/home/landing-draft-store";
import {
  preparedWorkspaceFolderToWorkspaceFolderInfo,
  useWorkspaceFolderActions,
} from "@/hooks/workspace/use-workspace-folder-actions";
import { PROJECT_PROFILE_COLOR_DOT } from "./project-profile-colors";

const EXTRA_SEEDS: ReadonlyArray<{
  readonly id: Exclude<ProjectProfileSeed, "folder">;
  readonly label: string;
  readonly hint: string;
}> = [
  {
    id: "all",
    label: "All current folders",
    hint: "Keep today's multi-repo set on this project",
  },
  {
    id: "empty",
    label: "Empty",
    hint: "Add this project's folder after creating it",
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
  const [seed, setSeed] = useState<ProjectProfileSeed>("folder");
  const [pickedFolder, setPickedFolder] = useState<string | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  // A folder picked via the native/remote picker that is NOT in the host
  // catalog yet. Dialog-local only: it reaches the catalog on Create (the
  // profile seed reads the catalog), never on pick - Cancel must leave the
  // host library untouched.
  const [pendingFolder, setPendingFolder] =
    useState<WorkspaceFolderInfo | null>(null);
  const catalog = useWorkspaceFoldersStore((state) =>
    selectWorkspaceFoldersBucket(state, hostId),
  );
  const selectedFolder = pickedFolder;
  const { pickAndPrepareFolders, isPreparing } = useWorkspaceFolderActions();

  const reset = () => {
    setName("");
    setColor("orange");
    setSeed("folder");
    setPickedFolder(null);
    setPendingFolder(null);
    setAdvancedOpen(false);
  };

  const submit = () => {
    if (hostId === null) return;
    const trimmed = name.trim();
    if (
      !canConfirmNewProject({
        name: trimmed,
        seed,
        pickedFolder,
      })
    ) {
      return;
    }
    // The picked folder joins the catalog only now, on confirm, so
    // `folderSeedForNewProfile` can resolve it below. An "Empty" project
    // deliberately skips the write - the user asked for no folders.
    if (
      pendingFolder !== null &&
      seed !== "empty" &&
      !catalog.folders.includes(pendingFolder.path)
    ) {
      useWorkspaceFoldersStore
        .getState()
        .addResolvedFolders(hostId, [pendingFolder]);
    }
    const confirmedCatalog = selectWorkspaceFoldersBucket(
      useWorkspaceFoldersStore.getState(),
      hostId,
    );
    const folders = folderSeedForNewProfile(
      confirmedCatalog,
      seed,
      selectedFolder,
    );
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

  const chooseFolder = async () => {
    const result = await pickAndPrepareFolders();
    if (result === null || result.folders.length === 0) return;
    const first = result.folders[0];
    if (hostId !== null && result.hostId !== hostId) return;
    setSeed("folder");
    setPickedFolder(first.workspacePath);
    setPendingFolder(
      preparedWorkspaceFolderToWorkspaceFolderInfo(first, result.hostId),
    );
  };

  const pendingPath =
    pendingFolder !== null && !catalog.folders.includes(pendingFolder.path)
      ? pendingFolder.path
      : null;
  const folderRows =
    pendingPath === null
      ? catalog.folders
      : [pendingPath, ...catalog.folders];

  // Every close path (Cancel, overlay, Escape) discards the dialog-local pick.
  const handleOpenChange = (next: boolean) => {
    if (!next) reset();
    onOpenChange(next);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        className="max-w-[min(92vw,28rem)]"
        data-testid="project-profile-create-dialog"
      >
        <DialogHeader>
          <DialogTitle>New project</DialogTitle>
          <DialogDescription>
            Each project has its own main folder. New chats only open that
            folder — not every repo you have ever added.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <label
            className="flex flex-col gap-1.5"
            htmlFor="project-profile-name"
          >
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
            <legend className="text-ui-sm font-medium">
              This project's folder
            </legend>
            {folderRows.length === 0 ? (
              <p className="text-ui-xs text-muted-foreground">
                Choose the folder this project should open.
              </p>
            ) : (
              <div className="flex max-h-48 flex-col gap-1 overflow-y-auto">
                {folderRows.map((folderPath) => (
                  <button
                    key={folderPath}
                    type="button"
                    data-testid={`project-profile-folder-${folderPath}`}
                    aria-pressed={
                      seed === "folder" && selectedFolder === folderPath
                    }
                    onClick={() => {
                      setSeed("folder");
                      setPickedFolder(folderPath);
                    }}
                    className={cn(
                      "flex flex-col items-start rounded-md px-2.5 py-1.5 text-left",
                      seed === "folder" && selectedFolder === folderPath
                        ? "bg-foreground/8"
                        : "hover:bg-foreground/5",
                    )}
                  >
                    <span className="text-ui-sm font-medium">
                      {workspaceFolderName(folderPath)}
                    </span>
                    <span className="text-ui-xs text-muted-foreground">
                      {folderPath}
                    </span>
                  </button>
                ))}
              </div>
            )}
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-testid="project-profile-choose-folder"
              disabled={hostId === null || isPreparing}
              onClick={() => {
                void chooseFolder();
              }}
            >
              <FolderPlus className="size-3.5" />
              {isPreparing ? "Opening…" : "Choose folder"}
            </Button>
          </fieldset>
          <details className="flex flex-col gap-1.5" open={advancedOpen}>
            <summary
              className="cursor-pointer text-ui-sm font-medium text-muted-foreground"
              data-testid="project-profile-advanced"
              onClick={(event) => {
                event.preventDefault();
                setAdvancedOpen((open) => !open);
              }}
            >
              Advanced
            </summary>
            {advancedOpen ? (
              <fieldset className="flex flex-col gap-1.5">
                <legend className="sr-only">More ways to start</legend>
                <div className="flex flex-col gap-1">
                  {EXTRA_SEEDS.map((option) => (
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
                      <span className="text-ui-sm font-medium">
                        {option.label}
                      </span>
                      <span className="text-ui-xs text-muted-foreground">
                        {option.hint}
                      </span>
                    </button>
                  ))}
                </div>
              </fieldset>
            ) : null}
          </details>
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => handleOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            type="button"
            data-testid="project-profile-create-confirm"
            disabled={
              hostId === null ||
              !canConfirmNewProject({
                name,
                seed,
                pickedFolder,
              })
            }
            onClick={submit}
          >
            Create project
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
