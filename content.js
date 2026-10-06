// content.js
//
// 1) Highlights and restores the text of deleted messages right inside the
//    native Twitch chat (Twitch tries to replace them with "Message deleted
//    by a moderator" — we detect that and put the original text back).
// 2) Manages its own panel listing ONLY the deleted messages.
//    The panel opens/closes when the toolbar icon or the right-click menu
//    item is clicked (a TOGGLE_PANEL message from background.js) — it does
//    NOT close itself on an outside click, since it's a regular page
//    element, not a browser popup, and stays alive as long as the tab is open.

// --- Native Twitch chat selectors ------------------------------------------
// NOTE: Twitch has no official API for its own chat markup, so matching is
// done heuristically. If Twitch changes the markup and the highlighting
// stops working, start by checking these selectors.
const SELECTORS = {
  chatContainer: [
    '.chat-scrollable-area__message-container',
    '[data-test-selector="chat-scrollable-area__message-container"]',
  ],
  messageLine: [
    '.chat-line__message',
    '[data-a-target="chat-line-message"]',
  ],
  username: [
    '[data-a-target="chat-message-username"]',
    '.chat-line__username',
  ],
  messageBody: [
    '[data-a-target="chat-line-message-body"]',
  ],
};

const IGNORED_FIRST_SEGMENTS = new Set([
  "", "directory", "downloads", "jobs", "turbo", "subscriptions",
  "wallet", "drops", "settings", "friends", "inventory", "prime",
  "p", "creatorcamp", "broadcast", "videos", "search",
]);

const PENDING_TTL_MS = 8000; // how long to wait for a matching DOM element for a message
const ENFORCE_ATTEMPTS = 15; // how many times to force the restored text back
const ENFORCE_INTERVAL_MS = 200; // interval between attempts (~3 seconds total)

let currentChannel = null;
let pendingQueue = []; // { id, user, userLogin, text, color, emotes, deadline }
const idToInfo = new Map(); // msgId -> { el, id, originalText, user, color, emotes, guarding }
let chatObserver = null;
let containerPollTimer = null;
let channelEmoteMap = {}; // code -> image URL (third-party: BTTV/FFZ/7TV, merged global+channel)

// --- Deleted-messages panel --------------------------------------------------
let panelEl = null;
let listEl = null;
let statusEl = null;
let panelVisible = false;
const deletedLog = []; // { id, user, color, text }

function queryFirst(root, selectors) {
  for (const sel of selectors) {
    const el = root.querySelector?.(sel);
    if (el) return el;
  }
  return null;
}

// In reply messages (Replying to @X: ...) Twitch renders the quoted preview
// with the same selector as the new message's own body. The preview comes
// EARLIER in the markup, so we need the last matching element, not the first.
function queryLast(root, selectors) {
  for (const sel of selectors) {
    const all = root.querySelectorAll?.(sel);
    if (all && all.length) return all[all.length - 1];
  }
  return null;
}

function matchesAny(el, selectors) {
  return selectors.some((sel) => el.matches?.(sel));
}

function normalize(str) {
  return (str || "").trim().toLowerCase();
}

// Emote-only messages are rendered by Twitch as <img> tags with no text
// nodes — textContent is empty for them. Emote images keep their code (the
// same one that arrives in the IRC text) in the alt attribute, so we walk
// the DOM manually and use alt instead of textContent for images.
function extractDisplayText(el) {
  if (!el) return "";
  let result = "";
  const walk = (node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      result += node.textContent;
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      if (node.tagName === "IMG") {
        const alt = node.getAttribute("alt") || "";
        if (alt) {
          if (result && !/\s$/.test(result)) result += " ";
          result += alt;
        }
      } else {
        for (const child of node.childNodes) walk(child);
      }
    }
  };
  walk(el);
  return result;
}

function getChannelFromPath() {
  const seg = location.pathname.split("/").filter(Boolean)[0];
  if (!seg) return null;
  if (IGNORED_FIRST_SEGMENTS.has(seg.toLowerCase())) return null;
  return seg.toLowerCase();
}

