import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { useAuthLinkLoginProgress } from "@/hooks/auth/use-auth-link-login-progress";
import { type LinkLoginProgress } from "@/lib/auth/auth-service";
import { useAuthService } from "@/lib/host";
import { useRemainingSeconds } from "./use-remaining-seconds";

/** The approval wait on the phone, after a scanned or typed code has been claimed: the desktop has to approve
 * before anything is signed in, and the only thing happening in between is a poll loop the user cannot see. */
function WaitStatusLine(props: { readonly progress: LinkLoginProgress }) {
  const secondsToNextPoll = useRemainingSeconds(props.progress.nextPollAtMs);
  if (props.progress.phase === "finalizing") {
    return (
      <span className="inline-flex items-center gap-1.5">
        <AgentSpinningDots
          variant="dots"
          className={undefined}
          testId="link-code-signin-finalizing-spinner"
        />
        Approved — finishing sign-in
      </span>
    );
  }
  // The tail of a wait and an outstanding request both read as "checking": once the countdown hits zero the poll
  // is due, so continuing to show "0s" would be a clock the user can see has stopped.
  if (props.progress.phase === "checking" || secondsToNextPoll === 0) {
    return (
      <span className="inline-flex items-center gap-1.5">
        <AgentSpinningDots
          variant="dots"
          className={undefined}
          testId="link-code-signin-checking-spinner"
        />
        Checking…
      </span>
    );
  }
  return <>Checking again in {secondsToNextPoll}s</>;
}

/** Before the claim round-trip returns there is no poll yet and so no progress to show; the explanation line
 * stands alone for that beat rather than flashing a placeholder countdown. */
export function LinkCodeWaitStatus() {
  const auth = useAuthService();
  const progress = useAuthLinkLoginProgress(auth);
  const matchCode = progress === null ? null : progress.matchCode;
  return (
    <div
      className="flex flex-col items-center gap-0.5"
      data-testid="link-code-signin-waiting"
    >
      {matchCode !== null ? (
        // The claim's match code, large: the desktop's prompt asks "Does your phone show NN?", and this is the NN.
        <p
          className="text-center text-ui-sm"
          data-testid="link-code-signin-match-code"
          role="status"
          aria-live="polite"
        >
          Your code:{" "}
          <span className="font-mono text-title-lg tabular-nums">
            {matchCode}
          </span>
        </p>
      ) : null}
      <p className="text-center text-ui-sm opacity-80">
        Waiting for approval on your computer…
      </p>
      {matchCode !== null ? (
        <p
          className="text-center text-ui-xs text-muted-foreground"
          data-testid="link-code-signin-match-code-hint"
        >
          If your computer asks, it should show this code.
        </p>
      ) : null}
      {progress !== null ? (
        <p
          className="text-center text-ui-xs text-muted-foreground tabular-nums"
          data-testid="link-code-signin-poll-status"
        >
          {/* Keyed on the poll target: `useRemainingSeconds` samples the clock at mount. */}
          <WaitStatusLine key={progress.nextPollAtMs} progress={progress} />
        </p>
      ) : null}
    </div>
  );
}
