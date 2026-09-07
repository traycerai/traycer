import { useCallback, useEffect, useId, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { Check, Copy, ExternalLink } from "lucide-react";
import type {
  ModelProviderAuthResult,
  ModelProviderEntry,
  ModelProviderPrompt,
  ProviderModelProvidersCapabilities,
} from "@traycer/protocol/host/provider-native-schemas";
import type { ProviderId } from "@traycer/protocol/host/provider-schemas";
import { MutedAgentSpinner } from "@/components/ui/agent-spinning-dots";
import { ModelProviderMark } from "@/components/home/pickers/model-provider-icons";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useProvidersModelProviderAuth } from "@/hooks/providers/use-providers-model-provider-auth-mutation";
import { useProvidersAwaitModelProviderAuth } from "@/hooks/providers/use-providers-await-model-provider-auth-mutation";
import { useProvidersCancelModelProviderAuth } from "@/hooks/providers/use-providers-cancel-model-provider-auth-mutation";
import { useOpenLink } from "@/lib/links/open-link";
import { useClipboardCopy } from "@/hooks/ui/use-clipboard-copy";
import {
  modelProviderAuthErrorDisposition,
  modelProviderAuthErrorMessage,
} from "@/lib/providers/model-provider-error-copy";
import { redactLogText } from "@/lib/logger";
import type { ModelProviderPendingAuthEntry } from "@/stores/settings/model-provider-pending-auth-store";
import { useModelProviderPendingAuthStore } from "@/stores/settings/model-provider-pending-auth-store";
import {
  connectChoicesFor,
  credentialPrecedenceNotice,
  extractConfirmationCode,
  initialConnectChoiceId,
  type ConnectChoice,
} from "./model-provider-connect-model";
import {
  defaultModelProviderPromptAnswers,
  modelProviderPromptInputs,
  unansweredModelProviderPrompts,
  visibleModelProviderPrompts,
} from "./model-provider-prompts";

/** The call is a bounded registry read, not a long poll, so the cadence is ours to pick. */
const OAUTH_AUTO_POLL_MS = 1_500;

type LiveAttempt = {
  readonly attemptId: string;
  readonly authorizationUrl: string;
  readonly method: "auto" | "code";
  readonly instructions: string | null;
  /** When this attempt started, never when it was last polled. */
  readonly startedAt: number;
};

/** Same attempt, same data. */
function sameLiveAttempt(left: LiveAttempt, right: LiveAttempt): boolean {
  return (
    left.attemptId === right.attemptId &&
    left.authorizationUrl === right.authorizationUrl &&
    left.method === right.method &&
    left.instructions === right.instructions
  );
}

