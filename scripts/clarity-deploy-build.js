const fs = require("fs");
const crypto = require("crypto");
const path = require("path");

const root = path.resolve(__dirname, "..");
const dist = path.join(root, "dist");

const publicPaths = [
  "index.html",
  "assets",
  "scripts",
  "styles",
  "demo",
  // Deep-link verification files. Android reads assetlinks.json and iOS reads
  // apple-app-site-association from this path over https; if they are not
  // deployed, links open the browser instead of the app and the failure is
  // silent - the OS simply does not verify and falls back.
  ".well-known"
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

fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist, { recursive: true });
publicPaths.forEach(copyEntry);

/* Stamp every script/style ?v= in the deployed index.html with a hash of that
   file's CONTENT.
 *
 * The manual ?v= strings in index.html are load-bearing cache keys: a browser
 * caches a script under its ?v=, so editing a script without bumping its ?v=
 * leaves returning users on the old cached copy - a mismatched build where new
 * index.html loads stale modules. That silently broke the course picker and
 * Supabase for returning users after a day of edits with unbumped versions.
 *
 * Content-hashing removes the manual step entirely: a file that changed gets a
 * new ?v= automatically, an unchanged file keeps its cache. This runs on the
 * COPY in dist, so the source index.html keeps its human-readable version
 * labels. */
stampContentVersions();

function stampContentVersions() {
  const indexPath = path.join(dist, "index.html");
  if (!fs.existsSync(indexPath)) return;
  let html = fs.readFileSync(indexPath, "utf8");
  let stamped = 0;
  /* Match src/href="scripts/...js?v=..." or styles/...css?v=... */
  html = html.replace(/((?:src|href)=")((?:scripts|styles)\/[^"?]+\.(?:js|css))\?v=[^"]*(")/g,
    function (whole, pre, assetPath, post) {
      const assetFile = path.join(dist, assetPath);
      if (!fs.existsSync(assetFile)) return whole; // leave unknown paths untouched
      const hash = crypto.createHash("sha1").update(fs.readFileSync(assetFile)).digest("hex").slice(0, 10);
      stamped += 1;
      return pre + assetPath + "?v=" + hash + post;
    });
  fs.writeFileSync(indexPath, html);
  console.log("Stamped content-hash cache versions on " + stamped + " assets");
}

console.log("Prepared Netlify deploy output: " + path.relative(root, dist));
console.log("Clarity Caddy app restored at site root: /");
console.log("Public entries: " + publicPaths.filter(function (entry) { return fs.existsSync(path.join(root, entry)); }).join(", "));
