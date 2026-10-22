import pkg from '/home/user/invest254/node_modules/playwright-core/index.js';
import { createHmac } from 'node:crypto';
const { chromium } = pkg;
const DIR = '/tmp/claude-0/-home-user/452c9309-f7cb-51b6-8e0c-13816b147fab/scratchpad';
const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const RUN = Date.now().toString(16).padStart(12,'0').slice(-12);
let uid = 0;
const sign = () => { const s=`e${String(++uid).padStart(7,'0')}-0000-0000-0000-${RUN}`; const h=b64u({alg:'HS256',typ:'JWT'}); const p=b64u({sub:s,iat:(Date.now()/1000|0),exp:(Date.now()/1000|0)+3600,role:'player',site:'00000000-0000-0000-0000-000000000001'}); return `${h}.${p}.${createHmac('sha256','harness-secret-0001').update(`${h}.${p}`).digest('base64url')}`; };
const until = async (pg,fn,ms=60000,step=400)=>{const t0=Date.now();for(;;){const v=await fn();if(v)return v;if(Date.now()-t0>ms)return v;await pg.waitForTimeout(step);}};
const browser = await chromium.launch({ executablePath:'/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args:['--no-sandbox'] });
const open = async () => {
  const ctx = await browser.newContext({ viewport:{width:1440,height:900}, colorScheme:'dark' });
  const pg = await ctx.newPage();
  await pg.addInitScript(t=>localStorage.setItem('pp-session',JSON.stringify({state:{token:t},version:0})), sign());
  await pg.goto('http://127.0.0.1:3100/',{waitUntil:'domcontentloaded'});
  await until(pg, async()=> (await pg.locator('button:has-text("Sell by Market")').count())===1);
  await pg.waitForTimeout(1500);
  await pg.locator('button:has-text("Buy by Market")').first().click();
  await pg.waitForTimeout(1500);
  // The position menu lives in the Toolbox grid, which is closed by default.
  await pg.keyboard.press('Control+KeyT');
  // Desktop opens the menu by clicking the Toolbox ROW (title="Open the position menu");
  // the aria-labelled button is the sm:hidden phone row.
  await until(pg, async()=> (await pg.locator('tr[title="Open the position menu"]').count())>0, 25000, 250);
  return pg;
};

// CLAIM 1: the position menu and what it offers.
{
  const pg = await open();
  await pg.locator('tr[title="Open the position menu"]').first().click();
  await pg.waitForTimeout(800);
  const items = await pg.evaluate(() => [...document.querySelectorAll('button,[role="menuitem"]')]
    .map(e=>(e.textContent||'').replace(/\s+/g,' ').trim()).filter(t=>t && t.length<40));
  console.log('CLAIM 1 menu items:', JSON.stringify(items.slice(0,14)));
  const hasModify = items.some(t=>/Modify position/i.test(t));
  console.log(`CLAIM 1 RESULT: Modify position in the desktop position menu = ${hasModify}`);
  if (hasModify) {
    await pg.locator('button:has-text("Modify position")').first().click();
    await pg.waitForTimeout(1000);
    const sl = await pg.evaluate(() => {
      const d = document.querySelector('[role="dialog"]'); if (!d) return null;
      return { title: (d.getAttribute('aria-label')||''), hasStopLoss: /Stop Loss/i.test(d.textContent||''),
               steppers: d.querySelectorAll('button[aria-label*="Stop Loss" i]').length };
    });
    console.log('   modify dialog:', JSON.stringify(sl));
    await pg.screenshot({ path: `${DIR}/gap3-modify-open.png` });
  }
  await pg.close();
}

// CLAIM 2: the close action's wording on a LOSING position.
{
  const pg = await open();
  await until(pg, async()=> /KES\s*-\d/.test(await pg.evaluate(()=>document.body.innerText)), 90000, 1000);
  await pg.locator('tr[title="Open the position menu"]').first().click();
  await pg.waitForTimeout(700);
  await pg.locator('button:has-text("Close position")').first().click();
  await pg.waitForTimeout(1200);
  const btn = await pg.evaluate(() => {
    const el=[...document.querySelectorAll('button')].find(b=>/CLOSE WITH/i.test(b.textContent||''));
    return el?{txt:(el.textContent||'').replace(/\s+/g,' ').trim(),disabled:el.disabled}:null;
  });
  const slRow = await pg.evaluate(() => {
    const d=document.querySelector('[role="dialog"]'); if(!d) return null;
    const m=(d.textContent||'').replace(/\s+/g,' ').match(/S \/ L[^A-Z]{0,40}/); return m?m[0]:null;
  });
  console.log('CLAIM 2 close action:', JSON.stringify(btn));
  console.log('CLAIM 2 S/L row in the close dialog:', JSON.stringify(slRow));
  await pg.screenshot({ path: `${DIR}/gap9-losing-close.png` });
  await pg.close();
}
await browser.close();
