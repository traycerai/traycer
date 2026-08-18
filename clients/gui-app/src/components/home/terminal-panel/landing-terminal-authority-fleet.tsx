import { useEffect, useRef, type ReactNode } from "react";
import type { PlainTerminalScope } from "@traycer/protocol/host/terminal/plain-schemas";
import { TabHostProvider } from "@/components/epic-canvas/tab-host-provider";
import {
  useTabPlainTerminalAuthority,
  type PlainTerminalAuthorityResult,
} from "@/hooks/terminal/use-plain-terminal-authority";
import {
  useTabPlainTerminalMutations,
  type PlainTerminalMutations,
} from "@/hooks/terminal/use-plain-terminal-mutations";

const INDEPENDENT_SCOPE: PlainTerminalScope = { kind: "independent" };

export interface LandingTerminalAuthorityEntry {
  readonly authority: PlainTerminalAuthorityResult;
  readonly mutations: PlainTerminalMutations;
}

export type LandingTerminalAuthorityEntries = Readonly<
  Partial<Record<string, LandingTerminalAuthorityEntry>>
>;

export function LandingTerminalAuthorityFleet(props: {
  readonly hostIds: readonly string[];
  readonly onEntry: (
    hostId: string,
    entry: LandingTerminalAuthorityEntry | null,
  ) => void;
}): ReactNode {
  return props.hostIds.map((hostId) => (
    <TabHostProvider key={hostId} hostId={hostId}>
      <LandingTerminalAuthorityRegistration
        hostId={hostId}
        onEntry={props.onEntry}
      />
    </TabHostProvider>
  ));
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
