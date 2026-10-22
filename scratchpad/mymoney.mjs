/**
 * Two money-path fixes, read back from the running app.
 *   A. Opening a position must not move the Balance (MetaTrader: Balance excludes open positions).
 *   B. Modify position must be able to modify the STOP, not only the target.
 */
import pkg from '/home/user/invest254/node_modules/playwright-core/index.js';
import { createHmac } from 'node:crypto';
const { chromium } = pkg;
const DIR = '/tmp/claude-0/-home-user/452c9309-f7cb-51b6-8e0c-13816b147fab/scratchpad';
const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const RUN = Date.now().toString(16).padStart(12,'0').slice(-12);
let uid = 0;
const sign = () => { const s=`e${String(++uid).padStart(7,'0')}-0000-0000-0000-${RUN}`; const h=b64u({alg:'HS256',typ:'JWT'}); const p=b64u({sub:s,iat:(Date.now()/1000|0),exp:(Date.now()/1000|0)+3600,role:'player',site:'00000000-0000-0000-0000-000000000001'}); return `${h}.${p}.${createHmac('sha256','harness-secret-0001').update(`${h}.${p}`).digest('base64url')}`; };
const until = async (pg,fn,ms=60000,step=400)=>{const t0=Date.now();for(;;){const v=await fn();if(v)return v;if(Date.now()-t0>ms)return v;await pg.waitForTimeout(step);}};
const ok=[]; const check=(n,v,i='')=>{ok.push(v);console.log(`[${v?'PASS':'FAIL'}] ${n}${v||!i?'':'  -- '+i}`);};
const body = async (pg) => (await pg.evaluate(()=>document.body.innerText)).replace(/\s+/g,' ');

const browser = await chromium.launch({ executablePath:'/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args:['--no-sandbox'] });
const open = async () => {
  const ctx = await browser.newContext({ viewport:{width:1440,height:900}, colorScheme:'dark' });
  const pg = await ctx.newPage();
  await pg.addInitScript(t=>localStorage.setItem('pp-session',JSON.stringify({state:{token:t},version:0})), sign());
  await pg.goto('http://127.0.0.1:3100/',{waitUntil:'domcontentloaded'});
  await until(pg, async()=> (await pg.locator('button:has-text("Buy by Market")').count())===1);
  await pg.waitForTimeout(1500);
  return pg;
};
const strip = (t) => ({
  balance: t.match(/Balance:\s*([\d\s.,]+)/)?.[1]?.trim(),
  equity: t.match(/Equity:\s*([-\d\s.,]+)/)?.[1]?.trim(),
  // The collapsed strip prints "Margin Level:", not "Margin:", so read the level: it is
  // Equity/Margin x 100 and exists only when margin is in use, which is the thing being asserted.
  marginLevel: t.match(/Margin Level:\s*([-\d\s.,%]+)/)?.[1]?.trim(),
});

// ── A. Balance must not move on opening ───────────────────────────────────────────────────────
{
  const pg = await open();
  const before = strip(await body(pg));
  await pg.locator('button:has-text("Buy by Market")').first().click();
  await until(pg, async()=> !/Opening/.test(await body(pg)), 20000, 400);
  await pg.waitForTimeout(2000);
  const after = strip(await body(pg));
  console.log(`   before ${JSON.stringify(before)}`);
  console.log(`   after  ${JSON.stringify(after)}`);
  check('A: Balance is unchanged by opening a position', before.balance === after.balance, `${before.balance} -> ${after.balance}`);
  check('A: the stake is in Margin, so a margin level exists where there was none',
    !!after.marginLevel && !/^-/.test(after.marginLevel) && before.marginLevel !== after.marginLevel,
    `margin level ${before.marginLevel} -> ${after.marginLevel}`);
  await pg.screenshot({ path: `${DIR}/money-balance.png` });
  await pg.close();
}

// ── B. Modify position can modify the STOP ────────────────────────────────────────────────────
{
  const pg = await open();
  await pg.locator('button:has-text("Buy by Market")').first().click();
  await until(pg, async()=> !/Opening/.test(await body(pg)), 20000, 400);
  await pg.waitForTimeout(1200);
  await pg.keyboard.press('Control+KeyT');
  await until(pg, async()=> (await pg.locator('tr[title="Open the position menu"]').count())>0, 20000, 300);
  await pg.locator('tr[title="Open the position menu"]').first().click();
  await pg.waitForTimeout(600);
  await pg.locator('button:has-text("Modify position")').first().click();
  await until(pg, async()=> (await pg.locator('[role="dialog"][aria-label="Modify position"]').count())===1, 15000, 300);
  await pg.waitForTimeout(500);

  const slStepper = await pg.locator('[role="dialog"] button[aria-label="Lower Stop Loss"]').count();
  check('B: the Stop Loss row HAS a stepper (it was a read-only span)', slStepper > 0);
  const pointsStepper = await pg.locator('[role="dialog"] button[aria-label*="by ten points"]').count();
  check('B: and MetaTrader’s second spinner, the distance in points', pointsStepper >= 4, `found ${pointsStepper}`);

  const readSl = async () => (await pg.evaluate(() => {
    const d = document.querySelector('[role="dialog"]'); const m = (d?.textContent||'').replace(/\s+/g,' ').match(/Stop Loss\s*−?\s*([\d.]+|not set)/);
    return m ? m[1] : null;
  }));
  const sl0 = await readSl();
  await pg.locator('[role="dialog"] button[aria-label="Lower Stop Loss"]').first().click();
  await pg.waitForTimeout(700);
  const sl1 = await readSl();
  check('B: pressing it actually SETS the stop', sl0 !== sl1 && sl1 !== 'not set', `${sl0} -> ${sl1}`);
  // It must land on the correct side for a BUY: a stop above the entry is not a stop.
  const t = (await pg.evaluate(()=>document.querySelector('[role="dialog"]')?.textContent||'')).replace(/\s+/g,' ');
  const openP = Number(t.match(/buy [\d.]+ \w+ at ([\d.]+)/)?.[1]);
  check('B: and on the LOSING side of a buy, which is what makes it a stop',
    !!openP && Number(sl1) < openP, `stop ${sl1} vs open ${openP}`);
  check('B: the points row shows the distance', /points/.test(t), t.slice(0, 200));
  await pg.screenshot({ path: `${DIR}/money-modify.png` });
  await pg.close();
}
await browser.close();
console.log(`\n${ok.filter(Boolean).length}/${ok.length} passed`);
process.exit(ok.every(Boolean)?0:1);
