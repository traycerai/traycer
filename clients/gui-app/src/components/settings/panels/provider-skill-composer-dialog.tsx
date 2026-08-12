import { useMemo, useState, type ReactNode } from "react";
import type { ProvidersSkillsMutateAction } from "@traycer/protocol/host/provider-native-schemas";
import { MutedAgentSpinner } from "@/components/ui/agent-spinning-dots";
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
import { StartTruncatedText } from "@/components/ui/start-truncated-text";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import {
  previewSkillMd,
  skillBodyScaffold,
  skillComposerTabs,
  skillDestination,
  skillFilePath,
  skillNameError,
  skillSubmitBlocker,
  SKILL_DESCRIPTION_SOFT_LIMIT,
  type SkillAuthoring,
  type SkillComposerTab,
} from "./provider-skill-composer-model";

/**
 * The one surface for getting a skill onto disk.
 *
 * It replaces a `New ▾` menu whose item count was a function of the capability
 * table (and was therefore always one — every provider contract shipped
 * `create: []`) plus two inline panels that pushed the list down the page.
 * Writing and importing are tabs INSIDE this dialog rather than a choice made
 * before anything is visible, so no capability difference can collapse the
 * entry point into a menu-of-one again.
 *
 * Mounted only while open (the caller renders it conditionally), which keeps
 * the draft state's lifetime equal to the dialog's: closing it is what discards
 * a draft, and there is no stale half-filled form waiting behind the button.
 */
