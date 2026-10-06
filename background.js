// background.js — Service Worker
//
// Keeps a single WebSocket connection to Twitch IRC (anonymous, read-only)
// and distributes chat events to the active tab's content script:
//  - highlighting/restoring the text of deleted messages right in the
//    native chat,
//  - opening/closing the extension's own panel listing deleted messages,
//    triggered by clicking the toolbar icon or the right-click menu item.
//
// The chat-parsing logic mirrors the twitch-chat-logger Rust project 1:1:
// PRIVMSG -> new message, CLEARMSG -> a single message deleted by id,
// CLEARCHAT -> a user banned/timed out (clears all of their messages).

const IRC_URL = "wss://irc-ws.chat.twitch.tv:443";
const MAX_MESSAGES_PER_CHANNEL = 2000;
const CONTEXT_MENU_ID = "twitch-chat-logger-toggle";

let ws = null;
let wsReady = false;
let reconnectTimer = null;
let reconnectDelay = 1000;

// channel (lowercase, without "#") -> Set(tabId)
const channelTabs = new Map();
// channel -> Map(msgId -> messageObject)
const channelMessages = new Map();
// tabId -> channel (so we can unsubscribe cleanly on tab close/channel switch)
const tabChannel = new Map();

// --- Emotes: native Twitch + third-party (BTTV / FFZ / 7TV) ----------------
//
// Native Twitch emote positions come from the PRIVMSG "emotes" tag, e.g.
// "emotes=25:0-4,6-10/1902:12-17" — emote 25 at char positions 0-4 and 6-10,
// emote 1902 at 12-17. Positions are UTF-16 code unit offsets, which is
// exactly how JS strings index, so we can slice the text directly with them.
//
// Third-party emotes (BTTV/FFZ/7TV) are NOT in that tag at all — they're
// just plain words in the message text. To render them we need each
// channel's emote list (code -> image URL), fetched once per channel and
// cached here. The broadcaster's numeric Twitch ID (needed by these APIs)
// comes for free from the "room-id" tag on any PRIVMSG — no separate Helix/
// OAuth call needed.

function parseEmotesTag(tagValue) {
  if (!tagValue) return [];
  const result = [];
  for (const part of tagValue.split("/")) {
    if (!part) continue;
    const colonIdx = part.indexOf(":");
    if (colonIdx === -1) continue;
    const id = part.slice(0, colonIdx);
    const ranges = part.slice(colonIdx + 1);
    for (const range of ranges.split(",")) {
      const dashIdx = range.indexOf("-");
      if (dashIdx === -1) continue;
      const start = Number(range.slice(0, dashIdx));
      const end = Number(range.slice(dashIdx + 1));
      if (Number.isFinite(start) && Number.isFinite(end)) {
        result.push({ id, start, end });
      }
    }
  }
  result.sort((a, b) => a.start - b.start);
  return result;
}

function bttvCdnUrl(id) {
  return `https://cdn.betterttv.net/emote/${id}/2x.webp`;
}

async function fetchBttvGlobalEmotes() {
  try {
    const res = await fetch("https://api.betterttv.net/3/cached/emotes/global");
    if (!res.ok) return [];
    const data = await res.json();
    return (Array.isArray(data) ? data : []).map((e) => ({
      code: e.code,
      url: bttvCdnUrl(e.id),
    }));
  } catch (err) {
    log("BTTV global emotes fetch failed", err);
    return [];
  }
}

async function fetchBttvChannelEmotes(roomId) {
  try {
    const res = await fetch(`https://api.betterttv.net/3/cached/users/twitch/${roomId}`);
    if (!res.ok) return [];
    const data = await res.json();
    const list = [...(data?.channelEmotes || []), ...(data?.sharedEmotes || [])];
    return list.map((e) => ({ code: e.code, url: bttvCdnUrl(e.id) }));
  } catch (err) {
    log("BTTV channel emotes fetch failed", err);
    return [];
  }
}

