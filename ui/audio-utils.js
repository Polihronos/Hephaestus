export class VoiceActivity {
  constructor({threshold=0.012,silenceMs=500,frameMs=20,maxMs=24000,onStart=()=>{},onEnd=()=>{},onCancel=()=>{}}={}) {
    Object.assign(this,{threshold,silenceMs,frameMs,maxMs,onStart,onEnd,onCancel});this.reset();
  }
  reset(){this.pre=[];this.frames=[];this.active=false;this.voiced=0;this.quiet=0;this.noise=0.002;this.candidate=0;}
  push(frame,rms) {
    const isVoice=rms>Math.max(this.threshold,this.noise*3.8);
    if(!this.active){
      this.pre.push(frame);if(this.pre.length>10)this.pre.shift();
      this.candidate=isVoice?this.candidate+1:0;
      if(!isVoice)this.noise=this.noise*.98+Math.min(rms,0.008)*.02;
      if(this.candidate>=3){this.active=true;this.frames=this.pre.slice();this.voiced=3;this.quiet=0;this.onStart();}
      return;
    }
    this.frames.push(frame);if(isVoice){this.voiced++;this.quiet=0;}else this.quiet++;
    if(this.quiet*this.frameMs>=this.silenceMs||this.frames.length*this.frameMs>=this.maxMs){
      const frames=this.frames;const valid=this.voiced*this.frameMs>=160;this.reset();
      if(valid){let count=0;for(const f of frames)count+=f.length;const audio=new Float32Array(count);let i=0;for(const f of frames){audio.set(f,i);i+=f.length;}this.onEnd(audio);}
      else this.onCancel();
    }
  }
}

export function spokenText(text){return text.replace(/```[\s\S]*?```/g,' Code is shown in the conversation. ').replace(/\[([^\]]+)\]\([^)]+\)/g,'$1').replace(/[*#`_]/g,'').replace(/\s+/g,' ').trim();}
