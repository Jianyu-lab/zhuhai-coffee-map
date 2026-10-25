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
    let born = 0;
    let raf = 0;

    const CHAIN = '#E0A458';
    const INDIE = '#6FBF9B';
    const SAVED = '#E2607A';

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
    let dimmed = false;
    const lcache = new Map();

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

      const alpha = Math.min(1, (performance.now() - born) / 200);

      // 底图压暗只在"标签真的画出来"时生效，否则热力图/缩小时会白白变暗
      syncDim(z);

      // 热力图模式或结果为空：不画店点，但定位点要留着
      if (!data.length) { ctx.globalAlpha = 1; lastLabels = 0; drawMe(z); return; }
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

      for (let i = 0; i < data.length; i++) {
        const s = data[i];
        if (s.lng < sw.lng || s.lng > ne.lng || s.lat < sw.lat || s.lat > ne.lat) continue;
        let p;
        try {
          p = map.lngLatToContainer([s.lng, s.lat]);
        } catch (e) { continue; }
        if (!p) continue;
        if (!clusterMode) { singles.push({ s, x: p.x, y: p.y }); continue; }

        const k = ((p.x / cell) | 0) + '_' + ((p.y / cell) | 0);
        let b = buckets.get(k);
        if (!b) { b = { n: 0, x: 0, y: 0, lng: 0, lat: 0, items: [], dmin: Infinity }; buckets.set(k, b); }
        b.n++; b.x += p.x; b.y += p.y; b.lng += s.lng; b.lat += s.lat;
        b.items.push(s);
        if (s._d < b.dmin) b.dmin = s._d;
      }

      ctx.globalAlpha = alpha;

      if (clusterMode) {
        buckets.forEach((b) => {
          const cx = b.x / b.n, cy = b.y / b.n;
          const dr = dotRadius(z);
          ctx.globalAlpha = alpha * dim(b.dmin);
          if (b.n === 1) {
            // 单个点也要登记命中，否则这些点永远点不开
            drawDot(cx, cy, b.items[0], dr, emph);
            hits.push({ type: 'dot', x: cx, y: cy, r: dr + 2.5, s: b.items[0] });
            lab.push({ s: b.items[0], x: cx, y: cy, r: dr });
            return;
          }
          const r = Math.min(radiusFor(b.n), cell * 0.45);
          const isHover = hoverItem && hoverItem.type === 'cluster' &&
            Math.abs(hoverItem.x - cx) < 0.6 && Math.abs(hoverItem.y - cy) < 0.6;
          drawCluster(cx, cy, r, b.n, isHover);
          hits.push({
            type: 'cluster', x: cx, y: cy, r, n: b.n,
            lng: b.lng / b.n, lat: b.lat / b.n, items: b.items,
          });
        });
      } else {
        const dr = dotRadius(z);
        for (let i = 0; i < singles.length; i++) {
          const it = singles[i];
          ctx.globalAlpha = alpha * dim(it.s._d);
          drawDot(it.x, it.y, it.s, dr, emph);
          hits.push({ type: 'dot', x: it.x, y: it.y, r: dr + 2.5, s: it.s });
          lab.push({ s: it.s, x: it.x, y: it.y, r: dr });
        }
      }

      ctx.globalAlpha = 1;
      drawMeRing(z);
      // 标签压在圆点之上；蓝点（我自己）最后画，保证永远可见
      if (labelOn && z >= LABEL_MIN_Z && lab.length) {
        drawLabels(lab, alpha);
      } else {
        lastLabels = 0;
      }
      drawMeCore(z);
    }

    /* 标签文字组成：店名 + 距离 + 评分，超宽就截店名 */
    function buildLabel(s) {
      const badges = [];
      if (s._d != null) badges.push({ t: fmtDist(s._d), c: '#8CB8FF' });
      if (s.rating >= 4.0) badges.push({ t: '★' + s.rating.toFixed(1), c: '#E8B36A' });

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

    function drawLabels(list, alpha) {
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
      let n = 0;
      ctx.globalAlpha = alpha;

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
        let box = null;
        for (let c = 0; c < cands.length; c++) {
          const b = { x: cands[c][0], y: cands[c][1], w: L.w, h };
          if (fits(b, placed)) { box = b; break; }
        }
        if (!box) continue;
        placed.push(box);
        n++;
        drawPill(box, L, it.s);
        // 标签本身也能点开
        hits.push({ type: 'dot', s: it.s, box });
      }
      lastLabels = n;
      ctx.globalAlpha = 1;
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
      ctx.fillStyle = hl ? 'rgba(52,41,29,.97)' : 'rgba(13,11,9,.90)';
      ctx.fill();
      ctx.lineWidth = 1;
      ctx.strokeStyle = hl ? 'rgba(224,164,88,.9)' : 'rgba(255,255,255,.16)';
      ctx.stroke();

      const cy = b.y + b.h / 2 + 0.5;
      let tx = b.x + 7;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.font = FONT_N;
      ctx.fillStyle = hl ? '#FFF7EC' : '#E8E2D9';
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
      ctx.fillStyle = 'rgba(59,130,246,.10)';
      ctx.fill();
      ctx.lineWidth = 1;
      ctx.strokeStyle = 'rgba(59,130,246,.30)';
      ctx.stroke();
    }

    function drawMeCore(z) {
      const m = meAt(z);
      if (!m) return;
      const p = m.p;
      ctx.globalAlpha = 1;

      ctx.beginPath();
      ctx.arc(p.x, p.y, 17, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(59,130,246,.18)';
      ctx.fill();

      ctx.beginPath();
      ctx.arc(p.x, p.y, 7, 0, Math.PI * 2);
      ctx.fillStyle = '#3B82F6';
      ctx.fill();
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = '#FFFFFF';
      ctx.stroke();
    }

    function drawMe(z) { drawMeRing(z); drawMeCore(z); }

    function drawCluster(x, y, r, n, isHover) {
      if (isHover) {
        ctx.beginPath();
        ctx.arc(x, y, r + 5, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(224,164,88,.16)';
        ctx.fill();
      }
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = isHover ? '#F0B869' : 'rgba(224,164,88,.92)';
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = 'rgba(255,255,255,.5)';
      ctx.stroke();

      ctx.fillStyle = '#17130f';
      ctx.font = '600 ' + (n > 999 ? 10 : n > 99 ? 11 : 12) + 'px -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(n > 999 ? '999+' : String(n), x, y + 0.5);
    }

    function drawDot(x, y, s, base, emph) {
      const color = s.brand ? CHAIN : INDIE;
      const isHover = hoverItem && hoverItem.type === 'dot' && hoverItem.s === s;
      const r = isHover ? base + 2.2 : base;

      // 结果极少时加定位环，避免"筛出 1 家却找不到点"
      if (emph) {
        ctx.beginPath();
        ctx.arc(x, y, r + 9, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(255,255,255,.07)';
        ctx.fill();
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = 'rgba(255,255,255,.5)';
        ctx.stroke();
      }

      // 收藏：粉色光晕
      if (saved.has(s.id)) {
        ctx.beginPath();
        ctx.arc(x, y, r + 5, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(226,96,122,.30)';
        ctx.fill();
      }
      // 悬停：白色光晕
      if (isHover) {
        ctx.beginPath();
        ctx.arc(x, y, r + 4.5, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(255,255,255,.22)';
        ctx.fill();
      }

      // 主体
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = 'rgba(11,10,9,.85)';
      ctx.stroke();

      // 外圈高光，提升暗底上的辨识度
      ctx.beginPath();
      ctx.arc(x, y, r + 1.6, 0, Math.PI * 2);
      ctx.lineWidth = 1;
      ctx.strokeStyle = 'rgba(255,255,255,.20)';
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
      setData(list) { data = list; born = performance.now(); schedule(); },
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
    };
  })();

  window.__layer = layer;   // 调试用

  let mounted = false;
  function tryMount() { if (!mounted) mounted = layer.mount(); }

  /* ══ 区界 ══════════════════════════════════════ */
  const districtPolys = [];
  (function drawDistricts() {
    DISTRICTS.features.forEach((f) => {
      const g = f.geometry;
      const polys = g.type === 'MultiPolygon' ? g.coordinates : [g.coordinates];
      polys.forEach((poly) => {
        const p = new AMap.Polygon({
          path: poly[0].map((c) => [c[0], c[1]]),
          strokeColor: '#E0A458',
          strokeWeight: 1.2,
          strokeOpacity: 0.5,
          strokeStyle: 'dashed',
          fillColor: '#E0A458',
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
          'font-size:11px;letter-spacing:.22em;color:rgba(224,164,88,.6);' +
          'text-shadow:0 1px 6px #000;pointer-events:none;font-weight:500';
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

    return `<div class="card">
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
  tip.className = 'tip';
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
  ['move', 'zoom', 'zoomchange', 'zoomend', 'moveend', 'resize', 'complete']
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
    paintChips();
    apply();
    // 距离档位变化要把视野带过去，否则范围外的店看不见
    if (distChanged && me) fitToDist();
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

  /* 切距离档时把地图带到"能看全这一圈"的位置。
     早期版本只改筛选不改视野：点 3km/5km 后数量变了，但地图还停在 1km 的缩放，
     范围外的店根本看不见，表现为"点了没反应"。 */
  function fitToDist() {
    if (!me || !currentList.length) return;
    const lim = (DIST_LEVELS.find(([k]) => k === state.dist) || [])[1];

    if (lim == null) {
      // 「全部」：看全当前筛选结果，同时保证"我"还在视野里
      let minx = me.lng, miny = me.lat, maxx = me.lng, maxy = me.lat;
      for (let i = 0; i < currentList.length; i++) {
        const s = currentList[i];
        if (s.lng < minx) minx = s.lng;
        if (s.lng > maxx) maxx = s.lng;
        if (s.lat < miny) miny = s.lat;
        if (s.lat > maxy) maxy = s.lat;
      }
      map.setBounds(new AMap.Bounds([minx, miny], [maxx, maxy]), false, viewPadding(), 480);
    } else {
      // 有半径：以"我"为圆心，让 2×lim 的方框正好落进可视范围
      const el = document.getElementById('map');
      const pad = viewPadding();
      const availW = Math.max(200, el.clientWidth - pad[1] - pad[3]);
      const availH = Math.max(200, el.clientHeight - pad[0] - pad[2]);
      const px = Math.min(availW, availH);
      const mpp = (lim * 2) / px;
      const z = Math.log2(156543.03392 * Math.cos(me.lat * Math.PI / 180) / mpp);
      map.setZoomAndCenter(z, [me.lng, me.lat], false, 480);
    }

    // 缩得太小时标签画不出来，说清楚，别让用户以为又坏了
    setTimeout(() => {
      if (!me || map.getZoom() >= 14) return;
      const scope = state.dist === '全部'
        ? `共 ${currentList.length} 家`
        : `${state.dist} 内 ${currentList.length} 家`;
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

    // 有定位时：先算距离，再按档过滤，最后按距离从远到近排序
    // （远先画、近后画，近处的点自然压在上层 = "附近优先展示"）
    let list2 = list;
    if (me) {
      for (let i = 0; i < list.length; i++) {
        const s = list[i];
        s._d = distM(me.lng, me.lat, s.lng, s.lat);
      }
      const lim = (DIST_LEVELS.find(([k]) => k === state.dist) || [])[1];
      if (lim) list2 = list.filter((s) => s._d <= lim);
      list2.sort((a, b) => b._d - a._d);
    }

    currentList = list2;
    layer.setData(list2);

    // 数量发生变化且收敛到 20 家以内 → 自动定位（首次加载 lastLen=-1 不触发）
    const narrowed = lastLen >= 0 && list2.length !== lastLen && list2.length > 0 && list2.length <= 20;
    lastLen = list2.length;
    if (narrowed) flyTo(list2);

    const ch = list2.filter((s) => s.brand).length;
    setCount($('#c-total'), list2.length);
    setCount($('#c-chain'), ch);
    setCount($('#c-indie'), list2.length - ch);
    $('#empty').classList.toggle('hidden', list2.length > 0);
    syncURL();
    renderRank();
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
      const b = document.createElement('button');
      b.className = 'tool';
      b.textContent = '‹ 排行';
      b.style.cssText = 'position:absolute;right:16px;top:16px;z-index:25';
      b.onclick = () => { $('#rank').classList.remove('collapsed'); b.remove(); };
      document.body.appendChild(b);
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
      apply();
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
    setTimeout(() => {
      const b = document.createElement('button');
      b.className = 'tool';
      b.textContent = '☰ 筛选';
      b.style.cssText = 'position:absolute;left:16px;top:16px;z-index:25';
      b.onclick = () => {
        $('#panel').classList.remove('collapsed');
        document.body.classList.remove('pcollapsed');
        b.remove();
      };
      document.body.appendChild(b);
    }, 300);
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
