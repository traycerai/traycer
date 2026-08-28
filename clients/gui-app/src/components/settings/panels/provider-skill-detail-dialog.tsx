import { useEffect, useRef, useState, type ReactNode } from "react";
import { useForm } from "@tanstack/react-form";
import type { ProviderSkill } from "@traycer/protocol/host/provider-native-schemas";
import {
  AlertTriangle,
  FileWarning,
  Pencil,
  RefreshCw,
  Trash2,
} from "lucide-react";
import {
  MarkdownEditPreview,
  MarkdownPreview,
} from "@/components/markdown-edit-preview";
import { MutedAgentSpinner } from "@/components/ui/agent-spinning-dots";
import { Badge } from "@/components/ui/badge";
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
import { Label } from "@/components/ui/label";
import { StartTruncatedText } from "@/components/ui/start-truncated-text";
import { Textarea } from "@/components/ui/textarea";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { useWorkspaceReadFile } from "@/hooks/workspace/use-read-file-query";
import { useHostClient } from "@/lib/host";
import { cn } from "@/lib/utils";
import {
  SKILL_ENTRY_FILE,
  parseSkillMarkdown,
} from "./provider-skill-markdown";
import {
  previewSkillMd,
  skillEditPrefill,
  skillNameError,
  SKILL_DESCRIPTION_SOFT_LIMIT,
  type SkillEditTarget,
} from "./provider-skill-composer-model";
import type { SkillRemovability } from "./provider-skill-removable";
import {
  SKILL_CONFLICT_LABEL,
  SKILL_CONFLICT_TONE,
  SKILL_CONFLICT_TOOLTIP,
  SKILL_SOURCE_LABEL,
  SKILL_SOURCE_TONE,
} from "./provider-skill-source-badge";

type EditExitIntent = "detail" | "closed";
type SkillEditValues = Pick<SkillEditTarget, "name" | "description" | "body">;

