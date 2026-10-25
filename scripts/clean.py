"""
清洗 + 打标：原始高德 POI → 咖啡地图数据
输出:
  data/coffee_clean.json    完整字段
  data/coffee.geojson       GIS 分析用
  web/data/coffee.js        前端内嵌数据（file:// 直接打开也能跑）
  web/data/districts.js     区界
"""
import json
import math
import os
import re
import datetime
from collections import Counter, defaultdict

from shapely.geometry import Point, shape

from build_web import write_all

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, "..")
DATA = os.path.join(ROOT, "data")
WEB = os.path.join(ROOT, "web")

# ── 品牌表：name 关键词 → (品牌名, 归属) ───────────────────
BRANDS = [
    (r"瑞幸|luckin|小蓝杯", "瑞幸咖啡"),
    (r"星巴克|starbucks", "星巴克"),
    (r"库迪|cotti", "库迪咖啡"),
    (r"manner", "Manner"),
    (r"挪瓦|nowwa", "挪瓦咖啡"),
    (r"tim(s|hortons)|天好", "Tims天好"),
    (r"太平洋咖啡|pacific coffee", "太平洋咖啡"),
    (r"幸运咖", "幸运咖"),
    (r"m ?stand", "M Stand"),
    (r"seesaw", "Seesaw"),
    (r"arabica|百分号", "% Arabica"),
    (r"peet|皮爷", "Peet's"),
    (r"costa", "Costa"),
    (r"代数学家|algebraist", "代数学家"),
    (r"本来不该有", "本来不该有"),
    (r"四叶咖", "四叶咖"),
    (r"漫咖啡|maan coffee", "漫咖啡"),
    (r"蓝瓶|blue bottle", "蓝瓶咖啡"),
    (r"咖啡之翼", "咖啡之翼"),
    (r"由内向外", "由内向外"),
    (r"挪瓦", "挪瓦咖啡"),
    (r"益禾堂|蜜雪", None),          # 非咖啡品牌，剔噪
]

# 明显不是"咖啡馆"的噪声
NOISE = r"便利店|超市|咖啡豆|咖啡器具|咖啡设备|咖啡机|咖啡培训|咖啡批发|咖啡工厂|烘焙工厂|咖啡学院|咖啡师培训|自动售卖|自助咖啡机"
# 便利店咖啡（有咖啡但不值得单列）
CVS = r"全家|7-?11|罗森|美宜佳|喜士多|天虹微喔|易捷|昆仑好客"

# 商圈中心（GCJ-02，近似）
AREAS = [
    ("吉大", 113.5760, 22.2530), ("拱北", 113.5500, 22.2160),
    ("老香洲", 113.5680, 22.2830), ("柠溪", 113.5560, 22.2660),
    ("前山", 113.5250, 22.2450), ("南屏", 113.5170, 22.2180),
    ("唐家湾", 113.5960, 22.3630), ("横琴", 113.5350, 22.1300),
    ("金湾航空新城", 113.3630, 22.1460), ("斗门井岸", 113.2960, 22.2090),
    ("三灶", 113.3750, 22.0480), ("红旗", 113.3300, 22.1500),
]

TAG_RULES = [
    (r"手冲|单品|精品咖啡", "手冲"),
    (r"海景|海边|沙滩|湾畔|码头|灯塔", "海景"),
    (r"书店|书屋|书房", "书店咖啡"),
    (r"宠物|猫|狗|喵|汪", "宠物友好"),
    (r"面包|烘焙|bakery|欧包|可颂", "有烘焙"),
    (r"酒|bar|精酿|whisk|威士忌", "日咖夜酒"),
    (r"自习|办公|共享|联合办公", "适合办公"),
    (r"露营|户外|院子|花园|庭院", "院子/户外"),
    (r"民宿|酒店|hotel", "酒店咖啡"),
    (r"手作|工作室|艺术|画廊", "艺术空间"),
]

# ── 营业时间解析（高德 biz_ext.open_time，覆盖率约 74%） ──────
_TIME = re.compile(r"(\d{1,2})\s*[:：]\s*(\d{2})")
_RANGE = re.compile(r"(\d{1,2}\s*[:：]\s*\d{2})\s*[-–—~至]\s*(\d{1,2}\s*[:：]\s*\d{2})")
_ALLDAY = re.compile(r"24\s*小时|全天|00:00\s*[-–—~]\s*24:00|00:00\s*[-–—~]\s*00:00")