export function ProviderModelProviderConnectDialog(props: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly providerId: ProviderId;
  readonly providerLabel: string;
  readonly entry: ModelProviderEntry;
  readonly capabilities: ProviderModelProvidersCapabilities;
  readonly hostId: string | null;
  /** An attempt this dialog is resuming after a navigation, or null for a fresh open. */
  readonly resumedAttempt: ModelProviderPendingAuthEntry | null;
  readonly onDone: () => void;
}): ReactNode {
  const {
    providerId,
    providerLabel,
    entry,
    capabilities,
    hostId,
    resumedAttempt,
    onDone,
  } = props;

  const choices = useMemo(
    () => connectChoicesFor(entry, capabilities),
    [entry, capabilities],
  );
  const [choiceId, setChoiceId] = useState<string>(() =>
    initialConnectChoiceId(choices),
  );
  const choice =
    choices.find((entryChoice) => entryChoice.id === choiceId) ?? null;

  const [answers, setAnswers] = useState<ReadonlyMap<string, string>>(() =>
    defaultModelProviderPromptAnswers(choice?.prompts ?? []),
  );
  const [secret, setSecret] = useState("");
  const [code, setCode] = useState("");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [restartNotice, setRestartNotice] = useState<string | null>(null);
  const [attempt, setAttempt] = useState<LiveAttempt | null>(() =>
    resumedAttempt === null
      ? null
      : {
          attemptId: resumedAttempt.attemptId,
          authorizationUrl: resumedAttempt.authorizationUrl,
          method: resumedAttempt.method,
          instructions: resumedAttempt.instructions,
          startedAt: resumedAttempt.startedAt,
        },
  );
  const [cancelError, setCancelError] = useState<string | null>(null);

  const auth = useProvidersModelProviderAuth();
  const awaitAuth = useProvidersAwaitModelProviderAuth();
  const cancelAuth = useProvidersCancelModelProviderAuth();
  const openLink = useOpenLink();
  const pendingAuthUpsert = useModelProviderPendingAuthStore((s) => s.upsert);
  const pendingAuthRemove = useModelProviderPendingAuthStore((s) => s.remove);
  const pendingAuthGet = useModelProviderPendingAuthStore((s) => s.get);

  // Null while the host binding has not settled: an attempt cannot be filed under an unknown host, and a record
  // filed under the wrong one can never be resumed against the list it started from.
  const pendingKey = useMemo(
    () =>
      hostId === null
        ? null
        : { hostId, providerId, modelProviderId: entry.id },
    [hostId, providerId, entry.id],
  );

  // Switching sign-in method rebuilds the form: the prompts belong to the method, so carrying answers across
  // would submit one method's fields under another's keys.
  const handleChoiceChange = useCallback(
    (nextId: string) => {
      setChoiceId(nextId);
      const next = choices.find((entryChoice) => entryChoice.id === nextId);
      setAnswers(defaultModelProviderPromptAnswers(next?.prompts ?? []));
      setErrorMessage(null);
      setRestartNotice(null);
    },
    [choices],
  );

  const setAnswer = useCallback((key: string, value: string) => {
    setAnswers((prev) => {
      const next = new Map(prev);
      next.set(key, value);
      return next;
    });
  }, []);

  // Both halves are guarded by `attemptId`: a teardown that resolves after the user started a newer attempt for
  // the same row must not take the newer one's surface or its record with it.
  const forgetAttempt = useCallback(
    (attemptId: string) => {
      setAttempt((current) =>
        current !== null && current.attemptId === attemptId ? null : current,
      );
      setCode("");
      if (pendingKey !== null) pendingAuthRemove(pendingKey, attemptId);
    },
    [pendingAuthRemove, pendingKey],
  );

  const liveAttemptId = attempt === null ? null : attempt.attemptId;

  /** It deliberately cannot reach the browser. Opening the sign-in page belongs to applyStartResult alone - see
   * its note for why a status tick that carries an `authorizationUrl` must not be treated as a fresh start. */
  const applyResult = useCallback(
    (result: ModelProviderAuthResult, fromPoll: boolean) => {
      switch (result.kind) {
        case "done":
          if (liveAttemptId !== null) forgetAttempt(liveAttemptId);
          onDone();
          return;
        case "pending":
          return;
        case "unsupported":
          setErrorMessage(
            redactLogText(
              result.reason ?? "This sign-in isn't available on this host.",
            ),
          );
          return;
        case "authorizationUrl": {
          setAttempt((current) => {
            const next: LiveAttempt = {
              attemptId: result.attemptId,
              authorizationUrl: result.authorizationUrl,
              method: result.method,
              instructions: result.instructions,
              // A tick refreshes an attempt the panel already holds; only a genuinely new attempt starts a new clock.
              // Restamping every tick would make the newest-wins resume ordering meaningless.
              startedAt:
                current !== null && current.attemptId === result.attemptId
                  ? current.startedAt
                  : Date.now(),
            };
            if (current !== null && sameLiveAttempt(current, next)) {
              return current;
            }
            return next;
          });
          setErrorMessage(null);
          setRestartNotice(null);
          return;
        }
        case "error": {
          const message = redactLogText(
            modelProviderAuthErrorMessage(result.code, result.detail),
          );
          switch (modelProviderAuthErrorDisposition(result.code)) {
            case "stand-down":
              // Say nothing and drop this panel - the surface belongs to the other attempt. The local panel only: the store
              // slot for this row has already been claimed by the newer attempt, whose resume record must survive.
              setAttempt(null);
              setCode("");
              return;
            case "restart":
              if (liveAttemptId !== null) forgetAttempt(liveAttemptId);
              setRestartNotice(message);
              return;
            case "reprompt":
              // The attempt is still live; only the code was wrong.
              setCode("");
              setErrorMessage(message);
              return;
            case "report":
              // A `report` from a poll is a post-mortem - the host only answers a status read this way once the attempt has
              // already terminalized (the background callback failed, its lease was released, the row is settled).
              if (fromPoll) {
                if (liveAttemptId !== null) forgetAttempt(liveAttemptId);
                setRestartNotice(message);
                return;
              }
              setErrorMessage(message);
              return;
          }
        }
      }
    },
    [forgetAttempt, liveAttemptId, onDone],
  );

  /** This is the only function in the file that reaches the browser, and that matters because of how the host
   * answers a status poll: a still-pending attempt comes back as the stored `authorizationUrl`, not as `{ kind. */
  const applyStartResult = useCallback(
    (result: ModelProviderAuthResult) => {
      applyResult(result, false);
      if (result.kind !== "authorizationUrl") return;
      if (pendingKey !== null) {
        pendingAuthUpsert({
          key: pendingKey,
          attemptId: result.attemptId,
          startedAt: Date.now(),
          authorizationUrl: result.authorizationUrl,
          method: result.method,
          instructions: result.instructions,
        });
      }
      // Opened for both arms. `code` still needs the provider's page on screen
      // to produce the code the user is about to paste.
      void openLink(result.authorizationUrl, "auth", null);
    },
    [applyResult, openLink, pendingAuthUpsert, pendingKey],
  );

  /** Refreshes what the resume record knows - the host may have learned the provider's instructions since - and
   * never touches the browser. */
  const applyPollResult = useCallback(
    (result: ModelProviderAuthResult) => {
      applyResult(result, true);
      if (result.kind !== "authorizationUrl" || pendingKey === null) return;
      const stored = pendingAuthGet(pendingKey);
      // Only refresh OUR OWN record. A tick that races a newer attempt's upsert
      // must not write this attempt's data into the newer one's slot.
      if (stored === null || stored.attemptId !== result.attemptId) return;
      if (
        stored.authorizationUrl === result.authorizationUrl &&
        stored.method === result.method &&
        stored.instructions === result.instructions
      ) {
        return;
      }
      pendingAuthUpsert({
        ...stored,
        authorizationUrl: result.authorizationUrl,
        method: result.method,
        instructions: result.instructions,
      });
    },
    [applyResult, pendingAuthGet, pendingAuthUpsert, pendingKey],
  );

  /** The `auto` arm completes on the server's own loopback, so the only way to learn about it is to ask.
   * Single-flight: the next tick is scheduled when the previous one settles, never on a fixed interval. */
  const awaitMutate = awaitAuth.mutate;
  const shouldPoll = attempt !== null && attempt.method === "auto";
  const pollAttemptId = attempt === null ? null : attempt.attemptId;
  useEffect(() => {
    if (!shouldPoll || pollAttemptId === null) return;
    const attemptId = pollAttemptId;
    let cancelled = false;
    let timer: number | null = null;
    function schedule(): void {
      timer = window.setTimeout(tick, OAUTH_AUTO_POLL_MS);
    }
    function tick(): void {
      if (cancelled) return;
      awaitMutate(
        { providerId, modelProviderId: entry.id, attemptId },
        {
          onSuccess: (data) => {
            if (cancelled) return;
            applyPollResult(data.result);
          },
          onSettled: () => {
            if (cancelled) return;
            schedule();
          },
        },
      );
    }
    schedule();
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [
    applyPollResult,
    awaitMutate,
    entry.id,
    pollAttemptId,
    providerId,
    shouldPoll,
  ]);

  const promptsUnanswered = unansweredModelProviderPrompts(
    choice?.prompts ?? [],
    answers,
  );
  const needsSecret = choice !== null && choice.kind === "api";
  const submitDisabled =
    choice === null ||
    choice.unavailableReason !== null ||
    auth.isPending ||
    promptsUnanswered.length > 0 ||
    (needsSecret && secret.trim().length === 0);

  const handleSubmit = useCallback(() => {
    if (choice === null || choice.unavailableReason !== null) return;
    setErrorMessage(null);
    setRestartNotice(null);
    const promptInputs = modelProviderPromptInputs(choice.prompts, answers);
    if (choice.kind === "oauth") {
      if (choice.methodIndex === null) return;
      auth.mutate(
        {
          providerId,
          action: {
            action: "startOauth",
            modelProviderId: entry.id,
            methodIndex: choice.methodIndex,
            inputs: promptInputs,
          },
        },
        { onSuccess: (data) => applyStartResult(data.result) },
      );
      return;
    }
    // `key` is the pasted secret, not a key name - upstream's `ApiAuth.key`, which reads like an identifier and is
    // not one.
    auth.mutate(
      {
        providerId,
        action: {
          action: "connect",
          modelProviderId: entry.id,
          methodIndex: choice.methodIndex,
          key: secret.trim(),
          inputs: promptInputs,
        },
      },
      { onSuccess: (data) => applyResult(data.result, false) },
    );
  }, [
    answers,
    applyResult,
    applyStartResult,
    auth,
    choice,
    entry,
    providerId,
    secret,
  ]);

  const handleSubmitCode = useCallback(() => {
    // Guarded here, not only on the button: the paste field submits on Enter too, and two fast Enters would send
    // the same `attemptId` twice.
    if (attempt === null || auth.isPending || code.trim().length === 0) return;
    setErrorMessage(null);
    auth.mutate(
      {
        providerId,
        action: {
          action: "submitCode",
          modelProviderId: entry.id,
          attemptId: attempt.attemptId,
          code: code.trim(),
        },
      },
      { onSuccess: (data) => applyResult(data.result, false) },
    );
  }, [applyResult, attempt, auth, code, entry.id, providerId]);

  /** "Stop waiting". */
  const handleCancelAttempt = useCallback(() => {
    if (attempt === null) return;
    const attemptId = attempt.attemptId;
    setCancelError(null);
    cancelAuth.mutate(
      { providerId, modelProviderId: entry.id, attemptId },
      {
        onSuccess: (data) => {
          if (data.cancelled) {
            // The host reports that as `{ cancelled: true, result: done }` - `done` describing the cancel, not a
            // credential. Feeding it to `applyResult` would close the dialog claiming the provider had connected.
            forgetAttempt(attemptId);
            return;
          }
          // Nothing was pending: the attempt had already settled, expired or been superseded while the click was in
          // flight, and `result` says which.
          applyResult(data.result, false);
        },
        onError: () => {
          // Keep the panel and the record: the host may still hold this
          // attempt, and this is the only surface that can ask again.
          setCancelError("Couldn't stop the sign-in. Try again.");
        },
      },
    );
  }, [applyResult, attempt, cancelAuth, entry.id, forgetAttempt, providerId]);

  // Three mutually exclusive bodies, resolved as statements rather than nested ternaries inside the JSX: the
  // surface a live attempt owns is not a variant of the form, it replaces it.
  let body: ReactNode;
  if (choices.length === 0) {
    body = (
      <p className="text-ui-xs text-muted-foreground">
        {entry.name} advertises no sign-in method Traycer can drive. Sign in
        with the provider&apos;s own CLI and it will appear as connected here.
      </p>
    );
  } else if (attempt !== null) {
    body = (
      <OauthWaitingPanel
        attempt={attempt}
        code={code}
        onCodeChange={setCode}
        onSubmitCode={handleSubmitCode}
        onReopen={() => {
          void openLink(attempt.authorizationUrl, "auth", null);
        }}
        onCancel={handleCancelAttempt}
        submitting={auth.isPending}
        cancelling={cancelAuth.isPending}
        errorMessage={errorMessage}
        cancelError={cancelError}
      />
    );
  } else {
    body = (
      <ConnectForm
        providerLabel={providerLabel}
        precedenceNotice={credentialPrecedenceNotice(
          entry.source,
          providerLabel,
        )}
        choices={choices}
        choice={choice}
        onChoiceChange={handleChoiceChange}
        entry={entry}
        secret={secret}
        onSecretChange={setSecret}
        answers={answers}
        onAnswerChange={setAnswer}
        errorMessage={errorMessage}
        restartNotice={restartNotice}
        submitting={auth.isPending}
        submitDisabled={submitDisabled}
        onSubmit={handleSubmit}
      />
    );
  }

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent
        className="w-full sm:max-w-md"
        data-testid="model-provider-connect-dialog"
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {/* The provider's own mark, so the dialog and the row it came from
             * name the same thing the same way. */}
            <ModelProviderMark
              id={entry.id}
              configDeclaredCustom={entry.configDeclaredCustom}
              aria-hidden
              className="size-4 shrink-0"
            />
            Connect {entry.name}
          </DialogTitle>
          <DialogDescription>
            {providerLabel} will use this credential for {entry.name} models.
          </DialogDescription>
        </DialogHeader>
        {body}
      </DialogContent>
    </Dialog>
  );
}

