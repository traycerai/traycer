import type { ReactNode } from "react";
import { Laptop } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { HostScope } from "@/components/settings/host-scope/use-host-scope";

/**
 * Shown by a host-scoped section whose transport cannot reach the selected
 * host.
 *
 * Shell config and log levels are per-host settings — they live in the config
 * store next to the host they configure — but this client reads that store
 * through the local CLI bridge, so it can only ever describe the host running
 * on this computer. The honest response is to say which host is out of reach
 * and offer the way back, NOT to render this computer's values under a remote
 * host's name: that substitution is the exact failure the whole scope model
 * exists to prevent.
 *
 * These sections therefore stay inside the host group where they belong, and
 * pay for the missing RPC with one notice instead of with a permanent lie
 * about what they configure.
 */
export function RequiresLocalHostNotice(props: {
  readonly scope: HostScope;
  /** What this section configures, lower-case: "shell configuration". */
  readonly subject: string;
}): ReactNode {
  const { scope } = props;
  const localHost = scope.hosts.find((host) => host.isLocalMachine) ?? null;
  return (
    <div
      className="flex flex-col items-start gap-3 px-5 py-8 text-ui-sm"
      data-testid="requires-local-host-notice"
    >
      <span className="flex size-9 items-center justify-center rounded-lg bg-muted/60 text-muted-foreground">
        <Laptop className="size-4.5" />
      </span>
      <div className="max-w-[60ch] space-y-1">
        <p className="font-medium text-foreground">
          {props.subject.charAt(0).toUpperCase() + props.subject.slice(1)} lives
          on {scope.hostLabel}
        </p>
        <p className="text-muted-foreground">
          This window can only read it for the host running on this computer.
          Open Traycer on {scope.hostLabel} to change it there.
        </p>
      </div>
      {localHost === null ? null : (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => scope.setHostId(localHost.hostId)}
          data-testid="requires-local-host-switch"
        >
          Show {localHost.name}
        </Button>
      )}
    </div>
  );
}
