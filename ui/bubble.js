import{renderMarkdown}from'./markdown.js';
const request=window.companion.request,text=document.getElementById('bubble-text'),mode=document.getElementById('bubble-mode'),dots=document.getElementById('thinking-dots'),wave=document.getElementById('speech-wave');
let state={},generation=-1,pending='',renderFrame=0,activeTool=null;
function display(value){pending=value;if(renderFrame)return;renderFrame=requestAnimationFrame(()=>{renderFrame=0;renderMarkdown(text,pending);});}
function render(s){state=s;const thinking=s.busy&&!s.background&&!s.speaking;mode.textContent=s.speaking?'Speaking':activeTool?'Using '+activeTool:thinking?'Thinking':'Here with you';dots.hidden=!thinking;wave.hidden=!s.speaking;document.body.classList.toggle('talking',!!s.speaking);document.body.classList.toggle('thinking',thinking);}
window.companion.onEvent((event,data)=>{
 if(event==='state')render(data);
 if(event==='responseStart'){generation=data.generation;display('');}
 if(event==='activity'&&data.kind==='tool'&&!data.background){activeTool=data.status==='running'?data.title:null;render(state);}
 if(event==='delta'){if(data.generation<generation)return;generation=data.generation;display(data.full);}
 if(event==='message'&&data.role==='assistant')display(data.toolWarning?'Action failed: '+data.toolWarning+'\n\n'+data.text:data.text);
 if(event==='placement'){document.body.classList.toggle('below',data.below);document.documentElement.style.setProperty('--tail',data.tail+'px');}
});
let lastHeight=0;new ResizeObserver(()=>{const height=document.getElementById('answer-bubble').offsetHeight;if(height!==lastHeight){lastHeight=height;request('bubble-size',{height});}}).observe(document.getElementById('answer-bubble'));
const initial=await request('init');render(initial.state);const m=initial.messages.filter(m=>m.role==='assistant').at(-1);if(m)display(m.text);
window.hephaestusBubbleInspect=()=>({text:pending,renderedText:text.textContent,thinking:!dots.hidden,talking:!wave.hidden,hasInput:!!document.querySelector('input,textarea'),cardCount:document.querySelectorAll('#answer-bubble').length});
