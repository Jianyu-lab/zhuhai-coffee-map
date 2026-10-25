"""
珠海咖啡店 POI 采集
- 自适应网格切分（突破高德同参数 200 条上限）
- 截断判定用接口返回的 count 字段，而非经验阈值（更准，也更省调用）
- 多关键词合并：高德 keywords 支持 "|" 分隔，一次采集覆盖多个词
- 陆地掩膜：用区界多边形过滤海面网格，省一半调用
- 本地缓存：每个网格一次，重跑不重复消耗配额

用法:
  python fetch.py --step 0.02                      # 按 typecode 050500 全量
  python fetch.py --step 0.02 --keywords "咖啡"     # 按关键词
  python fetch.py --step 0.02 --keywords "coffee|cafe|roasters"
  python fetch.py --step 0.02 --types "050500|050100" --keywords "咖啡"
"""
import argparse
import json
import math
import os
import sys
import time

import requests
from shapely.geometry import box, shape
from shapely.ops import unary_union
from shapely.prepared import prep

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "..", "data")
CACHE = os.path.join(DATA, "cache")
os.makedirs(CACHE, exist_ok=True)

API = "https://restapi.amap.com/v3/place/polygon"
MAX_PAGE = 8          # 25 × 8 = 200，接口硬上限
PAGE_SIZE = 25
THRESHOLD = 180       # 单格 ≥180 条基本等于撞上限，直接细分
MIN_GAIN = 40         # count 与实收差 ≥40 条才值得再细分（避免无意义深挖）
MAX_DEPTH = 5
MIN_SIDE = 0.0022     # ≈240m，再细就没有意义了
SLEEP = 0.45          # ≈2.2 QPS，留余量避开并发频控


def load_key():
    # 环境变量优先：GitHub Actions 里用 secrets.AMAP_WEB_KEY 注入，
    # 不把 Key 写进仓库。本地仍可写在 scripts/.env。
    k = (os.environ.get("AMAP_WEB_KEY") or "").strip()
    if k:
        return k
    for p in (os.path.join(HERE, ".env"), os.path.join(HERE, "..", ".env")):
        if os.path.exists(p):
            for line in open(p, encoding="utf-8"):
                line = line.strip()
                if line.startswith("AMAP_WEB_KEY"):
                    return line.split("=", 1)[1].strip().strip('"').strip("'")
    sys.exit("缺少 AMAP_WEB_KEY：请写在 scripts/.env，或设环境变量 AMAP_WEB_KEY")


def load_land():
    gj = json.load(open(os.path.join(DATA, "zhuhai_districts.geojson"), encoding="utf-8"))
    geoms = [shape(f["geometry"]) for f in gj["features"]]
    land = unary_union(geoms)
    return land, prep(land), gj


def _int(v):
    try:
        return int(v)
    except (TypeError, ValueError):
        return 0