function ffzEmoteUrlFromUrls(urlsObj) {
  if (!urlsObj) return null;
  const raw = urlsObj["2"] || urlsObj["4"] || urlsObj["1"];
  if (!raw) return null;
  return raw.startsWith("//") ? "https:" + raw : raw;
}

async function fetchFfzGlobalEmotes() {
  try {
    const res = await fetch("https://api.frankerfacez.com/v1/set/global");
    if (!res.ok) return [];
    const data = await res.json();
    const out = [];
    for (const setId of data?.default_sets || []) {
      const set = data?.sets?.[setId];
      for (const e of set?.emoticons || []) {
        const url = ffzEmoteUrlFromUrls(e.animated || e.urls);
        if (url) out.push({ code: e.name, url });
      }
    }
    return out;
  } catch (err) {
    log("FFZ global emotes fetch failed", err);
    return [];
  }
}

async function fetchFfzChannelEmotes(roomId) {
  try {
    const res = await fetch(`https://api.frankerfacez.com/v1/room/id/${roomId}`);
    if (!res.ok) return [];
    const data = await res.json();
    const out = [];
    for (const set of Object.values(data?.sets || {})) {
      for (const e of set?.emoticons || []) {
        const url = ffzEmoteUrlFromUrls(e.animated || e.urls);
        if (url) out.push({ code: e.name, url });
      }
    }
    return out;
  } catch (err) {
    log("FFZ channel emotes fetch failed", err);
    return [];
  }
}

function sevenTvFileUrl(host) {
  if (!host?.url) return null;
  const base = host.url.startsWith("//") ? "https:" + host.url : host.url;
  const files = host.files || [];
  const preferred = ["2x.webp", "2x.png", "1x.webp", "1x.png"];
  for (const name of preferred) {
    const f = files.find((file) => file.name === name);
    if (f) return `${base}/${f.name}`;
  }
  return files[0] ? `${base}/${files[0].name}` : null;
}

function sevenTvEmoteFromEntry(entry) {
  const data = entry?.data || entry;
  const code = entry?.name || data?.name;
  const url = sevenTvFileUrl(data?.host);
  if (!code || !url) return null;
  return { code, url };
}

async function fetchSevenTvGlobalEmotes() {
  try {
    const res = await fetch("https://7tv.io/v3/emote-sets/global");
    if (!res.ok) return [];
    const data = await res.json();
    const emotes = data?.emotes || [];
    return emotes.map(sevenTvEmoteFromEntry).filter(Boolean);
  } catch (err) {
    log("7TV global emotes fetch failed", err);
    return [];
  }
}

async function fetchSevenTvChannelEmotes(roomId) {
  try {
    const res = await fetch(`https://7tv.io/v3/users/twitch/${roomId}`);
    if (!res.ok) return [];
    const data = await res.json();
    const emotes = data?.emote_set?.emotes || data?.emotes || [];
    return emotes.map(sevenTvEmoteFromEntry).filter(Boolean);
  } catch (err) {
    log("7TV channel emotes fetch failed", err);
    return [];
  }
}

// channel -> broadcaster's numeric Twitch ID (from the "room-id" IRC tag)
const channelRoomId = new Map();
// channel -> { code: url } — merged BTTV+FFZ+7TV, global+channel, ready to use
const channelEmoteMaps = new Map();
// channels for which a third-party fetch has already been kicked off
const channelEmoteFetchStarted = new Set();

// Global emote sets are the same for every channel — fetch them only once
// and share the result.
let globalEmotesPromise = null;
function getGlobalEmotes() {
  if (!globalEmotesPromise) {
    globalEmotesPromise = Promise.all([
      fetchBttvGlobalEmotes(),
      fetchFfzGlobalEmotes(),
      fetchSevenTvGlobalEmotes(),
    ]).then(([bttv, ffz, seventv]) => [...bttv, ...ffz, ...seventv]);
  }
  return globalEmotesPromise;
}

