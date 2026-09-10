import { useEffect, useRef, type ReactNode } from "react";
import type { PlainTerminalScope } from "@traycer/protocol/host/terminal/plain-schemas";
import { TabHostProvider } from "@/components/epic-canvas/tab-host-provider";
import { BrowserSessionsHostProvider } from "@/components/epic-canvas/renderers/browser-sessions-provider";
import { useBrowserSessionsContext } from "@/components/epic-canvas/renderers/browser-sessions-context";
import { useHostClientForHostId } from "@/hooks/host/use-host-client-for-host-id";
import type { BrowserSessionsState } from "@/lib/browser-view/sessions/browser-sessions-coordinator";
import {
  useTabPlainTerminalAuthority,
  type PlainTerminalAuthorityResult,
} from "@/hooks/terminal/use-plain-terminal-authority";
import {
  useTabPlainTerminalMutations,
  type PlainTerminalMutations,
} from "@/hooks/terminal/use-plain-terminal-mutations";
import {
  INDEPENDENT_BROWSER_SCOPE,
  useLandingBrowserReconciliation,
} from "./use-landing-browser-reconciliation";

const INDEPENDENT_SCOPE: PlainTerminalScope = { kind: "independent" };

export interface LandingTerminalAuthorityEntry {
  readonly authority: PlainTerminalAuthorityResult;
  readonly mutations: PlainTerminalMutations;
}

export type LandingTerminalAuthorityEntries = Readonly<
  Partial<Record<string, LandingTerminalAuthorityEntry>>
>;

export type LandingBrowserSessionEntries = Readonly<
  Partial<Record<string, BrowserSessionsState>>
>;

/**
 * Whether this fleet's browser arm also RECONCILES the device's independent
 * inventory into the panel's tab list, or merely reports it.
 *
 * Two surfaces mount this fleet - the panel and the tombstone recovery bridge,
 * which lives above the router and is therefore always mounted. Both must
 * acquire the same coordinator key so a window opens one independent stream per
 * device, but only ONE of them may write the store: two reconcilers racing on
 * one slice would each adopt and drop against a snapshot the other had already
 * acted on. The bridge reports only.
 */
export type LandingBrowserArm = "reconcile" | "report-only";

/**
 * The devices whose landing-panel machinery is mounted, one `TabHostProvider`
 * each.
 *
 * The two arms take SEPARATE host lists because a device that needs one does
 * not necessarily need the other. The panel's lists overlap heavily - each is
 * that kind's tab hosts plus the target device - but the always-mounted
 * tombstone bridge's do not: it mounts a device because a tombstone of one
 * kind names it, and mounting the other arm there would open a browser stream
 * to a device whose only outstanding work is a terminal kill (or the reverse)
 * for as long as that kill goes unanswered - which is precisely the case where
 * the device is unreachable and the stream would do nothing but retry.
 */
export function LandingTerminalAuthorityFleet(props: {
  /** Devices whose plain-terminal authority is mounted. */
  readonly hostIds: readonly string[];
  /** Devices whose independent browser inventory is mounted. */
  readonly browserHostIds: readonly string[];
  readonly browserArm: LandingBrowserArm;
  readonly onEntry: (
    hostId: string,
    entry: LandingTerminalAuthorityEntry | null,
  ) => void;
  readonly onBrowserSessions: (
    hostId: string,
    state: BrowserSessionsState | null,
  ) => void;
}): ReactNode {
  const terminalHostIds = new Set(props.hostIds);
  const browserHostIds = new Set(props.browserHostIds);
  return [...new Set([...props.hostIds, ...props.browserHostIds])].map(
    (hostId) => (
      <TabHostProvider key={hostId} hostId={hostId}>
        {terminalHostIds.has(hostId) ? (
          <LandingTerminalAuthorityRegistration
            hostId={hostId}
            onEntry={props.onEntry}
          />
        ) : null}
        {browserHostIds.has(hostId) ? (
          <LandingBrowserSessionsRegistration
            hostId={hostId}
            browserArm={props.browserArm}
            onBrowserSessions={props.onBrowserSessions}
          />
        ) : null}
      </TabHostProvider>
    ),
  );
}

function LandingTerminalAuthorityRegistration(props: {
  readonly hostId: string;
  readonly onEntry: (
    hostId: string,
    entry: LandingTerminalAuthorityEntry | null,
  ) => void;
}): ReactNode {
  const { hostId, onEntry } = props;
  const authority = useTabPlainTerminalAuthority(INDEPENDENT_SCOPE);
  const mutations = useTabPlainTerminalMutations(authority);
  const latestEntryRef = useRef<LandingTerminalAuthorityEntry>({
    authority,
    mutations,
  });
  useEffect(() => {
    latestEntryRef.current = { authority, mutations };
  }, [authority, mutations]);

  useEffect(() => {
    onEntry(hostId, latestEntryRef.current);
    return () => onEntry(hostId, null);
  }, [
    authority.canMutate,
    authority.capability.status,
    authority.collection,
    hostId,
    mutations.close.mutateAsync,
    mutations.create.mutateAsync,
    mutations.ensureRunning.mutateAsync,
    mutations.importLegacy.mutateAsync,
    mutations.rename.mutate,
    onEntry,
  ]);

  return null;
}

/**
 * One device's independent browser inventory, mounted beside its terminal
 * authority.
 *
 * The provider is acquired by the refcounted coordinator key, so this, the
 * panel's tiles, and the tombstone bridge all SHARE one stream per device per
 * window rather than opening three. Do not lift this state into props to avoid
 * a "second stream": there is no second stream, and hoisting would cost each
 * surface its independent lifetime.
 */
function LandingBrowserSessionsRegistration(props: {
  readonly hostId: string;
  readonly browserArm: LandingBrowserArm;
  readonly onBrowserSessions: (
    hostId: string,
    state: BrowserSessionsState | null,
  ) => void;
}): ReactNode {
  const hostClient = useHostClientForHostId(props.hostId);
  return (
    <BrowserSessionsHostProvider
      hostId={props.hostId}
      hostClient={hostClient}
      scope={INDEPENDENT_BROWSER_SCOPE}
    >
      <LandingBrowserSessionsPublisher
        hostId={props.hostId}
        browserArm={props.browserArm}
        onBrowserSessions={props.onBrowserSessions}
      />
    </BrowserSessionsHostProvider>
  );
}

function LandingBrowserSessionsPublisher(props: {
  readonly hostId: string;
  readonly browserArm: LandingBrowserArm;
  readonly onBrowserSessions: (
    hostId: string,
    state: BrowserSessionsState | null,
  ) => void;
}): ReactNode {
  const { hostId, onBrowserSessions } = props;
  const sessions = useBrowserSessionsContext();
  useLandingBrowserReconciliation({
    hostId,
    sessions,
    enabled: props.browserArm === "reconcile",
  });
  useEffect(() => {
    onBrowserSessions(hostId, sessions);
    return () => onBrowserSessions(hostId, null);
  }, [hostId, onBrowserSessions, sessions]);
  return null;
}
