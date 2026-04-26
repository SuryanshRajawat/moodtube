"""
MoodTube backend — resolves YouTube suggestions.
Primary mode: YouTube Data API v3 using YOUTUBE_API_KEY.
Fallback mode: yt-dlp scraping if API key is not set.

Run: pip install -r requirements.txt && python server.py
Then open http://127.0.0.1:8080/
"""

from __future__ import annotations

import json
import os
import sys
import urllib.parse
import urllib.request

from flask import Flask, jsonify, request, send_from_directory

ROOT = os.path.dirname(os.path.abspath(__file__))

try:
    import yt_dlp
except ImportError:
    yt_dlp = None

KIND_KEYWORDS = {
    "song": "official music audio",
    "comedy": "comedy funny sketch",
    "action": "action movie scene",
    "romance": "romantic love movie",
    "documentary": "documentary nature history",
    "trailer": "official trailer",
    "indian": "bollywood hindi song",
}


def _norm(s: str) -> str:
    return (s or "").strip().lower()


def map_kind_to_type(kind: str) -> str:
    k = _norm(kind)
    if not k or k == "indian":
        return ""
    return {
        "song": "song",
        "comedy": "podcast",
        "action": "motivation",
        "romance": "song",
        "documentary": "education",
        "trailer": "interview",
    }.get(k, "")


def build_search_query(mood: str, kind: str, optional: str) -> str:
    parts: list[str] = []
    opt = (optional or "").strip()
    mood_l = _norm(mood)
    kind_l = _norm(kind)

    if opt:
        parts.append(opt)
    if mood_l:
        parts.append(f"{mood_l} mood")
        parts.append(mood_l)
    if kind_l == "indian" or mood_l == "indian":
        parts.extend(["bollywood", "hindi", "indian"])
    elif kind_l and kind_l in KIND_KEYWORDS:
        parts.append(KIND_KEYWORDS[kind_l])

    q = " ".join(parts).replace("  ", " ").strip()
    return q or "popular music videos trending today"


def scrape_youtube(query: str, max_results: int, mood: str, kind: str) -> list[dict]:
    if yt_dlp is None:
        raise RuntimeError('Install dependencies: pip install -r requirements.txt (needs "yt-dlp")')

    mood_l = _norm(mood)
    kind_l = _norm(kind)
    type_slug = map_kind_to_type(kind_l) or "video"

    ydl_opts: dict = {
        "quiet": True,
        "no_warnings": True,
        "extract_flat": True,
        "playlistend": max_results,
        "socket_timeout": 25,
    }

    search_url = f"ytsearch{max_results}:{query}"
    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        info = ydl.extract_info(search_url, download=False)

    entries = info.get("entries") or []
    out: list[dict] = []
    for e in entries:
        if not e:
            continue
        vid = e.get("id")
        if not vid or len(str(vid)) != 11:
            continue
        title = (e.get("title") or "").strip() or "Untitled"
        creator = (
            e.get("uploader")
            or e.get("channel")
            or e.get("uploader_id")
            or "YouTube"
        )

        moods: list[str] = []
        if mood_l:
            moods.append(mood_l)
        if kind_l == "indian" or mood_l == "indian":
            moods.append("indian")
        if not moods:
            moods.append("trending")

        types = [type_slug] if type_slug else ["video"]

        out.append(
            {
                "title": title,
                "creator": str(creator),
                "youtubeId": str(vid),
                "moods": moods,
                "type": types,
            }
        )

    return out


def _api_videos_from_items(items: list[dict], mood: str, kind: str) -> list[dict]:
    mood_l = _norm(mood)
    kind_l = _norm(kind)
    type_slug = map_kind_to_type(kind_l) or "video"

    out: list[dict] = []
    for item in items:
        if not isinstance(item, dict):
            continue
        id_obj = item.get("id") or {}
        snippet = item.get("snippet") or {}
        vid = id_obj.get("videoId")
        if not vid or len(str(vid)) != 11:
            continue

        title = (snippet.get("title") or "").strip() or "Untitled"
        creator = (snippet.get("channelTitle") or "YouTube").strip()

        moods: list[str] = []
        if mood_l:
            moods.append(mood_l)
        if kind_l == "indian" or mood_l == "indian":
            moods.append("indian")
        if not moods:
            moods.append("trending")

        types = [type_slug] if type_slug else ["video"]
        out.append(
            {
                "title": title,
                "creator": creator,
                "youtubeId": str(vid),
                "moods": moods,
                "type": types,
            }
        )
    return out


