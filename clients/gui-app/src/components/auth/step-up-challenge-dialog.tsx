import type { SyntheticEvent } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Mail, RefreshCcw, ShieldCheck } from "lucide-react";
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
import { Input } from "@/components/ui/input";
import {
  useAuthRequestStepUpChallenge,
  useAuthVerifyStepUpChallenge,
} from "@/hooks/auth/use-step-up-challenge-mutations";
import {
  createStepUpCredential,
  type StepUpCredential,
} from "@/lib/auth/step-up-flow";
import {
  messageFromError,
  normalizeStepUpCodeInput,
  STEP_UP_CODE_LENGTH,
  type StepUpPromptRequest,
} from "@/lib/auth/step-up-prompt";

function dialogCopy(request: StepUpPromptRequest): {
  readonly title: string;
  readonly description: string;
} {
  if (request.purpose === "global-revoke") {
    return {
      title: "Verify sign out everywhere",
      description:
        "Enter the code sent to your email before signing out every session.",
    };
  }
  if (request.purpose === "host-provision") {
    const machine = request.subjectLabel ?? "this machine";
    return {
      title: "Authorize background work",
      description: `Enter the code sent to your email so ${machine} can keep running your work after you disconnect.`,
    };
  }
  return {
    title: "Verify session sign-out",
    description:
      "Enter the code sent to your email to continue signing out sessions.",
  };
}

export function StepUpChallengeDialog(props: {
  readonly request: StepUpPromptRequest | null;
  readonly onVerified: (credential: StepUpCredential) => void;
  readonly onCancel: () => void;
}) {
  if (props.request === null) {
    return null;
  }
  return (
    <StepUpChallengeDialogActive
      key={props.request.id}
      request={props.request}
      onVerified={props.onVerified}
      onCancel={props.onCancel}
    />
  );
}

/**
 * Where the emailed code stands. `sending` is the dialog's own record of the
 * challenge request in flight, not `requestChallenge.isPending`: the first
 * send fires from a mount effect, and under StrictMode (every dev build) that
 * effect's setup -> cleanup -> setup unsubscribes the mutation's observer in
 * between. TanStack then detaches the observer from the request already in
 * flight and never re-attaches it, so its `isPending` stays true for good -
 * which held `busy` on, disabled every button and never left "Sending code".
 */
type ChallengeStatus = "sending" | "sent" | "unsent";

