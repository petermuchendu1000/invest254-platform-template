/** The sync_positions request: does it answer, and does it tell the truth in both directions? */
import { createHmac } from 'node:crypto';
const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const RUN = Date.now().toString(16).padStart(12,'0').slice(-12);
const sign = (n) => { const s=`e${String(n).padStart(7,'0')}-0000-0000-0000-${RUN}`; const h=b64u({alg:'HS256',typ:'JWT'}); const p=b64u({sub:s,iat:(Date.now()/1000|0),exp:(Date.now()/1000|0)+3600,role:'player',site:'00000000-0000-0000-0000-000000000001'}); return `${h}.${p}.${createHmac('sha256','harness-secret-0001').update(`${h}.${p}`).digest('base64url')}`; };
const ok = []; const check=(n,v,i='')=>{ok.push(v);console.log(`[${v?'PASS':'FAIL'}] ${n}${v||!i?'':'  -- '+i}`);};

const session = (n, script) => new Promise((resolve) => {
  const ws = new WebSocket('ws://127.0.0.1:8787');
  const got = [];
  let done=false; const finish=()=>{ if(!done){done=true; try{ws.close();}catch{} resolve(got);} };
  ws.onopen = () => ws.send(JSON.stringify({ type:'auth', data:{ token: sign(n) } }));
  ws.onmessage = (e) => { let m; try{m=JSON.parse(e.data);}catch{return;} got.push(m); script(ws, m, finish); };
  ws.onerror = finish;
  setTimeout(finish, 15000);
});

// 1. No position yet: sync must answer with an EMPTY list, not silence.
{
  let asked=false;
  const got = await session(1, (ws,m,fin)=>{
    if (m.type==='balance' && !asked) { asked=true; ws.send(JSON.stringify({type:'sync_positions',data:{}})); }
    else if (m.type==='open_positions' && asked) fin();
  });
  const frames = got.filter(f=>f.type==='open_positions');
  check('sync_positions answers when nothing is open', frames.length>0, JSON.stringify(got.map(g=>g.type)));
  check('and the list is empty, which is the "order was not taken" answer',
    frames.length>0 && (frames[frames.length-1].data?.positions?.length ?? -1) === 0,
    JSON.stringify(frames[frames.length-1]?.data));
}

// 2. With a position open: sync must report it, with its levels.
{
  let opened=false, asked=false, posId=null;
  const got = await session(2, (ws,m,fin)=>{
    if (m.type==='balance' && !opened) { opened=true;
      ws.send(JSON.stringify({type:'open_position',data:{direction:'buy',stakeCents:25000,durationS:900,slPrice:3000.5,tpPrice:3100.25}})); }
    else if (m.type==='position_opened') { posId=m.data.positionId; asked=true; ws.send(JSON.stringify({type:'sync_positions',data:{}})); }
    else if (m.type==='open_positions' && asked) fin();
  });
  const last = got.filter(f=>f.type==='open_positions').pop();
  const p = last?.data?.positions?.[0];
  check('sync_positions reports an open position', !!p, JSON.stringify(last?.data));
  check('and it is the SAME position the ack named', !!p && p.positionId===posId, `${p?.positionId} vs ${posId}`);
  check('and it carries the engine-held levels', !!p && p.slPrice===3000.5 && p.tpPrice===3100.25, JSON.stringify({sl:p?.slPrice,tp:p?.tpPrice}));
  check('and the fields the client needs to adopt it', !!p && typeof p.entryRate==='number' && typeof p.expiresAtMs==='number' && typeof p.sellable==='boolean', JSON.stringify(p));
}

// 3. Unauthenticated sync must be refused, not answered.
{
  const got = await new Promise((resolve)=>{
    const ws = new WebSocket('ws://127.0.0.1:8787'); const g=[];
    let done=false; const fin=()=>{if(!done){done=true;try{ws.close();}catch{}resolve(g);}};
    ws.onopen = () => ws.send(JSON.stringify({type:'sync_positions',data:{}}));
    ws.onmessage = (e)=>{ let m; try{m=JSON.parse(e.data);}catch{return;} g.push(m); if(m.type==='error'||m.type==='open_positions') fin(); };
    setTimeout(fin, 8000);
  });
  const err = got.find(f=>f.type==='error');
  const leaked = got.find(f=>f.type==='open_positions');
  check('an unauthenticated sync is refused', !!err && err.data?.code==='AUTH_REQUIRED', JSON.stringify(got.map(g=>g.type)));
  check('and leaks no position list', !leaked);
}
console.log(`\n${ok.filter(Boolean).length}/${ok.length} passed`);
process.exit(ok.every(Boolean)?0:1);
