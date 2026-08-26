import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { useAuthLinkLoginProgress } from "@/hooks/auth/use-auth-link-login-progress";
import { type LinkLoginProgress } from "@/lib/auth/auth-service";
import { useAuthService } from "@/lib/host";
import { useRemainingSeconds } from "./use-remaining-seconds";

/**
 * The approval wait on the phone, after a scanned or typed code has been
 * claimed: the desktop has to approve before anything is signed in, and the
 * only thing happening in between is a poll loop the user cannot see. This
 * makes that loop legible — a countdown to the next check, and a "Checking…"
 * beat while one is outstanding.
 *
 * There is deliberately no manual re-check: the server paces the poll, so a
 * button would either do nothing or trip the pacing.
 *
 * The countdown reads the loop's own absolute `nextPollAtMs`, never a local
 * copy of the interval — a `slow_down` directive that stretches the wait moves
 * that instant, and the number shown follows it.
 */
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
  // The tail of a wait and an outstanding request both read as "checking":
  // once the countdown hits zero the poll is due, so continuing to show "0s"
  // would be a clock the user can see has stopped.
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

/**
 * The whole wait block: the standing explanation of what is being waited on,
 * plus the poll's live state beneath it. Rendered only while the redeem
 * mutation is in flight.
 *
 * Before the claim round-trip returns there is no poll yet and so no progress
 * to show; the explanation line stands alone for that beat rather than
 * flashing a placeholder countdown.
 */
export function LinkCodeWaitStatus() {
  const auth = useAuthService();
  const progress = useAuthLinkLoginProgress(auth);
  return (
    <div
      className="flex flex-col items-center gap-0.5"
      data-testid="link-code-signin-waiting"
    >
      <p className="text-center text-ui-sm opacity-80">
        Waiting for approval on your computer…
      </p>
      {progress !== null ? (
        <p
          className="text-center text-ui-xs text-muted-foreground tabular-nums"
          data-testid="link-code-signin-poll-status"
        >
          {/* Keyed on the poll target: `useRemainingSeconds` samples the
              clock at mount, so a new target has to arrive as a new
              component or its first render counts down from a stale
              instant and can show one second more than the server
              advertised. */}
          <WaitStatusLine key={progress.nextPollAtMs} progress={progress} />
        </p>
      ) : null}
    </div>
  );
}
