/**
 * Docs: see ../../SETTINGS.md (Permissions ▸ Modes).
 * Update that file whenever this settings surface changes.
 */
import type { ReactNode } from "react";
import { SettingsGroup } from "@/components/settings/settings-group";
import { SettingsRow } from "@/components/settings/settings-row";
import { PermissionsPicker } from "@/components/home/pickers/permissions-picker";
import {
  PERMISSION_MODE_DETAILS,
  PERMISSION_OPTIONS,
  type PermissionOption,
} from "@/components/home/data/landing-options";
import { Badge } from "@/components/ui/badge";
import { PERMISSIONS } from "@/components/settings/panels/permissions-settings.definitions";
import { trackSettingChanged } from "@/lib/analytics";
import { useSettingsStore } from "@/stores/settings/settings-store";

/**
 * The page's one app-scoped region: the mode a new conversation starts in, and
 * what each mode runs without asking.
 *
 * Deliberately NOT behind `HostScopeGate`. The default mode is one preference
 * for this app, not per machine, so it works with no host in scope at all -
 * and the note under the tab bar says the machine picker above changes nothing
 * here, because it is the one tab where that is true.
 */
export function ModesTab(): ReactNode {
  const defaultPermission = useSettingsStore((s) => s.defaultPermission);
  const setDefaultPermission = useSettingsStore((s) => s.setDefaultPermission);
  return (
    <div className="flex flex-col gap-5">
      <p className="px-1 text-ui-xs text-muted-foreground">
        The machine picker above doesn&apos;t change anything on this tab.
      </p>
      <SettingsGroup
        group={PERMISSIONS.definitions.startingMode}
        showTitle={false}
        tone="default"
        dataTestId={undefined}
        fill={false}
      >
        <SettingsRow
          row={PERMISSIONS.definitions.defaultPermission}
          labelStatus={
            <Badge variant="muted" size="xs">
              All machines
            </Badge>
          }
          control={
            <PermissionsPicker
              value={defaultPermission}
              disabled={false}
              onChange={(next) => {
                trackSettingChanged("permissions", "defaultPermission");
                setDefaultPermission(next);
              }}
              // No harness scope: the default is install-wide and every option
              // stays enabled. A provider that does not honour the chosen mode
              // narrows it in the composer, where a harness is selected.
              supportedPermissionModes={null}
              harnessLabel={null}
              // Install-wide and harness-agnostic, so there is no catalog to
              // union, no turn to be mid-way through, no one host whose judge
              // this row could name, and no negotiated catalog line to read.
              //
              // `hostKnowsAutoMode={null}` is the THIRD state: `null` means no
              // host is in scope, exactly as `supportedPermissionModes={null}`
              // means no harness is. `false` would claim "a machine was asked
              // and cannot spell `auto`", which gates the option off - and this
              // row has asked no machine anything. The composer clamps the
              // default per host at the point a host actually exists.
              catalogSupportedModes={null}
              hostKnowsAutoMode={null}
              turnActive={false}
              judgeBilling={null}
              closeFocus="trigger"
              // A Settings surface must not open Settings.
              onOpenPermissionSettings={null}
            />
          }
        />
      </SettingsGroup>
      <ul
        aria-label={PERMISSIONS.definitions.modeCards.label}
        className="grid grid-cols-1 gap-3 sm:grid-cols-2"
      >
        {PERMISSION_OPTIONS.map((option) => (
          <PermissionModeCard key={option.id} option={option} />
        ))}
      </ul>
    </div>
  );
}

function PermissionModeCard(props: {
  readonly option: PermissionOption;
}): ReactNode {
  const { option } = props;
  const Icon = option.icon;
  const details = PERMISSION_MODE_DETAILS[option.id];
  return (
    <li
      className="flex min-w-0 flex-col gap-1.5 rounded-lg border border-border/60 bg-card/40 px-4 py-3"
      data-testid={`permission-mode-card-${option.id}`}
    >
      <div className="flex min-w-0 items-center gap-2 font-medium text-foreground">
        <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <span className="min-w-0 truncate">{option.label}</span>
      </div>
      <p className="text-ui-sm text-muted-foreground">{option.description}</p>
      <ul
        aria-label={`${option.label} runs without asking`}
        className="list-disc space-y-0.5 pl-5 text-ui-sm text-foreground"
      >
        {details.runsWithoutAsking.map((item) => (
          <li key={item.text}>
            {item.text}
            {item.exception === null ? null : (
              <span className="text-muted-foreground"> ({item.exception})</span>
            )}
          </li>
        ))}
      </ul>
    </li>
  );
}
