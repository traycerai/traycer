import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { useAuthSignInMutation } from "@/hooks/auth/use-auth-sign-in-mutation";
import { cn } from "@/lib/utils";
import { HERO_PRIMARY_BUTTON_CLASS } from "./styles";

export function PrimarySignInButton(props: {
  readonly isHero: boolean;
  readonly isSigningIn: boolean;
}) {
  const signInMutation = useAuthSignInMutation();
  const isPending = props.isSigningIn || signInMutation.isPending;

  return (
    <Button
      type="button"
      size={props.isHero ? "lg" : "sm"}
      variant={props.isHero ? "default" : "outline"}
      disabled={isPending}
      onClick={() => {
        signInMutation.mutate();
      }}
      data-testid="signin-button"
      className={cn(
        "cursor-pointer",
        props.isHero && HERO_PRIMARY_BUTTON_CLASS,
      )}
    >
      Sign in
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
