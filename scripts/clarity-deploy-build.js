const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const dist = path.join(root, "dist");
const HOTFIX_SCRIPT = "scripts/clarity-auth-setup-hotfix.js";
const HOTFIX_TAG = '<script src="scripts/clarity-auth-setup-hotfix.js?v=20260706-login-hotfix" defer></script>';

const publicPaths = [
  "index.html",
  "assets",
  "scripts",
  "styles"
];

function copyEntry(relativePath) {
  const source = path.join(root, relativePath);
  const target = path.join(dist, relativePath);
  const deployHelper = path.join(root, "scripts", "clarity-deploy-build.js");
  if (!fs.existsSync(source)) {
    console.warn("Skipping missing optional deploy asset: " + relativePath);
    return;
  }
  fs.cpSync(source, target, {
    recursive: true,
    force: true,
    filter: function (entry) {
      return !entry.includes(path.sep + ".DS_Store") && entry !== deployHelper;
    }
  });
}

function injectAuthHotfix() {
  const indexPath = path.join(dist, "index.html");
  const hotfixPath = path.join(dist, HOTFIX_SCRIPT);
  if (!fs.existsSync(indexPath) || !fs.existsSync(hotfixPath)) return;
  let html = fs.readFileSync(indexPath, "utf8");
  if (html.includes("clarity-auth-setup-hotfix.js")) return;
  if (html.includes("</body>")) {
    html = html.replace("</body>", "  " + HOTFIX_TAG + "\n</body>");
  } else {
    html += "\n" + HOTFIX_TAG + "\n";
  }
  fs.writeFileSync(indexPath, html);
}

fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist, { recursive: true });
publicPaths.forEach(copyEntry);
injectAuthHotfix();

console.log("Prepared Netlify deploy output: " + path.relative(root, dist));
console.log("Clarity Caddie app restored at site root: /");
console.log("Public entries: " + publicPaths.filter(function (entry) { return fs.existsSync(path.join(root, entry)); }).join(", "));
console.log("Auth setup hotfix injected: " + fs.existsSync(path.join(dist, HOTFIX_SCRIPT)));
