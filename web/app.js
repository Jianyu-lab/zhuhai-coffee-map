/* 珠海咖啡地图 · 前端逻辑
   渲染策略：单张 canvas 自绘图层（不创建任何 DOM 标记），
   地图每次 move/zoom 触发一次 rAF 重绘，标记与底图严格同步。 */
(function () {
  'use strict';

  // 高德脚本没加载上（断网/被墙/CDN 挂了）时，后面每一行都会抛 AMap is not defined，
  // 整个 IIFE 中断、加载画面永远撤不掉，用户看到的是一块死黑屏。
  // 所以在最前面拦住，给出明确错误和重试入口。
  if (typeof AMap === 'undefined') {
    const el = document.getElementById('loader');
    const stage = document.getElementById('ld-stage');
    if (el && stage) {
      el.classList.add('failed');
      // 区分两种失败：没配 Key（本地忘了跑 gen_config.py / CI 上 secret 没设）
      // 和配了但网络不通。两者的处理方式完全不同，不能都提示"检查网络"。
      stage.textContent = window.AMAP_KEY
        ? '地图引擎加载失败 · 请检查网络后重试'
        : '未配置高德 Key · 本地跑 scripts/gen_config.py，CI 上配 AMAP_JS_KEY';
      const btn = document.createElement('button');
      btn.className = 'ld-retry';
      btn.textContent = '重新加载';
      btn.onclick = () => location.reload();
      el.querySelector('.ld-inner').appendChild(btn);
    }
    return;
  }

  const DATA = window.COFFEE_DATA || [];
  const DISTRICTS = window.ZH_DISTRICTS || { features: [] };
  const SAVED_KEY = 'zh_coffee_saved_v1';
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));
  const saved = new Set(JSON.parse(localStorage.getItem(SAVED_KEY) || '[]'));

  /* ── 调色板 ─────────────────────────────────────
     液态玻璃（Liquid Glass）风格，明暗两套。
     绘制代码里只读 PAL.xxx，切换主题时换掉 PAL 指向的对象即可，
     所以这里必须是 let，且不允许在别处解构缓存色值。 */
  const PAL_LIGHT = {
    // 连锁 / 独立 / 收藏：亮底上要用深一档才立得住
    chain: '#C67A3D',
    indie: '#2E9E78',
    saved: '#D6476B',
    // 圆点靠白边 + 深色柔环在亮底上分层
    dotEdge: 'rgba(255,255,255,.92)',
    dotRing: 'rgba(42,33,25,.12)',
    emphFill: 'rgba(42,33,25,.05)',
    emphEdge: 'rgba(42,33,25,.20)',
    savedGlow: 'rgba(214,71,107,.26)',
    hoverGlow: 'rgba(42,33,25,.09)',
    // 聚类保留品牌金，只把描边和数字换成亮底版本
    cluster: 'rgba(224,164,88,.94)',
    clusterHover: '#EFB966',
    clusterGlow: 'rgba(224,164,88,.20)',
    clusterEdge: 'rgba(255,255,255,.8)',
    clusterText: '#241C15',
    // 定位：Apple 蓝
    meFill: 'rgba(10,132,255,.12)',
    meEdge: 'rgba(10,132,255,.32)',
    meGlow: 'rgba(10,132,255,.18)',
    me: '#0A84FF',
    meDotEdge: '#FFFFFF',
    // 店名胶囊：白玻璃，必须配柔影才从亮色地图上分出来
    pillBg: 'rgba(255,255,255,.88)',
    pillBgHl: 'rgba(255,255,255,.99)',
    pillEdge: 'rgba(42,33,25,.10)',
    pillEdgeHl: 'rgba(198,122,61,.85)',
    pillText: '#241C15',
    pillTextHl: '#171310',
    pillShadow: 'rgba(60,40,20,.22)',
    distBadge: '#5B8DEF',
    ratingBadge: '#A87428',
    // 区界
    bound: '#C67A3D',
    boundLabel: 'rgba(160,105,58,.85)',
    boundLabelShadow: '0 1px 6px rgba(255,255,255,.9)',
  };

  /* 暗色：底图换成高德官方深色样式，标记要整体提亮一档才看得见；
     店名胶囊从白玻璃翻成深玻璃，配浅色文字。 */
  const PAL_DARK = {
    chain: '#E8A863',
    indie: '#54CFA0',
    saved: '#FF6E8E',
    // 深底上白边会发光过头，降到半透明只做分离
    dotEdge: 'rgba(255,255,255,.62)',
    dotRing: 'rgba(0,0,0,.45)',
    emphFill: 'rgba(255,255,255,.10)',
    emphEdge: 'rgba(255,255,255,.30)',
    savedGlow: 'rgba(255,110,142,.40)',
    hoverGlow: 'rgba(255,255,255,.18)',
    cluster: 'rgba(226,166,90,.96)',
    clusterHover: '#F5C67A',
    clusterGlow: 'rgba(226,166,90,.32)',
    clusterEdge: 'rgba(255,255,255,.5)',
    clusterText: '#1B1611',
    meFill: 'rgba(77,163,255,.18)',
    meEdge: 'rgba(77,163,255,.52)',
    meGlow: 'rgba(77,163,255,.32)',
    me: '#4DA3FF',
    meDotEdge: '#FFFFFF',
    pillBg: 'rgba(26,22,18,.86)',
    pillBgHl: 'rgba(40,34,27,.97)',
    pillEdge: 'rgba(255,255,255,.13)',
    pillEdgeHl: 'rgba(232,168,99,.8)',
    pillText: '#EDE6DC',
    pillTextHl: '#FFF8EE',
    pillShadow: 'rgba(0,0,0,.55)',
    distBadge: '#7FB2FF',
    ratingBadge: '#E0A458',
    bound: '#E8A863',
    boundLabel: 'rgba(242,222,196,.82)',
    boundLabelShadow: '0 1px 6px rgba(0,0,0,.9)',
  };

  let PAL = PAL_LIGHT;

  /* ══ 主题（明 / 暗）════════════════════════════
     暗色底图用高德官方深色样式，不走 CSS 反相 —— 反相会把路网颜色搞错，
     而且玻璃要去折射一张被反相的图，色相全歪。
     LiquidLens 的 --lg-tint-h / -a / --lg-spec 是 JS 写在 <html> 内联样式上的，
     内联优先级高于样式表，所以切换主题必须走 LiquidGlass.set()；
     --lg-tint-s / -l 这两个 JS 不碰，交给 CSS 的 :root[data-theme=dark] 覆盖。 */
  const THEME_KEY = 'zh_coffee_theme_v1';
  /* blur / tintA / sat 为什么明暗两套差这么多：
     日光底图是满屏白路网 + 绿地 + 彩色 POI，2px 模糊根本压不住，
     0.40 的白 tint 相当于什么都没挡 —— 文字后面全是地图的花纹。
     所以日光档做成磨砂牛奶玻璃：blur 10 / tint 0.68 / saturate 0.80。
     sat 压到 0.8：模糊只能把边缘糊掉，压不住"一大片绿地/水面"的色块，
     整块面板会被底图染成淡绿。先把背板去色再叠白，才真的干净。
     这三个数是量出来的，不是拍的：把面板文字全隐掉只截玻璃本身，
     逐档量像素标准差（底图轮廓透出来的程度）——
     0.76/16/0.50 是 3.0（几乎看不出材质），0.70/10/0.70 是 4.9，
     0.68/10/0.80 是 5.6，0.66/8/0.85 是 6.3（路网开始被读出来）。
     取 5.6 这一档：材质看得见，但路网还是糊的；面板平均亮度只从 244 掉到 241，
     深色文字的对比度基本没变。
     暗色档底图本身是黑的，不用去色（sat 反而可以留着，让深色玻璃有点冷调），
     tint 也不必加厚；但 blur 得给到 10 —— 原来 2px 的时候能透过面板
     读清底图上的地名（"市民…""香洲…"），面板随地图平移一直在变，
     观感就是"材质不稳"。模糊到 10 之后字糊成色块，才是磨砂该有的样子。
     代价是边缘折射被糊掉一些，但可读性优先于"液态"观感。 */
  const THEME_CFG = {
    light: { hue: 32, tintA: 0.68, spec: 0.95, sat: 0.80, blur: 10, mapStyle: 'amap://styles/normal' },
    dark:  { hue: 28, tintA: 0.26, spec: 0.55, sat: 1.35, blur: 10, mapStyle: 'amap://styles/dark' },
  };

  // 首屏先定主题，避免「先亮一下再变暗」的闪烁。
  // index.html 的 head 里已经同步设过 data-theme，以它为准，保证两边一致。
  let theme = (function () {
    const preset = document.documentElement.getAttribute('data-theme');
    if (preset === 'dark' || preset === 'light') return preset;
    let t = null;
    try { t = localStorage.getItem(THEME_KEY); } catch (e) {}
    if (t !== 'dark' && t !== 'light') {
      t = (window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light';
    }
    return t;
  })();
  document.documentElement.setAttribute('data-theme', theme);
  PAL = theme === 'dark' ? PAL_DARK : PAL_LIGHT;

  // 聚类：屏幕像素空间分桶。格子随缩放收缩，保证"放大到街道级只剩真正贴在一起的点才合并"
  const CLUSTER_MAX_ZOOM = 17.6;
  const CELL_BASE = 62, CELL_MIN = 30;
  function cellFor(z) {
    return Math.max(CELL_MIN, CELL_BASE - Math.max(0, z - 11) * 4);
  }

  const state = {
    q: '', district: '全部', kind: '全部', rating: 0,
    cost: '全部', tags: new Set(), brand: null, onlySaved: false,
    dist: '全部',
  };

  /* ══ 定位 ══════════════════════════════════════ */
  let me = null;                      // { lng, lat, acc }
  const DIST_LEVELS = [['全部', null], ['500m', 500], ['1km', 1000], ['3km', 3000], ['5km', 5000]];

  function distM(a, b, c, d) {        // 球面距离（米）
    const R = 6371000, p1 = a * Math.PI / 180, p2 = c * Math.PI / 180;
    const dp = p2 - p1, dl = (d - b) * Math.PI / 180;
    const h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  function fmtDist(m) {
    if (m == null) return '';
    return m < 1000 ? Math.round(m) + 'm' : (m / 1000).toFixed(1) + 'km';
  }

  /* ── cubic-bezier(x1,y1,x2,y2) → f(t) ──────────────────────────────
     和浏览器实现 CSS `cubic-bezier()` 用的是同一套算法：三次贝塞尔曲线的
     x(u)/y(u) 都是参数方程，给定 t 要先解 x(u)=t 反求 u，再取 y(u)。
     先用牛顿迭代（快），斜率太小或发散就退回二分（稳）。
     只建一次，之后每个元素每帧只做一次多项式求值。
     canvas 里没法用 CSS transition，所以曲线得自己算 —— 这是把
     Material / Fluent 那套"时长 + 缓动曲线"搬到 canvas 上的最小实现。 */
  function bezier(x1, y1, x2, y2) {
    const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
    const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
    const sx = (u) => ((ax * u + bx) * u + cx) * u;
    const sy = (u) => ((ay * u + by) * u + cy) * u;
    const dx = (u) => (3 * ax * u + 2 * bx) * u + cx;
    return function (t) {
      if (t <= 0) return 0;
      if (t >= 1) return 1;
      let u = t;
      for (let i = 0; i < 8; i++) {
        const err = sx(u) - t;
        if (Math.abs(err) < 1e-6) return sy(u);
        const d = dx(u);
        if (Math.abs(d) < 1e-6) break;
        u -= err / d;
      }
      let lo = 0, hi = 1;
      u = t;
      for (let i = 0; i < 22; i++) {
        const x = sx(u);
        if (Math.abs(x - t) < 1e-6) break;
        if (x < t) lo = u; else hi = u;
        u = (lo + hi) / 2;
      }
      return sy(u);
    };
  }

  /* 当前距离档的米数（0 = 「全部」，不裁） */
  function distLimit() {
    return (DIST_LEVELS.find(([k]) => k === state.dist) || [])[1] || 0;
  }

  /* 距离档现在还该不该生效：视野中心得还在「我」附近。
     一旦把地图拖走（去别的区逛），档位就必须让路 —— 否则拖到哪都是空的：
     实测定位 1km 后拖到 5km 外，圆点 0 个、标签 0 个，面板却还写着 72 家。
     1.15 倍是留一点余量，免得视野边缘刚蹭到就来回切。 */
  function distActive() {
    if (!me) return false;
    const lim = distLimit();
    if (!lim) return false;
    const b = map.getBounds();
    if (!b) return false;
    const sw = b.getSouthWest(), ne = b.getNorthEast();
    const cx = (sw.lng + ne.lng) / 2, cy = (sw.lat + ne.lat) / 2;
    return distM(me.lng, me.lat, cx, cy) <= lim * 1.15;
  }

  (function readURL() {
    const P = new URLSearchParams(location.search);
    if (P.get('d')) state.district = P.get('d');
    if (P.get('k')) state.kind = P.get('k');
    if (P.get('b')) state.brand = P.get('b');
    if (P.get('q')) state.q = P.get('q');
    if (P.get('r')) state.rating = parseFloat(P.get('r')) || 0;
  })();

  function syncURL() {
    const p = new URLSearchParams();
    if (state.district !== '全部') p.set('d', state.district);
    if (state.kind !== '全部') p.set('k', state.kind);
    if (state.brand) p.set('b', state.brand);
    if (state.q) p.set('q', state.q);
    if (state.rating) p.set('r', String(state.rating));
    const s = p.toString();
    try { history.replaceState(null, '', s ? '?' + s : location.pathname); } catch (e) { /* file:// */ }
  }

  /* ══ 加载画面 ══════════════════════════════════
     高德 JS API 的网络链路实测约 1.6s（maps → migrate → init → checkredirect → icons），
     这期间页面是全黑的，用户很容易以为卡死而关掉或反复刷新。
     这里按真实进度分段提示，全部就绪后淡出；另设最短显示时间防止闪烁、超时兜底告知。 */
  const ld = (function () {
    const el = document.getElementById('loader');
    const stage = document.getElementById('ld-stage');
    const t0 = performance.now();
    let dataOk = false, mapOk = false, minOk = false, done = false;

    const set = (t) => { if (!done && stage) stage.textContent = t; };

    function tryHide() {
      if (done || !dataOk || !mapOk || !minOk) return;
      done = true;
      el.classList.add('done');
      setTimeout(() => { el.style.display = 'none'; }, 500);
      console.log(`[珠海咖啡地图] 加载完成 ${Math.round(performance.now() - t0)}ms`);
    }

    setTimeout(() => { minOk = true; tryHide(); }, 420);        // 最短显示，避免快网下闪一下就没了
    // 硬兜底：底图瓦片挂了 complete 可能永远不来，不能把用户锁在全屏遮罩后面。
    // 这里是强制撤除——不管数据就绪没有，遮罩必须先让开。
    setTimeout(() => {
      if (done) return;
      done = true;
      el.classList.add('done');
      setTimeout(() => { el.style.display = 'none'; }, 500);
      setTimeout(() => toast('底图加载较慢 · 数据与排行仍可正常使用'), 700);
    }, 12000);

    return {
      set,
      data() {
        dataOk = true;
        set(`已载入 ${(window.COFFEE_DATA || []).length} 家 · 正在绘制`);
        tryHide();
      },
      map() { mapOk = true; tryHide(); },
    };
  })();

  ld.set('地图引擎就绪 · 正在载入咖啡馆');

  /* ══ 地图 ══════════════════════════════════════ */
  const map = new AMap.Map('map', {
    zoom: 11.3,
    center: [113.37, 22.21],
    viewMode: '2D',
    zooms: [9, 19],
  });
  window.__map = map;
  map.on('complete', () => ld.map());   // 底图首帧渲染完成

  const HOME = { zoom: 11.3, center: [113.37, 22.21] };

  /* ══ Canvas 图层 ═══════════════════════════════ */
  const layer = (function () {
    const cv = document.createElement('canvas');
    cv.className = 'coffee-canvas';
    const ctx = cv.getContext('2d', { alpha: true });

    let W = 0, H = 0, dpr = 1;
    let data = [];
    let hits = [];
    let hoverKey = null;
    let hoverItem = null;
    let raf = 0;

    /* ── 簇的视觉状态（平滑过渡）───────────────────
       分桶本身已经是稳定的（按地理坐标），但店多店少、缩放换格时
       成员数仍会突变。直接按新值画就是「啪」一下换掉，肉眼是闪。
       这里给每个桶存一份视觉状态，每帧向目标缓动：
         a 透明度（新出现的从 0 淡入，消失的淡出后再删）
         r 半径（1 家 ↔ 多家的圆点/圆环之间平滑长大缩小）
         n 成员数（用浮点插值，取整后才显示）

       两件事的驱动方式不同，是刻意的：
         a 透明度 —— 「时长 + 缓动曲线」。它是一段有始有终的动画，
                      用户要能看出"什么时候淡完"，所以给固定时长、到点即止。
         r/n/位置 —— 指数逼近。它们每帧都在改目标（成员数、质心），
                      要的是"跟随"而不是"演完一段"，给固定时长会一顿一顿。
       曲线本身见下面的 fadeTo / fadeStep，取的是 Material 官方令牌。 */
    const anim = new Map();
    let lastT = 0;
    let prevView = null;      // 上一帧视野，用来判断这一帧是不是在拖动/缩放
    let lastViewMoveT = 0;    // 上一次视野变化的时刻，给「刚动过」留个尾巴
    let settleUntil = 0;      // 结构变化后的自续帧截止时间，防止空转
    const ANIM_TAU = 130;     // 半径 / 成员数 / 质心的指数时间常数

    /* ── 透明度：时长 + 贝塞尔，不再用指数逼近 ──────────────────────
       原来 a += (t-a)*(1-e^{-dt/τ})。数学上连续，观感却是"头两帧冲过去，
       剩下大半秒在 0.98 上磨" —— 它永远到不了 1，尾巴又长又看不出变化，
       等于白烧帧，也让"淡出很慢"这个感觉一直存在。
       现在按设计系统里成熟的那套做（Material 3 / Fluent 2 都是这个思路）：
       一个**时长** + 一条 **cubic-bezier**，到点就是终点；中途改目标就从
       当前值重新起跑，且剩余距离越短用时越短。
       曲线取 Material 的官方令牌（m3.material.io/styles/motion/easing-and-duration）：
         进场 cubic-bezier(0.4, 0, 0.2, 1)  标准缓入缓出 —— 两头都软，慢而明显
         退场 cubic-bezier(0.3, 0, 1, 1)    标准加速   —— 起步软、离场干脆
       注意 Material 3 现在主推 spring（motion physics），但它自己写明
       缓动曲线这套仍用于 transitions，所以这里用曲线是稳的选择。 */
    const FADE_IN_MS = 620;
    const FADE_OUT_MS = 170;
    const FADE_OUT_FAST_MS = 110;   // 拖出视口，不许留尾巴
    const LABEL_IN_MS = 380;
    const LABEL_OUT_MS = 120;
    /* 换边：淡出 → 换位 → 淡入。三段都短，因为"字挪了个位置"不该抢注意力。
       Material 把这套叫 fade through，专门用在"元素换位置但没有共享元素过渡"
       的场合 —— 横着滑过去会让标签从圆点上碾过，比硬跳还难看。 */
    const LABEL_FLIP_OUT_MS = 90;
    const LABEL_FLIP_IN_MS = 200;
    const LABEL_MOVE_MS = 200;      // 同侧微调（点半径变了、文字变长了）
    const EASE_IN = bezier(0.4, 0, 0.2, 1);
    const EASE_OUT = bezier(0.3, 0, 1, 1);

    /* 启动一次透明度过渡。st 上挂五个字段：aFrom / aTo / aT0 / aDur / aRun。
       已经在去同一个目标就什么都不做 —— 每帧都会调，不能每次都重置计时。 */
    function fadeTo(st, to, now, dur) {
      if (st.aTo === to) {
        if (st.aRun) return;
        if (st.a === to) return;
      }
      if (!st.aRun && Math.abs(st.a - to) < 0.002) { st.a = to; st.aTo = to; return; }
      /* 用时按「剩余距离」折算，不是死给满时长：
         从 0 淡到 1 走满 620ms；从 0.7 接着淡到 1 只走 186ms；
         从 0.3 退回 0 只走 51ms。否则一个快淡完的点被改目标，
         会突然又慢下来重新演一遍，看着像"卡了一下"。
         下限 40ms（约 2.5 帧），再短就不如直接跳了。 */
      const d = Math.max(40, dur * Math.max(0.2, Math.abs(to - st.a)));
      st.aFrom = st.a;
      st.aTo = to;
      st.aT0 = now;
      st.aDur = d;
      st.aRun = true;
      /* 自己续帧。静止时没有 mapmove，主循环靠 settleUntil 决定要不要再出帧；
         这里不把窗口顶开，过渡就会停在半路（比如一个从 0.7 接着淡入的桶，
         它没走"新建"那条路，没人给它设窗口）。 */
      settleUntil = Math.max(settleUntil, now + d + 200);
    }

    /* 推进一帧，返回当前透明度 */
    function fadeStep(st, now) {
      if (!st.aRun) return st.a;
      const p = (now - st.aT0) / st.aDur;
      if (p >= 1) { st.a = st.aTo; st.aRun = false; return st.a; }
      if (p <= 0) return st.a;
      st.a = st.aFrom + (st.aTo - st.aFrom) * (st.aTo > st.aFrom ? EASE_IN : EASE_OUT)(p);
      return st.a;
    }

    /* 位移也走同一条贝塞尔。标签相对圆点的偏移在「同侧微调」时才用它；
       换边不走位移，走的是淡出→换位→淡入（见 drawLabels）。 */
    function moveStep(st, now) {
      if (!st.mRun) return;
      const p = (now - st.mT0) / st.mDur;
      if (p >= 1) { st.dx = st.tdx; st.dy = st.tdy; st.mRun = false; return; }
      if (p <= 0) return;
      const e = EASE_IN(p);
      st.dx = st.sdx + (st.tdx - st.sdx) * e;
      st.dy = st.sdy + (st.tdy - st.sdy) * e;
    }

    // 上一帧的「店 → 视觉状态」，用来判断一个桶到底是不是「新冒出来的」。
    // 少了它，地图平移时圆点跨过分桶格子边界（键变了、店没变）也会被当成
    // 新点重新淡入一遍 —— 那正是之前满屏闪动的成因，等于把 bug 又引回来。
    let lastState = new Map();
    // 非聚类模式（放得很大）下的单点淡入淡出，按店对象索引
    const singleAnim = new Map();
    // 常驻标签的淡入淡出，按店 id 索引
    const labelAnim = new Map();

    /* ── 常驻标签 ──────────────────────────────────
       定位之后把附近店名直接铺在地图上，不用逐个点开。
       规则：只在单点上挂标签（簇不挂）、按距离由近到远贪心占位、
       与已放置标签冲突就换个方向，四个方向都放不下就跳过。 */
    const LABEL_MIN_Z = 14.0;   // 低于这个缩放只显示圆点
    const LABEL_MAX = 36;       // 单帧最多画多少个标签
    const LABEL_H = 18;
    const LABEL_LIMIT = 152;    // 标签最大宽度（px）
    const FONT_N = '500 11px -apple-system,BlinkMacSystemFont,"PingFang SC","Helvetica Neue",sans-serif';
    const FONT_B = '600 10.5px -apple-system,BlinkMacSystemFont,"PingFang SC","Helvetica Neue",sans-serif';
    let labelOn = false;
    let lastLabels = 0;
    let labelBusy = false;      // 还有标签没淡完，需要续帧
    let dimmed = false;
    const lcache = new Map();
    const EMPTY = [];           // 标签关掉时传空表，让已有标签走淡出而不是硬消失

    function mount() {
      const host = document.querySelector('#map .amap-layers');
      if (!host) return false;
      const anchor = host.querySelector('.amap-markers');
      host.insertBefore(cv, anchor || null);
      resize();
      return true;
    }

    function resize() {
      const el = document.getElementById('map');
      if (!el) return;
      const r = el.getBoundingClientRect();
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      W = Math.round(r.width);
      H = Math.round(r.height);
      cv.width = Math.round(W * dpr);
      cv.height = Math.round(H * dpr);
      cv.style.width = W + 'px';
      cv.style.height = H + 'px';
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      draw();
    }

    function radiusFor(n) {
      return n < 10 ? 15 : n < 50 ? 18 : n < 200 ? 22 : 26;
    }

    // 单点半径随缩放递增：14 级 6.4px → 18 级 10px
    // （重叠由聚类负责，所以这里可以放心随缩放放大）
    function dotRadius(z) {
      const base = Math.min(10, 6.4 + Math.max(0, z - 14) * 0.85);
      return labelOn ? Math.max(5.2, base - 1.5) : base;
    }

    function draw() {
      raf = 0;
      ctx.clearRect(0, 0, W, H);
      hits = [];
      if (!W) return;

      let z, sw, ne;
      try {
        z = map.getZoom();
        const b = map.getBounds();
        sw = b.getSouthWest();
        ne = b.getNorthEast();
      } catch (e) { return; }

      const now = performance.now();
      // 全局淡入已经下放到「每个簇、每个标签各管自己的透明度」，
      // 这里恒为 1（原来是 (now-born)/200，换一次筛选就整层闪暗 200ms）。
      const alpha = 1;
      // 半径/成员数/质心仍按帧间隔做指数逼近，掉帧时不会变慢。
      // 上限 64ms 防止切标签页回来猛跳；"静止很久后重新起帧"单独按一帧算，
      // 否则一帧就把半径/质心顶到位，看着像"啪"一下换掉。
      let dtRaw = lastT ? now - lastT : 16;
      if (dtRaw > 200) dtRaw = 16;
      const dt = Math.min(64, dtRaw);
      lastT = now;
      const ease = 1 - Math.exp(-dt / ANIM_TAU);        // 半径、成员数、质心

      // 底图压暗只在"标签真的画出来"时生效，否则热力图/缩小时会白白变暗
      syncDim(z);

      // 热力图模式或结果为空：不画店点，但定位点要留着
      if (!data.length) {
        // 结果被筛空：圆点没了，标签也得跟着淡出，不能凭空消失
        drawLabels(EMPTY, alpha, now, true);
        ctx.globalAlpha = 1;
        drawMe(z);
        if (labelBusy && now < settleUntil) schedule();
        return;
      }
      if (!labelOn) lastLabels = 0;

      const clusterMode = z < CLUSTER_MAX_ZOOM;
      // 开标签时把格子收窄，让更多店从簇里拆出来，否则一整条街只剩一个簇
      const cell = cellFor(z) * (labelOn ? 0.52 : 1);
      const emph = data.length <= 3;      // 结果极少时高亮每个点
      const buckets = new Map();
      const singles = [];
      const lab = [];                     // 可以挂标签的单点

      // 定位后按距离分档压暗远处，让"附近"浮出来
      const dim = (d) => (me == null ? 1 : 0.55 + 0.45 * Math.max(0, 1 - (d || 0) / 4000));

      /* 距离档只在视野还停在我周边时生效。拖走以后必须让路，
         否则拖到别的区整片空白 —— 数据早被档位裁掉了，画无可画。 */
      let distLim = 0;
      if (me != null) {
        const lim = distLimit();
        if (lim) {
          const vcx = (sw.lng + ne.lng) / 2, vcy = (sw.lat + ne.lat) / 2;
          if (distM(me.lng, me.lat, vcx, vcy) <= lim * 1.15) distLim = lim;
        }
      }

      /* 分桶必须用「地理坐标」，不能用屏幕像素。
         用屏幕网格 ((p.x/cell)|0) 的话，地图一平移 p.x 整体位移，圆点会不停跨过
         格子边界，在「独立点 ↔ 聚类圈」之间来回跳 —— 实测拖动时 80% 的帧聚类
         数量都在变（97~122 之间抖，单帧最多跳 7 个），肉眼就是整屏圆点在闪。
         换成地理网格后，归属只跟缩放级别有关，平移时完全稳定。
         经度按固定纬度换算，珠海跨度不到 1 度，误差可以忽略。 */
      const KX = 111320 * Math.cos(22.27 * Math.PI / 180);   // 米 / 度经度
      const KY = 110540;                                     // 米 / 度纬度
      const spanX = Math.abs(ne.lng - sw.lng) * KX;          // 视口宽度（米）
      const cellM = Math.max(0.5, (cell * spanX) / (W || 1)); // 格子边长（米）

      for (let i = 0; i < data.length; i++) {
        const s = data[i];
        if (s.lng < sw.lng || s.lng > ne.lng || s.lat < sw.lat || s.lat > ne.lat) continue;
        if (distLim && s._d > distLim) continue;   // 距离档生效时裁掉圈外
        let p;
        try {
          p = map.lngLatToContainer([s.lng, s.lat]);
        } catch (e) { continue; }
        if (!p) continue;
        if (!clusterMode) { singles.push({ s, x: p.x, y: p.y }); continue; }

        const k = ((s.lng * KX) / cellM | 0) + '_' + ((s.lat * KY) / cellM | 0);
        let b = buckets.get(k);
        if (!b) { b = { n: 0, x: 0, y: 0, lng: 0, lat: 0, items: [], dmin: Infinity }; buckets.set(k, b); }
        b.n++; b.x += p.x; b.y += p.y; b.lng += s.lng; b.lat += s.lat;
        b.items.push(s);
        if (s._d < b.dmin) b.dmin = s._d;
      }

      ctx.globalAlpha = alpha;

      /* 这一帧视野动过没有（拖动/缩放）。位置缓动只该在视野静止时生效：
         平移时每帧都有店进出视口，桶的质心跟着变，若还缓动，圆点就会拖在
         底图后面 —— 正是最早那个"拖动延时"的毛病。所以视野一动就吸附。
         鼠标事件是一段段来的，两次事件之间那几帧会被判成"没动"，
         所以再留 180ms 尾巴：刚动过也算动，拖动全程都吸附。 */
      const viewMoved = !prevView || prevView.lng !== sw.lng || prevView.lat !== sw.lat ||
        prevView.z !== z;
      prevView = { lng: sw.lng, lat: sw.lat, z };
      if (viewMoved) lastViewMoveT = now;
      const viewBusy = viewMoved || now - lastViewMoveT < 180;

      if (clusterMode) {
        const dr = dotRadius(z);
        const seen = new Set();
        const curState = new Map();     // 本帧重建：店 → 状态

        buckets.forEach((b, k) => {
          seen.add(k);
          const cx = b.x / b.n, cy = b.y / b.n;          // 本帧真实质心（屏幕）
          const tglng = b.lng / b.n, tglat = b.lat / b.n; // 本帧真实质心（地理）
          const tgtR = b.n === 1 ? dr : Math.min(radiusFor(b.n), cell * 0.45);
          let st = anim.get(k);
          if (!st) {
            /* 这个桶没有历史状态。它可能是「真的新冒出来的」，也可能只是
               圆点跨过了分桶格子边界 —— 后者必须当成没变，否则平移时
               每个越界的点都要重新淡入，整屏又在闪。
               判据看「店里有没有上一帧就在的」：取成员里上一帧最亮的那个
               状态的透明度和半径接着往下走，完全没交集才从 0 淡入。
               半径只继承到 tgtR 为上限（Math.min）：几个点并成簇时长上来
               很好看，但反过来簇裂成一堆单点时，若每个点都继承簇的半径，
               会先闪出一片大圆点再缩下去 —— 那个方向只取目标值。 */
            let pv = null;
            for (let i = 0; i < b.items.length; i++) {
              const q = lastState.get(b.items[i]);
              if (q && (!pv || q.a > pv.a)) pv = q;
            }
            st = pv
              ? { a: pv.a, r: Math.min(pv.r, tgtR), n: pv.n, tgtR, tgtN: b.n, glng: tglng, glat: tglat }
              : { a: 0, r: tgtR * 0.55, n: b.n, tgtR, tgtN: b.n, glng: tglng, glat: tglat };
            anim.set(k, st);
            if (!pv) settleUntil = now + FADE_IN_MS + 400;
          }
          fadeTo(st, 1, now, FADE_IN_MS);
          fadeStep(st, now);
          st.r += (tgtR - st.r) * ease;
          st.n += (b.n - st.n) * ease;
          // 单点不插值成员数。簇散成单点时继承来的 n 可能还是 5，
          // 插值会让它先以「圈里写 5」的样子存在半秒，然后再变成圆点。
          if (b.n === 1) st.n = 1;
          st.tgtR = tgtR; st.tgtN = b.n;

          /* 位置也缓动：簇的成员一增一减，质心就会跳一格，硬切看着像"点瞬移"。
             缓动的是「地理质心」而不是屏幕坐标 —— 屏幕坐标缓动会让圆点在平移时
             拖在底图后面；地理质心在平移时不变，投影出来天然贴着地图走。
             但视野本身在动的那几帧必须吸附：那时质心变化是"店进出视口"造成的，
             缓动只会让圆点追不上底图。 */
          let px = cx, py = cy;
          if (viewBusy) {
            st.glng = tglng; st.glat = tglat;
          } else {
            const moved = Math.abs(st.glng - tglng) + Math.abs(st.glat - tglat) > 2e-7;
            st.glng += (tglng - st.glng) * ease;
            st.glat += (tglat - st.glat) * ease;
            if (moved) {
              const q = map.lngLatToContainer([st.glng, st.glat]);
              if (q) { px = q.x; py = q.y; }
            }
          }
          st.tglng = tglng; st.tglat = tglat;

          st.live = true;
          st.cx = px; st.cy = py;
          st.dmin = b.dmin; st.s = b.items[0];
          st.items = b.items;             // 供下一帧判断这个桶有没有"接力者"
          for (let i = 0; i < b.items.length; i++) curState.set(b.items[i], st);

          const shownN = Math.round(st.n);
          ctx.globalAlpha = alpha * st.a * dim(b.dmin);
          if (shownN <= 1) {
            // 单个点也要登记命中，否则这些点永远点不开
            drawDot(px, py, b.items[0], st.r, emph);
            hits.push({ type: 'dot', x: px, y: py, r: st.r + 2.5, s: b.items[0] });
            lab.push({ s: b.items[0], x: px, y: py, r: st.r, a: st.a });
            return;
          }
          const isHover = hoverItem && hoverItem.type === 'cluster' &&
            Math.abs(hoverItem.x - px) < 0.6 && Math.abs(hoverItem.y - py) < 0.6;
          drawCluster(px, py, st.r, shownN, isHover);
          hits.push({
            type: 'cluster', x: px, y: py, r: st.r, n: shownN,
            lng: st.glng, lat: st.glat, items: b.items,
          });
        });

        // 本帧消失的桶。分三种情况，混在一起处理会出两类毛病：
        //   ① 接力（缩放换格、簇拆并）：同一批店换了个画法，不是消失。
        //      这类必须立刻删 —— 留着淡出，缩放动画那 480ms 里每帧都新产生
        //      一批"死桶"，实测切一次 5km 峰值堆到 6232 个（5993 个在淡出），
        //      每个每帧还要重投影一次，画面成片残影、帧率也塌。
        //   ② 真的被筛掉了：慢慢淡出，让"之前的点"看得见是怎么走的。
        //   ③ 平移出视口：快速淡出，慢淡出会拖一条跟着地图滑的尾巴。
        anim.forEach((st, k) => {
          if (seen.has(k)) return;
          st.live = false;

          const its = st.items;
          if (its) {
            for (let i = 0; i < its.length; i++) {
              if (curState.has(its[i])) { anim.delete(k); return; }
            }
          }

          const inside = st.glng >= sw.lng && st.glng <= ne.lng &&
                         st.glat >= sw.lat && st.glat <= ne.lat;
          const outMs = inside ? FADE_OUT_MS : FADE_OUT_FAST_MS;
          fadeTo(st, 0, now, outMs);
          fadeStep(st, now);
          if (!st.aRun) { anim.delete(k); return; }   // 已经淡到 0，收摊
          settleUntil = Math.max(settleUntil, now + outMs + 200);
          let q = null;
          try { q = map.lngLatToContainer([st.glng, st.glat]); } catch (e) { anim.delete(k); return; }
          if (!q) { anim.delete(k); return; }
          const shownN = Math.max(1, Math.round(st.n));
          ctx.globalAlpha = alpha * st.a * dim(st.dmin);
          if (shownN <= 1) drawDot(q.x, q.y, st.s, st.r, false);
          else drawCluster(q.x, q.y, st.r, shownN, false);
        });

        // 供下一帧判断「这家店上一帧在哪、亮到多少」
        lastState = curState;

        // 静止时不再有 mapmove，过渡没收敛就得自己续帧，
        // 否则新出现的簇会永远停在半透明、改过成员的簇停在旧半径。
        // 透明度看 aRun（有没有在跑一段过渡），不再用 a<0.985 这种阈值猜 ——
        // 定时长的过渡到点就是 1，猜阈值只会白烧几十帧。
        let busy = false;
        anim.forEach((st) => {
          if (st.aRun) busy = true;
          else if (Math.abs(st.r - st.tgtR) > 0.12) busy = true;
          else if (Math.abs(st.n - st.tgtN) > 0.06) busy = true;
          // 质心还在滑（成员刚变过），也得继续出帧，否则会停在半路
          else if (st.live && Math.abs(st.glng - st.tglng) + Math.abs(st.glat - st.tglat) > 2e-7) busy = true;
        });
        if (busy && now < settleUntil) schedule();
      } else {
        /* 放到街区级（z ≥ CLUSTER_MAX_ZOOM）就不分桶了，但淡入淡出不能跟着消失 ——
           这一档恰好是标签全开、看得最仔细的时候，点突然冒出来/消失最扎眼。
           这里按店对象存一份状态，规则和上面完全一致：新点淡入、被筛掉的慢淡出、
           划出视口的快淡出；进出这一档时用 lastState 接力，不重新淡一遍。 */
        anim.clear();
        const dr = dotRadius(z);
        const seenS = new Set();
        const curSingle = new Map();

        for (let i = 0; i < singles.length; i++) {
          const it = singles[i];
          const s = it.s;
          seenS.add(s);
          let st = singleAnim.get(s);
          if (!st) {
            const pv = lastState.get(s);
            st = pv
              ? { a: pv.a, r: Math.min(pv.r, dr), x: it.x, y: it.y }
              : { a: 0, r: dr * 0.55, x: it.x, y: it.y };
            singleAnim.set(s, st);
            if (!pv) settleUntil = now + FADE_IN_MS + 400;
          }
          fadeTo(st, 1, now, FADE_IN_MS);
          fadeStep(st, now);
          st.r += (dr - st.r) * ease;
          st.x = it.x; st.y = it.y; st.live = true;
          curSingle.set(s, st);
          ctx.globalAlpha = alpha * st.a * dim(s._d);
          drawDot(it.x, it.y, s, st.r, emph);
          hits.push({ type: 'dot', x: it.x, y: it.y, r: st.r + 2.5, s });
          lab.push({ s, x: it.x, y: it.y, r: st.r, a: st.a });
        }

        singleAnim.forEach((st, s) => {
          if (seenS.has(s)) return;
          st.live = false;
          const inside = s.lng >= sw.lng && s.lng <= ne.lng &&
                         s.lat >= sw.lat && s.lat <= ne.lat;
          const outMs = inside ? FADE_OUT_MS : FADE_OUT_FAST_MS;
          fadeTo(st, 0, now, outMs);
          fadeStep(st, now);
          if (!st.aRun) { singleAnim.delete(s); return; }
          settleUntil = Math.max(settleUntil, now + outMs + 200);
          ctx.globalAlpha = alpha * st.a * dim(s._d);
          drawDot(st.x, st.y, s, st.r, false);
        });

        lastState = curSingle;

        let busyS = false;
        singleAnim.forEach((st) => {
          if (st.aRun || Math.abs(st.r - dr) > 0.12) busyS = true;
        });
        if (busyS && now < settleUntil) schedule();
      }

      ctx.globalAlpha = 1;
      drawMeRing(z);
      // 标签压在圆点之上；蓝点（我自己）最后画，保证永远可见。
      // 标签关掉/缩得太小时也走一遍，让已经画出来的标签淡出而不是凭空消失。
      if (labelOn && z >= LABEL_MIN_Z && lab.length) {
        drawLabels(lab, alpha, now, viewBusy);
      } else {
        drawLabels(EMPTY, alpha, now, true);
      }
      drawMeCore(z);
      if (labelBusy && now < settleUntil) schedule();
    }

    /* 标签文字组成：店名 + 距离 + 评分，超宽就截店名 */
    function buildLabel(s) {
      const badges = [];
      if (s._d != null) badges.push({ t: fmtDist(s._d), c: PAL.distBadge });
      if (s.rating >= 4.0) badges.push({ t: '★' + s.rating.toFixed(1), c: PAL.ratingBadge });

      let bw = 0;
      ctx.font = FONT_B;
      for (let i = 0; i < badges.length; i++) {
        badges[i].w = ctx.measureText(badges[i].t).width;
        bw += badges[i].w + 5;
      }

      const PAD = 7;
      let name = s.name;
      ctx.font = FONT_N;
      let nw = ctx.measureText(name).width;
      if (nw + bw + PAD * 2 > LABEL_LIMIT) {
        const room = Math.max(32, LABEL_LIMIT - bw - PAD * 2);
        while (name.length > 2 && nw > room) {
          name = name.slice(0, -1);
          nw = ctx.measureText(name + '…').width;
        }
        name += '…';
        nw = ctx.measureText(name).width;
      }
      return { name, nw, badges, w: Math.round(nw + bw + PAD * 2) };
    }

    function labelOf(s) {
      const k = s.id + '|' + (s._d == null ? '' : Math.round(s._d / 25));
      let v = lcache.get(k);
      if (!v) {
        if (lcache.size > 1400) lcache.clear();
        v = buildLabel(s);
        lcache.set(k, v);
      }
      return v;
    }

    function fits(b, placed) {
      if (b.x < 3 || b.y < 3 || b.x + b.w > W - 3 || b.y + b.h > H - 3) return false;
      for (let i = 0; i < placed.length; i++) {
        const p = placed[i];
        if (b.x < p.x + p.w + 4 && b.x + b.w + 4 > p.x &&
            b.y < p.y + p.h + 3 && b.y + b.h + 3 > p.y) return false;
      }
      return true;
    }

    /* 标签也要淡入淡出。
       之前是每帧重排完直接画：位置一变、或者被更近的店挤掉，就是「啪」
       一下没了，跟圆点的柔和过渡完全不搭。这里给每个标签存一份透明度：
       放得下就向 1 过渡，放不下就向 0 过渡，淡到 0 才删。
       标签的进场比圆点短（380ms vs 620ms）：文字一旦可读就该立刻清晰，
       跟着圆点一起慢慢浮出来反而像没渲染完。
       掉队的标签不是钉在原地，而是继续贴着自己的圆点飘 —— 否则地图一拖，
       残影似的几行字会留在半空。 */
    function drawLabels(list, alpha, now, viewBusy) {
      // 近的优先占位；没有定位就按评分和图片数排
      list.sort((a, b) => {
        if (me) {
          const da = a.s._d == null ? 1e9 : a.s._d;
          const db = b.s._d == null ? 1e9 : b.s._d;
          if (da !== db) return da - db;
        }
        return (b.s.rating || 0) - (a.s.rating || 0) || (b.s.photos || 0) - (a.s.photos || 0);
      });

      const placed = [];
      const seenL = new Set();
      let n = 0;

      for (let i = 0; i < list.length; i++) {
        if (n >= LABEL_MAX) break;
        const it = list[i];
        const L = labelOf(it.s);
        const h = LABEL_H;
        // 右 → 左 → 上 → 下，取第一个放得下的位置
        const cands = [
          [it.x + it.r + 6, it.y - h / 2],
          [it.x - it.r - 6 - L.w, it.y - h / 2],
          [it.x - L.w / 2, it.y - it.r - 6 - h],
          [it.x - L.w / 2, it.y + it.r + 6],
        ];
        let box = null, side = 0;
        for (let c = 0; c < cands.length; c++) {
          const b = { x: cands[c][0], y: cands[c][1], w: L.w, h };
          if (fits(b, placed)) { box = b; side = c; break; }
        }
        if (!box) continue;
        n++;

        const id = it.s.id;
        seenL.add(id);
        const tdx = box.x - it.x, tdy = box.y - it.y;   // 相对圆点的偏移
        let st = labelAnim.get(id);
        if (!st) {
          // 新标签：位置直接落在目标处（不要从圆点里滑出来），透明度从 0 起
          st = {
            a: 0, dx: tdx, dy: tdy, tdx, tdy, sdx: tdx, sdy: tdy,
            mT0: 0, mDur: 1, mRun: false, flip: 0, side, box, L, s: it.s,
          };
          labelAnim.set(id, st);
        }
        /* 位置也要过渡，但**不能横着滑过去**：
           换边（右→左→上→下）时如果让偏移从 +30 线性插到 -120，
           标签会从圆点上碾过去，比硬跳还难看。走 Material 的
           「淡出 → 换位 → 淡入」：先在原位淡到 0，看不见了再挪，然后淡回来。
           视野正在动的时候例外 —— 拖一下地图会有一排标签同时换边，
           集体闪一遍比硬跳更糟，所以那时吸附、不做换边动画。 */
        if (viewBusy) {
          st.dx = tdx; st.dy = tdy; st.tdx = tdx; st.tdy = tdy;
          st.side = side; st.flip = 0; st.mRun = false;
        } else if (st.side !== side) {
          /* 连换两次边（200ms 内又换回去）时，flip 可能正停在 2（正在淡入）。
             这时不能只更新目标位置 —— 等淡入走完 flip 归 0，就会从旧位置
             一路滑到新位置，正是要避免的那种「从圆点上碾过去」。
             所以只要不是正在淡出（flip !== 1），就重新起一次淡出。 */
          if (st.flip !== 1) {
            st.flip = 1;
            fadeTo(st, 0, now, LABEL_FLIP_OUT_MS);
          }
          st.side = side;
          st.flipDx = tdx; st.flipDy = tdy;
          st.mRun = false;
        } else if (st.flip === 0) {
          // 同侧微调（点半径随缩放变、标签文字变长）：贝塞尔位移，不闪
          if (!st.mRun || Math.abs(tdx - st.tdx) + Math.abs(tdy - st.tdy) > 0.5) {
            st.sdx = st.dx; st.sdy = st.dy;
            st.tdx = tdx; st.tdy = tdy;
            st.mT0 = now;
            st.mDur = Math.max(80, Math.min(LABEL_MOVE_MS,
              LABEL_MOVE_MS * Math.hypot(tdx - st.dx, tdy - st.dy) / 90));
            st.mRun = true;
          }
        }
        /* 换边的第二、三拍：淡到 0 → 挪到新位 → 淡回 1。
           这一步必须放在这里而不是上面的分支里 —— 上一帧的 fadeStep
           可能刚把 a 走到 0，得下一帧才能读到。 */
        if (st.flip === 1) {
          if (!st.aRun && st.a <= 0.001) {
            st.dx = st.flipDx; st.dy = st.flipDy;
            st.tdx = st.flipDx; st.tdy = st.flipDy;
            st.flip = 2;
            fadeTo(st, 1, now, LABEL_FLIP_IN_MS);
          }
        } else if (st.flip === 2) {
          if (!st.aRun) st.flip = 0;          // 淡回来了，回到常规态
        } else {
          fadeTo(st, 1, now, LABEL_IN_MS);
        }
        fadeStep(st, now);
        if (st.mRun) moveStep(st, now);
        st.box = box; st.L = L; st.s = it.s;
        st.live = true;

        const cur = { x: it.x + st.dx, y: it.y + st.dy, w: box.w, h: box.h };
        // 占位用「目标框」而不是当前滑到的位置：否则滑动途中会盖住别人的目标位，
        // 下一帧别人被判为放不下→淡出→再淡入，来回抖。占位稳定优先。
        placed.push(box);
        ctx.globalAlpha = alpha * st.a;
        drawPill(cur, L, it.s);
        // 标签本身也能点开
        hits.push({ type: 'dot', s: it.s, box: cur });
      }

      // 掉队的标签：淡出。位置用圆点的当前投影 + 上次的相对偏移重算，
      // 这样地图平移时它跟着点走，不会留在原地变成"浮空的字"。
      labelAnim.forEach((st, id) => {
        if (seenL.has(id)) return;
        st.live = false;
        fadeTo(st, 0, now, LABEL_OUT_MS);
        fadeStep(st, now);
        if (!st.aRun) { labelAnim.delete(id); return; }
        let q = null;
        try { q = map.lngLatToContainer([st.s.lng, st.s.lat]); } catch (e) { labelAnim.delete(id); return; }
        if (!q) { labelAnim.delete(id); return; }
        const box = { x: q.x + st.dx, y: q.y + st.dy, w: st.box.w, h: st.box.h };
        // 这一格已经被本帧的新标签占了就不画，否则两行字叠在一起更难认
        if (!fits(box, placed)) return;
        settleUntil = Math.max(settleUntil, now + LABEL_OUT_MS + 200);
        ctx.globalAlpha = alpha * st.a;
        drawPill(box, st.L, st.s);
      });

      lastLabels = n;
      ctx.globalAlpha = 1;

      // 标签过渡也得自己续帧：静止时没有 mapmove，否则字会停在半透明
      // 或者停在换边换到一半的位置
      let lb = false;
      labelAnim.forEach((st) => {
        if (st.aRun) lb = true;
        else if (st.live && Math.abs(st.dx - st.tdx) + Math.abs(st.dy - st.tdy) > 0.15) lb = true;
      });
      labelBusy = lb;
      if (lb) settleUntil = Math.max(settleUntil, now + 600);
    }

    function drawPill(b, L, s) {
      const hl = hoverItem && hoverItem.type === 'dot' && hoverItem.s === s;
      const rad = b.h / 2;

      ctx.beginPath();
      ctx.moveTo(b.x + rad, b.y);
      ctx.arcTo(b.x + b.w, b.y, b.x + b.w, b.y + b.h, rad);
      ctx.arcTo(b.x + b.w, b.y + b.h, b.x, b.y + b.h, rad);
      ctx.arcTo(b.x, b.y + b.h, b.x, b.y, rad);
      ctx.arcTo(b.x, b.y, b.x + b.w, b.y, rad);
      ctx.closePath();
      // 液态玻璃版给胶囊加一层柔影，白底才从亮色地图上分出来
      if (PAL.pillShadow) {
        ctx.save();
        ctx.shadowColor = PAL.pillShadow;
        ctx.shadowBlur = 14;
        ctx.shadowOffsetY = 4;
      }
      ctx.fillStyle = hl ? PAL.pillBgHl : PAL.pillBg;
      ctx.fill();
      if (PAL.pillShadow) ctx.restore();
      ctx.lineWidth = 1;
      ctx.strokeStyle = hl ? PAL.pillEdgeHl : PAL.pillEdge;
      ctx.stroke();

      const cy = b.y + b.h / 2 + 0.5;
      let tx = b.x + 7;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.font = FONT_N;
      ctx.fillStyle = hl ? PAL.pillTextHl : PAL.pillText;
      ctx.fillText(L.name, tx, cy);
      tx += L.nw;
      ctx.font = FONT_B;
      for (let i = 0; i < L.badges.length; i++) {
        const bd = L.badges[i];
        tx += 5;
        ctx.fillStyle = bd.c;
        ctx.fillText(bd.t, tx, cy);
        tx += bd.w;
      }
    }

    /* 当前位置：蓝点 + 光晕 + 精度圈（不登记命中，点它不会弹卡片）
       拆成两段：精度圈垫在标签下面，蓝点压在最上面 */
    function meAt(z) {
      if (!me) return null;
      let p;
      try { p = map.lngLatToContainer([me.lng, me.lat]); } catch (e) { return null; }
      if (!p) return null;
      const mpp = 156543.03392 * Math.cos(me.lat * Math.PI / 180) / Math.pow(2, z);
      const ar = Math.min(Math.max((me.acc || 50) / mpp, 12), Math.min(W, H) * 0.45);
      return { p, ar };
    }

    function drawMeRing(z) {
      const m = meAt(z);
      if (!m) return;
      const { p, ar } = m;
      ctx.beginPath();
      ctx.arc(p.x, p.y, ar, 0, Math.PI * 2);
      ctx.fillStyle = PAL.meFill;
      ctx.fill();
      ctx.lineWidth = 1;
      ctx.strokeStyle = PAL.meEdge;
      ctx.stroke();
    }

    function drawMeCore(z) {
      const m = meAt(z);
      if (!m) return;
      const p = m.p;
      ctx.globalAlpha = 1;

      ctx.beginPath();
      ctx.arc(p.x, p.y, 17, 0, Math.PI * 2);
      ctx.fillStyle = PAL.meGlow;
      ctx.fill();

      ctx.beginPath();
      ctx.arc(p.x, p.y, 7, 0, Math.PI * 2);
      ctx.fillStyle = PAL.me;
      ctx.fill();
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = PAL.meDotEdge;
      ctx.stroke();
    }

    function drawMe(z) { drawMeRing(z); drawMeCore(z); }

    function drawCluster(x, y, r, n, isHover) {
      if (isHover) {
        ctx.beginPath();
        ctx.arc(x, y, r + 5, 0, Math.PI * 2);
        ctx.fillStyle = PAL.clusterGlow;
        ctx.fill();
      }
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = isHover ? PAL.clusterHover : PAL.cluster;
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = PAL.clusterEdge;
      ctx.stroke();

      ctx.fillStyle = PAL.clusterText;
      ctx.font = '600 ' + (n > 999 ? 10 : n > 99 ? 11 : 12) + 'px -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(n > 999 ? '999+' : String(n), x, y + 0.5);
    }

    function drawDot(x, y, s, base, emph) {
      const color = s.brand ? PAL.chain : PAL.indie;
      const isHover = hoverItem && hoverItem.type === 'dot' && hoverItem.s === s;
      const r = isHover ? base + 2.2 : base;

      // 结果极少时加定位环，避免"筛出 1 家却找不到点"
      if (emph) {
        ctx.beginPath();
        ctx.arc(x, y, r + 9, 0, Math.PI * 2);
        ctx.fillStyle = PAL.emphFill;
        ctx.fill();
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = PAL.emphEdge;
        ctx.stroke();
      }

      // 收藏：粉色光晕
      if (saved.has(s.id)) {
        ctx.beginPath();
        ctx.arc(x, y, r + 5, 0, Math.PI * 2);
        ctx.fillStyle = PAL.savedGlow;
        ctx.fill();
      }
      // 悬停：同色系深色光晕
      if (isHover) {
        ctx.beginPath();
        ctx.arc(x, y, r + 4.5, 0, Math.PI * 2);
        ctx.fillStyle = PAL.hoverGlow;
        ctx.fill();
      }

      // 主体
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = PAL.dotEdge;
      ctx.stroke();

      // 外圈柔环，提升亮底上的层次
      ctx.beginPath();
      ctx.arc(x, y, r + 1.6, 0, Math.PI * 2);
      ctx.lineWidth = 1;
      ctx.strokeStyle = PAL.dotRing;
      ctx.stroke();
    }

    function syncDim(z) {
      if (z == null) { try { z = map.getZoom(); } catch (e) { return; } }
      const want = labelOn && data.length > 0 && z >= LABEL_MIN_Z;
      if (want === dimmed) return;
      dimmed = want;
      document.getElementById('map').classList.toggle('labels', want);
    }

    function schedule() {
      if (raf) return;
      raf = requestAnimationFrame(draw);
    }

    function hitTest(x, y) {
      // 标签矩形优先：面积大、指向明确，压住了别的圆点也算它的
      for (let i = 0; i < hits.length; i++) {
        const b = hits[i].box;
        if (b && x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) return hits[i];
      }
      let best = null, bd = Infinity;
      for (let i = 0; i < hits.length; i++) {
        const it = hits[i];
        if (it.box) continue;
        const dx = it.x - x, dy = it.y - y;
        const rr = it.r + 5;
        const d = dx * dx + dy * dy;
        if (d < rr * rr && d < bd) { bd = d; best = it; }
      }
      return best;
    }

    return {
      mount, resize, schedule, draw, hitTest,
      // 不再重置 born：那会让整层（圆点 + 标签）每次换筛选都从 0 亮起来，
      // 叠在逐簇淡入上就是一次 200ms 的全局闪暗。现在每个簇、每个标签各自淡入，
      // 谁新谁旧分得清，不需要再来一层全局遮罩。
      setData(list) { data = list; schedule(); },
      setLabels(v) { labelOn = !!v; schedule(); },
      getLabels() { return labelOn; },
      getLabelCount() { return lastLabels; },
      setHover(it) {
        const key = it ? (it.type === 'dot' ? it.s.id : 'c' + it.x + it.y) : null;
        if (key === hoverKey) return;
        hoverKey = key;
        hoverItem = it;
        schedule();
      },
      clearHover() { this.setHover(null); },

      // 调试用：导出簇的瞬时视觉状态。自动化测试靠它判断「淡入到底有没有在渐」，
      // 从画布上量 alpha 会被基础淡入、距离衰减、主题调色板一起干扰，量不准。
      debug() {
        const out = [];
        anim.forEach((st, k) => out.push({
          k, a: st.a, r: st.r, n: st.n, tgtR: st.tgtR, tgtN: st.tgtN,
          live: st.live, run: !!st.aRun, x: st.cx, y: st.cy,
          gx: st.glng, gy: st.glat, tgx: st.tglng, tgy: st.tglat,
        }));
        return out;
      },

      // 调试用：标签的透明度与位置偏移状态。live=false 是正在淡出的掉队标签。
      // side / flip 是换边状态机：flip 0=常规 1=正在淡出 2=正在淡入。
      debugLabels() {
        const out = [];
        labelAnim.forEach((st, id) => out.push({
          id, a: st.a, live: st.live, run: !!st.aRun, mRun: !!st.mRun,
          dx: st.dx, dy: st.dy, tdx: st.tdx, tdy: st.tdy,
          side: st.side, flip: st.flip,
        }));
        return out;
      },
    };
  })();

  window.__layer = layer;   // 调试用

  /* 主题落地：底图样式 + 玻璃令牌 + 画布调色板 三处一起换 */
  let styleApplied = false;      // 亮色就是默认样式，首屏不必再 setMapStyle 一次（会闪）
  let styleTries = 0;

  // 冷启动进暗色时地图还没 ready，这时候 setMapStyle 会被静默丢掉
  // （实测：面板已经变暗、底图还是亮的）。所以除了当场调一次，
  // 还要挂到 complete 上补。最多补 3 次 —— setMapStyle 自己也可能再触发
  // complete，不封顶会死循环。
  function pushDarkStyle() {
    if (theme !== 'dark' || styleTries >= 3) return;
    styleTries++;
    try { map.setMapStyle(THEME_CFG.dark.mapStyle); styleApplied = true; } catch (e) {}
  }

  function applyTheme(name, save) {
    theme = name === 'dark' ? 'dark' : 'light';
    const cfg = THEME_CFG[theme];
    document.documentElement.setAttribute('data-theme', theme);
    PAL = theme === 'dark' ? PAL_DARK : PAL_LIGHT;

    if (theme === 'dark') {
      styleTries = 0;
      pushDarkStyle();
    } else if (styleApplied) {
      try { map.setMapStyle(THEME_CFG.light.mapStyle); styleApplied = false; } catch (e) {}
    }
    if (window.LiquidGlass) {
      try {
        LiquidGlass.set({
          tintHue: cfg.hue, tintOpacity: cfg.tintA,
          specular: cfg.spec, saturation: cfg.sat, blur: cfg.blur,
        });
      } catch (e) {}
    }

    const b = document.getElementById('theme-btn');
    if (b) {
      b.textContent = theme === 'dark' ? '☀' : '☾';
      b.title = theme === 'dark' ? '切到浅色' : '切到深色';
      b.setAttribute('aria-label', b.title);
    }
    if (save) { try { localStorage.setItem(THEME_KEY, theme); } catch (e) {} }
    layer.schedule();
  }

  map.on('complete', pushDarkStyle);
  applyTheme(theme, false);
  const themeBtn = document.getElementById('theme-btn');
  if (themeBtn) themeBtn.onclick = () => applyTheme(theme === 'dark' ? 'light' : 'dark', true);

  let mounted = false;
  function tryMount() { if (!mounted) mounted = layer.mount(); }

  /* ══ 区界 ══════════════════════════════════════ */
  const districtPolys = [];
  (function drawDistricts() {
    DISTRICTS.features.forEach((f) => {
      const g = f.geometry;
      const polys = g.type === 'MultiPolygon' ? g.coordinates : [g.coordinates];
      polys.forEach((poly) => {
        const path = poly[0].map((c) => [c[0], c[1]]);
        const p = new AMap.Polygon({
          path,
          strokeColor: PAL.bound,
          strokeWeight: 1.2,
          strokeOpacity: 0.5,
          strokeStyle: 'dashed',
          fillColor: PAL.bound,
          fillOpacity: 0.012,
          bubble: true,
          cursor: 'default',
        });
        p.setMap(map);
        districtPolys.push(p);
      });

      if (f.properties.center) {
        const el = document.createElement('div');
        el.className = 'dlabel';
        el.textContent = f.properties.name;
        el.style.cssText =
          'font-size:11px;letter-spacing:.22em;color:' + PAL.boundLabel + ';' +
          'text-shadow:' + PAL.boundLabelShadow + ';pointer-events:none;font-weight:500';
        new AMap.Marker({
          position: f.properties.center, content: el,
          offset: new AMap.Pixel(-18, -8), map, zIndex: 60,
        });
      }
    });
  })();

  /* ══ 信息卡 ════════════════════════════════════ */
  let infoWin = null;
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /* 是否在营业中（跨夜班次单独判断） */
  function isOpen(s) {
    if (s.open == null || s.close == null) return null;
    if (s.open === 0 && s.close === 1440) return true;
    const d = new Date();
    const m = d.getHours() * 60 + d.getMinutes();
    return s.close > s.open ? m >= s.open && m < s.close : m >= s.open || m < s.close;
  }

  function cardHTML(s) {
    const isSaved = saved.has(s.id);
    const meta = [];
    if (s.rating) meta.push(`<span class="rt">★ ${s.rating.toFixed(1)}</span>`);
    if (s.cost) meta.push(`<span>人均 ¥${Math.round(s.cost)}</span>`);
    if (s.area && s.area !== '其他') meta.push(`<span>${esc(s.area)}</span>`);
    if (s.district) meta.push(`<span>${esc(s.district)}</span>`);

    const tags = [s.brand
      ? `<span class="tag br">${esc(s.brand)}</span>`
      : '<span class="tag br">独立小店</span>'];
    (s.tags || []).forEach((t) => tags.push(`<span class="tag">${esc(t)}</span>`));

    const op = isOpen(s);
    const hrs = s.hours
      ? `<div class="hrs">${esc(s.hours)}` +
        (op == null ? '' : `<b class="${op ? 'op' : 'cl'}">${op ? '营业中' : '已打烊'}</b>`) +
        '</div>'
      : '';

    const navi = `https://uri.amap.com/marker?position=${s.lng},${s.lat}` +
      `&name=${encodeURIComponent(s.name)}&src=zhuhai-coffee-map&coordinate=gaode&callnative=1`;

    return `<div class="card lg-glass" data-glass>
      <div class="top">
        <h3>${esc(s.name)}</h3>
        <button class="star ${isSaved ? 'on' : ''}" data-id="${esc(s.id)}"
          title="${isSaved ? '取消收藏' : '收藏'}">${isSaved ? '★' : '☆'}</button>
      </div>
      ${s._d != null ? `<div class="dist">距我 ${fmtDist(s._d)}</div>` : ''}
      ${meta.length ? `<div class="meta">${meta.join('<i></i>')}</div>` : ''}
      <div class="addr">${esc(s.address || '暂无地址信息')}</div>
      ${hrs}
      <div class="tags">${tags.join('')}</div>
      <div class="acts">
        <a class="pri" href="${navi}" target="_blank" rel="noopener">导航</a>
        <button data-copy="${esc(s.name)} ${s.lng},${s.lat}">复制坐标</button>
      </div>
    </div>`;
  }

  function openCard(s) {
    if (!infoWin) {
      infoWin = new AMap.InfoWindow({ isCustom: true, offset: new AMap.Pixel(0, -12), autoMove: true });
    }
    infoWin.setContent(cardHTML(s));
    infoWin.open(map, [s.lng, s.lat]);
    if (typeof showTip === 'function') showTip(null);

    setTimeout(() => {
      const root = document.querySelector('.amap-info-contentContainer');
      if (!root) return;
      // 信息卡是动态插入的，LiquidLens 的 MutationObserver 抓不到它
      // （实测 lgId 始终为空，backdrop-filter 停在纯模糊），这里显式补一次折射。
      // 卡高矮随店家标签数变化，每次开卡都要重新生成位移贴图，所以不能缓存。
      const cardEl = root.querySelector('.card');
      if (cardEl && window.LiquidGlass) {
        try { LiquidGlass.apply(cardEl); } catch (e) { /* 引擎缺席就退回 CSS 模糊 */ }
      }
      const star = root.querySelector('.star');
      if (star) {
        star.onclick = () => {
          const id = star.dataset.id;
          if (saved.has(id)) saved.delete(id); else saved.add(id);
          localStorage.setItem(SAVED_KEY, JSON.stringify([...saved]));
          refreshChrome();
          star.classList.toggle('on', saved.has(id));
          star.textContent = saved.has(id) ? '★' : '☆';
        };
      }
      const cp = root.querySelector('[data-copy]');
      if (cp) {
        cp.onclick = () => {
          navigator.clipboard?.writeText(cp.dataset.copy);
          cp.textContent = '已复制';
          setTimeout(() => (cp.textContent = '复制坐标'), 1200);
        };
      }
    }, 20);
  }

  function closeCard() { if (infoWin) infoWin.close(); }

  /* ══ 悬停浮层 ══════════════════════════════════ */
  const tip = document.createElement('div');
  // 只加 lg-glass 不加 data-glass：悬停浮层随指针高频移动，
  // 每次重算位移贴图不划算，用纯 CSS 的描边+高光就够"玻璃"了
  tip.className = 'tip lg-glass';
  document.getElementById('map').appendChild(tip);

  function showTip(it, px, py) {
    if (!it) { tip.classList.remove('on'); return; }
    if (it.type === 'dot') {
      const s = it.s;
      const l2 = [];
      if (s.rating) l2.push(`★ ${s.rating.toFixed(1)}`);
      if (s.cost) l2.push(`¥${Math.round(s.cost)}`);
      if (s.hours) l2.push(s.hours);
      // 早咖/夜咖 是时间推断的，浮层里没必要重复展示，优先放店名推断的业态
      const tg = (s.tags || []).filter((t) => t !== '早咖' && t !== '夜咖').slice(0, 3);
      tip.innerHTML = `<b>${esc(s.name)}</b>` +
        (s._d != null ? `<span class="dt">${fmtDist(s._d)}</span>` : '') +
        (l2.length ? `<span class="l2">${l2.join(' · ')}</span>` : '') +
        (tg.length ? `<span class="l3">${tg.map(esc).join(' / ')}</span>` : '');
    } else {
      const d = it.items && it.items[0] && it.items[0]._d != null
        ? ` · 最近 ${fmtDist(Math.min(...it.items.map((x) => (x._d == null ? Infinity : x._d))))}`
        : '';
      tip.innerHTML = `<b>${it.n} 家咖啡馆</b><span>点击放大${d}</span>`;
    }
    tip.style.left = px + 'px';
    tip.style.top = py + 'px';
    tip.classList.add('on');
  }

  /* ══ 交互（canvas 命中测试） ════════════════════ */
  function overCard(px, py) {
    const c = document.querySelector('.amap-info-contentContainer .card');
    if (!c) return false;
    const r = c.getBoundingClientRect();
    const m = document.getElementById('map').getBoundingClientRect();
    const x = px + m.left, y = py + m.top;
    return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  }

  map.on('mousemove', (e) => {
    if (!e.pixel) return;
    if (overCard(e.pixel.x, e.pixel.y)) {
      layer.clearHover();
      showTip(null);
      document.getElementById('map').style.cursor = '';
      return;
    }
    const it = layer.hitTest(e.pixel.x, e.pixel.y);
    layer.setHover(it);
    showTip(it, e.pixel.x, e.pixel.y);
    highlightRank(it && it.type === 'dot' ? it.s : null);
    document.getElementById('map').style.cursor = it ? 'pointer' : '';
  });

  map.on('mouseout', () => { layer.clearHover(); showTip(null); });

  map.on('click', (e) => {
    if (!e.pixel) return;
    const it = layer.hitTest(e.pixel.x, e.pixel.y);
    if (!it) { closeCard(); return; }
    if (it.type === 'cluster') {
      const z = map.getZoom();
      const target = Math.min(z + 2.2, 18);
      if (target - z < 0.3) {
        // 已经放到最大，展开这一簇里评分最高的一家
        it.items.sort((a, b) => (b.rating || 0) - (a.rating || 0));
        openCard(it.items[0]);
      } else {
        map.setZoomAndCenter(target, [it.lng, it.lat]);
      }
    } else {
      openCard(it.s);
    }
  });

  // AMap 在缩放动画结束时不一定再触发 zoom，必须同时监听 zoomend / moveend，
  // 否则画布会停在动画中途的那一帧（表现就是「放大后标记消失」）。
  //
  // mapmove 是关键：高德 2.0 拖拽期间只发 mapmove，不发 move（实测拖拽 1.2s，
  // mapmove 触发 73 次 ≈ 每帧一次，move 触发 0 次）。少了它，圆点会冻在原地
  // 等松手才跳过去 —— 表现就是「拖地图时点延时跟上」。
  ['mapmove', 'move', 'zoom', 'zoomchange', 'zoomend', 'moveend', 'resize', 'complete']
    .forEach((ev) => map.on(ev, () => layer.schedule()));

  // 缩得太小时标签画不出来，按钮给个"已开但未生效"的提示态
  const syncLabelBtn = () => {
    const on = layer.getLabels();
    $('#btn-label').classList.toggle('active', on);
    $('#btn-label').classList.toggle('sub', on && map.getZoom() < 14.0);
  };
  ['zoomend', 'moveend'].forEach((ev) => map.on(ev, syncLabelBtn));

  let rt = null;
  window.addEventListener('resize', () => {
    clearTimeout(rt);
    rt = setTimeout(() => layer.resize(), 120);
  });

  /* ══ 筛选 ══════════════════════════════════════ */
  const countBy = (arr, fn) => {
    const m = new Map();
    arr.forEach((x) => { const k = fn(x); if (k) m.set(k, (m.get(k) || 0) + 1); });
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  };

  function renderChips(sel, items, group) {
    const host = $(sel);
    host.innerHTML = '';
    items.forEach(([label, n]) => {
      const b = document.createElement('button');
      b.className = 'chip';
      b.dataset.v = label;
      b.innerHTML = label + (n != null ? `<span class="n">${n}</span>` : '');
      b.onclick = () => onChip(group, label);
      host.appendChild(b);
    });
  }

  function onChip(group, v) {
    if (group === 'tags') {
      if (state.tags.has(v)) state.tags.delete(v); else state.tags.add(v);
    } else if (group === 'rating') {
      state.rating = v === '4.5+' ? 4.5 : v === '4.0+' ? 4.0 : 0;
    } else {
      state[group] = v;
    }
    const distChanged = group === 'dist';
    const districtChanged = group === 'district';
    paintChips();
    // 距离档自己会 fitToDist，区域自己会 fitDistrict，别让自动飞行抢镜头
    suppressFly = distChanged || districtChanged;
    apply();
    suppressFly = false;
    // 距离档位变化要把视野带过去，否则范围外的店看不见
    if (distChanged && me) fitToDist();
    if (districtChanged) fitDistrict(v);
  }

  /* 点「区域」时把视野带到那个区。
     之前只有"筛完剩不到 20 家才自动定位"这一条路径，香洲区 930 家永远够不着 ——
     点了筛选，数量和列表都变了，地图却一动不动，看着像按钮没生效。
     区域是个"地点"而不是"数量条件"，选它就应当看过去，与结果多少无关。

     取景用**区内门店的 2%–98% 分位框**，不用行政区边界、也不用 min/max：
     香洲区辖万山群岛，边界一直延伸到外伶仃；门店里也真有几家在外伶仃（114.03）
     和万山岛（21.93）。按 min/max 取景会一路缩到 10 级，珠海、深圳、香港、澳门
     全挤进来，点了反而更看不清。掐掉两端 2% 的离群点，框住的才是这个区的"城区"。 */
  function fitDistrict(name) {
    if (name === '全部') {
      map.setZoomAndCenter(HOME.zoom, HOME.center, false, 420);
      return;
    }
    const lngs = [], lats = [];
    for (let i = 0; i < DATA.length; i++) {
      const s = DATA[i];
      if (s.district !== name) continue;
      lngs.push(s.lng); lats.push(s.lat);
    }
    if (!lngs.length) return;
    lngs.sort((a, b) => a - b); lats.sort((a, b) => a - b);
    const pick = (a, f) => a[Math.min(a.length - 1, Math.max(0, Math.round(f * (a.length - 1))))];
    const minx = pick(lngs, 0.02), maxx = pick(lngs, 0.98);
    const miny = pick(lats, 0.02), maxy = pick(lats, 0.98);
    const padX = Math.max((maxx - minx) * 0.12, 0.004);
    const padY = Math.max((maxy - miny) * 0.12, 0.004);
    fitBox(minx - padX, miny - padY, maxx + padX, maxy + padY);
  }

  function paintGroup(sel, active) {
    $$(sel + ' .chip').forEach((c) => c.classList.toggle('on', c.dataset.v === active));
  }

  function paintChips() {
    paintGroup('#f-district', state.district);
    paintGroup('#f-kind', state.kind);
    paintGroup('#f-dist', state.dist);
    paintGroup('#f-rating', state.rating === 4.5 ? '4.5+' : state.rating === 4.0 ? '4.0+' : '全部');
    paintGroup('#f-cost', state.cost);
    $$('#f-tags .chip').forEach((c) => c.classList.toggle('on', state.tags.has(c.dataset.v)));
    $$('.brand-item').forEach((d) => d.classList.toggle('on', d.dataset.v === state.brand));
  }

  function buildFilters() {
    const dCount = countBy(DATA, (s) => s.district);
    renderChips('#f-district', [['全部', DATA.length], ...dCount], 'district');

    const chain = DATA.filter((s) => s.brand).length;
    renderChips('#f-kind', [['全部', DATA.length], ['连锁', chain], ['独立', DATA.length - chain]], 'kind');

    const r45 = DATA.filter((s) => s.rating >= 4.5).length;
    const r40 = DATA.filter((s) => s.rating >= 4.0).length;
    renderChips('#f-rating', [['全部', null], ['4.5+', r45], ['4.0+', r40]], 'rating');

    const c30 = DATA.filter((s) => s.cost && s.cost <= 30).length;
    const c60 = DATA.filter((s) => s.cost > 30 && s.cost <= 60).length;
    const chi = DATA.filter((s) => s.cost > 60).length;
    renderChips('#f-cost', [['全部', null], ['≤30', c30], ['31-60', c60], ['>60', chi]], 'cost');

    const tagCount = countBy(DATA.flatMap((s) => s.tags || []), (t) => t)
      .filter(([, n]) => n >= 3).slice(0, 10);
    const th = $('#f-tags');
    th.innerHTML = '';
    tagCount.forEach(([t, n]) => {
      const b = document.createElement('button');
      b.className = 'chip';
      b.dataset.v = t;
      b.innerHTML = t + `<span class="n">${n}</span>`;
      b.onclick = () => onChip('tags', t);
      th.appendChild(b);
    });

    const bh = $('#f-brand');
    bh.innerHTML = '';
    countBy(DATA, (s) => s.brand).slice(0, 12).forEach(([b, n]) => {
      const d = document.createElement('div');
      d.className = 'brand-item';
      d.dataset.v = b;
      d.innerHTML = `<span class="nm">${esc(b)}</span><span class="ct">${n}</span>`;
      d.onclick = () => {
        state.brand = state.brand === b ? null : b;
        paintChips();
        apply();
      };
      bh.appendChild(d);
    });

    const areas = countBy(DATA, (s) => (s.area && s.area !== '其他' ? s.area : null)).slice(0, 8);
    const max = areas.length ? areas[0][1] : 1;
    $('#stats-area').innerHTML = areas.map(([a, n]) => `
      <div class="bar-row">
        <span class="lb">${esc(a)}</span>
        <span class="tr"><span class="fl" style="width:${Math.max(4, (n / max) * 100)}%"></span></span>
        <span class="vl">${n}</span>
      </div>`).join('');

    paintChips();
  }

  /* ══ 数字滚动 ══════════════════════════════════ */
  const shown = new WeakMap();
  function setCount(el, val) {
    const from = shown.has(el) ? shown.get(el) : 0;
    if (from === val) return;
    shown.set(el, val);
    const t0 = performance.now(), dur = 260;
    (function step() {
      const k = Math.min(1, (performance.now() - t0) / dur);
      const e = 1 - Math.pow(1 - k, 3);
      el.textContent = Math.round(from + (val - from) * e);
      if (k < 1) requestAnimationFrame(step);
    })();
  }

  /* ══ 主流程 ════════════════════════════════════ */
  let currentList = [];
  let lastLen = -1;
  let suppressFly = false;    // 调用方自己会取景时，别让 apply 里的自动飞行插一脚

  /* 结果收敛时把地图带过去，避免"筛出 1 家却看不到点" */
  function flyTo(list) {
    if (!list.length) return;
    if (list.length === 1) {
      map.setZoomAndCenter(Math.max(map.getZoom(), 16.2), [list[0].lng, list[0].lat], false, 420);
      return;
    }
    let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
    for (let i = 0; i < list.length; i++) {
      const s = list[i];
      if (s.lng < minx) minx = s.lng;
      if (s.lng > maxx) maxx = s.lng;
      if (s.lat < miny) miny = s.lat;
      if (s.lat > maxy) maxy = s.lat;
    }
    // 给最小跨度，避免几个点挤在一起时过度放大
    const padX = Math.max((maxx - minx) * 0.3, 0.006);
    const padY = Math.max((maxy - miny) * 0.3, 0.006);
    map.setBounds(
      new AMap.Bounds([minx - padX, miny - padY], [maxx + padX, maxy + padY]),
      false, viewPadding(), 420
    );
  }

  /* setBounds 的边距要绕开两侧面板，否则点全在面板底下 */
  function viewPadding() {
    const w = window.innerWidth, h = window.innerHeight;
    const pad = [40, 40, 40, 40];           // 上 右 下 左
    const rankOpen = (() => {
      const r = $('#rank');
      return !!r && !r.classList.contains('hidden') && !r.classList.contains('collapsed');
    })();
    const panelOpen = (() => {
      const p = $('#panel');
      return !!p && !p.classList.contains('collapsed');
    })();

    if (w <= 760) {
      if (panelOpen) pad[2] = Math.round(h * 0.62) + 16;   // 移动端筛选面板在底部
      if (rankOpen) pad[1] = Math.min(300, Math.max(120, w - 32)) + 16;
    } else {
      if (panelOpen) pad[3] = 356;                          // 桌面端筛选面板在左侧
      if (rankOpen) pad[1] = 316;                           // 排行面板在右侧
    }
    // 两个面板同时开会把可视区压没，保底留 240px
    if (w - pad[1] - pad[3] < 240) { pad[1] = 40; pad[3] = 40; }
    return pad;
  }

  /* 把一块矩形范围装进"两块面板之间"的可视区。
     不用 setBounds 自带的 padding：实测它并不把内容居中到留白后的区域，
     传 [40,316,40,356] 时圆心会跑到容器左上方，圆的左边照样压在左侧面板底下
     （量到圆心 x=562，而可视区中心应该在 740）。所以缩放和偏移都自己算：
       ① 用米/像素把矩形塞进 availW×availH，得出缩放；
       ② 把矩形中心从容器中心挪到可视区中心，得出该用的地图中心。 */
  function fitBox(minLng, minLat, maxLng, maxLat) {
    const el = document.getElementById('map');
    const pad = viewPadding();
    const W = el.clientWidth, H = el.clientHeight;
    const availW = Math.max(120, W - pad[1] - pad[3]);
    const availH = Math.max(120, H - pad[0] - pad[2]);
    const latC = (minLat + maxLat) / 2;
    const cos = Math.cos(latC * Math.PI / 180);
    const KX = 111320 * cos, KY = 110540;
    const bw = Math.max(40, (maxLng - minLng) * KX);     // 矩形宽（米）
    const bh = Math.max(40, (maxLat - minLat) * KY);     // 矩形高（米）
    const mpp = Math.max(bw / availW, bh / availH);
    const z = Math.log2(156543.03392 * cos / mpp);
    // 矩形中心要落在可视区中心 → 反推地图中心该偏多少
    const dx = (pad[3] + availW / 2) - W / 2;
    const dy = (pad[0] + availH / 2) - H / 2;
    map.setZoomAndCenter(z, [
      (minLng + maxLng) / 2 - (dx * mpp) / KX,
      latC + (dy * mpp) / KY,
    ], false, 480);
  }

  /* 切距离档时把地图带到"能看全这一圈"的位置。
     早期版本只改筛选不改视野：点 3km/5km 后数量变了，但地图还停在 1km 的缩放，
     范围外的店根本看不见，表现为"点了没反应"。 */
  function fitToDist() {
    if (!me) return;
    const lim = (DIST_LEVELS.find(([k]) => k === state.dist) || [])[1];

    if (lim == null) {
      // 「全部」：看全当前筛选结果，同时保证"我"还在视野里
      if (!currentList.length) return;      // 没有结果就算不出包围盒
      let minx = me.lng, miny = me.lat, maxx = me.lng, maxy = me.lat;
      for (let i = 0; i < currentList.length; i++) {
        const s = currentList[i];
        if (s.lng < minx) minx = s.lng;
        if (s.lng > maxx) maxx = s.lng;
        if (s.lat < miny) miny = s.lat;
        if (s.lat > maxy) maxy = s.lat;
      }
      fitBox(minx, miny, maxx, maxy);
    } else {
      // 有半径：以"我"为圆心，让 2×lim 见方的范围整块落进可视区
      const KX = 111320 * Math.cos(me.lat * Math.PI / 180);   // 米 / 度经度
      const KY = 110540;                                      // 米 / 度纬度
      const dlng = lim / KX, dlat = lim / KY;
      fitBox(me.lng - dlng, me.lat - dlat, me.lng + dlng, me.lat + dlat);
    }

    // 缩得太小时标签画不出来，说清楚，别让用户以为又坏了。
    // 文案在这里就定下来：等到 540ms 之后才读 currentList，用户连点两档时
    // 会弹出一条用新数字配旧档位的提示（实测"500m"选着、提示却写 5km 616 家）。
    const scope = state.dist === '全部'
      ? `共 ${currentList.length} 家`
      : `${state.dist} 内 ${currentList.length} 家`;
    const atDist = state.dist;
    setTimeout(() => {
      if (!me || state.dist !== atDist || map.getZoom() >= 14) return;
      toast(`${scope} · 放大到街区级可显示店名`);
    }, 540);
  }

  function apply() {
    const q = state.q.trim().toLowerCase();
    const list = DATA.filter((s) => {
      if (state.district !== '全部' && s.district !== state.district) return false;
      if (state.kind === '连锁' && !s.brand) return false;
      if (state.kind === '独立' && s.brand) return false;
      if (state.rating && !(s.rating >= state.rating)) return false;
      if (state.cost === '≤30' && !(s.cost && s.cost <= 30)) return false;
      if (state.cost === '31-60' && !(s.cost > 30 && s.cost <= 60)) return false;
      if (state.cost === '>60' && !(s.cost > 60)) return false;
      if (state.brand && s.brand !== state.brand) return false;
      if (state.onlySaved && !saved.has(s.id)) return false;
      if (state.tags.size) {
        for (const t of state.tags) if (!(s.tags || []).includes(t)) return false;
      }
      if (q) {
        const hay = (s.name + ' ' + (s.brand || '') + ' ' + (s.address || '') + ' ' + (s.area || '')).toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });

    // 有定位时：先算距离，再定"这一屏该展示哪些"，最后按距离从远到近排序
    // （远先画、近后画，近处的点自然压在上层 = "附近优先展示"）
    let list2 = list;
    if (me) {
      for (let i = 0; i < list.length; i++) {
        const s = list[i];
        s._d = distM(me.lng, me.lat, s.lng, s.lat);
      }
      const lim = distLimit();
      if (lim && distActive()) {
        list2 = list.filter((s) => s._d <= lim);
      } else if (lim) {
        /* 视野已经离开我周边（用户拖去别的区逛了）：这时再按档裁就是一片空白。
           改成"跟随视野"—— 统计和列表只看当前画面里的店，和地图上画的一致。 */
        const b = map.getBounds();
        if (b) {
          const sw = b.getSouthWest(), ne = b.getNorthEast();
          list2 = list.filter((s) =>
            s.lng >= sw.lng && s.lng <= ne.lng && s.lat >= sw.lat && s.lat <= ne.lat);
        }
      }
      list2.sort((a, b) => b._d - a._d);
    }

    currentList = list2;
    /* 地图拿的是「没被距离档裁过」的全量：图层自己每帧按视口裁，
       这样拖动时新进画面的店立刻就在，不用等松手重新 apply。
       距离档的裁剪在图层里做（distLim），和这里保持同一套判定。 */
    layer.setData(list);

    // 数量发生变化且收敛到 20 家以内 → 自动定位（首次加载 lastLen=-1 不触发）
    const narrowed = lastLen >= 0 && list2.length !== lastLen && list2.length > 0 && list2.length <= 20;
    lastLen = list2.length;
    // 切距离档时由 fitToDist 负责取景，这里不要再飞一次 ——
    // 两个 setZoomAndCenter 叠在同一个 tick 里，后一个会打断前一个，
    // 表现为切完范围画面先冲一下再改道，还会多弹一条 toast。
    if (narrowed && !suppressFly) flyTo(list2);

    const ch = list2.filter((s) => s.brand).length;
    setCount($('#c-total'), list2.length);
    setCount($('#c-chain'), ch);
    setCount($('#c-indie'), list2.length - ch);
    $('#empty').classList.toggle('hidden', !(list2.length === 0 && (list.length === 0 || distActive())));
    /* 空态只在「真的筛没了」时提示。跟随视野时拖到空区域（海面、山地）不该弹
       「试试放宽筛选」—— 那不是筛选的问题，是这块地方本来就没有店。 */
    syncURL();
    renderRank();
    // 记下这一轮距离档是不是生效，moveend 时靠它判断要不要重算
    distWasActive = me ? distActive() : null;
  }

  function refreshChrome() {
    $('#c-raw').textContent = DATA.length;
    setCount($('#c-saved'), saved.size);
    $('#saved-btn').classList.toggle('on', state.onlySaved);
    $('#updated').textContent = window.DATA_UPDATED || '—';
    renderDist();
    apply();
  }

  /* ══ 右侧评分排面板 ══════════════════════════════
     跟随左侧筛选实时重排；点行飞到店里并开卡片，悬停行在地图上高亮对应圆点。 */
  const RANK_CAP = 200;
  let rankSort = 'rating';
  let rankIdx = new Map();

  function rankSorted() {
    const arr = currentList.slice();
    if (rankSort === 'dist' && me) {
      arr.sort((a, b) => (a._d == null ? 1e9 : a._d) - (b._d == null ? 1e9 : b._d));
    } else if (rankSort === 'cost') {
      arr.sort((a, b) => (a.cost == null ? 1e9 : a.cost) - (b.cost == null ? 1e9 : b.cost));
    } else {
      // 评分降序；同分看图片数，再看店名，保证顺序稳定不跳
      arr.sort((a, b) =>
        (b.rating || 0) - (a.rating || 0) ||
        (b.photos || 0) - (a.photos || 0) ||
        (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    }
    return arr;
  }

  function renderRank() {
    const host = $('#rank-list');
    const all = rankSorted();
    const shown = all.slice(0, RANK_CAP);
    $('#rank-count').textContent = all.length;

    rankIdx = new Map();
    for (let i = 0; i < shown.length; i++) rankIdx.set(shown[i].id, shown[i]);

    if (!shown.length) {
      host.innerHTML = '<div class="rk-empty">没有符合条件的咖啡馆<br>试试放宽筛选</div>';
      $('#rank-note').textContent = '';
      return;
    }

    const byDist = rankSort === 'dist' && me;
    const byCost = rankSort === 'cost';
    let html = '';
    for (let i = 0; i < shown.length; i++) {
      const s = shown[i];
      const meta = [];
      if (s._d != null) meta.push(`<span class="dt">${fmtDist(s._d)}</span>`);
      if (s.cost) meta.push(`人均 ¥${Math.round(s.cost)}`);
      // 有业态标签就显示标签（比商圈更能说明这是什么店），否则退回品牌/商圈
      const tg = (s.tags || []).filter((t) => t !== '早咖' && t !== '夜咖')[0];
      if (s.brand) meta.push(esc(s.brand));
      else if (tg) meta.push(esc(tg));
      else if (s.area && s.area !== '其他') meta.push(esc(s.area));

      let val, low = '';
      if (byCost) { val = s.cost ? '¥' + Math.round(s.cost) : '—'; }
      else if (byDist) { val = s._d != null ? fmtDist(s._d) : '—'; }
      else {
        val = s.rating ? s.rating.toFixed(1) : '—';
        if (!s.rating || s.rating < 4.0) low = ' low';
      }

      html += `<div class="rrow" data-id="${esc(s.id)}">` +
        `<span class="rk">${i + 1}</span>` +
        `<span class="dot ${s.brand ? 'chain' : 'indie'}"></span>` +
        `<div class="mid"><div class="nm">${esc(s.name)}</div>` +
        (meta.length ? `<div class="mt">${meta.join('<i></i>')}</div>` : '') +
        `</div><span class="rv${low}">${val}</span></div>`;
    }
    host.innerHTML = html;

    $('#rank-note').textContent = all.length > RANK_CAP
      ? `显示前 ${RANK_CAP} 家 · 共 ${all.length} 家`
      : `共 ${all.length} 家`;
  }

  /* 地图上悬停某个圆点时，右侧列表对应行高亮 */
  function highlightRank(s) {
    const cur = $('#rank-list .rrow.hl');
    if (cur) cur.classList.remove('hl');
    if (!s) return;
    const row = $('#rank-list .rrow[data-id="' + s.id + '"]');
    if (row) row.classList.add('hl');
  }

  (function bindRank() {
    const host = $('#rank-list');
    // 事件委托：200 行也不用绑 200 个监听
    host.onclick = (e) => {
      const row = e.target.closest('.rrow');
      if (!row) return;
      const s = rankIdx.get(row.dataset.id);
      if (!s) return;
      openCard(s);
      map.setZoomAndCenter(Math.max(map.getZoom(), 16.2), [s.lng, s.lat], false, 420);
    };
    host.onmouseover = (e) => {
      const row = e.target.closest('.rrow');
      const s = row && rankIdx.get(row.dataset.id);
      layer.setHover(s ? { type: 'dot', s } : null);
    };
    host.onmouseleave = () => layer.clearHover();

    $('#rank-sort').onclick = (e) => {
      const b = e.target.closest('button');
      if (!b || b.classList.contains('on')) return;
      const v = b.dataset.v;
      if (v === 'dist' && !me) { toast('先点右上角「定位」才能按距离排序'); return; }
      rankSort = v;
      $$('#rank-sort button').forEach((x) => x.classList.toggle('on', x === b));
      renderRank();
    };

    $('#btn-rank').onclick = () => {
      const r = $('#rank');
      const willHide = !r.classList.contains('hidden');
      r.classList.toggle('hidden', willHide);
      $('#btn-rank').classList.toggle('active', !willHide);
    };

    $('#rank-collapse').onclick = () => {
      $('#rank').classList.add('collapsed');
      // 和左面板同一个节奏：等 280ms 再挂按钮。挂早了它会凭空浮在
      // 还在往右滑的面板上（z-index 25 > 面板的 19），看着像多贴了一块玻璃。
      setTimeout(() => {
        // 展开时按钮是「淡出 240ms 后再摘」，这期间它还在 DOM 里。
        // 若在这 240ms 内又点了收起，老按钮会挡住新建（原来直接 return 就没了）。
        // 只有带 .in 的才算「正在用」，其余一律当残留清掉。
        const old = document.getElementById('rank-open');
        if (old) {
          if (old.classList.contains('in')) return;
          old.remove();
        }
        /* 类名必须带 lg-glass：圆角和底色都是 .lg-glass 给的，只有 .tool 的话
           会退化成浏览器默认的灰方块（方角、系统字体、无背景），跟旁边的胶囊差一大截。 */
        const b = document.createElement('button');
        b.id = 'rank-open';
        b.className = 'tool lg-glass';
        b.title = '展开排行面板';
        b.textContent = '‹ 排行';
        b.onclick = () => {
          $('#rank').classList.remove('collapsed');
          // 先撤 .in 让它缩回去淡掉，再摘 DOM —— 直接 remove() 是凭空消失一块玻璃
          b.classList.remove('in');
          setTimeout(() => b.remove(), 240);
        };
        document.body.appendChild(b);
        // append 和加类在同一帧里不会有过渡，得等一帧（双层 rAF 更稳）
        requestAnimationFrame(() => requestAnimationFrame(() => b.classList.add('in')));
      }, 280);
    };

    // 小屏/中等宽度默认收起右面板，避免把地图挤没；宽屏再放出来
    const fitRank = () => {
      const narrow = window.innerWidth <= 1000;
      $('#rank').classList.toggle('hidden', narrow);
      $('#btn-rank').classList.toggle('active', !narrow);
    };
    fitRank();
    window.addEventListener('resize', fitRank);
  })();

  /* ══ 定位与"距我"筛选 ═══════════════════════════ */
  let toastTimer = null;
  function toast(msg) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('on'), 2800);
  }

  function renderDist() {
    const sec = $('#sec-dist');
    if (!me) { sec.classList.add('hidden'); return; }
    sec.classList.remove('hidden');
    // 一次算完所有距离，供各档计数复用
    const ds = DATA.map((s) => distM(me.lng, me.lat, s.lng, s.lat));
    const items = DIST_LEVELS.map(([label, lim]) => [
      label,
      lim == null ? DATA.length : ds.filter((d) => d <= lim).length,
    ]);
    renderChips('#f-dist', items, 'dist');
    paintGroup('#f-dist', state.dist);
  }

  let geoloc = null;
  function locate() {
    const btn = $('#btn-loc');
    if (typeof AMap.Geolocation !== 'function') {
      toast('定位插件未加载，请检查网络后刷新');
      return;
    }
    if (me) {                        // 已定位：再点一次回到自己位置
      // 档位要跟第一次定位一致。之前只有第一次会把「全部」收成 1km，
      // 第二次不管：如果先把范围切到「全部」（视野被拉到全市），再按定位，
      // 地图缩回街区级、面板却还写着全市的家数 —— 数字和画面对不上，
      // 看着就像"定位之后显示错了"。
      if (state.dist === '全部') {
        state.dist = '1km';
        renderDist();
        suppressFly = true;
        apply();
        suppressFly = false;
      }
      map.setZoomAndCenter(Math.max(map.getZoom(), 15.2), [me.lng, me.lat], false, 420);
      return;
    }
    btn.classList.add('busy');
    btn.textContent = '定位中…';
    if (!geoloc) {
      geoloc = new AMap.Geolocation({
        enableHighAccuracy: true,
        timeout: 8000,
        needAddress: false,
        noIpLocate: 0,               // 允许浏览器定位失败后走 IP 兜底
        GeoLocationFirst: true,
        showButton: false,
        showMarker: false,
        showCircle: false,
        panToLocation: false,
        zoomToAccuracy: false,
      });
    }
    geoloc.getCurrentPosition((status, result) => {
      btn.classList.remove('busy');
      btn.textContent = '定位';
      if (status !== 'complete' || !result.position) {
        const why = (result && (result.message || result.info)) || '浏览器未授权';
        toast('定位失败：' + why + '（可手动拖到你的位置）');
        return;
      }
      const p = result.position;
      me = { lng: p.getLng(), lat: p.getLat(), acc: result.accuracy || 60 };
      btn.classList.add('active');
      btn.textContent = '已定位';
      if (state.dist === '全部') state.dist = '1km';   // 默认只看附近
      // 定位后直接把附近店名铺到地图上，不用逐个点开
      layer.setLabels(true);
      syncLabelBtn();
      renderDist();
      suppressFly = true;          // 下面马上 setZoomAndCenter，别让 flyTo 抢
      apply();
      suppressFly = false;
      map.setZoomAndCenter(Math.max(map.getZoom(), 15.2), [me.lng, me.lat], false, 480);
      const n = currentList.length;
      toast(`已定位 · ${state.dist} 内 ${n} 家，店名已直接标在地图上`);
    });
  }

  /* ══ 事件绑定 ══════════════════════════════════ */
  let timer = null;
  $('#q').addEventListener('input', (e) => {
    state.q = e.target.value;
    $('#q-clear').classList.toggle('on', !!state.q);
    clearTimeout(timer);
    timer = setTimeout(apply, 160);
  });
  $('#q-clear').onclick = () => {
    $('#q').value = ''; state.q = ''; $('#q-clear').classList.remove('on'); apply();
  };

  $('#saved-btn').onclick = () => { state.onlySaved = !state.onlySaved; refreshChrome(); };

  $('#collapse').onclick = () => {
    $('#panel').classList.add('collapsed');
    document.body.classList.add('pcollapsed');   // 工具栏跟着挪到最左边
    // 面板滑出 320ms，按钮 280ms 后开始淡入，正好接住，不留空档
    setTimeout(() => {
      // 同 rank-open：展开时按钮淡出 240ms 才摘，这期间别把残留当成「已在用」
      const old = document.getElementById('panel-open');
      if (old) {
        if (old.classList.contains('in')) return;
        old.remove();
      }
      // 同 rank-open：带 lg-glass 才有圆角和底色，否则是个灰方块
      const b = document.createElement('button');
      b.id = 'panel-open';
      b.className = 'tool lg-glass';
      b.title = '展开筛选面板';
      b.textContent = '› 筛选';
      b.onclick = () => {
        $('#panel').classList.remove('collapsed');
        document.body.classList.remove('pcollapsed');
        b.classList.remove('in');
        setTimeout(() => b.remove(), 240);
      };
      document.body.appendChild(b);
      requestAnimationFrame(() => requestAnimationFrame(() => b.classList.add('in')));
    }, 280);
  };

  $('#btn-bound').onclick = () => {
    const on = $('#btn-bound').classList.contains('active');
    districtPolys.forEach((p) => p.setMap(on ? null : map));
    $('#btn-bound').classList.toggle('active', !on);
  };

  $('#btn-fit').onclick = () => map.setZoomAndCenter(HOME.zoom, HOME.center);

  document.addEventListener('keydown', (e) => {
    if (e.key === '/' && document.activeElement !== $('#q')) { e.preventDefault(); $('#q').focus(); }
    if (e.key === 'Escape') { closeCard(); $('#q').blur(); }
  });

  $('#btn-loc').onclick = locate;

  /* 视野离开我周边、或又拖回来时，距离档的生效状态变了 —— 统计和列表要跟着重算，
     否则地图已经按"跟随视野"画了，面板还停在原来的数字。
     只在跨过阈值的那一次触发，拖动过程中不会反复重建列表。
     必须延后一拍判断：moveend 回调里 map.getBounds() 有时还是移动前的视野，
     当场判断会得出"没变化"，然后就不会再有机会重算了（实测拖走 4.8km，
     计数仍停在 3km 档的 363）。 */
  let distWasActive = null;
  let distTimer = 0;
  function syncDistScope() {
    if (!me) { distWasActive = null; return; }
    clearTimeout(distTimer);
    distTimer = setTimeout(() => {
      const on = distActive();
      if (on === distWasActive) return;
      distWasActive = on;
      suppressFly = true;        // 用户只是在拖地图，别自动飞走
      apply();
      suppressFly = false;
    }, 80);
  }
  map.on('moveend', syncDistScope);
  map.on('zoomend', syncDistScope);

  $('#btn-label').onclick = () => {
    const on = !layer.getLabels();
    layer.setLabels(on);
    syncLabelBtn();
    if (on && map.getZoom() < 14.2) {
      // 没有定位时不能盲目放大——视野可能落在空旷处。
      // 按放大后的可视范围（约 1.5km 半径）数一数店，够密就留在原地，否则带到
      // 当前筛选结果里评分最高的那一批的中心去。
      let cx = map.getCenter().getLng(), cy = map.getCenter().getLat();
      let near = 0;
      for (let i = 0; i < currentList.length; i++) {
        const s = currentList[i];
        if (distM(cx, cy, s.lng, s.lat) <= 1500) near++;
      }
      if (near < 6 && currentList.length) {
        let sx = 0, sy = 0, w = 0;
        const top = currentList.slice().sort((a, b2) => (b2.rating || 0) - (a.rating || 0)).slice(0, 60);
        for (let i = 0; i < top.length; i++) { sx += top[i].lng; sy += top[i].lat; w++; }
        if (w) { cx = sx / w; cy = sy / w; }
      }
      map.setZoomAndCenter(14.8, [cx, cy], false, 420);
      toast('已放大到街区级 · 店名直接标在地图上');
    }
  };

  window.__setMe = (lng, lat, acc, dist) => {   // 调试用：绕过浏览器定位
    me = { lng, lat, acc: acc || 60 };
    $('#btn-loc').classList.add('active');
    layer.setLabels(true);
    syncLabelBtn();
    if (dist) state.dist = dist;
    else if (state.dist === '全部') state.dist = '1km';
    renderDist(); apply();
  };

  // 调试用：距离档的生效状态。自动化验证靠它判断"拖走以后档位有没有让路"。
  window.__dist = () => {
    const c = map.getCenter();
    return {
      lim: distLimit(),
      active: distActive(),
      meToView: me ? Math.round(distM(me.lng, me.lat, c.lng, c.lat)) : null,
      total: currentList.length,
      wasActive: distWasActive,
    };
  };

  /* ══ 启动 ══════════════════════════════════════ */
  if (state.q) { $('#q').value = state.q; $('#q-clear').classList.add('on'); }
  buildFilters();
  tryMount();
  refreshChrome();
  ld.data();                       // 数据已上屏，加载画面可以走了
  setTimeout(() => { tryMount(); layer.draw(); }, 600);
  setTimeout(() => $('#hint').classList.add('hidden'), 4200);

  console.log(`[珠海咖啡地图] ${DATA.length} 家 · canvas 图层`);
})();
