// A failed intentional voice request must be recoverable outside the hidden input.
export async function preserveFailedVoiceInput(companion,{text,source,error,startedAt}){
  if(!['voice','wispr'].includes(source))throw new TypeError('Voice recovery requires an intentional voice source');
  if(typeof text!=='string'||!text.trim())return null;
  const existing=[...companion.messages].reverse().find(message=>message.role==='user'&&message.source===source&&message.text===text&&message.at>=startedAt&&message.delivery==='failed');
  const message=existing??companion.message('user',text,{source,delivery:'failed',deliveryError:error?.message??String(error)});
  await companion.save();
  return message;
}
