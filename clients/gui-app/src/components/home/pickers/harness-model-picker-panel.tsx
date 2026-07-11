import { PopoverContent } from "@/components/ui/popover";
import { focusActiveComposer } from "@/lib/composer/composer-focus-registry";
import { LEADER_SCOPE_MODEL_PICKER } from "@/lib/keybindings/leader-scope";
import { HarnessModelPickerSearch } from "@/components/home/pickers/harness-model-picker-search";
import { HarnessModelPickerList } from "@/components/home/pickers/harness-model-picker-list";
import { ProviderRail } from "@/components/home/pickers/harness-model-picker-group";
import { ProfileDropdown } from "@/components/providers/profile-dropdown";
import { useProviderProfileAddFlowStore } from "@/stores/settings/provider-profile-add-flow-store";
import { pickerProfileShortcutHintForIndex } from "@/components/home/pickers/harness-model-picker-shortcut-hint";
import type {
  HarnessOption,
  ProviderId,
} from "@/components/home/data/landing-options";
import type { GuiHarnessId } from "@traycer/protocol/host/index";
import type { ProviderProfile } from "@traycer/protocol/host/provider-schemas";
import type { GuiHarnessCatalogEntry } from "@/hooks/harnesses/use-gui-harness-catalog";
import type { HarnessModelRow } from "@/components/home/data/harness-model-search";
import type { VirtuosoHandle } from "react-virtuoso";
import {
  useCallback,
  useState,
  type KeyboardEvent,
  type RefObject,
} from "react";
import {
  HarnessModelPickerModelSettingsFooter,
  type ReasoningFooterConfig,
  type ServiceTierFooterConfig,
} from "@/components/home/pickers/harness-model-picker-footers";

interface HarnessModelPickerPanelProps {
  readonly trimmedQuery: string;
  readonly hasQuery: boolean;
  readonly listboxId: string;
  readonly idPrefix: string;
  readonly inputRef: RefObject<HTMLInputElement | null>;
  readonly query: string;
  readonly onQueryChange: (next: string) => void;
  readonly activeProviderLabel: string;
  readonly activeDescendant: string | undefined;
  readonly onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
  readonly catalogHarnesses: ReadonlyArray<HarnessOption>;
  readonly fallbackHarnesses: ReadonlyArray<HarnessOption>;
  readonly profilesByHarnessId: ReadonlyMap<
    GuiHarnessId,
    ReadonlyArray<ProviderProfile>
  >;
  readonly resolvedActiveProviderId: ProviderId;
  readonly activeProfileId: string | null;
  readonly activeProfileIdByHarnessId: ReadonlyMap<GuiHarnessId, string | null>;
  readonly activeProviderProfiles: ReadonlyArray<ProviderProfile>;
  readonly lockedHarnessId: ProviderId | null;
  readonly degradedHarnessIds: ReadonlySet<GuiHarnessId>;
  readonly catalogHarnessesLoading: boolean;
  readonly onEntryChange: (providerId: ProviderId) => void;
  readonly onProfileChange: (
    providerId: ProviderId,
    profileId: string | null,
  ) => void;
  readonly onRefreshCatalog: () => Promise<void>;
  readonly onOpenProviderSettings: () => void;
  /** Closes the picker popover without opening Settings - used by the profile
   *  dropdown's "Create new profile" row, which opens the add-profile flow in
   *  its own global host, not Settings. */
  readonly onClosePicker: () => void;
  readonly listRef: RefObject<VirtuosoHandle | null>;
  readonly listKey: string;
  readonly visibleRows: ReadonlyArray<HarnessModelRow>;
  readonly selectedRowId: string;
  readonly effectiveActiveRowId: string;
  readonly hoveredRowId: string;
  readonly initialTopMostItemIndex: {
    index: number;
    align: "center" | "end" | "start";
    behavior: "auto";
  };
  readonly catalogHarnessesError: boolean;
  readonly activeProvider: GuiHarnessCatalogEntry | null;
  readonly onHoverRow: (rowId: string) => void;
  readonly onActiveRow: (rowId: string) => void;
  readonly onSelectRow: (row: HarnessModelRow) => void;
  readonly reasoningFooter: ReasoningFooterConfig | null;
  readonly serviceTierFooter: ServiceTierFooterConfig | null;
  /** The host "Create new profile" creates on - see `HarnessModelPicker`'s
   *  prop of the same name. */
  readonly createProfileHostId: string | null;
  readonly createProfileDisabled: boolean;
  readonly createProfileDisabledReason: string | undefined;
}

