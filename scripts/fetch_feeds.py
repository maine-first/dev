#!/usr/bin/env python3
"""Fetch feeds from config.json, score, filter, dedupe, write feed.json.

Design:
- Per-feed `include` keyword allowlist (compiled once), applied at fetch time.
- Per-feed `max_items` override of global max_per_source.
- Per-feed `tag` carried through to output (e.g. "primary", "poll").
- Global boosts/mutes as before, compiled once.
- Fails safe: keeps existing feed.json if the run would blank it.
"""

import html
import json
import re
import sys
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parent.parent
UA = "Mozilla/5.0 (compatible; MaineFirstBot/1.0; +https://maine-first.github.io/)"
TAG = re.compile(r"<[^>]+>")

# ---------------------------------------------------------------- helpers

def local(tag):
    return tag.rsplit("}", 1)[-1] if isinstance(tag, str) else ""


def clean(s):
    return re.sub(r"\s+", " ", html.unescape(TAG.sub("", s or ""))).strip()


def child_text(el, *names):
    for c in el:
        if local(c.tag) in names and (c.text or "").strip():
            return c.text.strip()
    return ""


def child_link(el):
    fallback = ""
    for c in el:
        if local(c.tag) != "link":
            continue
        href = (c.get("href") or "").strip()
        if href:
            if c.get("rel", "alternate") == "alternate":
                return href
            fallback = fallback or href
        elif (c.text or "").strip():
            return c.text.strip()
    return fallback


def parse_date(s):
    if not s:
        return None
    try:
        d = parsedate_to_datetime(s)
    except (TypeError, ValueError):
        try:
            d = datetime.fromisoformat(s.replace("Z", "+00:00"))
        except ValueError:
            return None
    if d is None:
        return None
    if d.tzinfo is None:
        d = d.replace(tzinfo=timezone.utc)
    return d.astimezone(timezone.utc)


def canon(u):
    p = urlsplit(u)
    return urlunsplit((p.scheme, p.netloc.lower(), p.path.rstrip("/"), "", ""))


def term_regex(term):
    return re.compile(r"(?<!\w)" + re.escape(term) + r"(?!\w)", re.I)


