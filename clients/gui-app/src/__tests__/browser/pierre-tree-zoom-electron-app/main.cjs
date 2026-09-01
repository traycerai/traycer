const { app, BrowserWindow } = require("electron");

const pageUrl = process.argv.at(-1);
if (pageUrl === undefined || !pageUrl.startsWith("http")) {
  throw new Error("The Pierre tree Electron fixture requires a page URL");
}

(async () => {
  await app.whenReady();
  const window = new BrowserWindow({
    show: false,
    width: 1000,
    height: 800,
    webPreferences: {
      sandbox: true,
    },
  });
  await window.loadURL(pageUrl);

  let input = "";
  let pending = Promise.resolve();
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    input += chunk;
    const lines = input.split("\n");
    input = lines.pop() ?? "";
    for (const line of lines) {
      if (line === "") continue;
      pending = pending.then(async () => {
        const command = JSON.parse(line);
        if (command.quit === true) {
          app.quit();
          return;
        }
        if (
          typeof command.id !== "string" ||
          typeof command.zoom !== "number"
        ) {
          throw new Error(`Invalid zoom command: ${line}`);
        }
        window.webContents.setZoomFactor(command.zoom);
        await window.webContents.executeJavaScript(
          "new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
        );
        process.stdout.write(
          `${JSON.stringify({
            id: command.id,
            zoom: window.webContents.getZoomFactor(),
          })}\n`,
        );
      });
    }
  });
})().catch((error) => {
  console.error(error);
  app.exit(1);
});
