class MicrophoneCapture extends AudioWorkletProcessor {
  constructor(){super();this.buffer=new Float32Array(320);this.index=0;}
  process(inputs,outputs){
    const samples=inputs[0]?.[0];if(!samples)return true;
    for(let i=0;i<samples.length;i++){
      this.buffer[this.index++]=samples[i];
      if(this.index===320){let sum=0;for(const v of this.buffer)sum+=v*v;this.port.postMessage({samples:this.buffer,rms:Math.sqrt(sum/320)},[this.buffer.buffer]);this.buffer=new Float32Array(320);this.index=0;}
    }
    // Keep the graph alive without playing microphone audio back to the user.
    for(const channel of outputs[0]??[])channel.fill(0);
    return true;
  }
}
registerProcessor('microphone-capture',MicrophoneCapture);