export function ProviderSkillComposerDialog(props: {
  readonly providerLabel: string;
  readonly authoring: SkillAuthoring;
  /** Which tab opens first. The caller picks it from the button that was hit. */
  readonly initialTab: SkillComposerTab;
  /** The provider's own skills root, when the listing has revealed it. */
  readonly providerRoot: string | null;
  readonly pending: boolean;
  /** A failed create/import, surfaced here rather than behind the dialog. */
  readonly error: string | null;
  readonly onSubmit: (mutation: ProvidersSkillsMutateAction) => void;
  readonly onClose: () => void;
}): ReactNode {
  const tabs = skillComposerTabs(props.authoring);
  const [tab, setTab] = useState<SkillComposerTab>(props.initialTab);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  // Seeded with the scaffold rather than left empty: the headings are the part
  // that is hard to invent and cheap to delete.
  const [body, setBody] = useState(skillBodyScaffold);
  const [source, setSource] = useState("");
  const [providerScoped, setProviderScoped] = useState(false);
  const [showPreview, setShowPreview] = useState(false);

  const nameError = useMemo(() => skillNameError(name), [name]);
  const blocker = skillSubmitBlocker({ tab, name, description, source });
  const destination = skillDestination({
    providerScoped,
    providerLabel: props.providerLabel,
    providerRoot: props.providerRoot,
  });

  function onSubmit(): void {
    if (blocker !== null || props.pending) return;
    if (tab === "write") {
      props.onSubmit({
        action: "create",
        name: name.trim(),
        description: description.trim(),
        body,
        providerScoped,
      });
      return;
    }
    // One field drives both git URLs and local folders: the host's `import`
    // arm already branches on the shape of the string (clone vs. copy), so
    // asking the user which one they have would be asking a question we can
    // answer ourselves.
    props.onSubmit({
      action: "import",
      source: source.trim(),
      providerScoped,
    });
  }

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
            {tabs.length > 0 ? "Add a skill" : titleForSingleTab(tab)}
          </DialogTitle>
          <DialogDescription className="text-ui-sm">
            A skill is a folder with a <code>SKILL.md</code> inside it. The
            agent loads one on its own when the work matches, or you can invoke
            it directly with <code>/name</code> in chat.
          </DialogDescription>
        </DialogHeader>

        <div className="flex min-h-0 flex-col gap-4 overflow-y-auto px-5 py-4">
          {props.error === null ? null : (
            <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-ui-sm text-destructive">
              {props.error}
            </div>
          )}

          <ComposerFields
            tabs={tabs}
            tab={tab}
            setTab={setTab}
            write={
              <WriteFields
                name={name}
                setName={setName}
                nameError={nameError}
                description={description}
                setDescription={setDescription}
                body={body}
                setBody={setBody}
                showPreview={showPreview}
                setShowPreview={setShowPreview}
                disabled={props.pending}
              />
            }
            importFields={
              <ImportFields
                source={source}
                setSource={setSource}
                disabled={props.pending}
              />
            }
          />

          <SkillScopeFieldset
            providerLabel={props.providerLabel}
            providerScoped={providerScoped}
            disabled={props.pending}
            onChange={setProviderScoped}
          />
        </div>

        <DialogFooter className="mx-0 mb-0 flex-col items-stretch gap-2 rounded-none border-t border-border/40 px-5 py-3 sm:flex-row sm:items-center sm:justify-between">
          <DestinationLine
            tab={tab}
            destination={destination.display}
            exact={destination.exact}
            filePath={skillFilePath({ destination, name })}
          />
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            {blocker === null ? null : (
              <span className="text-ui-xs text-muted-foreground">
                {blocker}
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
              disabled={props.pending || blocker !== null}
              onClick={onSubmit}
            >
              {props.pending ? <MutedAgentSpinner /> : null}
              {tab === "write" ? "Create skill" : "Import skill"}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function titleForSingleTab(tab: SkillComposerTab): string {
  return tab === "write" ? "Write a new skill" : "Import a skill";
}

/**
 * The two field sets, under a tab strip when there is a choice to make.
 *
 * A provider offering only one path gets the fields bare rather than a
 * one-tab strip that looks like a control but selects nothing. The tabbed arm
 * renders real `TabsContent` panels — a `TabsTrigger` with no panel to own
 * points `aria-controls` at an element that does not exist.
 */
function ComposerFields({
  tabs,
  tab,
  setTab,
  write,
  importFields,
}: {
  readonly tabs: readonly SkillComposerTab[];
  readonly tab: SkillComposerTab;
  readonly setTab: (tab: SkillComposerTab) => void;
  readonly write: ReactNode;
  readonly importFields: ReactNode;
}): ReactNode {
  if (tabs.length === 0) return tab === "write" ? write : importFields;
  return (
    <Tabs
      value={tab}
      onValueChange={(next) => {
        setTab(next === "import" ? "import" : "write");
      }}
      className="gap-4"
    >
      <TabsList>
        <TabsTrigger value="write">Write a new one</TabsTrigger>
        <TabsTrigger value="import">Import an existing one</TabsTrigger>
      </TabsList>
      <TabsContent value="write" className="flex flex-col gap-4">
        {write}
      </TabsContent>
      <TabsContent value="import" className="flex flex-col gap-4">
        {importFields}
      </TabsContent>
    </Tabs>
  );
}

function WriteFields({
  name,
  setName,
  nameError,
  description,
  setDescription,
  body,
  setBody,
  showPreview,
  setShowPreview,
  disabled,
}: {
  readonly name: string;
  readonly setName: (v: string) => void;
  readonly nameError: string | null;
  readonly description: string;
  readonly setDescription: (v: string) => void;
  readonly body: string;
  readonly setBody: (v: string) => void;
  readonly showPreview: boolean;
  readonly setShowPreview: (v: boolean) => void;
  readonly disabled: boolean;
}): ReactNode {
  const overSoftLimit =
    description.trim().length > SKILL_DESCRIPTION_SOFT_LIMIT;
  return (
    <>
      <Field
        htmlFor="skill-name"
        label="Name"
        // The invocation form is the whole reason the name is constrained;
        // saying so is what makes the lowercase-and-hyphens rule read as a
        // consequence rather than an arbitrary validation.
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
        // This is the field the user is most likely to treat as a throwaway
        // label, and the one that decides whether the skill is ever used.
        hint="The agent reads this — and only this — to decide whether to load the skill. Say what it does and when it applies, including the words someone would actually use."
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
            {description.trim().length} characters — over the{" "}
            {SKILL_DESCRIPTION_SOFT_LIMIT}-character guideline. Long
            descriptions are harder for the agent to match against.
          </p>
        ) : null}
      </Field>

      <div className="flex flex-col gap-1.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <label
            className="text-ui-sm font-medium text-foreground"
            htmlFor="skill-body"
          >
            Instructions
          </label>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="text-ui-xs"
            onClick={() => setShowPreview(!showPreview)}
          >
            {showPreview ? "Edit" : "Preview SKILL.md"}
          </Button>
        </div>
        <p className="text-ui-xs text-muted-foreground">
          Markdown the agent follows once the skill loads. The name and
          description above become the YAML frontmatter — you don&apos;t write
          it yourself.
        </p>
        {showPreview ? (
          <pre className="max-h-[24rem] overflow-auto rounded-md border border-border/60 bg-muted/30 px-3 py-2 font-mono text-ui-xs whitespace-pre-wrap text-foreground">
            {previewSkillMd({ name, description, body })}
          </pre>
        ) : (
          <Textarea
            id="skill-body"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            className="min-h-[12rem] font-mono text-ui-xs"
            disabled={disabled}
          />
        )}
      </div>
    </>
  );
}

function ImportFields({
  source,
  setSource,
  disabled,
}: {
  readonly source: string;
  readonly setSource: (v: string) => void;
  readonly disabled: boolean;
}): ReactNode {
  return (
    <Field
      htmlFor="skill-import-source"
      label="Git URL or folder path"
      hint="The repository or folder must contain a SKILL.md, either at its root or one level down."
      error={null}
    >
      <Input
        id="skill-import-source"
        value={source}
        onChange={(e) => setSource(e.target.value)}
        placeholder="https://github.com/org/skill.git"
        className="text-ui-sm"
        disabled={disabled}
      />
      <p className="text-ui-xs text-muted-foreground">
        A git URL is cloned; a path on this machine is copied. The skill keeps
        the name from its own frontmatter.
      </p>
    </Field>
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

/**
 * Where the file lands, spelled out before the write rather than after it.
 *
 * Falls back to prose (`exact: false`) when the provider's own root has not
 * been revealed by the listing yet — an invented path here would be worse than
 * an honest sentence.
 */
function DestinationLine({
  tab,
  destination,
  exact,
  filePath,
}: {
  readonly tab: SkillComposerTab;
  readonly destination: string;
  readonly exact: boolean;
  readonly filePath: string;
}): ReactNode {
  const shown = tab === "write" ? filePath : destination;
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
