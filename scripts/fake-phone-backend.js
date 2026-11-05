// node scripts/fake-phone-backend.js out-test/phone.js [out-test/bridge.js]   (run `npm test` first)
const path=require('path');
const phoneMod=require(path.resolve(process.argv[2]));
const {startPhoneServer,phoneMoveError}=phoneMod;
const {DialogHub}=require(path.resolve(process.argv[3]||process.argv[2].replace('phone.js','bridge.js')));
const hub=new DialogHub();
const projects=[{root:'/fake/alpha',name:'alpha'},{root:'/fake/beta',name:'beta'},{root:'/fake/gamma',name:'gamma'}];
let current='/fake/alpha';
const find=id=>tasks.find(x=>x.id===id);
let tasks=[
 {id:'t-run',title:'Running task',status:'doing',busy:true,asks:[{id:'a-perm',kind:'permission',tool:'Bash',detail:'npm test'}]},
 {id:'t-todo',title:'Todo task',status:'todo',busy:false,asks:[]},
 {id:'t-review',title:'Review task',status:'review',busy:false,asks:[],review:'pass',canMerge:true},
 {id:'t-ask',title:'Task with a question',status:'doing',busy:true,asks:[{id:'a-q',kind:'question',detail:'Which database should I use?'}]},
];
// a dialog event so /api/events has something to show (resolved/ignored by the phone page as it likes)
hub.ask({title:'Please confirm',text:'Fake dialog from the board',buttons:['OK']}).catch(()=>{});
startPhoneServer(+(process.env.PORT||7878),{token:process.env.TOK||'tok',state:()=>({projects,current,tasks}),events:n=>hub.events(n),
 board:async m=>{console.log('board',m.type,m.remote);
  if(m.type==='dialogReply')return void hub.reply(m);
  if(m.type==='merge'){const r=await hub.ask({title:'Please confirm',text:'Merge "Review task" into main?',buttons:['Merge']});console.log('merge answer',r);if(r?.button==='Merge'){const t=find('t-review');if(t){t.status='done';t.canMerge=false}}}},
 act:async m=>{
 const t=m.id&&find(m.id);
 switch(m.type){
  case 'addTask':{if(!String(m.title||'').trim())return 'title required';const n={id:'t'+(tasks.length+1),title:m.title,status:m.start?'doing':'todo',busy:!!m.start,asks:[]};tasks.push(n);break}
  case 'run':if(!t)return 'no such task';t.status='doing';t.busy=true;break;
  case 'stop':if(!t)return 'no such task';t.busy=false;t.asks=[];if(t.status==='doing')t.status='todo';break;
  case 'answer':{if(!t)return 'no such task';if(m.choice!=='allow'&&m.choice!=='deny')return 'phone can only allow or deny';
   if(!t.asks.some(a=>a.id===m.ask))return 'request no longer open';
   t.asks=t.asks.filter(a=>a.id!==m.ask);
   if(m.choice==='deny'){t.busy=false;t.status='todo'}else if(!t.asks.length){t.status='review';t.review='pass';t.busy=false;t.canMerge=true}
   break}
  case 'project':if(!projects.some(p=>p.root===m.root))return 'unknown project';current=m.root;break;
  case 'move':{const e=t&&phoneMoveError(t,m.status);if(e)return e;if(t)t.status=m.status;break}
 }
 console.log('act',m.type)}}).then(()=>console.log('up'));
