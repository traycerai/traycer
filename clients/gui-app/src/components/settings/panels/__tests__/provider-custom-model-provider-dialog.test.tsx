import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderCustomModelProviderDialog } from "@/components/settings/panels/provider-custom-model-provider-dialog";
import type { CustomProviderValues } from "@/components/settings/panels/model-provider-custom-draft";

function renderDialog(args: {
  readonly initial: CustomProviderValues | null;
  readonly takenIds: readonly string[];
  readonly onSubmit: (values: CustomProviderValues) => void;
  readonly submitError: string | null;
}) {
  return render(
    <ProviderCustomModelProviderDialog
      open
      onOpenChange={() => {}}
      providerLabel="OpenCode"
      takenIds={args.takenIds}
      initial={args.initial}
      isPending={false}
      submitError={args.submitError}
      onSubmit={args.onSubmit}
    />,
  );
}

function type(label: string, value: string): void {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

afterEach(() => {
  cleanup();
});

describe("custom model provider dialog", () => {
  it("sends the wire shape once every field is valid", () => {
    const onSubmit = vi.fn();
    renderDialog({
      initial: null,
      takenIds: [],
      onSubmit,
      submitError: null,
    });
    type("Name", "My gateway");
    type("Base URL", "https://api.example.test/v1");
    type("Model ids", "gpt-4o-mini\nllama-3.1-70b");
    fireEvent.click(screen.getByRole("button", { name: "Add provider" }));
    expect(onSubmit).toHaveBeenCalledWith({
      // The id came from the NAME - the common case never has to think about
      // the second field.
      modelProviderId: "my-gateway",
      name: "My gateway",
      baseUrl: "https://api.example.test/v1",
      modelIds: ["gpt-4o-mini", "llama-3.1-70b"],
    });
  });

  it("stops deriving the id once the user has touched it", () => {
    const onSubmit = vi.fn();
    renderDialog({
      initial: null,
      takenIds: [],
      onSubmit,
      submitError: null,
    });
    type("Name", "My gateway");
    type("Id", "eu-gw");
    // Re-deriving here would silently overwrite what they typed on the next
    // keystroke.
    type("Name", "My gateway v2");
    type("Base URL", "https://api.example.test/v1");
    type("Model ids", "a");
    fireEvent.click(screen.getByRole("button", { name: "Add provider" }));
    expect(onSubmit.mock.calls[0]?.[0]).toMatchObject({
      modelProviderId: "eu-gw",
      name: "My gateway v2",
    });
  });

  it("keeps submit dead until the draft would survive the wire", () => {
    const onSubmit = vi.fn();
    renderDialog({
      initial: null,
      takenIds: [],
      onSubmit,
      submitError: null,
    });
    const submit = screen.getByRole("button", { name: "Add provider" });
    expect(submit.hasAttribute("disabled")).toBe(true);
    type("Name", "My gateway");
    type("Base URL", "api.example.test/v1");
    type("Model ids", "a");
    // Still dead: `baseUrl` is `z.url()` on the wire, and a scheme-less host
    // fails it.
    expect(submit.hasAttribute("disabled")).toBe(true);
    type("Base URL", "https://api.example.test/v1");
    expect(submit.hasAttribute("disabled")).toBe(false);
  });

  it("explains a bad field where it was typed, not on submit", () => {
    // The button is disabled while invalid, so an error that waited for a
    // submit attempt would never arrive - the user would be left with a dead
    // button and no reason.
    renderDialog({
      initial: null,
      takenIds: [],
      onSubmit: vi.fn(),
      submitError: null,
    });
    expect(
      screen.queryByText("Enter a full URL, including https://."),
    ).toBeNull();
    type("Base URL", "nope");
    expect(
      screen.getByText("Enter a full URL, including https://."),
    ).toBeTruthy();
  });

  it("refuses an id that would shadow an existing provider", () => {
    renderDialog({
      initial: null,
      takenIds: ["openai"],
      onSubmit: vi.fn(),
      submitError: null,
    });
    type("Name", "OpenAI");
    expect(
      screen.getByText("A provider with this id already exists."),
    ).toBeTruthy();
  });

  it("edits an existing declaration without letting its key move", () => {
    const onSubmit = vi.fn();
    renderDialog({
      initial: {
        modelProviderId: "my-gateway",
        name: "My gateway",
        baseUrl: "https://api.example.test/v1",
        modelIds: ["a", "b"],
      },
      // Its OWN id is in the catalog and must not read as taken.
      takenIds: ["my-gateway", "openai"],
      onSubmit,
      submitError: null,
    });
    expect(screen.getByLabelText("Model ids").textContent).toBe("a\nb");
    // A rename would be a delete and a create wearing one button: the id is the
    // config key every stored model reference is built from.
    expect(screen.getByLabelText("Id").hasAttribute("disabled")).toBe(true);
    type("Name", "My gateway v2");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onSubmit).toHaveBeenCalledWith({
      modelProviderId: "my-gateway",
      name: "My gateway v2",
      baseUrl: "https://api.example.test/v1",
      modelIds: ["a", "b"],
    });
  });

  it("keeps the form open and shows what the host rejected", () => {
    renderDialog({
      initial: null,
      takenIds: [],
      onSubmit: vi.fn(),
      submitError: "That base URL isn't reachable.",
    });
    expect(screen.getByRole("alert").textContent).toBe(
      "That base URL isn't reachable.",
    );
    // Everything typed is still on screen to fix in place.
    expect(screen.getByLabelText("Base URL")).toBeTruthy();
  });
});
