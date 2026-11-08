import {createServer} from 'node:http';
import {randomBytes,randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {verifyToolOrigin,stripToolOrigin,TOOL_ORIGIN_MAX_AGE_MS} from './tool-origin.js';

async function body(req){const chunks=[];let size=0;for await(const chunk of req){const bytes=Buffer.from(chunk);size+=bytes.length;if(size>1000000)throw new Error('Request too large');chunks.push(bytes);}return JSON.parse(Buffer.concat(chunks).toString('utf8'));}
export function createDesktopHandler({companion,token,originSecret,deliveryTimeoutMs=15000}){
 const nonces=new Map(),deliveries=new Map();
 const metrics={originsAuthorized:0,tools:Object.create(null),imagesConfirmed:0};
 const handler=async(req,res)=>{
  if(req.method!=='POST'||!['/tool','/delivered'].includes(req.url)||req.headers.authorization!=='Bearer '+token){res.writeHead(403);res.end();return;}
  try{
   const input=await body(req);
   if(req.url==='/delivered'){
    const pending=deliveries.get(input.deliveryId);if(!pending)throw new Error('The image delivery receipt is no longer pending.');
    clearTimeout(pending.timer);deliveries.delete(input.deliveryId);
    const confirmed=pending.commits.map(commit=>commit()).every(result=>result!==false);if(confirmed)metrics.imagesConfirmed++;
    res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({confirmed}));return;
   }
   const {name,arguments:args}=input,origin=verifyToolOrigin({secret:originSecret,tool:name,args});
   const now=Date.now();for(const [nonce,at]of nonces)if(now-at>TOOL_ORIGIN_MAX_AGE_MS+10000)nonces.delete(nonce);
   if(nonces.has(origin.nonce))throw new Error('The tool authorization has already been used.');nonces.set(origin.nonce,now);
   const lease=await companion.authorizeToolOrigin(origin),commits=[];metrics.originsAuthorized++;
   const result=await companion.invokeDesktopTool(name,stripToolOrigin(args),{lease,onDelivered:commit=>commits.push(commit)});
   metrics.tools[name]=(metrics.tools[name]??0)+1;
   let deliveryId;
   if(commits.length){deliveryId=randomUUID();const timer=setTimeout(()=>deliveries.delete(deliveryId),deliveryTimeoutMs);timer.unref?.();deliveries.set(deliveryId,{commits,timer});}
   res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({...result,...(deliveryId?{deliveryId}:{})}));
  }catch(error){if(!res.headersSent&&!res.destroyed){res.writeHead(400,{'Content-Type':'application/json'});res.end(JSON.stringify({error:error.message}));}else res.destroy?.();}
 };
 handler.metrics=metrics;handler.close=()=>{for(const pending of deliveries.values())clearTimeout(pending.timer);deliveries.clear();nonces.clear();};return handler;
}

export async function startDesktopServer(companion){
 const token=randomBytes(32).toString('hex'),originSecret=randomBytes(32).toString('hex');
 const handler=createDesktopHandler({companion,token,originSecret}),server=createServer(handler);server.metrics=handler.metrics;server.on('close',handler.close);
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 await writeFile(join(companion.dataDir,'desktop-bridge.json'),JSON.stringify({url:`http://127.0.0.1:${server.address().port}/tool`,token,originSecret}),{mode:0o600});
 return server;
}
