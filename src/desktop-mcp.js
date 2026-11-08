import {createInterface} from 'node:readline';
import {readFile} from 'node:fs/promises';
import {dynamicTools} from './companion.js';
import {t3Tools} from './t3-workspace.js';
import {TOOL_ORIGIN_FIELD} from './tool-origin.js';
import {writeMcpResponse} from './mcp-output.js';
const file=process.argv[2],version=JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8')).version;
process.stdout.on('error',()=>{});
const send=(id,result,error)=>writeMcpResponse(process.stdout,{jsonrpc:'2.0',id,...(error?{error:{code:-32603,message:error.message}}:{result})});
for await(const line of createInterface({input:process.stdin})){
 let request;try{request=JSON.parse(line);}catch{continue;}
 if(request.id===undefined)continue;
 (async()=>{let replied=false;try{
  if(request.method==='initialize'){await send(request.id,{protocolVersion:request.params?.protocolVersion??'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'hephaestus-desktop',version}});return;}
  if(request.method==='ping'){await send(request.id,{});return;}
  if(request.method==='tools/list'){await send(request.id,{tools:[...dynamicTools,...t3Tools].map(({name,description,inputSchema})=>({name,description,inputSchema:{...inputSchema,properties:{...inputSchema.properties,[TOOL_ORIGIN_FIELD]:{type:'object',description:'Attached by the trusted runtime hook. Do not generate or reuse it.'}}}}))});return;}
  if(request.method!=='tools/call')throw new Error('Unknown method');
  const config=JSON.parse(await readFile(file,'utf8'));if(!/^http:\/\/127\.0\.0\.1:\d+\/tool$/.test(config.url))throw new Error('Invalid desktop endpoint');
  const headers={Authorization:'Bearer '+config.token,'Content-Type':'application/json'};
  // The originating native-turn proof is immutable; a newer bridge configuration
  // must never lend a delayed call the current request's authority.
  const response=await fetch(config.url,{method:'POST',headers,body:JSON.stringify(request.params)}),result=await response.json();if(!response.ok||result.error)throw new Error(result.error??'Desktop request failed');
  await send(request.id,{content:result.contentItems.map(c=>c.type==='inputImage'?{type:'image',mimeType:c.imageUrl.split(';')[0].slice(5),data:c.imageUrl.split(',')[1]}:{type:'text',text:c.text??''}),isError:!result.success});replied=true;
  if(result.deliveryId)await fetch(config.url.replace(/\/tool$/,'/delivered'),{method:'POST',headers,body:JSON.stringify({deliveryId:result.deliveryId})}).catch(()=>{});
 }catch(error){if(!replied)try{if(request.method==='tools/call')await send(request.id,{content:[{type:'text',text:error.message}],isError:true});else await send(request.id,null,error);}catch{process.exitCode=1;process.stdin.destroy();}}})();
}
