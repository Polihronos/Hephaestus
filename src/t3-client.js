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
  if(m._tag==='Chunk'){for(const value of m.values??[])p.onValue?.(value);this.send({_tag:'Ack',requestId:m.requestId});return;}
  if(m._tag==='Exit'){clearTimeout(p.timer);this.pending.delete(String(m.requestId));if(m.exit?._tag==='Success')p.resolve?.(m.exit.value);else{const cause=m.exit?.cause;const error=new Error(cause?.[0]?.error?.message??cause?.[0]?.error?.detail??JSON.stringify(cause));p.reject?.(error);}}
 }
 send(message){if(this.socket?.readyState!==WebSocket.OPEN)throw new Error('T3 is not connected');this.socket.send(JSON.stringify(message));}
 call(tag,payload={},timeoutMs=30000){const id=String(++this.sequence);return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error(tag+' timed out'));},timeoutMs);this.pending.set(id,{resolve,reject,timer});this.send({_tag:'Request',id,tag,payload,headers:[]});});}
 subscribe(tag,payload,onValue,onError=e=>this.emit('fault',e)){const id=String(++this.sequence);this.pending.set(id,{onValue,reject:onError});this.send({_tag:'Request',id,tag,payload,headers:[]});return()=>{this.pending.delete(id);if(this.socket?.readyState===WebSocket.OPEN)this.send({_tag:'Interrupt',requestId:id});};}
 async close(){this.socket?.close();if(this.sessionId)await this.cli(['auth','session','revoke',this.sessionId]).catch(()=>{});this.token=null;}
}
