/* Currykartan — visualization of a theoretical (NOT scientifically validated) grid.
 * Pipeline: UI state -> params -> grid math (EPSG:3006, metres) -> proj4 -> Leaflet -> Canvas px. */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);

  /* ===== Constants ===== */
  const DEFAULTS = { spacing: 3.5, angle: 45, offsetX: 0, offsetY: 0, gridA: true, gridB: true, opacity: 0.55, lineWidth: 0.75 };
  const LIMITS = { spacing: [0.1, 10000], angle: [-360, 360], offsetX: [-1e5, 1e5], offsetY: [-1e5, 1e5] };
  const MIN_PX_SPACING = 6;   // below this the grid is a solid wash; don't draw
  const MAX_LINES = 1500;     // hard safety cap per line family
  const params = { ...DEFAULTS }; // UI writes here; math/render only read

  /* ===== 2. Coordinate transformations =====
   * EPSG:4326 = WGS84 lon/lat (degrees); EPSG:3006 = SWEREF 99 TM (metres, UTM 33N, GRS80).
   * Leaflet converts 4326 -> 3857 -> pixels internally; we never touch 3857 ourselves. */
  const hasLibs = typeof L !== 'undefined' && typeof proj4 !== 'undefined';
  if (hasLibs) proj4.defs('EPSG:3006', '+proj=utm +zone=33 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs');

  const wgs84ToSweref = (lat, lon) => proj4('EPSG:4326', 'EPSG:3006', [lon, lat]); // -> [easting, northing]
  const swerefToWgs84 = (e, n) => { const p = proj4('EPSG:3006', 'EPSG:4326', [e, n]); return [p[1], p[0]]; }; // -> [lat, lon]

  /** Reference values for SWEREF 99 TM, computed with an INDEPENDENT implementation of the
   *  Lantmäteriet/Krüger transverse-Mercator series (GRS80, k0=0.9996, lon0=15°E, FE=500000), not with proj4.
   *  Anchor: lat 60°, lon 15° -> N = 0.9996 × meridian arc(60°) = 6651411.190 m. */
  const REFERENCE_POINTS = [ // [lat, lon, easting, northing]
    [60, 15, 500000.0, 6651411.19],
    [59.3293, 18.0686, 674571.866, 6580743.008],
    [63.8254, 20.263, 758807.111, 7088236.341],
    [68.35, 18.8, 656372.173, 7586708.951]];

  /** Dev self-check (console warning only): forward AND inverse against the reference values above (tolerance 1 cm),
   *  plus the exact central-meridian identities (lon 15° -> E = 500000, lat 0 -> N = 0). */
  function verifyTransforms() {
    const TOL = 0.01; // metres
    let ok = true;
    const [e0, n0] = wgs84ToSweref(0, 15);
    if (Math.abs(e0 - 500000) > 1e-3 || Math.abs(n0) > 1e-3) ok = false;
    for (const [lat, lon, eRef, nRef] of REFERENCE_POINTS) {
      const [e, n] = wgs84ToSweref(lat, lon), [la, lo] = swerefToWgs84(eRef, nRef);
      if (Math.abs(e - eRef) > TOL || Math.abs(n - nRef) > TOL || Math.abs(la - lat) > 1e-7 || Math.abs(lo - lon) > 1e-7) ok = false;
    }
    if (!ok) console.warn('EPSG:3006 reference check FAILED: projection output deviates from reference values');
    return ok;
  }

  /* ===== 3. Grid mathematics (pure, DOM-free, metres in EPSG:3006) =====
   * Rotated frame: u = x cosθ + y sinθ, v = -x sinθ + y cosθ (x=E-offsetX, y=N-offsetY).
   * Grid A: lines u = n*spacing. Grid B: lines v = n*spacing. */
  function gridFrame(bbox, p) {
    const th = (p.angle * Math.PI) / 180, c = Math.cos(th), s = Math.sin(th);
    const cx = (bbox.minE + bbox.maxE) / 2 - p.offsetX, cy = (bbox.minN + bbox.maxN) / 2 - p.offsetY;
    const R = Math.hypot(bbox.maxE - bbox.minE, bbox.maxN - bbox.minN) / 2; // half diagonal: lines cover bbox
    let uMin = Infinity, uMax = -Infinity, vMin = Infinity, vMax = -Infinity;
    for (const e of [bbox.minE, bbox.maxE]) for (const n of [bbox.minN, bbox.maxN]) {
      const x = e - p.offsetX, y = n - p.offsetY, u = x * c + y * s, v = -x * s + y * c;
      uMin = Math.min(uMin, u); uMax = Math.max(uMax, u); vMin = Math.min(vMin, v); vMax = Math.max(vMax, v);
    }
    const sp = p.spacing;
    return { c, s, cx, cy, R,
      A: { n0: Math.ceil(uMin / sp), n1: Math.floor(uMax / sp), t0: -cx * s + cy * c },
      B: { n0: Math.ceil(vMin / sp), n1: Math.floor(vMax / sp), t0: cx * c + cy * s } };
  }

  /** Point on line n of a family, at parameter t along the line (relative to viewport centre). Writes [E,N] to out. */
  function gridPoint(f, fam, n, t, p, out) {
    const q = n * p.spacing;
    if (fam === 'A') { // u = q; base (q c, q s); direction (-s, c)
      const tt = f.A.t0 + t; out[0] = q * f.c - f.s * tt; out[1] = q * f.s + f.c * tt;
    } else {           // v = q; base (-q s, q c); direction (c, s)
      const tt = f.B.t0 + t; out[0] = -q * f.s + f.c * tt; out[1] = q * f.c + f.s * tt;
    }
    out[0] += p.offsetX; out[1] += p.offsetY;
  }

  /* ===== 1. Map initialization ===== */
  let map = null, gridCanvas = null, gctx = null;
  function initMap() {
    map = L.map('map', { center: [65.0, 18.0], zoom: 5, minZoom: 3, maxZoom: 19,
      zoomAnimation: false, fadeAnimation: false }); // no zoom animation => overlay never drifts from tiles
    const tiles = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' }).addTo(map);
    let failed = 0;
    tiles.on('tileerror', () => { if (++failed === 3) showNotice('Some map tiles failed to load. Check your connection.'); });
    tiles.on('tileload', () => { failed = 0; });
  }

  /* ===== 4. Canvas rendering ===== */
  let notice = null, rafId = 0;
  function showNotice(msg) { if (!notice) return; notice.textContent = msg || ''; notice.hidden = !msg; }

  function sizeCanvas() {
    const r = gridCanvas.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
    gridCanvas.width = Math.max(1, Math.round(r.width * dpr)); gridCanvas.height = Math.max(1, Math.round(r.height * dpr));
    gctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /** Axis-aligned EPSG:3006 bbox of the visible map (sampled at corners + edge midpoints), padded 5%. */
  function visibleBbox() {
    const b = map.getBounds(), la = [b.getSouth(), (b.getSouth() + b.getNorth()) / 2, b.getNorth()],
      lo = [b.getWest(), (b.getWest() + b.getEast()) / 2, b.getEast()];
    let minE = Infinity, maxE = -Infinity, minN = Infinity, maxN = -Infinity;
    for (const lat of la) for (const lon of lo) {
      const [e, n] = wgs84ToSweref(lat, lon);
      minE = Math.min(minE, e); maxE = Math.max(maxE, e); minN = Math.min(minN, n); maxN = Math.max(maxN, n);
    }
    const pe = (maxE - minE) * 0.05, pn = (maxN - minN) * 0.05;
    return { minE: minE - pe, maxE: maxE + pe, minN: minN - pn, maxN: maxN + pn };
  }

  const pt = [0, 0];
  function drawFamily(f, fam, color, dash, segs) {
    const { n0, n1 } = f[fam];
    gctx.strokeStyle = color; gctx.setLineDash(dash); gctx.beginPath();
    for (let n = n0; n <= n1; n++) {
      for (let k = 0; k <= segs; k++) { // subdivide: straight in 3006 is slightly curved on screen
        gridPoint(f, fam, n, -f.R + (2 * f.R * k) / segs, params, pt);
        const [lat, lon] = swerefToWgs84(pt[0], pt[1]);
        const p = map.latLngToContainerPoint([lat, lon]);
        if (k === 0) gctx.moveTo(p.x, p.y); else gctx.lineTo(p.x, p.y);
      }
    }
    gctx.stroke();
  }

  function render() {
    rafId = 0;
    const w = gridCanvas.clientWidth, h = gridCanvas.clientHeight;
    gctx.clearRect(0, 0, w, h);
    if (!w || !h || (!params.gridA && !params.gridB)) { showNotice(''); return; }
    // metres per screen pixel (Web Mercator at centre latitude) -> decide whether lines are resolvable
    const lat = map.getCenter().lat, mpp = (40075016.686 * Math.cos((lat * Math.PI) / 180)) / (256 * Math.pow(2, map.getZoom()));
    const pxSpacing = params.spacing / mpp;
    if (pxSpacing < MIN_PX_SPACING) {
      // zoom at which the real spacing reaches MIN_PX_SPACING (spacing itself is never altered)
      const needZoom = Math.ceil(Math.log2((40075016.686 * Math.cos((lat * Math.PI) / 180) * MIN_PX_SPACING) / (256 * params.spacing)));
      showNotice(`GRID RESOLUTION ${params.spacing.toFixed(2)} m · Zoom in to visualize (zoom ${needZoom}+)`);
      return;
    }
    showNotice('');
    const f = gridFrame(visibleBbox(), params);
    const segs = f.R < 20000 ? 6 : 24; // more subdivision for large extents (curvature)
    if ((f.A.n1 - f.A.n0 > MAX_LINES) || (f.B.n1 - f.B.n0 > MAX_LINES)) { showNotice('Too many lines for this view. Zoom in.'); return; }
    gctx.globalAlpha = params.opacity; gctx.lineWidth = params.lineWidth; gctx.lineCap = 'butt';
    gctx.shadowBlur = 0;
    if (params.gridA) drawFamily(f, 'A', '#22d3ee', [], segs);           // solid cyan
    if (params.gridB) drawFamily(f, 'B', '#a78bfa', [6, 4], segs);       // dashed violet (not color-only)
    gctx.globalAlpha = 1;
  }
  const scheduleRender = () => { if (!rafId) rafId = requestAnimationFrame(render); };

  /* ===== 5. UI controls ===== */
  const clamp = (v, [lo, hi]) => Math.min(hi, Math.max(lo, v));

  function bindNumber(key) {
    const el = $(key); if (!el) return;
    el.addEventListener('input', () => {              // live update while typing, ignore invalid/partial input
      const v = parseFloat(el.value);
      if (Number.isFinite(v)) { params[key] = clamp(v, LIMITS[key]); onParamsChanged(); }
    });
    el.addEventListener('change', () => { el.value = params[key].toFixed(2); }); // normalise on blur
  }
  function bindToggle(key) { const el = $(key); if (el) el.addEventListener('change', () => { params[key] = el.checked; scheduleRender(); }); }
  function bindRange(key) { const el = $(key); if (el) el.addEventListener('input', () => { params[key] = parseFloat(el.value); scheduleRender(); }); }

  function onParamsChanged() {
    const s = $('info-spacing'); if (s) s.textContent = params.spacing.toFixed(2) + ' m';
    scheduleRender();
  }

  function initUI() {
    ['spacing', 'angle', 'offsetX', 'offsetY'].forEach(bindNumber);
    ['gridA', 'gridB'].forEach(bindToggle);
    ['opacity', 'lineWidth'].forEach(bindRange);
    const modal = $('about-modal');
    $('info-btn')?.addEventListener('click', () => modal?.showModal?.()); // Escape closes natively
    $('modal-close')?.addEventListener('click', () => modal?.close());
    modal?.addEventListener('click', (e) => { if (e.target === modal) modal.close(); }); // backdrop click
    $('explore-btn')?.addEventListener('click', () => {
      const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      $('map-section')?.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth' });
    });
    if (window.matchMedia('(max-width: 700px)').matches) $('controls')?.removeAttribute('open'); // keep map visible on phones
  }

  /* ===== 7. Mouse coordinate display ===== */
  function updateReadout(latlng) {
    const [e, n] = wgs84ToSweref(latlng.lat, latlng.lng);
    $('r-lat').textContent = latlng.lat.toFixed(4); $('r-lon').textContent = latlng.lng.toFixed(4);
    $('r-e').textContent = Math.round(e); $('r-n').textContent = Math.round(n);
  }
  const updateZoom = () => { $('r-zoom').textContent = map.getZoom(); };

  /* ===== 6. Animation (hero) — one canvas, two rotated line families, slow drift ===== */
  function initHero() {
    const cv = $('hero-canvas'); if (!cv) return;
    const ctx = cv.getContext('2d'); const GAP = 64;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    function resize() { const dpr = window.devicePixelRatio || 1, r = cv.getBoundingClientRect();
      cv.width = r.width * dpr; cv.height = r.height * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0); }
    function frame(t) {
      const w = cv.clientWidth, h = cv.clientHeight, d = Math.hypot(w, h), off = ((t || 0) * 0.006) % GAP;
      ctx.clearRect(0, 0, w, h); ctx.save(); ctx.translate(w / 2, h / 2); ctx.rotate(Math.PI / 4);
      ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(34,211,238,0.35)'; ctx.shadowColor = 'rgba(34,211,238,0.6)'; ctx.shadowBlur = 6;
      ctx.beginPath();
      for (let x = -d + off; x < d; x += GAP) { ctx.moveTo(x, -d); ctx.lineTo(x, d); }  // family 1
      for (let y = -d + off; y < d; y += GAP) { ctx.moveTo(-d, y); ctx.lineTo(d, y); }  // family 2
      ctx.stroke(); ctx.restore();
      if (!reduce) requestAnimationFrame(frame); // rAF pauses automatically in background tabs
    }
    resize(); window.addEventListener('resize', () => { resize(); if (reduce) frame(0); });
    reduce ? frame(0) : requestAnimationFrame(frame);
  }

  /* ===== Boot ===== */
  function boot() {
    initHero();
    initUI();
    notice = $('map-notice');
    if (!hasLibs || !$('map')) { // external CDN failed
      const el = $('map'); if (el) el.textContent = 'Map libraries failed to load. Check your connection and reload.';
      return;
    }
    verifyTransforms();
    gridCanvas = $('grid-canvas'); gctx = gridCanvas.getContext('2d');
    initMap(); sizeCanvas(); updateZoom(); updateReadout(map.getCenter());
    map.on('move zoom viewreset', scheduleRender);   // 'move' fires continuously during pan
    map.on('zoomend', updateZoom);
    map.on('resize', () => { sizeCanvas(); scheduleRender(); });
    map.on('mousemove', (e) => updateReadout(e.latlng));
    map.on('moveend', () => { if (window.matchMedia('(hover: none)').matches) updateReadout(map.getCenter()); }); // touch fallback
    window.addEventListener('resize', () => { map.invalidateSize(); });
    scheduleRender();
  }
  document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', boot) : boot();
})();