def search_youtube_api(query: str, max_results: int, mood: str, kind: str) -> list[dict]:
    api_key = (os.environ.get("YOUTUBE_API_KEY") or "").strip()
    if not api_key:
        raise RuntimeError("Missing YOUTUBE_API_KEY")

    params = {
        "part": "snippet",
        "q": query,
        "type": "video",
        "maxResults": str(max(1, min(max_results, 50))),
        "safeSearch": "moderate",
        "key": api_key,
    }
    url = "https://www.googleapis.com/youtube/v3/search?" + urllib.parse.urlencode(params)

    req = urllib.request.Request(
        url,
        headers={
            "Accept": "application/json",
            "User-Agent": "MoodTube/1.0",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except Exception as e:
        raise RuntimeError(f"YouTube API request failed: {e}") from e

    if not isinstance(data, dict):
        raise RuntimeError("Invalid YouTube API response")
    if data.get("error"):
        msg = data["error"].get("message") if isinstance(data["error"], dict) else str(data["error"])
        raise RuntimeError(f"YouTube API error: {msg}")

    items = data.get("items") or []
    return _api_videos_from_items(items, mood, kind)


app = Flask(__name__)


@app.route("/api/suggestions", methods=["GET"])
def api_suggestions():
    mood = request.args.get("mood", "") or ""
    kind = request.args.get("kind", "") or ""
    optional = request.args.get("optional", "") or ""

    q = build_search_query(mood, kind, optional)
    try:
        videos = search_youtube_api(q, max_results=24, mood=mood, kind=kind)
        if not videos:
            videos = scrape_youtube(q, max_results=24, mood=mood, kind=kind)
        return jsonify({"ok": True, "query": q, "videos": videos})
    except Exception as e:
        err = str(e)
        # Fallback to yt-dlp for environments where API key isn't configured yet.
        if "Missing YOUTUBE_API_KEY" in err:
            try:
                videos = scrape_youtube(q, max_results=24, mood=mood, kind=kind)
                return jsonify({"ok": True, "query": q, "videos": videos, "source": "yt-dlp-fallback"})
            except Exception as fallback_err:
                return jsonify({"ok": False, "error": str(fallback_err), "query": q}), 500
        return jsonify({"ok": False, "error": err, "query": q}), 500


@app.route("/")
def index():
    return send_from_directory(ROOT, "index.html")


def _static(name: str, mimetype: str | None = None):
    return send_from_directory(ROOT, name, mimetype=mimetype)


@app.route("/app.js")
def app_js():
    return _static("app.js", "application/javascript")


@app.route("/styles.css")
def styles_css():
    return _static("styles.css", "text/css")


@app.route("/data.js")
def data_js():
    return _static("data.js", "application/javascript")


def main() -> None:
    port = int(os.environ.get("PORT", "8080"))
    print(f"MoodTube: http://127.0.0.1:{port}/", file=sys.stderr)
    if os.environ.get("YOUTUBE_API_KEY"):
        print("YouTube API mode: enabled (YOUTUBE_API_KEY detected)", file=sys.stderr)
    else:
        print(
            "YouTube API mode: disabled (set YOUTUBE_API_KEY to use official API); falling back to yt-dlp",
            file=sys.stderr,
        )
    if yt_dlp is None:
        print("Warning: yt-dlp not installed. pip install yt-dlp", file=sys.stderr)
    app.run(host="127.0.0.1", port=port, debug=False, use_reloader=False)


if __name__ == "__main__":
    main()
