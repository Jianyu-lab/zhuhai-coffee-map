/* 标签层验证：定位后店名是否直接铺在地图上、能否点开、性能是否达标 */
const { chromium } = require('playwright-core');
const path = require('path');

const EXE = process.env.CHROME_PATH ||
  path.join(process.env.HOME, 'Library/Caches/ms-playwright/chromium-1248',
    'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
const shot = (n) => path.resolve(__dirname, '../shots/', n);

(async () => {
  const browser = await chromium.launch({ executablePath: EXE, args: ['--allow-file-access-from-files'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errs = [];
  page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
  page.on('pageerror', (e) => errs.push('PAGEERROR ' + e.message));

  await page.goto('file://' + path.resolve(__dirname, '../web/index.html'), { waitUntil: 'load' });
  await page.waitForTimeout(3200);

  console.log('初始:', JSON.stringify(await page.evaluate(() => ({
    total: window.COFFEE_DATA.length,
    withHours: window.COFFEE_DATA.filter((s) => s.hours).length,
    withTags: window.COFFEE_DATA.filter((s) => (s.tags || []).length).length,
    labels: window.__layer.getLabelCount(),
  }))));

  /* ① 定位到柠溪（真实流程：默认 1km + 自动开标签） */
  await page.evaluate(() => {
    window.__setMe(113.5560, 22.2660, 45);
    window.__map.setZoomAndCenter(15.2, [113.5560, 22.2660], false, 0);
  });
  await page.waitForTimeout(1500);
  console.log('定位 1km:', JSON.stringify(await page.evaluate(() => ({
    z: +window.__map.getZoom().toFixed(1),
    labels: window.__layer.getLabelCount(),
    shown: document.querySelector('#c-total').textContent,
    btn: document.querySelector('#btn-label').className,
  }))));
  await page.screenshot({ path: shot('label-1km.png') });

  /* ② 点标签开卡片 */
  const tgt = await page.evaluate(() => {
    for (let y = 100; y < 800; y += 7) for (let x = 380; x < 1200; x += 7) {
      const it = window.__layer.hitTest(x, y);
      if (it && it.box) return { x: x + 7, y: y + 7, name: it.s.name };
    }
    return null;
  });
  console.log('标签命中:', JSON.stringify(tgt));
  if (tgt) {
    await page.mouse.move(tgt.x, tgt.y);
    await page.waitForTimeout(450);
    await page.screenshot({ path: shot('label-hover.png') });
    await page.mouse.click(tgt.x, tgt.y);
    await page.waitForTimeout(900);
    console.log('卡片:', JSON.stringify(await page.evaluate(() => {
      const c = document.querySelector('.amap-info-contentContainer .card');
      return c ? { t: c.querySelector('h3').textContent, hrs: c.querySelector('.hrs')?.textContent || '' } : null;
    })));
    await page.screenshot({ path: shot('label-card.png') });
    await page.keyboard.press('Escape');
  }

  /* ③ 街区级 z=17 */
  await page.evaluate(() => window.__map.setZoom(17, false, 0));
  await page.waitForTimeout(1400);
  console.log('z=17 标签:', await page.evaluate(() => window.__layer.getLabelCount()));
  await page.screenshot({ path: shot('label-z17.png') });

  /* ④ 未定位 + 全部范围 + z=14（最坏密度） */
  await page.evaluate(() => {
    window.__map.setZoomAndCenter(14, [113.5680, 22.2830], false, 0);
  });
  await page.waitForTimeout(1400);
  const dense = await page.evaluate(() => {
    const t = [];
    for (let i = 0; i < 40; i++) { const a = performance.now(); window.__layer.draw(); t.push(performance.now() - a); }
    t.sort((x, y) => x - y);
    return { labels: window.__layer.getLabelCount(),
      avg: +(t.reduce((s, v) => s + v, 0) / t.length).toFixed(2),
      p95: +t[Math.floor(t.length * 0.95)].toFixed(2) };
  });
  console.log('z=14 全量:', JSON.stringify(dense));
  await page.screenshot({ path: shot('label-z14.png') });

  /* ⑤ 关标签 */
  await page.click('#btn-label');
  await page.waitForTimeout(700);
  console.log('关闭后:', JSON.stringify(await page.evaluate(() => ({
    n: window.__layer.getLabelCount(),
    btn: document.querySelector('#btn-label').className,
  }))));
  await page.screenshot({ path: shot('label-off.png') });

  console.log('控制台错误:', errs.length ? errs.slice(0, 6) : '无');
  await browser.close();
})();
