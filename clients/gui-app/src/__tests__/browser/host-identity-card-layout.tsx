import type { ReactElement } from "react";
import { createRoot } from "react-dom/client";
import type { HostListItem } from "@traycer/protocol/host/host-status";
import { MoreHorizontal, Pencil } from "lucide-react";
import { HostIdentityCard } from "@/components/settings/host-scope/host-identity-card";
import { hostScopeOptionFixture } from "@/components/settings/host-scope/host-scope-fixture";
import { HostOverviewAboutThisHost } from "@/components/settings/panels/host-overview-about-this-host";
import {
  InstallRecordGroup,
  type InstallationDetailsRecord,
} from "@/components/settings/panels/host-settings-installation-details";
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
        version={host.version}
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

function accountItem(): HostListItem {
  return {
    hostId: "8f14e45fceea167a5a36dedd4bea2543c9a2",
    displayName: null,
    platform: "darwin-arm64",
    kind: "personal",
    publicKey: "pk",
    createdAt: "2026-03-03T12:00:00Z",
    status: {
      connectivity: "connectable",
      viewerReachability: "unknown",
      clientCloud: "ok",
      updateState: "current",
      appVersion: "1.5.0",
      lastSeenAt: "2026-11-08T00:00:00Z",
    },
    updatePolicy: "manual",
  };
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
  return (
    <>
      <HostOverviewAboutThisHost
        item={accountItem()}
        nowMs={Date.parse("2026-11-09T12:00:00Z")}
      />
      <InstallRecordGroup
        hostName="Windows runner for long release integration and deployment checks"
        degrade={null}
        record={record}
        loading={false}
        readFailed={false}
      />
    </>
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