def load_json(path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return default


def pin_item(p):
    """Validate and normalize a manual pin entry."""
    if not isinstance(p, dict):
        return None
    url = str(p.get("url", "")).strip()
    title = clean(p.get("title", ""))
    if not url.startswith(("http://", "https://")) or not title:
        return None
    return {
        "title": title,
        "url": url,
        "source": clean(p.get("source", "")) or "Maine First",
        "tag": (p.get("tag") or "").strip().lower(),
        "published": parse_date(p.get("published")).isoformat(timespec="seconds")
                     if p.get("published") and parse_date(p.get("published")) else None,
    }

# ---------------------------------------------------------------- fetch

def fetch(feed, include_rx, cap):
    """Fetch one feed and return surviving entries, with include filter applied."""
    req = Request(feed["url"], headers={
        "User-Agent": UA,
        "Accept": "application/rss+xml, application/atom+xml, application/xml, text/xml, */*",
    })
    with urlopen(req, timeout=25) as r:
        data = r.read()
    root = ET.fromstring(data)

    out = []
    for el in root.iter():
        if local(el.tag) not in ("item", "entry"):
            continue
        title = clean(child_text(el, "title"))
        link = child_link(el)
        if not title or not link.startswith(("http://", "https://")):
            continue
        if include_rx and not any(rx.search(title) for rx in include_rx):
            continue
        dt = parse_date(child_text(el, "pubDate", "published", "updated", "date"))
        out.append({
            "title": title,
            "url": link,
            "source": feed["name"],
            "tag": (feed.get("tag") or "").strip().lower(),
            "dt": dt,
        })
        if len(out) >= cap:
            break
    return out

# ---------------------------------------------------------------- main

def main():
    cfg = load_json(ROOT / "config.json", None)
    if not cfg:
        print("config.json missing or invalid", file=sys.stderr)
        return 1

    pinned = load_json(ROOT / "pinned.json", {})
    now = datetime.now(timezone.utc)

    boosts = [(term_regex(k), float(w)) for k, w in cfg.get("boosts", {}).items()]
    mutes = [term_regex(m) for m in cfg.get("mutes", [])]
    weights = {f["name"]: float(f.get("weight", 1)) for f in cfg["feeds"]}

    global_cap = int(cfg.get("max_per_source", 10))
    per_feed_cap = {
        f["name"]: int(f.get("max_items", global_cap)) for f in cfg["feeds"]
    }

    # Pre-compile per-feed include filters.
    include_by_feed = {
        f["name"]: [term_regex(t) for t in f.get("include", [])] for f in cfg["feeds"]
    }

    entries = []
    for feed in cfg["feeds"]:
        try:
            got = fetch(feed, include_by_feed[feed["name"]], per_feed_cap[feed["name"]])
            print(f"ok   {feed['name']}: {len(got)} entries")
            entries.extend(got)
        except Exception as e:
            print(f"FAIL {feed['name']}: {e}", file=sys.stderr)

    # ---- score ----
    candidates = []
    for e in entries:
        if any(m.search(e["title"]) for m in mutes):
            continue
        if e["dt"]:
            age_h = (now - e["dt"]).total_seconds() / 3600
            if age_h < 0:
                age_h = 0.0
                print(f"     (future-dated, clamped): {e['title'][:60]}", file=sys.stderr)
        else:
            age_h = 24.0
        if age_h > cfg["max_age_hours"]:
            continue

        score = weights.get(e["source"], 1.0)
        score += cfg["recency_weight"] * 0.5 ** (age_h / cfg["half_life_hours"])
        score += sum(w for rx, w in boosts if rx.search(e["title"]))
        e["score"] = score
        candidates.append(e)

    # ---- rank + dedupe ----
    ranked, seen = [], set()
    for e in sorted(candidates, key=lambda x: x["score"], reverse=True):
        keys = (canon(e["url"]), re.sub(r"\W+", "", e["title"].lower()))
        if any(k in seen for k in keys):
            continue
        seen.update(keys)
        ranked.append(e)

    # ---- per-source cap ----
    counts, picked = {}, []
    for e in ranked:
        cap = per_feed_cap.get(e["source"], global_cap)
        if counts.get(e["source"], 0) >= cap:
            continue
        counts[e["source"]] = counts.get(e["source"], 0) + 1
        picked.append({
            "title": e["title"],
            "url": e["url"],
            "source": e["source"],
            "tag": e["tag"],
            "published": e["dt"].isoformat(timespec="seconds") if e["dt"] else None,
        })

    out_path = ROOT / "feed.json"
    old = load_json(out_path, {})

    # Safety: don't blank the site if this run produced nothing useful.
    if not picked:
        if old.get("items"):
            print("No candidates survived filtering; keeping existing feed.json",
                  file=sys.stderr)
            return 0
        print("No candidates and no prior feed.json; writing empty feed", file=sys.stderr)

    # ---- splash + pins ----
    splash = pin_item(pinned.get("splash"))
    pins = [p for p in (pin_item(x) for x in pinned.get("pins", [])) if p]
    used = {canon(x["url"]) for x in pins + ([splash] if splash else [])}
    rest = [x for x in picked if canon(x["url"]) not in used]
    if not splash and rest:
        splash = rest.pop(0)
    items = (pins + rest)[: cfg["max_items"]]

    # ---- no-op if unchanged ----
    if old.get("splash") == splash and old.get("items") == items:
        print("No change; feed.json left alone")
        return 0

    out_path.write_text(json.dumps({
        "updated": now.isoformat(timespec="seconds"),
        "splash": splash,
        "items": items,
    }, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

    tagged = sum(1 for i in items if i.get("tag"))
    print(f"Wrote feed.json: splash + {len(items)} items ({tagged} tagged)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
