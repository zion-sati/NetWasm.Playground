#!/usr/bin/env python3
"""Build the NativeAOT-LLVM browser compiler in an x64 Linux container."""
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
INTEROP_GENERATOR_VERSION = '10.0.12'
INTEROP_GENERATORS = {
    'library-import': ('analyzers/dotnet/cs/Microsoft.Interop.LibraryImportGenerator.dll',
                       'de58417fe04b0bec752a775ebac17d9fa0dfd6027eabe9310dc5c9d93e6c7ed5'),
    'interop-support': ('analyzers/dotnet/cs/Microsoft.Interop.SourceGeneration.dll',
                        '448cddcdccd7db7ba1e5de80234c137a6d1fcf0ed90687245109a6dc09dfe82b'),
}


def sha256(payload):
    return hashlib.sha256(payload).hexdigest()


def package_member(package, version, member):
    url = f'https://api.nuget.org/v3-flatcontainer/{package}/{version}/{package}.{version}.nupkg'
    request = urllib.request.Request(url, headers={'User-Agent': 'NetWasm.Playground-nativeaot-builder'})
    with urllib.request.urlopen(request) as response:
        archive = response.read()
    with zipfile.ZipFile(__import__('io').BytesIO(archive)) as package_zip:
        return package_zip.read(member)


