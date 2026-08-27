export interface FeatureSettingsSnapshot {
  readonly agentRoles: boolean;
}

export interface FeatureSettingsBridge {
  readonly get: () => Promise<FeatureSettingsSnapshot>;
  readonly setAgentRolesEnabled: (
    enabled: boolean,
  ) => Promise<FeatureSettingsSnapshot>;
}

interface RunnerHostWindowShape {
  readonly platform:
    | { readonly featureSettings: FeatureSettingsBridge | undefined }
    | undefined;
}

export function getFeatureSettingsBridge(): FeatureSettingsBridge | null {
  const host = (globalThis as { runnerHost?: RunnerHostWindowShape })
    .runnerHost;
  return host?.platform?.featureSettings ?? null;
}
