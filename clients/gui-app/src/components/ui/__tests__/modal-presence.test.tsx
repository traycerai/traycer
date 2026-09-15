import { StrictMode, useState } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { QueryClient } from "@tanstack/react-query";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { hostRpcRegistry, type HostRpcRegistry } from "@traycer/protocol/host";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Drawer, DrawerContent, DrawerTitle } from "@/components/ui/drawer";
import {
  resetModalPresenceForTests,
  useModalPresenceStore,
} from "@/components/ui/modal-presence";
import { PortalConcealmentProvider } from "@/components/ui/portal-concealment-context";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from "@/components/ui/sheet";
import { SurfacePresentationBoundary } from "@/components/layout/surface-presentation-boundary";
import { useRemoteFolderPickerStore } from "@/stores/workspace/remote-folder-picker-store";

/**
 * `presentedModalCount` (onboarding contract 3) counts PRESENTED modal
 * content, not mounted roots: the spotlight tour suspends on it, so a root
 * that is open-but-unpresented (background split pane, concealed region,
 * force-mounted closed content) must read as zero and nested modals must not
 * hit zero until the last one un-presents.
 */
const count = (): number =>
  useModalPresenceStore.getState().presentedModalCount;

function ProbeDialog(props: {
  readonly open: boolean;
  readonly modal: boolean;
  readonly forceMount: boolean;
  readonly title: string;
}): React.JSX.Element {
  return (
    <Dialog open={props.open} modal={props.modal}>
      <DialogContent forceMount={props.forceMount ? true : undefined}>
        <DialogTitle>{props.title}</DialogTitle>
        <DialogDescription>probe</DialogDescription>
      </DialogContent>
    </Dialog>
  );
}

beforeEach(() => {
  resetModalPresenceForTests();
});

afterEach(() => {
  cleanup();
  resetModalPresenceForTests();
});