def write_nuget_config(path, candidate_feed):
    configuration = ET.Element('configuration')
    sources = ET.SubElement(configuration, 'packageSources')
    ET.SubElement(sources, 'clear')
    ET.SubElement(sources, 'add', key='nuget.org', value=FEED)
    ET.SubElement(sources, 'add', key='dotnet-public',
                  value='https://pkgs.dev.azure.com/dnceng/public/_packaging/dotnet-public/nuget/v3/index.json')
    ET.SubElement(sources, 'add', key='dotnet-experimental',
                  value='https://pkgs.dev.azure.com/dnceng/public/_packaging/dotnet-experimental/nuget/v3/index.json')
    if candidate_feed:
        ET.SubElement(sources, 'add', key='netwasm-candidate', value='/candidate-feed')
    fallbacks = ET.SubElement(configuration, 'fallbackPackageFolders')
    ET.SubElement(fallbacks, 'clear')
    ET.ElementTree(configuration).write(path, encoding='unicode')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--emsdk', type=Path,
                        default=Path(os.environ.get('NETWASM_NATIVEAOT_EMSDK', '')),
                        help='Emscripten SDK directory with the pinned x64 toolchain installed')
    parser.add_argument('--package-cache', type=Path,
                        default=Path('/tmp/netwasm-nativeaot-nuget-x64'),
                        help='Persistent NuGet cache mounted into the build container')
    parser.add_argument('--candidate-feed', type=Path,
                        help='Local feed containing an exact NetWasm compiler candidate')
    parser.add_argument('--candidate-version',
                        help='Exact NetWasm compiler candidate version')
    args = parser.parse_args()
    if not args.emsdk or not (args.emsdk / 'emsdk_env.sh').is_file():
        parser.error('--emsdk must identify an installed Emscripten SDK')
    if shutil.which('docker') is None:
        parser.error('docker is required because the NativeAOT-LLVM compiler host is Linux x64 only')
    if bool(args.candidate_feed) != bool(args.candidate_version):
        parser.error('--candidate-feed and --candidate-version must be supplied together')
    if args.candidate_feed and not args.candidate_feed.is_dir():
        parser.error('--candidate-feed must identify an existing directory')

    upstream = json.loads((ROOT / 'eng/upstream-sources.json').read_text())
    candidate = upstream['nativeAotLlvmCandidate']
    pins = upstream['sources']
    members = upstream['compilerFramework']['members']
    netwasm_version = args.candidate_version or pins['netwasm']['packageVersion']
    browser_sdk_version = candidate['roslynSdkVersion']
    sdk_rows = subprocess.run(['dotnet', '--list-sdks'], check=True, capture_output=True, text=True).stdout.splitlines()
    sdk_row = next((row for row in sdk_rows if row.startswith(f'{browser_sdk_version} ')), None)
    if sdk_row is None:
        parser.error(f'.NET SDK {browser_sdk_version} is required for the pinned C# compiler')
    sdk_root = Path(sdk_row.rsplit('[', 1)[1].rstrip(']')) / browser_sdk_version
    roslyn_root = sdk_root / 'Roslyn/bincore'
    args.package_cache.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory(prefix='netwasm-nativeaot-compiler-', dir='/tmp') as temporary:
        work = Path(temporary)
        compiler_host = work / 'compiler-host'
        native_host = work / 'nativeaot-compiler-host'
        shutil.copytree(ROOT / 'eng/compiler-host', compiler_host)
        shutil.copytree(ROOT / 'eng/nativeaot-compiler-host', native_host)
        generators = work / 'generators'
        generators.mkdir()
        roslyn = work / 'roslyn'
        roslyn.mkdir()
        for name in ('Microsoft.CodeAnalysis.dll', 'Microsoft.CodeAnalysis.CSharp.dll'):
            shutil.copy2(roslyn_root / name, roslyn / name)
        extracted = {}
        for key, item in members.items():
            package = item['package']
            member = item['path']
            package_version = pins[item['source']]['packageVersion']
            payload = package_member(package, package_version, member)
            if sha256(payload) != item['sha256']:
                raise RuntimeError(f'Public package member changed: {package}/{member}')
            destination = generators / Path(member).name
            destination.write_bytes(payload)
            extracted[key] = destination
        for key, (member, expected) in INTEROP_GENERATORS.items():
            payload = package_member('microsoft.netcore.app.ref', INTEROP_GENERATOR_VERSION, member)
            if sha256(payload) != expected:
                raise RuntimeError(f'Public interop generator changed: {member}')
            destination = generators / Path(member).name
            destination.write_bytes(payload)
            extracted[key] = destination

        program = extracted['tunit-program'].read_text()
        (compiler_host / 'TrustedGeneratorAssets.cs').write_text(
            'namespace NetWasm.Playground.CompilerProbe;\n'
            'internal static class TrustedGeneratorAssets { internal const string TUnitProgram = ' +
            json.dumps(program) + ';\ninternal const bool DependencyInjectionAvailable = true;\n'
            'internal static global::Microsoft.CodeAnalysis.IIncrementalGenerator CreateDependencyInjectionGenerator() => '
            'new global::NetWasm.Microsoft.Extensions.DependencyInjection.Generator.NetWasmDependencyInjectionGenerator();\n'
            'internal static global::Microsoft.CodeAnalysis.IIncrementalGenerator CreateLoggingGenerator() => '
            'new global::Microsoft.Extensions.Logging.Generators.LoggerMessageGenerator();\n'
            'internal static global::Microsoft.CodeAnalysis.IIncrementalGenerator CreateLibraryImportGenerator() => '
            'new global::Microsoft.Interop.LibraryImportGenerator(); }\n')

        project_path = native_host / 'NativeAotCompilerHost.csproj'
        project = ET.parse(project_path)
        group = ET.SubElement(project.getroot(), 'ItemGroup')
        for name, key in [('System.Text.Json.SourceGeneration', 'json'),
                          ('TUnit.Core.SourceGenerator', 'tunit-generator'),
                          ('NetWasm.Microsoft.Extensions.DependencyInjection.Generator', 'di'),
                          ('NetWasm.Microsoft.Extensions.Logging.Generators', 'logging'),
                          ('Microsoft.Interop.LibraryImportGenerator', 'library-import'),
                          ('Microsoft.Interop.SourceGeneration', 'interop-support')]:
            reference = ET.SubElement(group, 'Reference', Include=name)
            ET.SubElement(reference, 'HintPath').text = f'/work/generators/{extracted[key].name}'
            if key == 'json':
                ET.SubElement(reference, 'Aliases').text = 'jsonsourcegen'
        project.write(project_path, encoding='unicode')

        (work / 'global.json').write_text(json.dumps({'sdk': {'version': '10.0.100', 'rollForward': 'latestFeature'}}, indent=2))
        write_nuget_config(work / 'NuGet.Config', args.candidate_feed)
        (work / 'Directory.Build.props').write_text(
            '<Project><PropertyGroup>'
            f'<NetWasmCompilerPackageVersion>{netwasm_version}</NetWasmCompilerPackageVersion>'
            f'<NativeAotLlvmVersion>{candidate["packageVersion"]}</NativeAotLlvmVersion>'
            '<RoslynCompilerPath>/work/roslyn</RoslynCompilerPath>'
            '</PropertyGroup></Project>')

        container_command = (
            "trap 'chmod -R a+rwX /work' EXIT; "
            'apt-get update >/dev/null && '
            'apt-get install -y --no-install-recommends python3 >/dev/null && '
            'ln -sf /usr/bin/python3 /usr/local/bin/python && '
            '. /emsdk/emsdk_env.sh >/dev/null && '
            'emcc --version | head -1 | grep -F " 3.1.56 " >/dev/null && '
            'dotnet restore --disable-build-servers -m:1 -nodeReuse:false --configfile /work/NuGet.Config '
            '-p:DisableImplicitLibraryPacksFolder=true -p:DisableImplicitNuGetFallbackFolder=true '
            '-p:RestoreFallbackFolders= -p:RestoreAdditionalProjectSources= '
            '-p:RestoreAdditionalProjectFallbackFolders= -p:NuGetAudit=false && '
            'dotnet publish -c Release --no-restore --disable-build-servers -m:1 -nodeReuse:false '
            '-p:BuildInParallel=false -p:UseSharedCompilation=false -p:ContinuousIntegrationBuild=true '
            '-p:Deterministic=true -p:DebugType=None -p:DebugSymbols=false '
            '-p:ILLinkTreatWarningsAsErrors=false -o /work/publish')
        docker_arguments = [
            'docker', 'run', '--rm', '--platform', 'linux/amd64',
            '--volume', f'{work}:/work', '--volume', f'{args.emsdk.resolve()}:/emsdk',
            '--volume', f'{args.package_cache.resolve()}:/nuget-cache',
            '--env', 'NUGET_PACKAGES=/nuget-cache/packages',
            '--env', 'NUGET_HTTP_CACHE_PATH=/nuget-cache/http-cache',
        ]
        if args.candidate_feed:
            docker_arguments += ['--volume', f'{args.candidate_feed.resolve()}:/candidate-feed:ro']
        docker_arguments += [
            '--workdir', '/work/nativeaot-compiler-host', candidate['sdkImage'],
            'bash', '-lc', container_command,
        ]
        subprocess.run(docker_arguments, check=True)

        publish = work / 'publish'
        outputs = [path for path in publish.iterdir() if path.suffix in ('.js', '.mjs', '.wasm')]
        if not any(path.suffix == '.wasm' for path in outputs) or not any(path.suffix in ('.js', '.mjs') for path in outputs):
            raise RuntimeError('NativeAOT-LLVM publish did not produce its JavaScript and Wasm host')
        if args.output.exists():
            shutil.rmtree(args.output)
        args.output.mkdir(parents=True)
        for source in outputs:
            shutil.copy2(source, args.output / source.name)
        receipt = {
            'schemaVersion': 1,
            'netwasmVersion': netwasm_version,
            'nativeAotLlvm': candidate,
            'files': {path.name: {'bytes': path.stat().st_size, 'sha256': sha256(path.read_bytes())}
                      for path in sorted(args.output.iterdir()) if path.is_file()},
        }
        (args.output / 'nativeaot-compiler-receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
        print(f'PASS: built NativeAOT-LLVM compiler host with {len(outputs)} runtime files')


if __name__ == '__main__':
    main()
