// Keyless imagery basemaps, added as raster layers under a vector style.
export const IMAGERY = {
  esri: {
    label: 'Esri World Imagery',
    tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
    maxzoom: 19, // z20+ returns "no data" placeholders here; overzoom instead
    attribution: 'Imagery © Esri, Maxar, Earthstar Geographics, and the GIS User Community',
  },
};

// Adds every IMAGERY entry as a hidden layer at the bottom of the style and returns
// setBasemap(name, { labels }), where name is 'map' (the vector style) or an IMAGERY key.
// Call on 'load', before adding your own layers, so they aren't hidden with the vector base.
export function addImageryBasemaps(map) {
  const style = map.getStyle().layers;
  const vectorBase = style.filter((l) => l.type !== 'symbol').map((l) => l.id);
  const labels = style.filter((l) => l.type === 'symbol').map((l) => l.id);
  const bottom = style[0]?.id;

  for (const [key, { label, ...source }] of Object.entries(IMAGERY)) {
    map.addSource(`imagery-${key}`, { type: 'raster', tileSize: 256, ...source });
    map.addLayer({ id: `imagery-${key}`, type: 'raster', source: `imagery-${key}`,
      layout: { visibility: 'none' } }, bottom);
  }

  const vis = (ids, on) => ids.forEach((id) => map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none'));
  return function setBasemap(name, { labels: showLabels = true } = {}) {
    for (const key of Object.keys(IMAGERY)) vis([`imagery-${key}`], key === name);
    vis(vectorBase, name === 'map');
    vis(labels, showLabels);
  };
}