export function ProviderSkillDetailDialog(props: {
  readonly skill: ProviderSkill;
  readonly removal: SkillRemovability;
  readonly removePending: boolean;
  readonly removeDisabled: boolean;
  readonly actionError: string | null;
  readonly canEdit: boolean;
  readonly canUpdate: boolean;
  readonly origin: string | null;
  readonly updatePending: boolean;
  readonly editPending: boolean;
  readonly onStartEdit: () => void;
  readonly onSave: (target: SkillEditTarget) => Promise<boolean>;
  readonly onRequestUpdate: () => void;
  readonly onRequestRemove: () => void;
  readonly onClose: () => void;
  readonly fileEpoch: number;
}): ReactNode {
  const client = useHostClient();
  const guardedClose = useRef<(() => void) | null>(null);
  function registerGuardedClose(request: (() => void) | null): void {
    guardedClose.current = request;
  }
  const fileQuery = useWorkspaceReadFile(
    client,
    props.skill.path,
    SKILL_ENTRY_FILE,
    [props.fileEpoch],
  );
  const content = fileQuery.data?.content ?? null;
  const [optimisticContent, setOptimisticContent] = useState<string | null>(
    null,
  );
  const truncated = fileQuery.data?.truncated ?? false;
  const readError = fileQuery.isError
    ? fileQuery.error.message
    : (fileQuery.data?.error ?? null);
  const stableContent =
    content ?? (fileQuery.isPending ? optimisticContent : null);
  const editableContent =
    props.canEdit && readError === null && stableContent !== null && !truncated
      ? stableContent
      : null;

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (open) return;
        const close = guardedClose.current;
        if (close === null) props.onClose();
        else close();
      }}
    >
      <DialogContent className="grid h-[min(86dvh,calc(100dvh-2rem))] w-[min(92vw,52rem)] grid-rows-[auto_minmax(0,1fr)_auto] gap-0 overflow-hidden p-0 sm:max-w-[min(92vw,52rem)]">
        {editableContent === null ? (
          <ReadOnlySkillDetail
            skill={props.skill}
            removal={props.removal}
            removePending={props.removePending}
            actionsDisabled={props.removeDisabled}
            actionError={props.actionError}
            canUpdate={props.canUpdate}
            origin={props.origin}
            updatePending={props.updatePending}
            pending={fileQuery.isPending}
            error={readError}
            content={content}
            truncated={truncated}
            onRequestUpdate={props.onRequestUpdate}
            onRequestRemove={props.onRequestRemove}
          />
        ) : (
          <EditableSkillDetail
            onCloseRequestChange={registerGuardedClose}
            skill={props.skill}
            raw={editableContent}
            removal={props.removal}
            removePending={props.removePending}
            actionsDisabled={props.removeDisabled}
            actionError={props.actionError}
            canUpdate={props.canUpdate}
            origin={props.origin}
            updatePending={props.updatePending}
            editPending={props.editPending}
            onStartEdit={props.onStartEdit}
            onSave={async (target) => {
              const saved = await props.onSave(target);
              if (saved) setOptimisticContent(previewSkillMd(target));
              return saved;
            }}
            onRequestUpdate={props.onRequestUpdate}
            onRequestRemove={props.onRequestRemove}
            onClose={props.onClose}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function EditableSkillDetail(props: {
  readonly onCloseRequestChange: (request: (() => void) | null) => void;
  readonly skill: ProviderSkill;
  readonly raw: string;
  readonly removal: SkillRemovability;
  readonly removePending: boolean;
  readonly actionsDisabled: boolean;
  readonly actionError: string | null;
  readonly canUpdate: boolean;
  readonly origin: string | null;
  readonly updatePending: boolean;
  readonly editPending: boolean;
  readonly onStartEdit: () => void;
  readonly onSave: (target: SkillEditTarget) => Promise<boolean>;
  readonly onRequestUpdate: () => void;
  readonly onRequestRemove: () => void;
  readonly onClose: () => void;
}): ReactNode {
  const initial = skillEditPrefill(props.skill, props.raw);
  const baseline = useRef(initial.baseline);
  const lastRaw = useRef(props.raw);
  const formNode = useRef<HTMLFormElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const editButton = useRef<HTMLButtonElement>(null);
  const bodyPreview = useRef<HTMLDivElement>(null);
  const bodyEditor = useRef<HTMLDivElement>(null);
  const previousEditing = useRef(false);
  const [editing, setEditing] = useState(false);
  const [exitIntent, setExitIntent] = useState<EditExitIntent | null>(null);
  const { editPending, onClose, onCloseRequestChange } = props;
  const form = useForm({
    defaultValues: editValues(initial),
    onSubmit: async ({ value }) => {
      const normalized = normalizeEditValues(value);
      const saved = await props.onSave({
        path: props.skill.path,
        baseline: baseline.current,
        ...normalized,
      });
      if (!saved) return;
      baseline.current = previewSkillMd(normalized);
      form.reset(normalized);
      syncBodyScroll("preview");
      setEditing(false);
    },
    onSubmitInvalid: () => {
      formNode.current
        ?.querySelector<HTMLElement>('[aria-invalid="true"]')
        ?.focus();
    },
  });

  function syncBodyScroll(destination: "edit" | "preview"): void {
    const editorScroller =
      bodyEditor.current?.querySelector<HTMLElement>(".cm-scroller") ?? null;
    const source =
      destination === "edit" ? bodyPreview.current : editorScroller;
    const target =
      destination === "edit" ? editorScroller : bodyPreview.current;
    if (source !== null && target !== null) target.scrollTop = source.scrollTop;
  }

  useEffect(() => {
    if (props.raw === lastRaw.current || editing) return;
    lastRaw.current = props.raw;
    const next = skillEditPrefill(props.skill, props.raw);
    baseline.current = next.baseline;
    form.reset(editValues(next));
  }, [editing, form, props.raw, props.skill]);

  useEffect(() => {
    if (editing === previousEditing.current) return;
    previousEditing.current = editing;
    if (editing) nameInput.current?.focus();
    else editButton.current?.focus();
  }, [editing]);

  function finishExit(intent: EditExitIntent): void {
    form.reset();
    setExitIntent(null);
    if (intent === "detail") {
      syncBodyScroll("preview");
      setEditing(false);
    } else {
      props.onClose();
    }
  }

  function requestExit(intent: EditExitIntent): void {
    if (props.editPending || form.state.isSubmitting) return;
    if (!editing) {
      if (intent === "closed") props.onClose();
      return;
    }
    if (form.state.isDefaultValue) {
      finishExit(intent);
      return;
    }
    setExitIntent(intent);
  }

  useEffect(() => {
    function handleCloseRequest(): void {
      if (editPending || form.state.isSubmitting) return;
      if (!editing) {
        onClose();
        return;
      }
      if (form.state.isDefaultValue) {
        form.reset();
        setExitIntent(null);
        onClose();
        return;
      }
      setExitIntent("closed");
    }

    onCloseRequestChange(handleCloseRequest);
    return () => {
      onCloseRequestChange(null);
    };
  }, [editing, form, editPending, onClose, onCloseRequestChange]);

  return (
    <>
      <form
        ref={formNode}
        className="contents"
        onSubmit={(event) => {
          event.preventDefault();
          event.stopPropagation();
          void form.handleSubmit();
        }}
      >
        <EditableSkillHeader
          nameField={
            <form.Field
              name="name"
              validators={{
                onChange: ({ value }) => editNameError(value),
              }}
            >
              {(field) => {
                const error = editNameError(field.state.value);
                return (
                  <div className="min-w-0 flex-1">
                    <div className="grid min-w-0">
                      <p
                        className={cn(
                          "col-start-1 row-start-1 flex h-8 min-w-0 items-center truncate text-title-sm font-semibold text-foreground",
                          editing ? "invisible" : null,
                        )}
                      >
                        {field.state.value}
                      </p>
                      <Input
                        ref={nameInput}
                        id="skill-detail-name"
                        name={field.name}
                        value={field.state.value}
                        onBlur={field.handleBlur}
                        onChange={(event) => {
                          field.handleChange(event.target.value);
                        }}
                        disabled={!editing || props.editPending}
                        aria-invalid={editing ? error !== undefined : undefined}
                        aria-describedby={
                          editing && error !== undefined
                            ? "skill-detail-name-help"
                            : undefined
                        }
                        className={cn(
                          "col-start-1 row-start-1 h-8 text-title-sm font-semibold",
                          editing ? null : "invisible pointer-events-none",
                        )}
                      />
                    </div>
                    {editing && error !== undefined ? (
                      <p
                        id="skill-detail-name-help"
                        className="mt-1.5 text-ui-xs text-destructive"
                      >
                        {error}
                      </p>
                    ) : null}
                  </div>
                );
              }}
            </form.Field>
          }
          descriptionField={
            <form.Field
              name="description"
              validators={{
                onChange: ({ value }) => editDescriptionError(value),
              }}
            >
              {(field) => {
                const error = editDescriptionError(field.state.value);
                const overSoftLimit =
                  field.state.value.trim().length >
                  SKILL_DESCRIPTION_SOFT_LIMIT;
                const help =
                  error ??
                  (overSoftLimit
                    ? `${field.state.value.trim().length} characters — over the ${SKILL_DESCRIPTION_SOFT_LIMIT}-character guideline.`
                    : null);
                return (
                  <div className="min-w-0">
                    <div className="grid">
                      <p
                        className={cn(
                          "col-start-1 row-start-1 min-h-16 py-1 text-ui-sm leading-relaxed text-muted-foreground",
                          editing ? "invisible" : null,
                        )}
                      >
                        {field.state.value.length > 0
                          ? field.state.value
                          : "No description in this skill's frontmatter."}
                      </p>
                      <Textarea
                        id="skill-detail-description"
                        name={field.name}
                        value={field.state.value}
                        onBlur={field.handleBlur}
                        onChange={(event) => {
                          field.handleChange(event.target.value);
                        }}
                        disabled={!editing || props.editPending}
                        aria-label="When to use"
                        aria-invalid={editing ? error !== undefined : undefined}
                        aria-describedby={
                          editing && help !== null
                            ? "skill-detail-description-help"
                            : undefined
                        }
                        className={cn(
                          "col-start-1 row-start-1 max-h-24 min-h-16 resize-none text-ui-sm leading-relaxed",
                          editing ? null : "invisible pointer-events-none",
                        )}
                      />
                    </div>
                    {editing && help !== null ? (
                      <p
                        id="skill-detail-description-help"
                        className={cn(
                          "mt-1.5 text-ui-xs",
                          error === undefined
                            ? "text-muted-foreground"
                            : "text-destructive",
                        )}
                      >
                        {help}
                      </p>
                    ) : null}
                  </div>
                );
              }}
            </form.Field>
          }
          skill={props.skill}
          editing={editing}
          origin={props.origin}
          canUpdate={props.canUpdate}
          updatePending={props.updatePending}
          updateDisabled={props.actionsDisabled}
          onRequestUpdate={props.onRequestUpdate}
        />

        <div className="flex min-h-0 flex-col overflow-hidden px-5 py-4">
          {props.actionError === null ? null : (
            <div className="mb-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-ui-sm text-destructive">
              {props.actionError}
            </div>
          )}
          <form.Field name="body">
            {(field) => (
              <div className="flex min-h-0 flex-1 flex-col gap-2">
                <div className="shrink-0">
                  <p className="text-ui-sm font-medium text-foreground">
                    Instructions
                    {editing ? (
                      <span className="ms-2 text-ui-xs font-normal text-muted-foreground">
                        Markdown
                      </span>
                    ) : null}
                  </p>
                </div>
                <div className="grid min-h-0 flex-1">
                  <div
                    ref={bodyPreview}
                    className={cn(
                      "col-start-1 row-start-1 min-h-0 overflow-auto",
                      editing ? "invisible" : null,
                    )}
                    data-testid="skill-detail-body-preview"
                  >
                    <div className="mx-auto max-w-[72ch] [&_.md-prose]:text-ui [&_.md-prose_h1]:text-title-lg [&_.md-prose_h2]:text-title-md [&_.md-prose_h3]:text-title-sm">
                      <MarkdownPreview value={field.state.value} />
                    </div>
                  </div>
                  <div
                    ref={bodyEditor}
                    className={cn(
                      "col-start-1 row-start-1 min-h-0 overflow-hidden rounded-md border border-input bg-background shadow-xs transition-[color,box-shadow] focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50",
                      editing ? null : "invisible pointer-events-none",
                    )}
                  >
                    <MarkdownEditPreview
                      value={field.state.value}
                      onChange={field.handleChange}
                      readOnly={!editing || props.editPending}
                      placeholder={undefined}
                      ariaLabel="Instructions"
                      testId="skill-detail-instructions"
                      showPreview={false}
                    />
                  </div>
                </div>
              </div>
            )}
          </form.Field>
        </div>

        <DialogFooter className="mx-0 mb-0 flex-row items-center gap-3 rounded-none border-t border-border/40 px-5 py-3 sm:justify-between">
          <StartTruncatedText className="block min-w-0 flex-1 font-mono text-ui-xs text-muted-foreground">
            {props.skill.path}
          </StartTruncatedText>
          {!editing && props.removal.kind === "blocked" ? (
            <span className="min-w-0 text-right text-ui-xs text-muted-foreground">
              {props.removal.reason}
            </span>
          ) : null}
          <form.Subscribe selector={(state) => state.isSubmitting}>
            {(isSubmitting) => (
              <div className="flex shrink-0 items-center gap-2">
                {editing ? (
                  <>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      disabled={props.editPending || isSubmitting}
                      onClick={() => {
                        requestExit("detail");
                      }}
                    >
                      Cancel
                    </Button>
                    <Button
                      type="submit"
                      size="sm"
                      disabled={props.editPending || isSubmitting}
                    >
                      {props.editPending || isSubmitting ? (
                        <MutedAgentSpinner />
                      ) : null}
                      Save changes
                    </Button>
                  </>
                ) : (
                  <>
                    <Button
                      ref={editButton}
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={props.actionsDisabled}
                      onClick={() => {
                        props.onStartEdit();
                        syncBodyScroll("edit");
                        setEditing(true);
                      }}
                    >
                      <Pencil className="size-3.5" />
                      Edit
                    </Button>
                    {props.removal.kind === "removable" ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="destructive"
                        className="shrink-0"
                        disabled={props.actionsDisabled}
                        onClick={props.onRequestRemove}
                      >
                        {props.removePending ? (
                          <MutedAgentSpinner />
                        ) : (
                          <Trash2 className="size-3.5" />
                        )}
                        Remove
                      </Button>
                    ) : null}
                  </>
                )}
              </div>
            )}
          </form.Subscribe>
        </DialogFooter>
      </form>

      <UnsavedSkillChangesDialog
        open={exitIntent !== null}
        onKeepEditing={() => {
          setExitIntent(null);
        }}
        onDiscard={() => {
          if (exitIntent !== null) finishExit(exitIntent);
        }}
      />
    </>
  );
}

function EditableSkillHeader(props: {
  readonly nameField: ReactNode;
  readonly descriptionField: ReactNode;
  readonly skill: ProviderSkill;
  readonly editing: boolean;
  readonly origin: string | null;
  readonly canUpdate: boolean;
  readonly updatePending: boolean;
  readonly updateDisabled: boolean;
  readonly onRequestUpdate: () => void;
}): ReactNode {
  return (
    <DialogHeader className="border-b border-border/40 px-5 py-4 text-left">
      <DialogTitle className="sr-only">{props.skill.name}</DialogTitle>
      <DialogDescription className="sr-only">
        {props.skill.description ?? "Skill details"}
      </DialogDescription>
      <div className="grid min-w-0 grid-cols-[max-content_minmax(0,1fr)] items-start gap-x-4 gap-y-3 pe-7">
        <Label
          className="pt-1.5 text-ui-xs font-medium text-muted-foreground"
          htmlFor="skill-detail-name"
        >
          Name
        </Label>
        <div className="flex min-w-0 items-start gap-2">
          {props.nameField}
          <div className="flex shrink-0 flex-wrap items-center gap-1.5 pt-1">
            <SkillBadges skill={props.skill} />
          </div>
        </div>

        <Label
          className="pt-1 text-ui-xs font-medium text-muted-foreground"
          htmlFor="skill-detail-description"
        >
          When to use
        </Label>
        {props.descriptionField}

        {props.origin === null ? null : (
          <>
            <span className="pt-1.5 text-ui-xs font-medium text-muted-foreground">
              Source
            </span>
            <div className="flex min-h-8 min-w-0 flex-wrap items-center justify-between gap-2">
              <p className="min-w-0 py-1 text-ui-xs text-muted-foreground">
                {props.origin}
              </p>
              {!props.editing && props.canUpdate ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="shrink-0"
                  disabled={props.updateDisabled}
                  onClick={props.onRequestUpdate}
                >
                  {props.updatePending ? (
                    <MutedAgentSpinner />
                  ) : (
                    <RefreshCw className="size-3.5" />
                  )}
                  Update from source
                </Button>
              ) : null}
            </div>
          </>
        )}
      </div>
    </DialogHeader>
  );
}

