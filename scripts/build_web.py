"""把清洗后的数据集打包成前端用的 JS 文件

输入（都在仓库里，CI 也能拿到）:
  data/coffee_clean.json         清洗后的完整字段
  data/zhuhai_districts.geojson  区界
输出:
  web/data/coffee.js             window.COFFEE_DATA + window.DATA_UPDATED
  web/data/districts.js          window.ZH_DISTRICTS

从 clean.py 里拆出来，是为了让 GitHub Pages 的构建不必依赖
data/raw_*.json（8MB 采集快照，已 gitignore）——CI 只需要这一步。
也顺带保证本地和 CI 产出的是同一份代码路径，不会两边漂移。

用法:
    python scripts/build_web.py
"""
import datetime
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, ".."))
DATA = os.path.join(ROOT, "data")
WEB = os.path.join(ROOT, "web")


def write_all(kept, districts_gj, updated=None):
    """把 kept（清洗后列表）+ 区界写成 web/data/ 下的两个 JS 文件"""
    if updated is None:
        updated = datetime.date.today().isoformat()
    os.makedirs(os.path.join(WEB, "data"), exist_ok=True)
    with open(os.path.join(WEB, "data", "coffee.js"), "w", encoding="utf-8") as f:
        f.write("window.COFFEE_DATA=")
        json.dump(kept, f, ensure_ascii=False, separators=(",", ":"))
        f.write(";\n")
        f.write(f'window.DATA_UPDATED="{updated}";\n')
    with open(os.path.join(WEB, "data", "districts.js"), "w", encoding="utf-8") as f:
        f.write("window.ZH_DISTRICTS=")
        json.dump(districts_gj, f, ensure_ascii=False, separators=(",", ":"))
        f.write(";\n")
    return len(kept)


def main():
    src = os.path.join(DATA, "coffee_clean.json")
    if not os.path.exists(src):
        raise SystemExit(f"缺少 {src}，先跑 python scripts/clean.py")
    with open(src, encoding="utf-8") as f:
        kept = json.load(f)
    with open(os.path.join(DATA, "zhuhai_districts.geojson"), encoding="utf-8") as f:
        gj = json.load(f)
    n = write_all(kept, gj)
    print(f"已生成 web/data/coffee.js（{n} 家）+ web/data/districts.js")


if __name__ == "__main__":
    main()
