import type { ReactNode } from "react";
import { ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ignoreError } from "@/lib/browser-view/ignore-error";
import { useOpenLink } from "@/lib/links/open-link";
import { useRunnerHostOrNull } from "@/providers/use-runner-host";

/**
 * Opens one of the account's dashboard pages. `page` builds its address from
 * the shell's sign-in origin; with no shell there is no origin to name, so
 * nothing is offered.
 */
export function DashboardLinkButton(props: {
  readonly page: (signInUrl: string) => string;
  readonly label: string;
  readonly testId: string;
}): ReactNode {
  const runnerHost = useRunnerHostOrNull();
  const openLink = useOpenLink();
  if (runnerHost === null) return null;
  const url = props.page(runnerHost.signInUrl);
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      data-testid={props.testId}
      onClick={(event) => {
        void openLink(url, "account", event).catch(ignoreError);
      }}
    >
      <ExternalLink className="size-3.5 shrink-0" aria-hidden />
      {props.label}
    </Button>
  );
}