describe("presentedModalCount", () => {
  it("counts a controlled Dialog only while open", () => {
    const view = render(
      <ProbeDialog open modal forceMount={false} title="One" />,
    );
    expect(count()).toBe(1);
    view.rerender(
      <ProbeDialog open={false} modal forceMount={false} title="One" />,
    );
    expect(count()).toBe(0);
    view.unmount();
    expect(count()).toBe(0);
  });

  it("follows an UNCONTROLLED Dialog through its own open/close", () => {
    render(
      <Dialog defaultOpen>
        <DialogTrigger>open</DialogTrigger>
        <DialogContent showCloseButton>
          <DialogTitle>Uncontrolled</DialogTitle>
          <DialogDescription>probe</DialogDescription>
        </DialogContent>
      </Dialog>,
    );
    expect(count()).toBe(1);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(count()).toBe(0);
    fireEvent.click(screen.getByRole("button", { name: "open" }));
    expect(count()).toBe(1);
  });

  it("does not count a non-modal Dialog", () => {
    render(<ProbeDialog open modal={false} forceMount={false} title="NM" />);
    expect(screen.getByText("NM")).toBeTruthy();
    expect(count()).toBe(0);
  });

  it("does not count force-mounted CLOSED content, and does count it once open", () => {
    const view = render(
      <ProbeDialog open={false} modal forceMount title="Forced" />,
    );
    // The wrapper's portal is not force-mounted, so closed content stays out
    // of the DOM here; the registration's own `open || !forceMount` guard is
    // what covers a caller that force-mounts the portal too.
    expect(screen.queryByText("Forced")).toBeNull();
    expect(count()).toBe(0);
    view.rerender(<ProbeDialog open modal forceMount title="Forced" />);
    expect(count()).toBe(1);
  });

  it("does not count a Dialog whose region is concealed, and re-counts when it returns", () => {
    function Wrapped(props: { readonly concealed: boolean }) {
      return (
        <PortalConcealmentProvider value={props.concealed}>
          <ProbeDialog open modal forceMount={false} title="Concealed" />
        </PortalConcealmentProvider>
      );
    }
    const view = render(<Wrapped concealed />);
    expect(count()).toBe(0);
    view.rerender(<Wrapped concealed={false} />);
    expect(count()).toBe(1);
    view.rerender(<Wrapped concealed />);
    expect(count()).toBe(0);
  });

  it("does not count a Dialog retained in a background split pane", () => {
    render(
      <SurfacePresentationBoundary visible focused={false}>
        <ProbeDialog open modal forceMount={false} title="Background" />
      </SurfacePresentationBoundary>,
    );
    expect(count()).toBe(0);
  });

  it("keeps two simultaneous modals at two, and one until the last closes", () => {
    const view = render(
      <>
        <ProbeDialog open modal forceMount={false} title="Outer" />
        <ProbeDialog open modal forceMount={false} title="Inner" />
      </>,
    );
    expect(count()).toBe(2);
    view.rerender(
      <>
        <ProbeDialog open modal forceMount={false} title="Outer" />
        <ProbeDialog open={false} modal forceMount={false} title="Inner" />
      </>,
    );
    expect(count()).toBe(1);
    view.rerender(
      <>
        <ProbeDialog open={false} modal forceMount={false} title="Outer" />
        <ProbeDialog open={false} modal forceMount={false} title="Inner" />
      </>,
    );
    expect(count()).toBe(0);
  });

  it("balances StrictMode's double effect invocation", () => {
    const view = render(
      <StrictMode>
        <ProbeDialog open modal forceMount={false} title="Strict" />
      </StrictMode>,
    );
    expect(count()).toBe(1);
    view.unmount();
    expect(count()).toBe(0);
  });

  it("un-presents a Sheet and a Drawer in a background split pane: DOM absent AND count zero", () => {
    render(
      <SurfacePresentationBoundary visible focused={false}>
        <Sheet open>
          <SheetContent>
            <SheetTitle>Background sheet</SheetTitle>
            <SheetDescription>probe</SheetDescription>
          </SheetContent>
        </Sheet>
        <Drawer open>
          <DrawerContent>
            <DrawerTitle>Background drawer</DrawerTitle>
          </DrawerContent>
        </Drawer>
      </SurfacePresentationBoundary>,
    );
    expect(document.querySelector('[data-slot="sheet-content"]')).toBeNull();
    expect(document.querySelector('[data-slot="sheet-overlay"]')).toBeNull();
    expect(document.querySelector('[data-slot="drawer-content"]')).toBeNull();
    expect(document.querySelector('[data-slot="drawer-overlay"]')).toBeNull();
    expect(count()).toBe(0);
  });

  it("un-presents a Sheet and a Drawer in a concealed region, and re-presents (and re-counts) on return", () => {
    function Wrapped(props: { readonly concealed: boolean }) {
      return (
        <PortalConcealmentProvider value={props.concealed}>
          <Sheet open>
            <SheetContent>
              <SheetTitle>Concealed sheet</SheetTitle>
              <SheetDescription>probe</SheetDescription>
            </SheetContent>
          </Sheet>
          <Drawer open>
            <DrawerContent>
              <DrawerTitle>Concealed drawer</DrawerTitle>
            </DrawerContent>
          </Drawer>
        </PortalConcealmentProvider>
      );
    }
    const view = render(<Wrapped concealed />);
    expect(document.querySelector('[data-slot="sheet-content"]')).toBeNull();
    expect(document.querySelector('[data-slot="drawer-content"]')).toBeNull();
    expect(count()).toBe(0);
    view.rerender(<Wrapped concealed={false} />);
    expect(
      document.querySelector('[data-slot="sheet-content"]'),
    ).not.toBeNull();
    expect(
      document.querySelector('[data-slot="drawer-content"]'),
    ).not.toBeNull();
    expect(count()).toBe(2);
    view.rerender(<Wrapped concealed />);
    expect(count()).toBe(0);
  });

  it("counts a Sheet the same way", () => {
    function Probe(props: { readonly open: boolean }) {
      return (
        <Sheet open={props.open}>
          <SheetContent>
            <SheetTitle>Sheet</SheetTitle>
            <SheetDescription>probe</SheetDescription>
          </SheetContent>
        </Sheet>
      );
    }
    const view = render(<Probe open />);
    expect(count()).toBe(1);
    view.rerender(<Probe open={false} />);
    expect(count()).toBe(0);
  });

  it("counts a Drawer, including a close reported through onOpenChange", () => {
    function Probe() {
      const [open, setOpen] = useState(true);
      return (
        <>
          <button type="button" onClick={() => setOpen(false)}>
            dismiss
          </button>
          <Drawer open={open} onOpenChange={setOpen}>
            <DrawerContent>
              <DrawerTitle>Drawer</DrawerTitle>
            </DrawerContent>
          </Drawer>
        </>
      );
    }
    render(<Probe />);
    expect(count()).toBe(1);
    // `hidden`: the modal drawer aria-hides its siblings while presented.
    fireEvent.click(
      screen.getByRole("button", { name: "dismiss", hidden: true }),
    );
    expect(count()).toBe(0);
  });

  it("is not double-counted by the folder picker's own `open` flag, which flips before any Dialog mounts", () => {
    const client = new HostClient<HostRpcRegistry>({
      registry: hostRpcRegistry,
      invalidator: createHostQueryInvalidator(new QueryClient()),
      messenger: new MockHostMessenger<HostRpcRegistry>({
        registry: hostRpcRegistry,
        requestId: () => "request-1",
        handlers: {},
      }),
    });
    let pick: Promise<unknown> | null = null;
    act(() => {
      pick = useRemoteFolderPickerStore.getState().requestPick(client);
    });
    // The pre-mount gap the controller bridges separately: the store is open
    // and nothing is presented yet.
    expect(useRemoteFolderPickerStore.getState().open).toBe(true);
    expect(count()).toBe(0);
    act(() => {
      useRemoteFolderPickerStore.getState().settle(null);
    });
    expect(useRemoteFolderPickerStore.getState().open).toBe(false);
    expect(pick).not.toBeNull();
  });
});
