/**
 * The identity rail: every file the identity holds, grouped Soul / Memories /
 * Skills, with the manifest's media type and size on blobs and a `pending`
 * badge on a blob the host has not finished mirroring.
 *
 * Every write goes through the tab host's client: adding a markdown file
 * (`files.add`), uploading a blob (`files.uploadBlob`, chunked), renaming and
 * deleting. A refusal is rendered inline under the tree rather than toasted:
 * the reasons are all things the user can act on (a taken name, a bad path)
 * and belong next to the control that produced them.
 */
import {
  useLayoutEffect,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { FilePlus, Upload } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDestructiveDialog } from "@/components/ui/confirm-destructive-dialog";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { useTabHostClient } from "@/hooks/host/use-tab-host-client";
import {
  useIdentityFileAddForClient,
  useIdentityFileDeleteForClient,
  useIdentityFileRenameForClient,
  useIdentityUploadBlobChunkForClient,
} from "@/hooks/identities/use-identity-mutations";
import { useInlineRename } from "@/hooks/ui/use-inline-rename";
import {
  formatByteLength,
  type IdentityFileGroupId,
  type IdentityTreeFile,
  type IdentityTreeGroup,
} from "@/lib/identities/file-tree";
import { identityRefusalCopy } from "@/lib/identities/refusal-copy";
import { uploadIdentityBlob } from "@/lib/identities/upload-blob";
import { useIdentityFileIsDirty } from "@/lib/identity-selectors";
import { cn } from "@/lib/utils";
import { IdentitySkillInstallButton } from "./identity-skill-install";

export interface IdentityFileTreeProps {
  readonly identityId: string;
  readonly groups: readonly IdentityTreeGroup[];
  readonly hydrated: boolean;
  readonly selectedPath: string | null;
  readonly onSelect: (path: string) => void;
}

/** The folder a new file in each group lands in. `other` takes no new files. */
const GROUP_PREFIX: Readonly<Record<IdentityFileGroupId, string | null>> = {
  soul: "",
  memories: "memories/",
  skills: "skills/",
  other: null,
};

const MARKDOWN_SUFFIX = ".md";

function withMarkdownSuffix(name: string): string {
  return name.toLowerCase().endsWith(MARKDOWN_SUFFIX)
    ? name
    : `${name}${MARKDOWN_SUFFIX}`;
}

function folderOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? "" : path.slice(0, slash + 1);
}

