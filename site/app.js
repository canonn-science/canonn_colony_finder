(function () {
  "use strict";

  const DATA_URL = "data/canonn_colony_targets.json";
  const TYPEAHEAD_ENDPOINT = "https://us-central1-canonn-api-236217.cloudfunctions.net/query/typeahead";
  const SUGGESTION_DEBOUNCE_MS = 300;
  const SUGGESTION_MIN_LENGTH = 3;

  /** Published Architect Registry sheet: tab-separated, header row first, "System Name" is the Colonisation Contact system. */
  const ARCHITECTS_SHEET_URL =
    "https://docs.google.com/spreadsheets/d/e/2PACX-1vS5TMBu2KJQBaNqSBropWVdXUcOjz-wJe57e8h4pRPzr7zZ066yjO-H2Z7hqZe-fOVSpzy-7dzAqU2z/pub?gid=1448295597&single=true&output=tsv";
  const ARCHITECTS_SHEET_TIMEOUT_MS = 8000;

  /** The system the "sort by distance" search box starts with — coordinates hardcoded to skip a lookup on launch. */
  const DEFAULT_REFERENCE_SYSTEM = { name: "Varati", x: -178.65625, y: 77.125, z: -87.125 };

  const COPY_ICON = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;
  const COPIED_ICON = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 6 9 17l-5-5"/></svg>`;
  const EXTERNAL_ICON = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><path d="M15 3h6v6"/><path d="M10 14 21 3"/></svg>`;
  const ROCKET_ICON = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2c3 2 5 6 5 10 0 2-1 4-2 5l-3 3-3-3c-1-1-2-3-2-5 0-4 2-8 5-10Z"/><path d="M9 15c-2 1-3 3-3 6 3 0 5-1 6-3"/><path d="M15 15c2 1 3 3 3 6-3 0-5-1-6-3"/><circle cx="12" cy="10" r="1.5"/></svg>`;
  const INARA_ICON = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="9" ry="4"/><path d="M3 12h18"/></svg>`;

  const state = {
    all: [],
    filtered: [],
    page: 1,
    pageSize: 50,
    referenceSystem: null, // { name, x, y, z }
    suggestions: [],
    activeSuggestionIndex: -1,
  };

  /** name (lowercase) -> { name, x, y, z }, from the most recent typeahead responses. */
  const typeaheadCache = new Map();

  const els = {
    systemSearchInput: document.getElementById("system-search"),
    systemSearchSuggestions: document.getElementById("system-search-suggestions"),
    systemSearchGo: document.getElementById("system-search-go"),
    systemSearchClear: document.getElementById("system-search-clear"),
    systemSearchError: document.getElementById("system-search-error"),
    distanceFromSearchHeader: document.getElementById("distance-from-search-header"),
    modalDistanceSearchLabel: document.getElementById("modal-distance-search-label"),
    modalDistanceSearch: document.getElementById("modal-distance-search"),
    modalArchitect: document.getElementById("modal-architect"),
    bodyType: document.getElementById("body-type"),
    minBodies: document.getElementById("min-bodies"),
    sortBy: document.getElementById("sort-by"),
    sortDir: document.getElementById("sort-dir"),
    resetFilters: document.getElementById("reset-filters"),
    pageSize: document.getElementById("page-size"),
    resultCount: document.getElementById("result-count"),
    resultsBody: document.getElementById("results-body"),
    emptyState: document.getElementById("empty-state"),
    pageIndicator: document.getElementById("page-indicator"),
    firstPage: document.getElementById("first-page"),
    prevPage: document.getElementById("prev-page"),
    nextPage: document.getElementById("next-page"),
    lastPage: document.getElementById("last-page"),
    modalOverlay: document.getElementById("modal-overlay"),
    modalClose: document.getElementById("modal-close"),
    modalTitle: document.getElementById("modal-title"),
    modalCoords: document.getElementById("modal-coords"),
    modalBodycount: document.getElementById("modal-bodycount"),
    modalHome: document.getElementById("modal-home"),
    modalDistance: document.getElementById("modal-distance"),
    modalStations: document.getElementById("modal-stations"),
    modalBodies: document.getElementById("modal-bodies"),
    sortHeaders: document.querySelectorAll("#results-table th.sortable"),
  };

  function debounce(fn, ms) {
    let t;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), ms);
    };
  }

  function distance3D(a, b) {
    return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2);
  }

  function computeDistanceFromSearch() {
    if (!state.referenceSystem) {
      for (const row of state.all) delete row.distanceFromSearch;
      return;
    }
    for (const row of state.all) {
      row.distanceFromSearch = row.coords ? distance3D(row.coords, state.referenceSystem) : null;
    }
  }

  /**
   * Parses the Architect Registry sheet: tab-separated, header row first, columns matched by
   * name so a reordered/added column doesn't break this. "System Name" is the Colonisation
   * Contact system this colony targets anchor off of. The sheet is a Google Form response log
   * (append-only, oldest first), and the same system can appear more than once - a later row
   * is a more recent answer, so it should win. Iterating top-to-bottom and overwriting the map
   * entry each time gives exactly that: the last entry wins.
   */
  function parseArchitectsTsv(text) {
    const map = new Map();
    const lines = text.replace(/\r\n/g, "\n").split("\n").filter((line) => line.length > 0);
    if (lines.length === 0) return map;

    const header = lines[0].split("\t");
    const systemNameIndex = header.indexOf("System Name");
    const architectNameIndex = header.indexOf("Architect Name");
    if (systemNameIndex === -1 || architectNameIndex === -1) return map;

    for (let i = 1; i < lines.length; i++) {
      const cells = lines[i].split("\t");
      const systemName = cells[systemNameIndex]?.trim();
      if (!systemName) continue;
      map.set(systemName, cells[architectNameIndex]?.trim() ?? "");
    }
    return map;
  }

  async function fetchArchitectRegistry() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ARCHITECTS_SHEET_TIMEOUT_MS);
    try {
      const res = await fetch(ARCHITECTS_SHEET_URL, { signal: controller.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return parseArchitectsTsv(await res.text());
    } finally {
      clearTimeout(timer);
    }
  }

  async function fetchTypeahead(query) {
    const res = await fetch(`${TYPEAHEAD_ENDPOINT}?q=${encodeURIComponent(query)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  function hideSuggestions() {
    state.suggestions = [];
    state.activeSuggestionIndex = -1;
    els.systemSearchSuggestions.innerHTML = "";
    els.systemSearchSuggestions.hidden = true;
    els.systemSearchInput.setAttribute("aria-expanded", "false");
  }

  function renderSuggestions() {
    els.systemSearchSuggestions.innerHTML = "";
    if (!state.suggestions.length) {
      els.systemSearchSuggestions.hidden = true;
      els.systemSearchInput.setAttribute("aria-expanded", "false");
      return;
    }
    state.suggestions.forEach((name, i) => {
      const li = document.createElement("li");
      li.textContent = name;
      li.role = "option";
      if (i === state.activeSuggestionIndex) li.classList.add("active");
      li.addEventListener("mousedown", (e) => {
        e.preventDefault();
        selectSystem(name);
      });
      els.systemSearchSuggestions.appendChild(li);
    });
    els.systemSearchSuggestions.hidden = false;
    els.systemSearchInput.setAttribute("aria-expanded", "true");
  }

  const fetchSuggestions = debounce(async (query) => {
    try {
      const response = await fetchTypeahead(query);
      for (const system of response.min_max || []) {
        typeaheadCache.set(system.name.toLowerCase(), system);
      }
      state.suggestions = response.values || [];
      state.activeSuggestionIndex = -1;
      renderSuggestions();
    } catch {
      hideSuggestions();
    }
  }, SUGGESTION_DEBOUNCE_MS);

  function onSystemSearchInput() {
    const value = els.systemSearchInput.value.trim();
    els.systemSearchError.hidden = true;
    if (value.length < SUGGESTION_MIN_LENGTH) {
      hideSuggestions();
      return;
    }
    fetchSuggestions(value);
  }

  function selectSystem(name) {
    els.systemSearchInput.value = name;
    hideSuggestions();
    void searchBySystemName(name);
  }

  async function searchBySystemName(name) {
    els.systemSearchError.hidden = true;
    const trimmed = name.trim();
    if (!trimmed) return;

    const cached = typeaheadCache.get(trimmed.toLowerCase());
    if (cached) {
      applyReferenceSystem(cached);
      return;
    }

    try {
      const response = await fetchTypeahead(trimmed);
      const match = (response.min_max || []).find(
        (s) => s.name.toLowerCase() === trimmed.toLowerCase()
      );
      if (!match) {
        els.systemSearchError.textContent = `System "${trimmed}" not found.`;
        els.systemSearchError.hidden = false;
        return;
      }
      typeaheadCache.set(match.name.toLowerCase(), match);
      applyReferenceSystem(match);
    } catch {
      els.systemSearchError.textContent = "Lookup failed. Try again.";
      els.systemSearchError.hidden = false;
    }
  }

  function applyReferenceSystem(system) {
    state.referenceSystem = system;
    els.systemSearchInput.value = system.name;
    els.systemSearchClear.hidden = false;
    els.distanceFromSearchHeader.hidden = false;
    computeDistanceFromSearch();
    els.sortBy.value = "distanceFromSearch";
    els.sortDir.value = "asc";
    applyFilters();
  }

  function clearReferenceSystem() {
    state.referenceSystem = null;
    els.systemSearchInput.value = "";
    els.systemSearchClear.hidden = true;
    els.distanceFromSearchHeader.hidden = true;
    els.systemSearchError.hidden = true;
    computeDistanceFromSearch();
    if (els.sortBy.value === "distanceFromSearch") {
      els.sortBy.value = "bodyCount";
      els.sortDir.value = "desc";
    }
    hideSuggestions();
    applyFilters();
  }

  function populateDropdowns(data) {
    const bodyTypes = new Set();
    for (const row of data) {
      for (const body of row.interestingBodies || []) {
        if (body.subType) bodyTypes.add(body.subType);
      }
    }

    const addOptions = (select, values) => {
      const sorted = Array.from(values).sort((a, b) => a.localeCompare(b));
      for (const value of sorted) {
        const opt = document.createElement("option");
        opt.value = value;
        opt.textContent = value;
        select.appendChild(opt);
      }
    };

    addOptions(els.bodyType, bodyTypes);
  }

  function applyFilters() {
    const bodyType = els.bodyType.value;
    const minBodies = els.minBodies.value ? Number(els.minBodies.value) : null;
    const sortBy = els.sortBy.value;
    const sortDir = els.sortDir.value;

    let rows = state.all;

    if (bodyType) {
      rows = rows.filter((r) =>
        (r.interestingBodies || []).some((b) => b.subType === bodyType)
      );
    }
    if (minBodies !== null && !Number.isNaN(minBodies)) {
      rows = rows.filter((r) => (r.bodyCount || 0) >= minBodies);
    }

    rows = rows.slice().sort((a, b) => {
      let av = a[sortBy];
      let bv = b[sortBy];
      if (typeof av === "string") av = av.toLowerCase();
      if (typeof bv === "string") bv = bv.toLowerCase();
      if (av < bv) return sortDir === "asc" ? -1 : 1;
      if (av > bv) return sortDir === "asc" ? 1 : -1;
      return 0;
    });

    state.filtered = rows;
    state.page = 1;
    render();
  }

  function totalPages() {
    return Math.max(1, Math.ceil(state.filtered.length / state.pageSize));
  }

  function updateSortIndicators() {
    const sortBy = els.sortBy.value;
    const sortDir = els.sortDir.value;
    els.sortHeaders.forEach((th) => {
      const indicator = th.querySelector(".sort-indicator");
      if (th.dataset.sort === sortBy) {
        th.classList.add("sorted");
        indicator.textContent = sortDir === "asc" ? " ▲" : " ▼";
      } else {
        th.classList.remove("sorted");
        indicator.textContent = "";
      }
    });
  }

  function render() {
    updateSortIndicators();
    const pages = totalPages();
    if (state.page > pages) state.page = pages;

    const start = (state.page - 1) * state.pageSize;
    const pageRows = state.filtered.slice(start, start + state.pageSize);

    els.resultsBody.innerHTML = "";
    for (const row of pageRows) {
      const tr = document.createElement("tr");
      tr.tabIndex = 0;

      const bodyGroups = groupBodies(row.interestingBodies || []);
      const bodiesHtml = bodyGroups
        .slice(0, 4)
        .map(([label, count]) => `<span class="tag rare">${escapeHtml(label)}${count > 1 ? ` ${count}` : ""}</span>`)
        .join("");
      const extra = bodyGroups.length > 4
        ? `<span class="tag">+${bodyGroups.length - 4} more</span>`
        : "";

      const distanceFromSearchHtml = state.referenceSystem
        ? `<td data-label="Dist. from search" class="num">${formatNum(row.distanceFromSearch)}</td>`
        : "";

      tr.innerHTML = `
        <td data-label="System" class="system-name">${systemNameCellHtml(row.name)}</td>
        <td data-label="Colonisation contact" class="system-name">${systemNameCellHtml(row.homeSystem)}</td>
        <td data-label="Architect">${escapeHtml(row.architect || "—")}</td>
        ${distanceFromSearchHtml}
        <td data-label="Bodies" class="num">${row.bodyCount ?? ""}</td>
        <td data-label="Interesting bodies">${bodiesHtml}${extra}</td>
      `;
      tr.addEventListener("click", (e) => {
        if (e.target.closest(".external-btn") || e.target.closest(".copy-btn") || e.target.closest(".inara-link")) return;
        openModal(row);
      });
      tr.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          openModal(row);
        }
      });
      els.resultsBody.appendChild(tr);
    }

    els.emptyState.hidden = state.filtered.length !== 0;
    els.resultCount.textContent = `${state.filtered.length.toLocaleString()} system${state.filtered.length === 1 ? "" : "s"} found`;
    els.pageIndicator.textContent = `Page ${state.page} of ${pages}`;

    els.firstPage.disabled = state.page <= 1;
    els.prevPage.disabled = state.page <= 1;
    els.nextPage.disabled = state.page >= pages;
    els.lastPage.disabled = state.page >= pages;
  }

  // The generator cleans genus codex names (e.g. "$Codex_Ent_Bacterial_Genus_Name;"
  // -> "Bacterial") before writing the data file, but older data files may still
  // carry a leftover, not-fully-stripped suffix (e.g. "Sphere_Name;") if they were
  // generated before a fix landed here. Cleaning again on load is a safety net so
  // the site always displays the current translation without needing a data rerun.
  const GENUS_CODEX_PREFIX = "$Codex_Ent_";
  const GENUS_CODEX_SUFFIXES = ["_Genus_Name;", "_Name;"];
  const GENUS_NAME_OVERRIDES = {
    Sphere: "Anemone",
    Brancae: "Brain Trees",
    Cone: "Bark Mounds",
  };

  function cleanSubType(subType) {
    let name = subType || "";
    if (name.startsWith(GENUS_CODEX_PREFIX)) {
      name = name.slice(GENUS_CODEX_PREFIX.length);
    }
    for (const suffix of GENUS_CODEX_SUFFIXES) {
      if (name.endsWith(suffix)) {
        name = name.slice(0, -suffix.length);
        break;
      }
    }
    return GENUS_NAME_OVERRIDES[name] || name;
  }

  // The curated set of subtypes the generator (canonn_colony_finder.py) treats as
  // genuinely interesting, mirrored here so already-generated data files that
  // predate a classification fix (e.g. still carrying a since-removed subtype
  // like an ordinary "K (Yellow-Orange) Star", or one that only slipped in via a
  // since-removed rule, like "Icy body" via the old landable+rings+atmosphere
  // special case) don't display stale noise. Not load-bearing once the data file
  // is regenerated with the current generator - just a safety net until then.
  const ALLOWED_SUBTYPES = new Set([
    "High metal content world",
    "Rocky body",
    "Metal-rich body",
    "Water world",
    "Gas giant with water-based life",
    "Neutron Star",
    "T Tauri Star",
    "Gas giant with ammonia-based life",
    "Ammonia world",
    "Earth-like world",
    "Black Hole",
    "Water giant",
    "Helium-rich gas giant",
    "M (Red giant) Star",
    "White Dwarf (DC) Star",
    "Herbig Ae/Be Star",
    "White Dwarf (DA) Star",
    "White Dwarf (DAB) Star",
    "K (Yellow-Orange giant) Star",
    "Wolf-Rayet O Star",
    "S-type Star",
    "MS-type Star",
    "White Dwarf (DB) Star",
    "CN Star",
    "A (Blue-White super giant) Star",
    "White Dwarf (DCV) Star",
    "B (Blue-White super giant) Star",
    "White Dwarf (DAV) Star",
    "Wolf-Rayet C Star",
    "Wolf-Rayet N Star",
    "Wolf-Rayet NC Star",
    "F (White super giant) Star",
    "G (White-Yellow super giant) Star",
    "White Dwarf (DBV) Star",
    "M (Red super giant) Star",
    "CJ Star",
    "White Dwarf (DAZ) Star",
    "White Dwarf (DBZ) Star",
    "C Star",
    "Wolf-Rayet Star",
    "White Dwarf (DQ) Star",
    "Helium gas giant",
    "White Dwarf (D) Star",
    // Biological signal genuses (cleaned display names, including this file's overrides).
    "Aleoids",
    "Bacterial",
    "Cactoid",
    "Clypeus",
    "Conchas",
    "Electricae",
    "Fonticulus",
    "Fumerolas",
    "Fungoids",
    "Osseus",
    "Recepta",
    "Shrubs",
    "Stratum",
    "Tubus",
    "Tussocks",
    "Brain Trees",
    "Bark Mounds",
    "Anemone",
  ]);

  function isAllowedSubType(subType) {
    return ALLOWED_SUBTYPES.has(subType) || subType.toLowerCase().includes("gas giant");
  }

  const TERRAFORM_LABELS = {
    terraformed: "Terraformed",
    terraforming: "Terraforming",
    terraformable: "Terraformable",
  };

  function bodyLabel(body) {
    const parts = [];
    if (body.ringed) parts.push("Ringed");
    const terraformLabel = TERRAFORM_LABELS[body.terraform];
    if (terraformLabel) parts.push(terraformLabel);
    parts.push(body.subType);
    return parts.join(" ");
  }

  /** Groups bodies by their composed label, returning [label, count] pairs in first-seen order. */
  function groupBodies(bodies) {
    const counts = new Map();
    for (const body of bodies) {
      const label = bodyLabel(body);
      counts.set(label, (counts.get(label) || 0) + 1);
    }
    return Array.from(counts.entries());
  }

  function formatNum(n) {
    if (n === undefined || n === null) return "";
    return Number(n).toFixed(2);
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function signalsUrl(systemName) {
    return `https://signals.canonn.tech/?system=${encodeURIComponent(systemName)}`;
  }

  function ravenColonialUrl(systemName) {
    return `https://ravencolonial.com/#sys=${encodeURIComponent(systemName)}`;
  }

  function inaraUrl(name) {
    return `https://inara.cz/elite/starsystem/?search=${encodeURIComponent(name)}`;
  }

  function systemNameHtml(systemName) {
    const name = escapeHtml(systemName || "");
    const signalsHref = signalsUrl(systemName || "");
    const ravenHref = ravenColonialUrl(systemName || "");
    const inaraHref = inaraUrl(systemName || "");
    return `<a class="system-link" href="${signalsHref}" target="_blank" rel="noopener noreferrer">${name}</a><a class="external-btn" href="${inaraHref}" target="_blank" rel="noopener noreferrer" title="Open in Inara" aria-label="Open in Inara">${INARA_ICON}</a><a class="external-btn" href="${ravenHref}" target="_blank" rel="noopener noreferrer" title="Open in Raven Colonial" aria-label="Open in Raven Colonial">${ROCKET_ICON}</a><button type="button" class="copy-btn" data-copy="${name}" title="Copy system name" aria-label="Copy system name">${COPY_ICON}</button>`;
  }

  /** Like systemNameHtml, but for the Colonisation Contact system in the modal: Inara is the main link, signals.canonn.tech becomes an icon button. */
  function homeSystemModalHtml(systemName) {
    const name = escapeHtml(systemName || "");
    const signalsHref = signalsUrl(systemName || "");
    const ravenHref = ravenColonialUrl(systemName || "");
    const inaraHref = inaraUrl(systemName || "");
    return `<a class="system-link" href="${inaraHref}" target="_blank" rel="noopener noreferrer">${name}</a><a class="external-btn" href="${signalsHref}" target="_blank" rel="noopener noreferrer" title="Open in signals.canonn.tech" aria-label="Open in signals.canonn.tech">${EXTERNAL_ICON}</a><a class="external-btn" href="${ravenHref}" target="_blank" rel="noopener noreferrer" title="Open in Raven Colonial" aria-label="Open in Raven Colonial">${ROCKET_ICON}</a><button type="button" class="copy-btn" data-copy="${name}" title="Copy system name" aria-label="Copy system name">${COPY_ICON}</button>`;
  }

  function systemNameCellHtml(systemName) {
    const name = escapeHtml(systemName || "");
    const signalsHref = signalsUrl(systemName || "");
    const ravenHref = ravenColonialUrl(systemName || "");
    const inaraHref = inaraUrl(systemName || "");
    return `<span class="system-text">${name}</span><a class="external-btn" href="${signalsHref}" target="_blank" rel="noopener noreferrer" title="Open in signals.canonn.tech" aria-label="Open in signals.canonn.tech">${EXTERNAL_ICON}</a><a class="external-btn" href="${inaraHref}" target="_blank" rel="noopener noreferrer" title="Open in Inara" aria-label="Open in Inara">${INARA_ICON}</a><a class="external-btn" href="${ravenHref}" target="_blank" rel="noopener noreferrer" title="Open in Raven Colonial" aria-label="Open in Raven Colonial">${ROCKET_ICON}</a><button type="button" class="copy-btn" data-copy="${name}" title="Copy system name" aria-label="Copy system name">${COPY_ICON}</button>`;
  }

  function copySystemName(name) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(name).catch(() => fallbackCopy(name));
    } else {
      fallbackCopy(name);
    }
  }

  function fallbackCopy(name) {
    const ta = document.createElement("textarea");
    ta.value = name;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand("copy"); } catch (e) { /* ignore */ }
    document.body.removeChild(ta);
  }

  function flashCopied(btn) {
    const original = btn.innerHTML;
    btn.innerHTML = COPIED_ICON;
    btn.classList.add("copied");
    setTimeout(() => {
      btn.innerHTML = original;
      btn.classList.remove("copied");
    }, 1200);
  }

  function openModal(row) {
    els.modalTitle.innerHTML = systemNameHtml(row.name);
    els.modalCoords.textContent = row.coords
      ? `${row.coords.x}, ${row.coords.y}, ${row.coords.z}`
      : "—";
    els.modalBodycount.textContent = row.bodyCount ?? "—";
    els.modalHome.innerHTML = row.homeSystem ? homeSystemModalHtml(row.homeSystem) : "—";
    els.modalArchitect.textContent = row.architect || "—";
    els.modalDistance.textContent = row.distanceToHome !== undefined ? `${formatNum(row.distanceToHome)} ly` : "—";

    const hasSearchDistance = state.referenceSystem && row.distanceFromSearch !== undefined;
    els.modalDistanceSearchLabel.hidden = !hasSearchDistance;
    els.modalDistanceSearch.hidden = !hasSearchDistance;
    if (hasSearchDistance) {
      els.modalDistanceSearch.textContent = `${formatNum(row.distanceFromSearch)} ly (from ${state.referenceSystem.name})`;
    }

    els.modalStations.innerHTML = "";
    for (const station of row.homeStations || []) {
      const li = document.createElement("li");
      li.textContent = station;
      els.modalStations.appendChild(li);
    }
    if (!(row.homeStations || []).length) {
      els.modalStations.innerHTML = "<li>—</li>";
    }

    els.modalBodies.innerHTML = "";
    for (const body of row.interestingBodies || []) {
      const li = document.createElement("li");
      li.textContent = `${body.name} — ${bodyLabel(body)}`;
      els.modalBodies.appendChild(li);
    }
    if (!(row.interestingBodies || []).length) {
      els.modalBodies.innerHTML = "<li>—</li>";
    }

    els.modalOverlay.hidden = false;
  }

  function closeModal() {
    els.modalOverlay.hidden = true;
  }

  function resetFilters() {
    els.bodyType.value = "";
    els.minBodies.value = "";
    els.sortBy.value = "bodyCount";
    els.sortDir.value = "desc";
    applyFilters();
  }

  function wireEvents() {
    els.systemSearchInput.addEventListener("input", onSystemSearchInput);
    els.systemSearchInput.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown") {
        if (!state.suggestions.length) return;
        e.preventDefault();
        state.activeSuggestionIndex = (state.activeSuggestionIndex + 1) % state.suggestions.length;
        renderSuggestions();
      } else if (e.key === "ArrowUp") {
        if (!state.suggestions.length) return;
        e.preventDefault();
        state.activeSuggestionIndex =
          (state.activeSuggestionIndex - 1 + state.suggestions.length) % state.suggestions.length;
        renderSuggestions();
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (state.activeSuggestionIndex >= 0 && state.suggestions[state.activeSuggestionIndex]) {
          selectSystem(state.suggestions[state.activeSuggestionIndex]);
        } else {
          hideSuggestions();
          void searchBySystemName(els.systemSearchInput.value);
        }
      } else if (e.key === "Escape") {
        hideSuggestions();
      }
    });
    els.systemSearchInput.addEventListener("blur", () => {
      setTimeout(hideSuggestions, 100);
    });
    els.systemSearchGo.addEventListener("click", () => {
      hideSuggestions();
      void searchBySystemName(els.systemSearchInput.value);
    });
    els.systemSearchClear.addEventListener("click", clearReferenceSystem);

    els.bodyType.addEventListener("change", applyFilters);
    els.minBodies.addEventListener("input", debounce(applyFilters, 150));
    els.sortBy.addEventListener("change", applyFilters);
    els.sortDir.addEventListener("change", applyFilters);
    els.resetFilters.addEventListener("click", resetFilters);

    els.sortHeaders.forEach((th) => {
      th.addEventListener("click", () => {
        const column = th.dataset.sort;
        if (els.sortBy.value === column) {
          els.sortDir.value = els.sortDir.value === "asc" ? "desc" : "asc";
        } else {
          els.sortBy.value = column;
          els.sortDir.value = "asc";
        }
        applyFilters();
      });
    });

    els.pageSize.addEventListener("change", () => {
      state.pageSize = Number(els.pageSize.value);
      state.page = 1;
      render();
    });

    els.firstPage.addEventListener("click", () => { state.page = 1; render(); });
    els.prevPage.addEventListener("click", () => { state.page = Math.max(1, state.page - 1); render(); });
    els.nextPage.addEventListener("click", () => { state.page = Math.min(totalPages(), state.page + 1); render(); });
    els.lastPage.addEventListener("click", () => { state.page = totalPages(); render(); });

    els.modalClose.addEventListener("click", closeModal);
    els.modalOverlay.addEventListener("click", (e) => {
      if (e.target === els.modalOverlay) closeModal();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !els.modalOverlay.hidden) closeModal();
    });

    document.addEventListener("click", (e) => {
      const btn = e.target.closest(".copy-btn");
      if (!btn) return;
      e.stopPropagation();
      copySystemName(btn.dataset.copy);
      flashCopied(btn);
    });
  }

  async function init() {
    wireEvents();
    try {
      const [res, architectMap] = await Promise.all([
        fetch(DATA_URL),
        fetchArchitectRegistry().catch(() => new Map()),
      ]);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      for (const row of data) {
        row.architect = architectMap.get(row.homeSystem) || "";
        row.interestingBodies = (row.interestingBodies || [])
          .map((body) => ({ ...body, subType: cleanSubType(body.subType) }))
          .filter((body) => isAllowedSubType(body.subType));
      }
      state.all = data;
      populateDropdowns(data);
      typeaheadCache.set(DEFAULT_REFERENCE_SYSTEM.name.toLowerCase(), DEFAULT_REFERENCE_SYSTEM);
      applyReferenceSystem(DEFAULT_REFERENCE_SYSTEM);
    } catch (err) {
      els.resultCount.textContent = `Failed to load data: ${err.message}`;
    }
  }

  init();
})();
