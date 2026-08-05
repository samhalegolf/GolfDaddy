const fs = require("fs");
const crypto = require("crypto");
const path = require("path");

const root = path.resolve(__dirname, "..");
const dist = path.join(root, "dist");

/* Two surfaces are built from ONE source index.html.
 *
 * The source is the STUDIO superset: it contains every panel and every script,
 * including the admin-only ones (course database, visual-engine tuning, mapping
 * debug). Anything that belongs only to the browser studio is marked in the
 * source with data-gd-surface="studio".
 *
 * - app    -> dist/index.html          studio-marked elements REMOVED
 * - studio -> dist/studio/index.html   everything, with <base href="/"> so its
 *                                      relative asset paths still resolve to the
 *                                      shared /scripts and /styles at site root
 *
 * The phone build is the app surface. Keeping admin code out of it is the whole
 * point: on a Capacitor install every byte in index.html's load order is parsed
 * at boot on the phone, so an admin panel Sam only ever opens on a laptop is
 * pure cost - boot time, memory, and surface area for a boot crash that takes
 * the round down mid-play.
 *
 * --app-only skips the studio output AND deletes the studio-only files from
 * dist. That is the mode `npm run native:sync` uses, because `npx cap sync`
 * copies all of dist into the native project - an unreferenced 250KB module
 * still ships inside the APK/IPA. On Netlify the files stay, since the studio
 * needs them and a CDN does not care. */
const APP_ONLY = process.argv.includes("--app-only");
const SURFACE_ATTR = "data-gd-surface";
const STUDIO = "studio";
const APP = "app";
/* Tags with no closing tag - a studio-marked one is removed on its own. */
const VOID_TAGS = { link: 1, meta: 1, img: 1, input: 1, br: 1, hr: 1, source: 1 };

const publicPaths = [
  "index.html",
  "assets",
  "scripts",
  "styles",
  "demo",
  // The fresh consumer-only surface (see app/README.md), served at /app/ while
  // it is built out alongside the current app. It reuses /assets and /scripts
  // at the site root, so copying the directory verbatim is enough.
  "app",
  // Legal pages, served at the site root. These are the URLs given to Apple and
  // Google in the store listings, and Play fetches the privacy policy during
  // review - a 404 there fails the submission. They shipped only under /assets
  // until 2026-07-27, so https://caddy.claritygolf.app/privacy.html did not
  // resolve at all. The /assets copies are now redirect stubs pointing here, so
  // there is one canonical source and older links keep working.
  "privacy.html",
  "terms.html",
  "support.html",
  // Play Console requires a web-accessible account deletion URL for any app
  // that allows account creation.
  "delete-account.html",
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

/* End index of the opening tag that starts at `from`. Quote-aware, because
   inline handlers in index.html contain ">" inside attribute values and a naive
   indexOf(">") would cut the tag in half. */
function openTagEnd(html, from) {
  let quote = "";
  for (let i = from + 1; i < html.length; i += 1) {
    const ch = html[i];
    if (quote) { if (ch === quote) quote = ""; continue; }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === ">") return i;
  }
  return -1;
}

/* Index just past the </tag> that closes the element opened at `openEnd`,
   counting nested same-name tags. */
function matchingCloseEnd(html, tag, openEnd) {
  const open = new RegExp("<" + tag + "(?=[\\s/>])", "ig");
  const close = new RegExp("</" + tag + "\\s*>", "ig");
  let depth = 1;
  let cursor = openEnd + 1;
  for (;;) {
    open.lastIndex = cursor;
    close.lastIndex = cursor;
    const nextOpen = open.exec(html);
    const nextClose = close.exec(html);
    if (!nextClose) return -1;
    if (nextOpen && nextOpen.index < nextClose.index) {
      depth += 1;
      cursor = openTagEnd(html, nextOpen.index) + 1;
      continue;
    }
    depth -= 1;
    cursor = nextClose.index + nextClose[0].length;
    if (depth === 0) return cursor;
  }
}

/* Remove every element carrying data-gd-surface="<surface>", including its
   children. Throws rather than guessing: a silently half-removed panel would
   ship a broken app build, which is worse than a failed build. */
function stripSurface(html, surface) {
  const marker = SURFACE_ATTR + '="' + surface + '"';
  let out = html;
  let removed = 0;
  for (;;) {
    const at = out.indexOf(marker);
    if (at < 0) break;
    const open = out.lastIndexOf("<", at);
    const name = open < 0 ? null : /^<([a-zA-Z][a-zA-Z0-9-]*)/.exec(out.slice(open, at + marker.length));
    if (!name) throw new Error("stripSurface: no opening tag found for " + marker + " at " + at);
    const tag = name[1].toLowerCase();
    const openEnd = openTagEnd(out, open);
    if (openEnd < 0) throw new Error("stripSurface: unterminated <" + tag + "> tag at " + open);
    let end;
    if (VOID_TAGS[tag] || out[openEnd - 1] === "/") {
      end = openEnd + 1;
    } else {
      end = matchingCloseEnd(out, tag, openEnd);
      if (end < 0) throw new Error("stripSurface: no </" + tag + "> closing the element at " + open);
    }
    out = out.slice(0, open) + out.slice(end);
    removed += 1;
  }
  return { html: out, removed: removed };
}

/* Every scripts//styles/ file the markup actually loads. */
function assetRefs(html) {
  const refs = new Set();
  const re = /(?:src|href)="((?:scripts|styles)\/[^"?]+\.(?:js|css))/g;
  let match;
  while ((match = re.exec(html))) refs.add(match[1]);
  return refs;
}

