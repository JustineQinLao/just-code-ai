// The phone page (HTML, CSS and script), served from / by phone.ts.
export const PAGE = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>JustCode</title><style>
:root{--bg:#f7f8fa;--panel:#eceef3;--card:#fff;--line:#dde0e7;--fg:#1d2129;--muted:#5d6574;--accent:#3550c8;--accent-fg:#fff;--todo:#6b7280;--work:#1c74c9;--needs:#a8690f;--review:#6c45d9;--done:#28805a;--err:#c93434;--warnbg:#fbf3e4;color-scheme:light}
@media(prefers-color-scheme:dark){:root{--bg:#14161b;--panel:#1a1d23;--card:#21252d;--line:#2c313b;--fg:#e6e8ec;--muted:#9299a6;--accent:#7d97ff;--accent-fg:#0a0e1c;--todo:#9097a3;--work:#5aa9ff;--needs:#f0b54a;--review:#b48cff;--done:#4ccf8f;--err:#ff6f6f;--warnbg:#2b2416;color-scheme:dark}}
*{box-sizing:border-box}body{font:14px/1.5 -apple-system,"Segoe UI",system-ui,sans-serif;margin:0;background:var(--bg);color:var(--fg)}
header{display:flex;align-items:center;gap:10px;padding:12px 14px;border-bottom:1px solid var(--line)}
header .br{font-weight:600;white-space:nowrap}header .br b{color:var(--accent)}
#pj{flex:1;min-width:0;text-align:right}#pj select{width:auto;max-width:100%;min-height:36px;margin:0;font-size:13px;background:transparent;color:var(--muted);border:0}
#top{position:sticky;top:0;z-index:5;background:var(--bg)}
.tabs{display:flex;gap:3px;background:var(--panel);padding:3px;border-radius:9px;margin:10px 12px;overflow-x:auto}
.tabs button{flex:1 0 auto;margin:0;min-height:40px;padding:6px 11px;white-space:nowrap;background:transparent;color:var(--muted);border:0;border-radius:7px}
.tabs button.on{background:var(--card);color:var(--fg);box-shadow:0 1px 2px #0002}
.tabs button.dot::after{content:"";display:inline-block;width:6px;height:6px;border-radius:50%;background:var(--needs);margin-left:6px;vertical-align:middle}
.c{margin:8px 12px;padding:10px 12px;background:var(--card);border:1px solid var(--line);border-left:3px solid var(--k,var(--todo));border-radius:9px}
.c h4{margin:0 0 4px;font-size:14px;font-weight:600;line-height:1.35}.s{color:var(--muted);font-size:12px}.c>.s:first-of-type{font-size:13px}
.acts{display:flex;flex-wrap:wrap;gap:6px;margin-top:6px}.acts button,.acts select{flex:1}
button,select{font:inherit;min-height:44px;padding:8px 14px;margin:6px 6px 0 0;border:1px solid var(--line);border-radius:8px;background:transparent;color:var(--fg)}
button.p{background:var(--accent);color:var(--accent-fg);border-color:transparent;font-weight:600}
button.n,select.n{background:transparent}
input{font:inherit;min-height:44px;padding:8px;width:calc(100% - 24px);margin:10px 12px;border:1px solid var(--line);border-radius:8px;background:var(--card);color:var(--fg)}
input[hidden]{display:none}
.c,.tabs{-webkit-user-select:none;user-select:none;-webkit-touch-callout:none}
.a{border:1px solid var(--needs);background:var(--warnbg);padding:8px;margin-top:6px;border-radius:8px;word-break:break-all}
.err{color:var(--err)}
@media(max-width:400px){body{font-size:14px}.c{margin:8px}}
.tabs[hidden]{display:none}
@media(min-width:900px){.cols{display:grid;grid-template-columns:repeat(5,1fr) 1.3fr;gap:8px;padding:0 10px;align-items:start}.col{min-width:0}.col .c{margin:8px 0}.pane{position:sticky;top:60px}.pane .c{margin:0}}
</style></head><body><div id="top"><header><span class="br"><b>◆</b> JustCode</span><div id="pj"></div></header>
<div id="tabs" class="tabs"></div></div><div id="ph" class="s" style="margin:6px 14px"></div>
<input id="t" placeholder="Token (from VS Code: JustCode: Show Phone Pairing)"><input id="n" placeholder="New task title">
<dialog id="dg" style="background:var(--card);color:var(--fg);border:1px solid var(--line);border-radius:8px;max-width:90vw"></dialog><button id="add" class="p" style="margin-left:12px">Add + run</button><div id="st" class="s" style="margin:0 12px"></div><div id="er" role="alert" style="margin:4px 12px;color:var(--err)"></div><div id="nt" class="s" style="margin:4px 12px"></div><div id="l"></div>
<script src="/status.js"></script><script>
const $=id=>document.getElementById(id);$('t').value=localStorage.tok||new URLSearchParams(location.search).get('token')||'';
const H=()=>({'x-token':$('t').value,'content-type':'application/json'});
async function act(m){const r=await fetch('/api/act',{method:'POST',headers:H(),body:JSON.stringify(m)});const j=await r.json();$('er').textContent=j.error||'';load()}
async function board(m){const r=await fetch('/api/board',{method:'POST',headers:H(),body:JSON.stringify(m)});const j=await r.json();if(j.error)alert(j.error);load()}
const LK=['needs','work','review','todo','done'],MV={work:'doing',review:'review',todo:'todo'},NM={needs:'Needs you',work:'Working',review:'Review',todo:'To do',done:'Done'},CL={needs:'needs',work:'work',review:'review',todo:'todo',done:'done'};
let dragging=false,redo=false,actTimer=0,actGen=0,busyIds=new Set();function hold(){return dragging||document.activeElement?.tagName==='SELECT'}function dragMove(c,t){let tm,on=false,sx,sy;const hl=x=>{for(const k of LK){const b=$('tab-'+k);if(b)b.style.outline=x===k?'2px solid var(--accent)':''}};
const at=e=>{const p=e.touches[0]||e.changedTouches[0],n=document.elementFromPoint(p.clientX,p.clientY),b=n&&n.closest('button[id^=tab-]');return b?b.id.slice(4):''};
c.addEventListener('touchstart',e=>{if(e.target.closest('select,button'))return;sx=e.touches[0].clientX;sy=e.touches[0].clientY;tm=setTimeout(()=>{on=true;dragging=true;c.style.opacity='.6';navigator.vibrate&&navigator.vibrate(30)},500)},{passive:true});
c.addEventListener('touchmove',e=>{if(!on){if(Math.abs(e.touches[0].clientX-sx)+Math.abs(e.touches[0].clientY-sy)>10)clearTimeout(tm);return}e.preventDefault();hl(at(e))},{passive:false});
const end=e=>{clearTimeout(tm);if(!on)return;on=false;dragging=false;c.style.opacity='';hl('');if(e.type==='touchend'){const k=at(e);const ns=MV[k];if(ns&&ns!==t.status)act({type:'move',id:t.id,status:ns});else if(redo)load()}redo=false};
c.addEventListener('touchend',end);c.addEventListener('touchcancel',end)}
let evN=0,shown=new Set();
function showDialog(m){if(shown.has(m.id))return;shown.add(m.id);const d=$('dg');let done=false;
const fin=x=>{if(done)return;done=true;board(Object.assign({type:'dialogReply',id:m.id},x));d.close()};
d.textContent='';d.append(el('b',{},m.title),el('p',{},m.text||''));
for(const b of m.buttons||['OK'])d.append(el('button',{onclick:()=>fin({button:b})},b));
d.append(el('button',{className:'n',onclick:()=>fin({cancelled:true})},'Cancel'));
d.onclose=()=>fin({cancelled:true});if(!d.open)d.showModal()}
async function poll(){try{const r=await fetch('/api/events?since='+evN,{headers:H()});if(r.ok){const j=await r.json();if(j.last<evN){evN=0;return poll()}evN=j.last;for(const e of j.events)if(e.type==='dialog')showDialog(e);else if(e.type==='toast')alert(e.text)}}catch(e){}}
function el(t,p,...k){const e=document.createElement(t);Object.assign(e,p);e.append(...k);return e}
const isWide=()=>typeof matchMedia==='function'&&matchMedia('(min-width:900px)').matches;let selId='',lastWide=isWide(),col='needs',fails=0,timer,seen=new Set(),first=true,busy=false;
function sched(){clearTimeout(timer);timer=setTimeout(load,Math.min(3000*2**fails,30000))}
function focusTask(id){if(isWide()&&id!==selId){selId=id;load()}const e=$('task-'+id);if(e){e.scrollIntoView();e.style.outline='2px solid var(--needs)'}}
async function notify(t,a){if(!window.Notification||Notification.permission!=='granted')return;
const o={body:a.tool+': '+a.detail,tag:'ask-'+a.id,data:'/?task='+t.id};
try{const reg=navigator.serviceWorker&&await navigator.serviceWorker.ready;if(reg)return reg.showNotification(t.title+' needs approval',o);new Notification(t.title+' needs approval',o).onclick=()=>{focus();focusTask(t.id)}}catch(e){}}
async function load(){if(busy)return;if(hold()){if(dragging)redo=true;sched();return}busy=true;clearTimeout(timer);localStorage.tok=$('t').value;
try{const r=await fetch('/api/state',{headers:H()});const l=$('l');
if(!r.ok){fails=0;$('st').textContent='';l.textContent='';l.append(el('div',{className:'c'},'Not paired: '+r.status));$('t').hidden=false;return}
const data=await r.json();fails=0;$('st').textContent='';l.textContent='';
$('t').hidden=true;const pj=$('pj');pj.textContent='';const rs=data.projects||[];{const ps=el('select',{title:'Project',style:'width:100%;min-height:44px;font-size:16px',onchange:()=>{ps.blur();selId='';actGen++;clearTimeout(actTimer);l.textContent='';$('tabs').textContent='';act({type:'project',root:ps.value})}});for(const r of rs){const o=el('option',{value:r.root},r.name);o.selected=r.root===data.current;ps.append(o)}if(!rs.length)ps.append(el('option',{},'No project'));pj.append(ps);$('ph').textContent=rs.length<2?'No other projects. Add one in VS Code: JustCode: Add Project':''}
busyIds=new Set(data.tasks.filter(t=>t.busy).map(t=>t.id));if(!selId||!data.tasks.some(t=>t.id===selId)){actGen++;clearTimeout(actTimer)}
const J=window.JCStatus,ln=t=>J?J.lane(Object.assign({},t,t.lt||{}),data.settings||{review:{maxAttempts:3}}):(t.asks.length?'needs':({todo:'todo',doing:'work',review:'review',done:'done'})[t.status]||'review');for(const t of data.tasks)t.ln=ln(t);
const inL=k=>data.tasks.filter(t=>t.ln===k);
const wide=isWide();const tb=$('tabs');tb.textContent='';tb.hidden=wide;if(!wide)for(const k of LK)tb.append(el('button',{id:'tab-'+k,className:(k===col?'on':'')+(k==='needs'&&inL(k).length?' dot':''),onclick:()=>{col=k;load()}},NM[k]+(inL(k).length?' '+inL(k).length:'')));
const feed=(box,steps)=>{box.textContent='';if(!steps.length){box.append(el('div',{className:'s'},'No activity yet'));return}for(const x of steps){const k=x.kind||'info';box.append(el('div',{className:'s',style:'margin:2px 0;white-space:pre-wrap;word-break:break-word'+(k==='error'?';color:var(--err)':k==='say'?';color:#eee':'')},el('b',{},(x.time?x.time+' ':'')+k+' '),(x.text||'').slice(0,500)))}};
const fill=(d,j)=>{
if(j.error||!j.files)d.append(el('div',{className:'s',style:'color:var(--err)'},j.error||'Could not load details'));
if(j.review){d.append(el('div',{className:'s'},'Review: '+j.review.state+(j.review.why?' · '+j.review.why:'')));for(const i of j.review.issues||[])d.append(el('div',{className:'a'},i))}
d.append(el('div',{className:'s'},'Changed files ('+(j.files||[]).length+')'));for(const f of j.files||[])d.append(el('div',{className:'s'},f.status+' '+f.file+' +'+f.added+' -'+f.removed));
for(const c of j.checks||[]){d.append(el('div',{className:'s'},c.name+': '+(c.ok?'pass':'fail')));if(c.tail)d.append(el('pre',{className:'s',style:'white-space:pre-wrap;word-break:break-all;margin:2px 0'},c.tail))}};
const detail=t=>{const d=el('div',{});const act=el('div',{});const gen=++actGen;clearTimeout(actTimer);
if(!isWide())d.append(el('button',{className:'n',onclick:()=>{selId='';actGen++;clearTimeout(actTimer);load()}},'Back'));d.append(el('div',{className:'s'},'Activity'),act);
const rest=el('div',{});d.append(rest);let first=true;
const tick=()=>{fetch('/api/detail?id='+encodeURIComponent(t.id),{headers:H()}).then(r=>r.json()).then(j=>{if(gen!==actGen)return;feed(act,j.steps||[]);if(first){first=false;fill(rest,j)}actTimer=setTimeout(tick,busyIds.has(t.id)?2000:6000)}).catch(e=>{if(gen!==actGen)return;if(first){first=false;rest.append(el('div',{className:'s',style:'color:var(--err)'},'Could not load details: '+(e&&e.message||e)))}actTimer=setTimeout(tick,4000)})};tick();return d};
const say=t=>t.asks.length?(t.asks[0].kind==='question'?'Claude has a question for you':t.asks[0].kind==='plan'?'Plan ready for your OK':'Claude needs your approval'):t.lt&&t.lt.error?'Stopped: '+String(t.lt.error).slice(0,120):t.lt&&t.lt.conflicts&&t.lt.conflicts.length?'Conflicts in '+t.lt.conflicts.length+' file(s)':t.lt&&t.lt.phase?t.lt.phase:t.ln==='work'?'Working…':t.ln==='todo'?'Ready':t.ln==='done'?'Merged':t.canMerge?'✓ Checks and AI review passed':t.review?'Review: '+t.review:'In review';
const card=(t,pane,extra)=>{const c=el('div',{className:'c',id:pane?'':'task-'+t.id,style:'--k:var(--'+(t.ln==='needs'&&t.lt&&(t.lt.error||t.lt.conflicts&&t.lt.conflicts.length)?'err':CL[t.ln]||'todo')+')'},el('h4',{},t.title),el('div',{className:'s'+(t.lt&&t.lt.error?' err':'')},say(t)));
const acts=el('div',{className:'acts'});const add=(label,fn,cls)=>{acts.append(el('button',{className:acts.children.length?(cls||'n'):'p',onclick:fn},label))};
for(const a of t.asks){const d=el('div',{className:'a'},a.tool+': '+a.detail);c.append(d);if(a.kind==='permission'){add('Approve',()=>act({type:'answer',id:t.id,ask:a.id,choice:'allow'}));add('Deny',()=>act({type:'answer',id:t.id,ask:a.id,choice:'deny'}))}else d.append(el('br'),el('i',{},'Answer this one in VS Code'))}
if(t.status==='todo'&&!t.busy)add('Run',()=>act({type:'run',id:t.id}));
if(t.canMerge)add('Merge',()=>board({type:'merge',id:t.id}));
if(t.busy)add('Stop',()=>act({type:'stop',id:t.id}));
if(acts.children.length)c.append(acts);
if(!t.busy&&!t.asks.length&&t.status!=='done'){const sel=el('select',{className:'n',onchange:()=>{if(sel.value){sel.blur();act({type:'move',id:t.id,status:sel.value})}}},el('option',{value:''},'Move to…'));for(const k of ['todo','doing','review'])if(k!==t.status)sel.append(el('option',{value:k},k));c.append(sel);if(!pane)dragMove(c,t)}
if(extra)c.append(extra);
if(!pane){c.style.cursor='pointer';if(t.id===selId)c.style.borderColor='var(--accent)';c.addEventListener('click',e=>{if(e.target.closest('select,button'))return;selId=wide||t.id!==selId?t.id:'';load()})}
return c};
if(wide){const g=el('div',{className:'cols'});for(const k of LK){const cl=el('div',{className:'col'},el('button',{id:'tab-'+k,className:'n',style:'width:100%;margin:0',onclick:()=>{}},NM[k]+(inL(k).length?' '+inL(k).length:'')));for(const t of inL(k))cl.append(card(t));g.append(cl)}
const st=data.tasks.find(t=>t.id===selId);g.append(el('div',{className:'pane'},st?card(st,true,detail(st)):el('div',{className:'s'},'Select a task to see its details.')));l.append(g)}
else{for(const t of inL(col))l.append(card(t,false,t.id===selId?detail(t):undefined));if(!inL(col).length)l.append(el('div',{className:'s',style:'margin:12px'},'Nothing here.'))}
for(const t of data.tasks)for(const a of t.asks)if(a.kind==='permission'&&!seen.has(a.id)){seen.add(a.id);if(!first)notify(t,a)}
first=false;const w=new URLSearchParams(location.search).get('task');if(w)focusTask(w);notifState()}
catch(e){fails++;$('st').textContent='Offline, retrying in '+Math.min(3000*2**fails,30000)/1000+'s'}
finally{busy=false;sched()}}
const reload=()=>{fails=0;load()};addEventListener('resize',()=>{const w=isWide();if(w!==lastWide){lastWide=w;reload()}});
document.addEventListener('visibilitychange',()=>{if(!document.hidden)reload()});addEventListener('online',reload);addEventListener('focus',reload);
if(navigator.connection)navigator.connection.addEventListener('change',reload);
if(navigator.serviceWorker){navigator.serviceWorker.register('/sw.js').catch(()=>{});navigator.serviceWorker.addEventListener('message',e=>{const w=new URL(e.data.open,location.href).searchParams.get('task');if(w)focusTask(w)})}
function notifState(){const n=$('nt');n.textContent='';
if(!window.Notification||!navigator.serviceWorker||!window.isSecureContext){n.textContent='Approval notifications unavailable here (needs https or localhost); this page still updates while open.';return}
if(Notification.permission==='default')n.append(el('button',{className:'n',onclick:()=>Notification.requestPermission().then(notifState)},'Enable approval notifications'));
else if(Notification.permission==='denied')n.textContent='Notifications are blocked in browser settings.'}
$('add').onclick=()=>{if($('n').value){act({type:'addTask',title:$('n').value,start:true});$('n').value=''}};
load();if(typeof setInterval==='function')setInterval(poll,2000);
</script></body></html>`;
