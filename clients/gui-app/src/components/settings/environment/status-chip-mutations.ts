import { useMutationState } from "@tanstack/react-query";

function stringField(value: unknown, field: string): string | null {
  if (typeof value !== "object" || value === null || !(field in value))
    return null;
  const member: unknown = Reflect.get(value, field);
  return typeof member === "string" ? member : null;
}

/** Queued settings are scoped to their configuration, never a neighbouring team. */
export function useConfigurationSavingOffline(
  environmentId: string | null,
  hostIds: ReadonlySet<string>,
): boolean {
  const paused = useMutationState({
    filters: { status: "pending" },
    select: (mutation) => {
      if (!mutation.state.isPaused) return false;
      const method = mutation.options.mutationKey?.at(0);
      if (typeof method !== "string") return false;
      // Secret/key inputs are transient; they never become a queued setting.
      if (
        method.startsWith("environment.secrets.") ||
        method.includes("ApiKey")
      )
        return false;
      const settings =
        method.startsWith("environment.configuration.") ||
        method.startsWith("environment.agentDefinitions.") ||
        method.startsWith("config.env.") ||
        method.startsWith("config.shell.") ||
        method.startsWith("providers.set") ||
        method.startsWith("providers.deleteEnvOverride");
      if (!settings) return false;
      const configurationId =
        stringField(mutation.state.variables, "environmentId") ??
        stringField(mutation.options.meta, "configurationId");
      if (configurationId !== null) return configurationId === environmentId;
      const hostId =
        stringField(mutation.state.context, "hostId") ??
        stringField(mutation.state.variables, "hostId");
      return hostId !== null && hostIds.has(hostId);
    },
  });
  return paused.some(Boolean);
}
