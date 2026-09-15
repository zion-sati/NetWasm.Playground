using System;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Runtime.InteropServices.JavaScript;
using System.Runtime.Versioning;
using System.Text;
using Microsoft.CodeAnalysis.Text;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using NetWasm.Compiler;
using NetWasm.Compiler.Browser;
using NetWasm.Compiler.Core;
using System.Collections.Generic;
using System.Reflection.PortableExecutable;

[assembly: SupportedOSPlatform("browser")]

namespace NetWasm.Playground.CompilerProbe;

public static partial class Program
{
    public sealed record SupportSource(string path, string text);

    public static void Main() { }

    private static string Bound(string text) => text.Length <= 4096 ? text : text[..4096];

    [JSExport]
    public static string Compile(string source, string reference, string supportJson, string implementation, string witJson, string witBytes)
    {
        try
        {
            var parse = new CSharpParseOptions(LanguageVersion.Latest,
                preprocessorSymbols: ["TRACE", "NETWASM", "NETWASM0_1", "RELEASE"]);
            var trees = new[] { CSharpSyntaxTree.ParseText(SourceText.From(source, Encoding.UTF8), parse, "Program.cs") }
                .Concat(JsonSerializer.Deserialize<SupportSource[]>(supportJson)!
                    .Select(file => CSharpSyntaxTree.ParseText(SourceText.From(file.text, Encoding.UTF8), parse, file.path)));
            var compilation = CSharpCompilation.Create("NetWasmApp", trees,
                new[] { MetadataReference.CreateFromImage(Convert.FromBase64String(reference)) },
                new CSharpCompilationOptions(OutputKind.ConsoleApplication,
                    optimizationLevel: OptimizationLevel.Release,
                    nullableContextOptions: NullableContextOptions.Enable,
                    concurrentBuild: false, deterministic: true));
            using var pe = new MemoryStream();
            var emitted = compilation.Emit(pe);
            if (!emitted.Success) return JsonSerializer.Serialize(new { schemaVersion = 1, success = false, stage = "roslyn", code = "source-diagnostics", recoverable = true,
                diagnostics = emitted.Diagnostics.Take(128).Select(d => new {code=d.Id,message=Bound(d.GetMessage()),severity=d.Severity.ToString(),path=d.Location.GetLineSpan().Path,line=d.Location.GetLineSpan().StartLinePosition.Line,column=d.Location.GetLineSpan().StartLinePosition.Character}), pe=(string?)null });
            var images = new Dictionary<string,byte[]> { ["NetWasmApp.dll"] = pe.ToArray(), ["NetWasm.CoreLib.dll"] = Convert.FromBase64String(implementation) };
            images["compiler.wit.wasm"] = Convert.FromBase64String(witBytes);
            using var metadata = new PEReader(new MemoryStream(pe.ToArray()));
            var token = metadata.PEHeaders.CorHeader!.EntryPointTokenOrRelativeVirtualAddress;
            var options = new CompilerOptions(
                "NetWasmApp.dll", ["NetWasm.CoreLib.dll"], "Program", "<Main>$", [],
                WitPath: "compiler.wit.wasm", WitWorld: "netwasm:platform@1.0.0/platform",
                EntryMethodToken: token, EntryPointKind: CompilerEntryPointKind.ManagedExecutable);
            var compiled = BrowserCompiler.Compile(new BrowserCompilationRequest(options, images,
                new Dictionary<string,string> { ["compiler.wit.wasm"] = witJson }));
            return JsonSerializer.Serialize(new {
                schemaVersion = 1, success = emitted.Success,
                application = Convert.ToBase64String(compiled.ApplicationModule),
                staticDataEnd = compiled.StaticDataEnd,
                runtimeFeatures = compiled.RuntimeFeatures,
                imports = compiled.FunctionImports,
                interopManifest = compiled.InteropManifest,
                entryPoint = compiled.EntryPoint,
                diagnostics = emitted.Diagnostics.Take(128).Select(d => new { code = d.Id, message = Bound(d.GetMessage()),
                    severity = d.Severity.ToString(), path = d.Location.GetLineSpan().Path,
                    line = d.Location.GetLineSpan().StartLinePosition.Line,
                    column = d.Location.GetLineSpan().StartLinePosition.Character }),
                pe = emitted.Success ? Convert.ToBase64String(pe.ToArray()) : null
            });
        }
        catch (CompilerException error)
        {
            return JsonSerializer.Serialize(new { schemaVersion = 1, success = false, stage = "netwasm",
                code = error.Diagnostic.Id, recoverable = true,
                diagnostics = new[] { new { code = error.Diagnostic.Id, message = Bound(error.Diagnostic.Message),
                    severity = "Error", method = error.Diagnostic.Method, ilOffset = error.Diagnostic.IlOffset } } });
        }
        catch (Exception error)
        {
            return JsonSerializer.Serialize(new { schemaVersion = 1, success = false, stage = "compiler-host", code = "host-error", recoverable = true, error = Bound(error.ToString()) });
        }
    }
}
