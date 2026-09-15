#!/usr/bin/env python3
"""Verify public notice inputs and stage notices plus a portable origins.json.

The embedded public catalog needs only caller-supplied NuGet package roots.
Package inputs must retain their NuGet.org restore metadata and archive hashes.
Small pinned Git notice files and integrity-checked npm archives are cached.
An ignored asset audit is optional for investigating a changed input set. No
tools are built. Copy the output into the bundle's notices/ directory.
"""
import argparse
import base64
import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import shutil
import subprocess
import tarfile
import tempfile
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
import zipfile


# Public archive members and Git blobs corresponding to the shipped toolchain.
# Update these immutable identities when the toolchain inputs change.
PUBLIC_CATALOG = {'files': {'netwasm/LICENSES/BSD-2-Clause.txt': {'bytes': 1310,
                                       'covers': ['NetWasm compiler, CoreLib and runtime copied '
                                                  'material'],
                                       'sha256': '989a9d0cbb3b96f5f6c3601c4f645ae4c68ca248b20a53a2603c271d8ea60e3a',
                                       'source': {'commit': '743ceacf2e40edeba9fccf531979c45b12552ea2',
                                                  'kind': 'git',
                                                  'path': 'LICENSES/BSD-2-Clause.txt',
                                                  'repository': 'https://github.com/zion-sati/NetWasm'}},
 'netwasm/LICENSES/BSD-3-Clause.txt': {'bytes': 1514,
                                       'covers': ['NetWasm compiler, CoreLib and runtime copied '
                                                  'material'],
                                       'sha256': 'ea5b22afa9a8eb96ccc7d511c7cae492130d0e9250204c9e82c0b1a7971d28ac',
                                       'source': {'commit': '743ceacf2e40edeba9fccf531979c45b12552ea2',
                                                  'kind': 'git',
                                                  'path': 'LICENSES/BSD-3-Clause.txt',
                                                  'repository': 'https://github.com/zion-sati/NetWasm'}},
 'netwasm/LICENSES/MIT.txt': {'bytes': 1078,
                              'covers': ['NetWasm compiler, CoreLib and runtime copied material'],
                              'sha256': 'e13634f149ae4557df3f8bd1f14a57e39e1cc8581f2fa1c9b7b35fed443ee148',
                              'source': {'commit': '743ceacf2e40edeba9fccf531979c45b12552ea2',
                                         'kind': 'git',
                                         'path': 'LICENSES/MIT.txt',
                                         'repository': 'https://github.com/zion-sati/NetWasm'}},
           'bdwgc/AUTHORS': {'bytes': 17411,
                             'covers': ['runtime/wasm32/libnetwasm-runtime.a'],
                             'sha256': 'd2257f0fd22ac0e32912ca2c1fa2190c289ba3961fca7c68cb46ed6af711e985',
                             'source': {'commit': 'ee59af3722e56de8404de6cd0c21c2493cc4d855',
                                        'kind': 'git',
                                        'path': 'AUTHORS',
                                        'repository': 'https://github.com/ivmai/bdwgc'}},
           'bdwgc/README.QUICK': {'bytes': 4075,
                                  'covers': ['runtime/wasm32/libnetwasm-runtime.a'],
                                  'sha256': 'a9b077aeb4e9e1aaf9742119d8023ef26f52f445cdc3f60d390bf59e1647f54a',
                                  'source': {'commit': 'ee59af3722e56de8404de6cd0c21c2493cc4d855',
                                             'kind': 'git',
                                             'path': 'README.QUICK',
                                             'repository': 'https://github.com/ivmai/bdwgc'}},
           'binaryen/LICENSE': {'bytes': 11356,
                                'covers': ['wasm-merge.js', 'wasm-opt.js'],
                                'sha256': 'c5accbbd8546e94c34aed24afe689a617627d18eed5a6c48277e48db57c23851',
                                'source': {'archiveSha256': 'a7ef7628e5d57c768b3e51f1e54ef4027715ac279c98916593f4a121b6f9cf83',
                                           'archiveSha512': 'hU+/ohr85EWuc6ULZQ0Vfi0tKpgBghOYYIN5DxxUq/zIPoKVfoouj/jTBy6xBoPFzL7J5UuILQvQkYJkhm+PNg==',
                                           'kind': 'nuget',
                                           'package': 'netwasm.toolchain',
                                           'path': 'tools/binaryen/LICENSE',
                                           'restoreContentHash': 'VIOturRaJK/pjNwybp2XC+etpQfieqQm7HYWsVUckVhpslrgS9i3uZp3j5AzIHBBsxNCj2gOOFPaJYbhAdZ4kQ==',
                                           'url': 'https://api.nuget.org/v3-flatcontainer/netwasm.toolchain/0.1.0/netwasm.toolchain.0.1.0.nupkg',
                                           'version': '0.1.0'}},
           'browser_wasi_shim/LICENSE-APACHE': {'bytes': 11357,
                                                'covers': ['wasi-shim/*'],
                                                'sha256': 'c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4',
                                                'source': {'archiveSha256': '9c0281520d0e99f027ec7c1c79b4036c0f8168ed9bf98aba19db4737a1333782',
                                                           'integrity': 'sha512-/iHkCVUG3VbcbmEHn5iIUpIrh7a7WPiwZ3sHy4HZKZzBdSadwdddYDZAII2zBvQYV0Lfi8naZngPCN7WPHI/hA==',
                                                           'kind': 'npm',
                                                           'path': 'package/LICENSE-APACHE',
                                                           'url': 'https://registry.npmjs.org/@bjorn3/browser_wasi_shim/-/browser_wasi_shim-0.4.2.tgz',
                                                           'version': '0.4.2'}},
           'browser_wasi_shim/LICENSE-MIT': {'bytes': 1023,
                                             'covers': ['wasi-shim/*'],
                                             'sha256': '23f18e03dc49df91622fe2a76176497404e46ced8a715d9d2b67a7446571cca3',
                                             'source': {'archiveSha256': '9c0281520d0e99f027ec7c1c79b4036c0f8168ed9bf98aba19db4737a1333782',
                                                        'integrity': 'sha512-/iHkCVUG3VbcbmEHn5iIUpIrh7a7WPiwZ3sHy4HZKZzBdSadwdddYDZAII2zBvQYV0Lfi8naZngPCN7WPHI/hA==',
                                                        'kind': 'npm',
                                                        'path': 'package/LICENSE-MIT',
                                                        'url': 'https://registry.npmjs.org/@bjorn3/browser_wasi_shim/-/browser_wasi_shim-0.4.2.tgz',
                                                        'version': '0.4.2'}},
           'dotnet/microsoft.extensions.dependencyinjection.abstractions/THIRD-PARTY-NOTICES.TXT': {'bytes': 78041,
                                                                                                    'covers': ['compiler/_framework/Microsoft.Extensions.DependencyInjection.Abstractions.*'],
                                                                                                    'sha256': '6d15e10a101c6bfff2ab4429ed061bf76c456fc4b23ad6b03e0d0f8377148a21',
                                                                                                    'source': {'archiveSha256': 'f62a1d5cfdfd62a831a269ce3cec5dfe6cdb1b425f3925f3168354de8993d8fb',
                                                                                                               'archiveSha512': 'R1JUmDhx81zXARj7/3QwSexiO9lNE2PBPXyK47sblSGIOl4Jd60iLY8wtmJ/NzhpXtPBiSOTMn2KFYuf7QaRIw==',
                                                                                                               'kind': 'nuget',
                                                                                                               'package': 'microsoft.extensions.dependencyinjection.abstractions',
                                                                                                               'path': 'THIRD-PARTY-NOTICES.TXT',
                                                                                                               'restoreContentHash': 'L3AdmZ1WOK4XXT5YFPEwyt0ep6l8lGIPs7F5OOBZc77Zqeo01Of7XXICy47628sdVl0v/owxYJTe86DTgFwKCA==',
                                                                                                               'url': 'https://api.nuget.org/v3-flatcontainer/microsoft.extensions.dependencyinjection.abstractions/10.0.0/microsoft.extensions.dependencyinjection.abstractions.10.0.0.nupkg',
                                                                                                               'version': '10.0.0'}},
           'dotnet/microsoft.extensions.dependencyinjection/THIRD-PARTY-NOTICES.TXT': {'bytes': 78041,
                                                                                       'covers': ['compiler/_framework/Microsoft.Extensions.DependencyInjection.*'],
                                                                                       'sha256': '6d15e10a101c6bfff2ab4429ed061bf76c456fc4b23ad6b03e0d0f8377148a21',
                                                                                       'source': {'archiveSha256': '2d89bd855968fd1f5cd9a00a1ec0d8279bd8f54d3edc9bdc9667b7a2edc1b6f4',
                                                                                                  'archiveSha512': 'jKVOffyzW7yqmikvAQf69oCKjPlMiHmnqv4xroQRdNKQCYlUIc4rvJv6/YbQyqvUArvrzITxlhd0dA3MFVIpuw==',
                                                                                                  'kind': 'nuget',
                                                                                                  'package': 'microsoft.extensions.dependencyinjection',
                                                                                                  'path': 'THIRD-PARTY-NOTICES.TXT',
                                                                                                  'restoreContentHash': 'f0RBabswJq+gRu5a+hWIobrLWiUYPKMhCD9WO3sYBAdSy3FFH14LMvLVFZc2kPSCimBLxSuitUhsd6tb0TAY6A==',
                                                                                                  'url': 'https://api.nuget.org/v3-flatcontainer/microsoft.extensions.dependencyinjection/10.0.0/microsoft.extensions.dependencyinjection.10.0.0.nupkg',
                                                                                                  'version': '10.0.0'}},
           'dotnet/microsoft.extensions.logging.abstractions/THIRD-PARTY-NOTICES.TXT': {'bytes': 78041,
                                                                                        'covers': ['compiler/_framework/Microsoft.Extensions.Logging.Abstractions.*'],
                                                                                        'sha256': '6d15e10a101c6bfff2ab4429ed061bf76c456fc4b23ad6b03e0d0f8377148a21',
                                                                                        'source': {'archiveSha256': '067860199734d47c134b1a206afabb51eab857b88c037c0f9db7d1c10e118469',
                                                                                                   'archiveSha512': 'CElGLz6i7loG2KuKixPwXzz0Zt5m67xqCpysS+/JHOsYCuA8QgiasMp6Jsp/5bTtGo9z4jXhMI2Zl8lSnDad0Q==',
                                                                                                   'kind': 'nuget',
                                                                                                   'package': 'microsoft.extensions.logging.abstractions',
                                                                                                   'path': 'THIRD-PARTY-NOTICES.TXT',
                                                                                                   'restoreContentHash': 'FU/IfjDfwaMuKr414SSQNTIti/69bHEMb+QKrskRb26oVqpx3lNFXMjs/RC9ZUuhBhcwDM2BwOgoMw+PZ+beqQ==',
                                                                                                   'url': 'https://api.nuget.org/v3-flatcontainer/microsoft.extensions.logging.abstractions/10.0.0/microsoft.extensions.logging.abstractions.10.0.0.nupkg',
                                                                                                   'version': '10.0.0'}},
           'dotnet/microsoft.netcore.app.runtime.mono.browser-wasm/LICENSE.TXT': {'bytes': 1116,
                                                                                  'covers': ['compiler/_framework/*'],
                                                                                  'sha256': 'cfc21f5e8bd655ae997eec916138b707b1d290b83272c02a95c9f821b8c87310',
                                                                                  'source': {'archiveSha256': '1467752acef8971a61a3f464992f16527c528dcd36ea5d15581f9c9e865ebf3b',
                                                                                             'archiveSha512': 'HUMehyDkCtNh477HxKLBm2NqfiImCp5pQJFknJ7XMDHPsQN2UzHHLAdLzQ+0ES9e9aC/lhSd5sS0ri9Gop7B5Q==',
                                                                                             'kind': 'nuget',
                                                                                             'package': 'microsoft.netcore.app.runtime.mono.browser-wasm',
                                                                                             'path': 'LICENSE.TXT',
                                                                                             'restoreContentHash': '7RAMnN/ZL6fjSocFEGSsIeGjZeT2uShNo0+JkkGf7b70i80YLc6rsDVovpifvWhmw8HWOqzXUlLOAcUTCFtzGA==',
                                                                                             'url': 'https://api.nuget.org/v3-flatcontainer/microsoft.netcore.app.runtime.mono.browser-wasm/10.0.12/microsoft.netcore.app.runtime.mono.browser-wasm.10.0.12.nupkg',
                                                                                             'version': '10.0.12'}},
           'dotnet/microsoft.netcore.app.runtime.mono.browser-wasm/THIRD-PARTY-NOTICES.TXT': {'bytes': 76623,
                                                                                              'covers': ['compiler/_framework/*'],
                                                                                              'sha256': '66f1d4e44973185519bb4aa8a9718eb22fc7af2cc532e3ae9cfc4c127ee7fc54',
                                                                                              'source': {'archiveSha256': '1467752acef8971a61a3f464992f16527c528dcd36ea5d15581f9c9e865ebf3b',
                                                                                                         'archiveSha512': 'HUMehyDkCtNh477HxKLBm2NqfiImCp5pQJFknJ7XMDHPsQN2UzHHLAdLzQ+0ES9e9aC/lhSd5sS0ri9Gop7B5Q==',
                                                                                                         'kind': 'nuget',
                                                                                                         'package': 'microsoft.netcore.app.runtime.mono.browser-wasm',
                                                                                                         'path': 'THIRD-PARTY-NOTICES.TXT',
                                                                                                         'restoreContentHash': '7RAMnN/ZL6fjSocFEGSsIeGjZeT2uShNo0+JkkGf7b70i80YLc6rsDVovpifvWhmw8HWOqzXUlLOAcUTCFtzGA==',
                                                                                                         'url': 'https://api.nuget.org/v3-flatcontainer/microsoft.netcore.app.runtime.mono.browser-wasm/10.0.12/microsoft.netcore.app.runtime.mono.browser-wasm.10.0.12.nupkg',
                                                                                                         'version': '10.0.12'}},
           'dotnet/roslyn/THIRD-PARTY-NOTICES.txt': {'bytes': 524150,
                                                     'covers': ['compiler/_framework/Microsoft.CodeAnalysis.*'],
                                                     'sha256': '9879407362c623ca2af5d0460a556d25a2fa1afbaa6530707963fc7166102d4d',
                                                     'source': {'commit': '35b593bebfcba58f8e78298cef14c2761f5d86c6',
                                                                'kind': 'git',
                                                                'path': 'src/roslyn/THIRD-PARTY-NOTICES.txt',
                                                                'repository': 'https://github.com/dotnet/dotnet'}},
           'emscripten/AUTHORS': {'bytes': 29142,
                                  'covers': ['lld/netwasm-lld.*', 'runtime/*'],
                                  'sha256': '018d4191aa649d5c82ba1b2f9117b9902648792c89d5f0d5564a689dc4198aaa',
                                  'source': {'commit': '4483d70a78098ed5d860dff2dc21f3025b2da2ee',
                                             'kind': 'git',
                                             'path': 'AUTHORS',
                                             'repository': 'https://github.com/emscripten-core/emscripten'}},
           'emscripten/LICENSE': {'bytes': 5093,
                                  'covers': ['lld/netwasm-lld.*', 'runtime/*'],
                                  'sha256': '620a78084fc7ca97c0b5dea9abf891f3ffcadfdbf305276f099c9c4e12fc1d86',
                                  'source': {'commit': '4483d70a78098ed5d860dff2dc21f3025b2da2ee',
                                             'kind': 'git',
                                             'path': 'LICENSE',
                                             'repository': 'https://github.com/emscripten-core/emscripten'}},
           'emscripten/system/lib/compiler-rt/LICENSE.TXT': {'bytes': 16708,
                                                             'covers': ['lld/netwasm-lld.*', 'runtime/*'],
                                                             'sha256': '1a8f1058753f1ba890de984e48f0242a3a5c29a6a8f2ed9fd813f36985387e8d',
                                                             'source': {'commit': '4483d70a78098ed5d860dff2dc21f3025b2da2ee',
                                                                        'kind': 'git',
                                                                        'path': 'system/lib/compiler-rt/LICENSE.TXT',
                                                                        'repository': 'https://github.com/emscripten-core/emscripten'}},
           'emscripten/system/lib/libc/musl/COPYRIGHT': {'bytes': 6196,
                                                         'covers': ['lld/netwasm-lld.*', 'runtime/*'],
                                                         'sha256': 'b870108ec5e7790e9f9919064f1b9421d62d5f9b0e6c230c6adf7ea2da62e97b',
                                                         'source': {'commit': '4483d70a78098ed5d860dff2dc21f3025b2da2ee',
                                                                    'kind': 'git',
                                                                    'path': 'system/lib/libc/musl/COPYRIGHT',
                                                                    'repository': 'https://github.com/emscripten-core/emscripten'}},
           'jco/jco-transpile/LICENSE': {'bytes': 12243,
                                         'covers': ['jco/*'],
                                         'sha256': '268872b9816f90fd8e85db5a28d33f8150ebb8dd016653fb39ef1f94f2686bc5',
                                         'source': {'archiveSha256': 'a7ef7628e5d57c768b3e51f1e54ef4027715ac279c98916593f4a121b6f9cf83',
                                                    'archiveSha512': 'hU+/ohr85EWuc6ULZQ0Vfi0tKpgBghOYYIN5DxxUq/zIPoKVfoouj/jTBy6xBoPFzL7J5UuILQvQkYJkhm+PNg==',
                                                    'kind': 'nuget',
                                                    'package': 'netwasm.toolchain',
                                                    'path': 'tools/jco/node_modules/@bytecodealliance/jco-transpile/LICENSE',
                                                    'restoreContentHash': 'VIOturRaJK/pjNwybp2XC+etpQfieqQm7HYWsVUckVhpslrgS9i3uZp3j5AzIHBBsxNCj2gOOFPaJYbhAdZ4kQ==',
                                                    'url': 'https://api.nuget.org/v3-flatcontainer/netwasm.toolchain/0.1.0/netwasm.toolchain.0.1.0.nupkg',
                                                    'version': '0.1.0'}},
           'jco/jco/LICENSE': {'bytes': 12243,
                               'covers': ['jco/*'],
                               'sha256': '268872b9816f90fd8e85db5a28d33f8150ebb8dd016653fb39ef1f94f2686bc5',
                               'source': {'archiveSha256': 'a7ef7628e5d57c768b3e51f1e54ef4027715ac279c98916593f4a121b6f9cf83',
                                          'archiveSha512': 'hU+/ohr85EWuc6ULZQ0Vfi0tKpgBghOYYIN5DxxUq/zIPoKVfoouj/jTBy6xBoPFzL7J5UuILQvQkYJkhm+PNg==',
                                          'kind': 'nuget',
                                          'package': 'netwasm.toolchain',
                                          'path': 'tools/jco/node_modules/@bytecodealliance/jco/LICENSE',
                                          'restoreContentHash': 'VIOturRaJK/pjNwybp2XC+etpQfieqQm7HYWsVUckVhpslrgS9i3uZp3j5AzIHBBsxNCj2gOOFPaJYbhAdZ4kQ==',
                                          'url': 'https://api.nuget.org/v3-flatcontainer/netwasm.toolchain/0.1.0/netwasm.toolchain.0.1.0.nupkg',
                                          'version': '0.1.0'}},
           'jco/notices.json': {'bytes': 24354,
                                'covers': ['jco/*'],
                                'sha256': 'b4f5739409454b2dc09293c1647dea901ec30f8876c40aecbcb3f070200224c4',
                                'source': {'archiveSha256': 'a7ef7628e5d57c768b3e51f1e54ef4027715ac279c98916593f4a121b6f9cf83',
                                           'archiveSha512': 'hU+/ohr85EWuc6ULZQ0Vfi0tKpgBghOYYIN5DxxUq/zIPoKVfoouj/jTBy6xBoPFzL7J5UuILQvQkYJkhm+PNg==',
                                           'kind': 'nuget',
                                           'package': 'netwasm.toolchain',
                                           'path': 'tools/jco/notices.json',
                                           'restoreContentHash': 'VIOturRaJK/pjNwybp2XC+etpQfieqQm7HYWsVUckVhpslrgS9i3uZp3j5AzIHBBsxNCj2gOOFPaJYbhAdZ4kQ==',
                                           'url': 'https://api.nuget.org/v3-flatcontainer/netwasm.toolchain/0.1.0/netwasm.toolchain.0.1.0.nupkg',
                                           'version': '0.1.0'}},
           'jco/preview2-shim/LICENSE': {'bytes': 12243,
                                         'covers': ['jco/*'],
                                         'sha256': '268872b9816f90fd8e85db5a28d33f8150ebb8dd016653fb39ef1f94f2686bc5',
                                         'source': {'archiveSha256': 'a7ef7628e5d57c768b3e51f1e54ef4027715ac279c98916593f4a121b6f9cf83',
                                                    'archiveSha512': 'hU+/ohr85EWuc6ULZQ0Vfi0tKpgBghOYYIN5DxxUq/zIPoKVfoouj/jTBy6xBoPFzL7J5UuILQvQkYJkhm+PNg==',
                                                    'kind': 'nuget',
                                                    'package': 'netwasm.toolchain',
                                                    'path': 'tools/jco/node_modules/@bytecodealliance/preview2-shim/LICENSE',
                                                    'restoreContentHash': 'VIOturRaJK/pjNwybp2XC+etpQfieqQm7HYWsVUckVhpslrgS9i3uZp3j5AzIHBBsxNCj2gOOFPaJYbhAdZ4kQ==',
                                                    'url': 'https://api.nuget.org/v3-flatcontainer/netwasm.toolchain/0.1.0/netwasm.toolchain.0.1.0.nupkg',
                                                    'version': '0.1.0'}},
           'llvm/lib/Support/BLAKE3/LICENSE': {'bytes': 18691,
                                               'covers': ['lld/netwasm-lld.wasm'],
                                               'sha256': '6a94bedb8b707ed97f6e310d0d015ab14e0683ffa0a612b02958581b9cc9fc0e',
                                               'source': {'commit': '4cc02503f584aad493a1d0d35bb5afb710a5510b',
                                                          'kind': 'git',
                                                          'path': 'llvm/lib/Support/BLAKE3/LICENSE',
                                                          'repository': 'https://github.com/llvm/llvm-project'}},
           'llvm/lib/Support/COPYRIGHT.regex': {'bytes': 2718,
                                                'covers': ['lld/netwasm-lld.wasm'],
                                                'sha256': '0424e57d4303164dc59a8509c20dae0518b853692e5c2b0e98b11816fdbc97c7',
                                                'source': {'commit': '4cc02503f584aad493a1d0d35bb5afb710a5510b',
                                                           'kind': 'git',
                                                           'path': 'llvm/lib/Support/COPYRIGHT.regex',
                                                           'repository': 'https://github.com/llvm/llvm-project'}},
           'netwasm-libraries/LICENSE-MAP.md': {'bytes': 403,
                                                'covers': ['implementations/System.*',
                                                           'references/System.*',
                                                           'compiler/target-*.dll',
                                                                   'implementations/Microsoft.Extensions.*',
                                                                   'references/Microsoft.Extensions.*',
                                                                   'compiler/_framework/NetWasm.Microsoft.Extensions.DependencyInjection.Generator.*'],
                                                'sha256': 'e6896725f2ad5a63b62755a0119e66cb8f30afb6ab8be1c6e37c82da1251c5f2',
                                                'source': {'commit': '628cc17d25327d111950363494bd90ff3dcee2b7',
                                                           'kind': 'git',
                                                           'path': 'LICENSE-MAP.md',
                                                           'repository': 'https://github.com/zion-sati/NetWasm.Libraries'}},
           'netwasm-libraries/LICENSES/MIT.txt': {'bytes': 1078,
                                                  'covers': ['implementations/System.*',
                                                             'references/System.*',
                                                             'compiler/target-*.dll',
                                                                   'implementations/Microsoft.Extensions.*',
                                                                   'references/Microsoft.Extensions.*',
                                                                   'compiler/_framework/NetWasm.Microsoft.Extensions.DependencyInjection.Generator.*'],
                                                  'sha256': 'e13634f149ae4557df3f8bd1f14a57e39e1cc8581f2fa1c9b7b35fed443ee148',
                                                  'source': {'commit': '628cc17d25327d111950363494bd90ff3dcee2b7',
                                                             'kind': 'git',
                                                             'path': 'LICENSES/MIT.txt',
                                                             'repository': 'https://github.com/zion-sati/NetWasm.Libraries'}},
           'netwasm-libraries/THIRD-PARTY-NOTICES.md': {'bytes': 328,
                                                        'covers': ['implementations/System.*',
                                                                   'references/System.*',
                                                                   'compiler/target-*.dll',
                                                                   'implementations/Microsoft.Extensions.*',
                                                                   'references/Microsoft.Extensions.*',
                                                                   'compiler/_framework/NetWasm.Microsoft.Extensions.DependencyInjection.Generator.*'],
                                                        'sha256': 'ad8ae6f60ad9827fbce06d82cfcea5e986e84516ff22195cab9e277498e66889',
                                                        'source': {'commit': '628cc17d25327d111950363494bd90ff3dcee2b7',
                                                                   'kind': 'git',
                                                                   'path': 'THIRD-PARTY-NOTICES.md',
                                                                   'repository': 'https://github.com/zion-sati/NetWasm.Libraries'}},
           'netwasm-libraries/UPSTREAM_PROVENANCE.md': {'bytes': 2057,
                                                        'covers': ['implementations/System.*',
                                                                   'references/System.*',
                                                                   'compiler/target-*.dll',
                                                                   'implementations/Microsoft.Extensions.*',
                                                                   'references/Microsoft.Extensions.*',
                                                                   'compiler/_framework/NetWasm.Microsoft.Extensions.DependencyInjection.Generator.*'],
                                                        'sha256': '54279a361d8221398d2a56e826579cca7590a082bd61664cc1fea92ff69d20f1',
                                                        'source': {'commit': '628cc17d25327d111950363494bd90ff3dcee2b7',
                                                                   'kind': 'git',
                                                                   'path': 'UPSTREAM_PROVENANCE.md',
                                                                   'repository': 'https://github.com/zion-sati/NetWasm.Libraries'}},
           'netwasm/LICENSE-MAP.md': {'bytes': 1984,
                                      'covers': ['compiler/NetWasm.*',
                                                 'hosts/*',
                                                 'hosting/*',
                                                 'runtime/*',
                                                 'references/*'],
                                      'sha256': 'e6f3f6c567c71916685c696812fd2291350757a2cba752ce2d7ec60ca3dcfc39',
                                      'source': {'commit': '743ceacf2e40edeba9fccf531979c45b12552ea2',
                                                 'kind': 'git',
                                                 'path': 'LICENSE-MAP.md',
                                                 'repository': 'https://github.com/zion-sati/NetWasm'}},
           'netwasm/LICENSES/LicenseRef-NetWasm-Community-1.0.txt': {'bytes': 23878,
                                                                     'covers': ['compiler/NetWasm.*',
                                                                                'hosts/*',
                                                                                'hosting/*',
                                                                                'runtime/*',
                                                                                'references/*'],
                                                                     'sha256': 'cbea962e1c0871e0e9288ca8eff5b3f8f15ce81123d6f05d5f0b48aca3c2a093',
                                                                     'source': {'commit': '743ceacf2e40edeba9fccf531979c45b12552ea2',
                                                                                'kind': 'git',
                                                                                'path': 'LICENSES/LicenseRef-NetWasm-Community-1.0.txt',
                                                                                'repository': 'https://github.com/zion-sati/NetWasm'}},
           'netwasm/THIRD-PARTY-NOTICES.TXT': {'bytes': 4036,
                                               'covers': ['compiler/NetWasm.*',
                                                          'hosts/*',
                                                          'hosting/*',
                                                          'runtime/*',
                                                          'references/*'],
                                               'sha256': 'd186240d601760b3e64025ab129d05826b433f06c20d115383e688c989e58109',
                                               'source': {'commit': '743ceacf2e40edeba9fccf531979c45b12552ea2',
                                                          'kind': 'git',
                                                          'path': 'THIRD-PARTY-NOTICES.TXT',
                                                          'repository': 'https://github.com/zion-sati/NetWasm'}},
           'netwasm/THIRD-PARTY-NOTICES.md': {'bytes': 1384,
                                              'covers': ['compiler/NetWasm.*',
                                                         'hosts/*',
                                                         'hosting/*',
                                                         'runtime/*',
                                                         'references/*'],
                                              'sha256': 'bddc81eaab724ca5cf70a8e3c11929f4fb1c4d9013ceba8e780e5157f7187a52',
                                              'source': {'commit': '743ceacf2e40edeba9fccf531979c45b12552ea2',
                                                         'kind': 'git',
                                                         'path': 'THIRD-PARTY-NOTICES.md',
                                                         'repository': 'https://github.com/zion-sati/NetWasm'}},
           'path-browserify/LICENSE': {'bytes': 1071,
                                       'covers': ['path-browserify.js'],
                                       'sha256': 'a22b9d5763f574e5db347c30acc0b33eaf4846767c03d2e27d012e864e79a824',
                                       'source': {'archiveSha256': '74ad6965c6f8cb61d17b1798d48095c3238eca5707b517640a12150f17b8f93d',
                                                  'integrity': 'sha512-b7uo2UCUOYZcnF/3ID0lulOJi/bafxa1xPe7ZPsammBSpjSWQkjNxlt635YGS2MiR9GjvuXCtz2emr3jbsz98g==',
                                                  'kind': 'npm',
                                                  'path': 'package/LICENSE',
                                                  'url': 'https://registry.npmjs.org/path-browserify/-/path-browserify-1.0.1.tgz',
                                                  'version': '1.0.1'}},
           'tunit/netwasm.tunit.assertions/LICENSE': {'bytes': 1070,
                                                      'covers': ['recipes/tunit*.json',
                                                                 'compiler/_framework/*TUnit*',
                                                                 'implementations/{NetWasm.TUnit.Runner,TUnit.Core,TUnit.Assertions}.dll'],
                                                      'sha256': '53d1954a8bfd660bd53fa5cec8a47349e15bcbffc0b673f36997e7603fb58dc8',
                                                      'source': {'archiveSha256': 'cadbc8744e398f7528c55c7a73c94b2bf3b83d6f8462d7bbeefe62f358371339',
                                                                 'archiveSha512': 'gf8s0Np3ip0+YTUm/oAme20wmiQrBwk5DgdKmi9EzpVAydWszfSaeiCI+HaAWWj9Knn89GT9wagUFwMlPHmhnw==',
                                                                 'kind': 'nuget',
                                                                 'package': 'netwasm.tunit.assertions',
                                                                 'path': 'LICENSE',
                                                                 'restoreContentHash': 'NUqEi97TN14hZtBaOw0nstLeCdN6M5mYBKaRqLHT5p6HXglw5FIPMuLKdRYUeHDg/sSFswSvjY8OBGlpCGY9kg==',
                                                                 'url': 'https://api.nuget.org/v3-flatcontainer/netwasm.tunit.assertions/0.1.0/netwasm.tunit.assertions.0.1.0.nupkg',
                                                                 'version': '0.1.0'}},
           'tunit/netwasm.tunit.core/LICENSE': {'bytes': 1070,
                                                'covers': ['recipes/tunit*.json',
                                                           'compiler/_framework/*TUnit*',
                                                           'implementations/{NetWasm.TUnit.Runner,TUnit.Core,TUnit.Assertions}.dll'],
                                                'sha256': '53d1954a8bfd660bd53fa5cec8a47349e15bcbffc0b673f36997e7603fb58dc8',
                                                'source': {'archiveSha256': '4f8bd7674bffabcc3526a941af347d12449ae3b86413436825b4d9fb186fc63f',
                                                           'archiveSha512': 'inEz01isEfvkSmeGM5/3xcQ4tRkTOOFXx1qhDEA4kJz8yfvsMcLzxYcszEKxBaGLLp+C/YY6JXrpM7Lzj0rQ8g==',
                                                           'kind': 'nuget',
                                                           'package': 'netwasm.tunit.core',
                                                           'path': 'LICENSE',
                                                           'restoreContentHash': 'iyRjhlSt6YpdC8iApgDwyPJU8GwreDGMV4aSyblAY8bI5aiDBgd+yxMNs8SOfA1ouV+ssM2YR5QqCd/3XXv4Vw==',
                                                           'url': 'https://api.nuget.org/v3-flatcontainer/netwasm.tunit.core/0.1.0/netwasm.tunit.core.0.1.0.nupkg',
                                                           'version': '0.1.0'}},
           'tunit/netwasm.tunit/LICENSE': {'bytes': 1070,
                                           'covers': ['recipes/tunit*.json',
                                                      'compiler/_framework/*TUnit*',
                                                      'implementations/{NetWasm.TUnit.Runner,TUnit.Core,TUnit.Assertions}.dll'],
                                           'sha256': '53d1954a8bfd660bd53fa5cec8a47349e15bcbffc0b673f36997e7603fb58dc8',
                                           'source': {'archiveSha256': '0578f43d968d71f6856c2cffc685cce1a79c0964fb910f2bb52704ef2cd73d74',
                                                      'archiveSha512': 'lVejYG7592hPSTkeLWZqGP8b/ijxtSwvDlbjaCbwJWUQIn1rWpBSsXRFq1U38fdxZ9bOXDm2JDnZbi1TPp08Aw==',
                                                      'kind': 'nuget',
                                                      'package': 'netwasm.tunit',
                                                      'path': 'LICENSE',
                                                      'restoreContentHash': 'gnnOx9sjE+aou1WHqfKNt3PnOPpJ93Gr5JSZwHrCyARRCtXVvm4UyYWtS2L7nZ1PAxvyxz91ZfgbIcWz+pcR0w==',
                                                      'url': 'https://api.nuget.org/v3-flatcontainer/netwasm.tunit/0.1.0/netwasm.tunit.0.1.0.nupkg',
                                                      'version': '0.1.0'}},
           'wasi/LICENSE.md': {'bytes': 410,
                               'covers': ['*.wit.wasm'],
                               'sha256': '0416590f3f47381bb5b9b467c27824d1228fac58b8031d693130865273ffefcb',
                               'source': {'commit': '743ceacf2e40edeba9fccf531979c45b12552ea2',
                                          'kind': 'git',
                                          'path': 'src/NetWasm.Runtime/wit/LICENSE.md',
                                          'repository': 'https://github.com/zion-sati/NetWasm'}},
           'wasm-tools/LICENSE-APACHE': {'bytes': 10847,
                                         'covers': ['wasm-tools.wasm'],
                                         'sha256': 'a60eea817514531668d7e00765731449fe14d059d3249e0bc93b36de45f759f2',
                                         'source': {'archiveSha256': 'a7ef7628e5d57c768b3e51f1e54ef4027715ac279c98916593f4a121b6f9cf83',
                                                    'archiveSha512': 'hU+/ohr85EWuc6ULZQ0Vfi0tKpgBghOYYIN5DxxUq/zIPoKVfoouj/jTBy6xBoPFzL7J5UuILQvQkYJkhm+PNg==',
                                                    'kind': 'nuget',
                                                    'package': 'netwasm.toolchain',
                                                    'path': 'tools/wasm-tools/LICENSE-APACHE',
                                                    'restoreContentHash': 'VIOturRaJK/pjNwybp2XC+etpQfieqQm7HYWsVUckVhpslrgS9i3uZp3j5AzIHBBsxNCj2gOOFPaJYbhAdZ4kQ==',
                                                    'url': 'https://api.nuget.org/v3-flatcontainer/netwasm.toolchain/0.1.0/netwasm.toolchain.0.1.0.nupkg',
                                                    'version': '0.1.0'}},
           'wasm-tools/LICENSE-Apache-2.0_WITH_LLVM-exception': {'bytes': 12243,
                                                                 'covers': ['wasm-tools.wasm'],
                                                                 'sha256': '268872b9816f90fd8e85db5a28d33f8150ebb8dd016653fb39ef1f94f2686bc5',
                                                                 'source': {'archiveSha256': 'a7ef7628e5d57c768b3e51f1e54ef4027715ac279c98916593f4a121b6f9cf83',
                                                                            'archiveSha512': 'hU+/ohr85EWuc6ULZQ0Vfi0tKpgBghOYYIN5DxxUq/zIPoKVfoouj/jTBy6xBoPFzL7J5UuILQvQkYJkhm+PNg==',
                                                                            'kind': 'nuget',
                                                                            'package': 'netwasm.toolchain',
                                                                            'path': 'tools/wasm-tools/LICENSE-Apache-2.0_WITH_LLVM-exception',
                                                                            'restoreContentHash': 'VIOturRaJK/pjNwybp2XC+etpQfieqQm7HYWsVUckVhpslrgS9i3uZp3j5AzIHBBsxNCj2gOOFPaJYbhAdZ4kQ==',
                                                                            'url': 'https://api.nuget.org/v3-flatcontainer/netwasm.toolchain/0.1.0/netwasm.toolchain.0.1.0.nupkg',
                                                                            'version': '0.1.0'}},
           'wasm-tools/LICENSE-MIT': {'bytes': 1023,
                                      'covers': ['wasm-tools.wasm'],
                                      'sha256': '23f18e03dc49df91622fe2a76176497404e46ced8a715d9d2b67a7446571cca3',
                                      'source': {'archiveSha256': 'a7ef7628e5d57c768b3e51f1e54ef4027715ac279c98916593f4a121b6f9cf83',
                                                 'archiveSha512': 'hU+/ohr85EWuc6ULZQ0Vfi0tKpgBghOYYIN5DxxUq/zIPoKVfoouj/jTBy6xBoPFzL7J5UuILQvQkYJkhm+PNg==',
                                                 'kind': 'nuget',
                                                 'package': 'netwasm.toolchain',
                                                 'path': 'tools/wasm-tools/LICENSE-MIT',
                                                 'restoreContentHash': 'VIOturRaJK/pjNwybp2XC+etpQfieqQm7HYWsVUckVhpslrgS9i3uZp3j5AzIHBBsxNCj2gOOFPaJYbhAdZ4kQ==',
                                                 'url': 'https://api.nuget.org/v3-flatcontainer/netwasm.toolchain/0.1.0/netwasm.toolchain.0.1.0.nupkg',
                                                 'version': '0.1.0'}}},
 'missingSourceNotices': [],
 'schemaVersion': 1}


