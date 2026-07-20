"use strict";

/* Public store-billing config for the native apps.
 *
 * RevenueCat SDK keys are public by design - they identify the app, they do not
 * authorise anything. They are served from here rather than hardcoded so keys and
 * product ids can change without shipping a new store build, which matters because
 * a bad product id is otherwise a multi-day review cycle to fix.
 *
 * The webhook shared secret (REVENUECAT_WEBHOOK_AUTH) is NOT public and is never
 * returned here. */

exports.handler = async function (event) {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: { "Cache-Control": "no-store" }, body: "" };
  }
  if (event.httpMethod !== "GET") {
    return {
      statusCode: 405,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      body: JSON.stringify({ error: "Method not allowed" })
    };
  }

  const androidKey = process.env.REVENUECAT_ANDROID_PUBLIC_KEY || "";
  const iosKey = process.env.REVENUECAT_IOS_PUBLIC_KEY || "";

  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    body: JSON.stringify({
      configured: !!(androidKey || iosKey),
      apiKeys: {
        android: androidKey,
        ios: iosKey
      },
      /* Maps our internal product keys to store product identifiers. Defaults
         match the ids assumed by dev/store-billing.test.js. */
      products: {
        monthly_membership: process.env.STORE_MEMBERSHIP_PRODUCT_ID || "clarity_membership_monthly",
        month_pass: process.env.STORE_MONTH_PASS_PRODUCT_ID || "clarity_month_pass"
      },
      /* RevenueCat entitlement identifier that means "has full access". */
      entitlementId: process.env.REVENUECAT_ENTITLEMENT_ID || "membership"
    })
  };
};
