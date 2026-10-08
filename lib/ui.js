// Small panel helpers.

const FORMATS = {
  percent: (v) => `${Math.round(v * 100)}%`,
  times: (v) => `${Number(v)}×`,
};

// Adds a min / mid / max scale under every <input type=range data-format="percent|times">
// and a live value readout beside it.
export function addSliderScales(root = document) {
  for (const input of root.querySelectorAll('input[type=range][data-format]')) {
    const fmt = FORMATS[input.dataset.format] ?? String;
    const min = Number(input.min);
    const max = Number(input.max);

    const wrap = document.createElement('span');
    wrap.className = 'slider';
    input.replaceWith(wrap);
    const scale = document.createElement('span');
    scale.className = 'slider-scale';
    scale.innerHTML = [min, (min + max) / 2, max].map((v) => `<span>${fmt(v)}</span>`).join('');
    wrap.append(input, scale);

    const out = document.createElement('output');
    const update = () => { out.textContent = fmt(input.value); };
    input.addEventListener('input', update);
    update();
    wrap.after(out);
  }
}

// Current numeric value of an input, by id.
export const valueOf = (id) => Number(document.getElementById(id).value);

// Wraps an existing page element as a MapLibre control, so it stacks with the built-in controls
// in a map corner instead of being positioned by hand. Mark the element `hidden` in the HTML to
// avoid a flash before the map adds it.
//   map.addControl(new ElementControl('map-title'), 'top-left');
export class ElementControl {
  constructor(el) {
    this._el = typeof el === 'string' ? document.getElementById(el) : el;
  }

  onAdd() {
    this._el.classList.add('maplibregl-ctrl');
    this._el.hidden = false;
    return this._el;
  }

  onRemove() {
    this._el.remove();
  }
}

// A single icon button styled like MapLibre's built-in controls, with an optional text label.
//   map.addControl(new ButtonControl({ title: 'Zoom to site', icon: '<svg …>', onClick }), 'top-right');
export class ButtonControl {
  constructor({ title, icon, label, onClick }) {
    this._opts = { title, icon, label, onClick };
  }

  onAdd() {
    const { title, icon, label, onClick } = this._opts;
    this._el = document.createElement('div');
    this._el.className = 'maplibregl-ctrl maplibregl-ctrl-group';
    const button = document.createElement('button');
    button.type = 'button';
    button.title = title;
    button.setAttribute('aria-label', title);
    if (label) {
      button.className = 'ctrl-labelled';
      button.innerHTML = `${icon}<span>${label}</span>`;
    } else {
      button.innerHTML = icon;
      button.style.display = 'grid';
      button.style.placeItems = 'center';
    }
    button.addEventListener('click', onClick);
    this._el.append(button);
    return this._el;
  }

  onRemove() {
    this._el.remove();
  }
}

// Scale bar in metres with a tick every 10, 20 or 50 m (1-5 m or 100 m+ when zoomed far in or out),
// measured across the centre of the view.
export class ScaleBarControl {
  constructor({ maxWidth = 200 } = {}) {
    this._maxWidth = maxWidth;
    this._update = this._update.bind(this);
  }

  onAdd(map) {
    this._map = map;
    this._el = document.createElement('div');
    this._el.className = 'maplibregl-ctrl scale-bar';
    this._el.title = 'Scale at the centre of the view; it varies across tilted 3D views';
    map.on('move', this._update);
    map.on('load', this._update);
    this._update();
    return this._el;
  }

  onRemove() {
    this._map.off('move', this._update);
    this._map.off('load', this._update);
    this._el.remove();
  }

  _update() {
    const map = this._map;
    const { clientWidth: w, clientHeight: h } = map.getContainer();
    const a = map.unproject([w / 2 - 50, h / 2]);
    const b = map.unproject([w / 2 + 50, h / 2]);
    const pxPerM = 100 / a.distanceTo(b);
    if (!Number.isFinite(pxPerM)) return;

    // Smallest 10/20/50 m step (then 100, 200, 500 m...) that fits at most 5 segments in maxWidth;
    // only when even one 10 m segment is too wide, drop to 5, 2 or 1 m.
    const fit = (st) => Math.floor(this._maxWidth / (st * pxPerM));
    let step = 10;
    for (let k = 0; fit(step) > 5; k++) step = [20, 50, 100][k % 3] * 10 ** Math.floor(k / 3);
    for (const st of [5, 2, 1]) if (fit(step) < 1) step = st;
    const segs = Math.max(1, Math.floor(this._maxWidth / (step * pxPerM)));
    const seg = step * pxPerM;
    const pad = 12; // room for the first and last labels
    const width = segs * seg + 2 * pad;
    const bars = [];
    const ticks = [];
    for (let i = 0; i <= segs; i++) {
      const x = pad + i * seg;
      if (i < segs) bars.push(`<rect x="${x}" y="16" width="${seg}" height="5" fill="${i % 2 ? '#fff' : '#222'}"/>`);
      ticks.push(`<line x1="${x}" y1="12" x2="${x}" y2="21" stroke="#222"/>`,
        `<text x="${x}" y="10" text-anchor="middle">${i * step}${i === segs ? ' m' : ''}</text>`);
    }
    this._el.innerHTML = `<svg width="${width + 12}" height="24" font-size="11" font-family="system-ui, sans-serif">
      ${bars.join('')}<rect x="${pad}" y="16" width="${segs * seg}" height="5" fill="none" stroke="#222"/>${ticks.join('')}</svg>`;
  }
}
