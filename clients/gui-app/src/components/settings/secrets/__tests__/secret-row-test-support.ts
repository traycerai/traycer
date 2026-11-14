import type { EnvironmentSecretV12 } from "@traycer/protocol/host/environment-schemas";
import {
  RETIRED_PROVIDER_VARIABLES,
  RETIRED_SECRET_ROW_FIELDS,
} from "@traycer/protocol/host/released-wire-rows";

export function secretRowFixture(
  overrides: Partial<EnvironmentSecretV12> = {},
): EnvironmentSecretV12 {
  return {
    ...RETIRED_SECRET_ROW_FIELDS,
    providerVariables: [...RETIRED_PROVIDER_VARIABLES],
    secretId: "sec-1",
    name: "STRIPE_KEY",
    kind: "api_key",
    protocol: "https",
    destinations: ["api.stripe.com"],
    currentVersionId: "ver-1",
    revoked: false,
    updatedAt: 1,
    variables: [],
    ...overrides,
  };
}
