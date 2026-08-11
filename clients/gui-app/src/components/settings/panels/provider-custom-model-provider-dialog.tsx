import {
  cloneElement,
  isValidElement,
  useCallback,
  useId,
  useMemo,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";
import { Plus, Trash2 } from "lucide-react";
import { MutedAgentSpinner } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { GenericModelProviderIcon } from "@/components/home/pickers/model-provider-icons";
import { useRunnerOpenExternalLink } from "@/hooks/runner/use-open-external-link-mutation";
import { cn } from "@/lib/utils";
import {
  customProviderDraftFrom,
  customProviderValues,
  emptyCustomProviderDraft,
  emptyCustomProviderHeaderRow,
  emptyCustomProviderModelRow,
  relockCustomProviderDraft,
  suggestCustomProviderId,
  validateCustomProviderDraft,
  type CustomProviderDraft,
  type CustomProviderRowErrors,
  type CustomProviderValues,
  type StoredCustomKeys,
} from "./model-provider-custom-draft";

/**
 * The docs upstream's own dialog links, so a user following either app lands on
 * the same page.
 */
const CUSTOM_PROVIDER_DOCS_URL =
  "https://opencode.ai/docs/providers/#custom-provider";

/**
 * Re-lock the draft whenever the catalog's reading of this provider changes.
 *
 * DURING RENDER, guarded by the snapshot's identity - the same shape the tab
 * uses to adopt a resumed OAuth attempt, and for the same reason: this is
 * adjusting state to a prop that changed, so an effect would only add a commit
 * and a frame that still shows the stale locks. The snapshot is memoized by the
 * tab, so the guard settles in one pass and no-ops thereafter.
 *
 * The case it exists for: the host commits a config block before it reports the
 * credential step, so a write that FAILED can still have stored rows this form
 * opened believing were unsaved.
 */
function useRelockAgainstCatalog(args: {
  readonly stored: StoredCustomKeys;
  readonly setDraft: Dispatch<SetStateAction<CustomProviderDraft>>;
}): void {
  const [relockedAgainst, setRelockedAgainst] =
    useState<StoredCustomKeys | null>(null);
  if (relockedAgainst === args.stored) return;
  setRelockedAgainst(args.stored);
  args.setDraft((current) => relockCustomProviderDraft(current, args.stored));
}

/**
 * Declare (or edit) an OpenAI-compatible provider the catalog does not ship.
 *
 * A DELIBERATE MIRROR of upstream's `CustomProviderForm`: same fields in the
 * same order, same copy, same helper text, same row editors. Matching their
 * rules while inventing the surface around them is not a mirror: the point is
 * that a user who knows one app can use the other without relearning it.
 *
 * EDIT is ours, not theirs. Upstream has no edit mode at all: you re-declare a
 * provider with the same id, which their exists-check permits only while it is
 * disabled. Ours opens the form on the current values with the id locked, which
 * is strictly more capable and is the only way to repair a hand-broken
 * declaration.
 *
 * The submit path is a PROP rather than a mutation hook of its own. The tab
 * owns which host and provider this is for and already holds the invalidation
 * story for the list.
 */
export function ProviderCustomModelProviderDialog(props: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly providerLabel: string;
  /** Ids already in the catalog - a new provider may not shadow one. */
  readonly takenIds: readonly string[];
  /**
   * Ids currently suppressed in the provider's config.
   *
   * Upstream skips the already-exists check for these, because re-declaring a
   * disabled custom provider is how their app re-enables it.
   */
  readonly disabledIds: readonly string[];
  /** The provider being edited, or null when declaring a new one. */
  readonly initial: CustomProviderValues | null;
  /**
   * What the config declares for this provider RIGHT NOW, from the catalog.
   *
   * The form's own locks are a snapshot of when it opened, and a partially
   * committed write moves the config underneath them - see
   * {@link relockCustomProviderDraft}.
   */
  readonly stored: StoredCustomKeys;
  readonly isPending: boolean;
  /** Inline failure from the last submit, already redacted, or null. */
  readonly submitError: string | null;
  readonly onSubmit: (values: CustomProviderValues) => void;
}): ReactNode {
  const initialValues = props.initial;
  const editing = initialValues !== null;
  const [draft, setDraft] = useState<CustomProviderDraft>(() =>
    initialValues === null
      ? emptyCustomProviderDraft()
      : customProviderDraftFrom(initialValues),
  );
  // Whether the id is still following the name. An edit starts detached - the
  // id is already fixed, and re-deriving it from a renamed provider would
  // propose changing the key every stored model reference is built from.
  const [idPinned, setIdPinned] = useState(editing);

  useRelockAgainstCatalog({ stored: props.stored, setDraft });

  const openExternalLink = useRunnerOpenExternalLink();
  const fieldId = useId();
  const propTakenIds = props.takenIds;
  const initialId = initialValues?.modelProviderId ?? null;
  const takenIds = useMemo(
    () =>
      initialId === null
        ? propTakenIds
        : propTakenIds.filter((id) => id !== initialId),
    [initialId, propTakenIds],
  );
  const disabledIds = props.disabledIds;
  const scope = useMemo(
    // An edit judges the id as an EXISTING one: the field is disabled anyway,
    // so the minting rules could only condemn a declaration the user cannot
    // change from this form.
    () => ({ takenIds, disabledIds, existing: editing }),
    [disabledIds, editing, takenIds],
  );
  // Validated continuously, SHOWN only after a submit attempt - upstream's
  // behaviour, and the reason their Submit stays live. Disabling it instead
  // turns a blank form into a dead button whose reasons are all invisible,
  // because the errors it is waiting for are exactly the ones a
  // blank form has.
  const [showErrors, setShowErrors] = useState(false);
  const errors = validateCustomProviderDraft(draft, scope);
  const shown = showErrors ? errors : null;

  const handleNameChange = useCallback(
    (name: string) => {
      setDraft((current) => ({
        ...current,
        name,
        providerId: idPinned
          ? current.providerId
          : suggestCustomProviderId(name),
      }));
    },
    [idPinned],
  );

  const handleSubmit = useCallback(() => {
    if (props.isPending) return;
    const values = customProviderValues(draft, scope);
    if (values === null) {
      // Every field at once. This is four short fields and two row lists;
      // revealing them one submit at a time would turn one fix into several
      // rounds.
      setShowErrors(true);
      return;
    }
    props.onSubmit(values);
  }, [draft, props, scope]);

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="flex max-h-[85vh] w-full max-w-lg flex-col overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {/* Always the generic mark: a provider the user declared has no
             * brand of its own, and borrowing one would put a real company's
             * logo on someone's private gateway. */}
            <GenericModelProviderIcon aria-hidden className="size-4 shrink-0" />
            {editing ? "Edit custom provider" : "Custom provider"}
          </DialogTitle>
          <DialogDescription>
            Configure an OpenAI-compatible provider. See the{" "}
            <button
              type="button"
              // The shell owns external navigation - the renderer has no
              // browser to hand a URL to, which is the same route the connect
              // dialog's authorization link takes.
              className="underline underline-offset-2 hover:text-foreground"
              onClick={() => {
                openExternalLink.mutate(CUSTOM_PROVIDER_DOCS_URL);
              }}
            >
              provider config docs
            </button>
            .
          </DialogDescription>
        </DialogHeader>

        <form
          className="flex w-full flex-col gap-6"
          onSubmit={(event) => {
            event.preventDefault();
            handleSubmit();
          }}
        >
          <div className="flex w-full flex-col gap-4">
            <Field
              id={`${fieldId}-provider-id`}
              label="Provider ID"
              hint="Lowercase letters, numbers, hyphens, or underscores"
              error={shown?.providerId ?? null}
            >
              <Input
                id={`${fieldId}-provider-id`}
                value={draft.providerId}
                placeholder="myprovider"
                autoComplete="off"
                spellCheck={false}
                // An existing provider's id is its config key and the name every
                // stored model reference is built from, so a rename here would
                // be a delete and a create wearing one button.
                disabled={editing}
                onChange={(event) => {
                  setIdPinned(true);
                  setDraft((current) => ({
                    ...current,
                    providerId: event.target.value,
                  }));
                }}
              />
            </Field>

            <Field
              id={`${fieldId}-name`}
              label="Display name"
              hint={null}
              error={shown?.name ?? null}
            >
              <Input
                id={`${fieldId}-name`}
                value={draft.name}
                placeholder="My AI Provider"
                autoComplete="off"
                onChange={(event) => {
                  handleNameChange(event.target.value);
                }}
              />
            </Field>

            <Field
              id={`${fieldId}-base-url`}
              label="Base URL"
              hint={null}
              error={shown?.baseUrl ?? null}
            >
              <Input
                id={`${fieldId}-base-url`}
                value={draft.baseUrl}
                placeholder="https://api.myprovider.com/v1"
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => {
                  setDraft((current) => ({
                    ...current,
                    baseUrl: event.target.value,
                  }));
                }}
              />
            </Field>

            <Field
              id={`${fieldId}-api-key`}
              label="API key"
              hint={
                editing
                  ? // The stored secret is never read back, so an edit cannot
                    // show it - and neither can one field show several env
                    // fallbacks. Untouched keeps whatever is there; typing
                    // replaces it. CLEARING is the third state and it is real
                    // now, so the copy has to name it rather than promise that
                    // an empty field is always harmless: a restored
                    // `{env:VAR}` the user deletes is a deletion.
                    "Optional. Untouched keeps the saved key and env fallbacks; clearing a restored {env:VAR} removes it."
                  : "Optional. Leave empty if you manage auth via headers."
              }
              error={null}
            >
              <Input
                id={`${fieldId}-api-key`}
                value={draft.apiKey}
                placeholder="API key"
                type="password"
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => {
                  setDraft((current) => ({
                    ...current,
                    apiKey: event.target.value,
                    // From here the field REPLACES whatever the row arrived
                    // with; until now it was only proposing to.
                    apiKeyEdited: true,
                  }));
                }}
              />
            </Field>
          </div>

          <RowSection
            label="Models"
            note={
              draft.models.some((model) => model.locked)
                ? "Saved models can be renamed but not removed - their IDs are fixed. To drop one, disable this provider and declare it again under a new ID."
                : null
            }
            addLabel="Add model"
            onAdd={() => {
              setDraft((current) => ({
                ...current,
                models: [...current.models, emptyCustomProviderModelRow()],
              }));
            }}
          >
            {draft.models.map((model, index) => (
              <EditorRow
                key={model.row}
                rowId={`${fieldId}-model-${model.row}`}
                firstLabel="ID"
                firstPlaceholder="model-id"
                firstValue={model.id}
                secondLabel="Name"
                secondPlaceholder="Display Name"
                secondValue={model.name}
                errors={shown?.models[index]}
                locked={model.locked}
                removeLabel={`Remove model ${String(index + 1)}`}
                // Upstream keeps the last row: the section is required, and a
                // list you can empty is one whose Add button is its only
                // content.
                removeDisabled={draft.models.length <= 1}
                onFirstChange={(value) => {
                  setDraft((current) => ({
                    ...current,
                    models: current.models.map((row, at) =>
                      at === index ? { ...row, id: value } : row,
                    ),
                  }));
                }}
                onSecondChange={(value) => {
                  setDraft((current) => ({
                    ...current,
                    models: current.models.map((row, at) =>
                      at === index ? { ...row, name: value } : row,
                    ),
                  }));
                }}
                onRemove={() => {
                  setDraft((current) => ({
                    ...current,
                    models: current.models.filter((_, at) => at !== index),
                  }));
                }}
              />
            ))}
          </RowSection>

          <RowSection
            label="Headers (optional)"
            note={
              draft.headers.some((header) => header.locked)
                ? "Saved headers can have their value changed but not be removed - their names are fixed. Dropping one takes the same route: disable this provider and declare it again."
                : null
            }
            addLabel="Add header"
            onAdd={() => {
              setDraft((current) => ({
                ...current,
                headers: [...current.headers, emptyCustomProviderHeaderRow()],
              }));
            }}
          >
            {draft.headers.map((header, index) => (
              <EditorRow
                key={header.row}
                rowId={`${fieldId}-header-${header.row}`}
                firstLabel="Header"
                firstPlaceholder="Header-Name"
                firstValue={header.key}
                secondLabel="Value"
                secondPlaceholder="value"
                secondValue={header.value}
                errors={shown?.headers[index]}
                locked={header.locked}
                removeLabel={`Remove header ${String(index + 1)}`}
                removeDisabled={draft.headers.length <= 1}
                onFirstChange={(value) => {
                  setDraft((current) => ({
                    ...current,
                    headers: current.headers.map((row, at) =>
                      at === index ? { ...row, key: value } : row,
                    ),
                  }));
                }}
                onSecondChange={(value) => {
                  setDraft((current) => ({
                    ...current,
                    headers: current.headers.map((row, at) =>
                      at === index ? { ...row, value } : row,
                    ),
                  }));
                }}
                onRemove={() => {
                  setDraft((current) => ({
                    ...current,
                    headers: current.headers.filter((_, at) => at !== index),
                  }));
                }}
              />
            ))}
          </RowSection>

          {props.submitError !== null ? (
            <p className="text-ui-xs text-destructive" role="alert">
              {props.submitError}
            </p>
          ) : null}

          <div className="flex w-full items-center justify-end gap-2">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => {
                props.onOpenChange(false);
              }}
            >
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={props.isPending}>
              {props.isPending ? <MutedAgentSpinner /> : null}
              Submit
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * A labelled field whose message is ANNOUNCED with it.
 *
 * The message carries an id the control points at through `aria-describedby`,
 * and an invalid one also sets `aria-invalid`. Without that the error is a
 * paragraph that happens to sit nearby: sighted users infer the association
 * from proximity, and a screen reader gets the label and the box with nothing
 * saying why it was rejected. `RowField` already did this; this one did not.
 */
