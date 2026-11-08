import type { ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { MoreHorizontal, Pencil } from "lucide-react";
import { HostIdentityCard } from "@/components/settings/host-scope/host-identity-card";
import { hostScopeOptionFixture } from "@/components/settings/host-scope/host-scope-fixture";
import {
  HostOverviewFact,
  HostOverviewFacts,
} from "@/components/settings/panels/host-overview-facts";
import {
  deriveInstallationDetails,
  deriveInstallRecordRows,
} from "@/components/settings/panels/host-overview-installation-model";
import type { InstallationDetailsRecord } from "@/components/settings/panels/host-settings-installation-details";
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

function InstallationFacts(): ReactElement {
  const record: InstallationDetailsRecord = {
    version:
      "local-runtime-2026-11-08-release-integration-with-a-long-build-identifier",
    runtimeVersion: "1.5.0",
    installedAt: "2026-11-08T00:00:00Z",
    source: { kind: "registry", value: "1.5.0" },
    archiveSha256: "a".repeat(64),
    signatureVerifiedAt: null,
    signatureKeyId: "local-file:unsigned",
    platform: "darwin",
    arch: "arm64",
  };
  const rows = [
    ...deriveInstallationDetails({
      about: null,
      live: true,
      runningVersion: "1.5.0",
      record,
    }),
    ...deriveInstallRecordRows(record, "1.5.0"),
  ];
  return (
    <section aria-label="Installation facts" data-testid="fixture-installation">
      <HostOverviewFacts testId="fixture-installation-facts">
        {rows.map((row) => (
          <HostOverviewFact key={row.testId} {...row} />
        ))}
      </HostOverviewFacts>
    </section>
  );
}

const container = document.getElementById("root");
if (container !== null) {
  createRoot(container).render(
    <main className="w-full space-y-4">
      <HostCard failed={false} />
      <HostCard failed />
      <InstallationFacts />
    </main>,
  );
}
