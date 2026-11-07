import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';

export class ProcessRpc extends EventEmitter {
  constructor(command, args = [], options = {}) { super(); Object.assign(this, {command,args,options}); this.pending=new Map(); this.sequence=0; }
  start() {
    this.process=spawn(this.command,this.args,{...this.options,windowsHide:true,stdio:['pipe','pipe','pipe']});
    this.process.on('error',e=>this.emit('fault',e));
    this.process.stdin.on('error',e=>this.emit('fault',e));
    this.process.stderr.on('data',d=>this.emit('diagnostic',d.toString()));
    this.lines=createInterface({input:this.process.stdout});
    this.lines.on('line',line=>{try{const m=JSON.parse(line);if(m.event){this.emit(m.event,m);return;}const p=this.pending.get(m.id);if(!p)return;clearTimeout(p.timer);this.pending.delete(m.id);m.error?p.reject(Object.assign(new Error(m.error),{detail:m.detail})):p.resolve(m.result);}catch{}});
    this.process.on('exit',()=>{for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(new Error('Local component disconnected'));}this.pending.clear();this.emit('disconnected');});
    return this;
  }
  call(command,params={},timeout=15000) {
    const id=++this.sequence;
    return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error(`${command} timed out`));},timeout);this.pending.set(id,{resolve,reject,timer});try{this.process.stdin.write(JSON.stringify({id,command,params})+'\n');}catch(e){clearTimeout(timer);this.pending.delete(id);reject(e);}});
  }
  close(){this.lines?.close();this.process?.stdin.end();this.process?.kill();}
}
