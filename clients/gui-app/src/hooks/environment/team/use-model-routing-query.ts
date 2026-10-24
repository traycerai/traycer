import { z } from "zod";
import {
  createDefaultFallbackPolicy,
  fallbackPolicySchema,
} from "@traycer/protocol/host/fallback-policy";
import {
  useConfigurationItemsQuery,
  type ConfigurationItem,
} from "./use-configuration-items-query";
import { configurationProfileValueSchema } from "./configuration-item-values";

const valueSchema = z.object({ document: fallbackPolicySchema });
export function useConfigurationModelRoutingQuery() {
  return useConfigurationItemsQuery(
    "model-routing",
    (items: readonly ConfigurationItem[]) => {
      const row = items.find(
        (item) => item.kind === "fallback_policy" && item.key === "fallback",
      );
      return {
        policy:
          row === undefined
            ? createDefaultFallbackPolicy()
            : valueSchema.parse(row.value).document,
        revision: row?.revision ?? null,
        profiles: items.flatMap((item) =>
          item.kind === "managed_profile"
            ? [
                {
                  key: item.key,
                  ...configurationProfileValueSchema.parse(item.value),
                },
              ]
            : [],
        ),
      };
    },
  );
}
