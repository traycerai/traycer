import type { ReactNode } from "react";
import { PROVIDER_DISPLAY_NAMES } from "@traycer/protocol/host/provider-schemas";
import type { ProviderCliState } from "@traycer/protocol/host/provider-schemas";
import { MutedAgentSpinner } from "@/components/ui/agent-spinning-dots";
import { useHostSupportsMethod } from "@/hooks/host/use-host-supports-method";
import { useProvidersSetEnvOverride } from "@/hooks/providers/use-providers-set-env-override-mutation";
import { useProvidersDeleteEnvOverride } from "@/hooks/providers/use-providers-delete-env-override-mutation";
import { useProvidersProfileConfig } from "@/hooks/providers/use-providers-profile-config-query";
import {
  useProvidersDeleteProfileEnvOverride,
  useProvidersSetProfileEnvOverride,
} from "@/hooks/providers/use-providers-set-profile-env-mutation";
import { EnvOverrideEditor } from "./env-override-editor";
import { envNamePlaceholder } from "./provider-env-name-placeholder";

type ProviderId = ProviderCliState["providerId"];

const EMPTY_RESERVED_KEYS: readonly string[] = [];

/**
 * D29: mirrors `RESERVED_PROFILE_ENV_KEYS`
 * (`traycer-host/src/domain/providers/profile-execution-config.ts`) - a
 * client-side hint only, never the sole check. The host stays authoritative
 * (`profile-env-reserved-key`); a key this list misses still fails the write
 * with the host's own error.
 *
 * Kept in step BY HAND, and there is no test that can do it for us: the two
 * lists live either side of a repo boundary (this package is the OSS
 * submodule, the host is the internal monorepo), so nothing importable can
 * pin them together. Changing the host list means changing this one in the
 * same PR - the cost of missing a key is a user typing it, pressing Add, and
 * getting the host rejection this field exists to pre-empt.
 */
const RESERVED_PROFILE_ENV_KEYS: readonly string[] = [
  "CLAUDE_CONFIG_DIR",
  "CODEX_HOME",
  "CODEX_SQLITE_HOME",
  "GROK_HOME",
  "XDG_DATA_HOME",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_STATE_HOME",
  "GH_CONFIG_DIR",
  "OPENCODE_CONFIG_DIR",
  "OPENCODE_CONFIG_CONTENT",
  "KIMI_CODE_HOME",
  "COPILOT_HOME",
  "REASONIX_HOME",
  "KILO_CONFIG_CONTENT",
  "KILO_AUTH_CONTENT",
  "TRAYCER_CODEX_API_KEY",
  "XAI_API_KEY",
  "GROK_XAI_API_BASE_URL",
];

export function ProviderEnvOverridesSection({
  hostId,
  providerId,
  profileId,
  overrides,
  envOverrideScope,
}: {
  readonly hostId: string | null;
  readonly providerId: ProviderId;
  /** D17; the switcher's current selection. `null` = the Default account. */
  readonly profileId: string | null;
  /** The Default account's overrides (`state.envOverrides`); unused when a
   *  managed profile is selected, which reads its own env from
   *  `providers.getProfileConfig` instead (D16: never mirrored). */
  readonly overrides: readonly {
    readonly key: string;
    readonly value: string | null;
  }[];
  readonly envOverrideScope: ProviderCliState["nativeCapabilities"]["envOverrideScope"];
}) {
  const providerName = PROVIDER_DISPLAY_NAMES[providerId];
  const supportsProfileConfig = useHostSupportsMethod(
    hostId,
    "providers.setProfileConfig",
  );
  const isProfile = profileId !== null;

  if (isProfile && !supportsProfileConfig) {
    return (
      <div className="mt-3 flex flex-col gap-1 rounded-lg border border-border/60 p-3">
        <div className="text-ui-sm font-medium text-foreground">
          Environment variables
        </div>
        <p className="text-ui-xs text-muted-foreground">
          This host doesn&apos;t support per-profile environment variables yet.
          Update the host to manage this profile&apos;s env here.
        </p>
      </div>
    );
  }

  return isProfile ? (
    <ProfileEnvOverridesSectionBody
      providerId={providerId}
      profileId={profileId}
      providerName={providerName}
      envOverrideScope={envOverrideScope}
    />
  ) : (
    <DefaultAccountEnvOverridesSection
      providerId={providerId}
      providerName={providerName}
      overrides={overrides}
      envOverrideScope={envOverrideScope}
    />
  );
}

