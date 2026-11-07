export function createDictation(input,request,{manual=false,onError=()=>{}}={}){
 let state={},armed=false,released=true,baseline='',timer;
 function cancel(){armed=false;released=true;clearTimeout(timer);}
 async function submit(source='text'){clearTimeout(timer);const text=input.value.trim();if(!text)return;try{const r=await request('send',{text,source});if(r?.accepted){input.value='';cancel();}}catch(e){onError(e);}}
 function maybeSend(){clearTimeout(timer);if(!armed||!released||!state.autoSend||!input.value.trim()||input.value.trim()===baseline.trim())return;timer=setTimeout(()=>submit('wispr'),120);}
 function event(name,data){if(name==='state')state=data;if(name==='focusDictation')input.focus();if(name==='dictation'){armed=data.armed;released=!armed;if(armed){baseline=input.value;input.focus();}else clearTimeout(timer);}if(name==='dictationReleased'){released=true;maybeSend();}}
 input.addEventListener('paste',()=>{if(armed){released=true;request('dictation-complete').catch(onError);}});input.addEventListener('input',maybeSend);
 if(manual)input.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();submit(armed?'wispr':'text');}});
 return{event,submit,inspect:()=>({armed,released,value:input.value})};
}
