#!/usr/bin/env python3
"""Compare the public one-file TUnit template using ordinary dotnet test."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time
import xml.etree.ElementTree as ET
from xml.sax.saxutils import escape

ROOT = Path(__file__).resolve().parents[1]
FEED = 'https://api.nuget.org/v3/index.json'
SDK = '10.0.302'

def fingerprint(path):
    return {'bytes': path.stat().st_size, 'sha256': hashlib.sha256(path.read_bytes()).hexdigest()}

def write_json(path, value):
    path.write_text(json.dumps(value, indent=2) + '\n')

def verify(run):
    receipt = json.loads((run / 'receipt.json').read_text())
    for name, expected in receipt['files'].items():
        if fingerprint(run / name) != expected:
            raise ValueError(f'TUnit receipt mismatch: {name}')
    print('PASS: public TUnit example receipt verified', flush=True)

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('directory', type=Path)
    parser.add_argument('--wasm-ld', type=Path)
    parser.add_argument('--template-source', type=Path, default=ROOT / '.cache/public-tunit')
    parser.add_argument('--verify', action='store_true')
    parser.add_argument('--resume', action='store_true', help='Reuse verified packages and completed source snapshots after a failed attempt')
    args = parser.parse_args()
    run = args.directory.resolve()
    if args.verify:
        verify(run)
        return
    if not args.wasm_ld:
        parser.error('--wasm-ld is required')
    run.mkdir(parents=True, exist_ok=args.resume)
    if shutil.disk_usage(run).free < 100 * 1024**3:
        raise RuntimeError('100 GiB free space required')
    pins = json.loads((ROOT / 'eng/upstream-sources.json').read_text())
    source = args.template_source.resolve()
    commit = subprocess.check_output(['git', '-C', str(source), 'rev-parse', 'HEAD'], text=True).strip()
    if commit != pins['sources']['tunit']['commit']:
        raise ValueError('Public TUnit source pin mismatch')
    template = source / 'packaging/NetWasm.TUnit.Templates/content/NetWasmTUnitTests'
    app = run / 'app'
    app.mkdir(exist_ok=args.resume)
    original = run / 'template'
    original.mkdir(exist_ok=args.resume)
    for name in ('Tests.cs', 'NetWasmTUnitTests.csproj', 'global.json'):
        shutil.copyfile(template / name, original / name)
        shutil.copyfile(template / name, app / name)
    global_json = json.loads((app / 'global.json').read_text())
    global_json['sdk'] = {'version': SDK, 'rollForward': 'disable', 'allowPrerelease': False}
    write_json(app / 'global.json', global_json)
    (run / 'NuGet.Config').write_text('<configuration><packageSources><clear/><add key="nuget.org" value="' + FEED + '"/></packageSources><fallbackPackageFolders><clear/></fallbackPackageFolders></configuration>\n')
    env = dict(os.environ, NUGET_PACKAGES=str(run / 'packages'), NUGET_HTTP_CACHE_PATH=str(run / 'http-cache'), NETWASM_CAPTURE_CONFIG=str(run / 'capture-config.json'))
    commands = json.loads((run / 'commands.json').read_text()) if args.resume else []
    logs = run / 'logs'
    logs.mkdir(exist_ok=args.resume)
    def execute(arguments, name, expected=0):
        started = time.monotonic()
        with (logs / (name + '.stdout')).open('w') as stdout, (logs / (name + '.stderr')).open('w') as stderr:
            result = subprocess.run(arguments, cwd=app, env=env, stdout=stdout, stderr=stderr)
        commands.append({'name': name, 'arguments': arguments, 'exitCode': result.returncode, 'seconds': round(time.monotonic() - started, 3)})
        write_json(run / 'commands.json', commands)
        if result.returncode != expected:
            raise RuntimeError(f'{name}: unexpected exit {result.returncode}; retained diagnostics in logs')
        return (logs / (name + '.stdout')).read_text()
    if execute(['dotnet', '--version'], 'sdk-version').strip() != SDK:
        raise ValueError('SDK pin mismatch')
    # Preserve wasm-ld basename: resolving its multicall symlink would select the wrong LLD driver.
    linker = args.wasm_ld.absolute()
    lld_identity = execute([str(linker), '--version'], 'lld-version').strip()
    if '4cc02503f584aad493a1d0d35bb5afb710a5510b' not in lld_identity:
        raise ValueError('Native LLD source pin mismatch')
    print('Reusing verified NuGet.org-only packages' if args.resume else 'Restoring public TUnit template with an empty NuGet.org-only cache', flush=True)
    if not args.resume:
        execute(['dotnet', 'restore', '--configfile', str(run / 'NuGet.Config'), '-p:RestoreFallbackFolders=', '-p:RestoreAdditionalProjectSources=', '-p:RestoreAdditionalProjectFallbackFolders=', '-p:DisableImplicitLibraryPacksFolder=true', '-p:DisableImplicitNuGetFallbackFolder=true', '-p:NuGetAudit=false'], 'restore')
    assets = json.loads((app / 'obj/project.assets.json').read_text())
    if set(assets['project']['restore']['sources']) != {FEED} or {str(Path(folder).resolve()) for folder in assets['packageFolders']} != {str(run / 'packages')}:
        raise ValueError('Unexpected restore source or package folder')
    metadata = list((run / 'packages').glob('*/*/.nupkg.metadata'))
    if not metadata or any(json.loads(path.read_text()).get('source') != FEED for path in metadata):
        raise ValueError('Unexpected resolved package origin')
    write_json(run / 'package-origins.json', {path.relative_to(run).as_posix(): json.loads(path.read_text()) for path in metadata})
    version = pins['sources']['netwasm']['packageVersion']
    binaryen = run / f'packages/netwasm.toolchain/{version}/tools/binaryen/bin'
    write_json(run / 'capture-config.json', {'tools': {'wasm-ld': str(linker), 'wasm-merge': str(binaryen / 'wasm-merge'), 'wasm-opt': str(binaryen / 'wasm-opt')}, 'output': str(run / 'captured-tools'), 'python': sys.executable, 'pythonAdapter': str(ROOT / 'eng/capture-tool.py')})
    wrappers = run / 'wrappers'
    wrappers.mkdir(exist_ok=args.resume)
    if not (wrappers / 'wasm-ld').exists():
        (wrappers / 'wasm-ld').symlink_to(ROOT / 'eng/capture-tool.py')
    for name in ('wasm-merge', 'wasm-opt'):
        shutil.copyfile(ROOT / 'eng/capture-tool.mjs', wrappers / name)
    properties = {'NetWasmWasmLdPath': 'wasm-ld', 'NetWasmBinaryenWasmMergePath': 'wasm-merge', 'NetWasmBinaryenWasmOptPath': 'wasm-opt'}
    (run / 'capture.targets').write_text('<Project><Target Name="CaptureTUnitExampleTools" AfterTargets="NetWasmSdkResolveBuildEnvironment"><PropertyGroup>' + ''.join(f'<{key}>{escape(str(wrappers / value))}</{key}>' for key, value in properties.items()) + '</PropertyGroup></Target></Project>\n')
    libraries = {}
    for package, entry in assets['targets']['netwasm0.1'].items():
        for kind in ('compile', 'runtime'):
            for relative in entry.get(kind, {}):
                if relative.endswith('.dll'):
                    libraries.setdefault(package, {}).setdefault(kind, []).append((Path('packages') / assets['libraries'][package]['path'] / relative).as_posix())
    write_json(run / 'recipe-inputs.json', {'templateCommit': commit, 'sdk': SDK, 'libraries': libraries, 'compilerWorld': 'netwasm:platform@1.0.0/async-platform', 'componentContract': 'async-command', 'entryType': 'NetWasm.TUnit.Generated.NetWasmTestProgram', 'entryMethod': 'Main', 'coreLibImplementation': f'packages/netwasm.runtime.wasm32/{version}/runtime/NetWasm.CoreLib.dll', 'compilerWitBinary': f'packages/netwasm.toolchain/{version}/tools/wit-packages/compiler.wit.wasm', 'componentWitBinary': f'packages/netwasm.toolchain/{version}/tools/wit-packages/async-command.wit.wasm', 'generatedProgram': f'packages/netwasm.tunit/{version}/build/NetWasm,Version=v0.1/NetWasm.TUnit.Program.cs', 'trustedGenerator': f'packages/netwasm.tunit.core/{version}/analyzers/dotnet/roslyn4.14/cs/TUnit.Core.SourceGenerator.dll'})
    template_source = (original / 'Tests.cs').read_text()
    second_source = template_source.rsplit('}', 1)[0] + '''    [Test]
    public async Task SecondAnswerIsFortyTwo()
    {
        var answer = 40 + 2;
        await Assert.That(answer).IsEqualTo(42);
    }
}
'''
    cases = [('template', template_source, 1, 0), ('second-test', second_source, 2, 0), ('assertion-failure', second_source.replace('Assert.That(answer).IsEqualTo(42)', 'Assert.That(answer).IsEqualTo(43)', 1), 1, 1)]
    outcomes = json.loads((run / 'outcomes.json').read_text()) if args.resume else []
    for name, editable_source, passed, failed in cases:
        case = run / 'cases' / name
        if any(outcome['case'] == name for outcome in outcomes):
            if (case / 'Tests.cs').read_text() != editable_source or fingerprint(case / 'Tests.cs') != next(outcome['source'] for outcome in outcomes if outcome['case'] == name):
                raise ValueError('Completed source snapshot changed')
            continue
        case.mkdir(parents=True, exist_ok=args.resume)
        (app / 'Tests.cs').write_text(editable_source)
        generated = run / 'generated'
        if generated.exists():
            shutil.rmtree(generated)
        print(f'Running ordinary dotnet test: {name}', flush=True)
        arguments = ['dotnet', 'test', '-c', 'Release', '--no-restore', '--logger', 'trx;LogFileName=result.trx', '--results-directory', str(case / 'test-results'), '-p:CustomAfterMicrosoftCommonTargets=' + str(run / 'capture.targets'), '-p:EmitCompilerGeneratedFiles=true', '-p:CompilerGeneratedFilesOutputPath=' + str(generated)]
        execute(arguments, name, expected=1 if failed else 0)
        trx = ET.parse(case / 'test-results/result.trx')
        counters = trx.find('.//{*}Counters')
        if counters is None or int(counters.attrib['passed']) != passed or int(counters.attrib['failed']) != failed or int(counters.attrib['total']) != passed + failed:
            raise ValueError(f'{name}: test counts mismatch')
        shutil.copyfile(app / 'Tests.cs', case / 'Tests.cs')
        shutil.copytree(app / 'obj/Release/netwasm0.1', case / 'obj', dirs_exist_ok=args.resume)
        shutil.copytree(app / 'bin/Release/netwasm0.1', case / 'bin', dirs_exist_ok=args.resume)
        shutil.copytree(generated, case / 'generated', dirs_exist_ok=args.resume)
        execute(['dotnet', 'test', '-c', 'Release', '--no-build', '--no-restore', '--list-tests', '-p:CustomAfterMicrosoftCommonTargets=' + str(run / 'capture.targets')], name + '-catalog')
        catalog = (logs / (name + '-catalog.stdout')).read_text()
        if 'AnswerIsFortyTwo' not in catalog or ('SecondAnswerIsFortyTwo' in catalog) != (passed + failed == 2):
            raise ValueError(f'{name}: catalog mismatch')
        outcome = {'case': name, 'passed': passed, 'failed': failed, 'total': passed + failed, 'source': fingerprint(case / 'Tests.cs'), 'generatedSources': len(list((case / 'generated').rglob('*.cs')))}
        outcomes.append(outcome)
        write_json(run / 'outcomes.json', outcomes)
        print(f'PASS: {name}: {passed} passed, {failed} failed', flush=True)
    retained = [*original.rglob('*'), *logs.rglob('*'), * (run / 'cases').rglob('*'), *(run / 'captured-tools').rglob('*'), *(run / 'packages').glob('*/*/*.nupkg'), *metadata, run / 'NuGet.Config', run / 'commands.json', run / 'recipe-inputs.json', run / 'package-origins.json', run / 'outcomes.json', app / 'global.json', app / 'NetWasmTUnitTests.csproj', app / 'obj/project.assets.json', run / 'capture.targets', run / 'capture-config.json']
    for entry in libraries.values():
        for paths in entry.values():
            retained.extend(run / path for path in paths)
    retained.extend((run / f'packages/netwasm.runtime.wasm32/{version}/runtime').glob('*.dll'))
    retained.extend((run / f'packages/netwasm.tunit/{version}/build').rglob('*.cs'))
    retained.extend((run / f'packages/netwasm.tunit.core/{version}/analyzers/dotnet/roslyn4.14/cs').glob('*.dll'))
    retained.extend((run / f'packages/netwasm.toolchain/{version}/tools/wit-packages').glob('*.wasm'))
    files = {path.relative_to(run).as_posix(): fingerprint(path) for path in retained if path.is_file()}
    write_json(run / 'receipt.json', {'schemaVersion': 1, 'pins': pins, 'files': files, 'outcomes': outcomes, 'packageCount': len(metadata), 'identities': {'dotnet': SDK, 'lld': lld_identity}})
    verify(run)

if __name__ == '__main__':
    main()
