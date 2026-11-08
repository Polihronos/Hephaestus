import {resolveCodexLauncher} from '../src/codex-launcher.js';
try{await resolveCodexLauncher(process.argv[2]??'codex');console.log('Codex launcher is supported.');}
catch(error){console.error(error.message);process.exitCode=1;}
