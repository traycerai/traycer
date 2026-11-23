import { useCallback, useSyncExternalStore } from "react";
import { subscribeNegotiatedManifests } from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import { usePickHostScope } from "@/components/settings/host-scope/use-host-scope";
import { useWindowHostRunsPersonal } from "@/components/settings/personal/use-window-host-runs-personal";
import { useEffectiveHostId } from "@/hooks/host/use-effective-host-id";
import { useHostMethodSupport } from "@/hooks/host/use-host-supports-method";
import { UNNAMED_HOST_LABEL } from "@/lib/host/host-name";
import {
  readNegotiatedMethodVersion,
  type NegotiatedMethodVersion,
} from "@/lib/host/read-negotiated-method-version";
import {
  hostLacksEnvironmentStatus,
  isEnvironmentGroupSection,
  isOldHostLocalPick,
  type EnvironmentPick,
  oldHostSectionShown,
} from "@/lib/settings-environment-pages";
import type { SettingsSectionId } from "@/lib/settings-sections";
import { useEnvironmentPick } from "@/stores/settings/settings-environment-pick-store";

/**
 * Whether the pick is a Local row on a host that serves no `environment.status`,
 * read from that host's own negotiated manifest by its id: a Local pick names
 * a computer, which need not be the window's host or have a client yet. A
 * Personal pick is never old, whatever the window's host has negotiated, so an
 * outage never touches it.
 *
 * With no pick and no default stored for this window's host, the pick the
 * dropdown will resolve is this host's own Local row when its manifest lacks
 * `environment.status` (`localPickerRow`, version `false`), so that manifest is
 * read directly: a surface that never mounts the dropdown, such as the command
 * palette in a window that has not opened Settings, lists no page the host lacks.
 */
export function useOldHostLocalPick(): boolean {
  return useIsOldHostPick(useEnvironmentPick());
}

function useIsOldHostPick(pick: EnvironmentPick): boolean {
  const windowHostId = useEffectiveHostId();
  const getSnapshot = useCallback(
    () =>
      pick.kind === "unresolved"
        ? windowHostId !== null && hostLacksEnvironmentStatus(windowHostId)
        : isOldHostLocalPick(pick),
    [pick, windowHostId],
  );
  return useSyncExternalStore(subscribeNegotiatedManifests, getSnapshot);
}

/**
 * What the body of `section` shows under a pick, the one answer every road to
 * a page ends at (`SettingsPanelForSection`):
 *
 * - `served`: the page itself.
 * - `unresolved`: no pick yet, the page's own unresolved state.
 * - `pending`: the picked computer has not answered yet; "Connecting".
 * - `lists-failed`: the host lists failed before naming the computer, so
 *   nothing is known about it; the lists' retry.
 * - `missing`: the computer lacks the page. `updateGives` is whether an
 *   update would give it: an old host's pages other than Secrets, which is
 *   pool-only and no host update serves.
 * - `unlisted`: a Local pick of a computer this app's host list does not name.
 * - `team-only`: Members, under a pick that is not a team.
 *
 * Nothing here moves the surface or hides a row: the rail lists rows by the
 * kind of pick alone, and a late answer changes only this body.
 */
export type SectionAnswer =
  | { readonly kind: "served" }
  | { readonly kind: "unresolved" }
  | { readonly kind: "pending"; readonly hostName: string }
  | { readonly kind: "lists-failed" }
  | {
      readonly kind: "missing";
      readonly hostId: string;
      readonly hostName: string;
      readonly updateGives: boolean;
    }
  | { readonly kind: "unlisted"; readonly hostName: string }
  | { readonly kind: "team-only" };

/** The facts `sectionAnswer` decides from, read by `useSectionAnswer`. */
interface SectionFacts {
  readonly pick: EnvironmentPick;
  readonly section: SettingsSectionId;
  /** The host the pick reads through, or `null` where the list names none. */
  readonly host: { readonly hostId: string; readonly name: string } | null;
  readonly hostsLoading: boolean;
  /** A host list failed, so a host it does not name is not known to be gone. */
  readonly listsFailed: boolean;
  /** `useWindowHostRunsPersonal`, for a Personal pick. */
  readonly windowHostRuns: boolean | null;
  /** That host's own `environment.status`, from its handshake. */
  readonly environmentStatus: NegotiatedMethodVersion;
  /**
   * Whether that host serves `environment.secrets.list`: a Local computer's
   * own handshake, never a pool's answer; for Personal on a host that runs
   * it, the support read, which answers for the pool in a pool build.
   */
  readonly secretsList: boolean | null;
}

