const fs = require("fs");
const path = require("path");
const landing = require("./clarity-landing-build2");

const root = path.resolve(__dirname, "..");
const dist = path.join(root, "dist");

const publicPaths = [
  "assets",
  "scripts",
  "styles"
];

function copyEntry(relativePath) {
  const source = path.join(root, relativePath);
  const target = path.join(dist, relativePath);
  const deployHelper = path.join(root, "scripts", "clarity-deploy-build.js");
  if (!fs.existsSync(source)) {
    console.warn(`Skipping missing optional deploy asset: ${relativePath}`);
    return;
  }
  fs.cpSync(source, target, {
    recursive: true,
    force: true,
    filter: (entry) => !entry.includes(`${path.sep}.DS_Store`) && entry !== deployHelper
  });
}

function ensureDir(relativePath) {
  fs.mkdirSync(path.join(dist, relativePath), { recursive: true });
}

function writeLandingEntry() {
  const content = landing.loadLandingContent(root);
  fs.writeFileSync(path.join(dist, "index.html"), landing.renderLandingPage(content), "utf8");
}

function writeAppEntry() {
  ensureDir("app");
  fs.copyFileSync(path.join(root, "index.html"), path.join(dist, "app", "index.html"));
}

function writeRedirects() {
  fs.writeFileSync(
    path.join(dist, "_redirects"),
    [
      "/app/* /app/index.html 200",
      "/login /app/index.html 200",
      "/signup /app/index.html 200"
    ].join("\n") + "\n",
    "utf8"
  );
}

fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist, { recursive: true });
publicPaths.forEach(copyEntry);
writeAppEntry();
writeLandingEntry();
writeRedirects();

console.log(`Prepared Netlify deploy output: ${path.relative(root, dist)}`);
console.log("Public Clarity Golf landing page: /");
console.log("Clarity Caddie app: /app");
console.log(`Public entries: ${publicPaths.filter((entry) => fs.existsSync(path.join(root, entry))).join(", ")}`);
