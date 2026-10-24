/**
 * Fixtures for the host's `macosRequirement` projection (`providers.list@10.2`).
 * Spread into a provider state so the suites that use it still collect against
 * a schema that does not model the key yet.
 */
export interface MacosRequirementFixture {
  readonly runningMacos: string;
  readonly managed: { readonly requiredMacos: string } | null;
  readonly launch: { readonly requiredMacos: string } | null;
  // A mutable array, as the schema's inferred type is: a readonly one is not
  // assignable to `ProviderCliState["macosRequirement"]`.
  readonly refusedVersions: {
    readonly version: string;
    readonly requiredMacos: string;
  }[];
}

/** 13.6 with nothing runnable: the managed pin and the launch both need 14.0. */
export function settledMacosBlock(
  overrides: Partial<MacosRequirementFixture>,
): { readonly macosRequirement: MacosRequirementFixture } {
  return {
    macosRequirement: {
      runningMacos: "13.6",
      managed: { requiredMacos: "14.0" },
      launch: { requiredMacos: "14.0" },
      refusedVersions: [],
      ...overrides,
    },
  };
}

export const MACOS_13_SENTENCE =
  "Antigravity needs macOS 14.0 or later. This Mac runs macOS 13.6.";
