// ==============================
// Cross & Crescent - app.js (OBJECT-TABS)
// Loads:
//   - data/objects.json  (array of objects)
// Renders (per selected object tab):
//   - origin marker(s) from obj.locations
//   - destination marker(s) from obj.routes (same size/colour/behaviour as origin)
//   - routes (curved or straight depending on obj.routes[].curve)
// Interaction:
//   - Hover marker -> small info tooltip (thumbnail + minimal text)
//   - Click marker -> right panel (full details)
// Notes:
//   - All markers + routes are BLUE (as requested)
//   - Multiple routes supported
// ==============================

const panelTitle = document.getElementById("panelTitle");
const panelBody  = document.getElementById("panelBody");

let map = null;
let markersLayer = null;
let routesLayer  = null;

let OBJECTS_BY_ID = new Map();

// Track the currently selected marker so we can keep it darker
let selectedMarker = null;

// Prevent spamming transitions when switching fast
let isTransitioning = false;

// Cancels any in-flight route animations when object changes
let renderToken = 0;

// ✅ Requested constant colour
const BLUE = "#2b6cb0";

// ---------------- Panel helpers ----------------
function setPanel(title, html) {
  panelTitle.textContent = title;
  panelBody.innerHTML = html;
}

function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

// ---------------- Map init ----------------
function initMap() {
  map = L.map("map", { scrollWheelZoom: false }).setView([41.5, 18], 4);

  // Clean, label-free basemap (CARTO Light - No Labels)
  L.tileLayer("https://{s}.basemaps.cartocdn.com/light_nolabels/{z}/{x}/{y}{r}.png", {
    maxZoom: 20,
    subdomains: "abcd",
    attribution: ""
  }).addTo(map);

  markersLayer = L.layerGroup().addTo(map);
  routesLayer  = L.layerGroup().addTo(map);
}

function clearLayers() {
  markersLayer.clearLayers();
  routesLayer.clearLayers();
  selectedMarker = null;
}

// ---------------- Marker styles ----------------
function markerStyleBase(color) {
  return {
    radius: 11,
    weight: 0,
    opacity: 0,
    color: color,
    fillColor: color,
    fillOpacity: 0.65
  };
}

function markerStyleHover(color) {
  return {
    radius: 12,
    weight: 0,
    opacity: 0,
    color: color,
    fillColor: color,
    fillOpacity: 0.95
  };
}

function markerStyleSelected(color) {
  return {
    radius: 12,
    weight: 0,
    opacity: 0,
    color: color,
    fillColor: color,
    fillOpacity: 1
  };
}

// ---------------- Fade helpers ----------------
function easeLinear(t) { return t; }

function animateStyle(layer, from, to, durationMs = 300, onDone) {
  const start = performance.now();
  function tick(now) {
    const t = Math.min(1, (now - start) / durationMs);
    const e = easeLinear(t);

    const cur = {};
    for (const k of Object.keys(to)) {
      const a = (from[k] ?? 0);
      const b = to[k];
      cur[k] = a + (b - a) * e;
    }
    layer.setStyle(cur);

    if (t < 1) requestAnimationFrame(tick);
    else if (onDone) onDone();
  }
  requestAnimationFrame(tick);
}

function fadeOutLayers(markersLayer, routesLayer, durationMs = 220) {
  const markers = [];
  markersLayer.eachLayer(l => markers.push(l));
  const routes = [];
  routesLayer.eachLayer(l => routes.push(l));

  for (const m of markers) {
    const from = {
      fillOpacity: (typeof m.options?.fillOpacity === "number") ? m.options.fillOpacity : 0.5,
      opacity: (typeof m.options?.opacity === "number") ? m.options.opacity : 1
    };
    animateStyle(m, from, { fillOpacity: 0, opacity: 0 }, durationMs);
  }

  for (const r of routes) {
    const from = { opacity: (typeof r.options?.opacity === "number") ? r.options.opacity : 0.9 };
    animateStyle(r, from, { opacity: 0 }, durationMs);
  }

  return new Promise(resolve => setTimeout(resolve, durationMs));
}

function fadeInMarker(marker, targetFillOpacity, durationMs = 450) {
  marker.setStyle({ fillOpacity: 0, opacity: 0 });
  animateStyle(marker, { fillOpacity: 0, opacity: 0 }, { fillOpacity: targetFillOpacity, opacity: 1 }, durationMs);
}

