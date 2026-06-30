import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { useAuthService } from "@/lib/host";
import { cn } from "@/lib/utils";
import { HERO_PRIMARY_BUTTON_CLASS } from "./styles";

export function PrimarySignInButton(props: {
  readonly isHero: boolean;
  readonly isSigningIn: boolean;
}) {
  const auth = useAuthService();
  const label = props.isSigningIn ? "Signing in" : "Sign in";

  return (
    <Button
      type="button"
      size={props.isHero ? "lg" : "sm"}
      variant={props.isHero ? "default" : "outline"}
      disabled={props.isSigningIn}
      onClick={() => {
        void auth.signIn();
      }}
      data-testid="signin-button"
      className={cn(
        "cursor-pointer",
        props.isHero && HERO_PRIMARY_BUTTON_CLASS,
      )}
    >
      {label}
      {props.isSigningIn ? (
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
  const auth = useAuthService();

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
      onClick={() => {
        void auth.signIn();
      }}
      className={cn(
        props.isHero ? "h-auto justify-center px-0 py-0 text-ui-sm" : null,
      )}
    >
      Taking too long? Retry
    </Button>
  );
}
