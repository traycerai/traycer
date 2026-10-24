import { describe, expect, it } from "vitest";
import {
  resolveShellLocalPlaneAdmission,
  type ShellLocalPlaneAdmission,
} from "@/hooks/auth/use-shell-local-plane-admission";
import type { AuthStatus } from "@/stores/auth/auth-store";

/**
 * `resolveShellLocalPlaneAdmission` is the pure half of the shell's admission
 * read: given the auth status, whether the shell bundles a local host, and
 * whether a host has refused the bearer an `unverified` session holds, it says
 * whether the app shell mounts and - when an `unverified` session is turned
 * away - WHICH sentence the auth surface owes the person.
 *
 * The refusal is a union rather than a boolean precisely so those two reasons
 * (no local host to fall back to, and a local host that refused the held
 * bearer) cannot be conflated by the copy.
 */

interface AdmissionCase {
  readonly name: string;
  readonly status: AuthStatus;
  readonly hasLocalHost: boolean;
  readonly hostRefusedHeldBearer: boolean;
  readonly expected: ShellLocalPlaneAdmission;
}

const ADMITTED: ShellLocalPlaneAdmission = { admitted: true, refusal: null };
const NOT_ADMITTED_NO_NOTICE: ShellLocalPlaneAdmission = {
  admitted: false,
  refusal: null,
};
const UNVERIFIED_HOST_REFUSED: ShellLocalPlaneAdmission = {
  admitted: false,
  refusal: "unverified-host-refused",
};
const UNVERIFIED_RELAY_ONLY: ShellLocalPlaneAdmission = {
  admitted: false,
  refusal: "unverified-relay-only",
};

const CASES: ReadonlyArray<AdmissionCase> = [
  {
    name: "unverified + local host + a host refused the held bearer -> refused as host-refused",
    status: "unverified",
    hasLocalHost: true,
    hostRefusedHeldBearer: true,
    expected: UNVERIFIED_HOST_REFUSED,
  },
  {
    name: "unverified + no local host + flag clear -> refused as relay-only",
    status: "unverified",
    hasLocalHost: false,
    hostRefusedHeldBearer: false,
    expected: UNVERIFIED_RELAY_ONLY,
  },
  {
    name: "unverified + no local host + flag set -> still relay-only, never host-refused",
    status: "unverified",
    hasLocalHost: false,
    hostRefusedHeldBearer: true,
    expected: UNVERIFIED_RELAY_ONLY,
  },
  {
    name: "unverified + local host + flag clear -> admitted (the case `unverified` exists for)",
    status: "unverified",
    hasLocalHost: true,
    hostRefusedHeldBearer: false,
    expected: ADMITTED,
  },
  {
    name: "signed-in + local host + flag set -> admitted (the flag only speaks for unverified)",
    status: "signed-in",
    hasLocalHost: true,
    hostRefusedHeldBearer: true,
    expected: ADMITTED,
  },
  {
    name: "signed-in + no local host + flag set -> admitted (signed-in can mint the relay credential)",
    status: "signed-in",
    hasLocalHost: false,
    hostRefusedHeldBearer: true,
    expected: ADMITTED,
  },
  {
    name: "signed-in + local host + flag clear -> admitted",
    status: "signed-in",
    hasLocalHost: true,
    hostRefusedHeldBearer: false,
    expected: ADMITTED,
  },
  {
    name: "signed-out + local host + flag clear -> not admitted, and no notice owed",
    status: "signed-out",
    hasLocalHost: true,
    hostRefusedHeldBearer: false,
    expected: NOT_ADMITTED_NO_NOTICE,
  },
  {
    name: "signed-out + no local host + flag set -> not admitted, and no notice owed",
    status: "signed-out",
    hasLocalHost: false,
    hostRefusedHeldBearer: true,
    expected: NOT_ADMITTED_NO_NOTICE,
  },
  {
    name: "signing-in + local host + flag set -> not admitted, and no notice owed",
    status: "signing-in",
    hasLocalHost: true,
    hostRefusedHeldBearer: true,
    expected: NOT_ADMITTED_NO_NOTICE,
  },
];

describe("resolveShellLocalPlaneAdmission", () => {
  for (const testCase of CASES) {
    it(testCase.name, () => {
      expect(
        resolveShellLocalPlaneAdmission(
          testCase.status,
          testCase.hasLocalHost,
          testCase.hostRefusedHeldBearer,
        ),
      ).toEqual(testCase.expected);
    });
  }
});