def encoded(value):
    return (json.dumps(value, sort_keys=True, indent=2) + '\n').encode()


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def relative(value):
    path = PurePosixPath(value)
    if not value or '\\' in value or path.is_absolute() or '..' in path.parts or str(path) != value:
        raise ValueError('Notice path must be a normalized relative path')
    return value


def load(path):
    return json.loads(path.read_text())


def download(url, cache, expected_sha=None, limit=2 * 1024 * 1024):
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme != 'https' or parsed.hostname not in {'raw.githubusercontent.com', 'registry.npmjs.org'}:
        raise ValueError('Notice download must use an approved public origin')
    cached = cache / sha256(url.encode())
    if cached.exists():
        data = cached.read_bytes()
    else:
        request = urllib.request.Request(url, headers={'User-Agent': 'NetWasm-Playground-notice-stager'})
        with urllib.request.urlopen(request, timeout=30) as response:
            if urllib.parse.urlparse(response.url).hostname != parsed.hostname:
                raise ValueError('Notice download changed origin')
            data = response.read(limit + 1)
        if len(data) > limit:
            raise ValueError('Public notice input exceeds its size bound')
        if expected_sha and sha256(data) != expected_sha:
            raise ValueError('Public source notice hash mismatch')
        cached.write_bytes(data)
    if len(data) > limit or (expected_sha and sha256(data) != expected_sha):
        raise ValueError('Cached public notice hash or size mismatch')
    return data


