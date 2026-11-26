import type { ReactNode } from "react";
import type { EnvironmentOwnSlot } from "@traycer/protocol/host/environment-schemas";
import { Button } from "@/components/ui/button";

export type OwnSlotAddress = Pick<EnvironmentOwnSlot, "kind" | "key" | "os">;

interface OwnSlotRowNoteTextBaseProps {
  readonly entry: EnvironmentOwnSlot;
  readonly hostName: string;
  readonly valueDescription: string | null;
  readonly disabled: boolean;
  readonly onChange: (
    address: OwnSlotAddress,
    action: "publish" | "usePersonal",
  ) => void | Promise<unknown>;
}

export type OwnSlotRowNoteTextProps = OwnSlotRowNoteTextBaseProps &
  (
    | {
        readonly copy: {
          readonly publishable: boolean;
          readonly sourceSelector: string;
        };
        readonly onCopyChange: (
          address: OwnSlotAddress,
          sourceSelector: string,
        ) => void | Promise<unknown>;
      }
    | { readonly copy?: never; readonly onCopyChange?: never }
  );

export function OwnSlotRowNoteText(props: OwnSlotRowNoteTextProps): ReactNode {
  const { entry } = props;
  const addressIsAbsent = entry.state === "absent";
  if (!addressIsAbsent && props.valueDescription === null) return null;
  const valueDescription = props.valueDescription;
  const canPublish = props.copy?.publishable ?? entry.publishable;
  const address: OwnSlotAddress = {
    kind: entry.kind,
    key: entry.key,
    os: entry.os,
  };

  return (
    <span data-testid="own-slot-row-note">
      {addressIsAbsent ? (
        <>
          Not set on {props.hostName} ·{" "}
          <Button
            type="button"
            variant="link"
            size="inline-xs"
            disabled={props.disabled}
            onClick={() => {
              void props.onChange(address, "usePersonal");
            }}
          >
            Use Personal&apos;s
          </Button>
        </>
      ) : (
        <>
          {props.hostName} uses: {valueDescription}
          {canPublish ? (
            <>
              {" · "}
              <Button
                type="button"
                variant="link"
                size="inline-xs"
                disabled={props.disabled}
                onClick={() => {
                  void (props.copy === undefined
                    ? props.onChange(address, "publish")
                    : props.onCopyChange(address, props.copy.sourceSelector));
                }}
              >
                Use everywhere
              </Button>
            </>
          ) : null}
        </>
      )}
    </span>
  );
}
