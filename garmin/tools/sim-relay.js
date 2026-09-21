#!/usr/bin/env node
/* Simulator relay: lets a round be DRIVEN from the Connect IQ simulator.

   The simulator on this Mac segfaults on any Communications.transmit while
   the adb tether is up (garmin/UPLOAD.md, "Known simulator bug"), so a
   watch-driven round - every SELECT, LOCK, AIM_AT is a message to the phone -
   was impossible to exercise. Its web requests are fine, though. So the muted
   watch build POSTs each message it would have transmitted to this process
   (GarminTransmitPolicy.relayUrl), and this process hands it to the phone
   app's WebView over the Chrome DevTools protocol, where
   tools/sim-relay-phone.js feeds it into the exact code path a real Garmin
   message takes. The phone's acknowledgement and every Scene still travel
   phone -> watch over the tether, which works.

   Usage (see UPLOAD.md for the full runbook):
     adb forward tcp:9222 localabstract:webview_devtools_remote_<pid>
     node garmin/tools/sim-relay.js            # listens on 127.0.0.1:7382

   Nothing here is used by any shipped build. */

"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = Number(process.env.RELAY_PORT || 7382);
const DEVTOOLS = process.env.DEVTOOLS || "http://127.0.0.1:9222";
const PHONE_HALF = fs.readFileSync(path.join(__dirname, "sim-relay-phone.js"), "utf8");

const queue = [];
let ws = null;
let nextId = 1;
const pending = new Map();
let injected = false;
let delivering = false;

function log(line) { console.log(new Date().toISOString().slice(11, 19) + " " + line); }

/* ------------------------------------------------------------ devtools */

async function connect() {
  if (ws && ws.readyState === WebSocket.OPEN) return ws;
  const pages = await (await fetch(DEVTOOLS + "/json")).json();
  const page = pages.find(p => p.type === "page") || pages[0];
  if (!page) throw new Error("no page behind " + DEVTOOLS);
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  socket.onmessage = (event) => {
    const m = JSON.parse(event.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  };
  socket.onclose = () => { ws = null; injected = false; log("devtools closed; will reconnect on next message"); };
  ws = socket;
  injected = false;
  log("devtools connected: " + page.url);
  return ws;
}

function evaluate(expression) {
  return new Promise(async (resolve, reject) => {
    const socket = await connect().catch(reject);
    if (!socket) return;
    const id = nextId++;
    pending.set(id, (m) => {
      if (m.result && m.result.exceptionDetails) return reject(new Error(m.result.exceptionDetails.text || "evaluate threw"));
      resolve(m.result && m.result.result ? m.result.result.value : undefined);
    });
    socket.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, awaitPromise: true, returnByValue: true } }));
  });
}

async function ensurePhoneHalf() {
  const present = await evaluate("typeof window.__simRelayDeliver === 'function'");
  if (present === true && injected) return;
  await evaluate(PHONE_HALF + "; true");
  injected = true;
  const stats = await evaluate("JSON.stringify(window.__simRelayStats())");
  log("phone half ready: " + stats);
}

/* --------------------------------------------------------------- queue */

async function drain() {
  if (delivering) return;
  delivering = true;
  try {
    while (queue.length) {
      const message = queue[0];
      try {
        await ensurePhoneHalf();
        const answer = await evaluate("JSON.stringify(window.__simRelayDeliver(" + JSON.stringify(message) + "))");
        log("-> phone " + Object.keys(message).join(",") + " => " + answer);
        queue.shift();
      } catch (error) {
        log("delivery failed (" + (error && error.message) + "); retrying in 2s");
        await new Promise(r => setTimeout(r, 2000));
      }
    }
  } finally {
    delivering = false;
  }
}

/* ---------------------------------------------------------------- http */

const server = http.createServer((req, res) => {
  const headers = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Allow-Methods": "GET,POST,OPTIONS" };
  if (req.method === "OPTIONS") { res.writeHead(204, headers); return res.end(); }
  if (req.method === "GET" && req.url.startsWith("/status")) {
    res.writeHead(200, headers);
    return res.end(JSON.stringify({ queued: queue.length, devtools: !!(ws && ws.readyState === WebSocket.OPEN) }));
  }
  if (req.method === "POST" && req.url.startsWith("/watch")) {
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
      let message;
      try { message = JSON.parse(body || "{}"); } catch (e) { res.writeHead(400, headers); return res.end(JSON.stringify({ error: "bad json" })); }
      queue.push(message);
      log("<- watch " + Object.keys(message).join(",") + (message.command ? " " + message.command.type : ""));
      res.writeHead(200, headers);
      res.end(JSON.stringify({ queued: queue.length }));
      drain();
    });
    return;
  }
  res.writeHead(404, headers);
  res.end(JSON.stringify({ error: "not found" }));
});

server.listen(PORT, "127.0.0.1", () => log("relay listening on http://127.0.0.1:" + PORT + "/watch, phone via " + DEVTOOLS));
