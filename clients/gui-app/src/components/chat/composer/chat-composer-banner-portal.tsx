import { createContext, useContext, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

const ChatComposerBannerPortalContext = createContext<HTMLDivElement | null>(
  null,
);

export function ChatComposerBannerPortalProvider({
  hidden,
  children,
}: {
  /** Out of the layout, still mounted, so a banner keeps its state. */
  readonly hidden: boolean;
  readonly children: ReactNode;
}): ReactNode {
  const [container, setContainer] = useState<HTMLDivElement | null>(null);

  return (
    <>
      <div
        ref={setContainer}
        hidden={hidden}
        data-testid="chat-composer-banner-host"
      />
      <ChatComposerBannerPortalContext.Provider value={container}>
        {children}
      </ChatComposerBannerPortalContext.Provider>
    </>
  );
}

export function ChatComposerBannerPortal({
  children,
}: {
  readonly children: ReactNode;
}): ReactNode {
  const container = useContext(ChatComposerBannerPortalContext);
  if (container === null) return null;
  return createPortal(children, container);
}
