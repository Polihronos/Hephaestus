import {T3Client} from '../src/t3-client.js';
import {writeFile} from 'node:fs/promises';
const client=new T3Client();
try{await client.start();console.log('Connected to local T3');const config=await client.call('server.getConfig',{});await writeFile('artifacts/t3-contracts/config.json',JSON.stringify(config,null,2));console.log(JSON.stringify({keys:Object.keys(config),providers:config.providers?.map(p=>({id:p.instanceId,driver:p.driverKind,status:p.status,models:p.models?.filter(m=>/luna/.test(m.id??m.slug??''))}))}));console.log('T3 runtime protocol',config.environment.orchestrationProtocolVersion);}catch(e){console.error(e.message);process.exitCode=1;}finally{await client.close();}
