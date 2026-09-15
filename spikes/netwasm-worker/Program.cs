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
using Microsoft.CodeAnalysis.Diagnostics;
using System.Collections.Immutable;
using System.Security.Cryptography;
using TUnit.Core.SourceGenerator.Generators;
using System.Text.Json.SourceGeneration;

[assembly: SupportedOSPlatform("browser")]

namespace NetWasm.Playground.CompilerProbe;

public static partial class Program
{
    public sealed record SupportSource(string path, string text);
    private sealed record StageTiming(string stage, double milliseconds);
    private sealed record GeneratedSource(string producer, string hintName, string? text, int bytes, string sha256);
    private const int MaximumGeneratedSources = 128;
    private const int MaximumGeneratedBytes = 512 * 1024;
    private static bool progressEnabled;
    private static long guestMemoryMaximum = 2147483648;

    [JSExport]
    public static void ConfigureGuestMemoryMaximum(int bytes)
    {
        if (bytes <= 0 || bytes % 65536 != 0)
            throw new ArgumentOutOfRangeException(nameof(bytes), "Guest memory maximum must be a positive multiple of 64 KiB.");
        guestMemoryMaximum = bytes;
    }

    [JSImport("reportStage", "compiler-progress")]
    private static partial void ReportStage(string stage);

    [JSExport]
    public static void EnableProgress() => progressEnabled = true;

    private static void Stage(string stage) { if (progressEnabled) ReportStage(stage); }

    public static void Main() { }

    private static string Bound(string text) => text.Length <= 4096 ? text : text[..4096];

    [JSExport]
    public static string Compile(string source, string reference, string supportJson, string implementation, string witJson, string witBytes, string runtimeManifest)
        => CompileRecipe(source, reference, supportJson, implementation, witJson, witBytes, runtimeManifest, "{}", "{}");

    [JSExport]
    public static string CompileRecipe(string source, string reference, string supportJson, string implementation, string witJson, string witBytes, string runtimeManifest,
        string additionalReferencesJson, string additionalImplementationsJson)
        => CompileCore(source, reference, supportJson, implementation, witJson, witBytes, runtimeManifest,
            additionalReferencesJson, additionalImplementationsJson, null, false);

    [JSExport]
    public static string CompileGeneratedRecipe(string source, string reference, string supportJson, string implementation, string witJson, string witBytes, string runtimeManifest,
        string additionalReferencesJson, string additionalImplementationsJson, string trustedRecipe, bool includeGeneratedSourceText)
        => CompileCore(source, reference, supportJson, implementation, witJson, witBytes, runtimeManifest,
            additionalReferencesJson, additionalImplementationsJson, trustedRecipe, includeGeneratedSourceText);