async function ensureThirdPartyEmotes(channel, roomId) {
  if (channelEmoteFetchStarted.has(channel)) return;
  channelEmoteFetchStarted.add(channel);

  try {
    const [global, bttvCh, ffzCh, seventvCh] = await Promise.all([
      getGlobalEmotes(),
      fetchBttvChannelEmotes(roomId),
      fetchFfzChannelEmotes(roomId),
      fetchSevenTvChannelEmotes(roomId),
    ]);
    const map = {};
    // Global emotes first, channel-specific ones win on code collisions.
    for (const e of global) map[e.code] = e.url;
    for (const e of [...bttvCh, ...ffzCh, ...seventvCh]) map[e.code] = e.url;
    channelEmoteMaps.set(channel, map);
    // Push the freshly loaded map to any tab that already registered before
    // the fetch finished, so it doesn't have to ask again.
    broadcastToChannelTabs(channel, { type: "EMOTE_MAP_READY", emoteMap: map });
  } catch (err) {
    log("Failed to load third-party emotes for", channel, err);
    channelEmoteMaps.set(channel, {});
  }
}

function log(...args) {
  console.log("[TwitchChatLogger]", ...args);
}

function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return;
  }
  log("Connecting to Twitch IRC...");
  ws = new WebSocket(IRC_URL);

  ws.onopen = () => {
    log("WebSocket open, logging in anonymously");
    const anonNick = "justinfan" + Math.floor(10000 + Math.random() * 89999);
    ws.send("CAP REQ :twitch.tv/tags twitch.tv/commands\r\n");
    ws.send("PASS SCHMOOPIIE\r\n");
    ws.send(`NICK ${anonNick}\r\n`);
    wsReady = true;
    reconnectDelay = 1000;
    for (const channel of channelTabs.keys()) {
      joinChannel(channel);
    }
  };

  ws.onmessage = (event) => {
    const lines = String(event.data).split("\r\n").filter(Boolean);
    for (const line of lines) {
      handleIrcLine(line);
    }
  };

  ws.onclose = () => {
    log("WebSocket closed");
    wsReady = false;
    scheduleReconnect();
  };

  ws.onerror = (err) => {
    log("WebSocket error", err);
  };
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    reconnectDelay = Math.min(reconnectDelay * 2, 30000);
    connect();
  }, reconnectDelay);
}

function joinChannel(channel) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(`JOIN #${channel}\r\n`);
  log("JOIN", channel);
}

function partChannel(channel) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(`PART #${channel}\r\n`);
  log("PART", channel);
}

// Parses a single IRCv3 line with tags (@key=value;... :prefix COMMAND params :trailing)
function parseIrcLine(line) {
  let tags = {};
  let rest = line;

  if (rest.startsWith("@")) {
    const spaceIdx = rest.indexOf(" ");
    const tagStr = rest.slice(1, spaceIdx);
    rest = rest.slice(spaceIdx + 1);
    for (const pair of tagStr.split(";")) {
      const eqIdx = pair.indexOf("=");
      const key = eqIdx === -1 ? pair : pair.slice(0, eqIdx);
      const val = eqIdx === -1 ? "" : pair.slice(eqIdx + 1);
      tags[key] = val;
    }
  }

  let prefix = "";
  if (rest.startsWith(":")) {
    const spaceIdx = rest.indexOf(" ");
    prefix = rest.slice(1, spaceIdx);
    rest = rest.slice(spaceIdx + 1);
  }

  let trailing = null;
  const trailingIdx = rest.indexOf(" :");
  let paramsStr;
  if (trailingIdx !== -1) {
    paramsStr = rest.slice(0, trailingIdx);
    trailing = rest.slice(trailingIdx + 2);
  } else {
    paramsStr = rest;
  }
  const params = paramsStr.split(" ").filter(Boolean);
  const command = params.shift();

  return { tags, prefix, command, params, trailing };
}

function unescapeTagValue(val) {
  if (!val) return val;
  return val
    .replace(/\\s/g, " ")
    .replace(/\\:/g, ";")
    .replace(/\\r/g, "\r")
    .replace(/\\n/g, "\n")
    .replace(/\\\\/g, "\\");
}