def git_origin(repository, commit, path):
    repository = repository.removesuffix('.git').rstrip('/')
    parsed = urllib.parse.urlparse(repository)
    allowed = {'zion-sati/NetWasm', 'zion-sati/NetWasm.Libraries', 'zion-sati/TUnit-NetWasm',
               'dotnet/dotnet', 'emscripten-core/emscripten', 'llvm/llvm-project', 'ivmai/bdwgc'}
    repo_path = parsed.path.lstrip('/')
    path = relative(path)
    if parsed.scheme != 'https' or parsed.hostname != 'github.com' or repo_path not in allowed:
        raise ValueError('Unknown public source repository')
    if len(commit) != 40 or any(c not in '0123456789abcdef' for c in commit):
        raise ValueError('Public notice source needs an exact Git commit')
    return repository, repo_path, path


def github_file(source, cache):
    commit = source['commit']
    repository, repo_path, path = git_origin(source['repository'], commit, source['path'])
    url = f'https://raw.githubusercontent.com/{repo_path}/{commit}/{path}'
    data = download(url, cache, source['sha256'])
    return data, {'kind': 'git', 'repository': repository, 'commit': commit, 'path': path}


def git_file(row):
    source = Path(row['sourceFile']).resolve()
    check = row['verification']
    repo = Path(subprocess.check_output(['git', '-C', str(source.parent), 'rev-parse', '--show-toplevel'], text=True).strip())
    remote = subprocess.check_output(['git', '-C', str(repo), 'remote', 'get-url', 'origin'], text=True).strip()
    repository, _, path = git_origin(row['publicOrigin'].split('/tree/')[0], check['gitCommit'], check['gitPath'])
    if remote.removesuffix('.git') != repository:
        raise ValueError('Git notice checkout has an unexpected public origin')
    data = subprocess.check_output(['git', '-C', str(repo), 'show', check['gitCommit'] + ':' + path])
    return data, {'kind': 'git', 'repository': repository, 'commit': check['gitCommit'], 'path': path}


