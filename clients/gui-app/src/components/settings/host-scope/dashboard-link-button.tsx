import type { ReactNode } from "react";
import { ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useDashboardPageOpener } from "@/components/settings/host-scope/use-dashboard-page-opener";

/**
 * A button that opens one of the account's dashboard pages
 * (`useDashboardPageOpener`); nothing is offered with no shell.
 */
export function DashboardLinkButton(props: {
  readonly page: (signInUrl: string) => string;
  readonly label: string;
  readonly testId: string;
}): ReactNode {
  const open = useDashboardPageOpener(props.page);
  if (open === null) return null;
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      data-testid={props.testId}
      onClick={open}
    >
      <ExternalLink className="size-3.5 shrink-0" aria-hidden />
      {props.label}
    </Button>
  );
}