function UnsavedSkillChangesDialog(props: {
  readonly open: boolean;
  readonly onKeepEditing: () => void;
  readonly onDiscard: () => void;
}): ReactNode {
  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => {
        if (!open) props.onKeepEditing();
      }}
    >
      <DialogContent
        showCloseButton={false}
        className="w-[min(92vw,28rem)] gap-0 overflow-hidden p-0 sm:max-w-md"
        data-testid="skill-unsaved-changes-dialog"
      >
        <div className="flex min-w-0 items-start gap-3 p-5">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-destructive/10 text-destructive">
            <AlertTriangle className="size-4" aria-hidden />
          </div>
          <div className="min-w-0 flex-1 space-y-1.5">
            <DialogTitle className="text-ui font-semibold leading-snug">
              Discard unsaved changes?
            </DialogTitle>
            <DialogDescription className="text-ui-sm leading-relaxed">
              Your edits to this skill will be lost.
            </DialogDescription>
          </div>
        </div>
        <div className="flex justify-end gap-2 border-t border-border/60 bg-foreground/3 px-5 py-3">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={props.onKeepEditing}
          >
            Keep editing
          </Button>
          <Button
            type="button"
            variant="destructive"
            size="sm"
            onClick={props.onDiscard}
          >
            Discard changes
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ReadOnlySkillDetail(props: {
  readonly skill: ProviderSkill;
  readonly removal: SkillRemovability;
  readonly removePending: boolean;
  readonly actionsDisabled: boolean;
  readonly actionError: string | null;
  readonly canUpdate: boolean;
  readonly origin: string | null;
  readonly updatePending: boolean;
  readonly pending: boolean;
  readonly error: string | null;
  readonly content: string | null;
  readonly truncated: boolean;
  readonly onRequestUpdate: () => void;
  readonly onRequestRemove: () => void;
}): ReactNode {
  return (
    <>
      <ReadOnlySkillHeader
        skill={props.skill}
        origin={props.origin}
        canUpdate={props.canUpdate}
        updatePending={props.updatePending}
        updateDisabled={props.actionsDisabled}
        onRequestUpdate={props.onRequestUpdate}
      />
      <div className="flex min-h-0 flex-col overflow-hidden px-5 py-4">
        {props.actionError === null ? null : (
          <div className="mb-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-ui-sm text-destructive">
            {props.actionError}
          </div>
        )}
        <div className="flex min-h-0 flex-1 flex-col gap-2">
          <p className="shrink-0 text-ui-sm font-medium text-foreground">
            Instructions
          </p>
          <SkillBody
            pending={props.pending}
            error={props.error}
            content={props.content}
            truncated={props.truncated}
          />
        </div>
      </div>
      <ReadOnlySkillFooter
        path={props.skill.path}
        removal={props.removal}
        removePending={props.removePending}
        actionsDisabled={props.actionsDisabled}
        onRequestRemove={props.onRequestRemove}
      />
    </>
  );
}

