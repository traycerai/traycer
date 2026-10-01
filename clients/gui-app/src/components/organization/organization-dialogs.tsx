import { useEpicCollaboratorsQuery } from "@/hooks/epics/use-epic-collaborators-query";
import { useMutation } from "@tanstack/react-query";
import { organizationKeys } from "@/lib/query-keys/organization-query-keys";
import {
  useId,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from "react";
import {
  Copy,
  Group,
  MoreHorizontal,
  Pencil,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import type {
  LabelDefinition,
  TaskLabel,
} from "@traycer/protocol/host/organization/schemas";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { TabColorPicker } from "@/components/layout/tabs/tab-appearance-menu";
import { TAB_COLORS } from "@/stores/tabs/tab-groups";
import {
  taskOrganization,
  useOrganization,
  useOrganizationTasks,
} from "@/hooks/organization/organization-context";
import { OrganizationDot, OrganizationSyncNote } from "./organization-metadata";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import {
  hasSharedLabelOwner,
  labelOwnerName,
} from "./organization-label-owner";
import { captureOrganizationDialogOpener } from "./organization-dialog-focus";

export type OrganizationDialog =
  | { kind: "labels"; taskId: string; canEdit: boolean }
  | { kind: "new-group"; taskId: string }
  | { kind: "manage-labels" };

export function OrganizationDialogHost(props: {
  readonly dialog: OrganizationDialog | null;
  readonly onClose: () => void;
  readonly returnFocusTo?: HTMLElement | null;
}) {
  const { dialog, onClose } = props;
  const openerRef = useRef<HTMLElement | null>(null);
  if (dialog === null) return null;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        className="sm:max-w-md"
        onOpenAutoFocus={() => {
          openerRef.current =
            props.returnFocusTo ?? captureOrganizationDialogOpener();
        }}
        onCloseAutoFocus={(event) => {
          const opener = openerRef.current;
          openerRef.current = null;
          if (!opener?.isConnected) return;
          // This controlled dialog has no DialogTrigger for Radix to restore.
          event.preventDefault();
          opener.focus({ preventScroll: true });
        }}
      >
        <OrganizationDialogBody dialog={dialog} onClose={onClose} />
      </DialogContent>
    </Dialog>
  );
}

function OrganizationDialogBody({
  dialog,
  onClose,
}: {
  readonly dialog: OrganizationDialog;
  readonly onClose: () => void;
}) {
  switch (dialog.kind) {
    case "labels":
      return (
        <TaskLabelsEditor
          key={dialog.taskId}
          taskId={dialog.taskId}
          canEdit={dialog.canEdit}
        />
      );
    case "new-group":
      return (
        <NewGroupEditor
          key={dialog.taskId}
          taskId={dialog.taskId}
          onClose={onClose}
        />
      );
    case "manage-labels":
      return <ManageLabels />;
  }
}

function NameColorFields(props: {
  readonly name: string;
  readonly color: string;
  readonly onName: (name: string) => void;
  readonly onColor: (color: string) => void;
  readonly colorReadOnly?: boolean;
}) {
  const id = useId();
  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <Label htmlFor={id}>Name</Label>
        <Input
          id={id}
          maxLength={80}
          value={props.name}
          onChange={(e) => props.onName(e.target.value)}
        />
      </div>
      <div className="space-y-1.5">
        <Label>Color</Label>
        {props.colorReadOnly ? (
          <OrganizationDot color={props.color} />
        ) : (
          <TabColorPicker
            menu={false}
            color={props.color}
            onChange={props.onColor}
          />
        )}
      </div>
    </div>
  );
}

function SaveButton(props: {
  readonly pending: boolean;
  readonly disabled: boolean;
  readonly children: ReactNode;
}) {
  return (
    <Button type="submit" disabled={props.pending || props.disabled}>
      {props.pending ? (
        <AgentSpinningDots
          className={undefined}
          testId={undefined}
          variant="dots"
        />
      ) : null}
      {props.children}
    </Button>
  );
}

