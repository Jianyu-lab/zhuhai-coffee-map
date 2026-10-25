const { chromium } = require('playwright-core');
const path = require('path');

(async () => {
  const exe = process.env.CHROME_PATH;
  const browser = await chromium.launch({
    executablePath: exe,
    args: ['--allow-file-access-from-files'],
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errs = [];
  page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
  page.on('pageerror', (e) => errs.push('PAGEERROR ' + e.message));

  const url = 'file://' + path.resolve(__dirname, '../web/index.html');
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForTimeout(3500);

  const info = await page.evaluate(() => ({
    total: (window.COFFEE_DATA || []).length,
    shown: document.querySelector('#c-total')?.textContent,
    raw: document.querySelector('#c-raw')?.textContent,
    zoom: window.__map ? window.__map.getZoom() : null,
  }));
  console.log('数据量:', JSON.stringify(info));

  // 搜 Seadome
  await page.fill('#q', 'seadome');
  await page.waitForTimeout(1200);
  const hit = await page.evaluate(() => {
    const t = document.querySelector('#c-total')?.textContent;
    return { total: t };
  });
  console.log('搜索 seadome 后:', JSON.stringify(hit));
  await page.screenshot({ path: path.resolve(__dirname, '../shots/verify-seadome.png') });

  // 清空搜索，飞到柠溪放大
  await page.fill('#q', '');
  await page.waitForTimeout(600);
  await page.evaluate(() => {
    window.__map.setZoomAndCenter(16.4, [113.556, 22.266]);
  });
  await page.waitForTimeout(1800);
  await page.screenshot({ path: path.resolve(__dirname, '../shots/verify-zoom.png') });

  console.log('控制台错误:', errs.length ? errs.slice(0, 5) : '无');
  await browser.close();
})();