// --- Building rich message content: plain text + emote images --------------
//
// Two kinds of emotes need different handling:
//  - Native Twitch emotes have exact character positions from the PRIVMSG
//    "emotes" tag (UTF-16 code unit offsets — same as JS string indexing).
//  - Third-party emotes (BTTV/FFZ/7TV) have no positions at all; they're
//    just whole words, matched by exact code against the channel's emote map.
//
// Twitch CDN URL pattern (default/dark background, size 2 = ~56px, displayed
// at 28px for a crisp look on high-DPI screens).
function twitchEmoteUrl(id) {
  return `https://static-cdn.jtvnw.net/emoticons/v2/${id}/default/dark/2.0`;
}

function buildMessageSegments(text, twitchEmotes, emoteMap) {
  const segments = [];

  const pushThirdPartyTokenized = (str) => {
    if (!str) return;
    // Split on whitespace but keep the whitespace itself as separate
    // segments, so spacing between words/emotes is preserved exactly.
    for (const part of str.split(/(\s+)/)) {
      if (!part) continue;
      if (/^\s+$/.test(part)) {
        segments.push({ type: "text", value: part });
        continue;
      }
      const url = emoteMap && emoteMap[part];
      if (url) {
        segments.push({ type: "emote", url, code: part });
      } else {
        segments.push({ type: "text", value: part });
      }
    }
  };

  const ranges = (twitchEmotes || []).slice().sort((a, b) => a.start - b.start);
  let cursor = 0;
  for (const r of ranges) {
    if (r.start > cursor) pushThirdPartyTokenized(text.slice(cursor, r.start));
    if (r.start >= cursor && r.end >= r.start) {
      const code = text.slice(r.start, r.end + 1);
      segments.push({ type: "emote", url: twitchEmoteUrl(r.id), code });
      cursor = r.end + 1;
    }
  }
  if (cursor < text.length) pushThirdPartyTokenized(text.slice(cursor));

  return segments;
}

function renderSegmentsInto(container, segments) {
  container.textContent = "";
  for (const seg of segments) {
    if (seg.type === "text") {
      container.appendChild(document.createTextNode(seg.value));
      continue;
    }
    const img = document.createElement("img");
    img.src = seg.url;
    img.alt = seg.code;
    img.title = seg.code;
    img.className = "tdm-emote";
    img.loading = "lazy";
    // If the image 404s (removed/expired emote), fall back to plain text so
    // the message still reads correctly instead of showing a broken icon.
    img.addEventListener(
      "error",
      () => {
        img.replaceWith(document.createTextNode(seg.code));
      },
      { once: true }
    );
    container.appendChild(img);
  }
}

// --- Matching incoming IRC messages to DOM elements -------------------------

function enqueuePending(msg) {
  const now = Date.now();
  pendingQueue = pendingQueue.filter((m) => m.deadline > now);
  pendingQueue.push({ ...msg, deadline: now + PENDING_TTL_MS });
}

function tryMatchElement(lineEl) {
  if (lineEl.dataset.tdmId) return; // already matched earlier

  // queryLast — so we don't grab the quoted text from "Replying to @X: ..."
  // instead of the actual new message's text.
  const usernameEl = queryLast(lineEl, SELECTORS.username);
  const bodyEl = queryLast(lineEl, SELECTORS.messageBody) || lineEl;
  const domUser = normalize(usernameEl?.textContent);
  const domText = normalize(extractDisplayText(bodyEl));
  if (!domText) return;

  const now = Date.now();
  pendingQueue = pendingQueue.filter((m) => m.deadline > now);
  if (!pendingQueue.length) return;

  // Score each candidate: a username match is a reliable signal, a text
  // match alone is not (replies to the same post can share an identical
  // quoted fragment across different people).
  let bestIdx = -1;
  let bestScore = 0;
  pendingQueue.forEach((m, i) => {
    const candUser = normalize(m.user);
    const candLogin = normalize(m.userLogin);
    const userMatches =
      !!domUser &&
      (domUser === candUser ||
        domUser === candLogin ||
        domUser.includes(candUser) ||
        domUser.includes(candLogin));
    const candText = normalize(m.text);
    const sampleLen = Math.min(30, candText.length) || 1;
    const textMatches = !!candText && domText.includes(candText.slice(0, sampleLen));

    let score = 0;
    if (userMatches && textMatches) score = 3;
    else if (userMatches) score = 2;
    else if (textMatches) score = 1;

    if (score > bestScore) {
      bestScore = score;
      bestIdx = i;
    }
  });

  // We ONLY tag a message when the username genuinely matched (score >= 2).
  // The previous "only one candidate left, so it must be this one" fallback
  // was removed: if an unrelated DOM line (a system/announcement message
  // that also matches our line selector) steals a slot from the queue, that
  // fallback could end up pinning the wrong user's id onto some other
  // person's message. Requiring a real username match makes that impossible.
  const idx = bestScore >= 2 ? bestIdx : -1;
  // Not confident enough — better to leave the message untagged (no
  // highlight in the chat itself for this one) than to highlight the wrong
  // user. The extension panel still logs it correctly either way — that
  // part works independently of this DOM matching.
  if (idx === -1) return;

  const matched = pendingQueue.splice(idx, 1)[0];
  lineEl.dataset.tdmId = matched.id;
  idToInfo.set(matched.id, {
    el: lineEl,
    id: matched.id,
    originalText: matched.text,
    user: matched.user,
    color: matched.color,
    emotes: matched.emotes,
    guarding: false,
  });
}

