import type { ReactNode } from "react";
import { toast } from "sonner";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useSandboxAutomation } from "@/hooks/sandboxes/use-sandbox-automation-query";
import { useSandboxAutomationOpen } from "@/hooks/sandboxes/use-sandbox-automation-open-mutation";

/**
 * The host list's Automations entry before the user's row exists: the
 * deployment offers Automations (`available`) and no row has been created
 * yet (`sandbox === null`), so there is no host list row to show. It reads
 * as the row at rest, `released`, with the one action that opens it. Once
 * the open creates the row, the host list carries the real one (its
 * sandbox card) and this renders nothing.
 *
 * Never an Activate: the Automations host is not a target for new work.
 * Renders nothing while the read is pending or has failed, and on a server
 * without the route (which reads as not available).
 */
export function AutomationsHostEntry(): ReactNode {
  const automation = useSandboxAutomation(null);
  const open = useSandboxAutomationOpen();
  const data = automation.data ?? null;
  if (data === null || !data.available || data.sandbox !== null) return null;
  return (
    <div
      className="flex items-center gap-2 px-2 py-1"
      data-testid="settings-automations-entry"
    >
      <span className="min-w-0 flex-1 truncate text-ui-sm">Automations</span>
      <Badge variant="muted" data-testid="settings-automations-entry-state">
        Released
      </Badge>
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={open.isPending}
        data-testid="settings-automations-entry-start"
        onClick={() => {
          open.mutate(null, {
            onSuccess: (settled) => {
              if (settled) toast.success("Automations started");
              else toast.info("Starting Automations…");
            },
          });
        }}
      >
        {open.isPending ? (
          <AgentSpinningDots
            className={undefined}
            testId="settings-automations-entry-start-spinner"
            variant={undefined}
          />
        ) : null}
        Start
      </Button>
    </div>
  );
}
