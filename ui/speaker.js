// Keep speech on the always-visible mascot, independent of the input bubble's lifecycle.
export function createSpeaker(request){
 let state={},buffer='',epoch=0,spokenCount=0,lastError=null;
 const retained=new Set();
 function silence(){epoch++;buffer='';speechSynthesis.cancel();retained.clear();request('talking',{active:false}).catch(()=>{});}
 function configure(next){const stop=state.spokenReplies&&!next.spokenReplies;state=next;if(stop)silence();}
 function speak(raw){
  const text=String(raw).replace(/```[\s\S]*?```/g,'Code is shown in the conversation.').replace(/[*#`]/g,'').replace(/\[([^\]]+)\]\([^)]+\)/g,'$1').trim();
  if(!text||!state.spokenReplies||state.dictating||state.hearing)return;
  const token=epoch,u=new SpeechSynthesisUtterance(text),voices=speechSynthesis.getVoices().filter(v=>v.localService);
  u.voice=voices.find(v=>v.name===state.voice)??voices.find(v=>v.lang.toLowerCase().startsWith('en'))??null;u.rate=1.08;retained.add(u);
  u.onstart=()=>{if(token!==epoch)return;lastError=null;spokenCount++;request('talking',{active:true,text}).catch(()=>{});};
  const finish=e=>{retained.delete(u);if(token!==epoch)return;if(e.error&&!['canceled','interrupted'].includes(e.error))lastError=e.error;if(!speechSynthesis.pending)request('talking',{active:false,error:lastError}).catch(()=>{});};
  u.onend=finish;u.onerror=finish;speechSynthesis.speak(u);
 }
 function delta(text){buffer+=text;let match;while((match=buffer.match(/^([\s\S]*?[.!?](?:\s|$))/))){speak(match[1]);buffer=buffer.slice(match[1].length);}}
 function flush(){speak(buffer);buffer='';}
 function inspect(){return {spokenCount,lastError,localVoices:speechSynthesis.getVoices().filter(v=>v.localService).length,pending:speechSynthesis.pending,speaking:speechSynthesis.speaking,enabled:state.spokenReplies,dictating:state.dictating??false,retained:retained.size};}
 speechSynthesis.getVoices();return {configure,delta,flush,silence,speak,inspect};
}
