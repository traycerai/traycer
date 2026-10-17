/**
 * The create-bot form's Max Mode label (Tracy Bots). The bot's trunk later
 * runs the chosen harness/model/effort/profile with `serviceTier: null`, so
 * the picker's pre-send context must be that tuple: the chosen effort, Fast
 * off. The toolbar-store hook is replaced by one that builds a REAL toolbar
 * store, and the picker is a stub that records the context it was given.
 */
import { useState } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelOption } from "@/components/home/data/landing-options";
import {
  maxModeListedFor,
  type MaxModeContext,
} from "@/components/home/data/model-max-mode";
import type { ComposerToolbarStore } from "@/stores/composer/composer-toolbar-store";

const mocks = vi.hoisted(() => ({
  hostClient: { stub: "host-client" },
  stores: [] as ComposerToolbarStore[],
  pickerContexts: [] as MaxModeContext[],
  initialReasoning: "high",
}));

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));
vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: () => mocks.hostClient,
}));
vi.mock("@/hooks/bots/use-bot-mutations", () => ({
  useBotCreateMutation: () => ({
    isPending: false,
    error: null,
    mutateAsync: vi.fn(),
  }),
}));
vi.mock("@/components/home/pickers/harness-model-picker", () => ({
  HarnessModelPicker: (props: { maxModeContext: MaxModeContext }) => {
    mocks.pickerContexts.push(props.maxModeContext);
    return <div data-testid="stub-harness-model-picker" />;
  },
}));
vi.mock("@/components/home/hooks/use-composer-toolbar-store", async () => {
  const { createComposerToolbarStore } =
    await import("@/stores/composer/composer-toolbar-store");
  return {
    useComposerToolbarStore: (): ComposerToolbarStore => {
      const [store] = useState(() =>
        createComposerToolbarStore({
          purpose: "run",
          reasoningFallback: "model-default",
          seedKey: "create-bot-form-test",
          values: {
            permission: "supervised",
            selection: {
              harnessId: "cursor",
              modelSlug: "cursor-max",
              profileId: null,
            },
            reasoning: mocks.initialReasoning,
            serviceTier: "",
          },
          onSettingsChange: null,
          tuiOnly: false,
          chatLineCarriesAutoMode: null,
          hostId: "host-1",
        }),
      );
      mocks.stores.push(store);
      return store;
    },
  };
});

import { CreateBotForm } from "@/components/home/bots/create-bot-form";

function mountForm(): void {
  render(
    <CreateBotForm
      environmentId="env-personal"
      environmentLabel="Personal"
      boundHostIds={["host-1"]}
      bindingsResolved
      failedHostIds={[]}
      onRetryFailedHosts={vi.fn()}
      hostLabels={new Map([["host-1", "This machine"]])}
      onDone={vi.fn()}
    />,
  );
}

function cursorRow(
  chat: ReadonlyArray<{ reasoningEffort: string | null; fast: boolean }>,
): ModelOption {
  return {
    harnessId: "cursor",
    slug: "cursor-max",
    label: "Cursor Max",
    description: null,
    contextWindow: null,
    maxOutputTokens: null,
    defaultReasoningEffort: null,
    supportedReasoningEfforts: ["low", "high"].map((id) => ({
      id,
      label: id,
      description: null,
    })),
    defaultServiceTier: null,
    supportedServiceTiers: [],
    deprecationNotice: null,
    metadata: { maxMode: { chat, judge: [], fastServiceTierId: "fast" } },
  };
}

function lastContext(): MaxModeContext {
  const context = mocks.pickerContexts.at(-1);
  if (context === undefined) throw new Error("the picker never rendered");
  return context;
}

beforeEach(() => {
  mocks.stores.length = 0;
  mocks.pickerContexts.length = 0;
  mocks.initialReasoning = "high";
});

afterEach(() => {
  cleanup();
});

describe("<CreateBotForm /> Max Mode label", () => {
  it("hands the picker the chosen effort with Fast off, never the none context", () => {
    mountForm();

    expect(lastContext()).toEqual({
      kind: "chat",
      tuple: { reasoningEffort: "high", serviceTier: null },
    });
  });

  it("lists Max at the selected effort with Fast off", () => {
    mountForm();

    expect(
      maxModeListedFor(
        cursorRow([{ reasoningEffort: "high", fast: false }]),
        lastContext(),
      ),
    ).toBe(true);
  });

  it("does not list Max when only another effort is Max-only", () => {
    mountForm();

    expect(
      maxModeListedFor(
        cursorRow([{ reasoningEffort: "low", fast: false }]),
        lastContext(),
      ),
    ).toBe(false);
  });

  it("does not list Max when only the Fast-on selection is Max-only", () => {
    mountForm();

    expect(
      maxModeListedFor(
        cursorRow([{ reasoningEffort: "high", fast: true }]),
        lastContext(),
      ),
    ).toBe(false);
  });

  it("does not re-render the owner when only the catalog moves", () => {
    mountForm();
    const apply = () =>
      act(() => {
        const store = mocks.stores.at(-1);
        if (store === undefined) throw new Error("no toolbar store");
        store.getState().setCatalog({
          hostId: "host-1",
          chatLineCarriesAutoMode: null,
          harnesses: undefined,
          modelsHarnessId: "cursor",
          models: [],
          modelsLoaded: false,
          tuiOnly: false,
        });
      });
    // A second write with fresh arrays and the same values must not render the
    // owner again: a broad `useStore(toolbarStore)` there feeds the catalog
    // effect that owns the write (the update-depth loop).
    apply();
    const settled = mocks.pickerContexts.length;
    apply();
    apply();

    expect(mocks.pickerContexts.length).toBe(settled);
  });
});