def _minute(s):
    m = _TIME.match(s.strip())
    if not m:
        return None
    h, mi = int(m.group(1)), int(m.group(2))
    if h > 24 or mi > 59:
        return None
    return h * 60 + mi


def parse_hours(raw):
    """'09:00-20:00' → (540, 1200)；'24小时营业' → (0, 1440)。
    跨夜（如 18:00-02:00）返回 close < open，由前端判定营业中。"""
    if not isinstance(raw, str):
        return None
    s = raw.strip()
    if not s:
        return None
    if _ALLDAY.search(s):
        return (0, 1440)
    m = _RANGE.search(s)
    if not m:
        return None
    a, b = _minute(m.group(1)), _minute(m.group(2))
    if a is None or b is None:
        return None
    if b == 0:
        b = 1440
    return (a, b)


def fmt_hours(hr):
    if not hr:
        return ""
    a, b = hr
    if a == 0 and b == 1440:
        return "24小时"
    return f"{a // 60:02d}:{a % 60:02d}-{b // 60:02d}:{b % 60:02d}"


def hav(a, b, c, d):
    R = 6371000
    p1, p2 = math.radians(b), math.radians(d)
    dp, dl = p2 - p1, math.radians(c - a)
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * R * math.asin(math.sqrt(h))


def num(v):
    try:
        f = float(v)
        return f if f > 0 else None
    except (TypeError, ValueError):
        return None


def load_raw():
    """主采集 + 所有关键词补采文件"""
    import glob
    files = [os.path.join(DATA, "raw_pois.json")]
    files += sorted(glob.glob(os.path.join(DATA, "raw_kw_*.json")))
    files += [os.path.join(DATA, "raw_pois_kw.json")]   # 旧命名兼容
    out = []
    for p in files:
        if not os.path.exists(p):
            continue
        rows = json.load(open(p, encoding="utf-8"))
        out += rows
        print(f"  载入 {os.path.basename(p)}: {len(rows)} 条")
    return out


