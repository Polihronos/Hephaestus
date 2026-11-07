import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {homedir} from 'node:os';
export class Pricing {
 constructor(){this.rates={'gpt-6-luna':{input_cost_per_token:0.1/1e6,cache_read_input_token_cost:0.01/1e6,output_cost_per_token:0.5/1e6,cache_creation_input_token_cost:0.125/1e6,input_cost_per_token_above_272k_tokens:0.2/1e6,cache_read_input_token_cost_above_272k_tokens:0.02/1e6,cache_creation_input_token_cost_above_272k_tokens:0.25/1e6,output_cost_per_token_above_272k_tokens:0.75/1e6}};this.source='Official OpenAI model rates';this.asOf='2026-11-07';}
 async load(){try{const cache=JSON.parse(await readFile(join(process.env.T3CODE_HOME??join(homedir(),'.t3'),'userdata','usage-model-rates.json'),'utf8'));this.rates={...this.rates,...cache.document};this.source='T3 pricing catalog';this.asOf=new Date(cache.fetchedAtMs).toISOString();}catch{}return this;}
 cost(usage,model,contextTokens=0,serviceTier='default'){
  const rate=this.rates[model]??this.rates[model?.replace(/-\d{4}-\d{2}-\d{2}$/,'')];if(!rate)return null;
  const suffix=(contextTokens>272000?'_above_272k_tokens':'')+(serviceTier==='priority'?'_priority':'');
  const value=key=>rate[key+suffix]??rate[key];const input=value('input_cost_per_token'),cache=value('cache_read_input_token_cost')??input,output=value('output_cost_per_token');if(input===undefined||output===undefined)return null;
  const cached=Math.min(usage.inputTokens,usage.cachedInputTokens),writes=Math.min(usage.inputTokens-cached,usage.cacheCreationTokens??0),fresh=Math.max(0,usage.inputTokens-cached-writes),categories={input:fresh*input,cacheRead:cached*cache,cacheWrite:writes*(value('cache_creation_input_token_cost')??input),output:usage.outputTokens*output};
  return{usd:categories.input+categories.cacheRead+categories.cacheWrite+categories.output,cacheSavingsUsd:cached*(input-cache),categories};
 }
}