def nuget_file(row):
    source = Path(row['sourceFile']).resolve()
    check = row['verification']
    package, version = check['package'].lower(), check['version']
    archive_name = f'{package}.{version}.nupkg'
    folder = next((p for p in source.parents if (p / archive_name).is_file()), None)
    if folder is None:
        raise ValueError('Notice package archive is unavailable')
    archive = (folder / archive_name).read_bytes()
    if sha256(archive) != check['nupkgSha256']:
        raise ValueError('Notice package archive hash mismatch')
    metadata = load(folder / '.nupkg.metadata')
    actual_content_hash = base64.b64encode(hashlib.sha512(archive).digest()).decode()
    # Signed package archives and NuGet's restore content hash can differ. The
    # retained archive checksum binds the ZIP bytes; preserve both hashes.
    archive_hash = (folder / (archive_name + '.sha512')).read_text().strip()
    if metadata['source'] != 'https://api.nuget.org/v3/index.json' or archive_hash != actual_content_hash:
        raise ValueError('Notice package is not bound to its NuGet.org restore metadata')
    path = relative(source.relative_to(folder).as_posix())
    with zipfile.ZipFile(io.BytesIO(archive)) as package_zip:
        nuspecs = [name for name in package_zip.namelist() if '/' not in name and name.endswith('.nuspec')]
        if len(nuspecs) != 1:
            raise ValueError('Notice package must contain one package manifest')
        manifest = ET.fromstring(package_zip.read(nuspecs[0]))
        fields = {node.tag.split('}')[-1]: node.text for node in manifest.iter()}
        if fields.get('id', '').lower() != package or fields.get('version') != version:
            raise ValueError('Notice package identity mismatch')
        data = package_zip.read(path)
    origin = f'https://api.nuget.org/v3-flatcontainer/{package}/{version}/{archive_name}'
    if origin != row['publicOrigin']:
        raise ValueError('Notice package public archive URL mismatch')
    return data, {'kind': 'nuget', 'package': package, 'version': version, 'url': origin,
                  'archiveSha256': sha256(archive), 'archiveSha512': actual_content_hash,
                  'restoreContentHash': metadata['contentHash'], 'path': path}