class Fetcher:
    def __init__(self, key):
        self.key = key
        self.calls = 0
        self.cache_hits = 0
        self.truncated = 0
        self.dead = False        # 配额/权限耗尽后停止继续请求

    def rect(self, w, s, e, n, keywords=None, types=None):
        """取矩形内全部 POI（自动翻页）。返回 (pois, 接口报告的 total)。命中缓存直接返回。"""
        tag = "".join(ch for ch in (keywords or "cat") if ch.isalnum() or ch in "_-") or "cat"
        fname = f"{tag}_{w:.4f}_{s:.4f}_{e:.4f}_{n:.4f}.json".replace("-", "m")
        path = os.path.join(CACHE, fname)
        if os.path.exists(path):
            self.cache_hits += 1
            d = json.load(open(path, encoding="utf-8"))
            if isinstance(d, dict):            # 新格式
                return d.get("pois") or [], _int(d.get("count"))
            return d, len(d)                   # 旧格式：纯列表

        if self.dead:
            return [], 0

        out, total = [], 0
        for page in range(1, MAX_PAGE + 1):
            params = {
                "key": self.key,
                "polygon": f"{w},{s}|{e},{n}",
                "offset": PAGE_SIZE,
                "page": page,
                "extensions": "all",
            }
            if keywords:
                params["keywords"] = keywords
            if types:
                params["types"] = types
            elif not keywords:
                params["types"] = "050500"     # 餐饮服务;咖啡厅

            d = None
            for attempt in range(6):
                try:
                    r = requests.get(API, params=params, timeout=20)
                    d = r.json()
                except Exception as ex:
                    if attempt == 5:
                        print(f"  ! 请求失败 {ex}")
                        d = {"status": "0"}
                    time.sleep(1.5 * (attempt + 1))
                    continue

                if d.get("status") == "1":
                    break

                info = (d.get("info") or "").upper()
                # 并发频控：退避后重试同一页，不放弃
                if "QPS" in info or "TOO_FREQUENT" in info or "BUSY" in info:
                    time.sleep(2.0 + attempt * 1.5)
                    continue
                # 日配额耗尽 / Key 失效：彻底停止
                if "DAILY" in info or "QUOTA" in info or "INVALID_USER_KEY" in info:
                    print(f"  ! 配额耗尽：{info} —— 停止后续请求")
                    self.dead = True
                break

            self.calls += 1
            time.sleep(SLEEP)

            if d.get("status") != "1":
                info = d.get("info", "") or ""
                if not self.dead and info and info != "OK":
                    print(f"  ! {info}")
                break

            if page == 1:
                total = _int(d.get("count"))
            pois = d.get("pois") or []
            if isinstance(pois, dict):        # 单条结果时返回对象
                pois = [pois]
            out += pois
            if len(pois) < PAGE_SIZE:
                break

        json.dump({"count": max(total, len(out)), "pois": out},
                  open(path, "w", encoding="utf-8"), ensure_ascii=False)
        return out, total

    def walk(self, w, s, e, n, depth=0, keywords=None, types=None):
        pois, total = self.rect(w, s, e, n, keywords, types)
        side = max(e - w, n - s)
        # 真正被截断：接口说还有更多，但我们只拿到 200 条以内
        cut = total > len(pois) + 1 and total - len(pois) >= MIN_GAIN
        if cut:
            self.truncated += 1
        need = (len(pois) >= THRESHOLD or cut) and depth < MAX_DEPTH and side > MIN_SIDE
        if need:
            mx, my = (w + e) / 2, (s + n) / 2
            got = []
            for q in [(w, s, mx, my), (mx, s, e, my), (w, my, mx, n), (mx, my, e, n)]:
                got += self.walk(*q, depth=depth + 1, keywords=keywords, types=types)
            return got
        return pois


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--step", type=float, default=0.02)
    ap.add_argument("--keywords", default=None, help='关键词，多个用 | 分隔，如 "咖啡|coffee"')
    ap.add_argument("--types", default=None, help='分类码，多个用 | 分隔，如 "050500|050100"')
    ap.add_argument("--out", default=None)
    args = ap.parse_args()

    key = load_key()
    land, land_prep, gj = load_land()
    minx, miny, maxx, maxy = land.bounds
    print(f"珠海陆地 bbox: {minx:.3f},{miny:.3f} → {maxx:.3f},{maxy:.3f}")

    nx = int(math.ceil((maxx - minx) / args.step))
    ny = int(math.ceil((maxy - miny) / args.step))
    print(f"网格 {nx}×{ny} = {nx*ny} 格，step={args.step}，"
          f"keywords={args.keywords or '-'}，types={args.types or '-'}")

    f = Fetcher(key)
    pois, cells, skipped = [], 0, 0
    t0 = time.time()

    for i in range(nx):
        for j in range(ny):
            w = round(minx + i * args.step, 6)
            s = round(miny + j * args.step, 6)
            e, n = round(w + args.step, 6), round(s + args.step, 6)
            cell = box(w, s, e, n)
            if not land_prep.intersects(cell):
                skipped += 1
                continue
            got = f.walk(w, s, e, n, keywords=args.keywords, types=args.types)
            if got:
                pois += got
            cells += 1
            if cells % 25 == 0:
                el = time.time() - t0
                print(f"  {cells} 格 / 跳过 {skipped} / 原始 {len(pois)} 条 / "
                      f"调用 {f.calls} / 细分 {f.truncated} / {el:.0f}s", flush=True)
            if f.dead:
                print("  ! 配额已耗尽，提前结束")
                break
        if f.dead:
            break

    # 去重
    seen, uniq = set(), []
    for p in pois:
        pid = p.get("id")
        if not pid or pid in seen:
            continue
        seen.add(pid)
        uniq.append(p)

    if args.out:
        out = args.out
    elif args.keywords:
        safe = "".join(ch for ch in args.keywords if ch.isalnum() or ch in "_-") or "kw"
        out = os.path.join(DATA, f"raw_kw_{safe}.json")
    else:
        out = os.path.join(DATA, "raw_pois.json")
    json.dump(uniq, open(out, "w", encoding="utf-8"), ensure_ascii=False)

    print(f"\n完成: {cells} 格, 跳过海面 {skipped} 格, 调用 {f.calls} 次, "
          f"缓存命中 {f.cache_hits}, 截断细分 {f.truncated} 次, "
          f"去重后 {len(uniq)} 条 → {out}")


if __name__ == "__main__":
    main()
