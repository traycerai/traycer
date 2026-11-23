import { useContext } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { applyHeldChange } from "@traycer-clients/shared/environment/environment-review";
import type {
  LocalOverride,
  LocalOverrideTarget,
} from "@traycer/protocol/host/environment-schemas";
import type { SchemaVersion } from "@traycer/protocol/framework/index";
import type { ProviderId } from "@traycer/protocol/host/provider-schemas";
import type { OnlyOnComputer } from "@/components/settings/panels/env-override-editor";
import {
  NO_OVERRIDES,
  PersonalPageContext,
  type PersonalPageContextValue,
} from "@/components/settings/personal/personal-page-context";
import {
  invalidateEnvironmentReads,
  useEnvironmentCloud,
} from "@/hooks/environment/use-environment-cloud";
import {
  useHostMethodSchemaVersion,
  useHostSupportsMethod,
} from "@/hooks/host/use-host-supports-method";
import { usePressCapturedMutation } from "@/hooks/use-press-captured-mutation";
import { captureSettingsSaveOrigin } from "@/lib/environment/settings-save-origin";
import { cloudVerdictPreflight } from "@/lib/host/cloud-verdict-preflight";
import { hostQueryKeys } from "@/lib/query-keys";

const SET = "config.env.localOverride.set";
const SAVE_TO_PERSONAL = "config.env.localOverride.saveToPersonal";
const CLEAR = "config.env.localOverride.clear";
const GUARDED_CLEAR = {
  method: CLEAR,
  version: { major: 1, minor: 1 },
} as const;
const REVIEW = "environment.review";
const SAVE_FAILED = "Couldn't save this variable.";
const CLEAR_FAILED = "Couldn't stop this computer keeping its own value.";

export function usePersonalEnvOverrideActions(providerId: ProviderId | null) {
  const scope = overrideScope(useContext(PersonalPageContext));
  const hostId = scope?.hostId ?? null;
  const maySet = useHostSupportsMethod(hostId, SET);
  const mayShare = useHostSupportsMethod(hostId, SAVE_TO_PERSONAL);
  const clearVersion = useHostMethodSchemaVersion(hostId, CLEAR);
  const cloud = useEnvironmentCloud();
  const queryClient = useQueryClient();
  const ownValues = ownValuesFor(scope?.overrides ?? NO_OVERRIDES, providerId);

  const targetFor = (key: string): LocalOverrideTarget =>
    providerId === null
      ? { kind: "variable", key }
      : { kind: "env_override", providerId, key };

  const refreshHostValues = async (sentOn: string): Promise<void> => {
    const list = providerId === null ? "config.env.list" : "providers.list";
    await Promise.all(
      ["environment.localOverrides", list].map((method) =>
        queryClient.invalidateQueries({
          queryKey: hostQueryKeys.methodScope(sentOn, method),
        }),
      ),
    );
  };

  const onlyOn: OnlyOnComputer | null =
    scope !== null && maySet && mayShare
      ? {
          label: `Only on ${scope.hostName}`,
          keptKeys: new Set(ownValues.keys()),
          save: async (key, value) => {
            const failed = `Couldn't keep the value on ${scope.hostName}.`;
            if (scope.client.getActiveHostId() !== scope.hostId)
              throw new Error(failed);
            let result;
            try {
              result = await scope.client.request(SET, {
                target: targetFor(key),
                value,
              });
            } catch {
              throw new Error(failed);
            } finally {
              await refreshHostValues(scope.hostId);
            }
            if (result.outcome === "needs_grant") {
              throw new Error(
                "Couldn't keep the value without your confirmation.",
              );
            }
          },
        }
      : null;

  const canShare =
    scope !== null && mayShare && supportsGuardedClear(clearVersion);
  const share = usePressCapturedMutation(
    (key: string) => {
      const value = ownValues.get(key);
      const origin = captureSettingsSaveOrigin(cloud);
      if (
        !canShare ||
        scope.client.getActiveHostId() !== scope.hostId ||
        value === undefined ||
        origin.kind !== "sign_in_at_press"
      ) {
        throw new Error(SAVE_FAILED);
      }
      return {
        client: scope.client,
        hostId: scope.hostId,
        value,
        target: targetFor(key),
        cloud: origin.operation,
      };
    },
    {
      mutationKey: [SAVE_TO_PERSONAL, hostId, providerId],
      mutationFn: async (_key, press): Promise<"shared" | "review"> => {
        try {
          cloudVerdictPreflight(SAVE_TO_PERSONAL)();
          if (!press.cloud.onOriginSignIn()) throw new Error(SAVE_FAILED);
          const receipt = await press.client.request(SAVE_TO_PERSONAL, {
            target: press.target,
            value: press.value,
          });
          if (receipt.reviewRequired) return "review";
          cloudVerdictPreflight(SAVE_TO_PERSONAL)();
          if (!press.cloud.onOriginSignIn()) throw new Error(SAVE_FAILED);
          const applied = await applyHeldChange(
            press.cloud,
            receipt.environmentId,
            receipt,
          );
          if (applied.outcome !== "applied") throw new Error(SAVE_FAILED);
        } catch {
          throw new Error(SAVE_FAILED);
        }
        try {
          if (
            press.client.getActiveHostId() !== press.hostId ||
            !press.cloud.onOriginSignIn()
          ) {
            throw new Error(CLEAR_FAILED);
          }
          await press.client.requestWithSignalRequiringHostMethodVersion(
            CLEAR,
            { target: press.target, expectedValue: press.value },
            undefined,
            GUARDED_CLEAR,
          );
        } catch {
          throw new Error(CLEAR_FAILED);
        } finally {
          await refreshHostValues(press.hostId);
        }
        return "shared";
      },
      onSettled: () => {
        void invalidateEnvironmentReads(queryClient, [REVIEW]);
      },
      onError: (error) => {
        toast.error(error instanceof Error ? error.message : SAVE_FAILED);
      },
    },
  );

  return { onlyOn, canShare, share };
}

function overrideScope(page: PersonalPageContextValue | null) {
  if (
    page?.pick.kind !== "personal" ||
    page.client === null ||
    page.hostId === null ||
    page.localOverrides === null
  ) {
    return null;
  }
  return {
    client: page.client,
    hostId: page.hostId,
    hostName: page.hostName || "this computer",
    overrides: page.localOverrides,
  };
}

function supportsGuardedClear(version: SchemaVersion | null): boolean {
  return (
    version?.major === GUARDED_CLEAR.version.major &&
    version.minor >= GUARDED_CLEAR.version.minor
  );
}

function ownValuesFor(
  overrides: readonly LocalOverride[],
  providerId: ProviderId | null,
): Map<string, string> {
  const ownValues = new Map<string, string>();
  for (const { target, value } of overrides) {
    if (
      target.kind === "variable"
        ? providerId === null
        : target.providerId === providerId
    ) {
      ownValues.set(target.key, value);
    }
  }
  return ownValues;
}
