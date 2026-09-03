import type {
  HostTreeResourceSnapshotWireV15,
  OwnerResourceSnapshotWireV15,
} from "@traycer/protocol/host/resources/subscribe";
import type { HostScope } from "@/components/settings/host-scope/use-host-scope";
import type { DesktopAppResourceUsage } from "@/lib/resources/desktop-app-resource-usage";
import {
  sumCompleteMemoryBytes,
  type ResourceMemoryMetric,
} from "@/lib/resources/memory-metric";
import {
  EMPTY_GLOBAL_RESOURCE_PROJECTION,
  type GlobalResourceProjection,
} from "@/stores/resources/resources-registry";
import type { AppResourceUsage } from "@/stores/resources/resources-store";

/**
 * The one number every surface that summarizes a machine's load shows. Homed
 * here rather than beside any one of them so the strip and the panel can never
 * report a different total for the same host.
 */
export interface HeadlineResourceSummary {
  readonly cpuPercent: number;
  readonly memoryBytes: number | null;
  readonly rssBytes: number | null;
  readonly pssBytes: number | null;
  readonly privateBytes: number | null;
  readonly trackedProcessCount: number;
}

interface DesktopResourceSummary {
  readonly cpuPercent: number;
  readonly rssBytes: number;
  readonly processCount: number;
}

/** Everything watching another machine changes about what a surface reads. */
export interface ResourceMonitorHostReading {
  /**
   * Where a kill goes for rows that carry no host of their own - the "Other"
   * roots. Owner rows route by their own `owner.hostId` and never consult this.
   */
  readonly killHostId: string | null;
  readonly projection: GlobalResourceProjection;
  readonly desktopApp: DesktopAppResourceUsage | null;
}

/**
 * Whether "Traycer Desktop" — the Electron shell, which is THIS computer's
 * process — belongs in the reading.
 *
 * The test is the machine's IDENTITY, not whether the surface happens to be
 * following the active selection. Those come apart in both directions: the
 * active host can itself be a remote machine (counting the local shell there
 * attributes this computer's memory to another one, over a "RAM share"
 * denominator its numerator never came from), and someone can explicitly pick
 * the machine they are sitting at while the active host is elsewhere — where
 * the row is exactly what they asked for.
 *
 * With no host resolved the answer is "we do not know which machine this is
 * describing", and the row stays hidden — which is also what it did before
 * there was a picker, since `isViewingActive` is itself false until a host
 * resolves (`isFollowing` requires one). Reaching for `isViewingActive` as a
 * cold-start fallback here looks like it preserves something and cannot: it is
 * false in exactly the case it would be consulted.
 */
function readingShowsLocalDesktop(scope: HostScope): boolean {
  return scope.host?.isLocalMachine === true;
}

/**
 * Reconcile a surface's three host-dependent inputs in ONE place, so the
 * "which machine is this" question is answered once rather than re-derived
 * beside every consumer — the shape of mistake where the totals move to the
 * picked host and the kill route quietly does not.
 *
 * Following the active host every answer is what it was before the picker
 * existed; nothing about a single-host window changes.
 */
export function resolveResourceMonitorHostReading(input: {
  readonly scope: HostScope;
  readonly hasExplicitPick: boolean;
  readonly streamed: GlobalResourceProjection;
  readonly localDesktopApp: DesktopAppResourceUsage | null;
}): ResourceMonitorHostReading {
  // ONE value answers "which machine is this reading about", and it answers it
  // for both the data and the actions. Deriving the kill target from a second
  // reader of the active host — `useAddressableHostId`, which this used to
  // call — is what let the two disagree: on an ambient host swap it moved to
  // the new machine a commit before the stream transport did, so the panel
  // showed the old host's processes with kills aimed at the new one. That
  // needed no picker to happen, and no pick to reproduce.
  return {
    killHostId: input.scope.hostId,
    projection: attributedProjection({
      scopeHostId: input.scope.hostId,
      hasExplicitPick: input.hasExplicitPick,
      streamed: input.streamed,
    }),
    desktopApp: readingShowsLocalDesktop(input.scope)
      ? input.localDesktopApp
      : null,
  };
}

/**
 * The projection, or nothing, according to what this surface is CLAIMING —
 * and the two claims differ, so the burden of proof does too.
 *
 * The projection is a module singleton that outlives any one transport, so it
 * can describe a machine the current reading was not opened against: a host
 * swap still in flight (ambient or scoped — the registry entry is named at
 * acquire time, one commit before the replacement binding reaches context), or
 * a pick just dropped, where the entry still carries the abandoned host's name.
 *
 * **Under a pick** the surface is accountable to a machine the person named, so
 * it owes positive proof: the projection must say this host, or there is
 * nothing to show. An unattributed projection is not good enough — that is
 * exactly the pre-v1.1 per-epic fallback, which rides the ambient transport and
 * would put one machine's processes under another's name.
 *
 * **With no pick** nothing on screen names a machine; the only thing that can
 * go wrong is a kill routed at a host these rows did not come from. So refuse
 * what can be PROVEN foreign and nothing more. A scope that has not resolved
 * its host id — every cold start, between the ambient stream connecting and the
 * host lists answering — proves nothing, and has no kill target either
 * (`defaultHostId` is null, so the Other roots offer no action). Demanding
 * proof there would blank a working monitor on every launch to defend a name it
 * never prints.
 *
 * The branch is `hasExplicitPick`, NOT `isViewingActive`. The latter is false
 * throughout that same cold-start window (see `watchesNamedHost`), so keying on
 * it puts the strict branch in charge of exactly the case the permissive branch
 * exists for — which is the bug this comment used to describe as fixed.
 *
 * Exported because the rule belongs to every surface that reads the global
 * projection while NAMING a host, not to the panel that happened to need it
 * first. The bottom strip names one unconditionally — its host chip is always
 * on screen — so it runs its projection through this before reading a single
 * number. It takes the host id rather than the whole `HostScope`: that is all
 * the rule consults, and a caller that holds only the id should not have to
 * invent a scope to ask.
 */
