# 珠海咖啡地图 · Zhuhai Coffee Map

用高德 POI 数据做的珠海全域咖啡地图。纯静态 Web，无需后端。

## 目录

```
zhuhai-coffee-map/
├── .github/workflows/
│   ├── pages.yml         # 推到 main → 构建 → 部署 GitHub Pages
│   └── refresh-data.yml  # 每周自动重新采集 + 清洗 + 提交回主干
├── scripts/
│   ├── .env              # 高德 Key（已 gitignore，绝不提交）
│   ├── fetch.py          # 采集：自适应网格 + 截断判定 + 陆地掩膜 + 本地缓存
│   ├── clean.py          # 清洗：去重 / 品牌识别 / 业态打标 / 营业时间解析
│   ├── build_web.py      # 打包：coffee_clean.json → web/data/*.js（CI 只跑这一步）
│   ├── gen_config.py     # 注入高德 Key → web/config.js（已 gitignore）
│   ├── verify.js         # Playwright 无头截图验证
│   └── verify-label.js   # 标签层专项验证
├── data/
│   ├── zhuhai_districts.geojson   # 区界（阿里 DataV GeoAtlas）
│   ├── coffee_clean.json          # 清洗后完整字段（站点唯一数据源）
│   ├── coffee.geojson             # GIS 分析用
│   ├── raw_*.json                 # 采集快照（已 gitignore，fetch.py 可重建）
│   └── cache/                     # 网格级缓存（已 gitignore，重跑不耗配额）
└── web/
    ├── index.html
    ├── config.js                 # 高德 Key 注入产物（已 gitignore）
    ├── style.css                 # 液态玻璃皮肤 + 布局
    ├── app.js                    # 逻辑 + 画布调色板 PAL
    ├── vendor/liquidlens/        # LiquidLens（MIT）液态玻璃材质引擎
    │   ├── liquid-glass.js       #   边缘折射：SVG feDisplacementMap
    │   ├── liquid-glass.css      #   材质分层（折射/高光/色散/内光）
    │   ├── tokens.css            #   设计令牌 --lg-*
    │   └── LICENSE
    └── data/
        ├── coffee.js              # 内嵌数据（file:// 也能打开）
        └── districts.js
```

## 用法

```bash
# 0. 装依赖（只有 clean.py 需要 shapely 做区界几何判定）
pip install -r requirements.txt

# 1. 主采集：按 typecode 050500（咖啡厅）全域扫描
python scripts/fetch.py --step 0.02

# 2. 关键词补采：捞回被高德误分类成"中餐厅"等类目的店
#    多个关键词用 | 分隔，一次采集即可覆盖
python scripts/fetch.py --step 0.02 --keywords "coffee|cafe|roaster|espresso|latte"
python scripts/fetch.py --step 0.05 --keywords "咖啡"

# 3. 清洗打标（自动合并 raw_pois.json + 所有 raw_kw_*.json）
python scripts/clean.py

# 4. 注入高德 Key（读取 scripts/.env，生成 web/config.js）
python scripts/gen_config.py

# 5. 本地预览
cd web && python -m http.server 8080
# 打开 http://localhost:8080
```

> **本地预览先确认高德 Key 的域名白名单**。JS API 的 Key 如果在高德控制台配了白名单，
> 本地 `localhost` / `127.0.0.1` 不在名单里时，`webapi.amap.com/maps` 会返回
> `{"info":"INVALID_USER_DOMAIN","infocode":"10006"}` 且 `Content-Type: application/json`，
> Chrome 的 ORB 会把它当脚本响应拦掉，表现为加载画面停在"地图引擎加载失败"。
> 去控制台把 `localhost` 一起加进白名单即可（生产只放 `*.github.io`）。

## 液态玻璃材质

