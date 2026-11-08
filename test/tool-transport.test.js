import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {Readable} from 'node:stream';
import {spawn} from 'node:child_process';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join,dirname,basename,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {createDesktopHandler} from '../src/desktop-server.js';
import {writeMcpResponse} from '../src/mcp-output.js';
import {TOOL_ORIGIN_FIELD,signToolOrigin,canonicalToolArguments} from '../src/tool-origin.js';

const tick=()=>new Promise(resolve=>setImmediate(resolve));
async function within(promise,ms=5000,label='Transport fixture timed out'){
 let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(label)),ms);})]);}finally{clearTimeout(timer);}
}
function fixture({beforeResult}={}){
 const token=randomBytes(32).toString('hex'),originSecret=randomBytes(32).toString('hex');
 const state={generation:1,authorized:[],invocations:[],commitAttempts:0,imageCommits:0,uiFrames:0,receipts:0};
 const companion={
  async authorizeToolOrigin(origin){state.authorized.push(origin);return Object.freeze({generation:state.generation,nativeTurnId:origin.nativeTurnId});},
  async invokeDesktopTool(name,args,{lease,onDelivered}){
   state.invocations.push({name,args,lease});
   onDelivered(()=>{state.commitAttempts++;if(lease.generation!==state.generation)return false;state.imageCommits++;state.uiFrames++;return true;});
   await beforeResult?.();
   return{success:true,contentItems:[{type:'inputImage',imageUrl:'data:image/jpeg;base64,'+Buffer.from('isolated image fixture').toString('base64')}]};
  },
 };
 const handler=createDesktopHandler({companion,token,originSecret,deliveryTimeoutMs:1000});
 function signed(args={mode:'window'},tool='screen_observe'){
  const proof=signToolOrigin({secret:originSecret,tool,args,nativeSessionId:'fixture-native-session',nativeTurnId:'fixture-turn',toolUseId:randomUUID()});
  return{name:tool,arguments:{...args,[TOOL_ORIGIN_FIELD]:proof}};
 }
 return{token,originSecret,state,handler,signed};
}
function request(f,url,input,{bytes}={}){
 const chunks=bytes??[Buffer.from(JSON.stringify(input),'utf8')],req=Readable.from(chunks);
 req.method='POST';req.url=url;req.headers={authorization:'Bearer '+f.token};return req;
}
function response({failWrite=false}={}){
 return{headersSent:false,destroyed:false,status:null,body:'',endCalls:0,
  writeHead(status){this.status=status;this.headersSent=true;},
  end(body=''){this.endCalls++;this.body=String(body);if(failWrite)throw Object.assign(new Error('Simulated response pipe failure'),{code:'EPIPE'});},
  destroy(){this.destroyed=true;},
 };
}
async function dispatch(f,url,input,options){
 const res=response();if(url==='/delivered')f.state.receipts++;
 await within(f.handler(request(f,url,input,options),res));
 return{status:res.status,body:res.body?JSON.parse(res.body):null};
}
async function listen(t,f){
 const server=createServer((req,res)=>{if(req.url==='/delivered')f.state.receipts++;f.handler(req,res).catch(error=>res.destroy(error));});
 await within(new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);}));
 t.after(async()=>{f.handler.close();server.closeAllConnections?.();await within(new Promise(resolve=>server.close(resolve)));});
 const base=`http://127.0.0.1:${server.address().port}`;
 return{base,post:async(path,input)=>{const result=await within(fetch(base+path,{method:'POST',headers:{Authorization:'Bearer '+f.token,'Content-Type':'application/json'},body:JSON.stringify(input)}));return{status:result.status,body:await within(result.json())};}};
}
async function mcpChild(t,f,base){
 const directory=await mkdtemp(join(tmpdir(),'hephaestus-tool-transport-'));
 const config=join(directory,'bridge.json');
 // The MCP transport gets no signing secret. Only this fixture signer/server
 // possess it; the child forwards an already-signed originating-turn proof.
 await writeFile(config,JSON.stringify({url:base+'/tool',token:f.token}));
 const child=spawn(process.execPath,[join(process.cwd(),'src','desktop-mcp.js'),config],{cwd:process.cwd(),env:{...process.env,ELECTRON_RUN_AS_NODE:'1'},windowsHide:true,stdio:['pipe','pipe','pipe']});
 let stdout='',stderr='';child.stdout.on('data',chunk=>{stdout+=chunk.toString('utf8');});child.stderr.on('data',chunk=>{stderr+=chunk.toString('utf8');});
 const exited=new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',(code,signal)=>resolve({code,signal}));});
 // Attach a rejection observer immediately so a failed fixture spawn cannot
 // leave an unhandled promise while the test waits for its local HTTP gate.
 exited.catch(()=>{});
 t.after(async()=>{
  if(child.exitCode===null&&child.signalCode===null)child.kill();
  await within(exited).catch(()=>{});
  assert.equal(dirname(resolve(directory)),resolve(tmpdir()));assert.ok(basename(directory).startsWith('hephaestus-tool-transport-'));
  await rm(directory,{recursive:true,force:true});
 });
 return{child,exited,output:()=>({stdout,stderr}),call:payload=>child.stdin.end(JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:payload})+'\n')};
}