function servedOr(
  supported: boolean | null,
  host: { readonly hostId: string; readonly name: string },
  updateGives: boolean,
): SectionAnswer {
  if (supported === null) return { kind: "pending", hostName: host.name };
  return supported
    ? { kind: "served" }
    : {
        kind: "missing",
        hostId: host.hostId,
        hostName: host.name,
        updateGives,
      };
}

/** An unknown fact: Connecting, or the lists' retry where they failed. */
function pendingOrFailed(facts: SectionFacts, hostName: string): SectionAnswer {
  return facts.listsFailed && facts.host === null
    ? { kind: "lists-failed" }
    : { kind: "pending", hostName };
}

function sectionAnswer(facts: SectionFacts): SectionAnswer {
  const { pick, section, host } = facts;
  if (!isEnvironmentGroupSection(section)) return { kind: "served" };
  if (pick.kind === "unresolved") return { kind: "unresolved" };
  if (pick.kind === "team") return { kind: "served" };
  if (section === "members") return { kind: "team-only" };
  if (pick.kind === "personal") {
    // Every Personal page waits for whether the window's host runs it: that
    // decides the page's source, so drawing one first would swap it.
    if (facts.windowHostRuns === null) {
      return pendingOrFailed(facts, host?.name ?? UNNAMED_HOST_LABEL);
    }
    // Personal reads the cloud unless the window's host runs it: only then is
    // a page the host's own, and only Secrets needs a method of it.
    if (section !== "secrets" || !facts.windowHostRuns || host === null) {
      return { kind: "served" };
    }
    return servedOr(facts.secretsList, host, false);
  }
  return localSectionAnswer(facts, pick.hostName);
}

/**
 * A Local pick reads its own computer's handshake, never a pool's answer: a
 * computer the list does not name is not connected, an old one has only
 * `oldHostSectionShown`'s pages, and a current one lacks Secrets only without
 * `environment.secrets.list`. Even a page every host serves waits for the
 * handshake: its frame, and Agents' body, differ on an old host
 * (`useOldHostLocalPick`), so drawing one first would swap it when the answer
 * lands. Updating an old host gives its missing pages, except Secrets.
 */
function localSectionAnswer(
  facts: SectionFacts,
  pickedName: string,
): SectionAnswer {
  const { host, section } = facts;
  if (host === null) {
    return facts.hostsLoading || facts.listsFailed
      ? pendingOrFailed(facts, pickedName)
      : { kind: "unlisted", hostName: pickedName };
  }
  if (facts.environmentStatus === null) {
    return { kind: "pending", hostName: host.name };
  }
  if (facts.environmentStatus === false) {
    return servedOr(oldHostSectionShown(section), host, section !== "secrets");
  }
  return section === "secrets"
    ? servedOr(facts.secretsList, host, false)
    : { kind: "served" };
}

/** `sectionAnswer` for `pick`, which need not be the pick in effect. */
export function useSectionAnswer(
  pick: EnvironmentPick,
  section: SettingsSectionId,
): SectionAnswer {
  const scope = usePickHostScope(pick);
  const windowHostRuns = useWindowHostRunsPersonal(scope);
  const hostId = scope.host?.hostId ?? null;
  const environmentStatus = useSyncExternalStore(
    subscribeNegotiatedManifests,
    () =>
      hostId === null
        ? null
        : readNegotiatedMethodVersion(hostId, "environment.status"),
  );
  const ownSecretsList = useSyncExternalStore(
    subscribeNegotiatedManifests,
    () => {
      if (hostId === null) return null;
      const version = readNegotiatedMethodVersion(
        hostId,
        "environment.secrets.list",
      );
      return version === null ? null : version !== false;
    },
  );
  const supportSecretsList = useHostMethodSupport(
    hostId,
    "environment.secrets.list",
  );
  return sectionAnswer({
    pick,
    section,
    host:
      scope.host === null
        ? null
        : { hostId: scope.host.hostId, name: scope.host.name },
    hostsLoading: scope.isLoading,
    listsFailed: scope.listsFailed,
    windowHostRuns,
    environmentStatus,
    secretsList: pick.kind === "local" ? ownSecretsList : supportSecretsList,
  });
}

/** Whether a page is served under a pick, for a surface that offers it. */
export type SectionServed = "served" | "not-served" | "pending";

/**
 * `useSectionAnswer` in three states, for an entry that is shown only where
 * its page is: shown on `served`, absent while `pending`, so it never shows
 * and then goes.
 */
export function useSectionServed(
  pick: EnvironmentPick,
  section: SettingsSectionId,
): SectionServed {
  const answer = useSectionAnswer(pick, section);
  if (answer.kind === "served") return "served";
  if (answer.kind === "pending" || answer.kind === "unresolved") {
    return "pending";
  }
  return "not-served";
}
