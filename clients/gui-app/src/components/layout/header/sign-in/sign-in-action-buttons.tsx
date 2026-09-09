import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { useAuthSignInMutation } from "@/hooks/auth/use-auth-sign-in-mutation";
import { cn } from "@/lib/utils";
import { HERO_PRIMARY_BUTTON_CLASS } from "./styles";

export function PrimarySignInButton(props: {
  readonly isHero: boolean;
  readonly isSigningIn: boolean;
  /**
   * True when the last error was `AUTH_ERROR_ACCOUNT_UNAVAILABLE`.
   *
   * The action is unchanged - the device flow is how you sign in as anybody -
   * but the LABEL is not, and the difference is the whole point. In that state
   * the account on this device is gone server-side, so a generic "Sign in" sits
   * directly beneath "This account is no longer available." and offers the one
   * path that cannot work. The escape is a DIFFERENT account, and the button is
   * where the user finds that out.
   */
  readonly offersDifferentAccount: boolean;
  /**
   * Visual weight, not behavior: the mobile app's sign-in screen leads with
   * the scan action and demotes the browser device flow to a same-width
   * secondary button beneath it; everywhere else this stays the primary.
   */
  readonly emphasis: "primary" | "secondary";
}) {
  const signInMutation = useAuthSignInMutation();
  const isPending = props.isSigningIn || signInMutation.isPending;
  const label = props.offersDifferentAccount
    ? "Sign in with a different account"
    : "Sign in";
  const heroVariant = props.emphasis === "primary" ? "default" : "secondary";

  return (
    <Button
      type="button"
      size={props.isHero ? "lg" : "sm"}
      variant={props.isHero ? heroVariant : "outline"}
      disabled={isPending}
      onClick={() => {
        signInMutation.mutate();
      }}
      data-testid="signin-button"
      className={cn(
        "cursor-pointer",
        props.isHero &&
          props.emphasis === "primary" &&
          HERO_PRIMARY_BUTTON_CLASS,
        props.isHero && props.emphasis === "secondary" && "w-full",
      )}
    >
      {label}
      {isPending ? (
        <AgentSpinningDots
          variant="dots"
          className="ml-1.5"
          testId="signin-spinner"
        />
      ) : null}
    </Button>
  );
}

export function RetrySignInButton(props: {
  readonly isHero: boolean;
  readonly isSigningIn: boolean;
}) {
  const signInMutation = useAuthSignInMutation();

  if (!props.isSigningIn) return null;

  return (
    // A stalled browser attempt (callback never returns) would otherwise leave
    // the user stuck on "Signing in" until the timeout. `signIn()` is
    // re-entrant - it supersedes the in-flight attempt and re-opens the sign-in
    // surface - so this gives an immediate escape hatch.
    <Button
      type="button"
      size={props.isHero ? "default" : "sm"}
      variant="link"
      data-testid="signin-retry-link"
      disabled={signInMutation.isPending}
      onClick={() => {
        signInMutation.mutate();
      }}
      className={cn(
        props.isHero ? "h-auto justify-center px-0 py-0 text-ui-sm" : null,
      )}
    >
      Taking too long? Retry
    </Button>
  );
}
