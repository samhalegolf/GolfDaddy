/* Which language an email goes out in.
 *
 * The recipient's own choice first: the app records it on their app_accounts row
 * (metadata.locale) at sign-in and on every account sync. Then the language of whoever
 * caused the send - a coach inviting a player who has never opened the app, or a player
 * resetting a password on a device that never synced. Then English. */
"use strict";

const { findAccountByEmail } = require("../auth-utils");
const { clean: cleanLocale } = require("../../scripts/gd-i18n-node.js");

function storedLocale(row) {
  const metadata = row && row.metadata;
  return metadata && typeof metadata === "object" && typeof metadata.locale === "string" ? metadata.locale : "";
}

async function recipientLocale(address, fallback, row) {
  let stored = storedLocale(row);
  if (!stored && address) {
    try { stored = storedLocale(await findAccountByEmail(address)); } catch (_error) { stored = ""; }
  }
  return cleanLocale(stored) || cleanLocale(fallback) || "en";
}

module.exports = { recipientLocale, cleanLocale, storedLocale };
