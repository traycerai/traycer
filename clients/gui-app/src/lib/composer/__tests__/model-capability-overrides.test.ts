import { describe, expect, it } from "vitest";
import type { ModelOption } from "@/components/home/data/landing-options";
import { modelSupportsImageAttachments } from "../chat-run-settings";
import { modelImageSupportOverride } from "../model-capability-overrides";

function model(overrides: {
  readonly harnessId: string;
  readonly slug: string;
  readonly label: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}): ModelOption {
  return {
    harnessId: overrides.harnessId as ModelOption["harnessId"],
    slug: overrides.slug,
    label: overrides.label,
    description: null,
    contextWindow: null,
    maxOutputTokens: null,
    defaultReasoningEffort: null,
    supportedReasoningEfforts: [],
    defaultServiceTier: null,
    supportedServiceTiers: [],
    metadata: overrides.metadata ?? {},
  } as ModelOption;
}

describe("modelImageSupportOverride", () => {
  it("flags Kimi K3 slugs as vision-capable", () => {
    expect(
      modelImageSupportOverride({
        harnessId: "kimi",
        slug: "kimi-k3",
        label: "Kimi K3",
      }),
    ).toBe(true);
  });

  it("flags Kimi K2.7 slugs as vision-capable", () => {
    expect(
      modelImageSupportOverride({
        harnessId: "kimi",
        slug: "kimi-k2.7-code",
        label: "Kimi K2.7 Code",
      }),
    ).toBe(true);
  });

  it("flags provider-prefixed Kimi K3 slugs (OMP route)", () => {
    expect(
      modelImageSupportOverride({
        harnessId: "omp",
        slug: "moonshot/kimi-k3-turbo",
        label: "kimi-k3-turbo",
      }),
    ).toBe(true);
  });

  it("flags bare-generation slugs on the Kimi harness (slug 'k3', label 'K3')", () => {
    expect(
      modelImageSupportOverride({
        harnessId: "kimi",
        slug: "k3",
        label: "K3",
      }),
    ).toBe(true);
    expect(
      modelImageSupportOverride({
        harnessId: "kimi",
        slug: "k2.7",
        label: "K2.7",
      }),
    ).toBe(true);
  });

  it("has no opinion on bare slugs outside the Kimi harness", () => {
    expect(
      modelImageSupportOverride({
        harnessId: "omp",
        slug: "k3",
        label: "K3",
      }),
    ).toBe(null);
  });

  it("has no opinion on older Kimi generations", () => {
    expect(
      modelImageSupportOverride({
        harnessId: "kimi",
        slug: "kimi-k2.5",
        label: "Kimi K2.5",
      }),
    ).toBe(null);
  });

  it("has no opinion on non-Kimi models", () => {
    expect(
      modelImageSupportOverride({
        harnessId: "codex",
        slug: "gpt-5.2",
        label: "GPT-5.2",
      }),
    ).toBe(null);
  });
});

describe("modelSupportsImageAttachments with overrides", () => {
  it("accepts images for kimi-k3 even with empty host metadata", () => {
    expect(
      modelSupportsImageAttachments(
        model({ harnessId: "kimi", slug: "kimi-k3", label: "Kimi K3" }),
      ),
    ).toBe(true);
  });

  it("still trusts host metadata for other models", () => {
    expect(
      modelSupportsImageAttachments(
        model({
          harnessId: "claude-code",
          slug: "claude-opus-5",
          label: "Opus 5",
          metadata: { supportsImages: true },
        }),
      ),
    ).toBe(true);
    expect(
      modelSupportsImageAttachments(
        model({
          harnessId: "codex",
          slug: "gpt-5.2",
          label: "GPT-5.2",
        }),
      ),
    ).toBe(false);
  });
});