function NewGroupEditor(props: {
  readonly taskId: string;
  readonly onClose: () => void;
}) {
  const organization = useOrganizationTasks([props.taskId]);
  const [name, setName] = useState("");
  const [color, setColor] = useState<string>(TAB_COLORS[1].value);
  const createGroup = useMutation({
    mutationKey: organizationKeys.workflow("create-group"),
    mutationFn: async () => {
      if (organization === null) return;
      const groupId = crypto.randomUUID();
      await organization.command({
        kind: "groups",
        operations: [
          {
            operation: "create",
            groupId,
            name: name.trim(),
            color,
            position: organization.view?.groups.groups.length ?? 0,
          },
          {
            operation: "moveTask",
            groupId,
            taskId: props.taskId,
            position: 0,
          },
        ],
      });
      props.onClose();
    },
  });
  const pending = createGroup.isPending;
  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (!name.trim() || organization === null || pending) return;
        createGroup.mutate();
      }}
    >
      <DialogHeader>
        <DialogTitle>New group</DialogTitle>
        <DialogDescription>
          Keep related tasks together in your own group.
        </DialogDescription>
      </DialogHeader>
      <NameColorFields
        name={name}
        color={color}
        onName={setName}
        onColor={setColor}
      />
      <DialogFooter>
        <Button type="button" variant="outline" onClick={props.onClose}>
          Cancel
        </Button>
        <SaveButton
          pending={pending}
          disabled={
            !name.trim() ||
            !organization?.view?.appearances.some(
              (a) => a.taskId === props.taskId,
            )
          }
        >
          Create group
        </SaveButton>
      </DialogFooter>
    </form>
  );
}

type LabelEditorState =
  | { kind: "create" }
  | { kind: "edit"; label: LabelDefinition }
  | { kind: "copy"; label: TaskLabel; taskId: string };
type LabelDialogState =
  | LabelEditorState
  | { kind: "delete"; label: LabelDefinition };

function labelEditorDescription(
  kind: LabelEditorState["kind"],
  taskId: string | null,
): string {
  if (kind === "edit") return "Changes apply to every task using this label.";
  if (kind === "copy")
    return "Create an independent label in your catalog. The task's labels stay the same.";
  return taskId === null
    ? "Add a label to your catalog."
    : "Create a label and apply it to this task.";
}