/* Stamp every script/style ?v= with a hash of that file's CONTENT.
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
function stampContentVersions(html) {
  let stamped = 0;
  const out = html.replace(/((?:src|href)=")((?:scripts|styles)\/[^"?]+\.(?:js|css))\?v=[^"]*(")/g,
    function (whole, pre, assetPath, post) {
      const assetFile = path.join(dist, assetPath);
      if (!fs.existsSync(assetFile)) return whole;
      const hash = crypto.createHash("sha1").update(fs.readFileSync(assetFile)).digest("hex").slice(0, 10);
      stamped += 1;
      return pre + assetPath + "?v=" + hash + post;
    });
  return { html: out, stamped: stamped };
}

/* Stamp the surface on <html> so runtime code can branch on
   document.documentElement.dataset.gdTarget without sniffing the URL. */
function stampTarget(html, target) {
  return html.replace(/<html(\s|>)/i, '<html data-gd-target="' + target + '"$1');
}

fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist, { recursive: true });
publicPaths.forEach(copyEntry);

const sourceHtml = fs.readFileSync(path.join(dist, "index.html"), "utf8");
const app = stripSurface(sourceHtml, STUDIO);
const studio = stripSurface(sourceHtml, APP);
const appOnlyFiles = [...assetRefs(sourceHtml)].filter(function (ref) { return !assetRefs(studio.html).has(ref); });
const studioOnlyFiles = [...assetRefs(sourceHtml)].filter(function (ref) { return !assetRefs(app.html).has(ref); });

const appStamped = stampContentVersions(stampTarget(app.html, APP));
fs.writeFileSync(path.join(dist, "index.html"), appStamped.html);
console.log("App surface: removed " + app.removed + " studio-only elements, stamped " + appStamped.stamped + " assets");

if (APP_ONLY) {
  studioOnlyFiles.forEach(function (ref) { fs.rmSync(path.join(dist, ref), { force: true }); });
  /* Walk each pruned file's directory up toward dist/, removing directories left
     empty by the prune - not just the file's immediate parent. A single-level check
     was enough while scripts/studio/ was flat; it silently leaves nested directories
     (e.g. scripts/studio/courses/course-database/) behind once anything under
     scripts/studio/ has its own subdirectory, and an empty directory still rides
     into the native bundle via `npx cap sync` the same as a stray file would. */
  const emptied = new Set(studioOnlyFiles.map(function (ref) { return path.dirname(ref); }));
  emptied.forEach(function (dir) {
    let target = path.join(dist, dir);
    while (target !== dist && fs.existsSync(target) && fs.readdirSync(target).length === 0) {
      fs.rmdirSync(target);
      target = path.dirname(target);
    }
  });
  /* Directories that belong to the deployed site but not inside a store binary.
     Same reasoning as the studio prune above: `npx cap sync` copies all of dist
     into the native projects, so anything left here ships inside the APK/IPA
     whether or not a single byte of it is reachable. `demo/` is the Playwright
     capture harness - a dev tool, and one that has no business being in a
     shipped app even at 20KB. On Netlify these stay, since the CDN serves them
     and `npm run demo:capture` drives them. */
  const NON_APP_DIRS = ["demo"];
  let prunedDirs = 0;
  NON_APP_DIRS.forEach(function (dir) {
    const target = path.join(dist, dir);
    if (!fs.existsSync(target)) return;
    fs.rmSync(target, { recursive: true, force: true });
    prunedDirs += 1;
  });
  console.log("--app-only: no studio output; pruned " + studioOnlyFiles.length
    + " studio-only files and " + prunedDirs + " non-app director" + (prunedDirs === 1 ? "y" : "ies") + " from dist");
} else {
  const studioHtml = stampTarget(studio.html, STUDIO).replace(/<head>/i, '<head>\n<base href="/">');
  const studioStamped = stampContentVersions(studioHtml);
  fs.mkdirSync(path.join(dist, STUDIO), { recursive: true });
  fs.writeFileSync(path.join(dist, STUDIO, "index.html"), studioStamped.html);
  console.log("Studio surface: /studio/ removed " + studio.removed + " app-only elements ("
    + appOnlyFiles.length + " app-only files), kept " + studioOnlyFiles.length + " studio-only, stamped "
    + studioStamped.stamped + " assets");
}

(function stampAppSurface() {
  const appIndex = path.join(dist, "app", "index.html");
  if (!fs.existsSync(appIndex)) return;
  let stamped = 0;
  const html = fs.readFileSync(appIndex, "utf8").replace(
    /((?:src|href)=")([^"?]+\.(?:js|css))(?:\?v=[^"]*)?(")/g,
    function (whole, pre, assetPath, post) {
      const assetFile = path.join(dist, "app", assetPath);
      if (!fs.existsSync(assetFile)) return whole;
      const hash = crypto.createHash("sha1").update(fs.readFileSync(assetFile)).digest("hex").slice(0, 10);
      stamped += 1;
      return pre + assetPath + "?v=" + hash + post;
    });
  fs.writeFileSync(appIndex, html);
  console.log("Fresh app surface: stamped " + stamped + " assets");
})();

console.log("Prepared Netlify deploy output: " + path.relative(root, dist));
console.log("Clarity Caddy app restored at site root: /");
console.log("Public entries: " + publicPaths.filter(function (entry) { return fs.existsSync(path.join(root, entry)); }).join(", "));
