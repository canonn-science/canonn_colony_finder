(function () {
  "use strict";

  const DATA_URL = "data/canonn_colony_targets.json";

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
  };

  const els = {
    search: document.getElementById("search"),
    homeSystem: document.getElementById("home-system"),
    bodyType: document.getElementById("body-type"),
    minBodies: document.getElementById("min-bodies"),
    maxDistance: document.getElementById("max-distance"),
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

  function populateDropdowns(data) {
    const homeSystems = new Set();
    const bodyTypes = new Set();
    for (const row of data) {
      if (row.homeSystem) homeSystems.add(row.homeSystem);
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

    addOptions(els.homeSystem, homeSystems);
    addOptions(els.bodyType, bodyTypes);
  }

  function applyFilters() {
    const q = els.search.value.trim().toLowerCase();
    const home = els.homeSystem.value;
    const bodyType = els.bodyType.value;
    const minBodies = els.minBodies.value ? Number(els.minBodies.value) : null;
    const maxDistance = els.maxDistance.value ? Number(els.maxDistance.value) : null;
    const sortBy = els.sortBy.value;
    const sortDir = els.sortDir.value;

    let rows = state.all;

    if (q) {
      rows = rows.filter(
        (r) =>
          (r.name || "").toLowerCase().includes(q) ||
          (r.homeSystem || "").toLowerCase().includes(q)
      );
    }
    if (home) {
      rows = rows.filter((r) => r.homeSystem === home);
    }
    if (bodyType) {
      rows = rows.filter((r) =>
        (r.interestingBodies || []).some((b) => b.subType === bodyType)
      );
    }
    if (minBodies !== null && !Number.isNaN(minBodies)) {
      rows = rows.filter((r) => (r.bodyCount || 0) >= minBodies);
    }
    if (maxDistance !== null && !Number.isNaN(maxDistance)) {
      rows = rows.filter((r) => (r.distanceToHome || 0) <= maxDistance);
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

      const bodiesHtml = (row.interestingBodies || [])
        .slice(0, 4)
        .map((b) => `<span class="tag rare">${escapeHtml(b.subType)}</span>`)
        .join("");
      const extra = (row.interestingBodies || []).length > 4
        ? `<span class="tag">+${row.interestingBodies.length - 4} more</span>`
        : "";

      tr.innerHTML = `
        <td data-label="System" class="system-name">${systemNameCellHtml(row.name)}</td>
        <td data-label="Colonisation contact" class="system-name">${systemNameCellHtml(row.homeSystem)}</td>
        <td data-label="Distance" class="num">${formatNum(row.distanceToHome)}</td>
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

  function inaraLinkHtml(displayName, className, systemName) {
    const safeName = escapeHtml(displayName || "");
    const url = inaraUrl(systemName !== undefined ? systemName : displayName);
    return `<a class="${className}" href="${url}" target="_blank" rel="noopener noreferrer">${safeName}</a>`;
  }

  function systemNameHtml(systemName) {
    const name = escapeHtml(systemName || "");
    const signalsHref = signalsUrl(systemName || "");
    const ravenHref = ravenColonialUrl(systemName || "");
    const inaraHref = inaraUrl(systemName || "");
    return `<a class="system-link" href="${signalsHref}" target="_blank" rel="noopener noreferrer">${name}</a><a class="external-btn" href="${inaraHref}" target="_blank" rel="noopener noreferrer" title="Open in Inara" aria-label="Open in Inara">${INARA_ICON}</a><a class="external-btn" href="${ravenHref}" target="_blank" rel="noopener noreferrer" title="Open in Raven Colonial" aria-label="Open in Raven Colonial">${ROCKET_ICON}</a><button type="button" class="copy-btn" data-copy="${name}" title="Copy system name" aria-label="Copy system name">${COPY_ICON}</button>`;
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
    els.modalHome.innerHTML = row.homeSystem ? systemNameHtml(row.homeSystem) : "—";
    els.modalDistance.textContent = row.distanceToHome !== undefined ? `${formatNum(row.distanceToHome)} ly` : "—";

    els.modalStations.innerHTML = "";
    for (const station of row.homeStations || []) {
      const li = document.createElement("li");
      li.innerHTML = inaraLinkHtml(station, "inara-link", row.homeSystem);
      els.modalStations.appendChild(li);
    }
    if (!(row.homeStations || []).length) {
      els.modalStations.innerHTML = "<li>—</li>";
    }

    els.modalBodies.innerHTML = "";
    for (const body of row.interestingBodies || []) {
      const li = document.createElement("li");
      li.textContent = `${body.name} — ${body.subType}`;
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
    els.search.value = "";
    els.homeSystem.value = "";
    els.bodyType.value = "";
    els.minBodies.value = "";
    els.maxDistance.value = "";
    els.sortBy.value = "bodyCount";
    els.sortDir.value = "desc";
    applyFilters();
  }

  function wireEvents() {
    els.search.addEventListener("input", debounce(applyFilters, 150));
    els.homeSystem.addEventListener("change", applyFilters);
    els.bodyType.addEventListener("change", applyFilters);
    els.minBodies.addEventListener("input", debounce(applyFilters, 150));
    els.maxDistance.addEventListener("input", debounce(applyFilters, 150));
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
      const res = await fetch(DATA_URL);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      state.all = data;
      populateDropdowns(data);
      applyFilters();
    } catch (err) {
      els.resultCount.textContent = `Failed to load data: ${err.message}`;
    }
  }

  init();
})();