function LabelEditor(props: {
  readonly editor: LabelEditorState;
  readonly applyTaskId: string | null;
  readonly onClose: () => void;
}) {
  const organization = useOrganization();
  const source = props.editor.kind === "create" ? null : props.editor.label;
  const [name, setName] = useState(source?.name ?? "");
  const [color, setColor] = useState(source?.color ?? TAB_COLORS[1].value);
  const normalized = name.trim().toLocaleLowerCase();
  const collision = organization?.view?.catalog.find(
    (l) =>
      l.name.toLocaleLowerCase() === normalized &&
      (props.editor.kind !== "edit" ||
        l.labelId !== props.editor.label.labelId),
  );
  const reserved = normalized === "imported" || normalized === "automation";
  const saveLabel = useMutation({
    mutationKey: organizationKeys.workflow("save-label"),
    mutationFn: async (reuse: boolean) => {
      if (organization === null) return;
      const editor = props.editor;
      let labelId: string = crypto.randomUUID();
      if (editor.kind === "edit") labelId = editor.label.labelId;
      if (reuse && collision) labelId = collision.labelId;
      if (editor.kind === "copy")
        await organization.command({
          kind: "catalog",
          command: {
            operation: "copy",
            taskId: editor.taskId,
            sourceOwnerId: editor.label.ownerId,
            sourceLabelId: editor.label.labelId,
            choice: reuse
              ? { kind: "reuse", labelId }
              : { kind: "create", labelId, name: name.trim() },
          },
        });
      else
        await organization.command({
          kind: "catalog",
          command: {
            operation: editor.kind === "edit" ? "update" : "create",
            labelId,
            name: name.trim(),
            color,
          },
        });
      if (props.applyTaskId !== null && editor.kind === "create")
        await organization.command({
          kind: "labels",
          taskId: props.applyTaskId,
          operations: [{ operation: "attach", labelId }],
        });
      props.onClose();
    },
  });
  const pending = saveLabel.isPending;
  function save(reuse: boolean) {
    if (
      organization === null ||
      pending ||
      !name.trim() ||
      reserved ||
      (collision && !reuse)
    )
      return;
    saveLabel.mutate(reuse);
  }
  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        void save(false);
      }}
    >
      <DialogHeader>
        <DialogTitle>
          {
            {
              copy: "Copy to my labels",
              edit: "Edit label everywhere",
              create: "Create label",
            }[props.editor.kind]
          }
        </DialogTitle>
        <DialogDescription>
          {labelEditorDescription(props.editor.kind, props.applyTaskId)}
        </DialogDescription>
      </DialogHeader>
      <NameColorFields
        name={name}
        color={color}
        onName={setName}
        onColor={setColor}
        colorReadOnly={props.editor.kind === "copy"}
      />
      {reserved ? (
        <p className="text-ui-xs text-destructive">
          This name belongs to a system label. Choose another name.
        </p>
      ) : null}
      {/* A pending create may already be present in the optimistic catalog. */}
      {collision && !pending ? (
        <div className="space-y-2 text-ui-xs">
          <p>You already have a label named “{collision.name}”.</p>
          {props.editor.kind === "copy" ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={pending}
              onClick={() => void save(true)}
            >
              Use existing label
            </Button>
          ) : null}
        </div>
      ) : null}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={props.onClose}>
          Cancel
        </Button>
        <SaveButton
          pending={pending}
          disabled={!name.trim() || !!collision || reserved}
        >
          {
            {
              copy: "Copy label",
              edit: "Save",
              create:
                props.applyTaskId === null
                  ? "Create label"
                  : "Create and apply",
            }[props.editor.kind]
          }
        </SaveButton>
      </DialogFooter>
    </form>
  );
}

function TaskLabelsEditor(props: {
  readonly taskId: string;
  readonly canEdit: boolean;
}) {
  const organization = useOrganizationTasks([props.taskId]);
  const collaborators = useEpicCollaboratorsQuery(props.taskId, {
    client: organization?.client ?? null,
    enabled: organization?.supported ?? false,
    poll: false,
    staleTime: 30000,
  });
  return (
    <>
      <DialogHeader>
        <DialogTitle>Task organization</DialogTitle>
        <DialogDescription>
          {props.canEdit
            ? "Labels are visible to everyone with access to this task."
            : "You can inspect labels and copy them to your catalog."}
        </DialogDescription>
      </DialogHeader>
      <TaskGroupDetails taskId={props.taskId} />
      <LabelCatalogList
        task={{
          taskId: props.taskId,
          canEdit: props.canEdit,
          labels: organization?.view?.taskLabels[props.taskId]?.labels,
        }}
        ownerNames={
          new Map(
            collaborators.data?.flatRows.flatMap((row) =>
              row.userId === null ? [] : [[row.userId, row.displayName]],
            ),
          )
        }
      />
    </>
  );
}

function TaskGroupDetails({ taskId }: { readonly taskId: string }) {
  const organization = useOrganization();
  const group = taskOrganization(organization?.view, taskId, undefined)?.group;
  if (!group) return null;
  return (
    <section aria-label="Group" className="space-y-1.5">
      <h3 className="text-ui-xs font-medium text-muted-foreground">Group</h3>
      <div
        className="flex min-w-0 items-center gap-2 rounded-md px-2 py-2 bg-[color-mix(in_srgb,var(--organization-color)_28%,transparent)]"
        style={{ "--organization-color": group.color } as CSSProperties}
      >
        <Group className="size-4 shrink-0" aria-hidden />
        <span className="min-w-0 flex-1 break-words text-ui-sm font-medium">
          {group.name}
        </span>
      </div>
    </section>
  );
}