function handleIrcLine(line) {
  if (line.startsWith("PING")) {
    ws.send("PONG :tmi.twitch.tv\r\n");
    return;
  }

  const msg = parseIrcLine(line);

  switch (msg.command) {
    case "PRIVMSG":
      handlePrivMsg(msg);
      break;
    case "CLEARMSG":
      handleClearMsg(msg);
      break;
    case "CLEARCHAT":
      handleClearChat(msg);
      break;
    default:
      break;
  }
}

function getChannelStore(channel) {
  if (!channelMessages.has(channel)) {
    channelMessages.set(channel, new Map());
  }
  return channelMessages.get(channel);
}

function broadcastToChannelTabs(channel, payload) {
  const tabs = channelTabs.get(channel);
  if (!tabs) return;
  for (const tabId of tabs) {
    chrome.tabs.sendMessage(tabId, payload).catch(() => {
      // the tab may have closed or reloaded — just ignore
    });
  }
}

function handlePrivMsg(msg) {
  const channel = msg.params[0]?.replace("#", "");
  if (!channel) return;

  const id = msg.tags.id;
  if (!id) return;

  const displayName = unescapeTagValue(msg.tags["display-name"]) || channel;
  const color = msg.tags.color || "#9147ff";
  const userLogin = (msg.prefix.split("!")[0] || "").toLowerCase();
  const text = msg.trailing || "";
  const emotes = parseEmotesTag(msg.tags.emotes);

  const roomId = msg.tags["room-id"];
  if (roomId && !channelRoomId.has(channel)) {
    channelRoomId.set(channel, roomId);
    ensureThirdPartyEmotes(channel, roomId); // fire and forget
  }

  const messageObj = {
    id,
    user: displayName,
    userLogin,
    color,
    text,
    emotes,
    ts: Date.now(),
    deleted: false,
  };

  const store = getChannelStore(channel);
  store.set(id, messageObj);

  if (store.size > MAX_MESSAGES_PER_CHANNEL) {
    const firstKey = store.keys().next().value;
    store.delete(firstKey);
  }

  broadcastToChannelTabs(channel, { type: "NEW_MESSAGE", message: messageObj });
}

function handleClearMsg(msg) {
  const channel = msg.params[0]?.replace("#", "");
  if (!channel) return;

  const targetId = msg.tags["target-msg-id"];
  if (!targetId) return;

  const store = getChannelStore(channel);
  let existing = store.get(targetId);

  if (existing) {
    existing.deleted = true;
    existing.deletedTs = Date.now();
  } else {
    // We never captured the original PRIVMSG for this id — maybe our IRC
    // connection was mid-reconnect right when it was sent, or it got pushed
    // out of the per-channel history cap in a very active chat. CLEARMSG
    // itself still carries the sender's login and the original text (Twitch
    // includes it as the trailing parameter), so we can reconstruct a usable
    // record instead of losing the message entirely. We just can't recover
    // native Twitch emote positions this way (those only come from PRIVMSG's
    // own "emotes" tag) — third-party emote codes still render fine, since
    // those are matched by plain text regardless of source.
    const login = msg.tags.login;
    if (login) {
      const sentTs = Number(msg.tags["tmi-sent-ts"]);
      existing = {
        id: targetId,
        user: login,
        userLogin: login.toLowerCase(),
        color: "#9147ff",
        text: msg.trailing || "",
        emotes: [],
        ts: Number.isFinite(sentTs) ? sentTs : Date.now(),
        deleted: true,
        deletedTs: Date.now(),
        reconstructed: true,
      };
      store.set(targetId, existing);
    }
  }

  broadcastToChannelTabs(channel, {
    type: "DELETE_MESSAGE",
    id: targetId,
    message: existing || null,
  });
}

