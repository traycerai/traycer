import type { WindowHostPersonalAnswer } from "@/components/settings/personal/use-window-host-runs-personal";
import type { EnvironmentStatusResponseV11 } from "@traycer/protocol/host/environment-schemas";
import { hostScopeFixture } from "@/components/settings/host-scope/host-scope-fixture";
import type { HostScope } from "@/components/settings/host-scope/use-host-scope";
import type { EnvironmentPickerModel } from "@/components/settings/environment/environment-picker-model";
import {
  UNRESOLVED_PICK,
  type EnvironmentPick,
} from "@/lib/settings-environment-pages";
import {
  useDefaultEnvironmentPick,
  useEnvironmentPick,
} from "@/stores/settings/settings-environment-pick-store";

/**
 * The reads under Settings' section filters (the rail, search and the
 * command palette), for suites that render one of them without a host
 * runtime: the window's host, what it says about Personal, and the picker
 * model that resolves the window's default pick. A suite mocks the module that
 * owns each read with the matching `*Module` below and sets the `current` of
 * its state; the reads' own states are `personal-page-frame.test.tsx`'s,
 * `use-window-host-runs-personal.test.ts`'s and `use-host-scope-*.test.tsx`'s.
 *
 * The defaults are the cloud road: `host-a` is the window's host, it does not
 * run Personal and is reachable, so a Personal pick offers the cloud's pages,
 * and the picker model resolves nothing, so the store keeps what a test set.
 */
export const windowHostRunsPersonal: { current: boolean | null } = {
  current: false,
};

export const personalHostScopeOverrides: {
  current: Partial<HostScope>;
} = { current: {} };

export const pickerDefaultPick: { current: EnvironmentPick } = {
  current: UNRESOLVED_PICK,
};

/** Each computer's answered status; none has a Local row. */
export const pickerStatuses: {
  current: ReadonlyMap<string, EnvironmentStatusResponseV11 | null>;
} = { current: new Map() };

export const windowHostRunsPersonalModule = {
  useWindowHostRunsPersonal: (): WindowHostPersonalAnswer => {
    const runs = windowHostRunsPersonal.current;
    return runs === null ? { runs, retryStatus: null } : { runs };
  },
};

export const personalHostScopeModule = {
  useHostScope: (): HostScope =>
    hostScopeFixture(personalHostScopeOverrides.current),
  useHostScopeFor: (): HostScope =>
    hostScopeFixture(personalHostScopeOverrides.current),
  usePersonalHostScope: (): HostScope =>
    hostScopeFixture(personalHostScopeOverrides.current),
  usePickHostScope: (): HostScope =>
    hostScopeFixture(personalHostScopeOverrides.current),
  useHostScopeForHostId: (): HostScope =>
    hostScopeFixture(personalHostScopeOverrides.current),
  WINDOW_HOST_SELECTION: {
    scopedHostId: null,
    setScopedHostId: () => undefined,
    defaultsToFirstHost: false,
  },
};

/**
 * The picker model resolving `pickerDefaultPick`, with no computer rows, over
 * `pickerStatuses`.
 */
export const environmentStatusModelModule = {
  useEnvironmentStatusModel: (): {
    readonly picker: EnvironmentPickerModel;
    readonly statuses: ReadonlyMap<string, EnvironmentStatusResponseV11 | null>;
  } => ({
    picker: { localRows: [], defaultPick: pickerDefaultPick.current },
    statuses: pickerStatuses.current,
  }),
};

/**
 * The picker model as the pick store holds it, writing nothing: for suites
 * that seed the store's default themselves and are about what a surface does
 * with it. The default's resolution has its own cases (Home's cold mount,
 * `use-environment-picker-model.test.tsx`).
 */
export const seededPickerModelModule = {
  useEnvironmentPickerModel: (): EnvironmentPickerModel & {
    readonly pick: EnvironmentPick;
  } => ({
    localRows: [],
    defaultPick: useDefaultEnvironmentPick(),
    pick: useEnvironmentPick(),
  }),
};

export function resetEnvironmentSectionReads(): void {
  windowHostRunsPersonal.current = false;
  personalHostScopeOverrides.current = {};
  pickerDefaultPick.current = UNRESOLVED_PICK;
  pickerStatuses.current = new Map();
}
