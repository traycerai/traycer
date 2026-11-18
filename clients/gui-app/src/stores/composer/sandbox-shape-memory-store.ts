import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { basePersistOptions, persistKey, STORE_KEYS } from "@/lib/persist";
import type { StageShape } from "@/lib/sandboxes/sandbox-stage-model";

/**
 * The shape a person last chose behind a New row's gear, per configuration:
 * their own preference, never the configuration's shared defaults. Bucketed
 * by the composer's host, as every composer memory is; a `null` host drops
 * the write.
 */
interface SandboxShapeMemoryState {
  /** hostId -> configuration key (`personal` or a team id) -> shape. */
  readonly byHost: Readonly<
    Record<string, Readonly<Record<string, StageShape>>>
  >;
  /**
   * hostId -> the configuration last staged, which heads the New group once
   * it collapses past two configurations.
   */
  readonly lastConfigurationByHost: Readonly<Record<string, string>>;
  readonly remember: (
    hostId: string | null,
    configurationKey: string,
    shape: StageShape,
  ) => void;
  readonly rememberConfiguration: (
    hostId: string | null,
    configurationKey: string,
  ) => void;
}

export const useSandboxShapeMemoryStore = create<SandboxShapeMemoryState>()(
  persist(
    (set) => ({
      byHost: {},
      lastConfigurationByHost: {},
      remember: (hostId, configurationKey, shape) => {
        if (hostId === null) return;
        set((state) => ({
          byHost: {
            ...state.byHost,
            [hostId]: {
              ...state.byHost[hostId],
              [configurationKey]: shape,
            },
          },
        }));
      },
      rememberConfiguration: (hostId, configurationKey) => {
        if (hostId === null) return;
        set((state) => ({
          lastConfigurationByHost: {
            ...state.lastConfigurationByHost,
            [hostId]: configurationKey,
          },
        }));
      },
    }),
    {
      ...basePersistOptions(persistKey(STORE_KEYS.sandboxShapeMemory)),
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        byHost: state.byHost,
        lastConfigurationByHost: state.lastConfigurationByHost,
      }),
    },
  ),
);

/** The remembered shape for a configuration on this host, or `null`. */
export function rememberedSandboxShape(
  byHost: SandboxShapeMemoryState["byHost"],
  hostId: string | null,
  configurationKey: string,
): StageShape | null {
  if (hostId === null) return null;
  return byHost[hostId]?.[configurationKey] ?? null;
}
