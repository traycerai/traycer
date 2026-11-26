import type { AuthenticatedUser } from "@traycer/protocol/auth";
import type {
  SandboxCatalogue,
  SandboxGrowth,
} from "@traycer/protocol/host/sandbox-control";
import type { HostSwitcherNewRow } from "@/components/settings/host-scope/host-switcher-new-rows";
import { useAuthUser } from "@/hooks/auth/use-auth-user-query";
import { useSandboxCatalogue } from "@/hooks/sandboxes/use-sandbox-catalogue-query";
import { useSandboxDefaultsLookup } from "@/hooks/sandboxes/use-sandbox-defaults";
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

interface NewSandboxRowInputs {
  readonly user: AuthenticatedUser | null;
  readonly catalogue: SandboxCatalogue | null;
  readonly defaults: (
    configurationKey: string,
  ) => SandboxConfigurationDefaults | null;
}

export function useNewSandboxRowInputs(
  enabled: boolean,
): NewSandboxRowInputs & {
  readonly catalogueState: "loading" | "error" | null;
} {
  const user = useAuthUser().data ?? null;
  const query = useSandboxCatalogue(enabled);
  const catalogue = query.data ?? null;
  const defaults = useSandboxDefaultsLookup(enabled);
  let catalogueState: "loading" | "error" | null = null;
  if (catalogue === null) {
    catalogueState = query.isError ? "error" : "loading";
  }
  return { user, catalogue, defaults, catalogueState };
}

/** Whether the existing New rows can stage a usable shape. */
export function hasStageableNewSandboxRow(input: NewSandboxRowInputs): boolean {
  return stageConfigurations(input.user).some(
    (configuration) => newRowShape(input, configuration) !== null,
  );
}

function newRowShape(
  input: NewSandboxRowInputs,
  configuration: StageConfiguration,
): StageShape | null {
  return input.catalogue === null
    ? null
    : configurationStageShape(
        input.catalogue,
        input.defaults(stageConfigurationKey(configuration)),
      );
}

export function newRowFacts(
  input: NewSandboxRowInputs & {
    readonly teamBalanceMc: TeamBalanceMc;
  },
): readonly NewRowFacts[] {
  return stageConfigurations(input.user).map((configuration) => {
    const shape = newRowShape(input, configuration);
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
