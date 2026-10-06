"use strict";

/* One well-mannered way to read somebody else's web page.
 *
 * The scorecard resolver reads pages it found through a search engine. Those pages
 * belong to clubs and to aggregators who did not ask to be read, so every fetch
 * goes through here and keeps four promises to them:
 *
 *   1. Sites that have asked us to stop are never fetched at all. BlueGolf wrote
 *      to say so (October 2026). Their URLs are dropped before they are even
 *      queued, and refused here as a second line of defence.
 *   2. robots.txt is read once per host and obeyed, matched on our own product
 *      token first and the "*" group second, in the RFC 9309 way.
 *   3. A host that answers 401, 403, 429 or 451 has said no. It is remembered and
 *      not asked again while this process is alive, however many more URLs on it
 *      turn up.
 *   4. Requests to one host are serialised and spaced at least MIN_GAP_MS apart,
 *      so eighteen hole pages arrive as a trickle rather than a burst.
 *
 * Shared CommonJS, like safe-remote-url.js, because the ESM functions import it
 * and the CommonJS scorecard-search function requires it. */

const { safeRemoteUrl, resolvesToPublicAddress } = require("./safe-remote-url");

/* Hosts we do not read because they asked us not to. A subdomain of a listed host
   is covered too. Hosts that merely refuse us are handled by the refusal memory
   below, so they need no entry here. */
const BLOCKED_HOSTS = ["bluegolf.com"];

/* How we introduce ourselves. The product token is what a robots.txt group would
   name to address us specifically. */
const AGENT_TOKEN = "ClarityCaddie";
const USER_AGENT = AGENT_TOKEN + "/1.0 (+https://caddy.claritygolf.app)";

const MIN_GAP_MS = 1000;
const ROBOTS_TTL_MS = 60 * 60 * 1000;
const MAX_ROBOTS_CHARS = 500000;
const REFUSAL_STATUSES = new Set([401, 403, 429, 451]);

function hostOf(url) {
  try { return new URL(String(url)).hostname.toLowerCase(); } catch (e) { return ""; }
}

function isBlockedHost(url) {
  const host = hostOf(url);
  if (!host) return false;
  return BLOCKED_HOSTS.some(blocked => host === blocked || host.endsWith("." + blocked));
}

/* robots.txt -> [{ agents: [lowercase tokens], rules: [{ allow, pattern }] }].
   Comments stripped, unknown directives ignored, consecutive User-agent lines
   share one group. */
function parseRobots(text) {
  const groups = [];
  let current = null;
  let lastWasAgent = false;
  String(text || "").split(/\r?\n/).forEach(rawLine => {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) return;
    const colon = line.indexOf(":");
    if (colon === -1) return;
    const field = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (field === "user-agent") {
      if (!lastWasAgent || !current) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      return;
    }
    lastWasAgent = false;
    if (!current) return;
    if (field === "allow" || field === "disallow") {
      current.rules.push({ allow: field === "allow", pattern: value });
    }
  });
  return groups;
}

/* A rule pattern is a path prefix with "*" as a wildcard and an optional "$" that
   pins the end. An empty Disallow means "nothing is disallowed". */
function patternMatches(pattern, path) {
  if (!pattern) return false;
  const anchored = pattern.endsWith("$");
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const source = "^" + body.split("*").map(part => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*") + (anchored ? "$" : "");
  return new RegExp(source).test(path);
}

/* Does the parsed robots.txt let `agentToken` read `path`? The group that names
   us wins over the "*" group; within a group the longest matching rule decides
   and Allow wins a tie. No group that applies to us means everything is allowed. */
function robotsAllows(groups, path, agentToken) {
  const token = String(agentToken || "").toLowerCase();
  const target = (groups || []).filter(group => group.agents.some(agent => agent !== "*" && token && (agent === token || agent.startsWith(token))));
  const applicable = target.length ? target : (groups || []).filter(group => group.agents.includes("*"));
  if (!applicable.length) return true;
  let best = null;
  applicable.forEach(group => group.rules.forEach(rule => {
    if (!patternMatches(rule.pattern, path)) return;
    const length = rule.pattern.length;
    if (!best || length > best.length || (length === best.length && rule.allow && !best.allow)) {
      best = { allow: rule.allow, length };
    }
  }));
  return best ? best.allow : true;
}

function sleep(ms, signal) {
  if (ms <= 0) return Promise.resolve();
  return new Promise(resolve => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", done);
      resolve();
    }
    if (signal) signal.addEventListener("abort", done, { once: true });
  });
}

/* Returns fetchHtml(url, signal) -> html string, with the host memory above kept
   on the returned function for the life of the process. `fetchImpl` is injected
   for the tests; everything else defaults to how the functions actually run. */
