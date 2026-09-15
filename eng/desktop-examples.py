#!/usr/bin/env python3
"""Verify visible example recipes against public packages in a fresh workspace."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
from xml.sax.saxutils import escape

ROOT = Path(__file__).resolve().parents[1]
PACKAGES = {'hello': [], 'allocation': [], 'linq': ['NetWasm.System.Linq'], 'json-dom': ['NetWasm.System.Text.Json'], 'json-generated': ['NetWasm.System.Text.Json']}
def fingerprint(path):
    return {'bytes': path.stat().st_size, 'sha256': hashlib.sha256(path.read_bytes()).hexdigest()}
def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('directory', type=Path)
    parser.add_argument('--baseline', type=Path, required=True)
    parser.add_argument('--wasm-ld', type=Path)
    parser.add_argument('--verify', action='store_true')
    parser.add_argument('--recipe', action='append', help='Verify only the named recipe; repeat to select several')
    args = parser.parse_args(); run = args.directory.resolve()
    if args.verify:
        receipt = json.loads((run/'receipt.json').read_text())
        for name, expected in receipt['files'].items():
            if fingerprint(run/name) != expected: raise ValueError(f'Example receipt mismatch: {name}')
        print('PASS: public example receipt verified'); return
    if not args.wasm_ld: parser.error('--wasm-ld is required')
    run.mkdir(parents=True, exist_ok=False)
    if shutil.disk_usage(run).free < 100 * 1024**3: raise RuntimeError('100 GiB free space required')
    baseline = args.baseline.resolve()
    subprocess.run(['python3',str(ROOT/'eng/desktop-baseline.py'),str(baseline),'--verify'],check=True)
    sources = subprocess.check_output(['node','--input-type=module','-e',"import('./src/examples.ts').then(m=>process.stdout.write(JSON.stringify(m.examples)))"],cwd=ROOT,text=True)
    examples = [example for example in json.loads(sources) if example['id'] in PACKAGES]
    if args.recipe:
        examples = [example for example in examples if example['id'] in args.recipe]
        if {example['id'] for example in examples} != set(args.recipe): parser.error('Unknown recipe')
    (run/'examples.json').write_text(json.dumps(examples)+'\n')
    pins = json.loads((ROOT/'eng/upstream-sources.json').read_text()); version=pins['sources']['libraries']['packageVersion']
    (run/'NuGet.Config').write_text('<configuration><packageSources><clear/><add key="nuget.org" value="https://api.nuget.org/v3/index.json"/></packageSources><fallbackPackageFolders><clear/></fallbackPackageFolders></configuration>\n')
    env=dict(os.environ,NUGET_PACKAGES=str(run/'packages'),NUGET_HTTP_CACHE_PATH=str(run/'http-cache'))
    outcomes=[]
    for example in examples:
        recipe=example['id']; app=run/recipe; app.mkdir()
        shutil.copyfile(baseline/'app/global.json',app/'global.json')
        (app/'Program.cs').write_text(example['source'])
        support=[{'path':path.relative_to(baseline/'app').as_posix(),'text':path.read_text()} for path in sorted((baseline/'app/obj/Release/netwasm0.1').glob('*.cs'))]
        for index,file in enumerate(support): (app/f'Support{index}.cs').write_text(file['text'])
        refs=''.join(f'<PackageReference Include="{package}" Version="[{version}]"/>' for package in PACKAGES[recipe])
        (app/'NetWasmApp.csproj').write_text('<Project Sdk="NetWasm.Sdk"><PropertyGroup><OutputType>Exe</OutputType><TargetFramework>netwasm0.1</TargetFramework><ImplicitUsings>disable</ImplicitUsings><Nullable>enable</Nullable><GenerateAssemblyInfo>false</GenerateAssemblyInfo><GenerateTargetFrameworkAttribute>false</GenerateTargetFrameworkAttribute></PropertyGroup><ItemGroup>'+refs+'</ItemGroup></Project>\n')
        (app/'linker.targets').write_text('<Project><Target Name="UseVerifiedExampleLinker" AfterTargets="NetWasmSdkResolveBuildEnvironment"><PropertyGroup><NetWasmWasmLdPath>'+escape(str(args.wasm_ld.absolute()))+'</NetWasmWasmLdPath></PropertyGroup></Target></Project>')
        def execute(command,name):
            result=subprocess.run(command,cwd=app,env=env,capture_output=True,text=True)
            (app/f'{name}.log').write_text(result.stdout+result.stderr)
            if result.returncode: raise RuntimeError(f'{recipe} {name} failed')
            return result.stdout
        execute(['dotnet','restore','--configfile',str(run/'NuGet.Config'),'-p:RestoreFallbackFolders=','-p:RestoreAdditionalProjectSources=','-p:RestoreAdditionalProjectFallbackFolders=','-p:DisableImplicitLibraryPacksFolder=true','-p:DisableImplicitNuGetFallbackFolder=true','-p:NuGetAudit=false'],'restore')
        assets=json.loads((app/'obj/project.assets.json').read_text())
        if set(assets['project']['restore']['sources'])!={'https://api.nuget.org/v3/index.json'} or {str(Path(p).resolve()) for p in assets['packageFolders']}!={str(run/'packages')}: raise RuntimeError('Non-public restore source/cache')
        execute(['dotnet','publish','-c','Release','--no-restore','-o',str(app/'publish'),'-p:CustomAfterMicrosoftCommonTargets='+str(app/'linker.targets')],'publish')
        stdout=execute(['wasmtime',str(app/'publish/NetWasmApp.wasm')],'run')
        expected={'hello':'42\n','linq':'Even sum: 120\n','json-dom':'Name: Ada\nAge: 29\nTags: 2\n','json-generated':'{"Name":"Ada","Score":42}\n'}
        if recipe=='allocation':
            if not stdout.startswith('Survivor: 42\nGuest collections: ') or int(stdout.strip().split(': ')[-1])<1: raise RuntimeError('Guest GC output mismatch')
        elif stdout!=expected[recipe]: raise RuntimeError('Example output mismatch')
        libraries={}
        for package, entry in assets['targets']['netwasm0.1'].items():
            for relative in entry.get('compile',{}):
                if relative.endswith('.dll') and Path(relative).name!='NetWasm.CoreLib.dll':
                    libraries[Path(relative).name]=(Path('packages')/assets['libraries'][package]['path']/relative).as_posix()
        (app/'recipe-inputs.json').write_text(json.dumps({'id':recipe,'support':support,'libraries':libraries,'packages':PACKAGES[recipe],'version':version},indent=2)+'\n')
        outcomes.append({'id':recipe,'stdout':stdout,'component':fingerprint(app/'publish/NetWasmApp.wasm')})
        print(f'PASS: desktop {recipe}',flush=True)
    (run/'outcomes.json').write_text(json.dumps(outcomes,indent=2)+'\n')
    retained=[run/'examples.json',run/'outcomes.json',run/'NuGet.Config',*run.glob('*/Program.cs'),*run.glob('*/Support*.cs'),*run.glob('*/NetWasmApp.csproj'),*run.glob('*/global.json'),*run.glob('*/recipe-inputs.json'),*run.glob('*/publish/NetWasmApp.wasm'),*run.glob('*/obj/project.assets.json'),*run.glob('*/obj/Release/netwasm0.1/NetWasmApp.dll'),*run.glob('*/bin/Release/netwasm0.1/NetWasmApp.core.wasm'),*run.glob('*/run.log'),*run.glob('packages/*/*/*.nupkg')]
    for app in [run/e['id'] for e in examples]:
        recipe=json.loads((app/'recipe-inputs.json').read_text())
        retained.extend(run/path for path in recipe['libraries'].values())
    files={path.relative_to(run).as_posix():fingerprint(path) for path in retained if path.is_file()}
    (run/'receipt.json').write_text(json.dumps({'schemaVersion':1,'pins':pins,'files':files,'outcomes':outcomes},indent=2)+'\n')
if __name__=='__main__': main()
