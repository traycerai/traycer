import { hostScopeFixture } from "@/components/settings/host-scope/host-scope-fixture";
import type { HostScope } from "@/components/settings/host-scope/use-host-scope";

/**
 * The two reads under Settings' section filters (the rail, search and the
 * command palette), for suites that render one of them without a host
 * runtime: the window's host, and whether it runs Personal. A suite mocks the
 * module that owns each read with the matching `*Module` below and sets the
 * `current` of its state; the reads' own states are
 * `personal-page-frame.test.tsx`'s and `use-host-scope-*.test.tsx`'s.
 *
 * The defaults are the cloud road: `host-a` is the window's host, and it does
 * not run Personal, so a Personal pick offers the cloud's pages.
 */
export const windowHostRunsPersonal: { current: boolean | null } = {
  current: false,
};

export const personalHostScopeOverrides: {
  current: Partial<HostScope>;
} = { current: {} };

export const windowHostRunsPersonalModule = {
  useWindowHostRunsPersonal: (): boolean | null =>
    windowHostRunsPersonal.current,
};

export const personalHostScopeModule = {
  useHostScope: (): HostScope =>
    hostScopeFixture(personalHostScopeOverrides.current),
  usePersonalHostScope: (): HostScope =>
    hostScopeFixture(personalHostScopeOverrides.current),
};

export function resetEnvironmentSectionReads(): void {
  windowHostRunsPersonal.current = false;
  personalHostScopeOverrides.current = {};
}
