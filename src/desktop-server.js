import {createServer} from 'node:http';
import {randomBytes} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';

export async function startDesktopServer(companion){
 const token=randomBytes(32).toString('hex');
 const server=createServer(async(req,res)=>{
  if(req.method!=='POST'||req.url!=='/tool'||req.headers.authorization!=='Bearer '+token){res.writeHead(403);res.end();return;}
  try{let raw='';for await(const b of req){raw+=b;if(raw.length>1000000)throw new Error('Request too large');}const {name,arguments:args}=JSON.parse(raw);const result=await companion.invokeDesktopTool(name,args);res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(result));}catch(e){res.writeHead(400,{'Content-Type':'application/json'});res.end(JSON.stringify({error:e.message}));}
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 await writeFile(join(companion.dataDir,'desktop-bridge.json'),JSON.stringify({url:`http://127.0.0.1:${server.address().port}/tool`,token}),{mode:0o600});
 return server;
}
