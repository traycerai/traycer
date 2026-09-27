import type { GuiHarnessCatalogEntry } from "@/hooks/harnesses/use-gui-harness-catalog";
import {
  agentModelKey,
  type SenderDisplayContext,
} from "@/lib/chat/sender-display";

export type ModelLabelIndex = Pick<
  SenderDisplayContext,
  "modelLabels" | "modelReasoningLabels"
>;

interface IndexNode {
  readonly harnessId: GuiHarnessCatalogEntry["id"] | null;
  readonly children: WeakMap<GuiHarnessCatalogEntry["models"], IndexNode>;
  index: ModelLabelIndex | null;
}

const root: IndexNode = {
  harnessId: null,
  children: new WeakMap(),
  index: null,
};

const emptyIndex: ModelLabelIndex = {
  modelLabels: new Map(),
  modelReasoningLabels: new Map(),
};

/**
 * Each tile receives a new harness-list wrapper, but the model arrays underneath
 * are the shared per-host query data. A weak trie shares the derived labels
 * without keeping replaced query data alive.
 */
export function getModelLabelIndex(
  harnesses: ReadonlyArray<GuiHarnessCatalogEntry>,
): ModelLabelIndex {
  let node = root;
  let hasModels = false;

  for (const harness of harnesses) {
    const { models } = harness;
    if (models.length === 0) continue;
    hasModels = true;

    let child = node.children.get(models);
    if (child === undefined) {
      child = {
        harnessId: harness.id,
        children: new WeakMap(),
        index: null,
      };
      node.children.set(models, child);
    } else if (child.harnessId !== harness.id) {
      // A model array used for another harness cannot identify this catalog.
      return buildModelLabelIndex(harnesses);
    }
    node = child;
  }

  if (!hasModels) return emptyIndex;
  node.index ??= buildModelLabelIndex(harnesses);
  return node.index;
}

function buildModelLabelIndex(
  harnesses: ReadonlyArray<GuiHarnessCatalogEntry>,
): ModelLabelIndex {
  const modelLabels = new Map<string, string>();
  const modelReasoningLabels = new Map<string, ReadonlyMap<string, string>>();

  for (const harness of harnesses) {
    for (const model of harness.models) {
      const key = agentModelKey(harness.id, model.slug);
      modelLabels.set(key, model.label);
      modelReasoningLabels.set(
        key,
        new Map(
          model.supportedReasoningEfforts.map((option) => [
            option.id,
            option.label,
          ]),
        ),
      );
    }
  }

  return { modelLabels, modelReasoningLabels };
}