function ConnectForm(props: {
  readonly providerLabel: string;
  /** Shown before the fields rather than gating them: the sign-in is legitimate and will be stored, it just may
   * not take effect while the other source outranks it. */
  readonly precedenceNotice: string | null;
  readonly choices: readonly ConnectChoice[];
  readonly choice: ConnectChoice | null;
  readonly onChoiceChange: (id: string) => void;
  readonly entry: ModelProviderEntry;
  readonly secret: string;
  readonly onSecretChange: (value: string) => void;
  readonly answers: ReadonlyMap<string, string>;
  readonly onAnswerChange: (key: string, value: string) => void;
  readonly errorMessage: string | null;
  readonly restartNotice: string | null;
  readonly submitting: boolean;
  readonly submitDisabled: boolean;
  readonly onSubmit: () => void;
}): ReactNode {
  const { choice } = props;
  const visiblePrompts = visibleModelProviderPrompts(
    choice?.prompts ?? [],
    props.answers,
  );
  const showCredentialField = choice !== null && choice.kind === "api";
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (props.submitDisabled) return;
        props.onSubmit();
      }}
    >
      <PrecedenceNotice notice={props.precedenceNotice} />

      <MethodPicker
        choices={props.choices}
        selectedId={choice === null ? "" : choice.id}
        onChoiceChange={props.onChoiceChange}
      />

      {choice !== null && choice.unavailableReason !== null ? (
        <p className="rounded-md border border-border/60 bg-foreground/3 px-3 py-2 text-ui-xs text-muted-foreground">
          {choice.unavailableReason}
        </p>
      ) : null}

      {showCredentialField ? (
        <CredentialField
          providerLabel={props.providerLabel}
          secret={props.secret}
          onSecretChange={props.onSecretChange}
          disabled={choice.unavailableReason !== null}
        />
      ) : null}

      {visiblePrompts.map((prompt) => (
        <PromptField
          key={prompt.key}
          prompt={prompt}
          value={props.answers.get(prompt.key) ?? ""}
          onChange={(value) => props.onAnswerChange(prompt.key, value)}
        />
      ))}

      {choice !== null && choice.kind === "oauth" ? (
        <p className="text-ui-xs text-muted-foreground">
          Continuing opens {props.entry.name} in your browser.
        </p>
      ) : null}

      {props.restartNotice !== null ? (
        <p className="rounded-md border border-border/60 bg-foreground/3 px-3 py-2 text-ui-xs text-muted-foreground">
          {props.restartNotice}
        </p>
      ) : null}
      {props.errorMessage !== null ? (
        <p className="text-ui-xs text-destructive">{props.errorMessage}</p>
      ) : null}

      <div className="flex items-center gap-2">
        <Button type="submit" size="sm" disabled={props.submitDisabled}>
          {props.submitting ? <MutedAgentSpinner /> : null}
          {choice !== null && choice.kind === "oauth" ? "Continue" : "Connect"}
        </Button>
      </div>
    </form>
  );
}