function ManageLabels() {
  return (
    <>
      <DialogHeader>
        <DialogTitle>Manage Labels</DialogTitle>
        <DialogDescription>
          Edits apply everywhere your labels are used. Deleting a label removes
          it from every task.
        </DialogDescription>
      </DialogHeader>
      <LabelCatalogList task={null} ownerNames={new Map()} />
    </>
  );
}

type LabelListTask = {
  readonly taskId: string;
  readonly canEdit: boolean;
  readonly labels: TaskLabel[] | undefined;
};

function labelKey(label: LabelDefinition): string {
  return `${label.ownerId}:${label.labelId}`;
}

/** Both entry points keep their list mounted while a focused child dialog is open. */
function LabelCatalogList(props: {
  readonly task: LabelListTask | null;
  readonly ownerNames: ReadonlyMap<string, string>;
}) {
  const organization = useOrganization();
  const [search, setSearch] = useState("");
  const [child, setChild] = useState<{
    editor: LabelDialogState;
    opener: HTMLElement | null;
  } | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const labels = catalogListLabels(
    organization?.view?.catalog ?? [],
    props.task,
    search,
  );
  const showOwners =
    props.task !== null &&
    hasSharedLabelOwner(labels, organization?.userId ?? null);
  const canCreate = props.task === null || props.task.canEdit;
  const taskId = props.task?.taskId ?? null;

  function openEditor(editor: LabelDialogState, opener: HTMLElement | null) {
    setChild({ editor, opener });
  }
  const toggleLabel = useMutation({
    mutationKey: organizationKeys.workflow("toggle-label"),
    mutationFn: async (label: LabelDefinition) => {
      if (!organization || !props.task?.canEdit) return;
      await organization.command({
        kind: "labels",
        taskId: props.task.taskId,
        operations: [
          props.task.labels?.some(
            (applied) => labelKey(applied) === labelKey(label),
          )
            ? {
                operation: "remove",
                ownerId: label.ownerId,
                labelId: label.labelId,
              }
            : { operation: "attach", labelId: label.labelId },
        ],
      });
    },
  });
  const pendingLabel = toggleLabel.isPending
    ? labelKey(toggleLabel.variables)
    : null;
  function toggle(label: LabelDefinition) {
    if (!organization || !props.task?.canEdit || toggleLabel.isPending) return;
    toggleLabel.mutate(label);
  }

  return (
    <>
      <Input
        ref={searchRef}
        type="search"
        aria-label={
          props.task === null ? "Search your labels" : "Search labels"
        }
        placeholder={
          props.task === null ? "Search your labels…" : "Search labels…"
        }
        value={search}
        onChange={(event) => setSearch(event.target.value)}
      />
      <section
        aria-label="Labels"
        className="max-h-[45vh] min-h-0 space-y-0.5 overflow-y-auto"
      >
        {labels.map((label) => (
          <TaskLabelCatalogRow
            key={labelKey(label)}
            label={label}
            task={props.task}
            ownerNames={props.ownerNames}
            showOwners={showOwners}
            pendingLabel={pendingLabel}
            onToggle={() => void toggle(label)}
            onOpenEditor={openEditor}
          />
        ))}
        <LabelListEmptyState
          loading={props.task !== null && props.task.labels === undefined}
          empty={labels.length === 0}
          search={search}
        />
      </section>
      <DialogFooter>
        {canCreate ? (
          <Button
            variant="outline"
            className="mr-auto"
            onClick={(event) =>
              openEditor({ kind: "create" }, event.currentTarget)
            }
          >
            <Plus />
            Create label
          </Button>
        ) : null}
        <OrganizationSyncNote taskId={taskId} labels={labels} />
      </DialogFooter>
      {child ? (
        <LabelDefinitionDialog
          editor={child.editor}
          applyTaskId={taskId}
          opener={child.opener}
          fallbackFocusRef={searchRef}
          onClose={() => setChild(null)}
        />
      ) : null}
    </>
  );
}

