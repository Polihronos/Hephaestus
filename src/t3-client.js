import {EventEmitter} from 'node:events';
import {readFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {join} from 'node:path';
import {homedir} from 'node:os';
import WebSocket from 'ws';

export class T3Client extends EventEmitter {
 constructor({home=process.env.T3CODE_HOME??join(homedir(),'.t3')}={}){super();this.home=home;this.pending=new Map();this.sequence=0;}
 async cli(args){
  const launcher=await readFile(process.env.T3CODE_CLI_PATH??join(this.home,'bin','t3.cmd'),'utf8');
  const executable=launcher.match(/^"([^"\r\n]+\.exe)"\s+"([^"\r\n]+bin\.mjs)"/m);
  if(!executable)throw new Error('Open T3 Code once to install its local command.');
  return new Promise((resolve,reject)=>{const child=spawn(executable[1],[executable[2],...args],{env:{...process.env,ELECTRON_RUN_AS_NODE:'1',T3CODE_HOME:this.home},windowsHide:true,stdio:['ignore','pipe','pipe']});let out='',err='';child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>err+=b);child.on('error',reject);child.on('exit',code=>code===0?resolve(out):reject(new Error(err.trim()||'T3 local command failed')));});
 }
 async start(){
  const runtime=JSON.parse(await readFile(join(this.home,'userdata','server-runtime.json'),'utf8'));this.origin=runtime.origin;
  if(!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(this.origin))throw new Error('Hephaestus requires a local T3 server.');
  const issued=JSON.parse(await this.cli(['auth','session','issue','--label','Hephaestus desktop','--ttl','12h','--json']));
  this.token=issued.token??issued.bearerToken??issued.accessToken;this.sessionId=issued.sessionId??issued.id;
  if(!this.token)throw new Error('T3 did not issue a local access session.');
  this.socket=new WebSocket(this.origin.replace('http:','ws:')+'/ws?orchestrationProtocol=2',{headers:{Authorization:'Bearer '+this.token}});
  await new Promise((resolve,reject)=>{this.socket.once('open',resolve);this.socket.once('error',reject);});
  this.socket.on('error',e=>this.emit('fault',e));
  this.socket.on('message',b=>{try{const decoded=JSON.parse(b);for(const m of Array.isArray(decoded)?decoded:[decoded])this.receive(m);}catch(e){this.emit('fault',e);}});
  this.socket.on('close',()=>{for(const p of this.pending.values()){clearTimeout(p.timer);p.reject?.(new Error('T3 disconnected'));}this.pending.clear();this.emit('disconnected');});
  return this;
 }
 receive(m){this.emit('frame',m);
  if(m._tag==='Ping'){this.send({_tag:'Pong'});return;}if(m._tag==='Pong')return;
  const p=this.pending.get(String(m.requestId));if(!p)return;
  if(m._tag==='Chunk'){
   for(const value of m.values??[]){
    if(this.pending.get(String(m.requestId))!==p)break;
    try{const processing=p.onValue?.(value);if(processing!==undefined)Promise.resolve(processing).catch(error=>this.failSubscription(String(m.requestId),p,error));}
    catch(error){this.failSubscription(String(m.requestId),p,error);break;}
   }
   this.send({_tag:'Ack',requestId:m.requestId});return;
  }
  if(m._tag==='Exit'){
   clearTimeout(p.timer);this.pending.delete(String(m.requestId));
   if(m.exit?._tag==='Success'){
    if(p.subscription)p.reject(new Error(p.tag+' subscription ended unexpectedly'));
    else p.resolve?.(m.exit.value);
   }else{const cause=m.exit?.cause;const error=new Error(cause?.[0]?.error?.message??cause?.[0]?.error?.detail??JSON.stringify(cause)??'T3 request failed');p.reject?.(error);}
  }
 }
 failSubscription(id,p,error){
  if(!p.subscription||this.pending.get(id)!==p)return;
  this.pending.delete(id);clearTimeout(p.timer);
  if(this.socket?.readyState===WebSocket.OPEN){try{this.send({_tag:'Interrupt',requestId:id});}catch{}}
  p.reject(error instanceof Error?error:new Error(String(error)));
 }
 send(message){if(this.socket?.readyState!==WebSocket.OPEN)throw new Error('T3 is not connected');this.socket.send(JSON.stringify(message));}
 call(tag,payload={},timeoutMs=30000){const id=String(++this.sequence);return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error(tag+' timed out'));},timeoutMs);timer.unref?.();this.pending.set(id,{resolve,reject,timer});try{this.send({_tag:'Request',id,tag,payload,headers:[]});}catch(e){clearTimeout(timer);this.pending.delete(id);reject(e);}});}
 subscribe(tag,payload,onValue,onError=e=>this.emit('fault',e)){
  if(typeof onValue!=='function'||typeof onError!=='function')throw new TypeError('Subscription callbacks must be functions');
  const id=String(++this.sequence),reject=error=>{
   try{Promise.resolve(onError(error)).catch(callbackError=>this.emit('fault',callbackError));}
   catch(callbackError){this.emit('fault',callbackError);}
  },p={subscription:true,tag,onValue,reject};
  this.pending.set(id,p);
  try{this.send({_tag:'Request',id,tag,payload,headers:[]});}catch(error){this.pending.delete(id);throw error;}
  return()=>{
   if(this.pending.get(id)!==p)return;
   this.pending.delete(id);
   if(this.socket?.readyState===WebSocket.OPEN){try{this.send({_tag:'Interrupt',requestId:id});}catch{}}
  };
 }
 async subscribeReady(tag,payload,onValue,{onError=error=>this.emit('fault',error),timeoutMs=10000,isReady=value=>value?.kind==='snapshot'}={}){
  if(typeof onValue!=='function'||typeof onError!=='function'||typeof isReady!=='function')throw new TypeError('Subscription callbacks must be functions');
  if(!Number.isFinite(timeoutMs)||timeoutMs<0)throw new TypeError('Subscription timeout must be a nonnegative number');
  return new Promise((resolve,reject)=>{
   let unsubscribe,cleanupRequested=false,stopped=false,ready=false,processing=Promise.resolve();
   const cleanup=()=>{cleanupRequested=true;if(unsubscribe){const stop=unsubscribe;unsubscribe=null;try{stop();}catch(error){this.emit('fault',error);}}};
   const stop=()=>{if(stopped)return;stopped=true;clearTimeout(timer);cleanup();};
   const fail=error=>{
    if(stopped)return;stopped=true;clearTimeout(timer);cleanup();
    const failure=error instanceof Error?error:new Error(String(error));
    if(!ready){reject(failure);return;}
    try{Promise.resolve(onError(failure)).catch(callbackError=>this.emit('fault',callbackError));}
    catch(callbackError){this.emit('fault',callbackError);}
   };
   const timer=setTimeout(()=>fail(new Error(tag+' subscription snapshot timed out')),timeoutMs);
   const receive=value=>{
    processing=processing.then(async()=>{
     if(stopped)return;
     try{
      await onValue(value);if(stopped)return;
      if(!ready&&await isReady(value)){if(stopped)return;ready=true;clearTimeout(timer);resolve(stop);}
     }catch(error){fail(error);}
    });
    return processing;
   };
   try{unsubscribe=this.subscribe(tag,payload,receive,fail);if(cleanupRequested)cleanup();}
   catch(error){fail(error);}
  });
 }
 async close(){this.socket?.close();if(this.sessionId)await this.cli(['auth','session','revoke',this.sessionId]).catch(()=>{});this.token=null;}
}