// ---------------- Curved route helpers (NO plugin) ----------------
// Supports per-route curve options: {strength, side, min, max}
// If you set strength:0 and min:0 (like you already do), it becomes a straight line.
function buildCurvedPoints(fromLatLng, toLatLng, steps = 28, curveOpts = {}) {
  const zoom = map.getZoom();
  const p0 = map.project(fromLatLng, zoom);
  const p2 = map.project(toLatLng, zoom);

  const dx = p2.x - p0.x;
  const dy = p2.y - p0.y;
  const len = Math.sqrt(dx * dx + dy * dy) || 1;

  const ux = -dy / len;
  const uy = dx / len;

  const strength = Number.isFinite(curveOpts.strength) ? curveOpts.strength : 0.18;
  const minBend  = Number.isFinite(curveOpts.min) ? curveOpts.min : 50;
  const maxBend  = Number.isFinite(curveOpts.max) ? curveOpts.max : 140;

  const sideRaw = curveOpts.side;
  const side = (sideRaw === -1 || sideRaw === 1) ? sideRaw : 1;

  const bend = Math.min(maxBend, Math.max(minBend, len * strength)) * side;

  const mx = (p0.x + p2.x) / 2;
  const my = (p0.y + p2.y) / 2;
  const p1 = L.point(mx + ux * bend, my + uy * bend);

  const pts = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const omt = 1 - t;
    const x = omt * omt * p0.x + 2 * omt * t * p1.x + t * t * p2.x;
    const y = omt * omt * p0.y + 2 * omt * t * p1.y + t * t * p2.y;
    pts.push(map.unproject(L.point(x, y), zoom));
  }
  return pts;
}

async function animateRouteCrawlCurved(polyline, { points, durationMs = 1500, delayMs = 0, token } = {}) {
  if (delayMs > 0) await new Promise(r => setTimeout(r, delayMs));
  if (token !== renderToken) return;

  const allow = Array.isArray(points) ? points : [];
  if (allow.length < 2) return;

  const start = performance.now();

  function frame(now) {
    if (token !== renderToken) return;

    const t = Math.min(1, (now - start) / durationMs);
    const e = easeLinear(t);

    const n = Math.max(2, Math.floor(e * (allow.length - 1)) + 1);
    polyline.setLatLngs(allow.slice(0, n));

    if (t < 1) requestAnimationFrame(frame);
    else polyline.setLatLngs(allow);
  }

  requestAnimationFrame(frame);
}

// ---------------- Tooltip + panel HTML ----------------
function buildHoverHTML(obj, locLabel) {
  const title = escapeHtml(obj?.title || obj?.id || "Object");
  const thumb = String(obj?.hover?.thumb || "").trim();
  const yearRaw = obj?.hover?.year ?? obj?.year ?? "";
  const year = yearRaw ? escapeHtml(yearRaw) : "";

  const locRaw = locLabel ?? obj?.hover?.location ?? "";
  const loc = locRaw ? escapeHtml(locRaw) : "";

  const imgHtml = thumb
    ? `<img class="hover-thumb" src="${escapeHtml(thumb)}" alt="${title}" />`
    : "";

  return `
    <div class="hover-card">
      ${imgHtml}
      <div class="hover-meta">
        <div class="hover-title">${title}</div>
        ${loc ? `<div class="hover-year">${loc}</div>` : ""}
        ${year ? `<div class="hover-year">${year}</div>` : ""}
      </div>
    </div>
  `;
}

function buildPanelHTML(obj) {
  const title = escapeHtml(obj?.title || obj?.id || "Object");
  const body = escapeHtml(obj?.panel?.body || "");

  const yearRaw = obj?.panel?.year ?? obj?.hover?.year ?? obj?.year ?? "";
  const year = yearRaw ? escapeHtml(yearRaw) : "";

  const locs = Array.isArray(obj?.locations) ? obj.locations : [];
  const locHtml = locs.length
    ? `<p><strong>Locations:</strong> ${locs.map(l => escapeHtml(l.label || "")).filter(Boolean).join(", ")}</p>`
    : "";

  const images = Array.isArray(obj?.panel?.images) ? obj.panel.images : [];
  const imagesHtml = images.length
    ? `
      <div class="panel-images">
        ${images
          .filter(Boolean)
          .map(src => `<img class="panel-img" src="${escapeHtml(src)}" alt="${title}" />`)
          .join("")}
      </div>
    `
    : "";

  return `
    ${year ? `<p><strong>Date:</strong> ${year}</p>` : ""}
    ${locHtml}
    ${body ? `<p>${body}</p>` : ""}
    ${imagesHtml}
  `;
}

// ---------------- Data loading ----------------
async function loadData() {
  const objectsRes = await fetch("data/objects.json", { cache: "no-store" });
  if (!objectsRes.ok) throw new Error("Failed to load data/objects.json");

  const objectsArr = await objectsRes.json();
  if (!Array.isArray(objectsArr)) throw new Error("objects.json must be an array of objects");

  OBJECTS_BY_ID = new Map(objectsArr.map(o => [o.id, o]));
}

