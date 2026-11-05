// The phone page (HTML, CSS and script), served from / by phone.ts.
export const PAGE = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>JustCode</title><style>
*{box-sizing:border-box}body{font:15px system-ui;margin:0;background:#111;color:#eee}
header{display:flex;align-items:center;gap:8px;padding:8px 12px;background:#222;font-weight:600}
header select{flex:1;min-width:0;margin:0;max-width:100%}
#top{position:sticky;top:0;z-index:5;background:#111}
.tabs{display:flex;gap:6px;padding:8px 10px;background:#111;overflow-x:auto}
.tabs button{flex:1;margin:0;white-space:nowrap}
.c{margin:10px;padding:12px;background:#1c1c1c;border:1px solid #2c2c2c;border-radius:10px}.s{opacity:.7;font-size:12px}
button,select{font:inherit;min-height:44px;padding:8px 14px;margin:6px 6px 0 0;border:0;border-radius:8px;background:#3b82f6;color:#fff}
button.n,select.n,header select{background:#444}
input{font:inherit;min-height:44px;padding:8px;width:calc(100% - 20px);margin:10px;border:1px solid #444;border-radius:8px;background:#1c1c1c;color:#eee}
input[hidden]{display:none}
.c,.tabs{-webkit-user-select:none;user-select:none;-webkit-touch-callout:none}
.a{border:1px solid #f59e0b;padding:8px;margin-top:8px;border-radius:8px;word-break:break-all}
@media(max-width:400px){body{font-size:14px}.c{margin:8px}.tabs{gap:4px;padding:6px}.tabs button{padding:8px 2px;font-size:13px}}
.tabs[hidden]{display:none}
@media(min-width:900px){.cols{display:grid;grid-template-columns:repeat(4,1fr) 1.3fr;gap:8px;padding:0 10px;align-items:start}.col{min-width:0}.col .c{margin:8px 0}.pane{position:sticky;top:60px}.pane .c{margin:0}}
</style></head><body><div id="top"><header>JustCode<div id="pj" style="flex:1;min-width:0;text-align:right"></div></header>
<div id="tabs" class="tabs"></div></div>
<input id="t" placeholder="Token (from VS Code: JustCode: Show Phone Pairing)"><input id="n" placeholder="New task title">
<dialog id="dg" style="background:#222;color:#eee;border:1px solid #555;border-radius:8px;max-width:90vw"></dialog><button id="add" style="margin-left:10px">Add + run</button><div id="st" class="s" style="margin:0 12px"></div><div id="er" role="alert" style="margin:4px 12px;color:#f88"></div><div id="nt" class="s" style="margin:4px 12px"></div><div id="l"></div>
<script>
const $=id=>document.getElementById(id);$('t').value=localStorage.tok||new URLSearchParams(location.search).get('token')||'';
const H=()=>({'x-token':$('t').value,'content-type':'application/json'});
async function act(m){const r=await fetch('/api/act',{method:'POST',headers:H(),body:JSON.stringify(m)});const j=await r.json();$('er').textContent=j.error||'';load()}
async function board(m){const r=await fetch('/api/board',{method:'POST',headers:H(),body:JSON.stringify(m)});const j=await r.json();if(j.error)alert(j.error);load()}
let dragging=false,redo=false;function hold(){return dragging||document.activeElement?.tagName==='SELECT'}function dragMove(c,t){let tm,on=false,sx,sy;const hl=x=>{for(const k of ['todo','doing','review','done']){const b=$('tab-'+k);if(b)b.style.outline=x===k?'2px solid #4af':''}};
const at=e=>{const p=e.touches[0]||e.changedTouches[0],n=document.elementFromPoint(p.clientX,p.clientY),b=n&&n.closest('button[id^=tab-]');return b?b.id.slice(4):''};
c.addEventListener('touchstart',e=>{if(e.target.closest('select,button'))return;sx=e.touches[0].clientX;sy=e.touches[0].clientY;tm=setTimeout(()=>{on=true;dragging=true;c.style.opacity='.6';navigator.vibrate&&navigator.vibrate(30)},500)},{passive:true});
c.addEventListener('touchmove',e=>{if(!on){if(Math.abs(e.touches[0].clientX-sx)+Math.abs(e.touches[0].clientY-sy)>10)clearTimeout(tm);return}e.preventDefault();hl(at(e))},{passive:false});
const end=e=>{clearTimeout(tm);if(!on)return;on=false;dragging=false;c.style.opacity='';hl('');if(e.type==='touchend'){const k=at(e);if(k&&k!==t.status)act({type:'move',id:t.id,status:k});else if(redo)load()}redo=false};
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
const isWide=()=>typeof matchMedia==='function'&&matchMedia('(min-width:900px)').matches;let selId='',lastWide=isWide(),col='todo',fails=0,timer,seen=new Set(),first=true,busy=false;
function sched(){clearTimeout(timer);timer=setTimeout(load,Math.min(3000*2**fails,30000))}
function focusTask(id){if(isWide()&&id!==selId){selId=id;load()}const e=$('task-'+id);if(e){e.scrollIntoView();e.style.outline='2px solid #f59e0b'}}
async function notify(t,a){if(!window.Notification||Notification.permission!=='granted')return;
const o={body:a.tool+': '+a.detail,tag:'ask-'+a.id,data:'/?task='+t.id};
try{const reg=navigator.serviceWorker&&await navigator.serviceWorker.ready;if(reg)return reg.showNotification(t.title+' needs approval',o);new Notification(t.title+' needs approval',o).onclick=()=>{focus();focusTask(t.id)}}catch(e){}}
async function load(){if(busy)return;if(hold()){if(dragging)redo=true;sched();return}busy=true;clearTimeout(timer);localStorage.tok=$('t').value;
try{const r=await fetch('/api/state',{headers:H()});const l=$('l');
if(!r.ok){fails=0;$('st').textContent='';l.textContent='';l.append(el('div',{className:'c'},'Not paired: '+r.status));$('t').hidden=false;return}
const data=await r.json();fails=0;$('st').textContent='';l.textContent='';
$('t').hidden=true;const pj=$('pj');pj.textContent='';const rs=data.projects||[];if(rs.length){const ps=el('select',{title:'Project',onchange:()=>{ps.blur();act({type:'project',root:ps.value})}});for(const r of rs){const o=el('option',{value:r.root},r.name);o.selected=r.root===data.current;ps.append(o)}pj.append(ps)}
const wide=isWide();const tb=$('tabs');tb.textContent='';tb.hidden=wide;if(!wide)for(const k of ['todo','doing','review','done'])tb.append(el('button',{id:'tab-'+k,className:k===col?'':'n',onclick:()=>{col=k;load()}},({todo:'To do',doing:'Doing',review:'Review',done:'Done'})[k]+' ('+data.tasks.filter(t=>t.status===k).length+')'+(data.tasks.some(t=>t.status===k&&t.asks.length)?' !':'')));
const card=(t,pane)=>{const c=el('div',{className:'c',id:pane?'':'task-'+t.id},el('b',{},t.title),el('div',{className:'s'},t.status+(t.review?' · review '+t.review:'')));
if(t.status==='todo')c.append(el('button',{onclick:()=>act({type:'run',id:t.id})},'Run'));
if(t.busy)c.append(el('button',{className:'n',onclick:()=>act({type:'stop',id:t.id})},'Stop'));
for(const a of t.asks){const d=el('div',{className:'a'},a.tool+': '+a.detail,el('br'));
if(a.kind==='permission'){d.append(el('button',{onclick:()=>act({type:'answer',id:t.id,ask:a.id,choice:'allow'})},'Approve'),el('button',{className:'n',onclick:()=>act({type:'answer',id:t.id,ask:a.id,choice:'deny'})},'Deny'))}else d.append(el('i',{},'Answer this one in VS Code'));c.append(d)}
if(!t.busy&&!t.asks.length&&t.status!=='done'){const sel=el('select',{className:'n',onchange:()=>{if(sel.value){sel.blur();act({type:'move',id:t.id,status:sel.value})}}},el('option',{value:''},'Move to…'));for(const k of ['todo','doing','review'])if(k!==t.status)sel.append(el('option',{value:k},k));c.append(sel);if(!pane)dragMove(c,t)}
if(t.canMerge)c.append(el('button',{onclick:()=>board({type:'merge',id:t.id})},'Merge'));
if(wide&&!pane){c.style.cursor='pointer';if(t.id===selId)c.style.borderColor='#3b82f6';c.addEventListener('click',e=>{if(e.target.closest('select,button'))return;selId=t.id;load()})}
return c};
const names={todo:'To do',doing:'Doing',review:'Review',done:'Done'};
if(wide){const g=el('div',{className:'cols'});for(const k of ['todo','doing','review','done']){const cl=el('div',{className:'col'},el('button',{id:'tab-'+k,className:'n',style:'width:100%;margin:0',onclick:()=>{}},names[k]+' ('+data.tasks.filter(t=>t.status===k).length+')'+(data.tasks.some(t=>t.status===k&&t.asks.length)?' !':'')));for(const t of data.tasks.filter(t=>t.status===k))cl.append(card(t));g.append(cl)}
const st=data.tasks.find(t=>t.id===selId);g.append(el('div',{className:'pane'},st?card(st,true):el('div',{className:'s'},'Select a task to see its details.')));l.append(g)}
else for(const t of data.tasks.filter(t=>t.status===col||t.asks.length))l.append(card(t));
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