/** A single choice is not a choice: with one way in, the picker would be a control whose only job is to display
 * a constant. */
/** Shown before the fields, not in place of them: what already supplies this provider's credential outranks
 * what the user is about to save, but the sign-in is still legitimate and still stored. */
function PrecedenceNotice(props: {
  readonly notice: string | null;
}): ReactNode {
  if (props.notice === null) return null;
  return (
    <p className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-ui-xs text-amber-900 dark:text-amber-200">
      {props.notice}
    </p>
  );
}

function MethodPicker(props: {
  readonly choices: readonly ConnectChoice[];
  readonly selectedId: string;
  readonly onChoiceChange: (id: string) => void;
}): ReactNode {
  const fieldId = useId();
  if (props.choices.length <= 1) return null;
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={fieldId}>Sign-in method</Label>
      <Select value={props.selectedId} onValueChange={props.onChoiceChange}>
        <SelectTrigger id={fieldId} className="w-full">
          <SelectValue placeholder="Choose a method" />
        </SelectTrigger>
        <SelectContent>
          {props.choices.map((option) => (
            <SelectItem key={option.id} value={option.id}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function CredentialField(props: {
  readonly providerLabel: string;
  readonly secret: string;
  readonly onSecretChange: (value: string) => void;
  readonly disabled: boolean;
}): ReactNode {
  const fieldId = useId();
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={fieldId}>API key</Label>
      <Input
        id={fieldId}
        type="password"
        autoComplete="off"
        spellCheck={false}
        className="w-full font-mono text-ui-sm"
        placeholder="API key"
        value={props.secret}
        disabled={props.disabled}
        onChange={(event) => props.onSecretChange(event.target.value)}
      />
      {/* No env-var name any more: that came from `credentialKey`, which went with the classifier that decided which
         providers could be given a key at all. */}
      <p className="text-ui-xs text-muted-foreground">
        Stored by {props.providerLabel}. It is never shown again.
      </p>
    </div>
  );
}

function PromptField(props: {
  readonly prompt: ModelProviderPrompt;
  readonly value: string;
  readonly onChange: (value: string) => void;
}): ReactNode {
  const fieldId = useId();
  const { prompt } = props;
  if (prompt.type === "select") {
    return (
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={fieldId}>{prompt.message}</Label>
        <Select value={props.value} onValueChange={props.onChange}>
          <SelectTrigger id={fieldId} className="w-full">
            <SelectValue placeholder="Choose one" />
          </SelectTrigger>
          <SelectContent>
            {prompt.options.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.hint === null
                  ? option.label
                  : `${option.label} — ${option.hint}`}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={fieldId}>{prompt.message}</Label>
      <Input
        id={fieldId}
        type="text"
        autoComplete="off"
        spellCheck={false}
        className="w-full text-ui-sm"
        placeholder={prompt.placeholder ?? ""}
        value={props.value}
        onChange={(event) => props.onChange(event.target.value)}
      />
    </div>
  );
}

/** The instructions stay above it verbatim rather than being replaced. */
function ConfirmationCodeField(props: {
  readonly code: string | null;
}): ReactNode {
  const fieldId = useId();
  const { copied, copy } = useClipboardCopy({
    resetMs: 1600,
    onSuccess: null,
    onError: null,
  });
  const code = props.code;
  if (code === null) return null;
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={fieldId}>Confirmation code</Label>
      <div className="flex items-center gap-2">
        <Input
          id={fieldId}
          type="text"
          readOnly
          value={code}
          className="min-w-0 flex-1 font-mono text-ui-sm"
        />
        <Button
          type="button"
          size="icon-sm"
          variant="secondary"
          aria-label={
            copied ? "Confirmation code copied" : "Copy confirmation code"
          }
          onClick={() => copy(code)}
        >
          {copied ? (
            <Check className="size-3.5" aria-hidden />
          ) : (
            <Copy className="size-3.5" aria-hidden />
          )}
        </Button>
      </div>
    </div>
  );
}

/** Both arms show the provider's own `instructions` verbatim when it sent any - it is the only honest copy for
 * a flow Traycer does not otherwise understand, and paraphrasing it would invent steps. */
function OauthWaitingPanel(props: {
  readonly attempt: LiveAttempt;
  readonly code: string;
  readonly onCodeChange: (value: string) => void;
  readonly onSubmitCode: () => void;
  readonly onReopen: () => void;
  readonly onCancel: () => void;
  readonly submitting: boolean;
  readonly cancelling: boolean;
  readonly errorMessage: string | null;
  readonly cancelError: string | null;
}): ReactNode {
  const codeId = useId();
  const { attempt } = props;
  return (
    <div className="flex flex-col gap-3">
      {attempt.instructions !== null ? (
        <p className="rounded-md border border-border/60 bg-foreground/3 px-3 py-2 text-ui-xs whitespace-pre-wrap text-muted-foreground">
          {redactLogText(attempt.instructions)}
        </p>
      ) : null}

      {attempt.method === "auto" ? (
        <>
          <ConfirmationCodeField
            code={extractConfirmationCode(attempt.instructions)}
          />
          <div
            className="flex items-center gap-2 text-ui-sm text-muted-foreground"
            role="status"
          >
            <MutedAgentSpinner />
            Waiting for the browser to finish signing in
          </div>
        </>
      ) : (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={codeId}>Paste the code</Label>
          <div className="flex items-center gap-2">
            <Input
              id={codeId}
              type="text"
              autoComplete="off"
              spellCheck={false}
              className="min-w-0 flex-1 font-mono text-ui-sm"
              placeholder="Paste code"
              value={props.code}
              onChange={(event) => props.onCodeChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== "Enter") return;
                event.preventDefault();
                props.onSubmitCode();
              }}
            />
            <Button
              type="button"
              size="sm"
              disabled={props.submitting || props.code.trim().length === 0}
              onClick={props.onSubmitCode}
            >
              {props.submitting ? <MutedAgentSpinner /> : null}
              Submit
            </Button>
          </div>
        </div>
      )}

      {props.errorMessage !== null ? (
        <p className="text-ui-xs text-destructive">{props.errorMessage}</p>
      ) : null}
      {props.cancelError !== null ? (
        <p className="text-ui-xs text-destructive">{props.cancelError}</p>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={props.onReopen}
        >
          <ExternalLink className="size-3.5" />
          Reopen sign-in page
        </Button>
        {/* It does not revoke anything at the provider. */}
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={props.cancelling}
          onClick={props.onCancel}
        >
          Stop waiting
        </Button>
      </div>
    </div>
  );
}
