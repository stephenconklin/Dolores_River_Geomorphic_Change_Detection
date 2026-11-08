import { STYLES } from './lib/styles.js';
import { RAMPS, colorExpression, cssGradient } from './lib/ramps.js';
import { IMAGERY, addImageryBasemaps } from './lib/imagery.js';
import { ButtonControl, ElementControl, ScaleBarControl, addSliderScales, valueOf } from './lib/ui.js';

// Initial opacity and exaggeration come from the slider values in index.html.
addSliderScales();

// Local tile sets, built by the scripts in scripts/ (see README).
const TILES = new URL('./data/tiles', import.meta.url).href; // relative, so it works from any subfolder
const SITE_DEM = `${TILES}/dsm_feb2024`; // Feb 2024 DSM merged into AWS terrain (Terrarium PNG)
const ORTHO = `${TILES}/ortho_feb2024/{z}/{x}/{y}.webp`; // Feb 2024 drone mosaic
const CHANGE = `${TILES}/change_F24_m_A23`; // F24 minus A23 DSM change, metres (Terrarium PNG)
const AWS = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium';
const AWS_MAXZOOM = 15;

const [site, change] = await Promise.all([SITE_DEM, CHANGE].map((t) => fetch(`${t}/tiles.json`).then((r) => r.json())));

// --- sitedem:// protocol: local merged DEM tiles inside the site, AWS everywhere else ----------
// MapLibre allows one terrain source, so tiles outside the DSM fall back to AWS. Above z15 AWS
// tiles are bilinear-upsampled exactly like aws_background() in scripts/build_terrain_tiles.py.

