import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
const delay=ms=>new Promise(r=>setTimeout(r,ms));
export async function appSelfCheck({window,companion,root}){
  await mkdir(join(root,'artifacts'),{recursive:true});
  const started=Date.now();
  while((companion.state.connection!=='connected'||companion.state.speech!=='ready')&&Date.now()-started<45000)await delay(100);
  const report={date:new Date().toISOString(),connection:companion.state.connection,plan:companion.state.plan,speech:companion.state.speech,speechModel:companion.state.speechModel};
  try{
    await window.webContents.executeJavaScript("document.getElementById('start').click()");
    await delay(1800);
    report.before=await window.webContents.executeJavaScript('window.screenCompanionInspect()');
    if(!report.before.microphoneActive)throw new Error('The microphone could not be opened');
    const samples=(await readFile(join(root,'artifacts','stop.f32'))).toString('base64');
    report.audioPipeline=await window.webContents.executeJavaScript(`window.screenCompanionTestAudio(${JSON.stringify(samples)})`);
    await delay(1600);
    report.voiceStopConfirmed=companion.messages.some(m=>m.role==='user'&&/^stop now[.!]?$/i.test(m.text));
    const question=(await readFile(join(root,'artifacts','math.f32'))).toString('base64');
    const questionStart=Date.now();const messageCount=companion.messages.length;
    await window.webContents.executeJavaScript(`window.screenCompanionTestAudio(${JSON.stringify(question)})`);
    while(!companion.messages.slice(messageCount).some(m=>m.role==='assistant')&&Date.now()-questionStart<25000)await delay(100);
    report.voiceQuestion=companion.messages.slice(messageCount).filter(m=>m.role==='user'||m.role==='assistant').map(m=>({role:m.role,text:m.text}));
    report.voiceQuestionTotalMs=Date.now()-questionStart;
    await delay(500);
    report.after=await window.webContents.executeJavaScript('window.screenCompanionInspect()');
    report.tts=await window.webContents.executeJavaScript('window.screenCompanionTestVoice()');
    report.passed=report.voiceStopConfirmed&&report.after.microphoneActive&&report.tts.started===true&&report.voiceQuestion.some(m=>m.role==='assistant'&&/5|five/i.test(m.text));
  }catch(error){report.error=error.message;report.passed=false;}
  const image=await window.webContents.capturePage();await writeFile(join(root,'artifacts','screen-companion.png'),image.toPNG());
  await writeFile(join(root,'artifacts','app-self-check.json'),JSON.stringify(report,null,2));
  console.log('APP_SELF_CHECK '+JSON.stringify(report));
  return report;
}