// --- Watching for new chat messages -----------------------------------------

function attachChatObserver() {
  const container = queryFirst(document, SELECTORS.chatContainer);
  if (!container) return false;

  if (chatObserver) chatObserver.disconnect();
  chatObserver = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (!(node instanceof HTMLElement)) continue;
        const lineEl = matchesAny(node, SELECTORS.messageLine)
          ? node
          : queryFirst(node, SELECTORS.messageLine);
        if (lineEl) tryMatchElement(lineEl);
      }
    }
  });
  chatObserver.observe(container, { childList: true, subtree: true });
  return true;
}

function ensureChatObserverAttached() {
  if (attachChatObserver()) return;
  if (containerPollTimer) return;
  containerPollTimer = setInterval(() => {
    if (attachChatObserver()) {
      clearInterval(containerPollTimer);
      containerPollTimer = null;
    }
  }, 1000);
}

// --- Restoring text and highlighting deleted messages in the native chat ---

// After CLEARMSG, Twitch re-renders the message line (React), replacing its
// contents with "Message deleted by a moderator." It may rebuild not just
// the text but the nested nodes entirely. So we:
//  - watch the whole line (el), not a single text node,
//  - on every change, re-find the current node that holds the message text,
//  - if Twitch tore down the entire inner structure, rebuild the line
//    ourselves (username + original text) so the message is never lost.

function rebuildWholeLine(el, info) {
  el.textContent = "";
  const userSpan = document.createElement("span");
  userSpan.style.color = info.color;
  userSpan.style.fontWeight = "600";
  userSpan.textContent = info.user + ": ";
  const textSpan = document.createElement("span");
  renderSegmentsInto(textSpan, buildMessageSegments(info.originalText, info.emotes, channelEmoteMap));
  el.appendChild(userSpan);
  el.appendChild(textSpan);
  el.dataset.tdmRebuilt = info.id;
}

function enforceOriginalText(info) {
  const { el, originalText } = info;
  if (!el.isConnected) return;

  const bodyEl = queryLast(el, SELECTORS.messageBody);
  if (bodyEl) {
    // A marker on the node itself, not a text comparison: rendered emote
    // images don't show up in textContent, so comparing reconstructed text
    // against the original would be unreliable. If Twitch replaces the DOM
    // node, the fresh node simply won't carry our marker, which correctly
    // triggers a re-render.
    if (bodyEl.dataset.tdmRendered !== info.id) {
      renderSegmentsInto(bodyEl, buildMessageSegments(originalText, info.emotes, channelEmoteMap));
      bodyEl.dataset.tdmRendered = info.id;
    }
  } else if (el.dataset.tdmRebuilt !== info.id) {
    rebuildWholeLine(el, info);
  }
}

