(function () {
  "use strict";

  var REFRESH_MS = 10 * 60 * 1000;
  var RETRY_MS   = 60 * 1000;

  var stampEl    = document.getElementById("stamp");
  var splashEl   = document.getElementById("splash");
  var feedEl     = document.getElementById("feed");
  var roundup    = document.getElementById("roundup");
  var primarySec = document.getElementById("primary-section");
  var primaryEl  = document.getElementById("primary-feed");
  var emptyEl    = document.getElementById("empty");

  var lastJSON = "";
  var timer    = null;

  // ---- helpers ----
  function safeUrl(u) {
    try {
      var x = new URL(u);
      return (x.protocol === "https:" || x.protocol === "http:") ? x.href : null;
    } catch (e) { return null; }
  }

  function ago(iso) {
    if (!iso) return "";
    var t = new Date(iso).getTime();
    if (isNaN(t)) return "";
    var mins = Math.round((Date.now() - t) / 60000);
    if (mins < 0) return "";
    if (mins < 60) return Math.max(mins, 1) + "m ago";
    var hrs = Math.round(mins / 60);
    if (hrs < 24) return hrs + "h ago";
    return Math.round(hrs / 24) + "d ago";
  }

  function sourceLine(item) {
    var span = document.createElement("span");
    span.className = "src";
    var bits = [];
    if (item.source) bits.push(item.source);
    var when = ago(item.published);
    if (when) bits.push(when);
    span.textContent = bits.join(" · ");
    return span;
  }

  function anchor(item, cls) {
    var href = safeUrl(item.url);
    if (!href) return null;
    var a = document.createElement("a");
    a.href = href;
    a.rel = "noopener noreferrer";
    a.target = "_blank";
    a.className = cls || "";
    a.textContent = item.title || "(untitled)";
    return a;
  }

  // ---- splash ----
  function renderSplash(item) {
    splashEl.textContent = "";
    if (!item) { splashEl.hidden = true; return; }
    var a = anchor(item, "pin-title");
    if (!a) { splashEl.hidden = true; return; }

    var art = document.createElement("article");
    art.className = "pin";
    art.appendChild(a);

    var meta = document.createElement("p");
    meta.className = "pin-meta";
    meta.appendChild(sourceLine(item));
    art.appendChild(meta);

    splashEl.appendChild(art);
    splashEl.hidden = false;
  }

  // ---- one feed item ----
  function itemNode(item, badgeText) {
    var a = anchor(item, "item-title");
    if (!a) return null;

    var art = document.createElement("article");

    var h3 = document.createElement("h3");
    h3.className = "item-h";
    h3.appendChild(a);
    if (badgeText) {
      var badge = document.createElement("span");
      badge.className = "tag";
      badge.textContent = badgeText;
      h3.appendChild(badge);
    }
    art.appendChild(h3);

    var meta = document.createElement("p");
    meta.className = "item-meta";
    meta.appendChild(sourceLine(item));
    art.appendChild(meta);

    var li = document.createElement("li");
    li.className = "item";
    li.appendChild(art);
    return li;
  }

  // ---- main feed (untagged) ----
  function renderFeed(items) {
    feedEl.textContent = "";
    if (!items.length) {
      roundup.hidden = true;
      emptyEl.hidden = false;
      emptyEl.textContent = "No Maine headlines right now. Check back soon.";
      return;
    }
    roundup.hidden = false;
    emptyEl.hidden = true;

    var frag = document.createDocumentFragment();
    items.forEach(function (item) {
      var node = itemNode(item, null);
      if (node) frag.appendChild(node);
    });
    feedEl.appendChild(frag);
  }

  // ---- primary section (tagged) ----
  function renderPrimary(items) {
    primaryEl.textContent = "";
    if (!items.length) { primarySec.hidden = true; return; }

    var frag = document.createDocumentFragment();
    items.forEach(function (item) {
      var badge = item.tag === "primary" ? "Primary" : (item.tag === "poll" ? "Poll" : item.tag);
      var node = itemNode(item, badge);
      if (node) frag.appendChild(node);
    });
    primaryEl.appendChild(frag);
    primarySec.hidden = false;
  }

  function renderStamp(data) {
    if (data.updated) {
      var d = new Date(data.updated);
      stampEl.textContent = "Updated " + d.toLocaleString([], {
        weekday: "short", hour: "numeric", minute: "2-digit"
      });
    } else {
      stampEl.textContent = "";
    }
  }

  // ---- load ----
  function schedule(ms) {
    if (timer) clearTimeout(timer);
    timer = setTimeout(function () {
      if (document.visibilityState === "visible") load();
      else schedule(REFRESH_MS);
    }, ms);
  }

  function load() {
    fetch("feed.json?v=" + Math.floor(Date.now() / 60000), { cache: "no-cache" })
      .then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.text();
      })
      .then(function (raw) {
        if (raw === lastJSON) { schedule(REFRESH_MS); return; }
        lastJSON = raw;

        var data = JSON.parse(raw);
        var all = (data.items || []).slice();

        // sort newest first
        all.sort(function (a, b) {
          return new Date(b.published || 0) - new Date(a.published || 0);
        });

        // splash should be Maine-only if possible
        var splash = data.splash;
        if (splash && splash.tag) {
          splash = all.filter(function (i) { return !i.tag; })[0] || splash;
        }

        var tagged   = all.filter(function (i) { return !!i.tag; });
        var untagged = all.filter(function (i) { return !i.tag; });

        renderSplash(splash);
        renderFeed(untagged);
        renderPrimary(tagged);
        renderStamp(data);
        schedule(REFRESH_MS);
      })
      .catch(function (err) {
        console.error(err);
        stampEl.textContent = "Couldn't load feed.json. Retrying shortly…";
        schedule(RETRY_MS);
      });
  }

  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible") load();
  });

  load();
})();
