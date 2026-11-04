const {startPhoneServer}=require(process.argv[2]);
let tasks=[{id:'t1',title:'Demo task',status:'todo',busy:false,asks:[]}];
startPhoneServer(7878,{token:'tok',state:()=>({tasks}),act:async m=>{
 if(m.type==='addTask'){tasks.push({id:'t2',title:m.title,status:'doing',busy:true,asks:[{id:'a1',kind:'permission',tool:'Bash',detail:'npm test'}]})}
 if(m.type==='answer'){tasks[1].asks=[];tasks[1].status='review';tasks[1].review='pass';tasks[1].busy=false;tasks[1].canMerge=true}
 if(m.type==='merge'){tasks[1].status='done';tasks[1].canMerge=false}
 console.log('act',m.type)}}).then(()=>console.log('up'));