export function IdentityFileTree(props: IdentityFileTreeProps): ReactNode {
  const { identityId, groups, hydrated, selectedPath, onSelect } = props;
  const client = useTabHostClient();
  const addFile = useIdentityFileAddForClient(client);
  const renameFile = useIdentityFileRenameForClient(client);
  const deleteFile = useIdentityFileDeleteForClient(client);
  const uploadChunk = useIdentityUploadBlobChunkForClient(client);
  const [notice, setNotice] = useState<string | null>(null);
  const [addingIn, setAddingIn] = useState<IdentityFileGroupId | null>(null);
  const [uploading, setUploading] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<IdentityTreeFile | null>(
    null,
  );
  const uploadInput = useRef<HTMLInputElement | null>(null);
  const uploadGroup = useRef<IdentityFileGroupId | null>(null);

  const commitAdd = (group: IdentityFileGroupId, name: string) => {
    const prefix = GROUP_PREFIX[group];
    if (prefix === null) return;
    setAddingIn(null);
    setNotice(null);
    const path = `${prefix}${withMarkdownSuffix(name.trim())}`;
    addFile.mutate(
      { identityId, path },
      {
        onSuccess: (response) => {
          if (response.kind === "refused") {
            setNotice(identityRefusalCopy(response.reason));
            return;
          }
          onSelect(response.path);
        },
      },
    );
  };

  const commitRename = (file: IdentityTreeFile, name: string) => {
    setNotice(null);
    const toPath = `${folderOf(file.path)}${
      file.kind === "document" ? withMarkdownSuffix(name) : name
    }`;
    if (toPath === file.path) return;
    renameFile.mutate(
      { identityId, fromPath: file.path, toPath },
      {
        onSuccess: (response) => {
          if (response.kind === "refused") {
            setNotice(identityRefusalCopy(response.reason));
            return;
          }
          if (selectedPath === file.path) onSelect(response.path);
        },
      },
    );
  };

  const confirmDelete = () => {
    if (deleteTarget === null) return;
    const target = deleteTarget;
    setNotice(null);
    deleteFile.mutate(
      { identityId, path: target.path },
      {
        onSuccess: (response) => {
          setDeleteTarget(null);
          if (response.kind === "refused") {
            setNotice(identityRefusalCopy(response.reason));
          }
        },
        onError: () => {
          setDeleteTarget(null);
        },
      },
    );
  };

  const startUpload = (group: IdentityFileGroupId) => {
    uploadGroup.current = group;
    uploadInput.current?.click();
  };

  const onUploadPicked = async (event: ChangeEvent<HTMLInputElement>) => {
    const picked = event.target.files?.[0];
    event.target.value = "";
    const group = uploadGroup.current;
    if (picked === undefined || group === null) return;
    const prefix = GROUP_PREFIX[group];
    if (prefix === null) return;
    setNotice(null);
    setUploading(true);
    try {
      const bytes = new Uint8Array(await picked.arrayBuffer());
      const outcome = await uploadIdentityBlob({
        identityId,
        path: `${prefix}${picked.name}`,
        bytes,
        mediaType: picked.type.length > 0 ? picked.type : null,
        executable: false,
        sendChunk: (request) => uploadChunk.mutateAsync(request),
      });
      if (outcome.kind === "refused") {
        setNotice(identityRefusalCopy(outcome.reason));
      } else if (outcome.kind === "incomplete") {
        setNotice("The host did not finish the upload. Try again.");
      } else {
        onSelect(outcome.path);
      }
    } catch {
      // The mutation hook has already toasted the transport error.
    } finally {
      setUploading(false);
    }
  };

  if (!hydrated) {
    return (
      <div
        className="flex flex-col gap-2 p-3"
        data-testid="identity-tree-loading"
        aria-busy="true"
        aria-label="Loading files"
      >
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-6 w-full rounded-md" />
        ))}
      </div>
    );
  }

  const busy =
    addFile.isPending ||
    renameFile.isPending ||
    deleteFile.isPending ||
    uploading;

  return (
    <div className="flex flex-col gap-3 p-2" data-testid="identity-file-tree">
      <input
        ref={uploadInput}
        type="file"
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        data-testid="identity-upload-input"
        onChange={(event) => {
          void onUploadPicked(event);
        }}
      />
      {groups.map((group) => {
        const prefix = GROUP_PREFIX[group.id];
        if (prefix === null && group.files.length === 0) return null;
        return (
          <section
            key={group.id}
            className="flex flex-col gap-0.5"
            data-testid={`identity-tree-group-${group.id}`}
            aria-label={group.label}
          >
            <div className="flex items-center gap-1 px-1">
              <span className="flex-1 truncate text-overline text-muted-foreground">
                {group.label}
              </span>
              {prefix !== null ? (
                <>
                  <TooltipWrapper
                    label="New markdown file"
                    side="bottom"
                    sideOffset={4}
                    align={undefined}
                  >
                    <Button
                      type="button"
                      variant="muted"
                      size="icon-sm"
                      aria-label={`New file in ${group.label}`}
                      disabled={busy}
                      onClick={() => setAddingIn(group.id)}
                    >
                      <FilePlus className="size-3.5" />
                    </Button>
                  </TooltipWrapper>
                  <TooltipWrapper
                    label="Upload a file"
                    side="bottom"
                    sideOffset={4}
                    align={undefined}
                  >
                    <Button
                      type="button"
                      variant="muted"
                      size="icon-sm"
                      aria-label={`Upload a file to ${group.label}`}
                      disabled={busy}
                      onClick={() => startUpload(group.id)}
                    >
                      <Upload className="size-3.5" />
                    </Button>
                  </TooltipWrapper>
                  {group.id === "skills" ? (
                    <IdentitySkillInstallButton
                      identityId={identityId}
                      disabled={busy}
                      onInstalled={onSelect}
                    />
                  ) : null}
                </>
              ) : null}
            </div>
            {group.files.length === 0 && addingIn !== group.id ? (
              <p className="px-2 py-1 text-ui-xs text-muted-foreground">
                Nothing here yet.
              </p>
            ) : null}
            {group.files.map((file) => (
              <IdentityFileRow
                key={file.path}
                file={file}
                selected={file.path === selectedPath}
                disabled={busy}
                onSelect={() => onSelect(file.path)}
                onRename={(name) => commitRename(file, name)}
                onDelete={() => setDeleteTarget(file)}
              />
            ))}
            {addingIn === group.id ? (
              <NewFileInput
                onCommit={(name) => commitAdd(group.id, name)}
                onCancel={() => setAddingIn(null)}
              />
            ) : null}
          </section>
        );
      })}
      {notice !== null ? (
        <p
          role="alert"
          data-testid="identity-tree-notice"
          className="rounded-md border border-destructive/30 bg-destructive/10 px-2 py-1 text-ui-xs text-destructive-foreground"
        >
          {notice}
        </p>
      ) : null}
      <ConfirmDestructiveDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        title={`Delete ${deleteTarget?.name ?? "this file"}?`}
        description="Its history stays on the host, but the file leaves this identity and any agent using it."
        cascadeSummary={null}
        actionLabel="Delete"
        isPending={deleteFile.isPending}
        blockedReason={null}
        onConfirm={confirmDelete}
      />
    </div>
  );
}

