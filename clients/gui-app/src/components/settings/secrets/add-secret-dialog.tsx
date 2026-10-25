import { useRef, useState, type ReactNode } from "react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { HostMethodVersionUnsatisfiedError } from "@traycer-clients/shared/host-transport/host-messenger";
import type { EnvironmentSecretsCreateResponse } from "@traycer/protocol/host/environment-schemas";
import { SecretIntakeFields } from "@/components/settings/secrets/secret-intake-fields";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  useEnvironmentSecretsCreateMutation,
  useEnvironmentSecretsVerifyCandidateMutation,
} from "@/hooks/environment/team/use-secret-value-mutations";
import type { HostRpcRegistry } from "@/lib/host";
import {
  secretChangeRefusalLine,
  secretDestinationUnreachableLine,
} from "@/lib/sandboxes/secret-change-refusal-copy";
import {
  ADD_SECRET_KINDS,
  SECRET_KIND_LABEL,
  type DesktopSecretKind,
  secretKindHint,
  secretKindUnsupportedReason,
} from "@/lib/sandboxes/secret-intake-copy";
import {
  initialSecretForm,
  secretCreateRequest,
  secretFormHosts,
  secretFormProblem,
  secretVerifyCandidateRequest,
  secretVerifyProblem,
  type SecretFormState,
} from "@/lib/sandboxes/secret-intake-form";
import {
  secretVerifyLine,
  type SecretVerifyLine,
} from "@/lib/sandboxes/secret-verify-copy";
import {
  PROVIDER_KEYS_LINE,
  SECRET_CUSTODY_SENTENCE,
  SECRET_SAVED_OFFLINE,
  SECRETS_NEED_UPDATED_HOST,
} from "@/lib/sandboxes/secrets-page-copy";
import { HowTraycerHandlesThis } from "@/components/settings/members/how-traycer-handles-this";
import { dataHandlingNoticeText } from "@/components/settings/members/data-handling-notice-text";
import { navigateToSettingsSection } from "@/lib/settings-navigation";
import { cn } from "@/lib/utils";

/**
 * Settings ▸ Personal ▸ Secrets ▸ Add a secret:
 * kind first, then the kind's form with Verify, then the custody sentence
 * once more before Save. API keys and database logins are offered; a
 * provider's key is set on its Account tab, which the picker points to, and
 * SSH, the cloud and certificate kinds have no row. A kind no protocol of
 * which is brokered is greyed with the catalogue's own line. A value a
 * Variables row refused arrives as `prefill`, its name and value filled in.
 *
 * The typed value lives in this component's state only: Verify and Save read
 * it when their request is dispatched, so it reaches no query or mutation
 * cache, and closing the dialog drops it.
 */

/** A name and value Add a secret opens with. */
export interface SecretPrefill {
  readonly name: string;
  readonly value: string;
}

type Step =
  | { readonly kind: "pick" }
  | { readonly kind: "form"; readonly form: SecretFormState }
  | { readonly kind: "confirm"; readonly form: SecretFormState };

const PICK: Step = { kind: "pick" };

const STEP_DESCRIPTION: Readonly<Record<Step["kind"], string>> = {
  pick: "Choose what you are adding.",
  form: "Where it goes and how agents use it.",
  confirm: "Before you save.",
};

const NOTE_TONE: Readonly<Record<SecretVerifyLine["tone"], string>> = {
  success: "text-success-foreground",
  warning: "text-warning-foreground",
};

function errorText(error: unknown, fallback: string): string {
  if (error instanceof HostMethodVersionUnsatisfiedError) {
    return SECRETS_NEED_UPDATED_HOST;
  }
  return error instanceof Error && error.message.length > 0
    ? error.message
    : fallback;
}

function createOutcomeNote(
  outcome: EnvironmentSecretsCreateResponse,
  form: SecretFormState,
): SecretVerifyLine | null {
  switch (outcome.outcome) {
    case "created":
      return null;
    case "pending":
      return {
        tone: "success",
        text: SECRET_SAVED_OFFLINE,
      };
    case "refused":
      return {
        tone: "warning",
        text:
          outcome.code === "destination_unresolvable"
            ? secretDestinationUnreachableLine(secretFormHosts(form))
            : (secretChangeRefusalLine("create", outcome.code) ??
              "Couldn't save this secret."),
      };
  }
}

function KindOption(props: {
  readonly kind: DesktopSecretKind;
  readonly onPick: (kind: DesktopSecretKind) => void;
}): ReactNode {
  const { kind } = props;
  const unsupported = secretKindUnsupportedReason(kind);
  return (
    <li>
      <button
        type="button"
        disabled={unsupported !== null}
        onClick={() => props.onPick(kind)}
        className={cn(
          "flex w-full flex-col gap-0.5 rounded-md border border-border/60 px-3 py-2 text-left transition-colors",
          unsupported === null
            ? "hover:bg-accent/50"
            : "cursor-default opacity-60",
        )}
        data-testid={`secret-kind-option-${kind}`}
        data-unsupported={unsupported === null ? undefined : "true"}
      >
        <span className="text-ui-sm font-medium text-foreground">
          {SECRET_KIND_LABEL[kind]}
        </span>
        <span className="text-ui-xs text-muted-foreground">
          {unsupported ?? secretKindHint(kind)}
        </span>
      </button>
    </li>
  );
}

