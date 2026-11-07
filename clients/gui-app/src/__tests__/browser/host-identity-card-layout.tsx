import type { ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { MoreHorizontal, Pencil } from "lucide-react";
import { HostIdentityCard } from "@/components/settings/host-scope/host-identity-card";
import { hostScopeOptionFixture } from "@/components/settings/host-scope/host-scope-fixture";
import { Button } from "@/components/ui/button";
import "@/lib/theme-applier";
import "@/index.css";

export function HostCard(props: { readonly failed: boolean }): ReactElement {
  const name = props.failed
    ? "Release integration sandbox with settings that did not apply"
    : "Windows runner for long release integration and deployment checks";
  const host = hostScopeOptionFixture({
    hostId: props.failed ? "fixture-failed" : "fixture-windows",
    name,
    isLocalMachine: false,
    platform: "win32-x64",
    kind: "sandbox",
    sandbox: { state: "awake", frozen: false, summary: null, teamOwned: false },
  });
  return (
    <div data-testid={host.hostId}>
      <HostIdentityCard
        host={host}
        displayName={name}
        nameAction={
          <Button
            type="button"
            variant="muted"
            size="inline"
            className="size-7 shrink-0"
            aria-label="Edit name"
          >
            <Pencil className="size-3.5" />
          </Button>
        }
        nameInput={null}
        busy={false}
        busySessionCount={0}
        busyBreakdown={null}
        actions={
          <div
            className="flex min-w-0 flex-wrap items-center gap-2"
            data-testid="fixture-host-actions"
          >
            <Button type="button" variant="secondary" size="sm">
              {props.failed ? "Repair setup" : "Suspend"}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="More host actions"
            >
              <MoreHorizontal />
            </Button>
          </div>
        }
        healthAction={null}
        lifecycleLine={
          props.failed ? (
            <p>Settings did not apply: setup command failed.</p>
          ) : null
        }
      >
        <div className="px-5 pb-4">Host settings</div>
      </HostIdentityCard>
    </div>
  );
}

const container = document.getElementById("root");
if (container !== null) {
  createRoot(container).render(
    <main className="w-full space-y-4">
      <HostCard failed={false} />
      <HostCard failed />
    </main>,
  );
}
