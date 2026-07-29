import type { SyntheticEvent } from "react";
import { useEffect, useRef, useState } from "react";
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

function StepUpChallengeDialogActive(props: {
  readonly request: StepUpPromptRequest;
  readonly onVerified: (credential: StepUpCredential) => void;
  readonly onCancel: () => void;
}) {
  const requestChallenge = useAuthRequestStepUpChallenge();
  const verifyChallenge = useAuthVerifyStepUpChallenge();
  const [code, setCode] = useState("");
  const [challengeSent, setChallengeSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = requestChallenge.isPending || verifyChallenge.isPending;
  const requestChallengeMutateAsync = requestChallenge.mutateAsync;
  const mountedRef = useRef(true);
  const { title, description } = dialogCopy(props.request);

  useEffect(() => {
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    let active = true;
    void requestChallengeMutateAsync()
      .then(() => {
        if (active) {
          setChallengeSent(true);
        }
      })
      .catch((caught: unknown) => {
        if (active) {
          setError(messageFromError(caught));
        }
      });
    return () => {
      active = false;
    };
  }, [requestChallengeMutateAsync]);

  const handleResend = (): void => {
    setError(null);
    setChallengeSent(false);
    void requestChallenge
      .mutateAsync()
      .then(() => {
        setChallengeSent(true);
      })
      .catch((caught: unknown) => {
        setError(messageFromError(caught));
      });
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
            {requestChallenge.isPending ? (
              <p className="flex items-center gap-2 text-ui-xs text-muted-foreground">
                <AgentSpinningDots
                  className="text-current"
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
                  className="text-current"
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