function applyDeletedStyle(id) {
  let info = idToInfo.get(id);

  // If DOM matching didn't succeed but we have the message data from the
  // background — it's still recorded in the panel (see recordDeleted below),
  // just without a highlight in the chat itself (element wasn't found).
  if (!info) return;
  if (!info.el.isConnected) return;

  info.el.classList.add("tdm-native-deleted");
  enforceOriginalText(info);

  if (info.guarding) return;
  info.guarding = true;

  const observer = new MutationObserver(() => enforceOriginalText(info));
  observer.observe(info.el, { childList: true, subtree: true, characterData: true });

  // Extra safety net: React sometimes updates the DOM in several mutations
  // with small pauses between them — force it again for ~3 seconds just in case.
  let attempts = 0;
  const iv = setInterval(() => {
    enforceOriginalText(info);
    attempts += 1;
    if (attempts >= ENFORCE_ATTEMPTS) clearInterval(iv);
  }, ENFORCE_INTERVAL_MS);
}

// --- Deleted-messages panel --------------------------------------------------

function ensurePanel() {
  if (panelEl) return;

  panelEl = document.createElement("div");
  panelEl.id = "tdm-panel";
  panelEl.classList.add("tdm-panel-hidden");

  const header = document.createElement("div");
  header.id = "tdm-header";

  const title = document.createElement("span");
  title.id = "tdm-title";
  title.textContent = "Deleted Messages";
  header.appendChild(title);

  statusEl = document.createElement("span");
  statusEl.id = "tdm-status";
  statusEl.textContent = currentChannel ? "channel: " + currentChannel : "…";
  header.appendChild(statusEl);

  const closeBtn = document.createElement("button");
  closeBtn.id = "tdm-close";
  closeBtn.type = "button";
  closeBtn.setAttribute("aria-label", "Close panel");
  closeBtn.addEventListener("click", () => setPanelVisible(false));
  header.appendChild(closeBtn);

  panelEl.appendChild(header);

  listEl = document.createElement("div");
  listEl.id = "tdm-list";
  panelEl.appendChild(listEl);

  document.body.appendChild(panelEl);
  makeDraggable(panelEl, header, closeBtn);

  for (const entry of deletedLog) {
    renderDeletedItem(entry);
  }
}

function makeDraggable(panel, handle, ignoreEl) {
  let offsetX = 0;
  let offsetY = 0;
  let dragging = false;

  handle.addEventListener("mousedown", (e) => {
    if (e.target === ignoreEl) return;
    dragging = true;
    const rect = panel.getBoundingClientRect();
    offsetX = e.clientX - rect.left;
    offsetY = e.clientY - rect.top;
  });

  document.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    panel.style.left = e.clientX - offsetX + "px";
    panel.style.top = e.clientY - offsetY + "px";
    panel.style.right = "auto";
  });

  document.addEventListener("mouseup", () => {
    dragging = false;
  });
}

