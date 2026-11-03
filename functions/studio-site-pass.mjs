/* POST /api/studio-site-pass - Studio > Marketing > Websites.
 *
 * Clarity's public websites are built with Clarity Booking's website builder, the same one
 * coaches use, so a change to the builder reaches every site at once. Studio frames that
 * builder from the Booking deploy (CLARITY_BOOKING_URL, default https://claritygolf.app) at
 * /studio-sites. Booking cannot read a Caddy login, so this hands the frame a short-lived
 * pass instead: once the bearer token is proved to be a Studio admin's (the same proof every
 * Studio API uses), it signs who they are and when the pass expires with the service secret
 * the two deploys already share (CLARITY_SERVICE_SECRET). Booking checks the signature
 * (_shared/site/house.mts there) and lets the pass edit Clarity's own sites, nothing else.
 *
 * The pass:   v1.<payload>.<signature>
 *   payload    base64url of {"aud":"clarity-studio-sites","sub":<admin email>,"exp":<unix seconds>}
 *   signature  base64url of HMAC-SHA256(secret, "v1.<payload>")
 * Booking tests the same fixed vector as dev/studio-site-pass.test.js, so neither side can
 * change the format alone.
 *
 * Answers { pass, expiresAt (ms), bookingUrl }. */
import { createHmac } from "node:crypto";
import { verifiedAdminEmail, json } from "./lib/gd-map-overlay-store.mjs";

export const STUDIO_PASS_AUDIENCE = "clarity-studio-sites";
export const STUDIO_PASS_SECONDS = 15 * 60;

function env(name) { return process.env[name] || ""; }

export function bookingUrl() {
  return (env("CLARITY_BOOKING_URL") || "https://claritygolf.app").replace(/\/+$/, "");
}

/** The pass for one admin, valid until `exp` (unix seconds). */
export function signStudioPass(secret, email, exp) {
  const payload = Buffer.from(JSON.stringify({ aud: STUDIO_PASS_AUDIENCE, sub: email, exp })).toString("base64url");
  const signature = createHmac("sha256", secret).update("v1." + payload).digest("base64url");
  return "v1." + payload + "." + signature;
}

export default async function handler(req) {
  if (req.method !== "POST") return json(405, { error: "Method not allowed" });
  const secret = env("CLARITY_SERVICE_SECRET");
  if (!secret) return json(503, { error: "CLARITY_SERVICE_SECRET is not set on Clarity Caddy, so Studio cannot sign in to the website builder." });
  const email = await verifiedAdminEmail(req);
  if (!email) return json(403, { error: "Sign in as an admin first." });
  const exp = Math.floor(Date.now() / 1000) + STUDIO_PASS_SECONDS;
  return json(200, { pass: signStudioPass(secret, email, exp), expiresAt: exp * 1000, bookingUrl: bookingUrl() });
}

export const config = { path: "/api/studio-site-pass" };
