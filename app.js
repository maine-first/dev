(function () {
  "use strict";

  var REFRESH_MS = 10 * 60 * 1000;
  var stamp = document.getElementById("stamp");
  var splashEl = document.getElementById("splash");
  var cols = [1, 2, 3].map(function (n) { return document.getElementById("col-" + n); });

  function safeUrl(u) {
    try {
      var x = new URL(u);
      return x.protocol === "https:" || x.protocol === "http:" ? x.href : null;
    } catch (e) {
      return null;
    }
  }

  function ago(iso) {
    if (!iso) return "";
    var mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
    if (isNaN(mins) || mins < 0) return "";
    if (mins < 60) return Math.max(mins, 1) + "m ago";
    var hrs = Math.round(mins / 60);
    if (hrs < 24) return hrs + "h ago";
    return Math.round(hrs / 24) + "d ago";
  }

  function sourceLine(item) {
    var span = document.createElement("span");
    span.className = "src";
    var when = ago(item.published);
    span.textContent = [item.source, when].filter(Boolean).join(", ");
    return span;
  }

  function anchor(item) {
    var href = safeUrl(item.url);
    if (!href) return null;
    var a = document.createElement("a");
    a.href = href;
    a.rel = "noopener noreferrer";
    a.target = "_blank";
    a.textContent = item.title;
    return a;
  }

  function render(data) {
    splashEl.textContent = "";
    cols.forEach(function (c) { c.textContent = ""; });

    if (data.splash) {
      var sa = anchor(data.splash);
      if (sa) {
        splashEl.appendChild(sa);
        var sl = sourceLine(data.splash);
        splashEl.appendChild(sl);
      }
    }

    var items = data.items || [];
    var per = Math.ceil(items.length / 3) || 1;
    items.forEach(function (item, i) {
      var a = anchor(item);
      if (!a) return;
      var li = document.createElement("li");
      li.appendChild(a);
      li.appendChild(sourceLine(item));
      cols[Math.min(Math.floor(i / per), 2)].appendChild(li);
    });

    if (!data.splash && !items.length) {
      stamp.textContent = "No stories yet. The first refresh runs within half an hour.";
    } else if (data.updated) {
      stamp.textContent = "Updated " + new Date(data.updated).toLocaleString([], {
        weekday: "short", hour: "numeric", minute: "2-digit"
      });
    } else {
      stamp.textContent = "";
    }
  }

  function load() {
    fetch("feed.json", { cache: "no-cache" })
      .then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      })
      .then(render)
      .catch(function () {
        stamp.textContent = "Couldn't load feed.json. Reload to try again.";
      });
  }

  load();
  setInterval(load, REFRESH_MS);
})();
