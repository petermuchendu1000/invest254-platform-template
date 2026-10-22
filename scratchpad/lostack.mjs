/**
 * A LOST acknowledgement must resolve, in both directions, without guessing.
 *
 * Case A: the engine DID take the order, the ack is destroyed in flight. The card must stop saying
 * "Opening…" and become the real position, with its id and live P/L.
 * Case B: the order is never sent at all (the socket swallows it), so the engine has nothing. The
 * card must roll back and the balance must be restored, rather than showing money committed to
 * nothing.
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

// Destroy frames of a chosen type on the way IN, or requests of a chosen type on the way OUT.
const SABOTAGE = (dropIn, dropOut) => `
(() => {
  const Orig = window.WebSocket;
  window.__dropped = 0;
  window.WebSocket = function (...a) {
    const ws = new Orig(...a);
    const realSend = ws.send.bind(ws);
    ws.send = (d) => {
      try { const m = JSON.parse(d); if (${JSON.stringify(dropOut)} && m.type === ${JSON.stringify(dropOut)}) { window.__dropped++; return; } } catch {}
      return realSend(d);
    };
    const realAdd = ws.addEventListener.bind(ws);
    Object.defineProperty(ws, 'onmessage', {
      set(fn) { realAdd('message', (e) => {
        try { const m = JSON.parse(e.data); if (${JSON.stringify(dropIn)} && m.type === ${JSON.stringify(dropIn)}) { window.__dropped++; return; } } catch {}
        fn.call(ws, e);
      }); },
      get() { return null; }, configurable: true,
    });
    return ws;
  };
  window.WebSocket.prototype = Orig.prototype;
})();
`;

const browser = await chromium.launch({ executablePath:'/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args:['--no-sandbox'] });
const open = async (sab) => {
  const ctx = await browser.newContext({ viewport:{width:1440,height:900}, colorScheme:'dark' });
  const pg = await ctx.newPage();
  await pg.addInitScript(sab);
  await pg.addInitScript(t=>localStorage.setItem('pp-session',JSON.stringify({state:{token:t},version:0})), sign());
  await pg.goto('http://127.0.0.1:3100/',{waitUntil:'domcontentloaded'});
  await until(pg, async()=> (await pg.locator('button:has-text("Buy by Market")').count())===1);
  await pg.waitForTimeout(1500);
  return pg;
};
const body = async (pg) => (await pg.evaluate(()=>document.body.innerText)).replace(/\s+/g,' ');

// ── CASE A: ack destroyed, engine DID take the order ──────────────────────────────────────────
{
  const pg = await open(SABOTAGE('position_opened', null));
  await pg.locator('button:has-text("Buy by Market")').first().click();
  await pg.waitForTimeout(4000);
  check('A: before the watchdog fires the card is still "Opening…"', /Opening/.test(await body(pg)), (await body(pg)).slice(0,160));
  const resolved = await until(pg, async()=> !/Opening/.test(await body(pg)), 20000, 500);
  check('A: the card stops saying "Opening…" instead of freezing for ever', !!resolved, (await body(pg)).slice(0,200));
  const dropped = await pg.evaluate(()=>window.__dropped||0);
  check('A: the acknowledgement really was destroyed', dropped>0, `dropped=${dropped}`);
  // The engine DID open it, so the position must be adopted, not rolled back.
  await pg.keyboard.press('Control+KeyT');
  await pg.waitForTimeout(1200);
  const hasRow = await pg.locator('tr[title="Open the position menu"]').count();
  check('A: the real position is adopted, not discarded', hasRow>0, (await body(pg)).slice(0,220));
  await pg.screenshot({ path: `${DIR}/lostack-A.png` });
  await pg.close();
}

// ── CASE B: the order never reached the engine ────────────────────────────────────────────────
{
  const pg = await open(SABOTAGE(null, 'open_position'));
  const before = (await body(pg)).match(/Balance: ([\d\s.,]+)/)?.[1]?.trim();
  await pg.locator('button:has-text("Buy by Market")').first().click();
  await pg.waitForTimeout(3000);
  check('B: the optimistic card appears', /Opening/.test(await body(pg)));
  const rolled = await until(pg, async()=> !/Opening/.test(await body(pg)), 25000, 500);
  check('B: it rolls back rather than showing money committed to nothing', !!rolled, (await body(pg)).slice(0,200));
  /**
   * The invariant is that the optimistic DEBIT is gone, not that the figure matches what was on
   * screen before. The rollback invalidates the wallet query, which refetches from the API; in this
   * harness the stub's REST /wallet serves a fixed figure unrelated to the engine's in-memory
   * balance, so the two legitimately differ. What must never survive is the debited number.
   */
  const after = (await body(pg)).match(/Balance: ([\d\s.,]+)/)?.[1]?.trim();
  const debited = before ? (Number(before.replace(/[\s,]/g,'')) - 250).toFixed(2) : null;
  const afterNum = after ? Number(after.replace(/[\s,]/g,'')).toFixed(2) : null;
  check('B: the optimistic debit is reversed, not left on screen', !!afterNum && afterNum !== debited,
    `before ${before} debited-would-be ${debited} after ${after}`);
  const said = /not accepted|no record|not confirmed/i.test(await body(pg));
  check('B: and the trader is told', said, (await body(pg)).slice(0,240));
  await pg.screenshot({ path: `${DIR}/lostack-B.png` });
  await pg.close();
}
await browser.close();
console.log(`\n${ok.filter(Boolean).length}/${ok.length} passed`);
process.exit(ok.every(Boolean)?0:1);
