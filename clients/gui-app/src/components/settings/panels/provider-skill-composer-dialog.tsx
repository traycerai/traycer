import { useMemo, useState, type ReactNode } from "react";
import type {
  ProviderNativeScope,
  ProviderSkillInspectCandidate,
  ProvidersSkillsMutateAction,
} from "@traycer/protocol/host/provider-native-schemas";
import { MarkdownEditPreview } from "@/components/markdown-edit-preview";
import { MutedAgentSpinner } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { SelectAllToggle } from "@/components/ui/select-all-toggle";
import { StartTruncatedText } from "@/components/ui/start-truncated-text";
import { Textarea } from "@/components/ui/textarea";
import type { SkillsMutateData } from "@/hooks/providers/native-response-map";
import { cn } from "@/lib/utils";
import { submitComposer } from "./provider-skill-composer-flow";
import {
  skillBodyScaffold,
  skillDestination,
  skillFilePath,
  skillNameError,
  skillSubmitBlocker,
  SKILL_DESCRIPTION_SOFT_LIMIT,
  type SkillAuthoring,
  type SkillComposerStep,
} from "./provider-skill-composer-model";

/**
 * The one surface for getting a skill onto disk.
 *
 * Opens import-first when import is advertised: a smart source field, then
 * either a direct install (one candidate) or a picker. "or write one from
 * scratch" swaps to the authoring form. There is no Write/Import tab strip.
 *
 * Mounted only while open (the caller renders it conditionally), which keeps
 * the draft state's lifetime equal to the dialog's: closing it is what discards
 * a draft, and there is no stale half-filled form waiting behind the button.
 */
