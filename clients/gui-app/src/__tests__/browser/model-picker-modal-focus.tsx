import { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { VirtuosoHandle } from "react-virtuoso";
import {
  guiAgentModelOptionSchema,
  guiHarnessOptionSchema,
} from "@traycer/protocol/host/agent/gui/unary-schemas";
import { buildAllHarnessModelRows } from "@/components/home/data/harness-model-search";
import { ComposerPromptEditor } from "@/components/chat/composer/composer-prompt-editor";
import { createComposerPickerStore } from "@/components/chat/composer/picker/composer-picker-store";
import { HarnessModelPickerPanel } from "@/components/home/pickers/harness-model-picker-panel";
import { handleHarnessModelPickerKeyDown } from "@/components/home/pickers/harness-model-picker-keyboard";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Popover, PopoverTrigger } from "@/components/ui/popover";
import { TooltipProvider } from "@/components/ui/tooltip";
import { HarnessModelPickerTriggerTooltip } from "@/components/home/pickers/harness-model-picker-trigger-tooltip";
import "@/lib/theme-applier";
import "@/index.css";

const EFFORTS = [
  { id: "low", label: "Low", description: null },
  { id: "high", label: "High", description: null },
];
const TIERS = [
  { id: "standard", label: "Standard", description: null },
  { id: "fast", label: "Fast", description: null },
];
const ULTRA_TIER = { id: "ultrafast", label: "Ultrafast", description: null };
function fixtureModel(label: string, tiers: typeof TIERS) {
  return guiAgentModelOptionSchema.parse({
    harnessId: "claude",
    slug: label.toLowerCase(),
    label,
    description: null,
    contextWindow: null,
    maxOutputTokens: null,
    defaultReasoningEffort: "low",
    supportedReasoningEfforts: EFFORTS,
    defaultServiceTier: "standard",
    supportedServiceTiers: tiers,
    metadata: {},
  });
}
const SONNET = fixtureModel(
  "Sonnet",
  new URLSearchParams(window.location.search).has("dual-tier")
    ? [...TIERS, ULTRA_TIER]
    : TIERS,
);
const MODELS = [SONNET, fixtureModel("Haiku", TIERS)];
const HARNESS = {
  ...guiHarnessOptionSchema.parse({
    id: "claude",
    label: "Claude",
    available: true,
    error: null,
    modes: ["gui"],
    requiresApiKey: false,
  }),
  models: MODELS,
  modelsLoading: false,
  modelsError: null,
};
const ROWS = buildAllHarnessModelRows([{ harness: HARNESS, models: MODELS }]);

export function FixtureEditor(props: { readonly placeholder: string }) {
  const [pickerStore] = useState(() => createComposerPickerStore());
  return (
    <ComposerPromptEditor
      pickerStore={pickerStore}
      initialContent={{ type: "doc", content: [{ type: "paragraph" }] }}
      initialSelection={null}
      placeholder={props.placeholder}
      editorClassName={undefined}
      stabilizeImageAttachmentCaret={false}
      isActive
      disabled={false}
      slashProviderId="claude"
      hasPastedImageBytes={null}
      ingestPastedComposerImages={null}
      onDocumentChange={() => undefined}
      onSelectionChange={() => undefined}
      onSubmit={() => undefined}
      onPaste={() => undefined}
      onDragOver={() => undefined}
      onDrop={() => undefined}
      onKeyDown={undefined}
      onFocus={() => undefined}
      onBlur={() => undefined}
      onEditorReady={null}
    />
  );
}

export function ModalFixture() {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState("sonnet");
  const [reasoning, setReasoning] = useState("low");
  const [tier, setTier] = useState("");
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<VirtuosoHandle | null>(null);
  const selectedModel =
    MODELS.find((model) => model.slug === selected) ?? SONNET;

  return (
    <TooltipProvider delayDuration={0}>
      {/* An existing chat remains mounted while its pane's new-agent dialog is
          open. Both editors can claim active; Radix hides this one from input. */}
      <FixtureEditor placeholder="Background chat" />
      <Dialog open>
        <DialogContent showCloseButton={false}>
          <DialogTitle>Start a new agent</DialogTitle>
          <FixtureEditor placeholder="Ask Traycer anything" />
          <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
              <HarnessModelPickerTriggerTooltip
                pickerOpen={open}
                label={
                  <span>
                    {selectedModel.label} · Effort {reasoning}
                  </span>
                }
              >
                <button type="button">
                  {selectedModel.label} · {reasoning}
                </button>
              </HarnessModelPickerTriggerTooltip>
            </PopoverTrigger>
            <HarnessModelPickerPanel
              trimmedQuery={query.trim()}
              hasQuery={query.trim().length > 0}
              listboxId="fixture-model-listbox"
              idPrefix="fixture-model"
              inputRef={searchRef}
              query={query}
              onQueryChange={setQuery}
              activeProviderLabel="Claude"
              activeDescendant={undefined}
              onKeyDown={(event) =>
                handleHarnessModelPickerKeyDown(event, {
                  visibleRows: ROWS,
                  effectiveActiveRowId: ROWS[1]?.id ?? "",
                  activeRow: ROWS[1] ?? null,
                  trimmedQuery: "",
                  listRef,
                  onActiveRowId: () => undefined,
                  onSelectRow: (row) => setSelected(row.value),
                  onQueryChange: setQuery,
                  onClose: () => setOpen(false),
                })
              }
              catalogHarnesses={[HARNESS]}
              fallbackHarnesses={[HARNESS]}
              profilesByHarnessId={new Map()}
              resolvedActiveProviderId="claude"
              activeProfileId={null}
              activeProfileIdByHarnessId={new Map()}
              activeProviderProfiles={[]}
              profileEnablementPending={() => false}
              activeProviderState={null}
              lockedHarnessId={null}
              degradedHarnessIds={new Set()}
              preparingByHarnessId={new Map()}
              catalogHarnessesLoading={false}
              onEntryChange={() => undefined}
              onRetryPack={() => undefined}
              onProfileChange={() => undefined}
              onRefreshCatalog={() => Promise.resolve()}
              hostUnavailableLabel={null}
              onOpenProviderSettings={() => undefined}
              onClosePicker={() => setOpen(false)}
              listRef={listRef}
              listKey="fixture"
              visibleRows={ROWS}
              selectedRowId={
                ROWS.find((row) => row.value === selected)?.id ?? ""
              }
              effectiveActiveRowId={ROWS[1]?.id ?? ""}
              hoveredRowId=""
              initialTopMostItemIndex={{
                index: 0,
                align: "start",
                behavior: "auto",
              }}
              catalogHarnessesError={false}
              activeProvider={HARNESS}
              onHoverRow={() => undefined}
              onActiveRow={() => undefined}
              onSelectRow={(row) => setSelected(row.value)}
              reasoningFooter={{
                value: reasoning,
                options: EFFORTS,
                disabled: false,
                onChange: setReasoning,
              }}
              reasoningPickerOpen={open}
              serviceTierFooter={{
                selectedModel,
                value: tier,
                onChange: setTier,
              }}
              createProfileHostId={null}
              runTargetHostId={null}
              terminalLoginSurface={null}
              createProfileDisabled
              createProfileDisabledReason={undefined}
              profileAdmission={null}
              closeFocusesComposer
              footer={null}
            />
          </Popover>
        </DialogContent>
      </Dialog>
    </TooltipProvider>
  );
}

const root = document.getElementById("root");
if (root === null) throw new Error("Missing fixture root");
createRoot(root).render(<ModalFixture />);