function NewFileInput(props: {
  readonly onCommit: (name: string) => void;
  readonly onCancel: () => void;
}): ReactNode {
  const [name, setName] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);
  useLayoutEffect(() => {
    inputRef.current?.focus({ preventScroll: true });
  }, []);
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      if (name.trim().length > 0) props.onCommit(name);
    } else if (event.key === "Escape") {
      event.preventDefault();
      props.onCancel();
    }
  };
  return (
    <Input
      ref={inputRef}
      value={name}
      placeholder="name.md"
      aria-label="New file name"
      data-testid="identity-new-file-input"
      onChange={(event) => setName(event.target.value)}
      onKeyDown={onKeyDown}
      onBlur={() => {
        if (name.trim().length > 0) props.onCommit(name);
        else props.onCancel();
      }}
    />
  );
}

function IdentityFileRow(props: {
  readonly file: IdentityTreeFile;
  readonly selected: boolean;
  readonly disabled: boolean;
  readonly onSelect: () => void;
  readonly onRename: (name: string) => void;
  readonly onDelete: () => void;
}): ReactNode {
  const { file, selected, disabled, onSelect, onRename, onDelete } = props;
  const dirty = useIdentityFileIsDirty(
    file.kind === "document" ? file.path : null,
  );
  const rename = useInlineRename({
    value: file.name,
    canEdit: !disabled,
    onCommit: onRename,
  });
  const meta =
    file.kind === "document"
      ? "markdown"
      : `${file.mediaType}${file.byteLength === null ? "" : ` · ${formatByteLength(file.byteLength)}`}`;
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild disabled={rename.isEditing}>
        <div
          role="button"
          tabIndex={0}
          aria-pressed={selected}
          data-testid="identity-file-row"
          data-path={file.path}
          className={cn(
            "flex min-w-0 cursor-pointer flex-col rounded-md px-2 py-1 text-left outline-none hover:bg-foreground/5 focus-visible:ring-2 focus-visible:ring-ring",
            selected ? "bg-foreground/8" : null,
          )}
          onClick={onSelect}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              onSelect();
            }
          }}
          onDoubleClick={rename.startEditing}
        >
          {rename.isEditing ? (
            <Input
              {...rename.inputProps}
              aria-label={`Rename ${file.name}`}
              data-testid="identity-file-rename-input"
            />
          ) : (
            <span className="flex min-w-0 items-center gap-1.5">
              <span className="min-w-0 flex-1 truncate text-ui-sm text-foreground">
                {file.name}
              </span>
              {dirty ? (
                <span
                  className="size-1.5 shrink-0 rounded-full bg-warning"
                  aria-label="Unsaved changes"
                  data-testid="identity-file-dirty"
                />
              ) : null}
              {file.pending ? (
                <Badge
                  variant="warning"
                  size="xs"
                  data-testid="identity-file-pending"
                >
                  pending
                </Badge>
              ) : null}
              {file.executable ? (
                <Badge variant="muted" size="xs">
                  exec
                </Badge>
              ) : null}
            </span>
          )}
          <span className="truncate text-micro text-muted-foreground">
            {meta}
          </span>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={rename.startEditing} disabled={disabled}>
          Rename
        </ContextMenuItem>
        <ContextMenuItem
          variant="destructive"
          onSelect={onDelete}
          disabled={disabled}
        >
          Delete
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