function Field(props: {
  readonly id: string;
  readonly label: string;
  readonly hint: string | null;
  readonly error: string | null;
  readonly children: ReactNode;
}): ReactNode {
  const message = props.error ?? props.hint;
  const messageId = `${props.id}-message`;
  return (
    <div className="flex w-full flex-col gap-1.5">
      <Label htmlFor={props.id}>{props.label}</Label>
      {isValidElement<{
        readonly "aria-describedby"?: string;
        readonly "aria-invalid"?: boolean;
      }>(props.children)
        ? cloneElement(props.children, {
            "aria-describedby": message === null ? undefined : messageId,
            "aria-invalid": props.error !== null,
          })
        : props.children}
      {message === null ? null : (
        <p
          id={messageId}
          className={cn(
            "text-ui-xs",
            props.error === null ? "text-muted-foreground" : "text-destructive",
          )}
        >
          {message}
        </p>
      )}
    </div>
  );
}

function RowSection(props: {
  readonly label: string;
  /** Why stored rows cannot be removed, or null when none can be. */
  readonly note: string | null;
  readonly addLabel: string;
  readonly onAdd: () => void;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <div className="flex w-full flex-col gap-3">
      <span className="text-ui-xs font-medium text-muted-foreground">
        {props.label}
      </span>
      {props.note === null ? null : (
        <p className="text-ui-xs text-muted-foreground">{props.note}</p>
      )}
      {props.children}
      <Button
        type="button"
        size="sm"
        variant="ghost"
        className="self-start"
        onClick={props.onAdd}
      >
        <Plus className="size-3.5" />
        {props.addLabel}
      </Button>
    </div>
  );
}