    private static string CompileCore(string source, string reference, string supportJson, string implementation, string witJson, string witBytes, string runtimeManifest,
        string additionalReferencesJson, string additionalImplementationsJson, string? trustedRecipe, bool includeGeneratedSourceText)
    {
        var generatedSources = Array.Empty<GeneratedSource>();
        var generatorDiagnostics = ImmutableArray<Diagnostic>.Empty;
        var timings = new List<StageTiming>();
        double generatorMilliseconds = 0;
        try
        {
            if (trustedRecipe is not (null or "json" or "tunit" or "di") ||
                (trustedRecipe == "di" && !TrustedGeneratorAssets.DependencyInjectionAvailable))
                return JsonSerializer.Serialize(new { schemaVersion = 1, success = false, stage = "request", code = "unsupported-generator-recipe", recoverable = true, diagnostics = Array.Empty<object>() });
            var tunit = trustedRecipe == "tunit";
            Stage("roslyn");
            var started = Stopwatch.GetTimestamp();
            var parse = new CSharpParseOptions(LanguageVersion.Latest,
                preprocessorSymbols: ["TRACE", "NETWASM", "NETWASM0_1", "RELEASE"]);
            var trees = new[] { CSharpSyntaxTree.ParseText(SourceText.From(source, Encoding.UTF8), parse, tunit ? "Tests.cs" : "Program.cs") }
                .Concat(JsonSerializer.Deserialize<SupportSource[]>(supportJson)!
                    .Select(file => CSharpSyntaxTree.ParseText(SourceText.From(file.text, Encoding.UTF8), parse, file.path)));
            if (tunit) trees = trees.Append(CSharpSyntaxTree.ParseText(SourceText.From(TrustedGeneratorAssets.TUnitProgram, Encoding.UTF8), parse, "NetWasm.TUnit.Program.cs"));
            var compilation = CSharpCompilation.Create(tunit ? "NetWasmTUnitTests" : "NetWasmApp", trees,
                new[] { reference }.Concat(JsonSerializer.Deserialize<Dictionary<string, string>>(additionalReferencesJson)!.Values)
                    .Select(bytes => MetadataReference.CreateFromImage(Convert.FromBase64String(bytes))),
                new CSharpCompilationOptions(OutputKind.ConsoleApplication,
                    optimizationLevel: OptimizationLevel.Release,
                    nullableContextOptions: NullableContextOptions.Enable,
                    concurrentBuild: false, deterministic: true,
                    mainTypeName: tunit ? "NetWasm.TUnit.Generated.NetWasmTestProgram" : null));
            Compilation generatedCompilation = compilation;
            if (trustedRecipe is not null)
            {
                Stage("generator");
                var generatorStarted = Stopwatch.GetTimestamp();
                IIncrementalGenerator[] generators = trustedRecipe switch
                {
                    "tunit" => [new TestMetadataGenerator(), new HookMetadataGenerator(), new AotConverterGenerator(), new PropertyInjectionSourceGenerator()],
                    "di" => [TrustedGeneratorAssets.CreateDependencyInjectionGenerator()],
                    _ => [new JsonSourceGenerator()],
                };
                GeneratorDriver driver = CSharpGeneratorDriver.Create(generators.Select(generator => generator.AsSourceGenerator()),
                    parseOptions: parse, optionsProvider: new TrustedOptionsProvider(tunit));
                driver = driver.RunGeneratorsAndUpdateCompilation(compilation, out generatedCompilation, out generatorDiagnostics);
                var run = driver.GetRunResult();
                var count = run.Results.Sum(result => result.GeneratedSources.Length);
                var totalBytes = run.Results.Sum(result => result.GeneratedSources.Sum(item => Encoding.UTF8.GetByteCount(item.SourceText.ToString())));
                generatorMilliseconds = Stopwatch.GetElapsedTime(generatorStarted).TotalMilliseconds;
                timings.Add(new("generator", generatorMilliseconds));
                if (count > MaximumGeneratedSources || totalBytes > MaximumGeneratedBytes)
                    return JsonSerializer.Serialize(new { schemaVersion = 1, success = false, stage = "generator", code = "generated-output-limit", recoverable = true, diagnostics = Array.Empty<object>(), timings });
                generatedSources = run.Results.SelectMany((result, index) => result.GeneratedSources.Select(item =>
                {
                    var text = item.SourceText.ToString();
                    var bytes = Encoding.UTF8.GetBytes(text);
                    return new GeneratedSource(generators[index].GetType().FullName!, item.HintName,
                        includeGeneratedSourceText ? text : null, bytes.Length, Convert.ToHexStringLower(SHA256.HashData(bytes)));
                })).OrderBy(item => item.producer, StringComparer.Ordinal).ThenBy(item => item.hintName, StringComparer.Ordinal).ToArray();
                if (generatorDiagnostics.Any(d => d.Severity == DiagnosticSeverity.Error) || run.Results.Any(result => result.Exception is not null))
                    return JsonSerializer.Serialize(new { schemaVersion = 1, success = false, stage = "generator", code = "generator-diagnostics", recoverable = true,
                        diagnostics = generatorDiagnostics.Take(128).Select(Describe), generatedSources, timings,
                        generatorFailures = run.Results.Select((result, index) => new { producer = generators[index].GetType().FullName, errorType = result.Exception?.GetType().Name, message = result.Exception is null ? null : Bound(result.Exception.Message) }).Where(item => item.errorType is not null) });
                Stage("roslyn");
            }
            using var pe = new MemoryStream();
            var emitted = generatedCompilation.Emit(pe);
            timings.Add(new("roslyn", Math.Max(0, Stopwatch.GetElapsedTime(started).TotalMilliseconds - generatorMilliseconds)));
            if (!emitted.Success) return JsonSerializer.Serialize(new { schemaVersion = 1, success = false, stage = "roslyn", code = "source-diagnostics", recoverable = true,
                diagnostics = emitted.Diagnostics.Take(128).Select(Describe), generatedSources, generatorDiagnostics = generatorDiagnostics.Take(128).Select(Describe), pe=(string?)null, timings });
            Stage("netwasm");
            started = Stopwatch.GetTimestamp();
            var images = new Dictionary<string,byte[]> { ["NetWasmApp.dll"] = pe.ToArray(), ["NetWasm.CoreLib.dll"] = Convert.FromBase64String(implementation) };
            var additionalImplementations = JsonSerializer.Deserialize<Dictionary<string, string>>(additionalImplementationsJson)!;
            foreach (var image in additionalImplementations) images.Add(image.Key, Convert.FromBase64String(image.Value));
            images["compiler.wit.wasm"] = Convert.FromBase64String(witBytes);
            var options = new CompilerOptions(
                "NetWasmApp.dll", ["NetWasm.CoreLib.dll", .. additionalImplementations.Keys], "Program", "<Main>$", [],
                WitPath: "compiler.wit.wasm", WitWorld: tunit ? "netwasm:platform@1.0.0/async-platform" : "netwasm:platform@1.0.0/platform",
                EntryPointKind: CompilerEntryPointKind.ManagedExecutable);
            var compiled = BrowserCompiler.Compile(new BrowserCompilationRequest(options, images,
                new Dictionary<string,string> { ["compiler.wit.wasm"] = witJson }, selectManagedExecutableEntryPoint: true));
            timings.Add(new("netwasm", Stopwatch.GetElapsedTime(started).TotalMilliseconds));
            var runtimeLinkPlan = RuntimeLinkPlanner.Plan(new(runtimeManifest, "wasm32", compiled.StaticDataEnd,
                AssetRoot: "/netwasm-link/runtime", OutputPath: "/netwasm-link/runtime.wasm",
                MaximumMemorySizeBytes: guestMemoryMaximum));
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
                trustedRecipe,
                generatedSources,
                catalogCaseCount = tunit ? CountCatalogCases(generatedCompilation) : 0,
                generatorDiagnostics = generatorDiagnostics.Take(128).Select(Describe),
                diagnostics = emitted.Diagnostics.Take(128).Select(Describe),
                pe = emitted.Success ? Convert.ToBase64String(pe.ToArray()) : null
            });
        }
        catch (CompilerException error)
        {
            return JsonSerializer.Serialize(new { schemaVersion = 1, success = false, stage = "netwasm",
                code = error.Diagnostic.Id, recoverable = true,
                diagnostics = new[] { new { code = error.Diagnostic.Id, message = Bound(error.Diagnostic.Message),
                    severity = "Error", method = error.Diagnostic.Method, ilOffset = error.Diagnostic.IlOffset } }, generatedSources, generatorDiagnostics = generatorDiagnostics.Take(128).Select(Describe), timings });
        }
        catch (Exception error)
        {
            return JsonSerializer.Serialize(new { schemaVersion = 1, success = false, stage = "compiler-host", code = "host-error", recoverable = true, error = Bound(error.ToString()) });
        }
    }

    private static int CountCatalogCases(Compilation compilation) => compilation.SyntaxTrees.Sum(tree =>
        tree.FilePath.EndsWith("__TestSource.g.cs", StringComparison.Ordinal)
            ? tree.ToString().Split("cases.Add(new global::TUnit.Core.GeneratedTestCase<", StringSplitOptions.None).Length - 1 : 0);

    private static object Describe(Diagnostic diagnostic)
    {
        var location = diagnostic.Location.GetLineSpan();
        return new { code = diagnostic.Id, message = Bound(diagnostic.GetMessage()), severity = diagnostic.Severity.ToString(),
            path = location.Path, line = location.StartLinePosition.Line, column = location.StartLinePosition.Character };
    }

    private sealed class TrustedOptionsProvider(bool tunit) : AnalyzerConfigOptionsProvider
    {
        private readonly AnalyzerConfigOptions options = new TrustedOptions(tunit);
        public override AnalyzerConfigOptions GlobalOptions => options;
        public override AnalyzerConfigOptions GetOptions(SyntaxTree tree) => options;
        public override AnalyzerConfigOptions GetOptions(AdditionalText textFile) => options;
    }

    private sealed class TrustedOptions(bool tunit) : AnalyzerConfigOptions
    {
        public override bool TryGetValue(string key, out string value)
        {
            value = key switch
            {
                "build_property.EnableTUnitSourceGeneration" when tunit => "true",
                "build_property.TUnitSourceGenerationMode" when tunit => "ClosedWorldCatalog",
                _ => string.Empty,
            };
            return value.Length != 0;
        }
    }

    [JSExport]
    public static string RetainComponentExports(string module, string prefix) =>
        Convert.ToBase64String(BrowserComponentCoreModules.RetainComponentExports(Convert.FromBase64String(module), prefix));
}