function catalogListLabels(
  catalog: LabelDefinition[],
  task: LabelListTask | null,
  search: string,
): LabelDefinition[] {
  const definitions = new Map<string, LabelDefinition>();
  if (task === null || task.canEdit) {
    for (const label of catalog) definitions.set(labelKey(label), label);
  }
  for (const label of task?.labels ?? []) {
    if (!definitions.has(labelKey(label)))
      definitions.set(labelKey(label), label);
  }
  const query = search.toLocaleLowerCase();
  return [...definitions.values()].filter((label) =>
    label.name.toLocaleLowerCase().includes(query),
  );
}

function LabelListEmptyState(props: {
  readonly loading: boolean;
  readonly empty: boolean;
  readonly search: string;
}) {
  if (props.loading)
    return (
      <AgentSpinningDots
        className={undefined}
        testId={undefined}
        variant="dots"
      />
    );
  if (!props.empty) return null;
  return (
    <p className="px-2 py-4 text-ui-sm text-muted-foreground">
      {props.search ? "No matching labels" : "No labels yet"}
    </p>
  );
}

function rowOwnerName(
  label: LabelDefinition,
  userId: string | null,
  showOwners: boolean,
  ownerNames: ReadonlyMap<string, string>,
): string | null {
  if (label.kind === "system") return "System";
  if (!showOwners) return null;
  if (label.ownerId === userId) return "You";
  return ownerNames.get(label.ownerId) ?? labelOwnerName(label, userId);
}

function TaskLabelCatalogRow(props: {
  readonly label: LabelDefinition;
  readonly task: LabelListTask | null;
  readonly ownerNames: ReadonlyMap<string, string>;
  readonly showOwners: boolean;
  readonly pendingLabel: string | null;
  readonly onToggle: () => void;
  readonly onOpenEditor: (
    editor: LabelDialogState,
    opener: HTMLElement | null,
  ) => void;
}) {
  const organization = useOrganization();
  const owned =
    props.label.kind === "custom" &&
    props.label.ownerId === organization?.userId;
  const source = props.task?.labels?.find(
    (label) => labelKey(label) === labelKey(props.label),
  );
  const foreign = props.label.kind === "custom" && !owned;
  const canEdit = props.task?.canEdit === true;
  const disabled =
    props.pendingLabel !== null || props.task?.labels === undefined;
  return (
    <LabelCatalogRow
      label={props.label}
      owner={rowOwnerName(
        props.label,
        organization?.userId ?? null,
        props.showOwners,
        props.ownerNames,
      )}
      owned={owned}
      assignment={
        canEdit && owned ? { checked: source !== undefined, disabled } : null
      }
      pending={props.pendingLabel === labelKey(props.label)}
      onToggle={props.onToggle}
      onEdit={(editor) =>
        props.onOpenEditor(editor, captureOrganizationDialogOpener())
      }
      onCopy={
        foreign
          ? (opener) => {
              if (props.task && source)
                props.onOpenEditor(
                  { kind: "copy", label: source, taskId: props.task.taskId },
                  opener,
                );
            }
          : null
      }
      onRemove={canEdit && foreign ? props.onToggle : null}
      removeDisabled={disabled}
    />
  );
}