def npm_file(row, cache):
    check = row['verification']
    lock = load(Path(check['lockFile']))
    source = Path(row['sourceFile']).resolve()
    packages = lock['packages']
    entry = next((value for value in packages.values()
                  if value.get('resolved') == row['publicOrigin'] and value.get('version') == check['npmVersion']), None)
    if not entry or entry.get('integrity') != check['integrity']:
        raise ValueError('Notice npm input differs from its public package lock')
    archive = download(entry['resolved'], cache, limit=10 * 1024 * 1024)
    algorithm, digest = entry['integrity'].split('-', 1)
    if algorithm != 'sha512' or base64.b64encode(hashlib.sha512(archive).digest()).decode() != digest:
        raise ValueError('Notice npm archive integrity mismatch')
    path = 'package/' + source.name
    with tarfile.open(fileobj=io.BytesIO(archive), mode='r:gz') as package_tar:
        member = package_tar.getmember(path)
        if not member.isfile() or member.size > 2 * 1024 * 1024:
            raise ValueError('npm notice must be a bounded regular archive file')
        data = package_tar.extractfile(member).read()
    return data, {'kind': 'npm', 'url': entry['resolved'], 'version': entry['version'],
                  'integrity': entry['integrity'], 'archiveSha256': sha256(archive), 'path': path}


