import type { ReactNode } from "react";
import { Check } from "lucide-react";

import {
  PERMISSION_OPTIONS,
  normalizePermissionMode,
  type PermissionMode,
} from "@/components/home/data/landing-options";
import {
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer";
import { useResolvedTheme } from "@/providers/use-resolved-theme";
import { cn } from "@/lib/utils";
import "@/components/layout/shell/mobile-shell-touch-targets.css";

interface ComposerOptionsSheetProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly permission: PermissionMode;
  readonly onPermissionChange: (next: PermissionMode) => void;
  /** See `PermissionsPicker`: `null` (or empty) means "no harness scope". */
  readonly supportedPermissionModes: ReadonlyArray<PermissionMode> | null;
  readonly harnessLabel: string | null;
  readonly settingsLocked: boolean;
}

/**
 * Phone-width picker for agent mode and permissions, opened from the toolbar's
 * permission pill. Everything else the desktop toolbar shows stays inline on
 * the row; only these two need more width than a ~21rem row can give.
 *
 * A flat one-level list, deliberately NOT the desktop dropdowns: those hide
 * their labels under `@max-lg`, and nesting a Radix dropdown inside a vaul
 * drawer is the layering that made the terminal Launch button inert on this
 * branch. Rows read the same option registries the desktop pickers do, so the
 * copy and the supported-mode gating stay in one place.
 */
export function ComposerOptionsSheet(props: ComposerOptionsSheetProps) {
  // Drawer content portals to <body>; re-assert the resolved theme so
  // `--popover` / `--background` resolve inside the portal instead of falling
  // back to the light `:root` (same treatment as `TabSwitcherSheet`).
  const { resolvedTheme, themePreset } = useResolvedTheme();
  // Mirror the desktop picker: display the mode the harness will actually run,
  // never a stale sticky the active harness doesn't honor.
  const effectivePermission = normalizePermissionMode(
    props.permission,
    props.supportedPermissionModes,
  );
  const unsupportedSuffix = props.harnessLabel ?? "this provider";
  const supported = props.supportedPermissionModes;

  return (
    <Drawer
      direction="bottom"
      open={props.open}
      onOpenChange={props.onOpenChange}
    >
      <DrawerContent
        data-mobile-shell-touch-scope=""
        data-testid="composer-options-sheet"
        data-theme={themePreset}
        className={cn(resolvedTheme === "dark" && "dark", "max-h-[85dvh]")}
      >
        <DrawerHeader className="pb-1">
          <DrawerTitle>Task options</DrawerTitle>
        </DrawerHeader>
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-2 pb-[max(1rem,env(safe-area-inset-bottom))]">
          <div role="radiogroup" aria-label="Permissions">
            <OptionsSectionLabel>Permissions</OptionsSectionLabel>
            {PERMISSION_OPTIONS.map((option) => {
              const Icon = option.icon;
              // Inlined rather than hoisted into a boolean alias: TypeScript
              // narrows `supported` to non-null only through the check itself.
              // Empty is treated as `null` - see `normalizePermissionMode`.
              const isSupported =
                supported === null ||
                supported.length === 0 ||
                supported.includes(option.id);
              return (
                <OptionRow
                  key={option.id}
                  icon={
                    <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                  }
                  label={option.label}
                  description={
                    isSupported
                      ? option.description
                      : `Not supported by ${unsupportedSuffix}.`
                  }
                  selected={option.id === effectivePermission}
                  disabled={props.settingsLocked || !isSupported}
                  testId={`composer-options-permission-${option.id}`}
                  onSelect={() => {
                    // Defense-in-depth, mirroring `PermissionsPicker`: the
                    // disabled attribute already blocks activation, but a
                    // programmatic dispatch must not escalate permissions.
                    if (props.settingsLocked) return;
                    if (!isSupported) return;
                    props.onPermissionChange(option.id);
                  }}
                />
              );
            })}
          </div>
        </div>
      </DrawerContent>
    </Drawer>
  );
}

function OptionsSectionLabel(props: { readonly children: ReactNode }) {
  return (
    <p className="px-3 pb-1 text-overline uppercase tracking-wide text-muted-foreground/70">
      {props.children}
    </p>
  );
}

interface OptionRowProps {
  readonly icon: ReactNode;
  readonly label: string;
  readonly description: string;
  readonly selected: boolean;
  readonly disabled: boolean;
  readonly testId: string;
  readonly onSelect: () => void;
}

function OptionRow(props: OptionRowProps) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={props.selected}
      disabled={props.disabled}
      data-testid={props.testId}
      className={cn(
        "flex w-full items-start gap-3 rounded-md px-3 py-2.5 text-left transition-colors active:bg-accent/60 disabled:cursor-not-allowed disabled:opacity-50",
        props.selected && "bg-accent/40",
      )}
      onClick={props.onSelect}
    >
      {props.icon}
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-ui-sm font-medium text-foreground">
          {props.label}
        </span>
        <span className="text-ui-xs text-muted-foreground">
          {props.description}
        </span>
      </span>
      {props.selected ? (
        <Check className="mt-0.5 size-4 shrink-0 text-foreground" />
      ) : null}
    </button>
  );
}
