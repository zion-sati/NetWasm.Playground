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
    'json': ('netwasm.system.text.json', '0.4.0',
             'analyzers/dotnet/cs/System.Text.Json.SourceGeneration.dll',
             '595434b3c5d64e527c22104ba20f8796d8a9a18a076b36ca99d38c09f311893f'),
    'tunit-generator': ('netwasm.tunit.core', '0.4.0',
                        'analyzers/dotnet/roslyn4.14/cs/TUnit.Core.SourceGenerator.dll',
                        'bed94cb5b69336320ff7d387fdffedb4d97b89616918a9c63a537d6656b6aa8a'),
    'di': ('netwasm.microsoft.extensions.dependencyinjection', '0.4.0',
           'analyzers/dotnet/cs/NetWasm.Microsoft.Extensions.DependencyInjection.Generator.dll',
           '3661e3ec356ee8ebe9e73b6d4c4feb6254a395460766acc6d7f8a0cf67c427d3'),
    'logging': ('netwasm.microsoft.extensions.logging.abstractions', '0.4.0',
                'analyzers/dotnet/cs/NetWasm.Microsoft.Extensions.Logging.Generators.dll',
                'f219353ffd51e4635fcc90e7bc8042127c57c093e014da17a8ffc8387cee4741'),
    'tunit-program': ('netwasm.tunit', '0.4.0',
                      'build/NetWasm,Version=v0.1/NetWasm.TUnit.Program.cs',
                      '7a9860417e8486dabfd02875784f8d71f19c7c36882c2b9dfc6d70d130a8fde5'),
}


def sha256(payload):
    return hashlib.sha256(payload).hexdigest()


def package_member(package, version, member, candidate_feed=None):
    candidates = [] if candidate_feed is None else [path for path in candidate_feed.glob('*.nupkg')
        if path.name.lower() == f'{package}.{version}.nupkg'.lower()]
    if len(candidates) > 1:
        raise RuntimeError(f'Candidate feed contains duplicate package identities: {package}/{version}')
    if candidates:
        archive = candidates[0].read_bytes()
    else:
        url = f'https://api.nuget.org/v3-flatcontainer/{package}/{version}/{package}.{version}.nupkg'
        request = urllib.request.Request(url, headers={'User-Agent': 'NetWasm.Playground-release-builder'})
        with urllib.request.urlopen(request) as response:
            archive = response.read()
    with zipfile.ZipFile(__import__('io').BytesIO(archive)) as package_zip:
        return package_zip.read(member), bool(candidates)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--candidate-feed', type=Path,
                        help='Temporary CI/local feed containing an exact candidate package graph')
    parser.add_argument('--candidate-version',
                        help='Exact candidate version; required with --candidate-feed')
    parser.add_argument('--candidate-tunit-version',
                        help='Exact TUnit candidate version from the same temporary feed')
    args = parser.parse_args()
    if bool(args.candidate_feed) != bool(args.candidate_version):
        parser.error('--candidate-feed and --candidate-version must be supplied together')
    if args.candidate_tunit_version and not args.candidate_feed:
        parser.error('--candidate-tunit-version requires --candidate-feed')
    pins = json.loads((ROOT / 'eng/upstream-sources.json').read_text())['sources']
    version = args.candidate_version or pins['netwasm']['packageVersion']
    candidate_feed = args.candidate_feed.resolve() if args.candidate_feed else None
    if candidate_feed:
        for package in ('NetWasm.Compiler.Browser', 'NetWasm.Runtime.Pack'):
            if not (candidate_feed / f'{package}.{version}.nupkg').is_file():
                parser.error(f'candidate feed lacks {package}.{version}.nupkg')
    if args.candidate_tunit_version:
        available = {path.name.lower() for path in candidate_feed.glob('*.nupkg')}
        for package in ('NetWasm.TUnit', 'NetWasm.TUnit.Core'):
            expected = f'{package}.{args.candidate_tunit_version}.nupkg'.lower()
            if expected not in available:
                parser.error(f'candidate feed lacks {package}.{args.candidate_tunit_version}.nupkg')
    runtime = json.loads((ROOT / 'eng/browser-host.json').read_text())['runtimeFrameworkVersion']
    with tempfile.TemporaryDirectory(prefix='netwasm-release-compiler-') as temporary:
        work = Path(temporary)
        app = work / 'app'
        shutil.copytree(ROOT / 'eng/compiler-host', app)
        generators = work / 'generators'
        generators.mkdir()
        extracted = {}
        for key, (package, package_version, member, expected) in PACKAGES.items():
            if args.candidate_tunit_version and key.startswith('tunit-'):
                package_version = args.candidate_tunit_version
            payload, from_candidate = package_member(package, package_version, member, candidate_feed)
            if not from_candidate and sha256(payload) != expected:
                raise RuntimeError(f'Public package member changed: {package}/{member}')
            destination = generators / Path(member).name
            destination.write_bytes(payload)
            extracted[key] = destination

        project = ET.parse(app / 'CompilerProbe.csproj')
        group = ET.SubElement(project.getroot(), 'ItemGroup')
        for name, key in [('System.Text.Json.SourceGeneration', 'json'),
                          ('TUnit.Core.SourceGenerator', 'tunit-generator'),
                          ('NetWasm.Microsoft.Extensions.DependencyInjection.Generator', 'di'),
                          ('NetWasm.Microsoft.Extensions.Logging.Generators', 'logging')]:
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
            'new global::NetWasm.Microsoft.Extensions.DependencyInjection.Generator.NetWasmDependencyInjectionGenerator();\n'
            'internal static global::Microsoft.CodeAnalysis.IIncrementalGenerator CreateLoggingGenerator() => '
            'new global::Microsoft.Extensions.Logging.Generators.LoggerMessageGenerator(); }\n')
        (app / 'global.json').write_text(json.dumps({'sdk': {'version': '11.0.100-rc.1.26425.128', 'rollForward': 'disable',
                                                             'allowPrerelease': True}}, indent=2))
        nuget = work / 'NuGet.Config'
        configuration = ET.Element('configuration')
        sources = ET.SubElement(configuration, 'packageSources')
        ET.SubElement(sources, 'clear')
        if candidate_feed:
            ET.SubElement(sources, 'add', key='candidate', value=str(candidate_feed))
        ET.SubElement(sources, 'add', key='nuget.org', value=FEED)
        fallbacks = ET.SubElement(configuration, 'fallbackPackageFolders')
        ET.SubElement(fallbacks, 'clear')
        ET.ElementTree(configuration).write(nuget, encoding='unicode')
        env = dict(os.environ, NUGET_PACKAGES=str(work / 'packages'), NUGET_HTTP_CACHE_PATH=str(work / 'http-cache'))
        # Keep the Mono runtime native, but execute the compiler's managed IL in
        # interpreter mode. Full browser AOT has produced method-layout-sensitive
        # miscompilations in the compiler host; trimming would also remove IL that
        # the interpreter needs.
        common = [f'-p:RuntimeFrameworkVersion={runtime}', f'-p:NetWasmCompilerPackageVersion={version}',
                  '-p:DefineConstants=FRONTEND_CACHE_TRANSPORT',
                  '-p:WasmBuildNative=true', '-p:RunAOTCompilation=false', '-p:PublishTrimmed=false',
                  '-p:ILLinkTreatWarningsAsErrors=false']
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
