import { useCallback } from "react";
import type { Mutation } from "@tanstack/react-query";
import { useMutationStateOf } from "@/hooks/use-mutation-state-of";

function stringField(value: unknown, field: string): string | null {
  if (typeof value !== "object" || value === null || !(field in value))
    return null;
  const member: unknown = Reflect.get(value, field);
  return typeof member === "string" ? member : null;
}

const SETTINGS_PREFIXES = [
  "environment.configuration.",
  "environment.agentDefinitions.",
  "config.env.",
  "config.shell.",
  "providers.set",
  "providers.deleteEnvOverride",
] as const;

function isSettingsMethod(method: string): boolean {
  return (
    method === "providers.skillsMutate" ||
    SETTINGS_PREFIXES.some((prefix) => method.startsWith(prefix))
  );
}

/** Queued settings are scoped to their configuration, never a neighbouring team. */
export function useConfigurationSavingOffline(
  environmentId: string | null,
  hostIds: ReadonlySet<string>,
): boolean {
  const selectPaused = useCallback(
    (mutation: Mutation) => {
      if (!mutation.state.isPaused) return false;
      const method = mutation.options.mutationKey?.at(0);
      if (typeof method !== "string") return false;
      // Secret/key inputs are transient; they never become a queued setting.
      if (
        method.startsWith("environment.secrets.") ||
        method.includes("ApiKey")
      )
        return false;
      if (!isSettingsMethod(method)) return false;
      const configurationId =
        stringField(mutation.state.variables, "environmentId") ??
        stringField(mutation.options.meta, "configurationId");
      if (configurationId !== null) return configurationId === environmentId;
      const hostId =
        stringField(mutation.state.context, "hostId") ??
        stringField(mutation.state.variables, "hostId");
      return hostId !== null && hostIds.has(hostId);
    },
    [environmentId, hostIds],
  );
  const paused = useMutationStateOf({ status: "pending" }, selectPaused);
  return paused.some(Boolean);
}