function createPoliteHtmlFetcher(options) {
  const opts = options || {};
  const fetchImpl = opts.fetchImpl || ((...args) => fetch(...args));
  const minGapMs = Number.isFinite(opts.minGapMs) ? opts.minGapMs : MIN_GAP_MS;
  const maxChars = Number.isFinite(opts.maxChars) ? opts.maxChars : 650000;
  const userAgent = opts.userAgent || USER_AGENT;
  const agentToken = opts.agentToken || AGENT_TOKEN;
  const now = opts.now || (() => Date.now());

  /* host -> { reason, status } once a host has said no. */
  const refused = new Map();
  /* host -> { at, promise of { groups|null, allowAll, unreachable? } }. An
     unreachable robots.txt means the host is left alone until the entry expires. */
  const robots = new Map();
  /* host -> promise chain, so concurrent callers to one host take turns. */
  const queues = new Map();
  const lastRequestAt = new Map();

  function refuse(host, status, reason) {
    refused.set(host, { status, reason });
  }

  /* Runs `task` as the next request to this host, after the spacing gap. */
  function takeTurn(host, signal, task) {
    const previous = queues.get(host) || Promise.resolve();
    const turn = previous.catch(() => {}).then(async () => {
      const waitMs = (lastRequestAt.get(host) || 0) + minGapMs - now();
      await sleep(waitMs, signal);
      if (signal && signal.aborted) throw new Error("aborted before fetch");
      lastRequestAt.set(host, now());
      return task();
    });
    queues.set(host, turn);
    return turn;
  }

  function robotsFor(target, signal) {
    const host = target.hostname.toLowerCase();
    const cached = robots.get(host);
    if (cached && now() - cached.at < ROBOTS_TTL_MS) return cached.promise;
    /* The promise is cached, not the answer, so three callers arriving together
       share one robots.txt read instead of each making their own. */
    const entry = { at: now() };
    entry.promise = readRobots(target, host, signal).catch(error => {
      robots.delete(host);
      throw error;
    });
    robots.set(host, entry);
    return entry.promise;
  }

  async function readRobots(target, host, signal) {
    const entry = { groups: null, allowAll: false };
    try {
      const response = await takeTurn(host, signal, () => fetchImpl(target.origin + "/robots.txt", {
        signal, redirect: "follow",
        headers: { Accept: "text/plain", "User-Agent": userAgent }
      }));
      if (response.ok) {
        entry.groups = parseRobots((await response.text()).slice(0, MAX_ROBOTS_CHARS));
      } else if (response.status >= 500) {
        /* RFC 9309: a server that cannot say what it allows is treated as
           allowing nothing, until it can. */
        entry.unreachable = "HTTP " + response.status;
      } else {
        /* No robots.txt, or one we may not read: nothing is disallowed. */
        entry.allowAll = true;
      }
    } catch (error) {
      if (signal && signal.aborted) throw error;
      entry.unreachable = String(error && error.message || error).slice(0, 120);
    }
    return entry;
  }

  async function fetchHtml(url, signal) {
    const target = safeRemoteUrl(url);
    if (!target) throw new Error("unsafe or unsupported url");
    if (isBlockedHost(target)) throw new Error("host is on the do-not-fetch list");
    const host = target.hostname.toLowerCase();
    const earlier = refused.get(host);
    if (earlier) throw new Error("host refused us earlier (" + earlier.reason + ")");
    if (!(await resolvesToPublicAddress(target))) throw new Error("url does not resolve to a public address");

    const rules = await robotsFor(target, signal);
    if (rules.unreachable) throw new Error("robots.txt unreachable (" + rules.unreachable + "), leaving host alone");
    if (!rules.allowAll && !robotsAllows(rules.groups, target.pathname + target.search, agentToken)) {
      throw new Error("disallowed by robots.txt");
    }

    const response = await takeTurn(host, signal, () => fetchImpl(target.href, {
      signal, redirect: "follow",
      headers: { Accept: "text/html,application/xhtml+xml", "User-Agent": userAgent }
    }));
    if (REFUSAL_STATUSES.has(response.status)) {
      refuse(host, response.status, "HTTP " + response.status);
      throw new Error("HTTP " + response.status + " - host will not be asked again");
    }
    if (!response.ok) throw new Error("HTTP " + response.status);
    /* A scorecard table is never megabytes, and an unbounded read is how one bad
       URL becomes a function timeout. */
    return (await response.text()).slice(0, maxChars);
  }

  fetchHtml.refusedHosts = () => [...refused.entries()].map(([host, entry]) => Object.assign({ host }, entry));
  return fetchHtml;
}

module.exports = {
  BLOCKED_HOSTS,
  AGENT_TOKEN,
  USER_AGENT,
  MIN_GAP_MS,
  isBlockedHost,
  parseRobots,
  robotsAllows,
  createPoliteHtmlFetcher
};
