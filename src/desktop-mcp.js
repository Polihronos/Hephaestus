import {createInterface} from 'node:readline';
import {readFile} from 'node:fs/promises';
import {dynamicTools} from './companion.js';
import {t3Tools} from './t3-workspace.js';
const file=process.argv[2];
const send=(id,result,error)=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,...(error?{error:{code:-32603,message:error.message}}:{result})})+'\n');
for await(const line of createInterface({input:process.stdin})){
 let request;try{request=JSON.parse(line);}catch{continue;}
 if(request.id===undefined)continue;
 (async()=>{try{
  if(request.method==='initialize'){send(request.id,{protocolVersion:request.params?.protocolVersion??'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'hephaestus-desktop',version:'3.0.0'}});return;}
  if(request.method==='ping'){send(request.id,{});return;}
  if(request.method==='tools/list'){send(request.id,{tools:[...dynamicTools,...t3Tools].map(({name,description,inputSchema})=>({name,description,inputSchema}))});return;}
  if(request.method!=='tools/call')throw new Error('Unknown method');
  const config=JSON.parse(await readFile(file,'utf8'));if(!/^http:\/\/127\.0\.0\.1:\d+\/tool$/.test(config.url))throw new Error('Invalid desktop endpoint');
  const response=await fetch(config.url,{method:'POST',headers:{Authorization:'Bearer '+config.token,'Content-Type':'application/json'},body:JSON.stringify(request.params)});const result=await response.json();if(!response.ok||result.error)throw new Error(result.error??'Desktop request failed');
  send(request.id,{content:result.contentItems.map(c=>c.type==='inputImage'?{type:'image',mimeType:c.imageUrl.split(';')[0].slice(5),data:c.imageUrl.split(',')[1]}:{type:'text',text:c.text??''}),isError:!result.success});
 }catch(e){if(request.method==='tools/call')send(request.id,{content:[{type:'text',text:e.message}],isError:true});else send(request.id,null,e);}})();
}