export function HarnessModelPickerPanel(props: HarnessModelPickerPanelProps) {
  const {
    trimmedQuery,
    hasQuery,
    listboxId,
    idPrefix,
    inputRef,
    query,
    onQueryChange,
    activeProviderLabel,
    activeDescendant,
    onKeyDown,
    catalogHarnesses,
    fallbackHarnesses,
    profilesByHarnessId,
    resolvedActiveProviderId,
    activeProfileId,
    activeProfileIdByHarnessId,
    activeProviderProfiles,
    lockedHarnessId,
    degradedHarnessIds,
    catalogHarnessesLoading,
    onEntryChange,
    onProfileChange,
    onRefreshCatalog,
    onOpenProviderSettings,
    onClosePicker,
    listRef,
    listKey,
    visibleRows,
    selectedRowId,
    effectiveActiveRowId,
    hoveredRowId,
    initialTopMostItemIndex,
    catalogHarnessesError,
    activeProvider,
    onHoverRow,
    onActiveRow,
    onSelectRow,
    reasoningFooter,
    serviceTierFooter,
    createProfileHostId,
    createProfileDisabled,
    createProfileDisabledReason,
  } = props;
  const openAddProfile = useProviderProfileAddFlowStore(
    (state) => state.openForHarness,
  );
  const [profileDropdownContainer, setProfileDropdownContainer] =
    useState<HTMLDivElement | null>(null);
  const bindProfileDropdownContainer = useCallback(
    (node: HTMLDivElement | null) => {
      setProfileDropdownContainer(node);
    },
    [],
  );

  return (
    <PopoverContent
      side="bottom"
      align="end"
      sideOffset={8}
      collisionPadding={12}
      role="dialog"
      aria-label="Select model"
      // Opts this popover out of the keybinding provider's dialog block so the
      // picker's leader-digit shortcuts fire while it's open (see
      // `isAnyDialogOpen` in keybinding-provider.tsx).
      data-leader-scope={LEADER_SCOPE_MODEL_PICKER}
      className="h-[min(var(--radix-popover-content-available-height),23rem)] w-[min(86vw,30rem)] gap-0 overflow-hidden rounded-xl p-0"
      // Return focus to the composer editor (not the trigger pill) on close so
      // the user can keep typing after picking a model. No-op on surfaces with
      // no registered composer (e.g. the terminal launcher), where Radix's
      // default focus restore stands.
      onCloseAutoFocus={(event) => {
        if (focusActiveComposer()) event.preventDefault();
      }}
      onKeyDown={onKeyDown}
      onEscapeKeyDown={(event) => {
        if (trimmedQuery.length === 0) return;
        event.preventDefault();
        onQueryChange("");
      }}
    >
      <HarnessModelPickerSearch
        inputRef={inputRef}
        value={query}
        onChange={onQueryChange}
        providerLabel={activeProviderLabel}
        listboxId={listboxId}
        activeDescendant={activeDescendant}
      />
      {/* The provider rail stays mounted while searching: search is local to the
          active harness, so the rail keeps its role as the only way to switch
          scope. The grid is always two columns - no width jump on query. */}
      <div className="grid min-h-0 flex-1 grid-cols-[3rem_minmax(0,1fr)] overflow-hidden">
        <ProviderRail
          harnesses={catalogHarnesses}
          fallbackHarnesses={fallbackHarnesses}
          profilesByHarnessId={profilesByHarnessId}
          activeProviderId={resolvedActiveProviderId}
          activeProfileIdByHarnessId={activeProfileIdByHarnessId}
          lockedHarnessId={lockedHarnessId}
          degradedHarnessIds={degradedHarnessIds}
          pending={catalogHarnessesLoading}
          onEntryChange={onEntryChange}
          onRefresh={onRefreshCatalog}
          onOpenProviderSettings={onOpenProviderSettings}
        />
        <div
          ref={bindProfileDropdownContainer}
          className="flex min-h-0 min-w-0 flex-col overflow-hidden"
        >
          {/* The dropdown is the picker's second interaction level: only when
              the active provider has 2+ profiles, and it persists while
              typing - search stays scoped to the active provider+profile
              pair. */}
          {activeProviderProfiles.length >= 2 ? (
            <div className="shrink-0 border-b p-2">
              <ProfileDropdown
                providerLabel={activeProviderLabel}
                profiles={activeProviderProfiles}
                activeProfileId={activeProfileId}
                onSelectProfile={(profileId) =>
                  onProfileChange(resolvedActiveProviderId, profileId)
                }
                onCreateProfile={() => {
                  onClosePicker();
                  openAddProfile(
                    resolvedActiveProviderId,
                    createProfileHostId,
                    (profileId) =>
                      onProfileChange(resolvedActiveProviderId, profileId),
                  );
                }}
                onEditProfile={null}
                createProfileDisabled={createProfileDisabled}
                createProfileDisabledReason={createProfileDisabledReason}
                shortcutHintForIndex={pickerProfileShortcutHintForIndex}
                contentContainer={profileDropdownContainer}
                onCloseAutoFocus={() => inputRef.current?.focus()}
              />
            </div>
          ) : null}
          <div className="min-h-0 flex-1 overflow-hidden">
            <HarnessModelPickerList
              idPrefix={idPrefix}
              listboxId={listboxId}
              listRef={listRef}
              listKey={listKey}
              rows={visibleRows}
              selectedRowId={selectedRowId}
              activeRowId={effectiveActiveRowId}
              hoveredRowId={hoveredRowId}
              hasQuery={hasQuery}
              initialTopMostItemIndex={initialTopMostItemIndex}
              catalogLoading={catalogHarnessesLoading}
              catalogError={catalogHarnessesError}
              activeProvider={activeProvider}
              onHover={onHoverRow}
              onActive={onActiveRow}
              onSelect={onSelectRow}
              onOpenProviderSettings={onOpenProviderSettings}
            />
          </div>
          <HarnessModelPickerModelSettingsFooter
            reasoning={reasoningFooter}
            serviceTier={serviceTierFooter}
          />
        </div>
      </div>
    </PopoverContent>
  );
}
