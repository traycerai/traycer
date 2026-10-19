import { useRef, useState, type ReactNode } from "react";
import { ExternalLink } from "lucide-react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { EnvironmentSecretsCreateResponse } from "@traycer/protocol/host/environment-schemas";
import {
  SANDBOX_SECRET_FORM_KINDS,
  type SandboxSecretFormKind,
} from "@traycer/protocol/host/secret-intake-catalogue";
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
import type { HostRpcRegistry } from "@/lib/host";
import { secretChangeRefusalLine } from "@/lib/sandboxes/secret-change-refusal-copy";
import {
  SECRET_KIND_LABEL,
  SECRET_KIND_ON_THE_WEB,
  isDesktopSecretKind,
  secretKindHint,
  secretKindUnsupportedReason,
} from "@/lib/sandboxes/secret-intake-copy";
import {
  initialSecretForm,
  secretCreateRequest,
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
  SECRET_SAVED_OFFLINE,
  secretSaveConfirmationLines,
} from "@/lib/sandboxes/secrets-page-copy";
import { cn } from "@/lib/utils";

/**
 * Settings ▸ Personal ▸ Secrets ▸ Add a secret:
 * kind first, then the kind's form with Verify, then the confirmation of
 * where the value becomes readable. API keys, model provider keys and
 * database logins are added here; every other kind is listed and opens its
 * form on the web; a kind no protocol of which is brokered is greyed with
 * the catalogue's own line.
 *
 * The typed value lives in this component's state only: Verify and Save send
 * it by a direct request, so it reaches no query or mutation cache, and
 * closing the dialog drops it.
 */

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
  return error instanceof Error && error.message.length > 0
    ? error.message
    : fallback;
}

function createOutcomeNote(
  outcome: EnvironmentSecretsCreateResponse,
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
          secretChangeRefusalLine("create", outcome.code) ??
          "Couldn't save this secret.",
      };
  }
}

function KindOption(props: {
  readonly kind: SandboxSecretFormKind;
  readonly onPick: (kind: SandboxSecretFormKind) => void;
}): ReactNode {
  const { kind } = props;
  const unsupported = secretKindUnsupportedReason(kind);
  const onTheWeb = unsupported === null && !isDesktopSecretKind(kind);
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
        <span className="flex items-center justify-between gap-2 text-ui-sm font-medium text-foreground">
          {SECRET_KIND_LABEL[kind]}
          {onTheWeb ? (
            <span className="flex shrink-0 items-center gap-1 text-ui-xs font-normal text-muted-foreground">
              {SECRET_KIND_ON_THE_WEB}
              <ExternalLink className="size-3" aria-hidden />
            </span>
          ) : null}
        </span>
        <span className="text-ui-xs text-muted-foreground">
          {unsupported ?? secretKindHint(kind)}
        </span>
      </button>
    </li>
  );
}

function KindPicker(props: {
  readonly onPick: (kind: SandboxSecretFormKind) => void;
}): ReactNode {
  return (
    <ul
      className="grid grid-cols-1 gap-2 sm:grid-cols-2"
      data-testid="secret-kind-picker"
    >
      {SANDBOX_SECRET_FORM_KINDS.map((kind) => (
        <KindOption key={kind} kind={kind} onPick={props.onPick} />
      ))}
    </ul>
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

export function AddSecretDialog(props: {
  readonly open: boolean;
  readonly client: HostClient<HostRpcRegistry>;
  readonly onOpenChange: (open: boolean) => void;
  /** A kind whose form lives on the web: open it there. */
  readonly onOpenOnTheWeb: (kind: SandboxSecretFormKind) => void;
  /** A secret was saved: re-read the list. */
  readonly onSaved: () => void;
}): ReactNode {
  const [step, setStep] = useState<Step>(PICK);
  const [busy, setBusy] = useState<"verify" | "save" | null>(null);
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
    setStep(PICK);
    setVerifyNote(null);
    setSaveNote(null);
    setBusy(null);
    props.onOpenChange(false);
  };

  const pick = (kind: SandboxSecretFormKind): void => {
    if (!isDesktopSecretKind(kind)) {
      props.onOpenOnTheWeb(kind);
      close(false);
      return;
    }
    setStep({ kind: "form", form: initialSecretForm(kind) });
  };

  const changeForm = (form: SecretFormState): void => {
    setStep({ kind: "form", form });
    setVerifyNote(null);
  };

  const verify = async (form: SecretFormState): Promise<void> => {
    const sentFrom = openGeneration.current;
    setBusy("verify");
    setVerifyNote(null);
    try {
      const result = await props.client.request(
        "environment.secrets.verify",
        secretVerifyCandidateRequest(form),
      );
      if (openGeneration.current !== sentFrom) return;
      setVerifyNote(secretVerifyLine(result, form.protocol, "dialog"));
    } catch (error) {
      if (openGeneration.current !== sentFrom) return;
      setVerifyNote({
        tone: "warning",
        text: errorText(error, "Couldn't check."),
      });
    } finally {
      if (openGeneration.current === sentFrom) setBusy(null);
    }
  };

  const save = async (form: SecretFormState): Promise<void> => {
    const sentFrom = openGeneration.current;
    setBusy("save");
    setSaveNote(null);
    try {
      const outcome = await props.client.request(
        "environment.secrets.create",
        secretCreateRequest(form),
      );
      const note = createOutcomeNote(outcome);
      // The list is re-read whichever open is showing: the secret is saved.
      if (outcome.outcome !== "refused") props.onSaved();
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
    } finally {
      if (openGeneration.current === sentFrom) setBusy(null);
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
          {step.kind === "pick" ? <KindPicker onPick={pick} /> : null}
          {step.kind === "form" ? (
            <>
              <SecretIntakeFields state={step.form} onChange={changeForm} />
              <Note note={verifyNote} testId="secret-form-verify-line" />
              <FormProblem form={step.form} />
            </>
          ) : null}
          {step.kind === "confirm" ? (
            <div
              className="flex flex-col gap-2 text-ui-sm"
              data-testid="secret-save-confirmation"
            >
              {secretSaveConfirmationLines(
                step.form.name,
                step.form.mode,
                step.form.sandboxesByDefault,
              ).map((line) => (
                <p key={line} className="max-w-[72ch]">
                  {line}
                </p>
              ))}
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
              disabled={
                busy !== null || secretVerifyProblem(step.form) !== null
              }
              onClick={() => void verify(step.form)}
              data-testid="secret-form-verify"
            >
              Verify
              <Busy busy={busy === "verify"} />
            </Button>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              disabled={busy !== null || secretFormProblem(step.form) !== null}
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
              disabled={busy !== null}
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
              disabled={busy !== null}
              onClick={() => void save(step.form)}
              data-testid="secret-save"
            >
              Save
              <Busy busy={busy === "save"} />
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
