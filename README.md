# Dolores River Geomorphic Change Detection

**Live map: https://stephenconklin.github.io/Dolores_River_Geomorphic_Change_Detection/**

Interactive 3D web map of drone-derived surface change on the Dolores River, SW Colorado, between a
pre-flood and a post-flood survey, built with [MapLibre GL JS](https://maplibre.org/maplibre-gl-js/docs/API/).

- **Surveys**: April 2023, pre-flood, right before a large flood was released out of McPhee Dam due to
  high snow levels the winter before; February 2024, post-flood
- **Elevation change**: post-flood February 2024 DSM minus pre-flood April 2023 DSM, with selectable colour ramp and stretch.
  Changes within ±0.2 m (minimum level of detection) and beyond ±2 m are not shown. The default stretch
  is ±1.5 m: about 90% of the shown change falls within it, and it gives erosion (median 0.37 m) more
  contrast than ±2 m; change between 1.5 and 2 m (about 10%, almost all raising) takes the end colours
- **Data**: drone DSMs collected for the DRAMS project; cell sizes Feb 2024 1.82 cm, Apr 2023 1.53 cm,
  difference analysis 1.82 cm; NAD83(2011) / UTM zone 12N (EPSG:6341), displayed in Web Mercator
- **Imagery and terrain**: February 2024 drone orthomosaic and DSM, merged into AWS Terrain Tiles outside the survey area
- **Basemaps**: Esri World Imagery (default), OpenFreeMap

Map by [Stephen Conklin](https://github.com/stephenconklin), using drone survey data from research by
[Jonathan Harvey, Ph.D.](https://www.fortlewis.edu/academics/faculty-directory/harvey), Fort Lewis College.

No build step: plain HTML and ES modules, with MapLibre GL JS 5.24.0 from a CDN (pinned; the `color-relief` layer needs 5.6 or later).

## Run locally

```sh
./serve.sh        # then open http://localhost:8000
```

## Layout

| Path | What |
|---|---|
| `index.html` | Page, panel, and all title/description/About text |
| `main.js` | Map, sources and layers, `sitedem://` terrain protocol, panel wiring |
| `lib/` | Shared CSS and helpers (basemap styles, imagery switcher, slider scales, `ElementControl`) |
| `data/tiles/` | XYZ tiles served by the page (committed) |
| `data/*.tif` | Source rasters (gitignored) |
| `scripts/` | Tile build scripts |

## Rebuild tiles

Needs Homebrew GDAL, and for the Python scripts, a Python with numpy, scipy, rasterio and Pillow
(`/opt/anaconda3/bin/python` here). Intermediates go to `data/build/` (gitignored).

```sh
# DSM change raster -> Terrarium-encoded change values (z14-21), coloured in the browser
/opt/anaconda3/bin/python scripts/build_change_tiles.py data/F24_m_A23_dsm_setnull_masked_2.tif change_F24_m_A23

# Drone mosaic -> WebP tiles (z14-22)
mkdir -p data/build/ortho_feb2024
gdalwarp -t_srs EPSG:3857 -r bilinear -co TILED=YES -co COMPRESS=DEFLATE -co BIGTIFF=YES \
  data/SRBDC_feb2024_transparent_mosaic_group1.tif data/build/ortho_feb2024/merc.tif
gdal2tiles.py --xyz -z 14-22 -r average -w none --processes=8 --tiledriver=WEBP \
  data/build/ortho_feb2024/merc.tif data/tiles/ortho_feb2024

# DSM -> Terrarium terrain tiles merged into AWS terrain (z12-20)
/opt/anaconda3/bin/python scripts/build_terrain_tiles.py data/SRBDC_feb2024_dsm.tif dsm_feb2024
```

MapLibre allows a single terrain source, so `main.js` registers a `sitedem://` protocol that serves
the local DSM tiles inside the site and falls back to AWS Terrain Tiles everywhere else.

## Data sources

- Drone surveys (orthomosaic, DSMs, change raster): research by
  [Jonathan Harvey, Ph.D.](https://www.fortlewis.edu/academics/faculty-directory/harvey), Fort Lewis College
- Terrain outside the survey: [AWS Terrain Tiles](https://registry.opendata.aws/terrain-tiles/)
- Imagery: [Esri World Imagery](https://www.arcgis.com/home/item.html?id=10df2279f9684e4a9f6a7f08febac2a9)
- Vector basemap: [OpenFreeMap](https://openfreemap.org)

## License

Code: [MIT](LICENSE), © Stephen Conklin. The drone survey data and the tiles derived from it
(`data/tiles/`) are **not** covered by the MIT license: they were collected for the DRAMS project by
[Jonathan Harvey, Ph.D.](https://www.fortlewis.edu/academics/faculty-directory/harvey), Fort Lewis
College, and all rights remain with their owners.