function KindPicker(props: {
  readonly onPick: (kind: DesktopSecretKind) => void;
  readonly onProviders: () => void;
}): ReactNode {
  return (
    <div className="flex flex-col gap-2">
      <ul
        className="grid grid-cols-1 gap-2 sm:grid-cols-2"
        data-testid="secret-kind-picker"
      >
        {ADD_SECRET_KINDS.map((kind) => (
          <KindOption key={kind} kind={kind} onPick={props.onPick} />
        ))}
      </ul>
      <p
        className="max-w-[72ch] text-ui-xs text-muted-foreground"
        data-testid="secret-provider-keys-line"
      >
        {PROVIDER_KEYS_LINE.before}
        <Button
          type="button"
          variant="link"
          size="inline-xs"
          onClick={props.onProviders}
          data-testid="secret-provider-keys-link"
        >
          {PROVIDER_KEYS_LINE.link}
        </Button>
        {PROVIDER_KEYS_LINE.after}
      </p>
    </div>
  );
}

/** Where the value is stored and who reads it, then how Traycer handles it. */
function Custody(): ReactNode {
  return (
    <div className="flex flex-col gap-1">
      <p
        className="max-w-[72ch] text-ui-xs text-muted-foreground"
        data-testid="secret-custody-sentence"
      >
        {SECRET_CUSTODY_SENTENCE}
      </p>
      <HowTraycerHandlesThis noticeText={dataHandlingNoticeText()} />
    </div>
  );
}

function Note(props: {
  readonly note: SecretVerifyLine | null;
  readonly testId: string;
}): ReactNode {
  if (props.note === null) return null;
  return (
    <p
      role="status"
      className={cn("max-w-[72ch] text-ui-xs", NOTE_TONE[props.note.tone])}
      data-testid={props.testId}
    >
      {props.note.text}
    </p>
  );
}

function Busy(props: { readonly busy: boolean }): ReactNode {
  return props.busy ? (
    <AgentSpinningDots
      className={undefined}
      testId={undefined}
      variant={undefined}
      tone="muted"
    />
  ) : null;
}

/** A kind's empty form, with a carried-in name and value when there is one. */
function prefilledForm(
  kind: DesktopSecretKind,
  prefill: SecretPrefill | null,
): SecretFormState {
  const form = initialSecretForm(kind);
  return prefill === null
    ? form
    : { ...form, name: prefill.name, value: prefill.value };
}

/** A named kind opens its form; a carried-in value opens an API key's. */
function initialStepOf(
  initialKind: DesktopSecretKind | undefined,
  prefill: SecretPrefill | null,
): Step {
  if (initialKind !== undefined) {
    return { kind: "form", form: prefilledForm(initialKind, prefill) };
  }
  return prefill === null
    ? PICK
    : { kind: "form", form: prefilledForm("api_key", prefill) };
}

