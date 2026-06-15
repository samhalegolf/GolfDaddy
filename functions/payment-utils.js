"use strict";

const PASS_CONFIG = {
  day_pass: {
    env: "STRIPE_PRICE_DAY_PASS",
    label: "Day Pass",
    hoursEnv: "CLARITY_DAY_PASS_HOURS",
    defaultHours: 24
  },
  round_pass: {
    env: "STRIPE_PRICE_ROUND_PASS",
    label: "Round Pass",
    hoursEnv: "CLARITY_ROUND_PASS_HOURS",
    defaultHours: 24
  }
};

function env(name) {
  return process.env[name] || "";
}

function json(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store"
    },
    body: JSON.stringify(body)
  };
}

function text(value, limit) {
  const input = String(value || "").trim();
  return input.length > limit ? input.slice(0, limit) : input;
}

function email(value) {
  const input = text(value, 240).toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input) ? input : "";
}

function passType(value) {
  const raw = String(value || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  return PASS_CONFIG[raw] ? raw : "";
}

function appUrl() {
  const configured = env("APP_URL") || env("CLARITY_SITE_URL") || env("URL") || "https://clarity-caddie.netlify.app";
  return configured.replace(/\/+$/, "");
}

function passPriceId(type) {
  const config = PASS_CONFIG[type];
  return config ? env(config.env) : "";
}

function passDurationHours(type) {
  const config = PASS_CONFIG[type] || PASS_CONFIG.day_pass;
  const value = Number(env(config.hoursEnv));
  return Number.isFinite(value) && value > 0 ? value : config.defaultHours;
}

function entitlementWindow(type, createdMs) {
  const starts = new Date(Number.isFinite(createdMs) ? createdMs : Date.now());
  const expires = new Date(starts.getTime() + passDurationHours(type) * 60 * 60 * 1000);
  return {
    starts_at: starts.toISOString(),
    expires_at: expires.toISOString()
  };
}

function supabaseBase() {
  return env("SUPABASE_URL").replace(/\/+$/, "");
}

function supabaseKey() {
  return env("SUPABASE_SERVICE_ROLE_KEY");
}

function hasSupabase() {
  return !!(supabaseBase() && supabaseKey());
}

async function supabaseFetch(path, options) {
  if (!hasSupabase()) throw new Error("Supabase payment storage is not configured");
  const headers = Object.assign({
    apikey: supabaseKey(),
    Authorization: "Bearer " + supabaseKey(),
    "Content-Type": "application/json"
  }, options && options.headers || {});
  const response = await fetch(supabaseBase() + "/rest/v1/" + path, Object.assign({}, options, { headers }));
  const bodyText = await response.text();
  let body = null;
  if (bodyText) {
    try {
      body = JSON.parse(bodyText);
    } catch (error) {
      body = bodyText;
    }
  }
  if (!response.ok) {
    const error = new Error("Supabase request failed");
    error.status = response.status;
    error.body = body;
    throw error;
  }
  return body;
}

function encodeFilter(value) {
  return encodeURIComponent(String(value || ""));
}

module.exports = {
  PASS_CONFIG,
  appUrl,
  email,
  encodeFilter,
  entitlementWindow,
  env,
  hasSupabase,
  json,
  passPriceId,
  passType,
  supabaseFetch,
  text
};
