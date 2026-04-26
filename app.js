(function () {
  const CORE_MOODS = ["happy", "sad", "motivational", "chill", "focus", "learning"];

  let optionalDebounce;
  /** @type {object[]} */
  let lastFetchedCatalog = [];
  /** @type {Map<string, object[]>} */
  const searchCache = new Map();

  const els = {
    mood: document.getElementById("mood"),
    kind: document.getElementById("kind"),
    industry: document.getElementById("industry"),
    optional: document.getElementById("optional"),
    limit: document.getElementById("limit"),
    grid: document.getElementById("grid"),
    empty: document.getElementById("empty"),
    resultCount: document.getElementById("resultCount"),
    btnSuggest: document.getElementById("btnSuggest"),
    btnReset: document.getElementById("btnReset"),
    playerDock: document.getElementById("playerDock"),
    dockFrame: document.getElementById("dockFrame"),
    playerModal: document.getElementById("playerModal"),
    playerFrame: document.getElementById("playerFrame"),
    closeModal: document.getElementById("closeModal"),
    closeDock: document.getElementById("closeDock"),
  };

  function norm(s) {
    return String(s || "")
      .toLowerCase()
      .trim();
  }

  function uniqSortedCi(values) {
    return [...new Set(values.map((v) => String(v).toLowerCase()))].sort((a, b) => a.localeCompare(b));
  }

  function moodSeedList() {
    const fromWindow = Array.isArray(window.MOOD_OPTIONS) ? window.MOOD_OPTIONS : [];
    const fromLib = [];
    const lib = Array.isArray(window.VIDEO_LIBRARY) ? window.VIDEO_LIBRARY : [];
    for (const v of lib) {
      (v.moods || []).forEach((m) => fromLib.push(m));
    }
    return uniqSortedCi([...CORE_MOODS, ...fromWindow, ...fromLib]);
  }

  function mapKindToType(kindValue) {
    const k = norm(kindValue);
    if (!k || k === "indian") return "";
    const map = {
      song: "song",
      comedy: "podcast",
      action: "motivation",
      sports: "sports",
      documentary: "education",
      trailer: "interview",
    };
    return map[k] || "";
  }

  function readFiltersFromDom() {
    const kindVal = els.kind.value;
    const industryVal = els.industry ? els.industry.value : "";
    const limitVal = parseInt(els.limit && els.limit.value ? els.limit.value : "24", 10);
    return {
      mood: els.mood.value,
      optional: els.optional ? els.optional.value : "",
      type: mapKindToType(kindVal),
      legacyKind: kindVal,
      industry: industryVal,
      limit: Number.isFinite(limitVal) ? limitVal : 24,
    };
  }

  function hasActiveFilters(filters) {
    return !!(norm(filters.mood) || norm(filters.legacyKind) || norm(filters.optional));
  }

  async function fetchSuggestionsFromServer(filters) {
    if (!Number.isFinite(filters.limit) || filters.limit < 10 || filters.limit > 50) {
      throw new Error("Out of limit. Please choose a value between 10 and 50.");
    }

    const p = new URLSearchParams();
    if (norm(filters.mood)) p.set("mood", filters.mood.trim());
    if (norm(filters.legacyKind)) p.set("kind", filters.legacyKind.trim());
    if (norm(filters.industry)) p.set("industry", filters.industry.trim());
    if (norm(filters.optional)) p.set("optional", filters.optional.trim());
    p.set("limit", String(filters.limit));

    const res = await fetch(`/api/suggestions?${p.toString()}`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || data.message || res.statusText || "Server error");
    }
    if (!data.ok) {
      throw new Error(data.error || "Search failed");
    }
    return data;
  }

  function cacheKeyForFilters(filters) {
    return [
      norm(filters.mood),
      norm(filters.legacyKind),
      norm(filters.industry),
      norm(filters.optional),
      String(filters.limit || ""),
    ].join("|");
  }

  /**
   * @param {{ mood?: string, optional?: string, type?: string, legacyKind?: string }} filters
   * @param {object[]} catalog
   */
  function filterVideos(filters, catalog) {
    const data = Array.isArray(catalog) ? catalog : [];
    const moodN = norm(filters.mood);
    const optN = norm(filters.optional);
    const typeN = norm(filters.type);
    const legacyN = norm(filters.legacyKind);

    return data.filter((v) => {
      if (legacyN === "indian" || norm(filters.mood) === "indian") {
        if (!(v.moods || []).map(norm).includes("indian")) return false;
      }
      if (moodN && !(v.moods || []).map(norm).includes(moodN)) return false;
      if (optN && !norm(v.creator).includes(optN) && !norm(v.title).includes(optN)) {
        return false;
      }
      if (typeN) {
        const types = (v.type || []).map(norm);
        if (!types.includes(typeN)) return false;
      }
      return true;
    });
  }

  /**
   * @param {object[]} list
   * @param {number} count
   */
  function getRandomSuggestions(list, count) {
    const arr = list.slice();
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    const n = Math.max(0, Math.min(count, arr.length));
    return arr.slice(0, n);
  }

  function thumbUrl(youtubeId) {
    return `https://img.youtube.com/vi/${encodeURIComponent(youtubeId)}/mqdefault.jpg`;
  }

  function embedSrc(youtubeId) {
    const params = new URLSearchParams({
      rel: "0",
      enablejsapi: "1",
      playsinline: "1",
      origin: window.location.origin,
    });
    return `https://www.youtube.com/embed/${encodeURIComponent(youtubeId)}?${params.toString()}`;
  }

  function pauseOtherEmbeds(activeFrame) {
    const frames = els.grid.querySelectorAll("iframe");
    for (const frame of frames) {
      if (frame === activeFrame) continue;
      try {
        frame.contentWindow.postMessage(
          JSON.stringify({
            event: "command",
            func: "pauseVideo",
            args: [],
          }),
          "*"
        );
        frame.contentWindow.postMessage(
          JSON.stringify({
            event: "command",
            func: "stopVideo",
            args: [],
          }),
          "*"
        );
      } catch (_) {
        // Ignore cross-origin / unloaded iframe messaging errors.
      }
    }
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function tagMarkup(video) {
    const moods = (video.moods || []).map((m) => `<span class="kind-pill">${escapeHtml(m)}</span>`);
    const types = (video.type || []).map((t) => `<span class="kind-pill tag-pill">${escapeHtml(t)}</span>`);
    return [...moods, ...types].join("");
  }

  /**
   * @param {object[]} videos
   */
  function renderVideos(videos) {
    els.grid.innerHTML = "";
    const emptyP = els.empty.querySelector("p");

    if (!videos.length) {
      els.empty.classList.remove("hidden");
      if (emptyP) emptyP.textContent = "No videos found for this mood or creator.";
      els.resultCount.textContent = "No results.";
      return;
    }

    els.empty.classList.add("hidden");
    if (emptyP) emptyP.textContent = "No matches. Try another mood, kind, or optional search.";
    els.resultCount.textContent =
      videos.length === 1 ? "1 suggestion" : `${videos.length} suggestions`;

    const frag = document.createDocumentFragment();
    for (const v of videos) {
      const li = document.createElement("li");
      const card = document.createElement("div");
      card.className = "card card-embed";

      card.innerHTML = `
        <div class="thumb-wrap">
          <img src="${thumbUrl(v.youtubeId)}" alt="" loading="lazy" width="320" height="180" />
        </div>
        <div class="card-body">
          <h3 class="card-title">${escapeHtml(v.title)}</h3>
          <p class="card-creator">${escapeHtml(v.creator)}</p>
          <div class="meta meta-tags">${tagMarkup(v)}</div>
        </div>
        <div class="ratio card-iframe">
          <iframe
            src="${embedSrc(v.youtubeId)}"
            title="${escapeHtml(v.title)}"
            allowfullscreen
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
          ></iframe>
        </div>
      `;

      li.appendChild(card);
      frag.appendChild(li);
    }
    els.grid.appendChild(frag);
  }

  function showBackendHint(message) {
    lastFetchedCatalog = [];
    els.resultCount.textContent = "Could not load suggestions.";
    const emptyP = els.empty.querySelector("p");
    if (emptyP) {
      emptyP.textContent =
        message ||
        'Run the scraper server from this folder: pip install -r requirements.txt then python server.py — then open http://127.0.0.1:8080/';
    }
    els.empty.classList.remove("hidden");
    els.grid.innerHTML = "";
  }

  async function applyView() {
    if (els.playerDock) els.playerDock.classList.add("hidden");
    if (els.dockFrame) els.dockFrame.src = "";

    const filters = readFiltersFromDom();
    const cacheKey = cacheKeyForFilters(filters);
    els.resultCount.textContent = "Loading from YouTube…";

    try {
      let raw = searchCache.get(cacheKey);
      if (!raw) {
        const data = await fetchSuggestionsFromServer(filters);
        raw = Array.isArray(data.videos) ? data.videos : [];
        searchCache.set(cacheKey, raw);
      }
      lastFetchedCatalog = raw;
      // Server already applies mood/kind/industry/optional filters.
      // Rendering raw keeps the requested limit behavior predictable.
      renderVideos(raw);
    } catch (e) {
      const msg = String(e.message || e);
      if (msg === "Failed to fetch" || msg.includes("NetworkError")) {
        showBackendHint(
          "Cannot reach the MoodTube server. Open this app via http://127.0.0.1:8080 after starting: python server.py"
        );
      } else {
        showBackendHint(msg);
      }
    }
  }

  async function onSuggestForMe() {
    if (els.playerDock) els.playerDock.classList.add("hidden");
    if (els.dockFrame) els.dockFrame.src = "";

    if (!lastFetchedCatalog.length) {
      await applyView();
    }

    const filters = readFiltersFromDom();
    const pool = lastFetchedCatalog;
    const picked = getRandomSuggestions(pool, filters.limit);
    renderVideos(picked);
  }

  function resetFilters() {
    if (els.optional) els.optional.value = "";
    if (els.limit) els.limit.value = "24";
    els.mood.value = "";
    els.kind.value = "";
    if (els.industry) els.industry.value = "";
    if (els.playerModal && els.playerModal.open) {
      els.playerModal.close();
      if (els.playerFrame) els.playerFrame.src = "";
    }
    applyView();
  }

  function populateMoods() {
    for (const m of moodSeedList()) {
      const opt = document.createElement("option");
      opt.value = m;
      opt.textContent = m.charAt(0).toUpperCase() + m.slice(1);
      els.mood.appendChild(opt);
    }
  }

  window.filterVideos = filterVideos;
  window.getRandomSuggestions = getRandomSuggestions;
  window.renderVideos = renderVideos;

  window.addEventListener("message", (evt) => {
    let payload = evt.data;
    if (typeof payload === "string") {
      if (!payload.includes("onStateChange")) return;
      try {
        payload = JSON.parse(payload);
      } catch (_) {
        return;
      }
    }
    if (!payload || typeof payload !== "object") return;

    if (payload.event === "onStateChange" && Number(payload.info) === 1) {
      const sourceWin = evt.source;
      const frames = els.grid.querySelectorAll("iframe");
      for (const frame of frames) {
        if (frame.contentWindow === sourceWin) {
          pauseOtherEmbeds(frame);
          break;
        }
      }
    }
  });

  populateMoods();
  applyView();

  els.mood.addEventListener("change", applyView);
  els.kind.addEventListener("change", applyView);
  if (els.industry) {
    els.industry.addEventListener("change", applyView);
  }
  if (els.limit) {
    els.limit.addEventListener("change", applyView);
  }
  if (els.optional) {
    els.optional.addEventListener("input", () => {
      clearTimeout(optionalDebounce);
      optionalDebounce = setTimeout(applyView, 180);
    });
  }

  els.btnSuggest.addEventListener("click", () => void onSuggestForMe());
  els.btnReset.addEventListener("click", resetFilters);

  if (els.closeDock) {
    els.closeDock.addEventListener("click", () => {
      els.playerDock.classList.add("hidden");
      if (els.dockFrame) els.dockFrame.src = "";
    });
  }
  if (els.closeModal) {
    els.closeModal.addEventListener("click", () => {
      els.playerModal.close();
      if (els.playerFrame) els.playerFrame.src = "";
    });
  }
})();
