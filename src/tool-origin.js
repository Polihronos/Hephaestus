import {createHash,createHmac,randomBytes,timingSafeEqual} from 'node:crypto';

export const TOOL_ORIGIN_FIELD='__hephaestusOrigin';
export const TOOL_ORIGIN_MAX_AGE_MS=5*60*1000;
const CLOCK_SKEW_MS=10000;
const PROOF_KEYS=['version','nativeSessionId','nativeTurnId','toolUseId','tool','argsHash','nonce','issuedAt','signature'];
const HEX_256=/^[a-f0-9]{64}$/;
const invalid=()=>new Error('The tool request has no valid originating turn.');
const record=value=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&(Object.getPrototypeOf(value)===Object.prototype||Object.getPrototypeOf(value)===null);
const identifier=value=>typeof value==='string'&&value.length>0&&value.length<=512&&value.trim()===value&&!/[\u0000-\u001f\u007f]/.test(value);
const toolName=value=>typeof value==='string'&&/^[a-z][a-z0-9_]{0,127}$/.test(value);

function canonicalJson(value,depth=0){
 if(depth>100)throw invalid();
 if(value===null||typeof value==='string'||typeof value==='boolean')return JSON.stringify(value);
 if(typeof value==='number'&&Number.isFinite(value))return JSON.stringify(value);
 if(Array.isArray(value))return '['+Array.from(value,item=>canonicalJson(item,depth+1)).join(',')+']';
 if(record(value))return '{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonicalJson(value[key],depth+1)).join(',')+'}';
 throw invalid();
}

/** The proof is transport data, never part of a desktop or workspace tool's arguments. */
export function stripToolOrigin(args){
 if(!record(args))throw invalid();
 return Object.fromEntries(Object.entries(args).filter(([key])=>key!==TOOL_ORIGIN_FIELD));
}

export function canonicalToolArguments(args){return canonicalJson(stripToolOrigin(args));}

function signingKey(secret){
 if(typeof secret!=='string'||Buffer.byteLength(secret,'utf8')<32||secret.length>4096)throw invalid();
 return secret;
}

function payloadFrom(proof){
 if(!record(proof)||Object.keys(proof).length!==PROOF_KEYS.length||PROOF_KEYS.some(key=>!Object.hasOwn(proof,key)))throw invalid();
 const {version,nativeSessionId,nativeTurnId,toolUseId,tool,argsHash,nonce,issuedAt}=proof;
 if(version!==1||![nativeSessionId,nativeTurnId,toolUseId].every(identifier)||!toolName(tool)||!HEX_256.test(argsHash)||typeof nonce!=='string'||!/^[A-Za-z0-9_-]{22,128}$/.test(nonce)||!Number.isSafeInteger(issuedAt)||issuedAt<=0||!HEX_256.test(proof.signature))throw invalid();
 return {version,nativeSessionId,nativeTurnId,toolUseId,tool,argsHash,nonce,issuedAt};
}

function signatureFor(payload,secret){return createHmac('sha256',signingKey(secret)).update(canonicalJson(payload)).digest('hex');}

/** Sign the IDs supplied by Codex's hook event, never the companion's current run. */
export function signToolOrigin({secret,tool,args,nativeSessionId,nativeTurnId,toolUseId,issuedAt=Date.now(),nonce=randomBytes(24).toString('base64url')}){
 const payload={version:1,nativeSessionId,nativeTurnId,toolUseId,tool,argsHash:createHash('sha256').update(canonicalToolArguments(args)).digest('hex'),nonce,issuedAt};
 const proof={...payload,signature:signatureFor(payload,secret)};
 payloadFrom(proof);
 return Object.freeze(proof);
}

/** Cryptographic validation only. The caller must also reject replayed or revoked origins. */
export function verifyToolOrigin({secret,tool,args,proof=args?.[TOOL_ORIGIN_FIELD],now=Date.now(),maxAgeMs=TOOL_ORIGIN_MAX_AGE_MS,clockSkewMs=CLOCK_SKEW_MS}){
 const payload=payloadFrom(proof);
 const expected=Buffer.from(signatureFor(payload,secret),'hex');
 if(!timingSafeEqual(Buffer.from(proof.signature,'hex'),expected)||payload.tool!==tool||payload.argsHash!==createHash('sha256').update(canonicalToolArguments(args)).digest('hex'))throw invalid();
 if(!Number.isSafeInteger(now)||!Number.isSafeInteger(maxAgeMs)||maxAgeMs<0||!Number.isSafeInteger(clockSkewMs)||clockSkewMs<0)throw invalid();
 if(payload.issuedAt>now+clockSkewMs||now-payload.issuedAt>maxAgeMs)throw new Error('The tool request authorization has expired.');
 return Object.freeze(payload);
}