def main():
    print("载入原始数据…")
    raw = load_raw()
    print(f"  合计 {len(raw)} 条（含重复）")

    # 区界
    gj = json.load(open(os.path.join(DATA, "zhuhai_districts.geojson"), encoding="utf-8"))
    districts = [(f["properties"]["name"], shape(f["geometry"])) for f in gj["features"]]

    seen_id, rows = set(), []
    for p in raw:
        pid = p.get("id")
        if not pid or pid in seen_id:
            continue
        seen_id.add(pid)

        name = (p.get("name") or "").strip()
        loc = p.get("location") or ""
        if "," not in loc:
            continue
        lng, lat = (float(x) for x in loc.split(",")[:2])
        if not (113.0 < lng < 114.3 and 21.7 < lat < 22.6):
            continue
        # 严格限定珠海市（440402 香洲 / 440403 斗门 / 440404 金湾）
        adcode = str(p.get("adcode") or "")
        if not adcode.startswith("4404"):
            continue
        if re.search(NOISE, name) or re.search(CVS, name):
            continue

        # 品牌
        brand = None
        for pat, bname in BRANDS:
            if re.search(pat, name, re.I):
                brand = bname
                break
        if brand is None and re.search(r"益禾堂|蜜雪", name):
            continue

        # 区域：优先用高德 adcode（权威），几何兜底，最后就近归属
        ADNAME = {"440402": "香洲区", "440403": "斗门区", "440404": "金湾区"}
        pt = Point(lng, lat)
        district = ADNAME.get(adcode)
        if not district:
            district = next((nm for nm, geom in districts if geom.contains(pt)), None)
        if not district:
            # 横琴澳大校区等飞地不在区界多边形内，按最近区界归属
            district = min(districts, key=lambda kv: kv[1].distance(pt))[0]

        # 商圈
        area, best = "其他", 2600
        for an, ax, ay in AREAS:
            d = hav(lng, lat, ax, ay)
            if d < best:
                area, best = an, d

        biz = p.get("biz_ext") if isinstance(p.get("biz_ext"), dict) else {}
        rating = num(biz.get("rating"))
        cost = num(biz.get("cost"))
        hr = parse_hours(biz.get("open_time"))

        # 店名推断的业态标签
        tags = [t for pat, t in TAG_RULES if re.search(pat, name, re.I)]

        # 营业时间推断的事实标签（不依赖店名，覆盖率 74%）
        if hr:
            a, b = hr
            if a == 0 and b == 1440:
                tags.append("24小时")
            else:
                if a <= 8 * 60:
                    tags.append("早咖")
                if b >= 22 * 60 or b < a:      # 跨夜营业也算夜咖
                    tags.append("夜咖")

        rows.append({
            "id": pid,
            "name": name,
            "brand": brand,
            "lng": round(lng, 6),
            "lat": round(lat, 6),
            "address": p.get("address") if isinstance(p.get("address"), str) else "",
            "district": district,
            "area": area,
            "type": p.get("type") or "",
            "tel": p.get("tel") if isinstance(p.get("tel"), str) and ";" not in (p.get("tel") or "") else "",
            "rating": rating,
            "cost": cost,
            "tags": tags,
            "open": hr[0] if hr else None,
            "close": hr[1] if hr else None,
            "hours": fmt_hours(hr),
            "photos": len(p["photos"]) if isinstance(p.get("photos"), list) else 0,
        })

    # 二次去重：同名 + 60m 内
    rows.sort(key=lambda r: (-(r["rating"] or 0), r["name"]))
    kept, grid = [], defaultdict(list)
    for r in rows:
        key = re.sub(r"[\s()（）\-·]", "", r["name"]).lower()[:8]
        cell = (round(r["lng"], 3), round(r["lat"], 3))
        dup = False
        for c in [(cell[0] + i, cell[1] + j) for i in (-1, 0, 1) for j in (-1, 0, 1)]:
            for o in grid.get((key, c), []):
                if hav(r["lng"], r["lat"], o["lng"], o["lat"]) < 60:
                    dup = True
                    break
            if dup:
                break
        if dup:
            continue
        grid[(key, cell)].append(r)
        kept.append(r)

    print(f"  清洗后 {len(kept)} 家（剔除 {len(rows)-len(kept)} 条重复/噪声）")

    # ── 输出 ─────────────────────────────────────────
    json.dump(kept, open(os.path.join(DATA, "coffee_clean.json"), "w", encoding="utf-8"),
              ensure_ascii=False, indent=1)

    feats = [{
        "type": "Feature",
        "geometry": {"type": "Point", "coordinates": [r["lng"], r["lat"]]},
        "properties": {k: v for k, v in r.items() if k not in ("lng", "lat")},
    } for r in kept]
    json.dump({"type": "FeatureCollection", "features": feats},
              open(os.path.join(DATA, "coffee.geojson"), "w", encoding="utf-8"),
              ensure_ascii=False)

    # 前端数据打包逻辑抽到 build_web.py，本地和 CI 走同一条路径
    write_all(kept, gj)

    # ── 统计 ─────────────────────────────────────────
    dc = Counter(r["district"] for r in kept)
    bc = Counter(r["brand"] for r in kept if r["brand"])
    ac = Counter(r["area"] for r in kept)
    chain = sum(1 for r in kept if r["brand"])
    rated = [r["rating"] for r in kept if r["rating"]]
    costs = [r["cost"] for r in kept if r["cost"]]

    print("\n── 区域分布 ──")
    for k, v in dc.most_common():
        print(f"  {k:6s} {v:4d}")
    print("\n── 商圈 Top ──")
    for k, v in ac.most_common(12):
        print(f"  {k:8s} {v:4d}")
    print(f"\n── 品牌 Top ──  连锁 {chain} 家 / 独立 {len(kept)-chain} 家")
    for k, v in bc.most_common(15):
        print(f"  {k:10s} {v:4d}")
    if rated:
        print(f"\n评分 {len(rated)} 家有值，均值 {sum(rated)/len(rated):.2f}")
    if costs:
        print(f"人均 {len(costs)} 家有值，中位 {sorted(costs)[len(costs)//2]:.0f} 元")

    hrs = sum(1 for r in kept if r["hours"])
    tagged = sum(1 for r in kept if r["tags"])
    tc = Counter(t for r in kept for t in r["tags"])
    print(f"\n营业时间 {hrs} 家有值（{hrs/len(kept)*100:.0f}%）")
    print(f"有标签 {tagged} 家（{tagged/len(kept)*100:.0f}%）")
    for k, v in tc.most_common(14):
        print(f"  {k:8s} {v:4d}")

    print(f"\n输出完成 → web/data/coffee.js（{len(kept)} 家）")


if __name__ == "__main__":
    main()