function LabelCatalogRow(props: {
  readonly label: LabelDefinition;
  readonly owner: string | null;
  readonly owned: boolean;
  readonly assignment: { checked: boolean; disabled: boolean } | null;
  readonly pending: boolean;
  readonly onToggle: () => void;
  readonly onEdit: (editor: LabelDialogState) => void;
  readonly onCopy: ((opener: HTMLElement) => void) | null;
  readonly onRemove: (() => void) | null;
  readonly removeDisabled: boolean;
}) {
  const id = useId();
  return (
    <div className="flex min-w-0 items-center gap-2 rounded-md px-2 py-1.5 hover:bg-foreground/5">
      {props.assignment ? (
        <Checkbox
          id={id}
          aria-label={props.label.name}
          checked={props.assignment.checked}
          aria-disabled={props.assignment.disabled}
          onCheckedChange={
            props.assignment.disabled ? undefined : props.onToggle
          }
        />
      ) : null}
      <OrganizationDot color={props.label.color} />
      <label
        htmlFor={props.assignment ? id : undefined}
        className="min-w-0 flex-1 text-ui-sm"
      >
        <span className="block break-words">{props.label.name}</span>
        {props.owner ? (
          <span className="mt-0.5 block break-words text-ui-xs text-muted-foreground">
            {props.owner}
          </span>
        ) : null}
      </label>
      {props.pending ? (
        <AgentSpinningDots
          className={undefined}
          testId={undefined}
          variant="dots"
        />
      ) : null}
      {props.owned ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={`Options for ${props.label.name}`}
            >
              <MoreHorizontal />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              onSelect={() =>
                props.onEdit({ kind: "edit", label: props.label })
              }
            >
              <Pencil />
              Edit label
            </DropdownMenuItem>
            <DropdownMenuItem
              variant="destructive"
              onSelect={() =>
                props.onEdit({ kind: "delete", label: props.label })
              }
            >
              <Trash2 />
              Delete label
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
      {props.onCopy ? (
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={`Copy ${props.label.name} to my labels`}
          onClick={(event) => props.onCopy?.(event.currentTarget)}
        >
          <Copy />
        </Button>
      ) : null}
      {props.onRemove ? (
        <Button
          variant="ghost"
          size="icon-xs"
          disabled={props.removeDisabled}
          aria-label={`Remove ${props.label.name} from task`}
          onClick={props.onRemove}
        >
          <X />
        </Button>
      ) : null}
    </div>
  );
}

function LabelDefinitionDialog(props: {
  readonly editor: LabelDialogState;
  readonly applyTaskId: string | null;
  readonly opener: HTMLElement | null;
  readonly fallbackFocusRef: RefObject<HTMLInputElement | null>;
  readonly onClose: () => void;
}) {
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DialogContent
        onCloseAutoFocus={(event) => {
          const target = props.opener?.isConnected
            ? props.opener
            : props.fallbackFocusRef.current;
          if (!target?.isConnected) return;
          event.preventDefault();
          target.focus({ preventScroll: true });
        }}
      >
        {props.editor.kind === "delete" ? (
          <DeleteLabelEditor
            label={props.editor.label}
            onClose={props.onClose}
          />
        ) : (
          <LabelEditor
            editor={props.editor}
            applyTaskId={props.applyTaskId}
            onClose={props.onClose}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function DeleteLabelEditor(props: {
  readonly label: LabelDefinition;
  readonly onClose: () => void;
}) {
  const organization = useOrganization();
  const deleteLabel = useMutation({
    mutationKey: organizationKeys.workflow("delete-label"),
    mutationFn: async () => {
      if (!organization) return;
      await organization.command({
        kind: "catalog",
        command: { operation: "delete", labelId: props.label.labelId },
      });
      props.onClose();
    },
  });
  const pending = deleteLabel.isPending;
  return (
    <>
      <DialogHeader>
        <DialogTitle>Delete label</DialogTitle>
        <DialogDescription>
          Delete “{props.label.name}” from your catalog and every task?
        </DialogDescription>
      </DialogHeader>
      <DialogFooter>
        <Button variant="outline" disabled={pending} onClick={props.onClose}>
          Cancel
        </Button>
        <Button
          variant="destructive"
          disabled={pending}
          onClick={() => {
            if (!organization || pending) return;
            deleteLabel.mutate();
          }}
        >
          {pending ? (
            <AgentSpinningDots
              className={undefined}
              testId={undefined}
              variant="dots"
            />
          ) : null}
          Delete everywhere
        </Button>
      </DialogFooter>
    </>
  );
}
