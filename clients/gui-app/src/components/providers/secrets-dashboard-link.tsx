import type { ReactNode } from "react";
import { ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useOpenLink } from "@/lib/links/open-link";
import { ignoreError } from "@/lib/browser-view/ignore-error";
import {
  SECRETS_DASHBOARD_LABEL,
  secretsDashboardUrl,
} from "@/lib/sandboxes/secrets-dashboard";
import { useRunnerHostOrNull } from "@/providers/use-runner-host";

/**
 * Opens the account's Secrets page on the dashboard. Null-tolerant like the
 * settings rail it sits in: with no shell there is no platform origin to
 * name, so nothing is offered (and nothing below mounts).
 */
export function SecretsDashboardLink(props: {
  readonly testId: string;
  readonly className: string | undefined;
}): ReactNode {
  const runnerHost = useRunnerHostOrNull();
  if (runnerHost === null) return null;
  return (
    <SecretsDashboardButton
      testId={props.testId}
      className={props.className}
      url={secretsDashboardUrl(runnerHost.signInUrl)}
    />
  );
}

function SecretsDashboardButton(props: {
  readonly testId: string;
  readonly className: string | undefined;
  readonly url: string;
}): ReactNode {
  const openLink = useOpenLink();
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className={props.className}
      data-testid={props.testId}
      onClick={(event) => {
        void openLink(props.url, "account", event).catch(ignoreError);
      }}
    >
      <ExternalLink className="size-3.5 shrink-0" aria-hidden />
      {SECRETS_DASHBOARD_LABEL}
    </Button>
  );
}

/**
 * The one line a sandbox host's provider settings show in place of its
 * credential controls (`providers.list@10.5` `credentialsManagedInAccount`):
 * sign-ins and keys for sandboxes are stored in the account, not sent to the
 * sandbox.
 */
export function AccountManagedCredentialsLine(): ReactNode {
  return (
    <div
      data-testid="credentials-managed-in-account"
      className="flex flex-wrap items-center gap-x-2 gap-y-1 text-ui-xs text-muted-foreground"
    >
      <p className="min-w-0">
        Sign-ins and keys for sandboxes are stored in your account, where agents
        can use them and never read them.
      </p>
      <SecretsDashboardLink
        testId="credentials-managed-in-account-link"
        className={undefined}
      />
    </div>
  );
}
