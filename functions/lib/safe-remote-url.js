"use strict";

/* Shared SSRF guards for functions that fetch arbitrary third-party URLs on behalf
   of the app. Both the scorecard fetcher and the scorecard search resolver accept
   URLs that ultimately come from the open web, so the checks live here rather than
   being copied - two copies of a security check drift, and the weaker copy wins. */

const dns = require("node:dns").promises;
const net = require("node:net");

const DEFAULT_MAX_URL_CHARS = 500;

/* Static shape checks. Returns a URL object, or null if the URL is not something
   we are willing to request. Does not touch the network. */
function safeRemoteUrl(value, options) {
  const maxChars = (options && options.maxUrlChars) || DEFAULT_MAX_URL_CHARS;
  try {
    const url = new URL(String(value || ""));
    if (url.protocol !== "https:") return null;
    if (url.href.length > maxChars) return null;
    /* user:pass@host is never a real content URL, and is a classic way to make a
       URL read as one host while authenticating against another. */
    if (url.username || url.password) return null;
    if (url.port && url.port !== "443") return null;

    const host = stripBrackets(url.hostname.toLowerCase());
    if (!host) return null;
    if (host === "localhost" || host.endsWith(".localhost")) return null;
    if (host.endsWith(".local") || host.endsWith(".internal")) return null;
    /* Literal addresses are settled here; hostnames need DNS, below. */
    if (net.isIP(host) && !isPublicAddress(host)) return null;
    return url;
  } catch (error) {
    return null;
  }
}

/* Resolves the hostname and rejects if any answer lands in private space. A
   rebinding window remains between this lookup and the request that follows, but
   it closes the trivial "point a public name at 169.254.169.254" case. */
async function resolvesToPublicAddress(url) {
  const host = stripBrackets(String(url.hostname || "").toLowerCase());
  if (net.isIP(host)) return isPublicAddress(host);
  let records;
  try {
    records = await dns.lookup(host, { all: true });
  } catch (error) {
    return false;
  }
  return records.length > 0 && records.every(record => isPublicAddress(record.address));
}

function isPublicAddress(address) {
  const kind = net.isIP(address);
  if (kind === 4) return isPublicIPv4(address);
  if (kind === 6) return isPublicIPv6(address);
  return false;
}

function isPublicIPv4(address) {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4) return false;
  if (parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b] = parts;
  if (a === 0) return false;                          // this network
  if (a === 10) return false;                         // private
  if (a === 127) return false;                        // loopback
  if (a === 169 && b === 254) return false;           // link-local, incl. cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return false;  // private
  if (a === 192 && b === 0) return false;             // protocol assignments / TEST-NET-1
  if (a === 192 && b === 168) return false;           // private
  if (a === 100 && b >= 64 && b <= 127) return false; // carrier-grade NAT
  if (a >= 224) return false;                         // multicast, reserved, broadcast
  return true;
}

function isPublicIPv6(address) {
  const value = address.toLowerCase();
  if (value === "::" || value === "::1") return false;
  if (value.startsWith("::ffff:")) return isPublicIPv4(value.slice("::ffff:".length));
  if (/^fe[89ab]/.test(value)) return false;          // fe80::/10 link-local
  if (/^f[cd]/.test(value)) return false;             // fc00::/7 unique local
  return true;
}

function stripBrackets(host) {
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

module.exports = {
  safeRemoteUrl,
  resolvesToPublicAddress,
  isPublicAddress
};