export function AddSecretDialog(props: {
  readonly open: boolean;
  readonly initialKind?: DesktopSecretKind;
  /** A name and value carried in from a refused variable, or `null`. */
  readonly prefill: SecretPrefill | null;
  readonly client: HostClient<HostRpcRegistry>;
  readonly onOpenChange: (open: boolean) => void;
}): ReactNode {
  const { prefill } = props;
  const initialStep = initialStepOf(props.initialKind, prefill);
  const [step, setStep] = useState<Step>(initialStep);
  // The form a Verify or Save sends, read at dispatch.
  const sentForm = useRef<SecretFormState | null>(null);
  const readSentForm = (): SecretFormState => {
    if (sentForm.current === null) throw new Error("Nothing to send.");
    return sentForm.current;
  };
  const verifyCandidate = useEnvironmentSecretsVerifyCandidateMutation(
    props.client,
    () => secretVerifyCandidateRequest(readSentForm()),
  );
  const create = useEnvironmentSecretsCreateMutation(props.client, () =>
    secretCreateRequest(readSentForm()),
  );
  const busy = verifyCandidate.isPending || create.isPending;
  const [verifyNote, setVerifyNote] = useState<SecretVerifyLine | null>(null);
  const [saveNote, setSaveNote] = useState<SecretVerifyLine | null>(null);
  // Which open of the dialog a check or save belongs to. A close ends the
  // open, so a request that settles after it (the person closed and opened
  // the dialog again) neither closes nor writes into the form now showing.
  const openGeneration = useRef(0);

  const close = (open: boolean): void => {
    if (open) return;
    openGeneration.current += 1;
    // Closing drops the typed value with the rest of the form.
    setStep(initialStep);
    setVerifyNote(null);
    setSaveNote(null);
    verifyCandidate.reset();
    create.reset();
    props.onOpenChange(false);
  };

  const pick = (kind: DesktopSecretKind): void => {
    setStep({ kind: "form", form: prefilledForm(kind, prefill) });
  };

  const changeForm = (form: SecretFormState): void => {
    setStep({ kind: "form", form });
    setVerifyNote(null);
  };

  const verify = async (form: SecretFormState): Promise<void> => {
    const sentFrom = openGeneration.current;
    setVerifyNote(null);
    sentForm.current = form;
    try {
      const result = await verifyCandidate.mutateAsync();
      if (openGeneration.current !== sentFrom) return;
      setVerifyNote(secretVerifyLine(result, form.protocol, "dialog"));
    } catch (error) {
      if (openGeneration.current !== sentFrom) return;
      setVerifyNote({
        tone: "warning",
        text: errorText(error, "Couldn't check."),
      });
    }
  };

  const save = async (form: SecretFormState): Promise<void> => {
    const sentFrom = openGeneration.current;
    setSaveNote(null);
    sentForm.current = form;
    try {
      // The mutation re-reads the list once the secret is saved, whichever
      // open is showing.
      const outcome = await create.mutateAsync();
      const note = createOutcomeNote(outcome, form);
      if (openGeneration.current !== sentFrom) return;
      if (note === null) {
        close(false);
        return;
      }
      setSaveNote(note);
    } catch (error) {
      if (openGeneration.current !== sentFrom) return;
      setSaveNote({
        tone: "warning",
        text: errorText(error, "Couldn't save this secret."),
      });
    }
  };

  return (
    <Dialog open={props.open} onOpenChange={close}>
      <DialogContent
        layout="banded"
        className="flex max-h-[min(85dvh,44rem)] w-[min(92vw,34rem)] flex-col overflow-hidden sm:max-w-none"
        data-testid="add-secret-dialog"
      >
        <DialogHeader className="gap-1.5">
          <DialogTitle>
            {step.kind === "pick"
              ? "Add a secret"
              : SECRET_KIND_LABEL[step.form.kind]}
          </DialogTitle>
          <DialogDescription>{STEP_DESCRIPTION[step.kind]}</DialogDescription>
        </DialogHeader>
        <div className="flex min-h-0 flex-col gap-4 overflow-y-auto px-5 pb-5">
          {step.kind === "pick" ? (
            <KindPicker
              onPick={pick}
              onProviders={() => {
                close(false);
                navigateToSettingsSection("providers");
              }}
            />
          ) : null}
          {step.kind === "form" ? (
            <>
              <SecretIntakeFields state={step.form} onChange={changeForm} />
              <Custody />
              <Note note={verifyNote} testId="secret-form-verify-line" />
              <FormProblem form={step.form} />
            </>
          ) : null}
          {step.kind === "confirm" ? (
            <div
              className="flex flex-col gap-2 text-ui-sm"
              data-testid="secret-save-confirmation"
            >
              <Custody />
              <Note note={saveNote} testId="secret-save-note" />
            </div>
          ) : null}
        </div>
        {step.kind === "form" ? (
          <DialogFooter>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => setStep(PICK)}
            >
              Back
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={busy || secretVerifyProblem(step.form) !== null}
              onClick={() => void verify(step.form)}
              data-testid="secret-form-verify"
            >
              Verify
              <Busy busy={verifyCandidate.isPending} />
            </Button>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              disabled={busy || secretFormProblem(step.form) !== null}
              onClick={() => setStep({ kind: "confirm", form: step.form })}
              data-testid="secret-form-continue"
            >
              Continue
            </Button>
          </DialogFooter>
        ) : null}
        {step.kind === "confirm" && saveNote?.tone === "success" ? (
          // Saved and waiting to reach the account: one more Save would be a
          // second secret, so only Done is offered.
          <DialogFooter>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              onClick={() => close(false)}
              data-testid="secret-save-done"
            >
              Done
            </Button>
          </DialogFooter>
        ) : null}
        {step.kind === "confirm" && saveNote?.tone !== "success" ? (
          <DialogFooter>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => {
                setSaveNote(null);
                setStep({ kind: "form", form: step.form });
              }}
            >
              Back
            </Button>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              disabled={busy}
              onClick={() => void save(step.form)}
              data-testid="secret-save"
            >
              Save
              <Busy busy={create.isPending} />
            </Button>
          </DialogFooter>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function FormProblem(props: { readonly form: SecretFormState }): ReactNode {
  const problem = secretFormProblem(props.form);
  if (problem === null) return null;
  return (
    <p
      className="text-ui-xs text-muted-foreground"
      data-testid="secret-form-problem"
    >
      {problem}
    </p>
  );
}
