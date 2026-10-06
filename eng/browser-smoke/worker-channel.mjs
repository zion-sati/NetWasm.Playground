import { browserName, browserType } from './engine.mjs';
import { writeFile } from 'node:fs/promises';
const browser = await browserType.launch({headless:true});
try {
 const page=await browser.newPage(); const pageErrors=[]; page.on('pageerror',error=>pageErrors.push(String(error))); await page.goto(process.env.PLAYGROUND_URL ?? 'http://127.0.0.1:5173/playground/');
 const results=await page.evaluate(async()=>{
  const {WorkerChannel}=await import(new URL('src/worker-channel.ts', location.href).href);
  const url=URL.createObjectURL(new Blob([`self.onmessage=({data})=>{if(data.operation==='loop'){postMessage({id:data.id,guestEntered:true});while(true){}}else if(data.operation==='repeat'){postMessage({id:data.id,guestEntered:true});setInterval(()=>postMessage({id:data.id,guestEntered:true}),10)}else if(data.operation==='silent'){}else postMessage({id:data.id,result:{value:data.value}})}`],{type:'text/javascript'}));
  const channel=new WorkerChannel(new URL(url),()=>{});const results=[];
  for(const [operation,timeout,executionTimeout,expected] of [['loop',1000,80,'Guest execution time limit exceeded'],['repeat',1000,80,'Guest execution time limit exceeded'],['silent',80,undefined,'Browser stage timeout']]){
   const started=performance.now();let failure;try{await channel.request({operation},[],timeout,executionTimeout)}catch(e){failure=e.message}
   if(failure!==expected)throw Error(`${operation}: ${failure}`);
   const recovery=await channel.request({operation:'success',value:42},[],1000);
   if(recovery.value!==42)throw Error('Recovery failed');results.push({operation,failure,milliseconds:performance.now()-started,recovery});
  }
  const pending=channel.request({operation:'silent'},[],1000);channel.reset();try{await pending;throw Error('Stop accepted')}catch(e){if(e.message!=='Stopped')throw e}
  results.push({operation:'stop',recovery:await channel.request({operation:'success',value:43},[],1000)});channel.reset();URL.revokeObjectURL(url);
  const missing=new WorkerChannel(new URL(`missing-worker-module-${Date.now()}.mjs`,location.href),()=>{});let failure;
  try{await missing.request({operation:'initialize'},[],1000)}catch(e){failure=e.message}
  missing.reset();if(!failure?.startsWith('Worker module failed:'))throw Error(`Module failure was not reported through the channel: ${failure}`);
  results.push({operation:'module-load',failure});return results;
 });
 await page.waitForTimeout(100);if(pageErrors.length)throw Error(`${browserName} page errors: ${JSON.stringify(pageErrors)}`);
 if (process.env.PLAYGROUND_CHANNEL_RESULT) await writeFile(process.env.PLAYGROUND_CHANNEL_RESULT,JSON.stringify(results,null,2)); console.log(JSON.stringify(results));
}finally{await browser.close()}