function ReadOnlySkillHeader(props: {
  readonly skill: ProviderSkill;
  readonly origin: string | null;
  readonly canUpdate: boolean;
  readonly updatePending: boolean;
  readonly updateDisabled: boolean;
  readonly onRequestUpdate: () => void;
}): ReactNode {
  return (
    <DialogHeader className="border-b border-border/40 px-5 py-4 text-left">
      <DialogTitle className="sr-only">{props.skill.name}</DialogTitle>
      <DialogDescription className="sr-only">
        {props.skill.description ?? "Skill details"}
      </DialogDescription>
      <div className="grid min-w-0 grid-cols-[max-content_minmax(0,1fr)] items-start gap-x-4 gap-y-3 pe-7">
        <span className="pt-1.5 text-ui-xs font-medium text-muted-foreground">
          Name
        </span>
        <div className="flex min-w-0 items-start gap-2">
          <p className="flex h-8 min-w-0 flex-1 items-center truncate text-title-sm font-semibold text-foreground">
            {props.skill.name}
          </p>
          <div className="flex shrink-0 flex-wrap items-center gap-1.5 pt-1">
            <SkillBadges skill={props.skill} />
          </div>
        </div>

        <span className="pt-1 text-ui-xs font-medium text-muted-foreground">
          When to use
        </span>
        <p className="min-h-16 py-1 text-ui-sm leading-relaxed text-muted-foreground">
          {props.skill.description !== null &&
          props.skill.description.length > 0
            ? props.skill.description
            : "No description in this skill's frontmatter."}
        </p>

        {props.origin === null ? null : (
          <>
            <span className="pt-1.5 text-ui-xs font-medium text-muted-foreground">
              Source
            </span>
            <div className="flex min-h-8 min-w-0 flex-wrap items-center justify-between gap-2">
              <p className="min-w-0 py-1 text-ui-xs text-muted-foreground">
                {props.origin}
              </p>
              {props.canUpdate ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="shrink-0"
                  disabled={props.updateDisabled}
                  onClick={props.onRequestUpdate}
                >
                  {props.updatePending ? (
                    <MutedAgentSpinner />
                  ) : (
                    <RefreshCw className="size-3.5" />
                  )}
                  Update from source
                </Button>
              ) : null}
            </div>
          </>
        )}
      </div>
    </DialogHeader>
  );
}

