import { useSyncExternalStore } from "react";

function readDocumentTheme(): "light" | "dark" {
  if (typeof document === "undefined") return "light";
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

function subscribeToDocumentTheme(onStoreChange: () => void): () => void {
  if (typeof document === "undefined") return () => undefined;
  const observer = new MutationObserver(onStoreChange);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class"],
  });
  return () => observer.disconnect();
}

function readServerDocumentTheme(): "light" {
  return "light";
}

export function useCodeMirrorTheme(): "light" | "dark" {
  return useSyncExternalStore(
    subscribeToDocumentTheme,
    readDocumentTheme,
    readServerDocumentTheme,
  );
}