def verify(folder):
    origins = load(folder / 'origins.json')
    if origins.get('schemaVersion') != 1:
        raise ValueError('Unknown notice origins schema')
    if origins['files'] != PUBLIC_CATALOG['files'] or origins.get('missingSourceNotices') != PUBLIC_CATALOG['missingSourceNotices']:
        raise ValueError('Notice origins differ from the pinned public catalog')
    expected = {'origins.json'}
    for path, item in origins['files'].items():
        relative(path)
        file = folder / path
        if file.is_symlink() or not file.is_file():
            raise ValueError('Staged notice is not a regular file')
        data = file.read_bytes()
        if len(data) != item['bytes'] or sha256(data) != item['sha256']:
            raise ValueError('Staged notice hash mismatch: ' + path)
        expected.add(path)
    actual = {p.relative_to(folder).as_posix() for p in folder.rglob('*') if p.is_file()}
    if actual != expected:
        raise ValueError('Unexpected or missing staged notice files')
    for value in walk_strings(origins):
        if value.startswith('/') or '/Users/' in value or '/.cache/' in value or '\\' in value:
            raise ValueError('Notice origins contain a local path')
    print(f"PASS: {len(origins['files'])} public notice files verified")


def walk_strings(value):
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for key, item in value.items():
            yield key
            yield from walk_strings(item)
    elif isinstance(value, list):
        for item in value:
            yield from walk_strings(item)