function SkillBadges({ skill }: { readonly skill: ProviderSkill }): ReactNode {
  return (
    <>
      <Badge
        variant="outline"
        className={cn("rounded-full", SKILL_SOURCE_TONE[skill.source])}
      >
        {SKILL_SOURCE_LABEL[skill.source]}
      </Badge>
      {skill.conflict === true ? (
        <TooltipWrapper
          label={SKILL_CONFLICT_TOOLTIP}
          side="top"
          sideOffset={4}
          align="center"
        >
          <Badge
            variant="outline"
            className={cn("rounded-full", SKILL_CONFLICT_TONE)}
          >
            {SKILL_CONFLICT_LABEL}
          </Badge>
        </TooltipWrapper>
      ) : null}
    </>
  );
}

function ReadOnlySkillFooter(props: {
  readonly path: string;
  readonly removal: SkillRemovability;
  readonly removePending: boolean;
  readonly actionsDisabled: boolean;
  readonly onRequestRemove: () => void;
}): ReactNode {
  return (
    <DialogFooter className="mx-0 mb-0 flex-row items-center gap-3 rounded-none border-t border-border/40 px-5 py-3 sm:justify-between">
      <StartTruncatedText className="block min-w-0 flex-1 font-mono text-ui-xs text-muted-foreground">
        {props.path}
      </StartTruncatedText>
      {props.removal.kind === "blocked" ? (
        <span className="min-w-0 text-right text-ui-xs text-muted-foreground">
          {props.removal.reason}
        </span>
      ) : null}
      {props.removal.kind === "removable" ? (
        <Button
          type="button"
          size="sm"
          variant="destructive"
          className="shrink-0"
          disabled={props.actionsDisabled}
          onClick={props.onRequestRemove}
        >
          {props.removePending ? (
            <MutedAgentSpinner />
          ) : (
            <Trash2 className="size-3.5" />
          )}
          Remove
        </Button>
      ) : null}
    </DialogFooter>
  );
}