function formatTime(ts) {
  if (!ts) return "";
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function formatFullDateTime(ts) {
  if (!ts) return "";
  return new Date(ts).toLocaleString();
}

function isNearBottom(el, threshold = 24) {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= threshold;
}

function renderDeletedItem(msg) {
  if (!listEl) return;
  if (document.getElementById("tdm-item-" + msg.id)) return;

  // Only auto-scroll if the user was already at (or near) the bottom before
  // this message was added — otherwise scrolling up to read older deleted
  // messages would keep getting yanked back down by new arrivals.
  const shouldStickToBottom = panelVisible && isNearBottom(listEl);

  const el = document.createElement("div");
  el.id = "tdm-item-" + msg.id;
  el.className = "tdm-msg";

  const timeSpan = document.createElement("span");
  timeSpan.className = "tdm-time";
  timeSpan.textContent = formatTime(msg.ts);
  timeSpan.title = msg.deletedTs
    ? "Deleted: " + formatFullDateTime(msg.deletedTs)
    : "Deletion time unknown";

  const userSpan = document.createElement("span");
  userSpan.className = "tdm-user";
  userSpan.style.color = msg.color;
  userSpan.textContent = msg.user + ": ";

  const textSpan = document.createElement("span");
  textSpan.className = "tdm-text";
  renderSegmentsInto(textSpan, buildMessageSegments(msg.text, msg.emotes, channelEmoteMap));

  el.appendChild(timeSpan);
  el.appendChild(userSpan);
  el.appendChild(textSpan);
  listEl.appendChild(el);

  if (shouldStickToBottom) {
    listEl.scrollTop = listEl.scrollHeight;
  }
}

function recordDeleted(msg) {
  if (!msg || !msg.id) return;
  if (deletedLog.some((m) => m.id === msg.id)) return;
  deletedLog.push(msg);
  renderDeletedItem(msg);
}

function setPanelVisible(visible) {
  ensurePanel();
  panelVisible = visible;
  panelEl.classList.toggle("tdm-panel-hidden", !panelVisible);
  if (statusEl) {
    statusEl.textContent = currentChannel ? "channel: " + currentChannel : "not on a channel page";
  }
  if (panelVisible && listEl) {
    // The panel may have accumulated messages while hidden (scrollHeight is
    // not computed for a display:none element) — scroll down after it's shown.
    listEl.scrollTop = listEl.scrollHeight;
  }
}

function togglePanel() {
  setPanelVisible(!panelVisible);
}

function clearPanelForNewChannel() {
  deletedLog.length = 0;
  if (listEl) listEl.innerHTML = "";
}

function loadDeletedHistory(channel) {
  chrome.runtime.sendMessage({ type: "GET_DELETED_HISTORY", channel }, (res) => {
    if (chrome.runtime.lastError) return;
    const deleted = res?.deleted || [];
    for (const msg of deleted) recordDeleted(msg);
  });
}

function loadEmoteMap(channel) {
  chrome.runtime.sendMessage({ type: "GET_EMOTE_MAP", channel }, (res) => {
    if (chrome.runtime.lastError) return;
    // Only apply if we're still on the same channel (avoids a slow response
    // clobbering the map after the user already switched channels).
    if (channel === currentChannel) channelEmoteMap = res?.emoteMap || {};
  });
}

// --- Registering the current tab/channel with the background script --------

function registerForChannel(channel) {
  currentChannel = channel;
  pendingQueue = [];
  idToInfo.clear();
  channelEmoteMap = {};
  clearPanelForNewChannel();
  ensureChatObserverAttached();
  if (statusEl) statusEl.textContent = "channel: " + channel;

  chrome.runtime.sendMessage({ type: "REGISTER", channel }, () => {
    if (chrome.runtime.lastError) return;
  });
  loadDeletedHistory(channel);
  loadEmoteMap(channel);
}

function checkChannelChange() {
  const channel = getChannelFromPath();
  if (channel === currentChannel) return;

  if (channel) {
    registerForChannel(channel);
  } else {
    currentChannel = null;
    channelEmoteMap = {};
    chrome.runtime.sendMessage({ type: "UNREGISTER" });
    if (chatObserver) {
      chatObserver.disconnect();
      chatObserver = null;
    }
    clearPanelForNewChannel();
    if (statusEl) statusEl.textContent = "not on a channel page";
  }
}

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "NEW_MESSAGE") {
    enqueuePending(message.message);
  } else if (message.type === "DELETE_MESSAGE") {
    applyDeletedStyle(message.id);
    if (message.message) recordDeleted(message.message);
  } else if (message.type === "DELETE_MANY") {
    for (const id of message.ids) applyDeletedStyle(id);
    if (message.messages) {
      for (const m of message.messages) recordDeleted(m);
    }
  } else if (message.type === "TOGGLE_PANEL") {
    togglePanel();
  } else if (message.type === "EMOTE_MAP_READY") {
    if (currentChannel) channelEmoteMap = message.emoteMap || {};
  }
});

setInterval(checkChannelChange, 1500);
checkChannelChange();

// The background service worker can be evicted and restarted by the browser
// at any time (normal Manifest V3 behavior). When that happens it loses all
// of its in-memory state, including which channel this tab is on — and
// since we only re-register on an actual channel change, we'd otherwise
// silently stop receiving chat events until the user navigates away and
// back. This heartbeat catches that and re-registers automatically.
setInterval(() => {
  if (!currentChannel) return;
  chrome.runtime.sendMessage({ type: "ENSURE_REGISTERED", channel: currentChannel }, () => {
    if (chrome.runtime.lastError) return;
  });
}, 20000);

window.addEventListener("beforeunload", () => {
  chrome.runtime.sendMessage({ type: "UNREGISTER" });
});
