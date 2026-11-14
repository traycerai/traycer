import type { HostOwnerPrincipal } from "@traycer/protocol/host/host-status";

export interface LocalOwnerJarCase {
  readonly name: string;
  readonly owner: HostOwnerPrincipal | null;
  readonly omitOwner?: true;
  readonly previousOwner?: HostOwnerPrincipal;
  readonly admitted: boolean;
}

/** The same ownership cases are exercised by the GUI and main jar selectors. */
export const LOCAL_OWNER_JAR_CASES: readonly LocalOwnerJarCase[] = [
  {
    name: "a known team owner",
    owner: { kind: "team", id: "team-1", name: "Team One" },
    admitted: false,
  },
  {
    name: "a known personal owner",
    owner: { kind: "user", id: "user-1" },
    admitted: true,
  },
  {
    name: "an owner that is not known yet",
    owner: null,
    admitted: true,
  },
  {
    name: "an entry with no owner field",
    owner: null,
    omitOwner: true,
    admitted: true,
  },
  {
    name: "an owner learned later as a team",
    previousOwner: { kind: "user", id: "user-1" },
    owner: { kind: "team", id: "team-1", name: "Team One" },
    admitted: false,
  },
];
