// node scripts/fake-phone-backend.js out-test/phone.js [out-test/bridge.js]   (run `npm test` first)
const {startPhoneServer}=require(require('path').resolve(process.argv[2]));
const {DialogHub}=require(require('path').resolve(process.argv[3]||process.argv[2].replace('phone.js','bridge.js')));
const hub=new DialogHub();
let tasks=[{id:'t1',title:'Demo task',status:'todo',busy:false,asks:[]}];
startPhoneServer(7878,{token:process.env.TOK||'tok',state:()=>({tasks}),events:n=>hub.events(n),
 board:async m=>{console.log('board',m.type,m.remote);
  if(m.type==='dialogReply')return void hub.reply(m);
  if(m.type==='merge'){const r=await hub.ask({title:'Please confirm',text:'Merge "Demo task" into main?',buttons:['Merge']});console.log('merge answer',r);if(r?.button==='Merge'){tasks[1].status='done';tasks[1].canMerge=false}}},
 act:async m=>{
 if(m.type==='addTask'){tasks.push({id:'t2',title:m.title,status:'doing',busy:true,asks:[{id:'a1',kind:'permission',tool:'Bash',detail:'npm test'}]})}
 if(m.type==='answer'){tasks[1].asks=[];tasks[1].status='review';tasks[1].review='pass';tasks[1].busy=false;tasks[1].canMerge=true}
 if(m.type==='move'){const t=tasks.find(x=>x.id===m.id);const e=t&&require(require('path').resolve(process.argv[2])).phoneMoveError(t,m.status);if(e)return e;if(t)t.status=m.status}
 console.log('act',m.type)}}).then(()=>console.log('up'));