function handleClearChat(msg) {
  const channel = msg.params[0]?.replace("#", "");
  if (!channel) return;

  const targetUserLogin = (msg.trailing || "").toLowerCase();
  if (!targetUserLogin) return; // full chat clear — rare, ignore

  const store = getChannelStore(channel);
  const deletedIds = [];
  const deletedMessages = [];
  for (const m of store.values()) {
    if (m.userLogin === targetUserLogin && !m.deleted) {
      m.deleted = true;
      m.deletedTs = Date.now();
      deletedIds.push(m.id);
      deletedMessages.push(m);
    }
  }

  if (deletedIds.length) {
    broadcastToChannelTabs(channel, {
      type: "DELETE_MANY",
      ids: deletedIds,
      messages: deletedMessages,
    });
  }
}

// --- Handling messages from content scripts ---

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const tabId = sender.tab?.id;

  switch (message.type) {
    case "REGISTER": {
      if (!tabId) return;
      const channel = message.channel.toLowerCase();
      registerTab(tabId, channel);
      const store = getChannelStore(channel);
      sendResponse({ history: Array.from(store.values()) });
      return true;
    }
    case "ENSURE_REGISTERED": {
      // Lightweight heartbeat sent periodically by the content script. If
      // the service worker got evicted and restarted since the last check,
      // all of its in-memory state (which tabs are on which channel) is
      // gone — this re-registers from scratch in that case. If we're still
      // registered as expected, this is a cheap no-op (no PART/JOIN churn).
      if (!tabId) return;
      const channel = message.channel.toLowerCase();
      if (tabChannel.get(tabId) !== channel) {
        registerTab(tabId, channel);
      } else {
        connect(); // no-op if the socket is already open
      }
      return;
    }
    case "UNREGISTER": {
      if (tabId) unregisterTab(tabId);
      return;
    }
    case "GET_DELETED_HISTORY": {
      const store = getChannelStore(message.channel);
      const deleted = Array.from(store.values())
        .filter((m) => m.deleted)
        .sort((a, b) => a.ts - b.ts);
      sendResponse({ deleted });
      return true;
    }
    case "GET_EMOTE_MAP": {
      const emoteMap = channelEmoteMaps.get(message.channel) || {};
      sendResponse({ emoteMap });
      return true;
    }
    default:
      return;
  }
});

function registerTab(tabId, channel) {
  unregisterTab(tabId); // in case it was subscribed to a different channel before

  tabChannel.set(tabId, channel);
  if (!channelTabs.has(channel)) {
    channelTabs.set(channel, new Set());
  }
  channelTabs.get(channel).add(tabId);

  connect();
  if (wsReady) {
    joinChannel(channel);
  }
}

function unregisterTab(tabId) {
  const prevChannel = tabChannel.get(tabId);
  if (!prevChannel) return;

  tabChannel.delete(tabId);
  const tabs = channelTabs.get(prevChannel);
  if (tabs) {
    tabs.delete(tabId);
    if (tabs.size === 0) {
      channelTabs.delete(prevChannel);
      partChannel(prevChannel);
      channelMessages.delete(prevChannel);
    }
  }
}

chrome.tabs.onRemoved.addListener((tabId) => {
  unregisterTab(tabId);
});

// --- Opening/closing the panel: toolbar icon click + right-click menu ------

function togglePanelForTab(tabId) {
  if (!tabId) return;
  chrome.tabs.sendMessage(tabId, { type: "TOGGLE_PANEL" }).catch(() => {
    // The content script may not have loaded yet (e.g. the tab was open
    // before the extension was installed/updated) — nothing happens then.
    // Reloading the Twitch tab once after an update is enough to fix it.
  });
}

chrome.action.onClicked.addListener((tab) => {
  togglePanelForTab(tab?.id);
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: CONTEXT_MENU_ID,
    title: "Twitch Chat Logger",
    contexts: ["all"],
    documentUrlPatterns: ["https://www.twitch.tv/*"],
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === CONTEXT_MENU_ID) {
    togglePanelForTab(tab?.id);
  }
});

// MV3 service workers can go to sleep — this wakes it up and checks the connection
chrome.alarms.create("keepAlive", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(() => {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    connect();
  }
});

connect();
