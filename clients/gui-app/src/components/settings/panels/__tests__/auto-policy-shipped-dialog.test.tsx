import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AutoPolicyShippedDialog } from "@/components/settings/panels/auto-policy-shipped-dialog";
import { parseShippedAutoPolicy } from "@/components/settings/panels/auto-policy-shipped-document";

afterEach(() => {
  cleanup();
});

// An inline fixture with all three tiers, parsed the same way the settings
// section parses the host's real `shippedDefaults`.
const FULL_DOCUMENT = `## Allow exceptions

- Read any file already in the workspace.

## Soft block

- Delete a file outside the workspace.

## Hard block (non-overridable)

- Force-push to a shared branch.
`;

describe("<AutoPolicyShippedDialog />", () => {
  it("renders the three user-facing tier labels and the out-of-scope note, in the user's own words", () => {
    render(
      <AutoPolicyShippedDialog
        sections={parseShippedAutoPolicy(FULL_DOCUMENT)}
        onEditPolicy={null}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText("Allowed without asking")).toBeTruthy();
    expect(screen.getByText("Always asks you")).toBeTruthy();
    expect(
      screen.getByText("Always asked, your policy can't turn these off"),
    ).toBeTruthy();
    expect(screen.getByText("Not the judge's job")).toBeTruthy();
    expect(
      screen.getByText(
        "The judge doesn't decide whether an action is relevant to what you asked for. Work that is off-track, unnecessary or not what you meant is for you to correct - it isn't blocked.",
      ),
    ).toBeTruthy();
    // The hard tier's note carries the promise the renamed label is only half
    // of: the user is ASKED, not refused, and their policy cannot stop the
    // asking. Losing this sentence would leave "your policy can't turn these
    // off" reading as a refusal.
    expect(
      screen.getByText(
        "You can still approve any of these on the card. Your policy can't stop Traycer asking.",
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "Unless you've asked for that exact thing in this conversation.",
      ),
    ).toBeTruthy();
  });

  it("renders a bullet from each section body under that section's own testid", async () => {
    render(
      <AutoPolicyShippedDialog
        sections={parseShippedAutoPolicy(FULL_DOCUMENT)}
        onEditPolicy={null}
        onClose={vi.fn()}
      />,
    );

    const allow = screen.getByTestId("auto-policy-shipped-allow");
    // The body is rendered through `TraycerMarkdown`, which resolves after the
    // initial render - `waitFor` around the first read is enough to settle it
    // for the rest of this test.
    await waitFor(() => {
      expect(
        within(allow).getByText(/Read any file already in the workspace\./),
      ).toBeTruthy();
    });

    const soft = screen.getByTestId("auto-policy-shipped-soft");
    expect(
      within(soft).getByText(/Delete a file outside the workspace\./),
    ).toBeTruthy();

    const hard = screen.getByTestId("auto-policy-shipped-hard");
    expect(
      within(hard).getByText(/Force-push to a shared branch\./),
    ).toBeTruthy();
  });

  it("never shows the document's own heading text, since the labels replace it", async () => {
    render(
      <AutoPolicyShippedDialog
        sections={parseShippedAutoPolicy(FULL_DOCUMENT)}
        onEditPolicy={null}
        onClose={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(
        within(screen.getByTestId("auto-policy-shipped-hard")).getByText(
          /Force-push to a shared branch\./,
        ),
      ).toBeTruthy();
    });

    expect(screen.queryByText("Hard block (non-overridable)")).toBeNull();
  });

  it("renders no section for a tier absent from the document", () => {
    const sections = parseShippedAutoPolicy(
      "## Allow exceptions\n\n- Only this tier exists.\n",
    );
    render(
      <AutoPolicyShippedDialog
        sections={sections}
        onEditPolicy={null}
        onClose={vi.fn()}
      />,
    );

    expect(screen.queryByTestId("auto-policy-shipped-soft")).toBeNull();
    expect(screen.queryByTestId("auto-policy-shipped-hard")).toBeNull();
  });

  it("disables Edit policy when onEditPolicy is null", () => {
    render(
      <AutoPolicyShippedDialog
        sections={parseShippedAutoPolicy(FULL_DOCUMENT)}
        onEditPolicy={null}
        onClose={vi.fn()}
      />,
    );

    const editButton = screen.getByTestId(
      "auto-policy-shipped-edit",
    ) as HTMLButtonElement;
    expect(editButton.disabled).toBe(true);
  });

  it("calls onEditPolicy when it is provided and the button is clicked", () => {
    const onEditPolicy = vi.fn();
    render(
      <AutoPolicyShippedDialog
        sections={parseShippedAutoPolicy(FULL_DOCUMENT)}
        onEditPolicy={onEditPolicy}
        onClose={vi.fn()}
      />,
    );

    const editButton = screen.getByTestId(
      "auto-policy-shipped-edit",
    ) as HTMLButtonElement;
    expect(editButton.disabled).toBe(false);
    fireEvent.click(editButton);
    expect(onEditPolicy).toHaveBeenCalledTimes(1);
  });
});