// ---------------- Marker factory (origin + destinations use this) ----------------
function addInteractiveMarker(obj, lat, lng, locLabel) {
  const baseStyle = markerStyleBase(BLUE);
  const hoverStyle = markerStyleHover(BLUE);
  const selectedStyle = markerStyleSelected(BLUE);

  const marker = L.circleMarker([Number(lat), Number(lng)], baseStyle);
  marker.__baseStyle = baseStyle;
  marker.__hoverStyle = hoverStyle;
  marker.__selectedStyle = selectedStyle;

  marker.bindTooltip(buildHoverHTML(obj, locLabel), {
    direction: "top",
    offset: [0, -10],
    opacity: 1,
    className: "hover-tooltip",
    sticky: true
  });

  marker.on("mouseover", () => {
    if (selectedMarker === marker) return;
    marker.setStyle(marker.__hoverStyle);
  });

  marker.on("mouseout", () => {
    if (selectedMarker === marker) return;
    marker.setStyle(marker.__baseStyle);
  });

  marker.on("click", () => {
    if (selectedMarker && selectedMarker !== marker) {
      selectedMarker.setStyle(selectedMarker.__baseStyle);
    }
    selectedMarker = marker;
    marker.setStyle(marker.__selectedStyle);

    setPanel(obj.title || obj.id || "Object", buildPanelHTML(obj));
  });

  marker.addTo(markersLayer);
  fadeInMarker(marker, marker.__baseStyle.fillOpacity, 400);

  return marker;
}

// ---------------- Render selected object ----------------
function drawForObject(objectId) {
  renderToken++;
  const token = renderToken;

  clearLayers();

  const obj = OBJECTS_BY_ID.get(objectId);
  if (!obj) {
    setPanel("Not found", `<p>Object <strong>${escapeHtml(objectId)}</strong> not found in objects.json.</p>`);
    return;
  }

  const locations = Array.isArray(obj.locations) ? obj.locations : [];
  const routes = Array.isArray(obj.routes) ? obj.routes : [];

  if (locations.length === 0) {
    setPanel(obj.title || obj.id || "Object", `<p>No locations configured for this object.</p>`);
    return;
  }

  // Avoid duplicate destination markers if multiple routes share the same coords
  const seenDest = new Set();
  let routeIndex = 0;

  for (const loc of locations) {
    if (loc?.lat == null || loc?.lng == null) continue;

    // origin marker
    addInteractiveMarker(obj, loc.lat, loc.lng, loc.label);

    // routes from this origin
    for (const r of routes) {
      if (r?.toLat == null || r?.toLng == null) continue;

      const from = L.latLng(Number(loc.lat), Number(loc.lng));
      const to = L.latLng(Number(r.toLat), Number(r.toLng));
      if (!Number.isFinite(from.lat) || !Number.isFinite(from.lng) || !Number.isFinite(to.lat) || !Number.isFinite(to.lng)) continue;

      // curve options (preserve your existing per-route curve config)
      const c = r.curve || {};
      const autoSide = (routeIndex % 2 === 0) ? 1 : -1;

      const curveOpts = {
        strength: (c.strength != null) ? Number(c.strength) : undefined,
        min:      (c.min != null) ? Number(c.min) : undefined,
        max:      (c.max != null) ? Number(c.max) : undefined,
        side:     (c.side === 1 || c.side === -1) ? c.side : autoSide
      };

      const curvePts = buildCurvedPoints(from, to, 28, curveOpts);

      const routeLine = L.polyline(curvePts.slice(0, 2), {
        color: BLUE,
        weight: 3,
        opacity: 0.9,
        dashArray: "6 8"
      }).addTo(routesLayer);

      animateRouteCrawlCurved(routeLine, {
        points: curvePts,
        durationMs: 1500,
        delayMs: routeIndex * 200,
        token
      });

      // destination marker (same size/colour/behaviour as origin marker)
      const key = `${to.lat.toFixed(6)},${to.lng.toFixed(6)}`;
      if (!seenDest.has(key)) {
        seenDest.add(key);
        addInteractiveMarker(obj, to.lat, to.lng, r.toLabel || "Destination");
      }

      routeIndex++;
    }
  }

  setPanel("Select a marker", `<p>Hover markers to preview. Click a marker to see full details.</p>`);
}

// ---------------- Tabs wiring ----------------
function setActiveTab(objectId) {
  document.querySelectorAll(".tabBtn").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.object === objectId);
    btn.setAttribute("aria-selected", btn.dataset.object === objectId ? "true" : "false");
  });
}

async function applyObject(objectId) {
  if (isTransitioning) return;
  isTransitioning = true;

  setActiveTab(objectId);

  await fadeOutLayers(markersLayer, routesLayer, 250);
  drawForObject(objectId);

  isTransitioning = false;
}

function wireTabs() {
  const buttons = Array.from(document.querySelectorAll(".tabBtn"));

  for (const btn of buttons) {
    const id = btn.dataset.object;

    btn.addEventListener("click", () => applyObject(id));

    btn.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" || ev.key === " ") {
        ev.preventDefault();
        applyObject(id);
      }
    });
  }
}

// ---------------- Main ----------------
(async function main() {
  initMap();
  wireTabs();

  try {
    await loadData();

    // default to first tab
    const first = document.querySelector(".tabBtn")?.dataset.object;
    if (first) await applyObject(first);

  } catch (err) {
    setPanel("Error", `<p>${escapeHtml(err.message)}</p>`);
    console.error(err);
  }
})();