/**
 * One two-column row with a trailing remove.
 *
 * Column labels are rendered for assistive tech only - upstream hides them too
 * (`hideLabel`), because a header repeated down every row is noise once the
 * placeholders have said the same thing.
 */
function EditorRow(props: {
  readonly rowId: string;
  readonly firstLabel: string;
  readonly firstPlaceholder: string;
  readonly firstValue: string;
  readonly secondLabel: string;
  readonly secondPlaceholder: string;
  readonly secondValue: string;
  readonly errors: CustomProviderRowErrors | undefined;
  /**
   * Whether this row is already stored - see `StoredRow` on the draft module
   * for what the merge can and cannot express. Locks the KEY and drops the
   * remove entirely.
   */
  readonly locked: boolean;
  readonly removeLabel: string;
  readonly removeDisabled: boolean;
  readonly onFirstChange: (value: string) => void;
  readonly onSecondChange: (value: string) => void;
  readonly onRemove: () => void;
}): ReactNode {
  const firstError = props.errors?.first ?? null;
  const secondError = props.errors?.second ?? null;
  return (
    <div className="flex w-full items-start gap-2">
      <RowField
        id={`${props.rowId}-first`}
        label={props.firstLabel}
        placeholder={props.firstPlaceholder}
        value={props.firstValue}
        error={firstError}
        // READ-ONLY rather than disabled: the value is still worth reading and
        // copying, and a disabled control drops out of the accessibility tree
        // that would otherwise say what this row is.
        readOnly={props.locked}
        onChange={props.onFirstChange}
      />
      <RowField
        id={`${props.rowId}-second`}
        label={props.secondLabel}
        placeholder={props.secondPlaceholder}
        value={props.secondValue}
        error={secondError}
        readOnly={false}
        onChange={props.onSecondChange}
      />
      {props.locked ? (
        // GONE, not disabled. A disabled control says "not right now"; this row
        // can never be removed from this form, and a button that will never
        // enable is an affordance that lies. The section's note carries the
        // real route.
        <div aria-hidden className="mt-1 size-7 shrink-0" />
      ) : (
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          className={cn(
            "mt-1 text-muted-foreground",
            "hover:bg-destructive/10 hover:text-destructive",
          )}
          disabled={props.removeDisabled}
          onClick={props.onRemove}
          aria-label={props.removeLabel}
        >
          <Trash2 className="size-3.5" />
        </Button>
      )}
    </div>
  );
}

/**
 * One column of a row editor, with its error ANNOUNCED rather than merely
 * adjacent - the same association {@link Field} makes, for the same reason.
 *
 * These rows repeat, so an unassociated "Required" is worse here than in the
 * fields above: a screen reader hears the column label and the value, and the
 * complaint belongs to whichever of the six nearby boxes the reader guesses.
 */
function RowField(props: {
  readonly id: string;
  readonly label: string;
  readonly placeholder: string;
  readonly value: string;
  readonly error: string | null;
  readonly readOnly: boolean;
  readonly onChange: (value: string) => void;
}): ReactNode {
  const messageId = `${props.id}-message`;
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1">
      <Input
        aria-label={props.label}
        aria-invalid={props.error !== null}
        aria-describedby={props.error === null ? undefined : messageId}
        value={props.value}
        placeholder={props.placeholder}
        autoComplete="off"
        spellCheck={false}
        readOnly={props.readOnly}
        className={cn(props.readOnly && "text-muted-foreground")}
        onChange={(event) => {
          props.onChange(event.target.value);
        }}
      />
      {props.error === null ? null : (
        <p id={messageId} className="text-ui-xs text-destructive">
          {props.error}
        </p>
      )}
    </div>
  );
}
