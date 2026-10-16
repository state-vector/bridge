export const UI_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Bridge</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
:root{--bg:#0d1117;--fg:#c9d1d9;--dim:#8b949e;--card:#161b22;--line:#30363d;
--green:#3fb950;--red:#f85149;--amber:#d29922;--blue:#58a6ff;--purple:#bc8cff}
*{box-sizing:border-box;margin:0}body{background:var(--bg);color:var(--fg);
font:14px/1.5 -apple-system,'Segoe UI',Roboto,sans-serif;padding:16px;max-width:1100px;margin:0 auto}
header{display:flex;align-items:baseline;gap:12px;margin-bottom:14px}
h1{font-size:17px}.dot{width:8px;height:8px;border-radius:50%;background:var(--green);
display:inline-block;margin-right:5px}.dot.down{background:var(--red)}
#live{font-size:12px;color:var(--dim)}
h2{font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:var(--dim);margin:18px 0 6px}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:20px}
@media(max-width:800px){.grid{grid-template-columns:1fr}}
.card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:9px 12px;margin-bottom:8px}
.card .t{font-weight:600}.card .r{color:var(--dim);font-size:12px;margin-top:2px;white-space:pre-wrap}
.muted{color:var(--dim);font-size:12px}
.badge{font-size:10px;padding:0 6px;border-radius:4px;border:1px solid var(--line);margin-left:6px}
.badge.needs_input{color:var(--amber);border-color:var(--amber)}
.badge.diagnostic{color:var(--red);border-color:var(--red)}
.pres{display:flex;gap:10px;flex-wrap:wrap}
.chip{display:flex;gap:6px;align-items:center;background:var(--card);border:1px solid var(--line);
border-radius:20px;padding:3px 12px;font-size:12px}
.chip .st{width:7px;height:7px;border-radius:50%}
.chip.active .st{background:var(--green)}.chip.idle .st{background:var(--dim)}
.chip .k{color:var(--dim)}
.ev{display:flex;gap:10px;padding:3px 8px;border-radius:5px;font-size:13px}
.ev:hover{background:var(--card)}
.ev .k{width:100px;flex:none;font-size:11px}
.ev .a{margin-left:auto;color:var(--dim);font-size:11px;flex:none}
.k.created,.k.claimed,.k.spawned{color:var(--blue)}
.k.completed,.k.unblocked{color:var(--green)}
.k.blocked,.k.changes_requested{color:var(--amber)}
.k.crashed,.k.gave_up,.k.timed_out{color:var(--red)}
.k.commented,.k.attached,.k.status,.k.archived{color:var(--dim)}
footer{color:var(--dim);font-size:11px;margin-top:24px}
</style></head><body>
<header><span id="live"><span class="dot"></span>LIVE</span><h1>bridge</h1>
<span style="margin-left:auto" class="muted" id="clock"></span></header>
<h2>Decisions needed</h2><div id="decisions"></div>
<div class="grid">
<div><h2>Who is active</h2><div class="pres" id="presence"></div></div>
<div><h2>Activity</h2><div id="feed"></div></div>
</div>
<footer>bridge · one door for agent + human work</footer>
<script>
function esc(s){const d=document.createElement('div');d.textContent=s==null?'':String(s);return d.innerHTML}
function ago(ts){const s=(Date.now()-ts)/1000;if(s<90)return Math.floor(s)+'s';if(s<7200)return Math.floor(s/60)+'m';
if(s<172800)return (s/3600).toFixed(1)+'h';return (s/86400).toFixed(1)+'d'}
let lastDecisions=[],lastPresence=[],lastEvents=[];
function renderDecisions(ds){lastDecisions=ds;const el=document.getElementById('decisions');
if(!ds.length){el.innerHTML='<div class="muted">nothing waiting on a human ✓</div>';return}
el.innerHTML=ds.map(d=>'<div class="card"><div class="t">'+esc(d.title)+
'<span class="badge '+esc(d.kind||'diagnostic')+'">'+esc(d.kind||'diagnostic')+'</span></div>'+
(d.reason?'<div class="r">'+esc(d.reason)+'</div>':'')+
'<div class="muted">opened '+ago(d.opened_ts)+' ago · '+esc(d.board||d.task_id||'')+'</div></div>').join('')}
function renderPresence(ps){lastPresence=ps;const el=document.getElementById('presence');
if(!ps.length){el.innerHTML='<div class="muted">no signals yet</div>';return}
el.innerHTML=ps.map(a=>'<div class="chip '+(a.active?'active':'idle')+'"><span class="st"></span>'+
esc(a.label||a.id)+'<span class="k">'+esc(a.kind)+' · '+ago(a.last_ts)+'</span></div>').join('')}
function renderFeed(evs){const el=document.getElementById('feed');
el.innerHTML=evs.slice(0,200).map(e=>'<div class="ev"><span class="k '+esc(e.kind)+'">'+esc(e.kind)+'</span>'+
'<span>'+esc(e.title||e.task_id||'')+'</span>'+
(e.actor?'<span class="muted">'+esc(e.actor)+'</span>':'')+
'<span class="a">'+ago(e.ts)+'</span></div>').join('')}
function apply(state){renderDecisions(state.decisions);renderPresence(state.presence);renderFeed(lastEvents=state.events)}
setInterval(()=>{document.getElementById('clock').textContent=
new Date().toLocaleTimeString('en-AU',{timeZone:'Australia/Brisbane'})+' AEST'},1000);
const wsProto=location.protocol==='https:'?'wss':'ws';
let retry=0;
function connect(){const ws=new WebSocket(wsProto+'://'+location.host+'/ws');
ws.onmessage=m=>{const msg=JSON.parse(m.data);
if(msg.type==='snapshot')apply(msg.state);
else if(msg.type==='event')renderFeed(lastEvents=[msg.event,...lastEvents].slice(0,200));
else if(msg.type==='decisions')renderDecisions(msg.decisions);
else if(msg.type==='presence')renderPresence(msg.presence);
document.querySelector('#live .dot').classList.remove('down');
document.querySelector('#live').lastChild.textContent='LIVE'};
ws.onopen=()=>{retry=0};
ws.onclose=async(e)=>{if(e.code===4001){document.getElementById('live').innerHTML='SESSION EXPIRED — <a href="/login">login</a>';return}
document.querySelector('#live .dot').classList.add('down');
document.querySelector('#live').lastChild.textContent='RECONNECTING';
setTimeout(connect,Math.min(15000,1000*Math.pow(2,retry++)))}}
connect();
</script></body></html>`;
