import{readFile,writeFile}from'node:fs/promises';import{join}from'node:path';
const path=join(process.env.APPDATA,'Screen Companion/settings.json');const s=JSON.parse(await readFile(path,'utf8'));
const authored=new Set(['Describe the application you can see in one short sentence.','In the input verification window, click the Increment button exactly once and tell me the new click count.','Verify my prompt.','Draw a mint circle at screenshot coordinate (500, 300), radius 45. Then move your attention mascot near that circle. Use your drawing and attention tools.']);
let remove=false,count=0;s.messages=(s.messages??[]).filter(m=>{if(m.role==='user')remove=authored.has(m.text);if(remove){count++;return false;}return true;});if(count)delete s.threadId;
await writeFile(path,JSON.stringify(s,null,2));console.log(`Removed ${count} verification messages; other conversation messages are preserved.`);
