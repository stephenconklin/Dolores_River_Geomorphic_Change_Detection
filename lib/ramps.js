// Diverging colour ramps for the change layer (ColorBrewer, 11-class picks), low (loss) to high (gain).
// Drawn in the browser by a MapLibre color-relief layer, so palette and range change instantly.
export const RAMPS = {
  RdBu: { label: 'Red–Blue', colors: ['#67001f', '#d6604d', '#fddbc7', '#f7f7f7', '#d1e5f0', '#4393c3', '#053061'] },
  BrBG: { label: 'Brown–Teal', colors: ['#543005', '#bf812d', '#f6e8c3', '#f5f5f5', '#c7eae5', '#35978f', '#003c30'] },
  RdYlBu: { label: 'Red–Yellow–Blue', colors: ['#a50026', '#f46d43', '#fee090', '#ffffbf', '#e0f3f8', '#74add1', '#313695'] },
  Spectral: { label: 'Spectral', colors: ['#9e0142', '#f46d43', '#fee08b', '#ffffbf', '#e6f598', '#66c2a5', '#5e4fa2'] },
};

// Where each colour sits, as a fraction of the range (more detail near zero).
const POSITIONS = [-1, -0.5, -0.125, 0, 0.125, 0.5, 1];
const CLEAR = 'rgba(0,0,0,0)';
const EPS = 0.01; // metres; gap between a colour stop and the transparent stop next to it

const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const hex = (c) => `#${c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;

// [value in metres, colour] stops for ramp `name` stretched over ±range, with |change| < hide
// transparent (minimum level of detection). The colour at ±hide is interpolated, as in a stretch.
function stops(name, range, hide) {
  const { colors } = RAMPS[name];
  const pts = POSITIONS.map((p, i) => [p * range, colors[i]]);
  const at = (v) => {
    const i = pts.findIndex(([x]) => x >= v);
    const [x0, c0] = pts[i - 1];
    const [x1, c1] = pts[i];
    const f = (v - x0) / (x1 - x0);
    return hex(rgb(c0).map((a, k) => a + (rgb(c1)[k] - a) * f));
  };
  if (!hide) return pts;
  return [
    ...pts.filter(([x]) => x < -hide), [-hide, at(-hide)], [-hide + EPS, CLEAR],
    [hide - EPS, CLEAR], [hide, at(hide)], ...pts.filter(([x]) => x > hide),
  ];
}

// color-relief-color expression. Values beyond the range take the end colours; `nodata` (written by
// scripts/build_change_tiles.py below -clamp) is transparent.
export function colorExpression(name, range, hide, { clamp, nodata }) {
  const { colors } = RAMPS[name];
  return ['interpolate', ['linear'], ['elevation'],
    nodata, CLEAR, -clamp - 1, CLEAR, -clamp, colors[0],
    ...stops(name, range, hide).flat()];
}

// Matching CSS gradient for the legend; the hidden band is left transparent so a hatch shows through.
export function cssGradient(name, range, hide) {
  const pct = (v) => `${((v / range + 1) * 50).toFixed(2)}%`;
  return `linear-gradient(to right, ${stops(name, range, hide).map(([v, c]) => `${c} ${pct(v)}`).join(', ')})`;
}
