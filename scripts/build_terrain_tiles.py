"""Merge a high-res DSM into AWS Terrain Tiles and write Terrarium-encoded XYZ tiles for MapLibre.

    /opt/anaconda3/bin/python scripts/build_terrain_tiles.py <dsm.tif> <name> [--zmin 12] [--zmax 20] [--feather 15]

Writes data/tiles/<name>/{z}/{x}/{y}.png plus tiles.json (the tile ranges written, so the page
knows which tiles are local and which fall back to AWS). The DSM is feathered into the AWS
terrain over --feather metres at its edges so there is no cliff at the boundary.
Needs numpy, scipy, rasterio, Pillow, requests.
"""
import argparse
import io
import json
import math
import os
import subprocess
from functools import lru_cache

import numpy as np
import rasterio
import requests
from PIL import Image
from rasterio.transform import from_bounds
from rasterio.warp import Resampling, reproject, transform_bounds
from scipy.ndimage import distance_transform_edt

AWS = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'
AWS_MAXZOOM = 15
TILE = 256
HALF = 20037508.342789244  # half the Web Mercator world width, metres
NODATA = -9999.0


def tile_bounds(z, x, y):
    size = 2 * HALF / 2 ** z
    return (-HALF + x * size, HALF - (y + 1) * size, -HALF + (x + 1) * size, HALF - y * size)


