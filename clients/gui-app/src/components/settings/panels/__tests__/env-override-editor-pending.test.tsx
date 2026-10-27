import { useEffect, useState, type ReactNode } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { EnvOverrideEditor } from "../env-override-editor";

/**
 * The editor stays mounted while a write travels to the host and until the
 * read that follows shows it: the person's Add and Remove must stay
 * represented the whole time, never as "No variables" or as the old value,
 * and a refused write keeps the draft to correct. The parent owns the
 * mutation (`onCommit` and `onDelete` return the write's promise) and the
 * rows it passes back; here the "host" is a test-held write and a test-held
 * read, so each gap is something the test opens and closes.
 */

const EMPTY_LABEL = "No environment variables.";

interface Write {
  readonly settle: (outcome: "ok" | "refused") => Promise<void>;
}

interface Row {
  readonly key: string;
  readonly value: string | null;
}

/** A parent that hands the editor the rows a test says the host has read. */
function Parent(props: {
  readonly initial: readonly Row[];
  readonly onWrite: (write: Write) => void;
  readonly onRows: (setRows: (rows: readonly Row[]) => void) => void;
}): ReactNode {
  const [rows, setRows] = useState<readonly Row[]>(props.initial);
  const { onRows } = props;
  useEffect(() => {
    onRows(setRows);
  }, [onRows]);
  const start = (): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      props.onWrite({
        settle: async (outcome) => {
          await act(async () => {
            if (outcome === "ok") resolve();
            else reject(new Error("The host refused this change."));
            await Promise.resolve();
          });
        },
      });
    });
  return (
    <EnvOverrideEditor
      overrides={rows}
      disabled={false}
      credentialRefusal={null}
      rowNotes={new Map()}
      claimedBy={new Map()}
      onHold={new Map()}
      keyRefusal={null}
      staleRefusal={null}
      namePlaceholder="OPENAI_API_KEY"
      emptyLabel={EMPTY_LABEL}
      onCommit={start}
      onDelete={start}
    />
  );
}

function mountEditor(initial: readonly Row[]) {
  const held: {
    write: Write | null;
    count: number;
    setRows: (rows: readonly Row[]) => void;
  } = { write: null, count: 0, setRows: () => undefined };
  render(
    <Parent
      initial={initial}
      onWrite={(write) => {
        held.count += 1;
        held.write = write;
      }}
      onRows={(setRows) => {
        held.setRows = setRows;
      }}
    />,
  );
  const settle = async (outcome: "ok" | "refused"): Promise<void> => {
    if (held.write === null) throw new Error("no write is in flight");
    await held.write.settle(outcome);
  };
  /** The read the host answers once it has applied the write. */
  const observe = async (rows: readonly Row[]): Promise<void> => {
    await act(async () => {
      held.setRows(rows);
      await Promise.resolve();
    });
  };
  return {
    settle,
    observe,
    held: { writes: () => held.count },
  };
}

function stageAdd(name: string, value: string): void {
  fireEvent.click(screen.getByRole("button", { name: "Add a variable" }));
  fireEvent.change(screen.getByLabelText("New variable name"), {
    target: { value: name },
  });
  fireEvent.change(screen.getByLabelText("New variable value"), {
    target: { value },
  });
  fireEvent.click(screen.getByRole("button", { name: "Apply variable" }));
}

function expectPendingDraft(): void {
  const name = screen.getByLabelText("New variable name");
  const value = screen.getByLabelText("New variable value");
  expect(name).toHaveProperty("value", "NEW_VAR");
  expect(name).toHaveProperty("disabled", true);
  expect(value).toHaveProperty("value", "one");
  expect(value).toHaveProperty("disabled", true);
  expect(screen.getByText(/NEW_VAR/)).toBeTruthy();
  expect(screen.getByText(/adding/i)).toBeTruthy();
  expect(screen.queryByText(EMPTY_LABEL)).toBeNull();
}

afterEach(() => {
  cleanup();
});

describe("EnvOverrideEditor left mounted across a write", () => {
  it("keeps an added variable's draft, disabled, as Adding from Apply until the read lists it, never as an empty table", async () => {
    const { settle, observe } = mountEditor([]);

    stageAdd("NEW_VAR", "one");

    // The write is in flight: the draft stays, disabled and unchanged, so a
    // refusal can hand back exactly what was typed.
    expectPendingDraft();

    // The write was accepted but the read has not caught up yet.
    await settle("ok");
    expectPendingDraft();

    // The read lists it: the draft closes and an ordinary editable row
    // replaces it.
    await observe([{ key: "NEW_VAR", value: "one" }]);
    expect(screen.queryByLabelText("New variable name")).toBeNull();
    expect(screen.getByLabelText("Value for NEW_VAR")).toBeTruthy();
    expect(screen.queryByText(/adding/i)).toBeNull();
    expect(screen.queryByText(EMPTY_LABEL)).toBeNull();
  });

  it("shows a removed variable as Removing from Remove until the read drops it, not as a value still Set", async () => {
    const { settle, observe, held } = mountEditor([
      { key: "OLD_VAR", value: "token" },
    ]);

    fireEvent.click(screen.getByRole("button", { name: "Remove OLD_VAR" }));

    // The real row stays, with its Remove disabled: a second press cannot
    // send the delete again.
    expect(screen.getByText(/removing/i)).toBeTruthy();
    const pendingRemove = screen.getByRole("button", {
      name: "Remove OLD_VAR",
    });
    expect(pendingRemove).toHaveProperty("disabled", true);
    fireEvent.click(pendingRemove);
    expect(held.writes()).toBe(1);

    // Accepted, but the read still lists it: still Removing, still disabled.
    await settle("ok");
    expect(screen.getByText(/removing/i)).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Remove OLD_VAR" }),
    ).toHaveProperty("disabled", true);
    expect(held.writes()).toBe(1);

    await observe([]);
    expect(screen.queryByText(/OLD_VAR/)).toBeNull();
    expect(screen.queryByText(/removing/i)).toBeNull();
    expect(screen.getByText(EMPTY_LABEL)).toBeTruthy();
  });

  it("puts a refused Add back as an editable draft with the refusal, nothing pending", async () => {
    const { settle } = mountEditor([]);

    stageAdd("NEW_VAR", "one");
    await settle("refused");

    const name = screen.getByLabelText("New variable name");
    expect(name).toHaveProperty("value", "NEW_VAR");
    expect(screen.getByLabelText("New variable value")).toHaveProperty(
      "value",
      "one",
    );
    expect(screen.getByRole("alert").textContent).toContain(
      "The host refused this change.",
    );
    expect(screen.queryByText(/adding/i)).toBeNull();
    // The draft can be corrected and sent again.
    fireEvent.change(name, { target: { value: "OTHER_VAR" } });
    expect(
      screen.getByRole("button", { name: "Apply variable" }),
    ).toHaveProperty("disabled", false);
  });

  it("puts a refused Remove back as the row it was, with the refusal", async () => {
    const { settle } = mountEditor([{ key: "OLD_VAR", value: "token" }]);

    fireEvent.click(screen.getByRole("button", { name: "Remove OLD_VAR" }));
    await settle("refused");

    expect(screen.getByLabelText("Value for OLD_VAR")).toHaveProperty(
      "value",
      "token",
    );
    expect(screen.getByRole("button", { name: "Remove OLD_VAR" })).toBeTruthy();
    expect(screen.queryByText(/removing/i)).toBeNull();
    expect(screen.getByRole("alert").textContent).toContain(
      "The host refused this change.",
    );
  });
});
