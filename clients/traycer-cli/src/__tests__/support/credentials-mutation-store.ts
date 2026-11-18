import { vi } from "vitest";
import type { CredentialsMutationStore } from "@traycer/protocol/config/credentials-mutation";

/**
 * A `CredentialsMutationStore` double with every member stubbed, for suites
 * that exercise ONE of them.
 *
 * The interface has eleven members and a test typically cares about one or
 * two, so hand-rolling the object means restating nine irrelevant stubs — and
 * each copy is a place that stops compiling, separately, the next time the
 * interface grows a method. Overrides are spread last, so a suite names only
 * the behaviour it is actually asserting.
 *
 * Lives outside a `*.test.ts` name on purpose: the workspace's vitest
 * `include` is `src/**‍/__tests__/**‍/*.test.ts`, so this file is importable
 * from tests without being collected as one.
 */
export function fakeCredentialsMutationStore(
  overrides: Partial<CredentialsMutationStore>,
): CredentialsMutationStore {
  return {
    read: vi.fn(),
    rotate: vi.fn(),
    signIn: vi.fn(),
    signOut: vi.fn(),
    signOutIfToken: vi.fn(),
    drainQuarantine: vi.fn(),
    updateProfile: vi.fn(),
    guardedSignIn: vi.fn(),
    migrateFirstWrite: vi.fn(),
    hasPendingContinuation: () => false,
    dispose: vi.fn(),
    ...overrides,
  };
}
