// CI entry point; full pixel comparison additionally needs the artifact baseline.
process.argv.push("--behavior");
await import("./primitive-gate-browser.mjs");
