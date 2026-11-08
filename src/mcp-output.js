export async function writeMcpResponse(output,message){
 await new Promise((resolve,reject)=>{try{output.write(JSON.stringify(message)+'\n',error=>error?reject(error):resolve());}catch(error){reject(error);}});
}
