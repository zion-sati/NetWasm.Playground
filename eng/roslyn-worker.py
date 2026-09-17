#!/usr/bin/env python3
"""Build and exercise the interpreter-first Roslyn worker against a desktop receipt."""

import argparse
import functools
import hashlib
import http.server
import json
import os
from pathlib import Path
import shutil
import subprocess
import threading
import time
import zipfile
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parent.parent


def fingerprint(path):
    return {"bytes": path.stat().st_size, "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}


def verify(run):
    receipt = json.loads((run / "receipt.json").read_text())
    for relative, expected in receipt["files"].items():
        if fingerprint(run / relative) != expected:
            raise RuntimeError(f"Browser evidence changed: {relative}")
    result = json.loads((run / "worker-test.json").read_text())
    for index, compilation in enumerate(result["results"]):
        if compilation["success"]:
            pe = fingerprint(run / f"managed-{index}.dll")
            if pe != {"bytes": compilation["bytes"], "sha256": compilation["sha256"]}:
                raise RuntimeError("Managed output does not match browser result")
            if "applicationSha256" in compilation:
                module = fingerprint(run / f"application-{index}.wasm")
                if module != {"bytes": compilation["applicationBytes"],
                              "sha256": compilation["applicationSha256"]}:
                    raise RuntimeError("Application module does not match browser result")
    if "desktopComparison" in receipt:
        comparison = receipt["desktopComparison"]
        first = result["results"][0]
        if first["applicationSha256"] != comparison["applicationSha256"]:
            raise RuntimeError("Browser application differs from desktop fixture")
        if camel_case(first["interopManifest"]) != comparison["interopManifest"]:
            raise RuntimeError("Browser interop manifest differs from desktop fixture")
        if first["staticDataEnd"] != comparison["staticDataEnd"]:
            raise RuntimeError("Browser static data differs from desktop fixture")
        inputs = json.loads((run / "inputs.json").read_text())
        if inputs.get("expectedRuntimePlan"):
            plan = camel_case(first["runtimeLinkPlan"])
            if plan["arguments"] != inputs["expectedRuntimePlan"]["arguments"] or plan["inputs"] != inputs["expectedRuntimePlan"]["inputs"]:
                raise RuntimeError("Browser runtime plan differs from captured desktop linker policy")
    if (run / "trusted-worker-test.json").exists():
        trusted = json.loads((run / "trusted-worker-test.json").read_text())
        if [[item["success"] for item in group["results"]] for group in trusted["groups"]] != [[True, True], [True, True, False, True]]:
            raise RuntimeError("Trusted generator success/failure/recovery evidence changed")
    if (run / "memory-test.json").exists():
        memory = json.loads((run / "memory-test.json").read_text())
        compilations = [item for item in memory["results"] if item["kind"] == "compile"]
        invalid = [item for item in memory["results"] if item["kind"] == "invalid-setting"]
        if not memory["passed"] or memory["configuredMaximumBytes"] != 268435456 or \
                [item["success"] for item in compilations] != [True, False, True] or \
                len(invalid) != 4 or not all(item["rejected"] for item in invalid) or \
                any(item["runtimeMemory"]["maximumPages"] != 4096 for item in compilations if item["success"]):
            raise RuntimeError("Configured guest memory and recovery evidence changed")
    if (run / "di-test.json").exists():
        di = json.loads((run / "di-test.json").read_text())
        results = di["results"]
        if not di["passed"] or [item["success"] for item in results] != [True, False, True] or \
                not any(item["code"] == "NWDI002" for item in results[1]["diagnostics"]):
            raise RuntimeError("Trusted DI generator failure and recovery evidence changed")
        for index in (0, 2):
            for field, suffix in (("pe", "dll"), ("application", "wasm")):
                if fingerprint(run / f"di-{index}.{suffix}") != {
                        "bytes": results[index][field + "Bytes"], "sha256": results[index][field + "Sha256"]}:
                    raise RuntimeError("DI output does not match browser result")
    print("PASS: browser fixture hashes and managed output match", flush=True)


def camel_case(value):
    if isinstance(value, dict):
        return {key[0].lower() + key[1:]: camel_case(item) for key, item in value.items()}
    if isinstance(value, list):
        return [camel_case(item) for item in value]
    return value


def verified_package_member(directory, relative):
    """Return a receipt-bound extraction after matching its public package archive."""
    relative = Path(relative)
    parts = relative.parts
    if relative.is_absolute() or len(parts) < 4 or parts[0] != "packages" or \
            any(part in ("", ".", "..") for part in parts):
        raise RuntimeError("Unapproved trusted package path")
    package_id, version = parts[1:3]
    if not package_id or not version:
        raise RuntimeError("Unapproved trusted package path")
    archive = directory / "packages" / package_id / version / f"{package_id}.{version}.nupkg"
    try:
        with zipfile.ZipFile(archive) as package:
            original = package.read("/".join(parts[3:]))
    except (FileNotFoundError, KeyError, zipfile.BadZipFile) as error:
        raise RuntimeError("Trusted input is absent from its public package archive") from error
    path = directory / relative
    if not path.is_file() or path.read_bytes() != original:
        raise RuntimeError("Trusted extracted input differs from public archive")
    return path


def prepare_trusted_inputs(json_run, tunit_run, run, di_run=None):
    """Snapshot only approved package executables and separately identify guest metadata."""
    for directory in (json_run, tunit_run, *([di_run] if di_run else [])):
        receipt = json.loads((directory / "receipt.json").read_text())
        for relative, expected in receipt["files"].items():
            if fingerprint(directory / relative) != expected:
                raise RuntimeError("Trusted recipe receipt changed")
    json_recipe = json.loads((json_run / "json-generated/recipe-inputs.json").read_text())
    tunit_recipe = json.loads((tunit_run / "recipe-inputs.json").read_text())
    di_recipe = json.loads((di_run / "di/recipe-inputs.json").read_text()) if di_run else None
    generators = {
        "System.Text.Json.SourceGeneration": verified_package_member(
            json_run,
            f"packages/netwasm.system.text.json/{json_recipe['version']}/analyzers/dotnet/cs/System.Text.Json.SourceGeneration.dll"),
        "TUnit.Core.SourceGenerator": verified_package_member(tunit_run, tunit_recipe["trustedGenerator"]),
    }
    if di_run and di_recipe:
        generators["NetWasm.Microsoft.Extensions.DependencyInjection.Generator"] = verified_package_member(
            di_run,
            f"packages/netwasm.microsoft.extensions.dependencyinjection/{di_recipe['version']}/analyzers/dotnet/cs/NetWasm.Microsoft.Extensions.DependencyInjection.Generator.dll")
    approved = run / "approved-generators"
    approved.mkdir()
    for name, path in list(generators.items()):
        shutil.copyfile(path, approved / (name + ".dll"))
        generators[name] = approved / (name + ".dll")
    program = verified_package_member(tunit_run, tunit_recipe["generatedProgram"])
    json_libraries = {name: verified_package_member(json_run, relative) for name, relative in json_recipe["libraries"].items()}
    tunit_references = {}
    tunit_implementations = {}
    for entry in tunit_recipe["libraries"].values():
        for kind, destination in (("compile", tunit_references), ("runtime", tunit_implementations)):
            for relative in entry.get(kind, []):
                if Path(relative).name != "NetWasm.CoreLib.dll":
                    destination[Path(relative).name] = verified_package_member(tunit_run, relative)
    result = {"generators": generators, "program": program.read_text(), "recipes": {
        "json": {"source": (json_run / "json-generated/Program.cs").read_text(), "support": json_recipe["support"], "references": json_libraries, "implementations": json_libraries},
        "tunit": {"source": (tunit_run / "cases/template/Tests.cs").read_text(), "secondSource": (tunit_run / "cases/second-test/Tests.cs").read_text(), "support": [{"path": "obj/Release/netwasm0.1/" + path.name, "text": path.read_text()} for path in sorted((tunit_run / "cases/template/obj").glob("*.cs"))], "references": tunit_references, "implementations": tunit_implementations},
    }}
    receipts = {"json": fingerprint(json_run / "receipt.json"), "tunit": fingerprint(tunit_run / "receipt.json")}
    if di_run:
        di_libraries = {name: verified_package_member(di_run, relative) for name, relative in di_recipe["libraries"].items()}
        result["recipes"]["di"] = {"source": (di_run / "di/Program.cs").read_text(), "support": di_recipe["support"],
            "references": di_libraries, "implementations": di_libraries}
        receipts["di"] = fingerprint(di_run / "receipt.json")
    (run / "trusted-inputs.json").write_text(json.dumps({
        "receipts": receipts,
        "generatorArchivesMatch": True, "targetMetadataArchivesMatch": True,
        "generators": {name: fingerprint(path) for name, path in generators.items()}, "program": fingerprint(program),
        "recipes": {name: {"references": {key: fingerprint(path) for key, path in recipe["references"].items()}, "implementations": {key: fingerprint(path) for key, path in recipe["implementations"].items()}} for name, recipe in result["recipes"].items()},
    }, indent=2))
    return result


def stage_trusted_inputs(trusted, web):
    recipes = {}
    for name, recipe in trusted["recipes"].items():
        staged = {"source": recipe["source"], "support": recipe["support"]}
        if "secondSource" in recipe:
            staged["secondSource"] = recipe["secondSource"]
        for kind in ("references", "implementations"):
            staged[kind] = {}
            for key, path in recipe[kind].items():
                relative = "trusted/" + name + "/" + kind + "/" + key
                destination = web / relative
                destination.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(path, destination)
                staged[kind][key] = relative
        recipes[name] = staged
    (web / "trusted-recipes.json").write_text(json.dumps(recipes, indent=2))
    (web / "trusted-worker.mjs").write_text(TRUSTED_WORKER)


TRUSTED_WORKER = r'''
import { dotnet } from './_framework/dotnet.js';
const base64 = bytes => btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join(''));
const load = async path => base64(new Uint8Array(await (await fetch(path)).arrayBuffer()));
try {
 const runtime = await dotnet.create();
 const exports = await runtime.getAssemblyExports(runtime.getConfig().mainAssemblyName);
 const api = exports.NetWasm.Playground.CompilerProbe.Program;
 const reference = await load('target-reference.dll');
 const implementation = await load('target-implementation.dll');
 const wit = await load('compiler.wit.wasm');
 const witJson = await (await fetch('compiler-wit.json')).text();
 const manifest = await (await fetch('runtime-pack.json')).text();
 const recipes = await (await fetch('trusted-recipes.json')).json();
 for(const recipe of Object.values(recipes)) for(const kind of ['references','implementations']) {
   recipe[kind] = Object.fromEntries(await Promise.all(Object.entries(recipe[kind]).map(async ([key,path])=>[key,await load(path)])));
 }
 self.onmessage = ({data}) => {
  const recipe = recipes[data.recipe];
  try {
   const result = JSON.parse(api.CompileGeneratedRecipe(data.source, reference, JSON.stringify(recipe.support), implementation,
     witJson, wit, manifest, JSON.stringify(recipe.references), JSON.stringify(recipe.implementations), data.recipe, data.evidence));
   result.hostLinearMemoryBytes = runtime.Module?.HEAPU8?.buffer?.byteLength ?? null;
   self.postMessage({id:data.id,result});
  } catch(error) { self.postMessage({id:data.id,error:String(error)}); }
 };
 self.postMessage({ready:true});
} catch(error) {self.postMessage({fatal:String(error)});}
'''

TRUSTED_TEST = r'''
import {chromium} from 'playwright';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
const browser = await chromium.launch({headless:true});
const page = await browser.newPage();
const groups=[]; const errors=[];
page.on('pageerror',error=>errors.push(String(error)));
const watchdog=setTimeout(()=>void browser.close(),240000);
const camel=value=>Array.isArray(value)?value.map(camel):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).map(([key,item])=>[key[0].toLowerCase()+key.slice(1),camel(item)])):value;
try {
 await page.goto(process.env.COMPILER_PROBE_URL);
 const recipes=await page.evaluate(async()=>await(await fetch('trusted-recipes.json')).json());
 const t=recipes.tunit.source;
 const invalid=t.replace('public async Task AnswerIsFortyTwo()', 'public int AnswerIsFortyTwo()').replace('await Assert.That(answer).IsEqualTo(42);','return answer;');
 for(const [recipe,sources] of [['json',[recipes.json.source,recipes.json.source.replace('Score = 42','Score = 43')]],['tunit',[t,recipes.tunit.secondSource,invalid,t]]]) {
  const results=await page.evaluate(async({recipe,sources})=>{
   const worker=new Worker('./trusted-worker.mjs',{type:'module'});
   try {
    await new Promise((resolve,reject)=>{worker.onmessage=({data})=>data.ready?resolve():data.fatal?reject(Error(data.fatal)):null;worker.onerror=event=>reject(Error(event.message));});
    const results=[];
    for(let id=0;id<sources.length;id++) {
     const started=performance.now();
     const result=await new Promise((resolve,reject)=>{worker.onmessage=({data})=>data.id===id?(data.error?reject(Error(data.error)):resolve(data.result)):null;worker.postMessage({id,recipe,source:sources[id],evidence:id===0});});
     results.push({...result,milliseconds:performance.now()-started});
    }
    return results;
   } finally {worker.terminate();}
  },{recipe,sources});
  for(let index=0;index<results.length;index++) {
   const result=results[index];const directory=`trusted-outputs/${recipe}-${index}`;mkdirSync(directory,{recursive:true});
   for(const [key,file] of [['pe','managed.dll'],['application','application.wasm']]) if(result[key]) {
    const bytes=Buffer.from(result[key],'base64');writeFileSync(`${directory}/${file}`,bytes);
    result[key+'Bytes']=bytes.length;result[key+'Sha256']=createHash('sha256').update(bytes).digest('hex');delete result[key];
   }
   for(const [sourceIndex,source] of (result.generatedSources??[]).entries()) if(source.text!==null) {
    const bytes=Buffer.from(source.text,'utf8');if(bytes.length!==source.bytes||createHash('sha256').update(bytes).digest('hex')!==source.sha256)throw Error('Generated source digest differs');
    writeFileSync(`${directory}/generated-${sourceIndex}.cs`,bytes);delete source.text;
   }
  }
  groups.push({recipe,results});writeFileSync('trusted-worker-test.json',JSON.stringify({browser:browser.version(),groups,errors},null,2));
  if(recipe==='json') {
   if(results.some(result=>!result.success)||!results[0].generatedSources.length||results[0].generatedSources.some(source=>source.producer!=='System.Text.Json.SourceGeneration.JsonSourceGenerator')||results[0].peSha256===results[1].peSha256||results[0].applicationSha256===results[1].applicationSha256)throw Error('Actual JSON generator compile/edit failed');
  } else {
   if(JSON.stringify(results.map(result=>result.success))!==JSON.stringify([true,true,false,true])||results[0].catalogCaseCount!==1||results[1].catalogCaseCount!==2||results[3].catalogCaseCount!==1||results[2].stage!=='generator'||!results[2].diagnostics.some(item=>item.code==='TUNIT1001')||results[2].peBytes||results[2].applicationBytes)throw Error('Actual TUnit catalog/failure/recovery failed');
   for(const result of results.filter(result=>result.success)) {
    const abi=camel(result.entryPoint).abi;
    if(abi.parameterShape!==1||abi.returnShape!==1||abi.completionShape!==1||camel(result.entryPoint).typeName!=='NetWasm.TUnit.Generated.NetWasmTestProgram'||!camel(result.coreLinkPlan).textModules.some(module=>module.text.includes('cm32p2|netwasm:runtime/process@1|start')))throw Error('Actual async TUnit entry/adapter plan differs');
   }
  }
 }
 if(errors.length)throw Error('Browser page error');
 console.log('PASS: actual JSON and TUnit generators; source-dependent outputs, generator failure, async entry and recovery');
} catch(error) {
 writeFileSync('trusted-worker-failure.json',JSON.stringify({error:String(error),groups,errors},null,2));throw error;
} finally {clearTimeout(watchdog);await browser.close();}
'''


TRUSTED_LIMIT_TEST = r'''
import {chromium} from 'playwright';
import {readFileSync,writeFileSync} from 'node:fs';
const record=JSON.parse(readFileSync('trusted-worker-test.json','utf8'));
const camel=value=>Array.isArray(value)?value.map(camel):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).map(([key,item])=>[key[0].toLowerCase()+key.slice(1),camel(item)])):value;
const tunit=record.groups.find(group=>group.recipe==='tunit');
if(JSON.stringify(tunit.results.map(result=>result.success))!==JSON.stringify([true,true,false,true]))throw Error('Retained TUnit outcomes differ');
for(const result of tunit.results.filter(result=>result.success)) {
 const entry=camel(result.entryPoint);
 if(entry.abi.parameterShape!==1||entry.abi.returnShape!==1||entry.abi.completionShape!==1||entry.typeName!=='NetWasm.TUnit.Generated.NetWasmTestProgram'||!camel(result.coreLinkPlan).textModules.some(module=>module.text.includes('cm32p2|netwasm:runtime/process@1|start')))throw Error('Retained authoritative async ABI exports differ');
}
const browser=await chromium.launch({headless:true});const page=await browser.newPage();
const watchdog=setTimeout(()=>void browser.close(),90000);
try {
 await page.goto(process.env.COMPILER_PROBE_URL);
 const oversized='using System;\nusing System.Text.Json.Serialization;\nConsole.WriteLine(42);\n'+Array.from({length:130},(_,index)=>`[JsonSerializable(typeof(Model${index}))]`).join('\n')+'\npublic partial class LimitContext : JsonSerializerContext {}\n'+Array.from({length:130},(_,index)=>`public sealed class Model${index} { public int Value {get;set;} }`).join('\n');
 const results=await page.evaluate(async sources=>{
  const worker=new Worker('./trusted-worker.mjs',{type:'module'});
  try {
   await new Promise((resolve,reject)=>{worker.onmessage=({data})=>data.ready?resolve():data.fatal?reject(Error(data.fatal)):null;worker.onerror=event=>reject(Error(event.message));});
   const results=[];
   for(let id=0;id<sources.length;id++) {
    const started=performance.now();
    const result=await new Promise((resolve,reject)=>{worker.onmessage=({data})=>data.id===id?(data.error?reject(Error(data.error)):resolve(data.result)):null;worker.postMessage({id,recipe:'json',source:sources[id],evidence:false});});
    delete result.pe;delete result.application;results.push({...result,milliseconds:performance.now()-started});
   }
   return results;
  } finally {worker.terminate();}
 },[oversized,'using System; Console.WriteLine(42);']);
 record.limits=results;writeFileSync('trusted-worker-test.json',JSON.stringify(record,null,2));
 if(results[0].success||results[0].stage!=='generator'||results[0].code!=='generated-output-limit'||!results[1].success||results[1].generatedSources.length)throw Error('Generated output cap/recovery differs');
 console.log('PASS: retained async ABI uses authoritative @1 exports; actual generator output limit and same-worker recovery');
} finally {clearTimeout(watchdog);await browser.close();}
'''


def finalize_evidence(run, baseline, compiler_package_version):
    web = run / "publish/wwwroot"
    app = run / "app"
    retained = [*web.rglob("*"), *app.glob("*"), *run.glob("managed-*.dll"),
                *run.glob("application-*.wasm"), *run.glob("*.json"), *run.glob("*.stdout"), *run.glob("*.stderr"), run / "test-worker.mjs",
                run / "test-trusted.mjs", run / "test-trusted-limit.mjs", *(run / "first-assertion-attempt").rglob("*"), *(run / "trusted-outputs").rglob("*"), *(run / "approved-generators").glob("*.dll"),
                *(run / "restore-assets").glob("*.json"),
                *(run / "packages").glob("*/*/*.nupkg")]
    evidence = {"schemaVersion": 1,
        "files": {str(path.relative_to(run)): fingerprint(path)
                  for path in retained if path.is_file()}}
    if compiler_package_version:
        desktop = baseline / "app/bin/Release/netwasm0.1"
        evidence["desktopComparison"] = {
            "applicationSha256": fingerprint(desktop / "NetWasmApp.core.wasm")["sha256"],
            "interopManifest": json.loads((desktop / "interop.json").read_text()),
            "staticDataEnd": json.loads((desktop / "runtime-layout.json").read_text())["applicationStaticDataEnd"]}
    (run / "receipt.json").write_text(json.dumps(evidence, indent=2))
    verify(run)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("desktop_baseline", type=Path)
    parser.add_argument("run_directory", type=Path)
    parser.add_argument("--verify", action="store_true")
    parser.add_argument("--compiler-package-version",
                        help="Exact publicly released NetWasm.Compiler.Browser package version")
    parser.add_argument("--roslyn-only", action="store_true",
                        help="Run only the historical Roslyn worker without NetWasm")
    parser.add_argument("--json-example", type=Path, help="Verified desktop JSON source-generation recipe")
    parser.add_argument("--tunit-example", type=Path, help="Verified ordinary dotnet test template comparison")
    parser.add_argument("--di-example", type=Path, help="Verified desktop DI recipe and its packaged trusted generator")
    parser.add_argument("--reuse-verified-host", type=Path,
                        help="Reuse a receipt-verified Playwright installation; Roslyn-only runs may also reuse its package cache")
    parser.add_argument("--skip-trusted-probes", action="store_true",
                        help="Run compiler compatibility checks without repeating the trusted generator matrix")
    args = parser.parse_args()
    baseline = args.desktop_baseline.resolve()
    run = args.run_directory.resolve()
    if args.verify:
        verify(run)
        return
    if bool(args.compiler_package_version) == args.roslyn_only:
        parser.error("choose exactly one of --compiler-package-version or --roslyn-only")
    reused_host = args.reuse_verified_host.resolve() if args.reuse_verified_host else None
    if reused_host:
        verify(reused_host)
        if not (reused_host / "packages").is_dir():
            raise RuntimeError("Verified host package cache is unavailable")
    subprocess.run(["python3", str(ROOT / "eng/desktop-baseline.py"), str(baseline), "--verify"], check=True)
    receipt = json.loads((baseline / "receipt.json").read_text())
    host = json.loads((ROOT / "eng/browser-host.json").read_text())
    runtime_option = "-p:RuntimeFrameworkVersion=" + host["runtimeFrameworkVersion"]
    run.mkdir(parents=True, exist_ok=False)
    if shutil.disk_usage(run).free < 100 * 1024 ** 3:
        raise RuntimeError("At least 100 GiB free space is required")
    app = run / "app"
    package_mode = args.compiler_package_version is not None
    fixture = ROOT / "spikes" / ("netwasm-worker" if package_mode else "roslyn-worker")
    package_options = []
    compiler_package_version = None
    if package_mode:
        compiler_package_version = args.compiler_package_version
        pinned_version = json.loads((ROOT / "eng/upstream-sources.json").read_text())["sources"]["netwasm"]["packageVersion"]
        if compiler_package_version != pinned_version:
            raise RuntimeError("Compiler package version does not match the public NetWasm package pin")
        package_options = ["-p:NetWasmCompilerPackageVersion=" + compiler_package_version]
    trusted = None
    if package_mode:
        if not args.json_example or not args.tunit_example:
            parser.error("--compiler-package-version requires --json-example and --tunit-example verified inputs")
        trusted = prepare_trusted_inputs(args.json_example.resolve(), args.tunit_example.resolve(), run,
                                        args.di_example.resolve() if args.di_example else None)
    shutil.copytree(fixture, app)
    if trusted:
        project = ET.parse(app / "CompilerProbe.csproj")
        group = ET.SubElement(project.getroot(), "ItemGroup")
        for name, path in trusted["generators"].items():
            reference_item = ET.SubElement(group, "Reference", Include=name)
            ET.SubElement(reference_item, "HintPath").text = str(path)
            if name == "System.Text.Json.SourceGeneration":
                ET.SubElement(reference_item, "Aliases").text = "jsonsourcegen"
        project.write(app / "CompilerProbe.csproj", encoding="unicode")
        di_available = "di" in trusted["recipes"]
        di_factory = "new global::NetWasm.Microsoft.Extensions.DependencyInjection.Generator.NetWasmDependencyInjectionGenerator()" if di_available else \
            'throw new global::System.InvalidOperationException("Trusted DI generator is not configured.")'
        (app / "TrustedGeneratorAssets.cs").write_text("namespace NetWasm.Playground.CompilerProbe;\ninternal static class TrustedGeneratorAssets { internal const string TUnitProgram = " + json.dumps(trusted["program"]) + ";\n" +
            "internal const bool DependencyInjectionAvailable = " + str(di_available).lower() + ";\n" +
            "internal static global::Microsoft.CodeAnalysis.IIncrementalGenerator CreateDependencyInjectionGenerator() => " + di_factory + "; }\n")
    (app / "global.json").write_text(json.dumps({"sdk": {
        "version": receipt["toolchain"]["dotnetSdk"], "rollForward": "disable"}}, indent=2))
    package_cache_owner = run if package_mode or reused_host is None else reused_host
    package_cache = package_cache_owner / "packages"
    env = dict(os.environ, NUGET_PACKAGES=str(package_cache),
               NUGET_HTTP_CACHE_PATH=str(run / "http-cache"))
    commands = []

    def execute(command, name, cwd=app):
        start = time.monotonic()
        result = subprocess.run(command, cwd=cwd, env=env, capture_output=True, text=True)
        (run / (name + ".stdout")).write_text(result.stdout)
        (run / (name + ".stderr")).write_text(result.stderr)
        commands.append({"command": command, "exitCode": result.returncode,
                         "seconds": time.monotonic() - start})
        (run / "commands.json").write_text(json.dumps(commands, indent=2))
        if result.returncode:
            raise RuntimeError(f"{name} failed; inspect {run / (name + '.stderr')}")

    print("Restoring and publishing the untrimmed interpreter compiler host", flush=True)
    execute(["dotnet", "restore", runtime_option, *package_options, "--configfile", str(baseline / "NuGet.Config"),
             "-p:DisableImplicitLibraryPacksFolder=true", "-p:DisableImplicitNuGetFallbackFolder=true",
             "-p:RestoreFallbackFolders=", "-p:RestoreAdditionalProjectSources=", "-p:RestoreAdditionalProjectFallbackFolders=", "-p:NuGetAudit=false"], "restore")
    assets = json.loads((app / "obj/project.assets.json").read_text())
    if set(assets["project"]["restore"]["sources"]) != {"https://api.nuget.org/v3/index.json"}:
        raise RuntimeError("Unexpected restore source")
    if compiler_package_version:
        expected_packages = {
            f"netwasm.compiler.browser/{compiler_package_version}",
            f"netwasm.runtime.pack/{compiler_package_version}"
        }
        restored_packages = {key.lower() for key in assets["libraries"]}
        if not expected_packages.issubset(restored_packages):
            raise RuntimeError("The exact browser compiler packages were not restored")
        pending = [app / "obj/project.assets.json"]
        checked = set()
        while pending:
            project = pending.pop().resolve()
            if project in checked:
                continue
            checked.add(project)
            resolved = json.loads(project.read_text())
            snapshots = run / "restore-assets"
            snapshots.mkdir(exist_ok=True)
            shutil.copyfile(project, snapshots / (project.parent.parent.name + ".json"))
            if {Path(folder).resolve() for folder in resolved["packageFolders"]} != {package_cache}:
                raise RuntimeError("Compiler restore did not use the isolated package cache")
            restore = resolved["project"]["restore"]
            if set(restore["sources"]) != {"https://api.nuget.org/v3/index.json"} or restore.get("fallbackFolders"):
                raise RuntimeError("Unexpected compiler restore source or fallback folder")
            for framework in restore["frameworks"].values():
                for reference in framework.get("projectReferences", {}):
                    pending.append(Path(reference).parent / "obj/project.assets.json")
        if len(checked) != 1:
            raise RuntimeError("Browser compiler host must not restore source project dependencies")
        package_origins = {}
        for package_id in ("netwasm.compiler.browser", "netwasm.runtime.pack"):
            package_root = package_cache / package_id / compiler_package_version
            metadata = json.loads((package_root / ".nupkg.metadata").read_text())
            if metadata.get("source") != "https://api.nuget.org/v3/index.json":
                raise RuntimeError(f"{package_id} did not originate from NuGet.org")
            archive = package_root / f"{package_id}.{compiler_package_version}.nupkg"
            package_origins[package_id] = {
                "version": compiler_package_version,
                "source": metadata["source"],
                "archive": fingerprint(archive),
                "metadata": fingerprint(package_root / ".nupkg.metadata")
            }
        (run / "compiler-package-origins.json").write_text(json.dumps(package_origins, indent=2))
        (run / "restore-provenance.json").write_text(json.dumps({
            "projectsChecked": len(checked), "sources": ["https://api.nuget.org/v3/index.json"],
            "fallbackFolders": [], "packageCache": str(package_cache.relative_to(package_cache_owner)),
            "reusedVerifiedHostReceipt": fingerprint(reused_host / "receipt.json") if reused_host else None}, indent=2))
    execute(["dotnet", "publish", runtime_option, *package_options, "-c", "Debug", "--no-restore",
             "-p:ContinuousIntegrationBuild=true", "-p:Deterministic=true", "-p:DebugType=None",
             "-p:DebugSymbols=false", "-p:PathMap=" + str(run) + "=/_/",
             "-o", str(run / "publish")], "publish")
    shutil.copyfile(app / "bin/Debug/net10.0/NetWasm.Playground.CompilerProbe.runtimeconfig.json",
                    run / "host-runtimeconfig.json")
    web = run / "publish/wwwroot"
    for name in ("index.html", "compiler-worker.mjs"):
        shutil.copyfile(app / name, web / name)
    version = receipt["pins"]["sources"]["netwasm"]["packageVersion"]
    reference = baseline / f"packages/netwasm.ref/{version}/ref/NetWasm,Version=v0.1/NetWasm.CoreLib.dll"
    shutil.copyfile(reference, web / "target-reference.dll")
    if compiler_package_version:
        shutil.copyfile(baseline / f"packages/netwasm.runtime.pack/{version}/runtime/runtime-pack.json",
                        web / "runtime-pack.json")
        shutil.copyfile(baseline / f"packages/netwasm.runtime.wasm32/{version}/runtime/NetWasm.CoreLib.dll",
                        web / "target-implementation.dll")
        tools = baseline / f"packages/netwasm.toolchain/{version}/tools"
        shutil.copyfile(tools / "wit-packages/compiler.wit.wasm", web / "compiler.wit.wasm")
        wit = subprocess.run(["node", str(tools / "wasm-tools/run-wasm-tools.mjs"),
                              str(tools / "wasm-tools/wasm-tools.wasm"), "component", "wit",
                              str(web / "compiler.wit.wasm"), "--json", "--no-docs"],
                             capture_output=True, text=True, check=True)
        (web / "compiler-wit.json").write_text(wit.stdout)
    if trusted:
        stage_trusted_inputs(trusted, web)
    source = (baseline / "app/Program.cs").read_text()
    generated = baseline / "app/obj/Release/netwasm0.1"
    support = [{"path": str(path.relative_to(baseline / "app")), "text": path.read_text()}
               for path in sorted(generated.glob("*.cs"))]
    (web / "support.json").write_text(json.dumps(support))
    expected_runtime_plan = None
    if compiler_package_version:
        captures = sorted((baseline / "captured-tools").glob("wasm-ld-*/invocation.json"))
        if len(captures) != 1:
            raise RuntimeError("Expected one authoritative desktop runtime link capture")
        capture = json.loads(captures[0].read_text())
        arguments = list(capture["arguments"])
        runtime_inputs = []
        for asset in capture["inputs"]:
            relative = asset["path"].split(f"/netwasm.runtime.pack/{version}/runtime/", 1)[1]
            path = "/netwasm-link/runtime/" + relative
            arguments[asset["argumentIndex"]] = path
            runtime_inputs.append({"path": path, "sha256": asset["sha256"]})
        arguments[-1] = "/netwasm-link/runtime.wasm"
        expected_runtime_plan = {"arguments": arguments, "inputs": runtime_inputs}
    (run / "inputs.json").write_text(json.dumps({
        "source": source, "support": support, "assemblyName": "NetWasmApp",
        "referenceSha256": hashlib.sha256(reference.read_bytes()).hexdigest(),
        "desktopReceiptSha256": hashlib.sha256((baseline / "receipt.json").read_bytes()).hexdigest(),
        "toolchain": receipt["toolchain"], "compilerHost": host,
        "browserCompilerPackage": ({"id": "NetWasm.Compiler.Browser", "version": compiler_package_version,
                                     "source": "https://api.nuget.org/v3/index.json"}
                                    if compiler_package_version else None),
        "expectedRuntimePlan": expected_runtime_plan}, indent=2))
    if reused_host:
        (run / "node_modules").symlink_to(reused_host / "node_modules", target_is_directory=True)
    else:
        execute(["npm", "install", "--no-save", "--package-lock=false",
                 "playwright@" + receipt["toolchain"]["playwright"]], "playwright-install", run)
    shutil.copyfile(fixture / "test-worker.mjs", run / "test-worker.mjs")
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(web))
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        env["COMPILER_PROBE_URL"] = f"http://127.0.0.1:{server.server_port}"
        print("Testing actual source compilation and recovery in Chromium", flush=True)
        execute(["node", "test-worker.mjs"], "worker-test", run)
        if trusted and not args.skip_trusted_probes:
            (run / "test-trusted.mjs").write_text(TRUSTED_TEST)
            execute(["node", "test-trusted.mjs"], "trusted-worker-test", run)
            (run / "test-trusted-limit.mjs").write_text(TRUSTED_LIMIT_TEST)
            execute(["node", "test-trusted-limit.mjs"], "trusted-limit-test", run)
    finally:
        server.shutdown()
        server.server_close()
        thread.join()
    finalize_evidence(run, baseline, compiler_package_version)
    print("PASS: browser Roslyn compilation, diagnostics and recovery" +
          ("; trusted generators" if trusted and not args.skip_trusted_probes else ""), flush=True)


if __name__ == "__main__":
    main()
