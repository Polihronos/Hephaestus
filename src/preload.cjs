const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('companion',{
  request:(command,params)=>ipcRenderer.invoke('companion:request',{command,params}),
  onEvent:callback=>{const handler=(_,payload)=>callback(payload.event,payload.data);ipcRenderer.on('companion:event',handler);return()=>ipcRenderer.removeListener('companion:event',handler);},
});
