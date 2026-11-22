import { UNKNOWN_FLEET_UPDATE_VIEW } from "@/lib/host/fleet-update/fleet-update-view";

/**
 * Module stand-ins for a suite that mounts the Settings rail without a host
 * runtime or a query client, each answering the honest "nothing has answered"
 * for the read it replaces. A suite mocks the module that owns each read with
 * the matching export below (see `settings-sidebar-members-search.test.tsx`),
 * beside the window-host reads in `environment-section-reads-fixture.ts`.
 * The reads' own behaviour is covered by their suites; stubbing them keeps a
 * rail test from turning into a polling test.
 */

// The Environment dropdown reads each registered computer's
// `environment.status` and negotiated version: `useQuery`s.
export const registeredHostEnvironmentStatusesModule = {
  useRegisteredHostEnvironmentStatuses: () => new Map(),
};
export const negotiatedMethodVersionModule = {
  useHostNegotiatedMethodVersions: () => new Map(),
};

// The picker's Personal row reads the hosts running Personal from one hook.
export const hostsRunningConfigurationModule = {
  useHostsRunningPersonal: () => ({
    hosts: [],
    state: "ready",
    collisions: [],
    retry: () => undefined,
  }),
};

// The footer's Sandboxes link and the Team rows read the environment list
// through the window's host client.
export const environmentListQueryModule = {
  useEnvironmentListQuery: () => ({ data: undefined }),
};
export const moveSheetModule = { MoveSheet: () => null };
export const teamPickLabelModule = {
  usePickedTeamLabel: () => null,
  useInvitedTeamName: () => null,
};
export const teamRowsModule = { TeamRows: () => null };
export const inviteAcceptDialogModule = { InviteAcceptDialog: () => null };
export const addHostDialogModule = { AddHostDialog: () => null };

// The Guide group leaves the rail once every Getting started step is done;
// not done, as for a new account.
export const gettingStartedChecklistModule = {
  useGettingStartedGuideIsComplete: () => false,
};

// The sidebar's liveness poll calls `useQuery` unconditionally.
export const registeredHostsLivenessModule = {
  useRegisteredHostsPollLiveness: () => undefined,
};

// The picker resolves each row's badge and environment label through
// queries. The fleet view is the SHARED "nothing observed" constant, never a
// literal spelled out here: a mock factory is not type-checked against the
// module it replaces, so a hand-written view loses any field added later.
export const hostEnvironmentLabelsModule = {
  useHostEnvironmentLabelResolver: () => () => null,
};
export const fleetUpdateViewsModule = {
  useFleetUpdateViews: () => () => UNKNOWN_FLEET_UPDATE_VIEW,
};

// The host picker's balance banner reads the sandbox list through a `useQuery`.
export const sandboxBalanceBannerModule = {
  SandboxBalanceBanner: () => null,
};