def catalog_entries(args):
    for target, entry in PUBLIC_CATALOG['files'].items():
        source = entry['source']
        if source['kind'] == 'git':
            data, origin = github_file({**source, 'sha256': entry['sha256']}, args.cache)
        elif source['kind'] == 'nuget':
            package, version = source['package'], source['version']
            folder = next((root / package / version for root in args.packages
                           if (root / package / version / f'{package}.{version}.nupkg').is_file()), None)
            if folder is None:
                raise ValueError(f'Public package unavailable; supply its package root: {package}/{version}')
            row = {'sourceFile': str(folder / source['path']), 'publicOrigin': source['url'],
                   'verification': {'package': package, 'version': version, 'nupkgSha256': source['archiveSha256']}}
            data, origin = nuget_file(row)
        elif source['kind'] == 'npm':
            archive = download(source['url'], args.cache, source['archiveSha256'], limit=10 * 1024 * 1024)
            algorithm, digest = source['integrity'].split('-', 1)
            if algorithm != 'sha512' or base64.b64encode(hashlib.sha512(archive).digest()).decode() != digest:
                raise ValueError('Public catalog npm archive integrity mismatch')
            with tarfile.open(fileobj=io.BytesIO(archive), mode='r:gz') as package_tar:
                member = package_tar.getmember(relative(source['path']))
                if not member.isfile() or member.size > 2 * 1024 * 1024:
                    raise ValueError('Public catalog npm notice is not a bounded regular file')
                data = package_tar.extractfile(member).read()
            origin = source
        else:
            raise ValueError('Unknown public notice catalog source')
        if len(data) != entry['bytes'] or sha256(data) != entry['sha256'] or origin != source:
            raise ValueError('Verified source differs from public notice catalog: ' + target)
        yield target, data, entry['covers'], origin


