import {mkdir,copyFile} from 'node:fs/promises';
await mkdir('ui/vendor',{recursive:true});
for(const[source,destination]of [['node_modules/marked/lib/marked.esm.js','marked.js'],['node_modules/dompurify/dist/purify.es.mjs','purify.js'],['node_modules/marked/LICENSE','marked.LICENSE.md'],['node_modules/dompurify/LICENSE','purify.LICENSE']])await copyFile(source,'ui/vendor/'+destination);
