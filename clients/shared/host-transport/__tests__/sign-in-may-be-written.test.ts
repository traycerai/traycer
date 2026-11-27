import { describe, expect, it } from "vitest";

import {
  createReleasedHostMemory,
  signInMayBeWritten,
  type ReleasedHostMemory,
  type SignInWriteCheck,
} from "../released-sign-on";

const HOST_ID = "host-a";

/** A write check over the real memory; the row and the eligibility are the only fakes. */
function checkOver(
  hosts: ReleasedHostMemory,
  input: { readonly row: boolean; readonly eligible: boolean },
): SignInWriteCheck {
  return {
    hosts,
    rowAllows: () => input.row,
    ownerSignInEligible: () => input.eligible,
  };
}

describe("signInMayBeWritten", () => {
  describe("the row rule is asked first, for every kind", () => {
    it("refuses a released, a remembered and an invited sign-in whose row does not allow it, whatever the memory holds", () => {
      const hosts = createReleasedHostMemory();
      const instance = hosts.currentInstance(HOST_ID);
      const invitation = hosts.invitationHeard(instance);
      const check = checkOver(hosts, { row: false, eligible: true });
      expect(
        signInMayBeWritten(check, { kind: "released", owner: instance }, false),
      ).toBe(false);
      expect(
        signInMayBeWritten(
          check,
          { kind: "remembered", owner: instance },
          false,
        ),
      ).toBe(false);
      expect(
        signInMayBeWritten(check, { kind: "invited", invitation }, true),
      ).toBe(false);
    });

    it("never reads the memory when the row refuses", () => {
      const read: string[] = [];
      const instance = createReleasedHostMemory().currentInstance(HOST_ID);
      const hosts: SignInWriteCheck["hosts"] = {
        isCurrent: () => {
          read.push("isCurrent");
          return true;
        },
        namedReason: () => {
          read.push("namedReason");
          return false;
        },
        invitationWithdrawn: () => {
          read.push("invitationWithdrawn");
          return false;
        },
      };
      const check: SignInWriteCheck = {
        hosts,
        rowAllows: () => false,
        ownerSignInEligible: () => {
          read.push("ownerSignInEligible");
          return true;
        },
      };
      signInMayBeWritten(check, { kind: "released", owner: instance }, false);
      signInMayBeWritten(
        check,
        { kind: "invited", invitation: { instance, refusalsBefore: 0 } },
        true,
      );
      expect(read).toEqual([]);
    });
  });

  describe.each(["released", "remembered"] as const)("a %s sign-in", (kind) => {
    it("may be written for the current instance that has named no reason", () => {
      const hosts = createReleasedHostMemory();
      const owner = hosts.currentInstance(HOST_ID);
      const check = checkOver(hosts, { row: true, eligible: false });
      expect(signInMayBeWritten(check, { kind, owner }, false)).toBe(true);
      // Eligibility is for an invited OPEN alone.
      expect(signInMayBeWritten(check, { kind, owner }, true)).toBe(true);
    });

    it("may not be written once the instance it was heard from is replaced", () => {
      const hosts = createReleasedHostMemory();
      hosts.observeInstance(HOST_ID, "100");
      const owner = hosts.currentInstance(HOST_ID);
      hosts.observeInstance(HOST_ID, "200");
      const check = checkOver(hosts, { row: true, eligible: true });
      expect(signInMayBeWritten(check, { kind, owner }, false)).toBe(false);
    });

    it("may not be written once the host named a reason", () => {
      const hosts = createReleasedHostMemory();
      const owner = hosts.currentInstance(HOST_ID);
      hosts.refusedNamingReason(owner, false);
      const check = checkOver(hosts, { row: true, eligible: true });
      expect(signInMayBeWritten(check, { kind, owner }, false)).toBe(false);
    });

    it("may be written again for the replacement that has named nothing", () => {
      const hosts = createReleasedHostMemory();
      hosts.observeInstance(HOST_ID, "100");
      hosts.refusedNamingReason(hosts.currentInstance(HOST_ID), false);
      hosts.observeInstance(HOST_ID, "200");
      const owner = hosts.currentInstance(HOST_ID);
      const check = checkOver(hosts, { row: true, eligible: true });
      expect(signInMayBeWritten(check, { kind, owner }, false)).toBe(true);
    });
  });

  describe("an invited sign-in", () => {
    it("may be written while its invitation stands, and eligibility is asked only at the OPEN", () => {
      const hosts = createReleasedHostMemory();
      const invitation = hosts.invitationHeard(hosts.currentInstance(HOST_ID));
      const ineligible = checkOver(hosts, { row: true, eligible: false });
      expect(
        signInMayBeWritten(ineligible, { kind: "invited", invitation }, false),
      ).toBe(true);
      expect(
        signInMayBeWritten(ineligible, { kind: "invited", invitation }, true),
      ).toBe(false);
      const eligible = checkOver(hosts, { row: true, eligible: true });
      expect(
        signInMayBeWritten(eligible, { kind: "invited", invitation }, true),
      ).toBe(true);
    });

    it("asks eligibility for the host id of the instance that invited", () => {
      const hosts = createReleasedHostMemory();
      const invitation = hosts.invitationHeard(hosts.currentInstance(HOST_ID));
      const asked: string[] = [];
      const check: SignInWriteCheck = {
        hosts,
        rowAllows: () => true,
        ownerSignInEligible: (hostId) => {
          asked.push(hostId);
          return true;
        },
      };
      signInMayBeWritten(check, { kind: "invited", invitation }, true);
      expect(asked).toEqual([HOST_ID]);
    });

    it("is withdrawn by a later refusal that names a reason, and not by the invitation's own", () => {
      const hosts = createReleasedHostMemory();
      const instance = hosts.currentInstance(HOST_ID);
      const invitation = hosts.invitationHeard(instance);
      const check = checkOver(hosts, { row: true, eligible: true });
      hosts.refusedNamingReason(instance, true);
      expect(
        signInMayBeWritten(check, { kind: "invited", invitation }, true),
      ).toBe(true);
      hosts.refusedNamingReason(instance, false);
      expect(
        signInMayBeWritten(check, { kind: "invited", invitation }, false),
      ).toBe(false);
      expect(
        signInMayBeWritten(check, { kind: "invited", invitation }, true),
      ).toBe(false);
    });

    it("is withdrawn by a restart of the host process", () => {
      const hosts = createReleasedHostMemory();
      hosts.observeInstance(HOST_ID, "100");
      const invitation = hosts.invitationHeard(hosts.currentInstance(HOST_ID));
      hosts.observeInstance(HOST_ID, "200");
      const check = checkOver(hosts, { row: true, eligible: true });
      expect(
        signInMayBeWritten(check, { kind: "invited", invitation }, false),
      ).toBe(false);
    });
  });
});
