const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const dist = path.join(root, "dist");

const publicPaths = [
  "index.html",
  "assets",
  "scripts",
  "styles"
];

const greenFocusShotEndGuard = '<script src="scripts/gd-green-focus-shot-end-guard.js?v=20260615-pointer-native-advance"></script>';

function copyEntry(relativePath) {
  const source = path.join(root, relativePath);
  const target = path.join(dist, relativePath);
  const deployHelper = path.join(root, "scripts", "clarity-deploy-build.js");
  if (!fs.existsSync(source)) {
    throw new Error(`Missing deploy asset: ${relativePath}`);
  }
  fs.cpSync(source, target, {
    recursive: true,
    force: true,
    filter: (entry) => !entry.includes(`${path.sep}.DS_Store`) && entry !== deployHelper
  });
}

function injectGreenFocusShotEndGuard() {
  const indexPath = path.join(dist, "index.html");
  let html = fs.readFileSync(indexPath, "utf8");
  if (html.includes("gd-green-focus-shot-end-guard.js")) {
    html = html.replace(/<script src="scripts\/gd-green-focus-shot-end-guard\.js\?v=[^"]+"><\/script>/g, greenFocusShotEndGuard);
    fs.writeFileSync(indexPath, html);
    return;
  }
  if (/<\/body>\s*<\/html>\s*$/i.test(html)) {
    html = html.replace(/<\/body>\s*<\/html>\s*$/i, `${greenFocusShotEndGuard}\n</body>\n</html>\n`);
  } else if (/<\/body>/i.test(html)) {
    html = html.replace(/<\/body>/i, `${greenFocusShotEndGuard}\n</body>`);
  } else {
    html += `\n${greenFocusShotEndGuard}\n`;
  }
  fs.writeFileSync(indexPath, html);
}

fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist, { recursive: true });
publicPaths.forEach(copyEntry);
injectGreenFocusShotEndGuard();

console.log(`Prepared Netlify deploy output: ${path.relative(root, dist)}`);
console.log(`Public entries: ${publicPaths.join(", ")}`);
console.log("Injected Green Focus shot-end guard");
