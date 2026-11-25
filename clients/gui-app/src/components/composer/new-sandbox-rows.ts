import type { AuthenticatedUser } from "@traycer/protocol/auth";
import type {
  SandboxCatalogue,
  SandboxGrowth,
} from "@traycer/protocol/host/sandbox-control";
import type { HostSwitcherNewRow } from "@/components/settings/host-scope/host-switcher-new-rows";
import {
  configurationStageShape,
  stageBalanceMc,
  stageConfigurationCopy,
  stageConfigurationKey,
  stageConfigurations,
  stageGrowth,
  stageNeedsCredits,
  stagePrice,
  type SandboxConfigurationDefaults,
  type StageConfiguration,
  type StagePrice,
  type StageShape,
  type TeamBalanceMc,
} from "@/lib/sandboxes/sandbox-stage-model";
import {
  fundedRowPrice,
  NEEDS_CREDITS,
  needsCreditsRow,
  newSandboxRowLabel,
  SANDBOXES_CANT_BE_CREATED,
  sandboxOsLabel,
  sandboxSizeLabel,
  usesCreditsClause,
} from "@/lib/sandboxes/sandbox-strings";

export interface NewRowFacts {
  readonly configuration: StageConfiguration;
  /** `null` before the catalogue answers, or when it offers no shape. */
  readonly shape: StageShape | null;
  /** What the shape grows to; `null` for a fixed shape. */
  readonly grows: SandboxGrowth | null;
  /** The catalogue answered with nothing this account can create. */
  readonly uncreatable: boolean;
  readonly price: StagePrice | null;
  readonly needsCredits: boolean;
}

export function newRowFacts(input: {
  readonly user: AuthenticatedUser | null;
  readonly teamBalanceMc: TeamBalanceMc;
  readonly catalogue: SandboxCatalogue | null;
  readonly defaults: (
    configurationKey: string,
  ) => SandboxConfigurationDefaults | null;
}): readonly NewRowFacts[] {
  return stageConfigurations(input.user).map((configuration) => {
    const shape =
      input.catalogue === null
        ? null
        : configurationStageShape(
            input.catalogue,
            input.defaults(stageConfigurationKey(configuration)),
          );
    const price =
      input.catalogue === null || shape === null
        ? null
        : stagePrice(input.catalogue, shape);
    return {
      configuration,
      shape,
      grows:
        input.catalogue === null || shape === null
          ? null
          : stageGrowth(input.catalogue, shape),
      uncreatable: input.catalogue !== null && shape === null,
      price,
      needsCredits: stageNeedsCredits(
        stageBalanceMc(input.user, configuration, input.teamBalanceMc),
        price,
      ),
    };
  });
}

/**
 * `New Acme sandbox` over `Linux · 2 vCPU · 4 GB · $0.12 an hour while awake ·
 * uses Acme's credits`; at a short balance `New Acme sandbox · needs
 * credits` over `Linux · 2 vCPU · 4 GB · from $0.12 an hour · uses Acme's
 * credits`.
 */
export function newRowPresentation(
  facts: NewRowFacts,
  catalogueState: "loading" | "error" | null,
): HostSwitcherNewRow {
  const copy = stageConfigurationCopy(facts.configuration);
  const head = newSandboxRowLabel(copy);
  if (catalogueState !== null) {
    return {
      configurationKey: stageConfigurationKey(facts.configuration),
      label: head,
      subLine:
        catalogueState === "loading"
          ? "Loading sizes and regions…"
          : "Sizes and regions couldn't be loaded.",
      configuration: copy,
      disabled: catalogueState === "loading",
    };
  }
  if (facts.uncreatable) {
    return {
      configurationKey: stageConfigurationKey(facts.configuration),
      label: head,
      subLine: SANDBOXES_CANT_BE_CREATED,
      configuration: copy,
      disabled: true,
    };
  }
  const parts: string[] = [];
  if (facts.shape !== null) {
    parts.push(
      sandboxOsLabel(facts.shape.os),
      sandboxSizeLabel(facts.shape.cpus, facts.shape.memoryMb, facts.grows),
    );
  }
  if (facts.price !== null) {
    parts.push(newRowPrice(facts.price, facts.needsCredits));
  }
  parts.push(usesCreditsClause(copy));
  return {
    configurationKey: stageConfigurationKey(facts.configuration),
    label: facts.needsCredits ? `${head} · ${NEEDS_CREDITS}` : head,
    subLine: parts.join(" · "),
    configuration: copy,
    disabled: false,
  };
}

function newRowPrice(price: StagePrice, needsCredits: boolean): string {
  return needsCredits
    ? needsCreditsRow(price.awakeMcPerHour, price.offer)
    : fundedRowPrice(price.awakeMcPerHour, price.offer, price.exact);
}
