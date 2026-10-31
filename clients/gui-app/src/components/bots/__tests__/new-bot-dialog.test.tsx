/**
 * The create form for one more bot in the person's own section,
 * behind its + in the channel sidebar: titled New bot, with the create
 * form for the environment it was opened for. Dismissed (Escape, Close, the
 * form's Cancel) it gives focus back to the control that opened it; a bot
 * created closes it and leaves focus to the destination. The real dialog runs
 * over a stub create form, in a harness that opens it as the sidebar does:
 * the opener is the control that was clicked.
 */
import { useState, type ReactNode } from "react";
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent, { type UserEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostEnvironmentBindings } from "@/hooks/bots/use-host-environment-bindings-query";
import {
  NewBotDialog,
  type NewBotTarget,
} from "@/components/bots/new-bot-dialog";

vi.mock("@/components/home/bots/create-bot-form", () => ({
  CreateBotForm: (props: {
    environmentId: string;
    environmentLabel: string;
    onCreated: () => void;
    onCancel: () => void;
  }) => (
    <div
      data-testid="stub-create-bot-form"
      data-environment-id={props.environmentId}
      data-environment-label={props.environmentLabel}
    >
      <button type="button" onClick={props.onCancel}>
        Cancel
      </button>
      <button type="button" onClick={props.onCreated}>
        Create bot
      </button>
    </div>
  ),
}));

const BINDINGS: HostEnvironmentBindings = {
  byHostId: new Map(),
  failedHostIds: [],
  retryFailed: () => undefined,
};

function Harness(): ReactNode {
  const [target, setTarget] = useState<NewBotTarget | null>(null);
  return (
    <>
      <button
        type="button"
        onClick={(event) =>
          setTarget({
            environmentId: "env-me",
            environmentLabel: "Personal",
            opener: event.currentTarget,
          })
        }
      >
        New bot in Personal
      </button>
      <NewBotDialog
        target={target}
        connectableHostIds={[]}
        environmentBindings={BINDINGS}
        onClose={() => setTarget(null)}
      />
    </>
  );
}

function mount(): HTMLElement {
  render(<Harness />);
  return screen.getByRole("button", { name: "New bot in Personal" });
}

afterEach(() => {
  cleanup();
});

describe("<NewBotDialog />", () => {
  it("opens titled New bot over the create form for the environment it was opened for", async () => {
    const user = userEvent.setup();
    const opener = mount();
    expect(screen.queryByTestId("new-bot-dialog")).toBeNull();

    await user.click(opener);

    const dialog = screen.getByTestId("new-bot-dialog");
    expect(within(dialog).getByText("New bot")).toBeTruthy();
    const form = within(dialog).getByTestId("stub-create-bot-form");
    expect(form.getAttribute("data-environment-id")).toBe("env-me");
    expect(form.getAttribute("data-environment-label")).toBe("Personal");
  });

  it.each([
    {
      label: "Escape",
      dismiss: (user: UserEvent) => user.keyboard("{Escape}"),
    },
    {
      label: "the Close button",
      dismiss: (user: UserEvent) =>
        user.click(screen.getByRole("button", { name: "Close" })),
    },
    {
      label: "the form's Cancel",
      dismiss: (user: UserEvent) =>
        user.click(screen.getByRole("button", { name: "Cancel" })),
    },
  ])(
    "gives focus back to the control that opened it on $label",
    async ({ dismiss }) => {
      const user = userEvent.setup();
      const opener = mount();
      await user.click(opener);
      await screen.findByTestId("new-bot-dialog");

      await dismiss(user);

      await waitFor(() => {
        expect(screen.queryByTestId("new-bot-dialog")).toBeNull();
      });
      await waitFor(() => {
        expect(document.activeElement).toBe(opener);
      });
    },
  );

  it("leaves focus off the opener when the form creates the bot and closes", async () => {
    const user = userEvent.setup();
    const opener = mount();
    await user.click(opener);
    const focus = vi.spyOn(opener, "focus");

    await user.click(await screen.findByRole("button", { name: "Create bot" }));

    await waitFor(() => {
      expect(screen.queryByTestId("new-bot-dialog")).toBeNull();
    });
    // The dialog hands focus back one task after it unmounts: run past that.
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
    expect(focus).not.toHaveBeenCalled();
    expect(document.activeElement).not.toBe(opener);
  });
});