export function ProviderSkillComposerDialog(props: {
  readonly providerLabel: string;
  readonly authoring: SkillAuthoring;
  readonly listScope: ProviderNativeScope;
  /** The provider's own skills root, when the listing has revealed it. */
  readonly providerRoot: string | null;
  readonly canProviderScope: boolean;
  readonly pending: boolean;
  readonly onMutate: (
    mutation: ProvidersSkillsMutateAction,
  ) => Promise<SkillsMutateData>;
  readonly onClose: () => void;
}): ReactNode {
  const draft = useComposerDraft(props);

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !props.pending) props.onClose();
      }}
    >
      <DialogContent className="grid max-h-[min(86dvh,calc(100dvh-2rem))] w-[min(92vw,44rem)] grid-rows-[auto_minmax(0,1fr)_auto] gap-0 overflow-hidden p-0 sm:max-w-[min(92vw,44rem)]">
        <DialogHeader className="space-y-2 border-b border-border/40 px-5 py-4 text-left">
          <DialogTitle className="text-ui-lg">
            {titleForStep(
              draft.step,
              draft.inspectSession?.candidates.length ?? 0,
            )}
          </DialogTitle>
          <DialogDescription className="text-ui-sm">
            <ComposerDescription step={draft.step} />
          </DialogDescription>
        </DialogHeader>

        <div className="flex min-h-0 flex-col gap-4 overflow-y-auto px-5 py-4">
          {draft.error === null ? null : (
            <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-ui-sm text-destructive">
              {draft.error}
            </div>
          )}

          {draft.step === "write" ? (
            <WriteFields
              name={draft.name}
              setName={draft.setName}
              nameError={draft.nameError}
              description={draft.description}
              setDescription={draft.setDescription}
              body={draft.body}
              setBody={draft.setBody}
              disabled={props.pending}
              canImport={props.authoring.canImport}
              onImport={draft.goToImport}
            />
          ) : null}
          {draft.step === "import" ? (
            <ImportFields
              source={draft.source}
              setSource={draft.setSource}
              disabled={props.pending}
              canWrite={props.authoring.canWrite}
              onWrite={draft.goToWrite}
            />
          ) : null}
          {draft.step === "picker" && draft.inspectSession !== null ? (
            <PickerFields
              candidates={draft.inspectSession.candidates}
              selectedNames={draft.selectedNames}
              note={draft.pickerNote}
              disabled={props.pending}
              onToggle={(candidateName) => {
                draft.setSelectedNames(
                  draft.selectedNames.includes(candidateName)
                    ? draft.selectedNames.filter(
                        (entry) => entry !== candidateName,
                      )
                    : [...draft.selectedNames, candidateName],
                );
              }}
              onToggleAll={() => {
                const candidateNames = draft.inspectSession?.candidates.map(
                  (candidate) => candidate.name,
                );
                if (candidateNames === undefined) return;
                const selected = new Set(draft.selectedNames);
                draft.setSelectedNames(
                  candidateNames.every((name) => selected.has(name))
                    ? []
                    : candidateNames,
                );
              }}
              onBack={draft.goToImport}
            />
          ) : null}

          {draft.showScope ? (
            <SkillScopeFieldset
              providerLabel={props.providerLabel}
              providerScoped={draft.effectiveProviderScoped}
              disabled={props.pending}
              onChange={draft.setProviderScoped}
            />
          ) : null}
        </div>

        <DialogFooter className="mx-0 mb-0 flex-col items-stretch gap-2 rounded-none border-t border-border/40 px-5 py-3 sm:flex-row sm:items-center sm:justify-between">
          <DestinationLine
            step={draft.step}
            destination={draft.destination.display}
            exact={draft.destination.exact}
            filePath={skillFilePath({
              destination: draft.destination,
              name: draft.name,
            })}
          />
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            {draft.blocker === null ? null : (
              <span className="text-ui-xs text-muted-foreground">
                {draft.blocker}
              </span>
            )}
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={props.pending}
              onClick={props.onClose}
            >
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={props.pending || draft.blocker !== null}
              onClick={() => {
                void draft.onSubmit();
              }}
            >
              {props.pending ? <MutedAgentSpinner /> : null}
              {submitLabel(
                draft.step,
                draft.selectedNames.length,
                props.authoring.canInspect,
              )}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function useComposerDraft(props: {
  readonly authoring: SkillAuthoring;
  readonly listScope: ProviderNativeScope;
  readonly providerLabel: string;
  readonly providerRoot: string | null;
  readonly canProviderScope: boolean;
  readonly pending: boolean;
  readonly onMutate: (
    mutation: ProvidersSkillsMutateAction,
  ) => Promise<SkillsMutateData>;
  readonly onClose: () => void;
}) {
  const [mode, setMode] = useState<"import" | "write">(
    !props.authoring.canImport ? "write" : "import",
  );
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [body, setBody] = useState(skillBodyScaffold);
  const [source, setSource] = useState("");
  const [providerScoped, setProviderScoped] = useState(false);
  const [inspectSession, setInspectSession] = useState<{
    readonly token: string;
    readonly candidates: readonly ProviderSkillInspectCandidate[];
  } | null>(null);
  const [selectedNames, setSelectedNames] = useState<readonly string[]>([]);
  const [pickerNote, setPickerNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const step: SkillComposerStep = inspectSession !== null ? "picker" : mode;
  const effectiveProviderScoped = props.canProviderScope && providerScoped;
  const nameError = useMemo(() => skillNameError(name), [name]);
  const blocker = skillSubmitBlocker({
    step,
    name,
    description,
    source,
    selectedNames,
  });
  const destination = skillDestination({
    providerScoped: effectiveProviderScoped,
    providerLabel: props.providerLabel,
    providerRoot: props.providerRoot,
  });
  const showScope = step !== "picker" && props.canProviderScope;

  function onSubmit(): void {
    void submitComposer({
      step,
      pending: props.pending,
      blocker,
      state: {
        source,
        name,
        description,
        body,
        providerScoped: effectiveProviderScoped,
        selectedNames,
        inspectSession,
        canInspect: props.authoring.canInspect,
        listScope: props.listScope,
      },
      sink: {
        onMutate: props.onMutate,
        onClose: props.onClose,
        setError,
        setInspectSession,
        setSelectedNames,
        setPickerNote,
      },
    });
  }

  function resetTransient(): void {
    setInspectSession(null);
    setSelectedNames([]);
    setPickerNote(null);
    setError(null);
  }

  return {
    name,
    setName,
    nameError,
    description,
    setDescription,
    body,
    setBody,
    source,
    setSource,
    inspectSession,
    selectedNames,
    setSelectedNames,
    pickerNote,
    error,
    step,
    effectiveProviderScoped,
    setProviderScoped,
    destination,
    showScope,
    blocker,
    onSubmit,
    goToWrite: () => {
      setMode("write");
      resetTransient();
    },
    goToImport: () => {
      setMode("import");
      resetTransient();
    },
  };
}

function ComposerDescription({
  step,
}: {
  readonly step: SkillComposerStep;
}): ReactNode {
  if (step === "picker") {
    return "Selecting an installed skill overwrites it from this source.";
  }
  if (step === "import") {
    return "Paste a source. The host clones or copies it and finds every SKILL.md.";
  }
  return (
    <>
      A skill is a folder with a <code>SKILL.md</code> inside it. The agent
      loads one on its own when the work matches, or you can invoke it directly
      with <code>/name</code> in chat.
    </>
  );
}

function titleForStep(step: SkillComposerStep, candidateCount: number): string {
  if (step === "picker") {
    return candidateCount === 1
      ? "1 skill found"
      : `${String(candidateCount)} skills found`;
  }
  return "Add a skill";
}

function submitLabel(
  step: SkillComposerStep,
  selectedCount: number,
  canInspect: boolean,
): string {
  if (step === "write") return "Create skill";
  if (step === "picker") {
    return selectedCount === 1
      ? "Install 1 skill"
      : `Install ${String(selectedCount)} skills`;
  }
  return canInspect ? "Add skill" : "Import skill";
}

function WriteFields({
  name,
  setName,
  nameError,
  description,
  setDescription,
  body,
  setBody,
  disabled,
  canImport,
  onImport,
}: {
  readonly name: string;
  readonly setName: (v: string) => void;
  readonly nameError: string | null;
  readonly description: string;
  readonly setDescription: (v: string) => void;
  readonly body: string;
  readonly setBody: (v: string) => void;
  readonly disabled: boolean;
  readonly canImport: boolean;
  readonly onImport: () => void;
}): ReactNode {
  const overSoftLimit =
    description.trim().length > SKILL_DESCRIPTION_SOFT_LIMIT;
  return (
    <>
      <Field
        htmlFor="skill-name"
        label="Name"
        hint="Becomes the folder name and the /command you type in chat."
        error={nameError}
      >
        <Input
          id="skill-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="review-pr"
          className="text-ui-sm"
          disabled={disabled}
          aria-invalid={nameError !== null}
        />
      </Field>

      <Field
        htmlFor="skill-description"
        label="Description"
        hint="The agent reads this - and only this - to decide whether to load the skill. Say what it does and when it applies, including the words someone would actually use."
        error={null}
      >
        <Textarea
          id="skill-description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Reviews a pull request for correctness and style. Use whenever the user asks for a code review, mentions a PR, or asks to check a diff before merging."
          className="min-h-[4.5rem] text-ui-sm"
          disabled={disabled}
        />
        {overSoftLimit ? (
          <p className="text-ui-xs text-muted-foreground">
            {description.trim().length} characters - over the{" "}
            {SKILL_DESCRIPTION_SOFT_LIMIT}-character guideline. Long
            descriptions are harder for the agent to match against.
          </p>
        ) : null}
      </Field>

      <div className="flex min-h-48 flex-col gap-1.5">
        <div className="flex flex-col gap-1">
          <span className="text-ui-sm font-medium text-foreground">
            Instructions
          </span>
          <p className="text-ui-xs text-muted-foreground">
            Markdown the agent follows once the skill loads. The name and
            description above become the YAML frontmatter - you don&apos;t write
            it yourself.
          </p>
        </div>
        <div className="flex min-h-48 flex-1 flex-col overflow-hidden rounded-md border border-border/60">
          <MarkdownEditPreview
            value={body}
            onChange={setBody}
            readOnly={disabled}
            placeholder={undefined}
            ariaLabel="Instructions"
            testId="skill-composer-instructions"
            showPreview
          />
        </div>
      </div>
      {canImport ? (
        <button
          type="button"
          className="self-start text-ui-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
          disabled={disabled}
          onClick={onImport}
        >
          or import an existing one
        </button>
      ) : null}
    </>
  );
}

function ImportFields({
  source,
  setSource,
  disabled,
  canWrite,
  onWrite,
}: {
  readonly source: string;
  readonly setSource: (v: string) => void;
  readonly disabled: boolean;
  readonly canWrite: boolean;
  readonly onWrite: () => void;
}): ReactNode {
  return (
    <>
      <Field
        htmlFor="skill-import-source"
        label="Skill source"
        hint="Paste an npx skills command, owner/repo, git or tree URL, or a folder path."
        error={null}
      >
        <Input
          id="skill-import-source"
          value={source}
          onChange={(e) => setSource(e.target.value)}
          placeholder="npx skills add owner/repo"
          className="text-ui-sm"
          disabled={disabled}
        />
      </Field>
      {canWrite ? (
        <button
          type="button"
          className="self-start text-ui-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
          disabled={disabled}
          onClick={onWrite}
        >
          or write one from scratch
        </button>
      ) : null}
    </>
  );
}

function PickerFields({
  candidates,
  selectedNames,
  note,
  disabled,
  onToggle,
  onToggleAll,
  onBack,
}: {
  readonly candidates: readonly ProviderSkillInspectCandidate[];
  readonly selectedNames: readonly string[];
  readonly note: string | null;
  readonly disabled: boolean;
  readonly onToggle: (name: string) => void;
  readonly onToggleAll: () => void;
  readonly onBack: () => void;
}): ReactNode {
  const selected = new Set(selectedNames);
  return (
    <div className="flex flex-col gap-3">
      {note === null ? null : (
        <div className="rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-ui-sm text-foreground">
          {note}
        </div>
      )}
      <div className="flex items-center justify-between gap-3">
        <span className="text-ui-xs text-muted-foreground">
          {selectedNames.length} of {candidates.length} selected
        </span>
        <SelectAllToggle
          accessibleLabel="Select all skills"
          selectableCount={candidates.length}
          selectedCount={selectedNames.length}
          disabled={disabled}
          testId="skill-picker-select-all"
          onToggle={onToggleAll}
        />
      </div>
      <ul className="flex flex-col gap-2">
        {candidates.map((candidate) => (
          <PickerRow
            key={candidate.relPath}
            candidate={candidate}
            checked={selected.has(candidate.name)}
            disabled={disabled}
            onToggle={onToggle}
          />
        ))}
      </ul>
      <button
        type="button"
        className="self-start text-ui-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
        disabled={disabled}
        onClick={onBack}
      >
        Choose a different source
      </button>
    </div>
  );
}

function PickerRow({
  candidate,
  checked,
  disabled,
  onToggle,
}: {
  readonly candidate: ProviderSkillInspectCandidate;
  readonly checked: boolean;
  readonly disabled: boolean;
  readonly onToggle: (name: string) => void;
}): ReactNode {
  const description =
    candidate.description !== null && candidate.description.length > 0
      ? candidate.description
      : null;
  return (
    <li>
      <label
        className={cn(
          "flex items-start gap-3 rounded-md border border-border/60 px-3 py-2",
          disabled ? "opacity-60" : null,
        )}
      >
        <Checkbox
          className="mt-0.5"
          checked={checked}
          disabled={disabled}
          aria-label={candidate.name}
          onCheckedChange={() => {
            onToggle(candidate.name);
          }}
        />
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 flex-wrap items-center gap-2">
            <span className="truncate text-ui-sm font-medium text-foreground">
              {candidate.name}
            </span>
            {candidate.installed ? (
              <span className="rounded-full border border-border/60 px-1.5 py-0.5 text-ui-xs text-muted-foreground">
                installed
              </span>
            ) : null}
          </span>
          {description === null ? null : (
            <span className="mt-0.5 block text-ui-xs text-muted-foreground">
              {description}
            </span>
          )}
        </span>
      </label>
    </li>
  );
}

function Field({
  htmlFor,
  label,
  hint,
  error,
  children,
}: {
  readonly htmlFor: string;
  readonly label: string;
  readonly hint: string;
  readonly error: string | null;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <div className="flex flex-col gap-1.5">
      <label
        className="text-ui-sm font-medium text-foreground"
        htmlFor={htmlFor}
      >
        {label}
      </label>
      <p className="text-ui-xs text-muted-foreground">{hint}</p>
      {children}
      {error === null ? null : (
        <p className="text-ui-xs text-destructive">{error}</p>
      )}
    </div>
  );
}

function DestinationLine({
  step,
  destination,
  exact,
  filePath,
}: {
  readonly step: SkillComposerStep;
  readonly destination: string;
  readonly exact: boolean;
  readonly filePath: string;
}): ReactNode {
  const shown = step === "write" ? filePath : destination;
  return (
    <span className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-1.5 text-ui-xs text-muted-foreground">
      <span className="shrink-0">Saves to</span>
      {exact ? (
        <StartTruncatedText className="block min-w-0 flex-1 font-mono text-ui-xs">
          {shown}
        </StartTruncatedText>
      ) : (
        <span className="min-w-0">{shown}</span>
      )}
    </span>
  );
}

function SkillScopeFieldset({
  providerLabel,
  providerScoped,
  disabled,
  onChange,
}: {
  readonly providerLabel: string;
  readonly providerScoped: boolean;
  readonly disabled: boolean;
  readonly onChange: (providerScoped: boolean) => void;
}): ReactNode {
  return (
    <fieldset className="flex flex-col gap-1.5">
      <legend className="text-ui-sm font-medium text-foreground">
        Available to
      </legend>
      <label
        className={cn(
          "flex items-start gap-2 text-ui-sm text-foreground",
          disabled ? "opacity-60" : null,
        )}
      >
        <input
          type="radio"
          name="skill-composer-scope"
          className="mt-1"
          checked={!providerScoped}
          onChange={() => onChange(false)}
          disabled={disabled}
        />
        <span className="min-w-0">
          Every provider
          <span className="block text-ui-xs text-muted-foreground">
            Stored once in the shared skills folder and picked up by any agent
            that reads it.
          </span>
        </span>
      </label>
      <label
        className={cn(
          "flex items-start gap-2 text-ui-sm text-foreground",
          disabled ? "opacity-60" : null,
        )}
      >
        <input
          type="radio"
          name="skill-composer-scope"
          className="mt-1"
          checked={providerScoped}
          onChange={() => onChange(true)}
          disabled={disabled}
        />
        <span className="min-w-0">
          {providerLabel} only
          <span className="block text-ui-xs text-muted-foreground">
            Stored in {providerLabel}&apos;s own skills folder.
          </span>
        </span>
      </label>
    </fieldset>
  );
}
