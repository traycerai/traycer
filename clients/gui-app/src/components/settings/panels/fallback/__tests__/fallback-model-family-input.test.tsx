import { cleanup, fireEvent, screen } from "@testing-library/react";
import { useState, type ChangeEvent, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  FallbackPolicy,
  TierCandidate,
} from "@traycer/protocol/host/fallback-policy";
import {
  createDefaultFallbackPolicy,
  fallbackPolicySchema,
} from "@traycer/protocol/host/fallback-policy";
import { FallbackModelFamilyInput } from "@/components/settings/panels/fallback/fallback-model-family-input";
import { renderWithFallbackQueryClient } from "@/components/settings/panels/__tests__/fallback-settings-panel-test-support";

const { catalogModels, modelsQuery } = vi.hoisted(() => {
  const catalogModels = {
    current: [
      { slug: "claude-sonnet-4", label: "Claude Sonnet 4" },
      { slug: "claude-opus-4", label: "Claude Opus 4" },
    ],
  };
  const modelsQuery = vi.fn(() => ({
    data: {
      models: catalogModels.current,
    },
  }));
  return { catalogModels, modelsQuery };
});

vi.mock("@/hooks/harnesses/use-gui-harness-catalog", () => ({
  useGuiHarnessModelsQuery: modelsQuery,
}));

afterEach(() => {
  cleanup();
  catalogModels.current = [
    { slug: "claude-sonnet-4", label: "Claude Sonnet 4" },
    { slug: "claude-opus-4", label: "Claude Opus 4" },
  ];
  modelsQuery.mockClear();
});

function candidate(modelFamily: string): TierCandidate {
  return { harnessId: "claude", modelFamily, reasoningEffort: null };
}

function policyWithFamily(modelFamily: string): FallbackPolicy {
  return {
    ...createDefaultFallbackPolicy(),
    tierGroups: [{ id: "sources", candidates: [candidate(modelFamily)] }],
  };
}

function ControlledEditor(props: {
  readonly commits: FallbackPolicy[];
}): ReactNode {
  const [current, setCurrent] = useState<FallbackPolicy>(() =>
    policyWithFamily("custom-family"),
  );
  const currentFamily = current.tierGroups[0].candidates[0].modelFamily;
  const onChange = (event: ChangeEvent<HTMLInputElement>): void => {
    const nextFamily = event.currentTarget.value;
    setCurrent((previous) => ({
      ...previous,
      tierGroups: [
        {
          ...previous.tierGroups[0],
          candidates: [
            {
              ...previous.tierGroups[0].candidates[0],
              modelFamily: nextFamily,
            },
          ],
        },
      ],
    }));
  };
  const commit = (): void => {
    props.commits.push(fallbackPolicySchema.parse(current));
  };
  return (
    <FallbackModelFamilyInput
      aria-label="Model family"
      harnessId="claude"
      value={currentFamily}
      onChange={onChange}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") commit();
      }}
    />
  );
}

describe("FallbackModelFamilyInput", () => {
  it("uses only the cached catalog for the selected harness and renders slug-valued labelled suggestions", () => {
    renderWithFallbackQueryClient(
      <FallbackModelFamilyInput
        aria-label="Model family"
        harnessId="claude"
        value=""
        onChange={() => {}}
      />,
    );

    expect(modelsQuery).toHaveBeenCalledWith("claude", null, {
      enabled: false,
      subscribed: true,
    });
    // The field carries NO hint of its own. It used to append "Choose a
    // catalog model or type a family name." as a `w-full` sibling, which broke
    // the model's row onto a second line and then repeated itself under every
    // other model in the group. The editor says it once, above the table.
    expect(
      screen.queryByText(/Choose a catalog model or type a family name/),
    ).toBeNull();
    const input = screen.getByRole("combobox", { name: "Model family" });
    const listId = input.getAttribute("list");
    expect(listId).not.toBeNull();
    if (listId === null) return;
    const datalist = document.getElementById(listId);
    expect(datalist).not.toBeNull();
    if (datalist === null) return;
    expect(
      Array.from(datalist.querySelectorAll("option")).map((option) => ({
        value: option.value,
        label: option.textContent,
      })),
    ).toEqual([
      { value: "claude-sonnet-4", label: "Claude Sonnet 4" },
      { value: "claude-opus-4", label: "Claude Opus 4" },
    ]);
  });

  it("round-trips a chosen catalog slug and free text through a controlled policy", () => {
    const commits: FallbackPolicy[] = [];
    renderWithFallbackQueryClient(<ControlledEditor commits={commits} />);

    const input = screen.getByRole("combobox", { name: "Model family" });
    fireEvent.change(input, { target: { value: "claude-opus-4" } });
    fireEvent.blur(input);
    expect(commits.at(-1)?.tierGroups[0]?.candidates[0]?.modelFamily).toBe(
      "claude-opus-4",
    );

    fireEvent.change(input, { target: { value: "my-private-family" } });
    if (!(input instanceof HTMLInputElement))
      throw new Error("Expected an input");
    expect(input.value).toBe("my-private-family");
    fireEvent.blur(input);
    expect(commits.at(-1)?.tierGroups[0]?.candidates[0]?.modelFamily).toBe(
      "my-private-family",
    );

    fireEvent.change(input, { target: { value: "another-family" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(commits.at(-1)?.tierGroups[0]?.candidates[0]?.modelFamily).toBe(
      "another-family",
    );
  });

  it("falls back to a plain textbox while forwarding input accessibility props", () => {
    catalogModels.current = [];
    renderWithFallbackQueryClient(
      <FallbackModelFamilyInput
        aria-label="Model family"
        aria-describedby="family-help"
        aria-invalid
        harnessId="claude"
        id="family-id"
        value="typed-family"
        onChange={() => {}}
      />,
    );

    const input = screen.getByRole("textbox", { name: "Model family" });
    expect(input.getAttribute("id")).toBe("family-id");
    expect(input.getAttribute("aria-describedby")).toBe("family-help");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(input.getAttribute("list")).toBeNull();
    expect(document.querySelector("datalist")).toBeNull();
  });
});
