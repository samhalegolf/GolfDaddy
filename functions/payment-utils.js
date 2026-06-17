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

function normaliseProductKey(value) {
  return String(value || "").trim().toLowerCase().replace(/[\s-]+/g, "_").replace(/[^a-z0-9_]/g, "");
}

async function paymentProduct(value) {
  const key = normaliseProductKey(value);
  if (!key || !hasSupabase()) return null;
  const rows = await supabaseFetch("payment_products?select=*&product_key=eq." + encodeFilter(key) + "&active=eq.true&limit=1", { method: "GET" });
  return Array.isArray(rows) && rows[0] || null;
}

function productPriceId(product, fallbackType) {
  if (product && product.stripe_price_id) return product.stripe_price_id;
  return passPriceId(fallbackType || product && product.product_key || "");
}

function productDurationHours(product, fallbackType) {
  const value = Number(product && product.duration_hours);
  if (Number.isFinite(value) && value > 0) return value;
  return passDurationHours(fallbackType || product && product.product_key || "day_pass");
}

function entitlementWindow(type, createdMs, durationHours) {
  const starts = new Date(Number.isFinite(createdMs) ? createdMs : Date.now());
  const hours = Number(durationHours);
  const cleanHours = Number.isFinite(hours) && hours > 0 ? hours : passDurationHours(type);
  const expires = new Date(starts.getTime() + cleanHours * 60 * 60 * 1000);
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
  normaliseProductKey,
  passPriceId,
  passType,
  paymentProduct,
  productDurationHours,
  productPriceId,
  supabaseFetch,
  text
};
