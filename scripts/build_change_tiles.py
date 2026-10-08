"""Turn a float change raster (e.g. DSM difference, metres) into Terrarium-encoded XYZ tiles, so the
page can colour it in the browser with a MapLibre color-relief layer (any ramp, any range).

    /opt/anaconda3/bin/python scripts/build_change_tiles.py <change.tif> <name> [--zmin 14] [--zmax 21]

Writes data/tiles/<name>/{z}/{x}/{y}.png plus tiles.json. Values are clamped to +/-CLAMP metres and
nodata is written as NODATA_VALUE, which the page's colour ramp maps to transparent (NODATA_VALUE and
CLAMP must match main.js). Needs numpy, rasterio, Pillow.
"""
import argparse
import json
import os
import subprocess

import numpy as np
import rasterio
from PIL import Image
from rasterio.enums import Resampling
from rasterio.warp import transform_bounds

from build_terrain_tiles import HALF, NODATA, TILE, encode, tile_range, to_tile

CLAMP = 50.0  # metres; real change beyond this is clamped
NODATA_VALUE = -1000.0  # written where there is no data; transparent in the page


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('change')
    ap.add_argument('name')
    ap.add_argument('--zmin', type=int, default=14)
    ap.add_argument('--zmax', type=int, default=21)
    a = ap.parse_args()

    root = os.path.join(os.path.dirname(__file__), '..')
    build = os.path.join(root, 'data', 'build', a.name)
    out_dir = os.path.join(root, 'data', 'tiles', a.name)
    os.makedirs(build, exist_ok=True)

    # 1. Reproject to Web Mercator at roughly zmax resolution (average, so noise is smoothed).
    merc = os.path.join(build, 'merc.tif')
    res = 2 * HALF / 2 ** a.zmax / TILE
    subprocess.run(['gdalwarp', '-q', '-overwrite', '-t_srs', 'EPSG:3857', '-tr', str(res), str(res),
                    '-r', 'average', '-dstnodata', str(NODATA), '-multi', '-wo', 'NUM_THREADS=ALL_CPUS',
                    '-co', 'TILED=YES', '-co', 'COMPRESS=DEFLATE', a.change, merc], check=True)
    with rasterio.open(merc) as src:
        b = src.bounds
        v = src.read(1)
        v = v[v != NODATA]
    print('change percentiles (m): ' + ', '.join(
        f'p{p} {q:+.2f}' for p, q in zip((1, 5, 50, 95, 99), np.percentile(v, (1, 5, 50, 95, 99)))))

    # 2. Tiles. Every tile in range is written (nodata ones too) so the page never gets a 404.
    count = 0
    for z in range(a.zmin, a.zmax + 1):
        x0, x1, y0, y1 = tile_range(z, b)
        for x in range(x0, x1 + 1):
            for y in range(y0, y1 + 1):
                t = to_tile(merc, z, x, y, Resampling.average)
                elev = np.where(t == NODATA, NODATA_VALUE, np.clip(t, -CLAMP, CLAMP))
                path = os.path.join(out_dir, str(z), str(x))
                os.makedirs(path, exist_ok=True)
                Image.fromarray(encode(elev)).save(os.path.join(path, f'{y}.png'), optimize=True)
                count += 1
        print(f'z{z}: {(x1 - x0 + 1) * (y1 - y0 + 1)} tiles')

    with open(os.path.join(out_dir, 'tiles.json'), 'w') as f:
        json.dump({'minzoom': a.zmin, 'maxzoom': a.zmax, 'encoding': 'terrarium',
                   'bounds': transform_bounds('EPSG:3857', 'EPSG:4326', *b),
                   'clamp': CLAMP, 'nodata': NODATA_VALUE}, f)
    print(f'{count} tiles -> {out_dir}')


if __name__ == '__main__':
    main()
