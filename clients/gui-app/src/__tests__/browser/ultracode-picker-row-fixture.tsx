import { useEffect, useRef, useState } from "react";
import type { VirtuosoHandle } from "react-virtuoso";
import {
  guiAgentModelOptionSchema,
  guiHarnessOptionSchema,
  type GuiAgentModelOption,
} from "@traycer/protocol/host/agent/gui/unary-schemas";
import { buildAllHarnessModelRows } from "@/components/home/data/harness-model-search";
import type { ProviderId } from "@/components/home/data/landing-options";
import { HarnessModelPickerPanel } from "@/components/home/pickers/harness-model-picker-panel";
import { HarnessModelTrigger } from "@/components/home/pickers/harness-model-trigger";
import { Popover, PopoverTrigger } from "@/components/ui/popover";
import { TooltipProvider } from "@/components/ui/tooltip";

/**
 * The real picker panel and the real model trigger with the Ultracode row.
 * The query string sets the first state (`offered` = true | false | unknown,
 * `carried` = 1 | 0, `label=long`); `window.__ultracodeRowProbe` changes the
 * model's eligibility and the carrier live, so a spec can compare the frame
 * before and after. Switching harness goes through the real provider rail.
 */

type Offered = boolean | undefined;

interface UltracodeRowProbe {
  readonly setOffered: (offered: "true" | "false" | "unknown") => void;
  readonly setCarried: (carried: boolean) => void;
}

declare global {
  interface Window {
    __ultracodeRowProbe: UltracodeRowProbe | undefined;
  }
}

function offeredFrom(value: string | null): Offered {
  if (value === "false") return false;
  if (value === "unknown") return undefined;
  return true;
}

const params = new URLSearchParams(window.location.search);
const LONG_LABEL =
  "Claude Opus 5.5 with an unusually long display name for narrow screens";
const CLAUDE_LABEL = params.get("label") === "long" ? LONG_LABEL : "Opus 5.5";

const EFFORTS = [
  { id: "low", label: "Low", description: null },
  { id: "high", label: "High", description: null },
];

function fixtureModel(
  harnessId: ProviderId,
  slug: string,
  label: string,
): GuiAgentModelOption {
  return guiAgentModelOptionSchema.parse({
    harnessId,
    slug,
    label,
    description: null,
    contextWindow: null,
    maxOutputTokens: null,
    defaultReasoningEffort: "low",
    supportedReasoningEfforts: EFFORTS,
    defaultServiceTier: null,
    supportedServiceTiers: [],
    metadata: {},
  });
}

function fixtureHarness(
  id: ProviderId,
  label: string,
  model: GuiAgentModelOption,
) {
  return {
    ...guiHarnessOptionSchema.parse({
      id,
      label,
      available: true,
      error: null,
      modes: ["gui"],
      requiresApiKey: false,
    }),
    models: [model],
    modelsLoading: false,
    modelsError: null,
  };
}

const CLAUDE_MODEL = fixtureModel("claude", "opus", CLAUDE_LABEL);
const CODEX_MODEL = fixtureModel("codex", "gpt", "GPT 5.5");
const CLAUDE = fixtureHarness("claude", "Claude", CLAUDE_MODEL);
const CODEX = fixtureHarness("codex", "Codex", CODEX_MODEL);
const CATALOG = [CLAUDE, CODEX];
const ROWS_BY_HARNESS = {
  claude: buildAllHarnessModelRows([
    { harness: CLAUDE, models: [CLAUDE_MODEL] },
  ]),
  codex: buildAllHarnessModelRows([{ harness: CODEX, models: [CODEX_MODEL] }]),
};

