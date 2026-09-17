#!/usr/bin/env python3
"""Build the browser compiler framework from public packages on a clean runner."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import urllib.request
import xml.etree.ElementTree as ET
import zipfile

ROOT = Path(__file__).resolve().parents[1]
FEED = 'https://api.nuget.org/v3/index.json'
PACKAGES = {
    'json': ('netwasm.system.text.json', '0.2.0',
             'analyzers/dotnet/cs/System.Text.Json.SourceGeneration.dll',
             '595434b3c5d64e527c22104ba20f8796d8a9a18a076b36ca99d38c09f311893f'),
    'tunit-generator': ('netwasm.tunit.core', '0.2.1',
                        'analyzers/dotnet/roslyn4.14/cs/TUnit.Core.SourceGenerator.dll',
                        '6353daf19574e86708c23df2b2cbebe522200e467c7744754f9d976df2b0693c'),
    'di': ('netwasm.microsoft.extensions.dependencyinjection', '0.2.0',
           'analyzers/dotnet/cs/NetWasm.Microsoft.Extensions.DependencyInjection.Generator.dll',
           '24b2552c8392d8ad7bade39edbfe73ceec0d3efc640fb69246e43544148b3be8'),
    'tunit-program': ('netwasm.tunit', '0.2.1',
                      'build/NetWasm,Version=v0.1/NetWasm.TUnit.Program.cs',
                      '7a9860417e8486dabfd02875784f8d71f19c7c36882c2b9dfc6d70d130a8fde5'),
}


def sha256(payload):
    return hashlib.sha256(payload).hexdigest()


def package_member(package, version, member):
    url = f'https://api.nuget.org/v3-flatcontainer/{package}/{version}/{package}.{version}.nupkg'
    request = urllib.request.Request(url, headers={'User-Agent': 'NetWasm.Playground-release-builder'})
    with urllib.request.urlopen(request) as response:
        archive = response.read()
    with zipfile.ZipFile(__import__('io').BytesIO(archive)) as package_zip:
        return package_zip.read(member)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    pins = json.loads((ROOT / 'eng/upstream-sources.json').read_text())['sources']
    version = pins['netwasm']['packageVersion']
    runtime = json.loads((ROOT / 'eng/browser-host.json').read_text())['runtimeFrameworkVersion']
    with tempfile.TemporaryDirectory(prefix='netwasm-release-compiler-') as temporary:
        work = Path(temporary)
        app = work / 'app'
        shutil.copytree(ROOT / 'spikes/netwasm-worker', app)
        generators = work / 'generators'
        generators.mkdir()
        extracted = {}
        for key, (package, package_version, member, expected) in PACKAGES.items():
            payload = package_member(package, package_version, member)
            if sha256(payload) != expected:
                raise RuntimeError(f'Public package member changed: {package}/{member}')
            destination = generators / Path(member).name
            destination.write_bytes(payload)
            extracted[key] = destination

        project = ET.parse(app / 'CompilerProbe.csproj')
        group = ET.SubElement(project.getroot(), 'ItemGroup')
        for name, key in [('System.Text.Json.SourceGeneration', 'json'),
                          ('TUnit.Core.SourceGenerator', 'tunit-generator'),
                          ('NetWasm.Microsoft.Extensions.DependencyInjection.Generator', 'di')]:
            reference = ET.SubElement(group, 'Reference', Include=name)
            ET.SubElement(reference, 'HintPath').text = str(extracted[key])
            if key == 'json':
                ET.SubElement(reference, 'Aliases').text = 'jsonsourcegen'
        project.write(app / 'CompilerProbe.csproj', encoding='unicode')
        program = extracted['tunit-program'].read_text()
        (app / 'TrustedGeneratorAssets.cs').write_text(
            'namespace NetWasm.Playground.CompilerProbe;\n'
            'internal static class TrustedGeneratorAssets { internal const string TUnitProgram = ' +
            json.dumps(program) + ';\ninternal const bool DependencyInjectionAvailable = true;\n'
            'internal static global::Microsoft.CodeAnalysis.IIncrementalGenerator CreateDependencyInjectionGenerator() => '
            'new global::NetWasm.Microsoft.Extensions.DependencyInjection.Generator.NetWasmDependencyInjectionGenerator(); }\n')
        (app / 'global.json').write_text(json.dumps({'sdk': {'version': '10.0.302', 'rollForward': 'disable'}}, indent=2))
        nuget = work / 'NuGet.Config'
        nuget.write_text('<configuration><packageSources><clear/><add key="nuget.org" value="' + FEED +
                         '"/></packageSources><fallbackPackageFolders><clear/></fallbackPackageFolders></configuration>\n')
        env = dict(os.environ, NUGET_PACKAGES=str(work / 'packages'), NUGET_HTTP_CACHE_PATH=str(work / 'http-cache'))
        common = [f'-p:RuntimeFrameworkVersion={runtime}', f'-p:NetWasmCompilerPackageVersion={version}']
        subprocess.run(['dotnet', 'restore', *common, '--configfile', str(nuget),
                        '-p:DisableImplicitLibraryPacksFolder=true', '-p:DisableImplicitNuGetFallbackFolder=true',
                        '-p:RestoreFallbackFolders=', '-p:RestoreAdditionalProjectSources=',
                        '-p:RestoreAdditionalProjectFallbackFolders=', '-p:NuGetAudit=false'], cwd=app, env=env, check=True)
        subprocess.run(['dotnet', 'publish', *common, '-c', 'Release', '--no-restore',
                        '-p:ContinuousIntegrationBuild=true', '-p:Deterministic=true', '-p:DebugType=None',
                        '-p:DebugSymbols=false', f'-p:PathMap={work}=/_/',
                        '-o', str(work / 'publish')], cwd=app, env=env, check=True)
        framework = work / 'publish/wwwroot/_framework'
        if args.output.exists():
            shutil.rmtree(args.output)
        shutil.copytree(framework, args.output)
        receipt = {path.relative_to(args.output).as_posix(): {'bytes': path.stat().st_size,
                   'sha256': sha256(path.read_bytes())} for path in sorted(args.output.rglob('*')) if path.is_file()}
        (args.output.parent / 'compiler-framework-receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
        print(f'PASS: built {len(receipt)} compiler framework files from public packages')


if __name__ == '__main__':
    main()
