import { dotnet } from './_framework/dotnet.js';
try {
 const runtime = await dotnet.create();
 const exports = await runtime.getAssemblyExports(runtime.getConfig().mainAssemblyName);
 const refBytes = new Uint8Array(await (await fetch('./target-reference.dll')).arrayBuffer());
 const reference = btoa(Array.from(refBytes, b => String.fromCharCode(b)).join(''));
 const support = await (await fetch('./support.json')).text();
 self.onmessage = ({data}) => {
  try { self.postMessage({ id:data.id, result:JSON.parse(exports.NetWasm.Playground.CompilerProbe.Program.Compile(data.source, reference, support)) }); }
  catch (error) { self.postMessage({id:data.id, error:String(error?.stack ?? error?.message ?? JSON.stringify(error))}); }
 };
 self.postMessage({ ready:true });
} catch(error) { self.postMessage({fatal:String(error?.stack ?? error?.message ?? JSON.stringify(error))}); }