const awsCache = new Map();
function awsElevation(z, x, y) {
  const key = `${z}/${x}/${y}`;
  if (!awsCache.has(key)) {
    awsCache.set(key, fetch(`${AWS}/${key}.png`)
      .then((r) => r.blob())
      .then((b) => createImageBitmap(b, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' }))
      .then((bmp) => {
        const ctx = new OffscreenCanvas(256, 256).getContext('2d', { willReadFrequently: true });
        ctx.drawImage(bmp, 0, 0);
        const px = ctx.getImageData(0, 0, 256, 256).data;
        const elev = new Float32Array(256 * 256);
        for (let i = 0; i < elev.length; i++) {
          elev[i] = px[i * 4] * 256 + px[i * 4 + 1] + px[i * 4 + 2] / 256 - 32768;
        }
        return elev;
      }));
  }
  return awsCache.get(key);
}

async function upsampledAws(z, x, y) {
  const d = z - AWS_MAXZOOM;
  const n = 2 ** d;
  const px = x >> d;
  const py = y >> d;
  // 3x3 block of z15 tiles so interpolation is continuous across parent edges
  const block = await Promise.all([-1, 0, 1].flatMap((dy) =>
    [-1, 0, 1].map((dx) => awsElevation(AWS_MAXZOOM, px + dx, py + dy))));
  const at = (u, v) => block[Math.floor(v / 256) * 3 + Math.floor(u / 256)][(v % 256) * 256 + (u % 256)];

  const img = new ImageData(256, 256);
  for (let j = 0; j < 256; j++) {
    const v = ((y % n) * 256 + j + 0.5) / n - 0.5 + 256;
    const v0 = Math.floor(v);
    const fv = v - v0;
    for (let i = 0; i < 256; i++) {
      const u = ((x % n) * 256 + i + 0.5) / n - 0.5 + 256;
      const u0 = Math.floor(u);
      const fu = u - u0;
      const e = (at(u0, v0) * (1 - fu) + at(u0 + 1, v0) * fu) * (1 - fv)
              + (at(u0, v0 + 1) * (1 - fu) + at(u0 + 1, v0 + 1) * fu) * fv;
      const t = e + 32768;
      const r = Math.floor(t / 256);
      const g = Math.floor(t - r * 256);
      const k = (j * 256 + i) * 4;
      img.data[k] = r;
      img.data[k + 1] = g;
      img.data[k + 2] = Math.floor((t - r * 256 - g) * 256);
      img.data[k + 3] = 255;
    }
  }
  const canvas = new OffscreenCanvas(256, 256);
  canvas.getContext('2d').putImageData(img, 0, 0);
  return (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer();
}

maplibregl.addProtocol('sitedem', async (params, abortController) => {
  const [z, x, y] = params.url.replace('sitedem://', '').split('/').map(Number);
  const r = site.ranges[z];
  const fetchBuf = (url) => fetch(url, { signal: abortController.signal }).then((res) => res.arrayBuffer());
  if (r && x >= r[0] && x <= r[1] && y >= r[2] && y <= r[3]) {
    return { data: await fetchBuf(`${SITE_DEM}/${z}/${x}/${y}.png`) };
  }
  if (z <= AWS_MAXZOOM) return { data: await fetchBuf(`${AWS}/${z}/${x}/${y}.png`) };
  return { data: await upsampledAws(z, x, y) };
});

// --- map ----------------------------------------------------------------------------------------

// --- keeping visitors near the site and above the ground -----------------------------------------

const [west, south, east, north] = site.bounds;
const SITE_CENTER = new maplibregl.LngLat((west + east) / 2, (south + north) / 2);
const ROAM_RADIUS = 2000; // metres from the site centre that the view centre may move
const MIN_ZOOM = 13;
const MAX_ZOOM = 22; // the drone imagery stops at z22
const MAX_PITCH = 75; // steeper views are mostly sky and easily end up nose-down in the terrain
const CLEARANCE = 8; // metres the camera keeps above the ground (MapLibre alone allows 0)

// Starting view, as a camera position relative to a ground point, so it's the same on every screen
// (a fixed zoom puts the camera closer on short screens). Ground heights are from the DSM tiles, metres.
// The "Study area" button and the Home key fly back to it.
const HOME = { target: [-108.87529, 38.03136], ground: 1661, bearing: -134.2, pitch: 67, distance: 140 };
const SITE_GROUND = 1666; // DSM at the site centre, for "Zoom to site"

// Replaces MapLibre's default constraint (so it clamps zoom too): pulls the view centre back inside
// ROAM_RADIUS. A circle rather than maxBounds, which jams pitch and zoom-out near its edges in 3D.
function keepNearSite(lngLat, zoom) {
  const d = SITE_CENTER.distanceTo(lngLat);
  const f = d > ROAM_RADIUS ? ROAM_RADIUS / d : 1;
  return {
    center: new maplibregl.LngLat(SITE_CENTER.lng + (lngLat.lng - SITE_CENTER.lng) * f,
      SITE_CENTER.lat + (lngLat.lat - SITE_CENTER.lat) * f),
    zoom: Math.min(Math.max(+zoom, MIN_ZOOM), MAX_ZOOM),
  };
}

// Runs on every camera change, after MapLibre's own "lift the camera out of the terrain" step: if the
// camera is within CLEARANCE of the ground, raise it there while it keeps looking at the same point.
// That built-in step looks the ground up at the fractional zoom, which finds no tile below the DEM's
// maxzoom and reads 0 m, so it rarely acts; the integer tileZoom works.
// MapLibre calls this as a map method (`this`), possibly from inside the Map constructor.
function keepAboveGround(tr) {
  if (!this.terrain) return {};
  const camera = tr.getCameraLngLat();
  const minAltitude = this.terrain.getElevationForLngLatZoom(camera, tr.tileZoom) + CLEARANCE;
  if (tr.getCameraAltitude() >= minAltitude) return {};
  const { pitch, zoom } = this.calculateCameraOptionsFromTo(camera, minAltitude, tr.center, tr.elevation);
  return { pitch, zoom };
}

const exaggeration = () => map.getTerrain()?.exaggeration ?? 1;

function homeCamera() {
  const { target, ground, bearing, pitch, distance } = HOME;
  const b = bearing * Math.PI / 180;
  const p = pitch * Math.PI / 180;
  const across = distance * Math.sin(p); // horizontal distance from the camera to the target
  const metresPerDegree = 111320;
  const camera = new maplibregl.LngLat(
    target[0] - across * Math.sin(b) / (metresPerDegree * Math.cos(target[1] * Math.PI / 180)),
    target[1] - across * Math.cos(b) / metresPerDegree);
  const groundHere = ground * exaggeration();
  return map.calculateCameraOptionsFromTo(camera, groundHere + distance * Math.cos(p),
    maplibregl.LngLat.convert(target), groundHere);
}

function siteCamera() { // overhead (nadir) view of the whole site
  const { center, zoom } = map.cameraForBounds(site.bounds, { padding: 40, bearing: 0, pitch: 0 });
  return { center, zoom, bearing: 0, pitch: 0, elevation: SITE_GROUND * exaggeration() };
}

// flyTo guesses the ground height at the destination from whichever terrain tiles are loaded when it starts
// (coarse, or 0 m when flying in from afar), so it can end at a wrong height and viewpoint. jumpTo honours
// `elevation`, so when the flight finishes uninterrupted, settle on the exact view.
const FLIGHT_MS = 2000;
function flyToView(view) {
  const start = performance.now();
  // Registered first: with reduced motion flyTo is an instant (exact) jumpTo that fires moveend at once.
  map.once('moveend', () => {
    if (performance.now() - start >= FLIGHT_MS) map.jumpTo(view);
  });
  map.flyTo({ ...view, duration: FLIGHT_MS });
}
const goHome = () => flyToView(homeCamera());

const startedFromHash = location.hash.length > 1; // a shared #zoom/lat/lng/bearing/pitch view

const map = new maplibregl.Map({
  container: 'map',
  style: STYLES.liberty,
  center: HOME.target, zoom: 18, pitch: HOME.pitch, bearing: HOME.bearing, // replaced by homeCamera() on load
  minZoom: MIN_ZOOM,
  maxZoom: MAX_ZOOM,
  maxPitch: MAX_PITCH,
  transformConstrain: keepNearSite,
  transformCameraUpdate: keepAboveGround,
  locale: { 'NavigationControl.ResetBearing': 'Drag to rotate, click to reset north and tilt' },
  hash: true,
  attributionControl: false, // added below, collapsed
});
// Attribution as an "i" button on every screen size. MapLibre's compact mode starts open and closes on the
// first drag; marking it compact ourselves skips that, so it starts closed. Added before the scale bar so it
// stays in the corner.
map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right');
map.getContainer().querySelector('.maplibregl-ctrl-attrib').classList.add('maplibregl-compact');
map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');
// Title, layer controls and About are plain HTML in index.html (#panel).
map.addControl(new ElementControl('panel'), 'top-left');
map.addControl(new ScaleBarControl(), 'bottom-right'); // bottom-left is covered by the tall panel

const demSource = {
  type: 'raster-dem',
  tiles: ['sitedem://{z}/{x}/{y}'],
  encoding: 'terrarium',
  tileSize: 256,
  maxzoom: site.maxzoom,
  attribution: 'Terrain: Feb 2024 drone DSM, <a href="https://registry.opendata.aws/terrain-tiles/">AWS Terrain Tiles</a>',
};

// Corner brackets around a dot: "zoom to extent".
const FIT_ICON = '<svg viewBox="0 0 20 20" width="20" height="20" fill="none" stroke="#333" stroke-width="1.8">'
  + '<path d="M3 7V3h4M13 3h4v4M17 13v4h-4M7 17H3v-4"/><circle cx="10" cy="10" r="2" fill="#333" stroke="none"/></svg>';

// House outline: "home view".
const HOME_ICON = '<svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="#333" stroke-width="1.8"'
  + ' stroke-linejoin="round"><path d="M3 10 10 3.5 17 10M5 8.5V17h4v-4.5h2V17h4V8.5"/></svg>';

// Labels that repeat along roads and rivers (OpenFreeMap Liberty layer ids). The style repeats them every
// 200-350 px, which piles up toward the horizon in tilted 3D views, so space them much further apart.
const LINE_LABELS = ['road_shield_us', 'highway-shield-non-us', 'highway-shield-us-interstate',
  'highway-name-major', 'highway-name-minor', 'highway-name-path', 'waterway_line_label', 'water_name_line_label'];
const LABEL_SPACING = 1000; // px
function thinLineLabels() {
  for (const id of LINE_LABELS) {
    if (map.getLayer(id)) map.setLayoutProperty(id, 'symbol-spacing', LABEL_SPACING);
  }
}

let setBasemap;

map.on('load', () => {
  setBasemap = addImageryBasemaps(map);

  // Separate sources for terrain and hillshade, as MapLibre recommends.
  map.addSource('dem', demSource);
  map.addSource('dem-hillshade', { ...demSource, attribution: undefined });
  map.setTerrain({ source: 'dem', exaggeration: valueOf('exaggeration') });
  map.addLayer({
    id: 'hillshade',
    type: 'hillshade',
    source: 'dem-hillshade',
    paint: { 'hillshade-exaggeration': 0.4 },
  }, 'building'); // keep buildings and labels above the hillshade
  map.setSky({ 'sky-color': '#9cc3e8', 'horizon-color': '#e6eef5', 'sky-horizon-blend': 0.5 });

  const firstSymbol = map.getStyle().layers.find((l) => l.type === 'symbol')?.id;

  map.addSource('ortho', {
    type: 'raster', tiles: [ORTHO], tileSize: 256, bounds: site.bounds, minzoom: 14, maxzoom: 22,
  });
  map.addLayer({
    id: 'ortho', type: 'raster', source: 'ortho', paint: { 'raster-opacity': valueOf('ortho-opacity') },
  }, firstSymbol);

  // Change values in metres, coloured in the browser so the ramp and range can be switched (see lib/ramps.js).
  map.addSource('change', {
    type: 'raster-dem',
    tiles: [`${CHANGE}/{z}/{x}/{y}.png`],
    encoding: 'terrarium',
    tileSize: 256,
    bounds: change.bounds,
    minzoom: change.minzoom,
    maxzoom: change.maxzoom,
  });
  map.addLayer({
    id: 'change',
    type: 'color-relief',
    source: 'change',
    paint: {
      'color-relief-color': changeColors(),
      'color-relief-opacity': valueOf('change-opacity'),
      resampling: 'nearest', // values are packed in RGB, so blending neighbours would corrupt them
    },
  }, firstSymbol);

  map.addControl(new maplibregl.TerrainControl({ source: 'dem', exaggeration: valueOf('exaggeration') }), 'top-right');
  map.addControl(new ButtonControl({
    title: 'Zoom to site',
    icon: FIT_ICON,
    onClick: () => flyToView(siteCamera()),
  }), 'top-right');
  map.addControl(new ButtonControl({
    title: 'Back to the study area (starting view; Home key)',
    icon: HOME_ICON,
    label: 'Study area',
    onClick: goHome,
  }), 'top-right');
  thinLineLabels();
  applyBasemap();
  if (!startedFromHash) map.jumpTo(homeCamera());
  updateLostButton();
});

// --- getting back -------------------------------------------------------------------------------

// "Back to the study area" appears in the middle of the map whenever none of the site is in view, or the
// view is zoomed out past where the change layer is drawn.
const lostButton = document.getElementById('lost');
lostButton.addEventListener('click', goHome);
const SITE_POINTS = [0, 0.5, 1].flatMap((fy) => [0, 0.5, 1].map((fx) =>
  [west + (east - west) * fx, south + (north - south) * fy]));
const onSite = ({ lng, lat }) => lng >= west && lng <= east && lat >= south && lat <= north;
function siteInView() {
  const { clientWidth: w, clientHeight: h } = map.getContainer();
  // Zoomed out: is a corner, edge midpoint or the centre of the site on screen?
  if (SITE_POINTS.some((p) => {
    const { x, y } = map.project(p);
    return x >= 0 && x <= w && y >= 0 && y <= h;
  })) return true;
  // Zoomed in: does any of a 5x5 grid of screen points land on the site?
  for (let i = 0; i < 5; i++) {
    for (let j = 0; j < 5; j++) {
      if (onSite(map.unproject([(i + 0.5) * w / 5, (j + 0.5) * h / 5]))) return true;
    }
  }
  return false;
}
function updateLostButton() {
  lostButton.hidden = map.getZoom() >= change.minzoom && siteInView();
}
map.on('move', updateLostButton);

document.addEventListener('keydown', (e) => {
  if (e.key === 'Home' && !e.target.closest?.('input, select, textarea')) goHome();
});

// --- panel --------------------------------------------------------------------------------------

// Collapse to title and legend; collapsed by default on phone-sized screens so the map stays usable.
const panel = document.getElementById('panel');
const panelToggle = document.getElementById('panel-toggle');
function setPanelCollapsed(collapsed) {
  panel.classList.toggle('collapsed', collapsed);
  panelToggle.setAttribute('aria-expanded', String(!collapsed));
  panelToggle.title = collapsed ? 'Show layers and details' : 'Hide layers and details';
}
setPanelCollapsed(matchMedia('(max-width: 640px), (max-height: 500px)').matches);
panelToggle.addEventListener('click', () => setPanelCollapsed(!panel.classList.contains('collapsed')));

for (const [id, opacity] of [['ortho', 'raster-opacity'], ['change', 'color-relief-opacity']]) {
  document.getElementById(`${id}-show`).addEventListener('change', (e) => {
    map.setLayoutProperty(id, 'visibility', e.target.checked ? 'visible' : 'none');
  });
  document.getElementById(`${id}-opacity`).addEventListener('input', (e) => {
    map.setPaintProperty(id, opacity, Number(e.target.value));
  });
}

// Change colour ramp and range (± metres); the legend is drawn from the same ramp.
// |change| below the minimum (the cm box, default 20 in index.html) is hidden as within measurement
// uncertainty; the About text in index.html says ±20 cm.
const HATCH = 'repeating-linear-gradient(45deg, #bbb 0 1px, #fff 1px 4px)'; // shows through the hidden band
const rampSelect = document.getElementById('change-ramp');
const rangeSelect = document.getElementById('change-range');
const minInput = document.getElementById('change-min');
for (const [key, { label }] of Object.entries(RAMPS)) rampSelect.add(new Option(label, key));
rampSelect.value = 'Spectral'; // default colour ramp
function changeColors() {
  const range = Number(rangeSelect.value);
  // Keep the hidden band inside the stretch (ramps.js interpolates the colour at ±hide). Below 2 cm its
  // stops would overlap, and the source already drops |change| < 1 cm, so treat that as no threshold.
  const cm = Number(minInput.value) || 0;
  const hide = cm < 2 ? 0 : Math.min(cm / 100, range - 0.05);
  document.querySelector('.ramp').style.background = `${cssGradient(rampSelect.value, range, hide)}, ${HATCH}`;
  document.getElementById('ramp-hide').textContent = hide ? `±${+hide.toFixed(2)} m not shown` : '';
  // Data runs to ±2 m, so a narrower stretch puts larger change in the end colours: say so.
  const [lo, hi] = range < 2 ? ['≤ ', '≥ '] : ['', ''];
  document.getElementById('ramp-lo').textContent = `${lo}−${range} m`;
  document.getElementById('ramp-hi').textContent = `${hi}+${range} m`;
  return colorExpression(rampSelect.value, range, hide, change);
}
for (const el of [rampSelect, rangeSelect, minInput]) {
  el.addEventListener(el === minInput ? 'input' : 'change', () => {
    const colors = changeColors();
    if (map.getLayer('change')) map.setPaintProperty('change', 'color-relief-color', colors);
  });
}
changeColors(); // draw the legend before the map loads
const basemapSelect = document.getElementById('basemap');
const labelsToggle = document.getElementById('labels');
for (const [key, { label }] of Object.entries(IMAGERY)) basemapSelect.add(new Option(label, key));
basemapSelect.value = 'esri'; // default basemap
function applyBasemap() {
  const name = basemapSelect.value;
  setBasemap(name, { labels: labelsToggle.checked });
  // imagery has its own shading; the hillshade only helps the vector map
  map.setLayoutProperty('hillshade', 'visibility', name === 'map' ? 'visible' : 'none');
}
basemapSelect.addEventListener('change', () => setBasemap && applyBasemap());
labelsToggle.addEventListener('change', () => setBasemap && applyBasemap());

document.getElementById('exaggeration').addEventListener('input', (e) => {
  if (map.getTerrain()) map.setTerrain({ source: 'dem', exaggeration: Number(e.target.value) });
});

window.map = map;
