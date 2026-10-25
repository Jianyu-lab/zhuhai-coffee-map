"""生成 web/config.js —— 把高德 Key 从仓库里请出去

为什么要有这一步：
  web/index.html 原本把 JS Key 和安全密钥硬编码在 <script> 标签里。
  仓库要公开（GitHub Free 的 Pages 只支持公开仓库），硬编码的 Key 会永久
  留在 git 历史里、被 GitHub 代码搜索索引、被扫号脚本批量捞走盗刷配额。
  所以改成构建期注入：仓库里只有占位，真值来自
    - 本地：scripts/.env 或环境变量
    - CI ：GitHub Secrets（AMAP_JS_KEY / AMAP_JS_SECURITY）

用法:
    python scripts/gen_config.py
    AMAP_JS_KEY=xx AMAP_JS_SECURITY=yy python scripts/gen_config.py

产出 web/config.js（已被 .gitignore 忽略）。
"""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, ".."))
OUT = os.path.join(ROOT, "web", "config.js")


def read_dotenv():
    """解析 scripts/.env → dict（跳过注释/空行，去掉引号）"""
    cfg = {}
    p = os.path.join(HERE, ".env")
    if not os.path.exists(p):
        return cfg
    with open(p, encoding="utf-8") as f:
        for raw in f:
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            cfg[k.strip()] = v.strip().strip('"').strip("'")
    return cfg


def render(key, sec):
    # document.write 而不是 createElement+appendChild：
    # 解析期插入的外链脚本会阻塞解析、加载完立即执行，和原来写在 index.html 里的
    # 普通 <script> 标签时序一致，app.js 才能直接拿到 AMap。
    # 用 createElement 会变成异步加载，app.js 会在 AMap 就绪前跑。
    loader = (
        "if(window.AMAP_KEY){document.write('<script src=\"https://webapi.amap.com/maps"
        "?v=2.0&key='+encodeURIComponent(window.AMAP_KEY)+'&plugin=AMap.Scale,"
        "AMap.Geolocation\"><\\/script>')}"
    )
    return "\n".join([
        "// 由 scripts/gen_config.py 自动生成，已被 .gitignore 忽略",
        "// 不要手改、不要提交。换 Key：改 scripts/.env 后重跑本脚本",
        "window.AMAP_KEY=%s;" % json.dumps(key),
        "window._AMapSecurityConfig={securityJsCode:%s};" % json.dumps(sec),
        loader,
        "",
    ])


def main():
    cfg = read_dotenv()
    key = (os.environ.get("AMAP_JS_KEY") or cfg.get("AMAP_JS_KEY") or "").strip()
    sec = (os.environ.get("AMAP_JS_SECURITY") or cfg.get("AMAP_JS_SECURITY") or "").strip()

    if not key:
        # CI 上 secret 没配时不退出：写一个空 Key 的 config，
        # 页面会走 app.js 里"未配置高德 Key"的提示分支，而不是白屏。
        print("!! 未找到 AMAP_JS_KEY，生成的 config.js 不含可用 Key", file=sys.stderr)

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        f.write(render(key, sec))
    print("已生成 web/config.js（Key %s）" % ("已注入" if key else "为空"))


if __name__ == "__main__":
    main()
