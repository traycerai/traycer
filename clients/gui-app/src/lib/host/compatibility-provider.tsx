import { useState, type ReactNode } from "react";
import { useEffectiveHostId } from "@/hooks/host/use-effective-host-id";
import { useHostClientForHostId } from "@/hooks/host/use-host-client-for-host-id";
import { useHostDirectoryList } from "@/hooks/host/use-host-directory-list-query";
import { useHostLeases } from "@/hooks/host/use-host-lease";
import {
  HostCompatibilityContext,
  useHostCompatibilityAuthorityReport,
  useHostCompatibilityProbe,
  useHostCompatibilityProbeForClient,
  useHostStatusReprobeOnRepoint,
  useHostStatusReprobeOnRowVersionChange,
} from "@/lib/host/compatibility-state";

export function HostCompatibilityProvider(props: {
  readonly children: ReactNode;
}): ReactNode {
  const effectiveHostId = useEffectiveHostId();
  const compatibility = useHostCompatibilityProbe();
  // The probe's verdict is also SELECTION evidence (D13/C4): reported from
  // here, one level up from the state machine, because that machine is a
  // render function and reporting from render double-fires under StrictMode.
  useHostCompatibilityAuthorityReport(compatibility, effectiveHostId);
  // A host becoming effective re-probes it. Here rather than inside the probe
  // hook because the trigger is the POINTER moving, which the probe cannot
  // see: it only ever knows the host it is currently keyed to.
  useHostStatusReprobeOnRepoint(effectiveHostId);
  // A host parked on dead("incompatible") is unreachable by BOTH triggers
  // above: it is not effective and cannot become effective until a fresh
  // probe clears it. One recovery probe per such host closes that loop - the
  // update that would fix it announces itself as the directory row's version
  // moving, and the verdict reports through the same seam as the main probe.
  const leases = useHostLeases();
  const directory = useHostDirectoryList();
  const rows = directory.data ?? [];
  const recoveryHosts = leases.flatMap((lease) => {
    if (lease.hostId === effectiveHostId) return [];
    if (lease.status !== "dead" || lease.dead.reason !== "incompatible") {
      return [];
    }
    return [
      {
        hostId: lease.hostId,
        version:
          rows.find((row) => row.hostId === lease.hostId)?.version ?? null,
        condemnedVersion: lease.dead.detail.hostVersion,
      },
    ];
  });
  return (
    <HostCompatibilityContext.Provider value={compatibility}>
      {recoveryHosts.map((host) => (
        <IncompatibleHostRecoveryProbe
          key={host.hostId}
          hostId={host.hostId}
          version={host.version}
          condemnedVersion={host.condemnedVersion}
        />
      ))}
      {props.children}
    </HostCompatibilityContext.Provider>
  );
}

/**
 * A component rather than a loop of hooks, for the usual rules-of-hooks
 * reason: the incompatible set changes size. Renders nothing - its work is
 * the probe it mounts and the verdict that probe reports.
 */
function IncompatibleHostRecoveryProbe(props: {
  readonly hostId: string;
  readonly version: string | null;
  readonly condemnedVersion: string | null;
}): ReactNode {
  const client = useHostClientForHostId(props.hostId);
  // ARMED only by evidence of an update: a row version that differs from the
  // one the verdict condemned, or - when the verdict carried no version - a
  // row version that MOVED while this watcher was mounted. Probing the same
  // build again right after it answered INCOMPATIBLE would be a wasted
  // duplicate (the incompatible-dispatch pin rightly counts dispatches), so
  // until the update shows itself this component watches and sends nothing:
  // the null client below is `useHostQuery`'s own dispatch gate.
  const [baselineVersion] = useState<string | null>(props.version);
  const armed =
    props.version !== null &&
    (props.condemnedVersion !== null
      ? props.version !== props.condemnedVersion
      : props.version !== baselineVersion);
  const compatibility = useHostCompatibilityProbeForClient(
    armed ? client : null,
    props.hostId,
  );
  useHostCompatibilityAuthorityReport(compatibility, props.hostId);
  useHostStatusReprobeOnRowVersionChange(props.hostId, props.version);
  return null;
}