export function UltracodePickerRowFixture() {
  const [activeId, setActiveId] = useState<"claude" | "codex">("claude");
  const [offered, setOffered] = useState<Offered>(
    offeredFrom(params.get("offered")),
  );
  const [carried, setCarried] = useState(params.get("carried") !== "0");
  const [requested, setRequested] = useState(true);
  const [reasoning, setReasoning] = useState("high");
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<VirtuosoHandle | null>(null);
  const noop = (): void => undefined;

  useEffect(() => {
    window.__ultracodeRowProbe = {
      setOffered: (next) => setOffered(offeredFrom(next)),
      setCarried,
    };
    return () => {
      window.__ultracodeRowProbe = undefined;
    };
  }, []);

  const active = activeId === "claude" ? CLAUDE : CODEX;
  const model = activeId === "claude" ? CLAUDE_MODEL : CODEX_MODEL;
  const rows = ROWS_BY_HARNESS[activeId];
  // The row and the icon belong to a Claude selection on a chat surface.
  const claudeSelected = activeId === "claude";
  const ultracodeRequested = claudeSelected && requested && offered === true;
  return (
    <TooltipProvider delayDuration={0}>
      <Popover open>
        <PopoverTrigger asChild>
          <HarnessModelTrigger
            selection={{
              harnessId: activeId,
              modelSlug: model.slug,
              profileId: null,
            }}
            label={model.label}
            reasoningLabel="High"
            reasoningStep={{ index: 1, count: 2 }}
            reasoningIndicator="text"
            serviceTierLabel={null}
            serviceTierActive={false}
            ultracodeRequested={ultracodeRequested}
            profileLabel={null}
            profileAccentDot={null}
            isLoading={false}
            disabled={false}
            labelDisplay="model-only"
          />
        </PopoverTrigger>
        <HarnessModelPickerPanel
          trimmedQuery=""
          hasQuery={false}
          listboxId="fixture-model-listbox"
          idPrefix="fixture-model"
          inputRef={searchRef}
          query={query}
          onQueryChange={setQuery}
          activeProviderLabel={active.label}
          activeDescendant={undefined}
          onKeyDown={noop}
          catalogHarnesses={CATALOG}
          fallbackHarnesses={CATALOG}
          offeredAgents={null}
          profilesByHarnessId={new Map()}
          resolvedActiveProviderId={activeId}
          activeProfileId={null}
          activeProfileIdByHarnessId={new Map()}
          activeProviderProfiles={[]}
          profileEnablementPending={() => false}
          activeProviderState={null}
          lockedHarnessId={null}
          degradedHarnessIds={new Set()}
          preparingByHarnessId={new Map()}
          catalogHarnessesLoading={false}
          onEntryChange={(providerId) => {
            if (providerId === "claude" || providerId === "codex") {
              setActiveId(providerId);
            }
          }}
          onRetryPack={noop}
          onProfileChange={noop}
          onRefreshCatalog={() => Promise.resolve()}
          hostUnavailableLabel={null}
          onOpenProviderSettings={noop}
          onClosePicker={noop}
          listRef={listRef}
          listKey={activeId}
          visibleRows={rows}
          selectedRowId={rows[0]?.id ?? ""}
          effectiveActiveRowId={rows[0]?.id ?? ""}
          hoveredRowId=""
          initialTopMostItemIndex={{
            index: 0,
            align: "start",
            behavior: "auto",
          }}
          catalogHarnessesError={false}
          activeProvider={active}
          onHoverRow={noop}
          onActiveRow={noop}
          onSelectRow={noop}
          reasoningFooter={{
            value: reasoning,
            options: EFFORTS,
            disabled: false,
            onChange: setReasoning,
          }}
          ultracodeFooter={
            claudeSelected
              ? {
                  requested,
                  offered,
                  carried,
                  modelLabel: model.label,
                  onChange: setRequested,
                }
              : null
          }
          reasoningPickerOpen
          serviceTierFooter={null}
          createProfileHostId={null}
          runTargetHostId={null}
          terminalLoginSurface={null}
          createProfileDisabled
          createProfileDisabledReason={undefined}
          profileAdmission={null}
          closeFocusesComposer={false}
          footer={null}
        />
      </Popover>
    </TooltipProvider>
  );
}
