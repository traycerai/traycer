import { useCallback, useId, useMemo, useState, type ReactNode } from "react";
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
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import {
  EMPTY_CUSTOM_PROVIDER_DRAFT,
  hasCustomProviderDraftError,
  suggestCustomProviderId,
  validateCustomProviderDraft,
  customProviderValues,
  type CustomProviderDraft,
  type CustomProviderField,
  type CustomProviderValues,
} from "./model-provider-custom-draft";

/**
 * Declare (or edit) an OpenAI-compatible provider the catalog does not ship.
 *
 * The submit path is a PROP rather than a mutation hook of its own. The tab
 * owns which host and provider this is for and already holds the invalidation
 * story for the list; a second component reaching for the same client would be
 * a second place to keep those two facts in sync.
 */
export function ProviderCustomModelProviderDialog(props: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly providerLabel: string;
  /** Ids already in the catalog - a new provider may not shadow one. */
  readonly takenIds: readonly string[];
  /** The provider being edited, or null when declaring a new one. */
  readonly initial: CustomProviderValues | null;
  readonly isPending: boolean;
  /** Inline failure from the last submit, already redacted, or null. */
  readonly submitError: string | null;
  readonly onSubmit: (values: CustomProviderValues) => void;
}): ReactNode {
  const editing = props.initial !== null;
  const [draft, setDraft] = useState<CustomProviderDraft>(() =>
    props.initial === null
      ? EMPTY_CUSTOM_PROVIDER_DRAFT
      : {
          id: props.initial.modelProviderId,
          name: props.initial.name,
          baseUrl: props.initial.baseUrl,
          models: props.initial.modelIds.join("\n"),
        },
  );
  // Whether the id is still following the name. An edit starts detached - the
  // id is already fixed and re-deriving it from a renamed provider would
  // propose changing the key every existing model reference points at.
  const [idPinned, setIdPinned] = useState(editing);
  // Errors appear per field, once that field has been EDITED. They cannot wait
  // for a submit attempt the way a form with a live button can: the wire
  // rejects a bad base URL and an empty model list outright, so submit is
  // disabled while the draft is invalid - and a dead button with no visible
  // reason is the worst of both.
  //
  // An EDIT starts with every field already counted as edited. Those values
  // came off a hand-editable config file, where the read side of the wire
  // deliberately reports what it finds rather than what it would accept - so a
  // malformed base URL arrives here, submit is disabled by it, and waiting for
  // the user to touch that field first would show a dead button beside the one
  // thing that is wrong and say nothing about it.
  const [dirty, setDirty] = useState<ReadonlySet<CustomProviderField>>(() =>
    editing ? new Set(["id", "name", "baseUrl", "models"]) : new Set(),
  );
  const markDirty = useCallback((field: CustomProviderField) => {
    setDirty((current) =>
      current.has(field) ? current : new Set([...current, field]),
    );
  }, []);

  const fieldId = useId();
  // Editing keeps the row's own id out of the taken list; the provider is
  // allowed to keep the id it already has.
  const initialId = props.initial?.modelProviderId ?? null;
  const propTakenIds = props.takenIds;
  const takenIds = useMemo(
    () =>
      initialId === null
        ? propTakenIds
        : propTakenIds.filter((id) => id !== initialId),
    [initialId, propTakenIds],
  );
  // An edit judges the id as an EXISTING one. The field is disabled anyway, so
  // the only thing the minting rules could do here is condemn a declaration the
  // user cannot change from this form - which is exactly the lock they caused.
  const scope = useMemo(
    () => ({ takenIds, existing: editing }),
    [editing, takenIds],
  );
  const errors = validateCustomProviderDraft(draft, scope);
  const invalid = hasCustomProviderDraftError(errors);

  const handleNameChange = useCallback(
    (name: string) => {
      markDirty("name");
      // The id counts as edited too when it is still following the name: the
      // value in that box visibly changed, and a derived id that collides with
      // an existing provider is otherwise a disabled submit with no reason
      // anywhere on screen.
      if (!idPinned) markDirty("id");
      setDraft((current) => ({
        ...current,
        name,
        id: idPinned ? current.id : suggestCustomProviderId(name),
      }));
    },
    [idPinned, markDirty],
  );

  const handleSubmit = useCallback(() => {
    const values = customProviderValues(draft, scope);
    // Re-checked here even though the button is disabled: the form also submits
    // on Enter, and a browser that lets that through would otherwise send a
    // draft the wire is going to reject.
    if (values === null || props.isPending) return;
    props.onSubmit(values);
  }, [draft, props, scope]);

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="w-full max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {editing ? "Edit custom provider" : "Add custom provider"}
          </DialogTitle>
          <DialogDescription>
            Point {props.providerLabel} at an OpenAI-compatible endpoint of your
            own. It is written to {props.providerLabel}&apos;s config file, so
            its CLI sees the same provider.
          </DialogDescription>
        </DialogHeader>

        <form
          className="flex w-full flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            handleSubmit();
          }}
        >
          <Field
            id={`${fieldId}-name`}
            label="Name"
            hint="What this provider is called in model pickers."
            error={dirty.has("name") ? errors.name : null}
          >
            <Input
              id={`${fieldId}-name`}
              value={draft.name}
              placeholder="My gateway"
              autoComplete="off"
              onChange={(event) => {
                handleNameChange(event.target.value);
              }}
            />
          </Field>

          <Field
            id={`${fieldId}-id`}
            label="Id"
            hint="The key this provider gets in the config file."
            error={dirty.has("id") ? errors.id : null}
          >
            <Input
              id={`${fieldId}-id`}
              value={draft.id}
              placeholder="my-gateway"
              autoComplete="off"
              // An existing provider's id is its config key and the name every
              // stored model reference is built from, so a rename here would be
              // a delete and a create wearing one button.
              disabled={editing}
              onChange={(event) => {
                setIdPinned(true);
                markDirty("id");
                setDraft((current) => ({ ...current, id: event.target.value }));
              }}
            />
          </Field>

          <Field
            id={`${fieldId}-base-url`}
            label="Base URL"
            hint="The OpenAI-compatible root, usually ending in /v1."
            error={dirty.has("baseUrl") ? errors.baseUrl : null}
          >
            <Input
              id={`${fieldId}-base-url`}
              value={draft.baseUrl}
              placeholder="https://api.example.com/v1"
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => {
                markDirty("baseUrl");
                setDraft((current) => ({
                  ...current,
                  baseUrl: event.target.value,
                }));
              }}
            />
          </Field>

          <Field
            id={`${fieldId}-models`}
            label="Model ids"
            // The endpoint is not asked what it serves: an OpenAI-compatible
            // gateway need not implement `/models`, and the ones that do
            // routinely list far more than the account may call.
            hint="One per line, exactly as the endpoint names them."
            error={dirty.has("models") ? errors.models : null}
          >
            <Textarea
              id={`${fieldId}-models`}
              value={draft.models}
              placeholder={"gpt-4o-mini\nllama-3.1-70b"}
              rows={3}
              spellCheck={false}
              onChange={(event) => {
                markDirty("models");
                setDraft((current) => ({
                  ...current,
                  models: event.target.value,
                }));
              }}
            />
          </Field>

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
            <Button
              type="submit"
              size="sm"
              disabled={props.isPending || invalid}
            >
              {props.isPending ? <MutedAgentSpinner /> : null}
              {editing ? "Save" : "Add provider"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function Field(props: {
  readonly id: string;
  readonly label: string;
  readonly hint: string;
  readonly error: string | null;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <div className="flex w-full flex-col gap-1.5">
      <Label htmlFor={props.id}>{props.label}</Label>
      {props.children}
      <p
        className={cn(
          "text-ui-xs",
          props.error === null ? "text-muted-foreground" : "text-destructive",
        )}
      >
        {props.error ?? props.hint}
      </p>
    </div>
  );
}
