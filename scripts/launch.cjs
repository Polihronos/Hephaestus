const {spawn}=require('node:child_process');
const path=require('node:path');
const root=path.join(__dirname,'..');
const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
const child=spawn(require('electron'),[root,...process.argv.slice(2)],{cwd:root,env,windowsHide:true,stdio:'inherit'});
child.on('error',error=>{console.error(error.message);process.exitCode=1;});
child.on('exit',code=>{process.exitCode=code??1;});