界面是 Apple Liquid Glass 风格，材质来自 [LiquidLens](https://github.com/DevBehindYou/LiquidLens)（MIT，
vendor 在 `web/vendor/liquidlens/`）。它的核心主张是：**液态玻璃 ≠ 背景模糊，关键是边缘折射**——
用 SVG `feDisplacementMap` 按凸超椭圆边缘 + Snell 定律（空气 n=1 → 玻璃 n=1.5）把玻璃背后的
背景像通过透镜一样弯折放大。所以 `blur` 必须压在 0–4，一高折射就被糊掉了。

接入方式：

```html
<link rel="stylesheet" href="vendor/liquidlens/tokens.css">       <!-- 必须在 liquid-glass.css 前 -->
<link rel="stylesheet" href="vendor/liquidlens/liquid-glass.css">
<link rel="stylesheet" href="style.css">                            <!-- 自己的样式最后，方便覆盖 -->

<div id="panel" class="lg-glass" data-glass>…</div>

<script src="vendor/liquidlens/liquid-glass.js"></script>
<script>LiquidGlass.init({ refraction:20, bezel:26, blur:2, saturation:1.9,
                           specular:.95, tintHue:32, tintOpacity:.40, quality:420 });</script>
```

几个针对本项目的取舍：

- **只有大面板走真折射**（`#panel` / `#rank` / 工具栏按钮 / 图例 / toast / 信息卡，共 11 个位移贴图）。
  筛选区一次能冒出三四十个 chip，每个都生成一张贴图会把 init 拖慢，视觉上也看不出差别，
  所以 chip、品牌行、排序钮用同色系的纯 CSS 玻璃（库文档同样建议"少量大面板"优先）
- **悬停浮层只加 `lg-glass` 不加 `data-glass`**：它随指针高频移动，每次重算贴图不划算
- **亮色主题必须改 `--lg-fg`**：库默认玻璃上的文字是白色（配深色玻璃），这里改成 `#211c16`
- **选中态用库自己的 tint 机制**（`--lg-tint-h/a/l` 写在单个元素上），不整块盖掉背景
- **`prefers-reduced-transparency` 的降级要单独改**：库自带的是深色不透明，亮色主题下会变成一块突兀的黑卡，
  且 `backdrop-filter` 得加 `!important`——JS 会写 inline style，普通声明盖不过它
- **折射只在 Chromium 生效**，Safari / Firefox 自动降级成"模糊 + 高光"，观感仍然成立

画布上那些标记（圆点、聚类、店名胶囊、定位蓝点）的颜色集中在 `app.js` 顶部的 `PAL` 对象里，
和 `style.css` 的 `--chain` / `--indie` / `--saved` 是同一套语义，改一边要记得改另一边。


## 部署到 GitHub Pages

仓库推到 GitHub 后，`push` 到 `main` 会自动跑 `.github/workflows/pages.yml`：
注入 Key（`gen_config.py`）→ 打包前端数据（`build_web.py`）→ 构建校验 → 部署到 Pages。
不需要手动构建，也不需要把 `web/data/*.js` 提交上去。

开启步骤：

```bash
# 1. 建仓库并推送（公开仓库——GitHub Free 的 Pages 只支持公开仓库）
gh repo create zhuhai-coffee-map --public --source=. --push

# 2. 把 scripts/.env 里的三个 Key 一次性导入为仓库 secret（值不会进仓库）
gh secret set -f scripts/.env

# 3. 开 Pages（source 选 GitHub Actions）
gh api -X POST repos/{owner}/{repo}/pages -f build_type=workflow
```

之后站点地址是 `https://<user>.github.io/zhuhai-coffee-map/`。
所有资源都是相对路径（`style.css`、`data/coffee.js`、`config.js`），所以挂在项目子路径下也能正常跑。

### 每周自动更新数据

`.github/workflows/refresh-data.yml` 每周一自动重新采集、清洗、提交回 `main`，
提交再触发 Pages 重新部署。它用的是 `AMAP_WEB_KEY`，上面第 2 步已经一起导入了。

## 高德 Key 为什么不写进仓库

`web/index.html` 原本把 JS Key 和安全密钥硬编码在 `<script>` 标签里。仓库要公开，
硬编码的 Key 会永久留在 git 历史、被 GitHub 代码搜索索引、被扫号脚本批量捞走盗刷配额。
所以改成构建期注入：仓库里只有 `<script src="config.js"></script>`，真值来自
`scripts/.env`（本地）或 GitHub Secrets（CI），`web/config.js` 被 `.gitignore` 忽略。

`config.js` 用 `document.write` 而不是 `createElement` 插入高德脚本，是为了保持同步加载时序
——`app.js` 依赖高德脚本在它之前执行完，用 `createElement` 会变成异步，`app.js` 会在
`AMap` 就绪前跑起来。

**换 Key**：改 `scripts/.env` 后重跑 `python scripts/gen_config.py`，再同步更新
GitHub 的 `AMAP_JS_KEY` / `AMAP_JS_SECURITY` 两个 secret。

**建议去高德控制台给 Key 加域名白名单**（只放 `*.github.io` 和 `localhost`）。
客户端代码里的 Key 任何人 view-source 都能看到，这是 JS API 的固有性质，域名白名单是唯一有效的兜底。


## 实现要点

**突破 200 条上限**
高德 `place/polygon` 同一组参数翻页最多返回 200 条（`offset≤25` × 8 页）。脚本按网格切分递归四分。

**用 `count` 判断截断，而不是猜阈值**
接口每次都会返回 `count`（该区域命中总数）。若 `count > 实收条数`，说明确实被截断了，必须细分；否则不管收了多少条都不细分。早期版本用「≥180 条就细分」的经验阈值，会漏掉「实际 250 家但只返回 200 家」的格子——横琴一带就因此漏采，因为相邻的澳门店铺把 200 条配额占满了。

**多关键词合并**
高德 `keywords` 支持 `|` 分隔多词，`咖啡|coffee|cafe` 一次请求即可，比逐词跑省下数倍调用。

**陆地掩膜省配额**
用区界多边形做 `prepared.intersects` 判断，海面网格直接跳过，不消耗 API 调用。珠海 bbox 里有近一半是海。

**网格级缓存**
每个网格的结果落盘到 `data/cache/`，重跑只补缺失格。调参迭代时不烧配额。缓存按「关键词 + 矩形」命名，不同关键词互不覆盖。

**坐标系**
高德返回 GCJ-02，前端同源使用无需转换。若要导出到 OSM/Mapbox 需转 WGS84（`gcoord`）。

## 数据字段

| 字段 | 说明 |
|---|---|
| `id` | 高德 POI ID |
| `name` / `address` | 店名 / 地址 |
| `brand` | 识别出的连锁品牌，`null` 为独立小店 |
| `district` | 香洲 / 斗门 / 金湾（优先 adcode，几何兜底） |
| `area` | 商圈（12 个中心点 2.6km 半径最近归属） |
| `rating` / `cost` | 评分 / 人均（高德 `biz_ext`） |
| `open` / `close` / `hours` | 营业时间，分钟数与展示串（解析自 `biz_ext.open_time`，覆盖 76%） |
| `tags` | 业态标签：店名推断（手冲 / 海景 / 宠物友好 / 有烘焙 / 日咖夜酒…）+ 营业时间推断（早咖 / 夜咖 / 24小时） |

## 当前数据（2026-10-25 采集）

| 指标 | 数值 |
|---|---|
| 咖啡馆总数 | **1303 家** |
| 香洲区 / 斗门区 / 金湾区 | 930 / 196 / 177 |
| 连锁 / 独立 | 321 / 982 |
| 识别出的连锁品牌 | 13 个（瑞幸 158、库迪 81、星巴克 46、挪瓦 10、幸运咖 6…） |
| 评分覆盖 | 1293 家（均值 3.98） |
| 人均覆盖 | 1073 家（中位 22 元） |
| 营业时间覆盖 | 985 家（76%，解析自高德 `biz_ext.open_time`） |
| 有标签 | 703 家（54%，此前仅店名推断时只有 13%） |
| 原始 POI | 6528 条（含跨市重复）→ 去重 2328 → 珠海 4404 段 1259+ |
| API 调用 | 主采集 638 次 + 关键词补采约 1400 次 |

### 覆盖率怎么验证的

高德按行政区返回的 `count` 是权威总量（`place/text` 单区查询，未触顶）：

| 区 | 高德自报（关键词「咖啡」） | 高德自报（typecode 050500） | 本项目 |
|---|---|---|---|
| 香洲 | 600+（触顶，实际更多） | 600+（触顶） | 930 |
| 斗门 | 199 | — | 196 |
| 金湾 | 158 | 134 | 177 |

斗门 196/199 = 98.5%，金湾 177 超过单一口径（因为取了两者并集），香洲远超 600 的返回上限。可以认为对高德索引内的咖啡店已基本无遗漏——**但高德本身没收录的店（新店、纯手作小店）不会出现在这里**。

## 已实现

- **液态玻璃皮肤**：整套界面换成 Apple Liquid Glass 风格，材质用 LiquidLens（MIT）做**真边缘折射**而不是单纯模糊——玻璃背后的地图会像通过透镜一样在边缘被弯折放大。亮色底图 + 暖白玻璃 + 深色文字，选中态靠单个元素的 tint 色相切换，指针移动时高光会跟着走
- **加载画面**：高德 JS API 的网络链路（`maps` → `migrate` → `init` → `checkredirect` → `icons`×5）实测要 1.6s，这期间页面是全黑的，用户很容易以为卡死而关掉或反复刷新。首屏先盖一层品牌加载页，按真实进度分段提示（「正在加载地图引擎」→「已载入 1303 家 · 正在绘制」），数据和底图都就绪后淡出。另有三重保护：最短显示 420ms 防闪烁、12s 硬兜底强制撤除遮罩（不让用户被锁在全屏遮罩后面）、以及高德脚本没加载上时**区分两种原因**给出明确错误 + 「重新加载」按钮——没配 Key 提示去跑 `gen_config.py`，配了但网络不通才提示检查网络
- **Canvas 自绘标记层**：零 DOM 标记，随地图逐帧重绘，聚合/散点连续切换
- **定位 + 就近优先**：右上角「定位」调用浏览器定位（失败回退 IP），画蓝点 + 精度圈；定位后自动切到「1km」档，近处的点全亮、远处按距离压暗，悬停与信息卡显示「距我 524m」
- **定位后直接显示店名标签**：按下「定位」后自动开启，附近咖啡馆的店名以胶囊形式直接铺在地图上（店名 + 距离 + 评分），不用逐个点开。胶囊按距离由近到远贪心占位，与已放置标签冲突就换方向（右→左→上→下），四个方向都放不下就跳过，同屏最多 36 个；标签本身可点击，悬停还能看到营业时间和业态标签
- **右侧评分排面板**：右栏常驻榜单，跟随左侧筛选实时重排，默认按评分降序（同分比图片数再比店名，顺序稳定不跳），可切「距离 / 人均」排序。前三名序号金色高亮，每行显示距离·人均·业态标签；**点行飞到店里并开卡片，悬停行在地图上高亮对应圆点，反过来悬停地图圆点也会高亮榜单行**（双向联动）。榜单取前 200 家，底部注明总数
- **工具栏改为竖排**，夹在左右两个面板之间（`left:372px`），任何窗口宽度都不会和面板打架；筛选面板收起时工具栏跟着挪到最左边（`body.pcollapsed`）
- **标签模式**：右上角「标签」可手动开关；缩放低于街区级时按钮转为"已开但未生效"态，此时再点会自动放大到 14.8 级（没有定位时会自动跳到当前筛选结果里最密的地方，不会落在空旷处）
- **聚类**：屏幕像素空间分桶，格子随缩放收缩（11 级 62px → 17 级 38px），17.6 级之后完全散开；单点格也登记命中，点簇自动放大到 18 级
- 单点半径随缩放递增（6.4px → 10px），带深色描边 + 外圈高光，暗底辨识度高
- 筛选结果收敛到 20 家以内时**自动飞到结果**；≤3 家时每个点加定位环
- 暗色底图 + 悬停浮层（店名/评分 · 或「N 家咖啡馆」）
- 筛选：区域 / 连锁独立 / 评分 / 人均 / 8 类业态标签 / 品牌，点击即时生效
- 本地搜索、信息卡（评分·人均·商圈·标签 + 导航跳转 + 复制坐标）
- 收藏（localStorage）+ 只看收藏、区界开关
- URL 参数分享（`?d=香洲区&b=瑞幸咖啡` 直接还原筛选）
- 数字滚动、标记淡入、移动端底部抽屉
- 快捷键：`/` 聚焦搜索、`Esc` 关卡片

## 性能

改造前后对比（1303 家，1440×900）：

| 指标 | DOM 标记方案 | Canvas 图层 |
|---|---|---|
| 高倍下 DOM 节点 | 2231 | 220 |
| 切换筛选（同步阻塞） | 185–327 ms | 0.4–2.2 ms |
| 单帧重绘 | 全量重建 DOM | 0.02–1.24 ms |
| 平移时标记跟随 | moveend 后跳变 | 逐帧同步 |


## 已知局限

- **集群模式下"单点格"必须单独登记命中**：分桶后 `n===1` 的格子是直接画点，早期版本在这里 `return` 掉了，导致这些点既不能悬停也不能点击（表现为"有些点点不开"）。已在同一分支补 `hits.push`。
- **浏览器定位在 `file://` 下会被部分浏览器拒绝**：Chrome 一般放行，Safari 会直接拒绝。本地调试建议 `python -m http.server 8080` 走 `http://localhost`；真机部署走 HTTPS。定位失败时高德插件会自动回退 IP 定位（精度到街道，可能落在隔壁城市），页面会弹提示告知。
- **聚类的开合阈值不要设太低**：早期版本 15.4 级就停止聚类，结果 15.4–18 级之间密集街区全是互相压盖的散点，看起来像"没有聚类"。现在格子随缩放收缩、阈值提到 17.6 级，过渡是渐进的。
- **地图暗色是靠 CSS 滤镜实现的**：该 Key 无法使用高德内置 `amap://styles/*` 样式（实测三种样式渲染结果字节级相同），因此用 `invert + hue-rotate` 反转瓦片画布。副作用是区界线也被一起反色，已通过调色补偿
- **`AMap.LngLat.set()` 在 2.0 不存在**，投影必须直接传 `[lng, lat]` 数组，否则抛异常（会被 try/catch 静默吞掉，表现为画布空白）
- **筛选条件变化时视野必须跟着变**。踩过两次：一次是结果收敛到 20 家以内时地图不动（"筛出 1 家却看不到点"），用 `flyTo()` 解决；一次是反过来——点「3km/5km」数量变了但地图还停在 1km 的缩放，范围外的店全在视口外，表现为"点了没反应"，用 `fitToDist()` 按半径反算缩放解决
- **加侧栏后面板会互相打架**。右侧排面板加上后，原来在右上角的工具栏在 ≤1000px 时会压住左面板。最终方案是工具栏竖排夹在两个面板之间（`left:372px`），筛选面板收起时用 `body.pcollapsed` 把它挪到最左；≤1000px 时右面板改成浮层且默认收起（左距 444px，避开工具栏），≤760px 时变成底部抽屉
- **`setBounds` 的 avoid 边距必须把所有可见面板都算进去**，否则结果点会落在面板底下。`viewPadding()` 按 上/右/下/左 四个方向分别给左筛选面板 356、右排面板 316、移动端底部 62vh，并保底留 240px 可视区
- **缩放动画结束时 AMap 不一定再触发 `zoom` 事件**，必须同时监听 `zoomend` / `moveend`，否则画布停在动画中途那一帧（表现为"放大后标记消失"）
- **高德 Key 的域名白名单会把错误伪装成"网络问题"**。白名单不含当前域名时，`webapi.amap.com/maps` 返回的是 `{"info":"INVALID_USER_DOMAIN","infocode":"10006"}` 且 `Content-Type: application/json`——不是 JS。Chrome 的 ORB（Opaque Response Blocking）会直接把它当脚本响应拦掉，`requestfailed` 里只留一个 `net::ERR_BLOCKED_BY_ORB`，控制台连一行报错都没有。排查时先 `curl` 那个地址看返回体，别被 ORB 的错号带偏。另外 Playwright 的 `page.route()` 改不了 `Referer`（AMap 2.0 用 `securityJsCode` + 来源算 MD5），所以本地想绕过白名单做无头验证是行不通的，只能去控制台加域名
- 高德不提供菜单、座位/插座等信息；营业时间有 76% 覆盖但可能存在门店调整，`tags` 由店名与营业时间推断，会有误判（"手冲"只有 6 家命中，明显偏少）
- POI 闭店状态滞后，出行前建议二次确认
- 数据版权归高德，仅供个人展示使用