function SkillBody(props: {
  readonly pending: boolean;
  readonly error: string | null;
  readonly content: string | null;
  readonly truncated: boolean;
}): ReactNode {
  if (props.pending) {
    return (
      <div className="flex min-h-0 flex-1 items-start gap-2 py-4 text-ui-sm text-muted-foreground">
        <MutedAgentSpinner />
        Loading skill
      </div>
    );
  }
  if (props.error !== null || props.content === null) {
    return (
      <div className="flex min-h-0 flex-1 items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-ui-sm text-amber-900 dark:text-amber-200">
        <FileWarning className="mt-0.5 size-3.5 shrink-0" aria-hidden />
        <span className="min-w-0">
          {props.error ?? `Could not read ${SKILL_ENTRY_FILE}.`}
        </span>
      </div>
    );
  }
  const body = parseSkillMarkdown(props.content).body;
  return (
    <>
      {props.truncated ? (
        <p className="mb-3 rounded-md border border-border/40 bg-foreground/3 px-3 py-2 text-ui-xs text-muted-foreground">
          This skill is large - showing the beginning of the file.
        </p>
      ) : null}
      {body.trim().length === 0 ? (
        <p className="min-h-0 flex-1 py-3 text-ui-sm text-muted-foreground">
          This skill has frontmatter but no instructions.
        </p>
      ) : (
        <div
          className="min-h-0 flex-1 overflow-auto"
          data-testid="skill-detail-body-preview"
        >
          <div className="mx-auto max-w-[72ch] [&_.md-prose]:text-ui [&_.md-prose_h1]:text-title-lg [&_.md-prose_h2]:text-title-md [&_.md-prose_h3]:text-title-sm">
            <MarkdownPreview value={body} />
          </div>
        </div>
      )}
    </>
  );
}

function editValues(target: SkillEditTarget): SkillEditValues {
  return {
    name: target.name,
    description: target.description,
    body: target.body,
  };
}

function normalizeEditValues(values: SkillEditValues): SkillEditValues {
  return {
    name: values.name.trim(),
    description: values.description.trim(),
    body: values.body,
  };
}

function editNameError(value: string): string | undefined {
  if (value.trim().length === 0) return "Give the skill a name.";
  return skillNameError(value) ?? undefined;
}

function editDescriptionError(value: string): string | undefined {
  return value.trim().length === 0
    ? "Add a description — the agent reads it to decide when to use this skill."
    : undefined;
}