test('an HTTP response write failure cannot commit an image or produce a delivery acknowledgement',async()=>{
 const f=fixture();try{
  const res=response({failWrite:true});await within(f.handler(request(f,'/tool',f.signed()),res));
  assert.equal(res.destroyed,true);assert.equal(res.endCalls,1);assert.equal(f.state.invocations.length,1);
  assert.equal(f.state.imageCommits,0);assert.equal(f.state.uiFrames,0);assert.equal(f.state.receipts,0);assert.equal(f.handler.metrics.imagesConfirmed,0);
  const attempted=JSON.parse(res.body);assert.equal(typeof attempted.deliveryId,'string');
  f.handler.close();
  const late=await dispatch(f,'/delivered',{deliveryId:attempted.deliveryId});assert.equal(late.status,400);assert.equal(f.state.commitAttempts,0);
 }finally{f.handler.close();}
});

test('a real HTTP result alone leaves the image uncommitted until its one-shot delivery receipt',async t=>{
 const f=fixture(),http=await listen(t,f),payload=f.signed();
 const result=await http.post('/tool',payload);
 assert.equal(result.status,200);assert.ok(result.body.deliveryId);assert.equal(result.body.contentItems[0].type,'inputImage');
 assert.equal(f.state.imageCommits,0);assert.equal(f.state.commitAttempts,0);assert.equal(f.handler.metrics.imagesConfirmed,0);
 const receipt=await http.post('/delivered',{deliveryId:result.body.deliveryId});
 assert.equal(receipt.status,200);assert.deepEqual(receipt.body,{confirmed:true});assert.equal(f.state.imageCommits,1);assert.equal(f.state.uiFrames,1);assert.equal(f.handler.metrics.imagesConfirmed,1);
 const replay=await http.post('/delivered',{deliveryId:result.body.deliveryId});assert.equal(replay.status,400);assert.equal(f.state.commitAttempts,1);assert.equal(f.state.imageCommits,1);
});

test('a stale generation consumes the receipt but cannot advance the shared image or UI',async()=>{
 const f=fixture();try{
  const result=await dispatch(f,'/tool',f.signed());f.state.generation++;
  const receipt=await dispatch(f,'/delivered',{deliveryId:result.body.deliveryId});
  assert.equal(receipt.status,200);assert.deepEqual(receipt.body,{confirmed:false});assert.equal(f.state.commitAttempts,1);
  assert.equal(f.state.imageCommits,0);assert.equal(f.state.uiFrames,0);assert.equal(f.handler.metrics.imagesConfirmed,0);
  assert.equal((await dispatch(f,'/delivered',{deliveryId:result.body.deliveryId})).status,400);assert.equal(f.state.commitAttempts,1);
 }finally{f.handler.close();}
});

test('a signed origin nonce cannot invoke the tool again after its first transport use',async()=>{
 const f=fixture();try{
  const payload=f.signed();assert.equal((await dispatch(f,'/tool',payload)).status,200);
  const replay=await dispatch(f,'/tool',payload);assert.equal(replay.status,400);assert.match(replay.body.error,/already been used/);
  assert.equal(f.state.invocations.length,1);assert.equal(f.state.authorized.length,1);assert.equal(f.handler.metrics.originsAuthorized,1);assert.equal(f.handler.metrics.tools.screen_observe,1);assert.equal(f.state.imageCommits,0);
 }finally{f.handler.close();}
});

