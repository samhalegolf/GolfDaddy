/* Capacitor generates packageClassList from npm plugins and intentionally
   overwrites it on sync. NativeRoundBridge is app-owned Swift, so retain its
   registration after every iOS sync without pretending it is an npm plugin. */
const fs = require("fs");
const path = require("path");

const configPath = path.join(__dirname, "..", "ios", "App", "App", "capacitor.config.json");
if (!fs.existsSync(configPath)) process.exit(0);
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
const list = Array.isArray(config.packageClassList) ? config.packageClassList : [];
if (!list.includes("NativeRoundBridge")) list.push("NativeRoundBridge");
config.packageClassList = list;
fs.writeFileSync(configPath, JSON.stringify(config, null, "\t") + "\n");
