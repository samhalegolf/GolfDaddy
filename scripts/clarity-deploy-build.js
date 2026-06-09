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

fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist, { recursive: true });
publicPaths.forEach(copyEntry);

console.log(`Prepared Netlify deploy output: ${path.relative(root, dist)}`);
console.log(`Public entries: ${publicPaths.join(", ")}`);
