import { createContext, use, useState, type ReactNode } from "react";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type { BrowserAnnotationRecord } from "@traycer/protocol/persistence/epic/messages";
import type {
  DraftAuthorityActor,
  DraftAuthorityExpectation,
} from "@/lib/drafts/draft-authority-types";

export interface BrowserSandboxCancelSnapshot {
  readonly returnId: string;
  readonly generation: number;
  readonly expectedChat: DraftAuthorityExpectation;
  readonly content: JsonContent;
  readonly browserAnnotations: readonly BrowserAnnotationRecord[];
  readonly bytes: ReadonlyMap<string, Blob>;
}

export interface BrowserSandboxCancelInstallation {
  readonly expectedChat: DraftAuthorityExpectation;
  readonly isCurrent: () => boolean;
  readonly finish: (outcome: "installed" | "fallback") => Promise<number | null>;
}

export interface BrowserSandboxCancelPress {
  readonly isCurrent: () => boolean;
  readonly install: (snapshot: BrowserSandboxCancelSnapshot) =>
    Promise<BrowserSandboxCancelInstallation | null>;
}

export type BrowserSandboxCancelComposer = (input: {
  readonly actor: DraftAuthorityActor;
  readonly sendId: string;
  readonly chatId: string;
  readonly hostId: string;
}) => BrowserSandboxCancelPress | null;

interface BrowserSandboxCancelScope {
  readonly capture: BrowserSandboxCancelComposer;
  readonly bind: (composer: BrowserSandboxCancelComposer) => () => void;
}

const ScopeContext = createContext<BrowserSandboxCancelScope | null>(null);

export function BrowserSandboxCancelScopeProvider(props: { readonly children: ReactNode }) {
  const [scope] = useState<BrowserSandboxCancelScope>(() => {
    let current: BrowserSandboxCancelComposer | null = null;
    return {
      capture: (input) => current?.(input) ?? null,
      bind: (composer) => {
        current = composer;
        return () => {
          if (current === composer) current = null;
        };
      },
    };
  });
  return <ScopeContext.Provider value={scope}>{props.children}</ScopeContext.Provider>;
}

export function useBrowserSandboxCancelComposer(): BrowserSandboxCancelComposer | null {
  return use(ScopeContext)?.capture ?? null;
}

export function useBrowserSandboxCancelComposerBinding() {
  return use(ScopeContext)?.bind ?? null;
}
