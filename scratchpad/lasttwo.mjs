/** The two items the agents each left to the other: Toolbox grid alignment, and Heikin Ashi. */
import pkg from '/home/user/invest254/node_modules/playwright-core/index.js';
import { createHmac } from 'node:crypto';
const { chromium } = pkg;
const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const RUN = Date.now().toString(16).padStart(12,'0').slice(-12);
let uid = 0;
const sign = () => { const s=`e${String(++uid).padStart(7,'0')}-0000-0000-0000-${RUN}`; const h=b64u({alg:'HS256',typ:'JWT'}); const p=b64u({sub:s,iat:(Date.now()/1000|0),exp:(Date.now()/1000|0)+3600,role:'player',site:'00000000-0000-0000-0000-000000000001'}); return `${h}.${p}.${createHmac('sha256','harness-secret-0001').update(`${h}.${p}`).digest('base64url')}`; };
const until = async (pg,fn,ms=60000,step=400)=>{const t0=Date.now();for(;;){const v=await fn();if(v)return v;if(Date.now()-t0>ms)return v;await pg.waitForTimeout(step);}};
const ok=[]; const check=(n,v,i='')=>{ok.push(v);console.log(`[${v?'PASS':'FAIL'}] ${n}${v||!i?'':'  -- '+i}`);};

const browser = await chromium.launch({ executablePath:'/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args:['--no-sandbox'] });
const open = async (w,h,mobile=false) => {
  const ctx = await browser.newContext({ viewport:{width:w,height:h}, colorScheme:'dark', ...(mobile?{isMobile:true,hasTouch:true}:{}) });
  const pg = await ctx.newPage();
  await pg.addInitScript(t=>localStorage.setItem('pp-session',JSON.stringify({state:{token:t},version:0})), sign());
  await pg.goto('http://127.0.0.1:3100/',{waitUntil:'domcontentloaded'});
  await until(pg, async()=> (await pg.evaluate(()=>document.body.innerText)).length>400, 60000);
  await pg.waitForTimeout(2500);
  return pg;
};

// ── Toolbox grid alignment, with a position open so the ten-column grid renders ───────────────
{
  const pg = await open(1440, 900);
  await pg.locator('button:has-text("Buy by Market")').first().click();
  await until(pg, async()=> !/Opening/.test(await pg.evaluate(()=>document.body.innerText)), 20000, 400);
  await pg.waitForTimeout(1200);
  // The Toolbox panel is closed by default, and the grid lives inside it.
  await pg.keyboard.press('Control+KeyT');
  await until(pg, async()=> (await pg.locator('th').count())>0, 20000, 300);
  await pg.waitForTimeout(800);
  const align = await pg.evaluate(() => {
    const th = [...document.querySelectorAll('th')].filter((e) => e.offsetParent !== null);
    return th.map((e) => `${(e.textContent||'').trim()}=${getComputedStyle(e).textAlign}`);
  });
  console.log('   headers:', align.join(' | '));
  const first = align[0] ?? '';
  const rest = align.slice(1);
  check('Toolbox: Symbol header is left-aligned', /^Symbol=left$/.test(first), first);
  check('Toolbox: every header from Ticket rightwards is right-aligned',
    rest.length > 0 && rest.every((a) => a.endsWith('=right')), rest.join(' | '));
  const cells = await pg.evaluate(() => {
    const tr = [...document.querySelectorAll('tbody tr')].find((r) => r.offsetParent !== null);
    return tr ? [...tr.querySelectorAll('td')].map((e) => `${(e.textContent||'').trim().slice(0,10)}=${getComputedStyle(e).textAlign}`) : [];
  });
  console.log('   cells  :', cells.join(' | '));
  check('Toolbox: the symbol CELL stays left, the figures go right',
    cells.length > 1 && cells[0].endsWith('=left') && cells.slice(1).every((c) => c.endsWith('=right')), cells.join(' | '));
  await pg.close();
}

// ── Heikin Ashi: off the desktop Tools menu, still on the phone ───────────────────────────────
{
  const pg = await open(1440, 900);
  await pg.locator('button:has-text("Tools")').first().click();
  await pg.waitForTimeout(800);
  const desktop = await pg.evaluate(() => {
    const hit = [...document.querySelectorAll('button')].map((b) => (b.textContent||'').trim());
    return hit.filter((t) => /Bar chart|Candlesticks|Line chart|Heikin/.test(t));
  });
  console.log('   desktop chart types:', JSON.stringify(desktop));
  check('desktop: MetaTrader’s three types only, no Heikin Ashi',
    desktop.includes('Bar chart') && desktop.includes('Candlesticks') && desktop.includes('Line chart') && !desktop.some((t)=>/Heikin/.test(t)),
    desktop.join(', '));
  await pg.close();
}
{
  const pg = await open(390, 844, true);
  // Open the phone chart's Indicators sheet, where its chart-type group lives.
  for (const sel of ['button:has-text("Charts")', '[aria-label*="Indicators" i]', 'button:has-text("Indicators")']) {
    if (await pg.locator(sel).count()) { await pg.locator(sel).first().click().catch(()=>{}); await pg.waitForTimeout(900); }
  }
  const phone = await pg.evaluate(() => [...document.querySelectorAll('button')].map((b)=>(b.textContent||'').trim()).filter((t)=>/Bar chart|Candlesticks|Line chart|Heikin/.test(t)));
  console.log('   phone chart types:', JSON.stringify(phone));
  check('phone: Heikin Ashi is still offered, which is where MetaTrader has it',
    phone.some((t)=>/Heikin/.test(t)), phone.join(', '));
  await pg.close();
}
await browser.close();
console.log(`\n${ok.filter(Boolean).length}/${ok.length} passed`);
