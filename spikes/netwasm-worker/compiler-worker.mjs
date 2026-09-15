import { dotnet } from './_framework/dotnet.js';
try {
 const runtime = await dotnet.create();
 const exports = await runtime.getAssemblyExports(runtime.getConfig().mainAssemblyName);
 const refBytes = new Uint8Array(await (await fetch('./target-reference.dll')).arrayBuffer());
 const reference = btoa(Array.from(refBytes, b => String.fromCharCode(b)).join(''));
 const witArray = new Uint8Array(await (await fetch("./compiler.wit.wasm")).arrayBuffer());
 const witBytes = btoa(Array.from(witArray, b => String.fromCharCode(b)).join(""));
 const witJson = await (await fetch("./compiler-wit.json")).text();
 const implBytes = new Uint8Array(await (await fetch('./target-implementation.dll')).arrayBuffer());
 const implementation = btoa(Array.from(implBytes, b => String.fromCharCode(b)).join(''));
 const support = await (await fetch('./support.json')).text();
 const runtimeManifest = await (await fetch('./runtime-pack.json')).text();
 self.onmessage = ({data}) => {
  if (data.schemaVersion !== 1 || data.recipe !== 'hello') {
    self.postMessage({id:data.id, result:{success:false, stage:'request', code:'unsupported-recipe', diagnostics:[],recoverable:true}});
    return;
  }
  try {
    const result = JSON.parse(exports.NetWasm.Playground.CompilerProbe.Program.Compile(
      data.source, reference, support, implementation, witJson, witBytes, runtimeManifest));
    result.hostLinearMemoryBytes = runtime.Module?.HEAPU8?.buffer?.byteLength ?? null;
    self.postMessage({id:data.id, result});
  }
  catch (error) { self.postMessage({id:data.id, error:String(error?.stack ?? error?.message ?? JSON.stringify(error))}); }
 };
 self.postMessage({ ready:true });
} catch(error) { self.postMessage({fatal:String(error?.stack ?? error?.message ?? JSON.stringify(error))}); }
