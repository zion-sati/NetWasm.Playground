using System;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Runtime.InteropServices.JavaScript;
using System.Runtime.Versioning;
using System.Text;
using System.Diagnostics;
using Microsoft.CodeAnalysis.Text;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using NetWasm.Compiler;
using NetWasm.Compiler.Browser;
using NetWasm.Compiler.Core;
using System.Collections.Generic;
using NetWasm.Runtime.Pack.Planning;
using NetWasm.Compiler.ComponentModel;
using NetWasm.Compiler.ComponentModel.Browser;

[assembly: SupportedOSPlatform("browser")]

namespace NetWasm.Playground.CompilerProbe;

public static partial class Program
{
    public sealed record SupportSource(string path, string text);
    private sealed record StageTiming(string stage, double milliseconds);
    private static bool progressEnabled;

    [JSImport("reportStage", "compiler-progress")]
    private static partial void ReportStage(string stage);

    [JSExport]
    public static void EnableProgress() => progressEnabled = true;

    private static void Stage(string stage) { if (progressEnabled) ReportStage(stage); }

    public static void Main() { }

    private static string Bound(string text) => text.Length <= 4096 ? text : text[..4096];

    [JSExport]
    public static string Compile(string source, string reference, string supportJson, string implementation, string witJson, string witBytes, string runtimeManifest)
    {
        try
        {
            var timings = new List<StageTiming>();
            Stage("roslyn");
            var started = Stopwatch.GetTimestamp();
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
            timings.Add(new("roslyn", Stopwatch.GetElapsedTime(started).TotalMilliseconds));
            if (!emitted.Success) return JsonSerializer.Serialize(new { schemaVersion = 1, success = false, stage = "roslyn", code = "source-diagnostics", recoverable = true,
                diagnostics = emitted.Diagnostics.Take(128).Select(d => new {code=d.Id,message=Bound(d.GetMessage()),severity=d.Severity.ToString(),path=d.Location.GetLineSpan().Path,line=d.Location.GetLineSpan().StartLinePosition.Line,column=d.Location.GetLineSpan().StartLinePosition.Character}), pe=(string?)null, timings });
            Stage("netwasm");
            started = Stopwatch.GetTimestamp();
            var images = new Dictionary<string,byte[]> { ["NetWasmApp.dll"] = pe.ToArray(), ["NetWasm.CoreLib.dll"] = Convert.FromBase64String(implementation) };
            images["compiler.wit.wasm"] = Convert.FromBase64String(witBytes);
            var options = new CompilerOptions(
                "NetWasmApp.dll", ["NetWasm.CoreLib.dll"], "Program", "<Main>$", [],
                WitPath: "compiler.wit.wasm", WitWorld: "netwasm:platform@1.0.0/platform",
                EntryPointKind: CompilerEntryPointKind.ManagedExecutable);
            var compiled = BrowserCompiler.Compile(new BrowserCompilationRequest(options, images,
                new Dictionary<string,string> { ["compiler.wit.wasm"] = witJson }, selectManagedExecutableEntryPoint: true));
            timings.Add(new("netwasm", Stopwatch.GetElapsedTime(started).TotalMilliseconds));
            var runtimeLinkPlan = RuntimeLinkPlanner.Plan(new(runtimeManifest, "wasm32", compiled.StaticDataEnd,
                AssetRoot: "/netwasm-link/runtime", OutputPath: "/netwasm-link/runtime.wasm"));
            var coreLinkPlan = BrowserComponentCoreModules.CreateLinkPlan(
                new("/netwasm-link/application.wasm", "/netwasm-link/runtime.wasm", "/netwasm-link/linked.wasm",
                    ComponentTarget.Wasm32Wasi02, compiled.EntryPoint.Abi),
                new("/netwasm-link/environment.wasm", "/netwasm-link/host.wasm", "/netwasm-link/command.wasm",
                    "/netwasm-link/merged.wasm", "/netwasm-link/sanitized.wasm"));
            return JsonSerializer.Serialize(new {
                schemaVersion = 1, success = emitted.Success,
                application = Convert.ToBase64String(compiled.ApplicationModule),
                staticDataEnd = compiled.StaticDataEnd,
                runtimeFeatures = compiled.RuntimeFeatures,
                imports = compiled.FunctionImports,
                interopManifest = compiled.InteropManifest,
                entryPoint = compiled.EntryPoint,
                runtimeLinkPlan,
                coreLinkPlan,
                timings,
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

    [JSExport]
    public static string RetainComponentExports(string module, string prefix) =>
        Convert.ToBase64String(BrowserComponentCoreModules.RetainComponentExports(Convert.FromBase64String(module), prefix));
}