def tile_range(z, b):
    """XYZ tile index range covering Web Mercator bounds b."""
    size = 2 * HALF / 2 ** z
    return (int((b[0] + HALF) // size), int((b[2] + HALF) // size),
            int((HALF - b[3]) // size), int((HALF - b[1]) // size))


def decode(rgb):
    rgb = rgb.astype(np.float64)
    return rgb[..., 0] * 256 + rgb[..., 1] + rgb[..., 2] / 256 - 32768


def encode(elev):
    v = np.clip(elev + 32768, 0, 65535.996)
    r = np.floor(v / 256)
    g = np.floor(v - r * 256)
    b = np.floor((v - r * 256 - g) * 256)
    return np.dstack([r, g, b]).astype(np.uint8)


@lru_cache(maxsize=None)
def aws_tile(z, x, y):
    resp = requests.get(AWS.format(z=z, x=x, y=y), timeout=30)
    resp.raise_for_status()
    return decode(np.asarray(Image.open(io.BytesIO(resp.content)).convert('RGB')))


def aws_background(z, x, y):
    """AWS elevation for a tile; above z15, bilinear upsample of the z15 parent.
    Must match the fallback in main.js to avoid seams."""
    if z <= AWS_MAXZOOM:
        return aws_tile(z, x, y)
    d = z - AWS_MAXZOOM
    n = 2 ** d
    px, py = x >> d, y >> d
    # 3x3 block of z15 tiles so interpolation is continuous across parent edges
    parent = np.vstack([np.hstack([aws_tile(AWS_MAXZOOM, px + dx, py + dy) for dx in (-1, 0, 1)])
                        for dy in (-1, 0, 1)])
    i = np.arange(TILE)
    u = ((x % n) * TILE + i + 0.5) / n - 0.5 + TILE
    v = ((y % n) * TILE + i + 0.5) / n - 0.5 + TILE
    u0, v0 = np.floor(u).astype(int), np.floor(v).astype(int)
    u1, v1 = u0 + 1, v0 + 1
    fu, fv = (u - u0)[None, :], (v - v0)[:, None]
    top = parent[v0][:, u0] * (1 - fu) + parent[v0][:, u1] * fu
    bot = parent[v1][:, u0] * (1 - fu) + parent[v1][:, u1] * fu
    return top * (1 - fv) + bot * fv


def to_tile(src_path, z, x, y, resampling, band=1):
    out = np.full((TILE, TILE), NODATA, dtype=np.float32)
    with rasterio.open(src_path) as src:
        reproject(rasterio.band(src, band), out, src_nodata=NODATA, dst_nodata=NODATA,
                  dst_transform=from_bounds(*tile_bounds(z, x, y), TILE, TILE),
                  dst_crs='EPSG:3857', resampling=resampling)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('dsm')
    ap.add_argument('name')
    ap.add_argument('--zmin', type=int, default=12)
    ap.add_argument('--zmax', type=int, default=20)
    ap.add_argument('--feather', type=float, default=15.0, help='edge blend width, metres')
    ap.add_argument('--offset', type=float, default=0.0, help='added to DSM heights (datum shift)')
    a = ap.parse_args()

    root = os.path.join(os.path.dirname(__file__), '..')
    build = os.path.join(root, 'data', 'build', a.name)
    out_dir = os.path.join(root, 'data', 'tiles', a.name)
    os.makedirs(build, exist_ok=True)

    # 1. DSM in Web Mercator at roughly zmax resolution.
    merc = os.path.join(build, 'merc.tif')
    res = 2 * HALF / 2 ** a.zmax / TILE
    subprocess.run(['gdalwarp', '-q', '-overwrite', '-t_srs', 'EPSG:3857', '-tr', str(res), str(res),
                    '-r', 'average', '-dstnodata', str(NODATA), '-multi', '-co', 'TILED=YES',
                    '-co', 'COMPRESS=DEFLATE', a.dsm, merc], check=True)

    # 2. Feather weight: 0 at the DSM edge rising to 1 at --feather metres inside.
    weight = os.path.join(build, 'weight.tif')
    with rasterio.open(merc) as src:
        valid = src.read(1) != NODATA
        b = src.bounds
        lat = math.radians((transform_bounds('EPSG:3857', 'EPSG:4326', *b)[1]
                            + transform_bounds('EPSG:3857', 'EPSG:4326', *b)[3]) / 2)
        ground_px = src.res[0] * math.cos(lat)  # mercator metres -> ground metres
        w = np.clip(distance_transform_edt(valid) * ground_px / a.feather, 0, 1).astype(np.float32)
        w[~valid] = NODATA
        profile = src.profile
    with rasterio.open(weight, 'w', **profile) as dst:
        dst.write(w, 1)

    # 3. Tiles.
    ranges, diffs, count = {}, [], 0
    for z in range(a.zmin, a.zmax + 1):
        x0, x1, y0, y1 = tile_range(z, b)
        ranges[z] = [x0, x1, y0, y1]
        rs = Resampling.bilinear if z == a.zmax else Resampling.average
        for x in range(x0, x1 + 1):
            for y in range(y0, y1 + 1):
                bg = aws_background(z, x, y)
                dsm = to_tile(merc, z, x, y, rs)
                wt = to_tile(weight, z, x, y, rs)
                ok = (dsm != NODATA) & (wt != NODATA)
                elev = bg.copy()
                elev[ok] = wt[ok] * (dsm[ok] + a.offset) + (1 - wt[ok]) * bg[ok]
                if z == AWS_MAXZOOM:
                    diffs.append((dsm[ok] + a.offset - bg[ok]))
                path = os.path.join(out_dir, str(z), str(x))
                os.makedirs(path, exist_ok=True)
                Image.fromarray(encode(elev)).save(os.path.join(path, f'{y}.png'), optimize=True)
                count += 1
        print(f'z{z}: {(x1 - x0 + 1) * (y1 - y0 + 1)} tiles')

    with open(os.path.join(out_dir, 'tiles.json'), 'w') as f:
        json.dump({'minzoom': a.zmin, 'maxzoom': a.zmax,
                   'bounds': transform_bounds('EPSG:3857', 'EPSG:4326', *b), 'ranges': ranges}, f)
    if diffs:
        d = np.concatenate(diffs)
        print(f'DSM - AWS at z{AWS_MAXZOOM}: median {np.median(d):+.2f} m, '
              f'p25 {np.percentile(d, 25):+.2f}, p75 {np.percentile(d, 75):+.2f}')
    print(f'{count} tiles -> {out_dir}')


if __name__ == '__main__':
    main()