def audit_entries(args):
    audit = load(args.audit)
    inputs = load(args.public_inputs) if args.public_inputs else {'files': {}}
    if audit.get('schemaVersion') != 1 or inputs.get('schemaVersion', 1) != 1:
        raise ValueError('Unknown notice input schema')
    for row in audit['proposedCopies']:
        original_target = relative(row['target']).removeprefix('notices/')
        replacement = inputs['files'].get(original_target)
        target = relative(replacement.get('target', original_target) if replacement else original_target)
        check = row['verification'] or {}
        if replacement:
            data, origin = github_file(replacement, args.cache)
            if not replacement.get('replacesDifferentNotice') and sha256(data) != row['sha256']:
                raise ValueError('Owning public source differs from the audited notice')
        elif check.get('package'):
            data, origin = nuget_file(row)
        elif check.get('npmVersion'):
            data, origin = npm_file(row, args.cache)
        elif check.get('gitCommit') and 'llvm-project-' not in row['sourceFile']:
            data, origin = git_file(row)
        elif check.get('gitCommit'):
            data, origin = github_file({'repository': row['publicOrigin'].split('/tree/')[0],
                                       'commit': check['gitCommit'], 'path': check['gitPath'],
                                       'sha256': row['sha256']}, args.cache)
        else:
            raise ValueError('Version-only notice needs a pinned public-source input: ' + original_target)
        if not replacement and (len(data) != row['bytes'] or sha256(data) != row['sha256']):
            raise ValueError('Verified source differs from audited notice: ' + original_target)
        yield target, data, row['covers'], origin


def stage(args):
    args.cache.mkdir(parents=True, exist_ok=True)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    files = {}
    with tempfile.TemporaryDirectory(prefix='.notices-', dir=args.output.parent) as temporary:
        folder = Path(temporary)
        entries = audit_entries(args) if args.audit else catalog_entries(args)
        for target, data, covers, origin in entries:
            if target in files:
                raise ValueError('Duplicate staged notice path')
            destination = folder / target
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(data)
            files[target] = {'bytes': len(data), 'sha256': sha256(data), 'covers': covers, 'source': origin}
        origins = {'schemaVersion': 1, 'files': files,
                   'missingSourceNotices': (load(args.audit)['missingPublicSourceInputs'] if args.audit
                                            else PUBLIC_CATALOG['missingSourceNotices']),
                   'coverageNotes': [
                       'License texts and notices are retained unchanged from their identified public inputs.',
                       'Source license maps describe the applicable NetWasm paths and retained third-party attribution.',
                       'Some source notice files describe additional components in their owning upstream source tree.',
                       'Build-only tools absent from the browser bundle, including VSTest and the Node bundler, are omitted.'
                   ]}
        (folder / 'origins.json').write_bytes(encoded(origins))
        verify(folder)
        if args.output.exists():
            verify(args.output)
            if (args.output / 'origins.json').read_bytes() != encoded(origins):
                raise ValueError('Output already contains a different notice set; use a new output directory')
        else:
            shutil.copytree(folder, args.output)
    print('Staged notices: ' + str(args.output))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--audit', type=Path, help='Ignored audit with exact source file hashes and public origins')
    parser.add_argument('--packages', type=Path, action='append', default=[],
                        help='NuGet global-packages root containing catalog packages; repeat for separate caches')
    parser.add_argument('--public-inputs', type=Path, help='Pinned Git-file counterparts for version-only SDK inputs')
    parser.add_argument('--cache', type=Path, help='Owned ignored directory for small public downloads')
    parser.add_argument('--output', type=Path, help='New ignored directory copied into bundle notices/')
    parser.add_argument('--verify', type=Path, help='Verify an existing notice directory without network access')
    args = parser.parse_args()
    if args.verify:
        verify(args.verify)
    elif args.output and args.cache and (args.audit or args.packages):
        stage(args)
    else:
        parser.error('Staging requires --packages (repeatable), --cache and --output; --audit is optional')


if __name__ == '__main__':
    main()
