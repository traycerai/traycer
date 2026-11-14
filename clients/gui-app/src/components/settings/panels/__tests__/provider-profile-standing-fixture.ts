import type { CredentialStanding } from "@traycer/protocol/host/provider-credential-home-schemas";
import type { ProviderProfile } from "@traycer/protocol/host/provider-schemas";
import { profile } from "@/components/settings/panels/permissions/__tests__/judge-test-support";

export function profileWithStanding(
  standing: Partial<CredentialStanding>,
  overrides: Partial<ProviderProfile>,
): ProviderProfile {
  return {
    ...profile("profile-managed", "managed"),
    label: "Work account",
    identity: { email: "worker@example.com", tier: null, accountUuid: null },
    credentialHome: {
      homeAddress: "synthetic-home",
      bindingVersion: 1,
      materialRevision: 1,
      custodyVersion: 1,
      custodyClass: "self-sufficient",
      environmentPresence: null,
      handoffEnvironmentId: null,
      materialFingerprint: "synthetic-material",
      observation: null,
      materialMatchesBinding: "yes",
      standing: {
        material: "usable",
        repairDeadline: null,
        familyVersion: null,
        authority: null,
        cause: null,
        observation: { source: "custodian", status: "answered", capturedAt: 1 },
        ...standing,
      },
    },
    ...overrides,
  };
}