export function attributedProjection(input: {
  readonly scopeHostId: string | null;
  readonly hasExplicitPick: boolean;
  readonly streamed: GlobalResourceProjection;
}): GlobalResourceProjection {
  const { scopeHostId, streamed } = input;
  if (input.hasExplicitPick) {
    return streamed.hostId !== null && streamed.hostId === scopeHostId
      ? streamed
      : EMPTY_GLOBAL_RESOURCE_PROJECTION;
  }
  const provablyAnotherMachine =
    streamed.hostId !== null &&
    scopeHostId !== null &&
    streamed.hostId !== scopeHostId;
  return provablyAnotherMachine ? EMPTY_GLOBAL_RESOURCE_PROJECTION : streamed;
}

/**
 * What share of the machine's RAM a reading accounts for.
 *
 * One implementation for the panel's "RAM share" block and the strip's `ram`
 * metric, so the two cannot round — or guard — differently. `hostTotalMemoryBytes`
 * is `0` on a host that never reported a total, and dividing by it would print
 * `Infinity%`; a null numerator is a sample that arrived without the memory
 * field (nullable on the wire from @1.5 on).
 */
export function hostMemorySharePercent(
  memoryBytes: number | null,
  app: AppResourceUsage | null,
): number | null {
  if (memoryBytes === null) return null;
  if (app === null || app.hostTotalMemoryBytes <= 0) return null;
  return (memoryBytes / app.hostTotalMemoryBytes) * 100;
}

export function combineHeadlineResourceSummary(input: {
  readonly hostTree: HostTreeResourceSnapshotWireV15 | null;
  readonly app: AppResourceUsage | null;
  readonly owners: readonly OwnerResourceSnapshotWireV15[];
  readonly desktopApp: DesktopAppResourceUsage | null;
  readonly memoryMetric: ResourceMemoryMetric;
}): HeadlineResourceSummary | null {
  const { hostTree, app, owners, desktopApp, memoryMetric } = input;
  if (
    hostTree === null &&
    app === null &&
    desktopApp === null &&
    owners.length === 0
  ) {
    return null;
  }
  // Pre-v1.2 hosts don't send the whole-host-tree aggregate, so fall back to
  // the host app process plus the tracked owner trees.
  const base =
    hostTree === null
      ? legacyHeadlineSummary(app, owners)
      : {
          cpuPercent: hostTree.cpuPercent,
          rssBytes: hostTree.rssBytes,
          pssBytes: hostTree.pssBytes,
          privateBytes: hostTree.privateBytes,
          trackedProcessCount: hostTree.processCount,
        };
  const desktop = desktopResourceSummary(desktopApp);

  const summary = {
    cpuPercent: base.cpuPercent + desktop.cpuPercent,
    rssBytes: base.rssBytes === null ? null : base.rssBytes + desktop.rssBytes,
    pssBytes: desktopApp === null ? base.pssBytes : null,
    privateBytes: desktopApp === null ? base.privateBytes : null,
    trackedProcessCount: base.trackedProcessCount + desktop.processCount,
  };
  return {
    ...summary,
    memoryBytes: memoryMetric === "pss" ? summary.pssBytes : summary.rssBytes,
  };
}

function legacyHeadlineSummary(
  app: AppResourceUsage | null,
  owners: readonly OwnerResourceSnapshotWireV15[],
): Omit<HeadlineResourceSummary, "memoryBytes"> {
  return owners.reduce(
    (summary, owner) => ({
      cpuPercent: summary.cpuPercent + owner.cpuPercent,
      rssBytes: sumCompleteMemoryBytes([summary.rssBytes, owner.rssBytes]),
      pssBytes: sumCompleteMemoryBytes([summary.pssBytes, owner.pssBytes]),
      privateBytes: sumCompleteMemoryBytes([
        summary.privateBytes,
        owner.privateBytes,
      ]),
      trackedProcessCount: summary.trackedProcessCount + owner.processCount,
    }),
    {
      cpuPercent: app?.cpuPercent ?? 0,
      rssBytes: app === null ? 0 : app.rssBytes,
      pssBytes: app?.pssBytes ?? null,
      privateBytes: app?.privateBytes ?? null,
      trackedProcessCount: app?.processCount ?? 0,
    },
  );
}

function desktopResourceSummary(
  desktopApp: DesktopAppResourceUsage | null,
): DesktopResourceSummary {
  if (desktopApp === null) {
    return { cpuPercent: 0, rssBytes: 0, processCount: 0 };
  }
  return {
    cpuPercent: desktopApp.cpuPercent,
    rssBytes: desktopApp.rssBytes,
    processCount: desktopApp.processCount,
  };
}