function StepUpChallengeDialogActive(props: {
  readonly request: StepUpPromptRequest;
  readonly onVerified: (credential: StepUpCredential) => void;
  readonly onCancel: () => void;
}) {
  const requestChallenge = useAuthRequestStepUpChallenge();
  const verifyChallenge = useAuthVerifyStepUpChallenge();
  const [code, setCode] = useState("");
  // Opens `sending`: the mount effect below sends the first code.
  const [challenge, setChallenge] = useState<ChallengeStatus>("sending");
  const [error, setError] = useState<string | null>(null);
  const challengeSent = challenge === "sent";
  // Verify only ever starts from a submit, long after the mount pass, so its
  // observer stays attached and its `isPending` is sound.
  const busy = challenge === "sending" || verifyChallenge.isPending;
  const requestChallengeMutateAsync = requestChallenge.mutateAsync;
  const mountedRef = useRef(true);
  const autoSentRef = useRef(false);
  const sendAttemptRef = useRef(0);
  const { title, description } = dialogCopy(props.request);

  // Set on every effect RUN, not only at declaration: StrictMode's cleanup
  // between its two setups would otherwise leave this false for the life of
  // the dialog - no sent code would ever be applied, and a verified one would
  // never reach `onVerified`.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // One send's answer, applied only while it is still the latest send and the
  // dialog is still open. The outcome travels on `mutateAsync`'s promise,
  // which settles whatever the observer is doing, and every rejection is
  // consumed here - the dialog says it inline, nothing toasts.
  const sendChallenge = useCallback((): void => {
    sendAttemptRef.current += 1;
    const attempt = sendAttemptRef.current;
    const current = (): boolean =>
      attempt === sendAttemptRef.current && mountedRef.current;
    void requestChallengeMutateAsync().then(
      () => {
        if (current()) setChallenge("sent");
      },
      (caught: unknown) => {
        if (!current()) return;
        setChallenge("unsent");
        setError(messageFromError(caught));
      },
    );
  }, [requestChallengeMutateAsync]);

  useEffect(() => {
    // Guard the REQUEST: StrictMode runs this effect setup -> cleanup ->
    // setup on mount, and without the latch the second setup would send a
    // second verification email for one prompt. A ref rather than state
    // because the second setup must read it synchronously, before any
    // re-render. No per-setup `active` flag: the cleanup between the two
    // setups would clear it for the one request that is actually in flight.
    // The parent keys this component on `request.id`, so a genuinely new
    // prompt gets a fresh instance and a fresh ref; explicit re-sends go
    // through `handleResend`.
    if (autoSentRef.current) return;
    autoSentRef.current = true;
    sendChallenge();
  }, [sendChallenge]);

  const handleResend = (): void => {
    setError(null);
    setChallenge("sending");
    sendChallenge();
  };

  const handleSubmit = (event: SyntheticEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const normalized = normalizeStepUpCodeInput(code);
    if (!challengeSent || normalized.length !== STEP_UP_CODE_LENGTH || busy) {
      setError("Enter the 6-digit verification code.");
      return;
    }
    setError(null);
    void verifyChallenge
      .mutateAsync(normalized)
      .then((response) => {
        if (mountedRef.current) {
          props.onVerified(createStepUpCredential(response, Date.now()));
        }
      })
      .catch((caught: unknown) => {
        setError(messageFromError(caught));
      });
  };

  return (
    <Dialog
      open
      onOpenChange={
        busy
          ? undefined
          : (nextOpen) => {
              if (!nextOpen) {
                props.onCancel();
              }
            }
      }
    >
      <DialogContent
        showCloseButton={!busy}
        className="w-[min(92vw,26rem)] sm:max-w-md"
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <form className="space-y-4" onSubmit={handleSubmit}>
          <div className="space-y-2">
            <label
              htmlFor="step-up-code"
              className="text-ui-xs font-medium text-muted-foreground"
            >
              Email code
            </label>
            <div className="flex items-center gap-2">
              <Mail className="size-4 shrink-0 text-muted-foreground" />
              <Input
                id="step-up-code"
                value={code}
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={STEP_UP_CODE_LENGTH}
                disabled={!challengeSent || busy}
                aria-invalid={error !== null}
                onChange={(event) => {
                  setCode(normalizeStepUpCodeInput(event.currentTarget.value));
                }}
              />
            </div>
            {challenge === "sending" ? (
              <p className="flex items-center gap-2 text-ui-xs text-muted-foreground">
                <AgentSpinningDots
                  className={undefined}
                  testId={undefined}
                  variant="orbit"
                />
                Sending code
              </p>
            ) : null}
            {challengeSent && error === null ? (
              <p className="text-ui-xs text-muted-foreground">
                Check your email for the verification code.
              </p>
            ) : null}
            {error === null ? null : (
              <p className="text-ui-xs text-destructive" role="alert">
                {error}
              </p>
            )}
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={props.onCancel}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={handleResend}
            >
              <RefreshCcw className="size-3.5" />
              Resend code
            </Button>
            <Button
              type="submit"
              size="sm"
              disabled={
                !challengeSent || code.length !== STEP_UP_CODE_LENGTH || busy
              }
            >
              <ShieldCheck className="size-3.5" />
              Verify
              {verifyChallenge.isPending ? (
                <AgentSpinningDots
                  className={undefined}
                  testId={undefined}
                  variant="orbit"
                />
              ) : null}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