function EnvOverridesFrame(props: {
  readonly envOverrideScope: ProviderCliState["nativeCapabilities"]["envOverrideScope"];
  readonly providerName: string;
  readonly disabled: boolean;
  readonly children: ReactNode;
}) {
  return (
    <div className="mt-3 flex flex-col gap-3 rounded-lg border border-border/60 p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-ui-sm font-medium text-foreground">
            Environment variables
          </div>
          {props.envOverrideScope === "native-config-only" ? (
            <p className="text-ui-xs text-muted-foreground">
              Applied to native configuration operations, such as MCP setup, but
              not chat turns. Use Unset to drop a variable inherited from your
              shell.
            </p>
          ) : (
            <p className="text-ui-xs text-muted-foreground">
              Applied when Traycer spawns the {props.providerName} harness. Use
              Unset to drop a variable inherited from your shell.
            </p>
          )}
        </div>
        {props.disabled ? <MutedAgentSpinner /> : null}
      </div>
      {props.children}
    </div>
  );
}

function DefaultAccountEnvOverridesSection({
  providerId,
  providerName,
  overrides,
  envOverrideScope,
}: {
  readonly providerId: ProviderId;
  readonly providerName: string;
  readonly overrides: readonly {
    readonly key: string;
    readonly value: string | null;
  }[];
  readonly envOverrideScope: ProviderCliState["nativeCapabilities"]["envOverrideScope"];
}) {
  const setOverride = useProvidersSetEnvOverride();
  const deleteOverride = useProvidersDeleteEnvOverride();
  const disabled = setOverride.isPending || deleteOverride.isPending;

  // A rename is set-new → delete-old so a failed delete leaves a harmless
  // duplicate rather than a lost value.
  const onCommit = (
    oldKey: string,
    newKey: string,
    value: string | null,
  ): void => {
    setOverride.mutate(
      { providerId, key: newKey, value },
      {
        onSuccess: () => {
          if (oldKey.length > 0 && oldKey !== newKey) {
            deleteOverride.mutate({ providerId, key: oldKey });
          }
        },
      },
    );
  };

  return (
    <EnvOverridesFrame
      envOverrideScope={envOverrideScope}
      providerName={providerName}
      disabled={disabled}
    >
      <EnvOverrideEditor
        overrides={overrides}
        disabled={disabled}
        namePlaceholder={envNamePlaceholder(providerId)}
        emptyLabel={`No environment variables for ${providerName}.`}
        reservedKeys={EMPTY_RESERVED_KEYS}
        onCommit={onCommit}
        onDelete={(key) => deleteOverride.mutate({ providerId, key })}
      />
    </EnvOverridesFrame>
  );
}

/** D16/D29: a managed profile's env lives on its own config row, read via
 *  `providers.getProfileConfig` and written whole via `providers.setProfileConfig`
 *  - never mirrored into the Default account's `envOverrides`. */
function ProfileEnvOverridesSectionBody({
  providerId,
  profileId,
  providerName,
  envOverrideScope,
}: {
  readonly providerId: ProviderId;
  readonly profileId: string;
  readonly providerName: string;
  readonly envOverrideScope: ProviderCliState["nativeCapabilities"]["envOverrideScope"];
}) {
  const configQuery = useProvidersProfileConfig({
    providerId,
    profileId,
    enabled: true,
  });
  const setOverride = useProvidersSetProfileEnvOverride();
  const deleteOverride = useProvidersDeleteProfileEnvOverride();
  const disabled =
    setOverride.isPending || deleteOverride.isPending || configQuery.isLoading;
  const overrides = configQuery.data?.config.env ?? [];

  const onCommit = (
    oldKey: string,
    newKey: string,
    value: string | null,
  ): void => {
    // One write, not an add followed by a delete: the config write is
    // whole-config LWW (D15), so a rename split in two clobbers a concurrent
    // edit twice and strands both keys if the second half fails.
    setOverride.mutate({
      providerId,
      profileId,
      key: newKey,
      value,
      previousKey: oldKey.length > 0 && oldKey !== newKey ? oldKey : null,
    });
  };

  return (
    <EnvOverridesFrame
      envOverrideScope={envOverrideScope}
      providerName={providerName}
      disabled={disabled}
    >
      <EnvOverrideEditor
        overrides={overrides}
        disabled={disabled}
        namePlaceholder={envNamePlaceholder(providerId)}
        emptyLabel={`No environment variables for ${providerName}.`}
        reservedKeys={RESERVED_PROFILE_ENV_KEYS}
        onCommit={onCommit}
        onDelete={(key) =>
          deleteOverride.mutate({ providerId, profileId, key })
        }
      />
    </EnvOverridesFrame>
  );
}
