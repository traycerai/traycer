import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { useConfigurationName } from "./team-pick-label";

/** A team page's failed read: one line, with Retry beside it. */
export function TeamReadFailed(props: {
  readonly message: string;
  readonly onRetry: () => void;
}): ReactNode {
  return (
    <p
      role="status"
      className="flex flex-wrap items-baseline gap-x-1 text-ui-sm text-muted-foreground"
    >
      {props.message}
      <Button
        type="button"
        variant="link"
        size="inline"
        onClick={props.onRetry}
      >
        Retry
      </Button>
    </p>
  );
}

/**
 * A cloud-read page's failed read, naming the configuration and the page:
 * "Couldn't read <Team>'s <page>." or "Couldn't read Personal's <page>."
 */
export function ConfigurationReadFailed(props: {
  readonly page: string;
  readonly onRetry: () => void;
}): ReactNode {
  const name = useConfigurationName();
  return (
    <TeamReadFailed
      message={`Couldn't read ${name}'s ${props.page}.`}
      onRetry={props.onRetry}
    />
  );
}
