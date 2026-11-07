const sequences={idle:{frames:[56,57,58,59],durations:[240,240,240,240]},'hammer-strike':{frames:[48,49,50,51,52,53,54,55],durations:[160,110,180,65,100,120,110,160]}};
for(const[i,d]of ['south','southwest','west','northwest','north','northeast','east','southeast'].entries())sequences['walk-'+d]={frames:Array.from({length:6},(_,j)=>i*6+j),durations:Array(6).fill(110)};
export class Sprite{
 constructor(canvas){this.canvas=canvas;this.context=canvas.getContext('2d');this.context.imageSmoothingEnabled=false;this.image=new Image();this.image.src='../assets/hephaestus-sprites/sheets/hephaestus-atlas.png';this.name='idle';this.index=0;this.image.onload=()=>this.tick();}
 animate(name){if(name===this.name)return;this.name=sequences[name]?name:'idle';this.index=0;}
 tick(){const a=sequences[this.name],f=a.frames[this.index%a.frames.length];this.context.clearRect(0,0,64,80);this.context.drawImage(this.image,(f%8)*64,Math.floor(f/8)*80,64,80,0,0,64,80);this.index++;this.timer=setTimeout(()=>this.tick(),a.durations[(this.index-1)%a.durations.length]);}
}