test('UTF-8 arguments split through multibyte characters preserve exact signed values and HMAC arguments hash',async()=>{
 const f=fixture();try{
  const args={mode:'window',label:'Здравей Ω 🐈 — café',nested:{text:'  ред\n第二行 & %PATH%  ',values:['é','🐾']}};
  const payload=f.signed(args),encoded=Buffer.from(JSON.stringify(payload),'utf8');
  const bytes=Array.from(encoded,byte=>Buffer.from([byte]));
  const result=await dispatch(f,'/tool',payload,{bytes});assert.equal(result.status,200);assert.equal(f.state.invocations.length,1);
  assert.deepEqual(f.state.invocations[0].args,args);assert.equal(Object.hasOwn(f.state.invocations[0].args,TOOL_ORIGIN_FIELD),false);
  assert.equal(f.state.authorized[0].argsHash,createHash('sha256').update(canonicalToolArguments(args)).digest('hex'));
  assert.equal(f.state.authorized[0].nativeTurnId,'fixture-turn');assert.equal(f.state.imageCommits,0);
 }finally{f.handler.close();}
});

test('a modified argument fails real signature verification before authorization or invocation',async()=>{
 const f=fixture();try{
  const payload=f.signed({label:'Exact text'});payload.arguments.label='Changed text';
  assert.equal((await dispatch(f,'/tool',payload)).status,400);assert.equal(f.state.authorized.length,0);assert.equal(f.state.invocations.length,0);assert.equal(f.handler.metrics.originsAuthorized,0);
 }finally{f.handler.close();}
});

test('writeMcpResponse remains pending until the actual stdout write callback succeeds',async()=>{
 let callback,written,settled=false;
 const message={jsonrpc:'2.0',id:2,result:{text:'Точен текст 🐈'}};
 const pending=writeMcpResponse({write(text,done){written=text;callback=done;return false;}},message).then(()=>{settled=true;});
 await tick();assert.equal(settled,false);assert.equal(written,JSON.stringify(message)+'\n');callback();await pending;assert.equal(settled,true);
});

test('writeMcpResponse rejects an asynchronous stdout callback failure',async()=>{
 const pending=writeMcpResponse({write(_text,done){queueMicrotask(()=>done(Object.assign(new Error('Broken stdout'),{code:'EPIPE'})));}}, {jsonrpc:'2.0',id:1,result:{}});
 await assert.rejects(pending,error=>error.code==='EPIPE');
});

test('writeMcpResponse rejects a synchronous stdout failure',async()=>{
 await assert.rejects(writeMcpResponse({write(){throw new Error('Closed stdout');}},{id:1}),/Closed stdout/);
});

test('the actual MCP child forwards a signed call and acknowledges only after its response write',async t=>{
 const f=fixture(),http=await listen(t,f),mcp=await mcpChild(t,f,http.base);
 mcp.call(f.signed({mode:'window',label:'Локален транспорт 🐈'}));
 const exit=await within(mcp.exited);assert.equal(exit.code,0);
 const output=mcp.output();assert.equal(output.stderr,'');const lines=output.stdout.trim().split('\n').map(line=>JSON.parse(line));
 assert.equal(lines.length,1);assert.equal(lines[0].id,1);assert.equal(lines[0].result.isError,false);assert.equal(lines[0].result.content[0].type,'image');
 assert.equal(f.state.receipts,1);assert.equal(f.state.commitAttempts,1);assert.equal(f.state.imageCommits,1);assert.equal(f.handler.metrics.imagesConfirmed,1);
});

test('broken actual MCP stdout cannot send an HTTP delivery receipt or commit the image',async t=>{
 let release,entered;
 const blocked=new Promise(resolve=>{release=resolve;}),invoked=new Promise(resolve=>{entered=resolve;});
 const f=fixture({beforeResult:async()=>{entered();await blocked;}}),http=await listen(t,f),mcp=await mcpChild(t,f,http.base);
 try{
  mcp.call(f.signed());await within(invoked);
  mcp.child.stdout.destroy();release();
  const exit=await within(mcp.exited);assert.notEqual(exit.code,0);
  assert.equal(f.state.invocations.length,1);assert.equal(f.state.receipts,0);assert.equal(f.state.commitAttempts,0);assert.equal(f.state.imageCommits,0);assert.equal(f.state.uiFrames,0);assert.equal(f.handler.metrics.imagesConfirmed,0);
 }finally{release();}
});
