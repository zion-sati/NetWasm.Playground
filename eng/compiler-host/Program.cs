extern alias jsonsourcegen;

using System;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Text.Json.Serialization;
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
using NetWasm.Compiler.Wasm;
using System.Collections.Generic;
using NetWasm.Runtime.Pack.Planning;
using NetWasm.Compiler.ComponentModel;
using NetWasm.Compiler.ComponentModel.Browser;
using Microsoft.CodeAnalysis.Diagnostics;
using System.Collections.Immutable;
using System.Security.Cryptography;
using System.Threading;
using TUnit.Core.SourceGenerator.Generators;
using Microsoft.Extensions.Logging.Generators;
using JsonSourceGenerator = jsonsourcegen::System.Text.Json.SourceGeneration.JsonSourceGenerator;

[assembly: SupportedOSPlatform("browser")]

namespace NetWasm.Playground.CompilerProbe;

public static partial class Program
{
    public sealed record SupportSource(string path, string text);
    private sealed record StageTiming(string stage, double milliseconds);
    private sealed record GeneratedSource(string producer, string hintName, string? text, int bytes, string sha256);
    private sealed record DiagnosticInfo(string code, string message, string severity, string? path = null,
        int? line = null, int? column = null, string? method = null, int? ilOffset = null);
    private sealed record GeneratorFailure(string? producer, string? errorType, string? message);
    private sealed record FunctionTypeInfo(int[] Parameters, int Result);
    private sealed record FunctionImportInfo(string Module, string Name, FunctionTypeInfo Type);
    private sealed record StatusAbiInfo(int SuccessStatus, int HostFailureStatus, int ScalarResultOffset);
    private sealed record TargetLayoutInfo(int ManagedReferenceSize, int StringLengthOffset, int StringDataOffset,
        int ArrayLengthOffset, int ArrayDataPointerOffset);
    private sealed record InteropImportInfo(string Module, string Name, string[] Parameters, string Result,
        string? AsyncReturn, string? ResolveExport, string? RejectExport, string? CancelExport);
    private sealed record InteropExportInfo(string Name, string[] Parameters, string Result,
        string? AsyncReturn, string? StatusExport, string? ResultExport, string? CompleteExport);
    private sealed record InteropCallbackInfo(string Module, string ImportName, int ParameterIndex, string ExportName,
        string[] Parameters, string Result);
    private sealed record WitImportInfo(string Interface, string Function);
    private sealed record InteropManifestInfo(int Version, string Target, StatusAbiInfo StatusAbi,
        TargetLayoutInfo TargetLayout, InteropImportInfo[] Imports, InteropExportInfo[] Exports,
        InteropCallbackInfo[] Callbacks, WitImportInfo[] WitImports);
    private sealed record EntryPointAbiInfo(int ParameterShape, int ReturnShape, int CompletionShape);
    private sealed record EntryPointInfo(string AssemblyPath, string TypeName, string MethodName, int? Token,
        int Kind, EntryPointAbiInfo? Abi);
    private sealed record RuntimeLinkAssetInfo(string Path, string Sha256);
    private sealed record RuntimeSystemLibrary(string Path, string Sha256);
    private sealed record RuntimeLinkPlanInfo(string[] Arguments, RuntimeLinkAssetInfo[] Inputs, string RuntimeAbi,
        string ToolchainFingerprint, long RuntimeGlobalBase, long HeapBase, long InitialMemorySizeBytes,
        long MaximumMemorySizeBytes);
    private sealed record TextModuleInfo(string OutputPath, string Text);
    private sealed record ToolInvocationInfo(string ToolId, string[] Arguments);
    private sealed record ExportPruningInfo(string InputPath, string OutputPath, string Prefix);
    private sealed record CoreLinkPlanInfo(TextModuleInfo[] TextModules, ToolInvocationInfo Merge,
        ExportPruningInfo ExportPruning, ToolInvocationInfo? Optimization, string[] CleanupPaths);
#if FRONTEND_CACHE_TRANSPORT
    private sealed record FrontendCacheInfo(string schema, string @namespace, string handle);
    private sealed record FrontendPublicationInfo(string token, int entryCount, long totalBytes);
    private sealed record FrontendBatchEntryInfo(string key, string checksum, int bytes);
    private sealed record FrontendBatchInfo(string token, bool isFinal, FrontendBatchEntryInfo[] entries);
    private sealed record FrontendCacheMetricsInfo(long lookups, long hits, long misses,
        long memoryHits, long diskHits, long stagedArtifacts, long stagedBytes);
#endif
    private sealed record CompilerHostResponse(
        int schemaVersion,
        bool success,
        string? stage = null,
        string? code = null,
        bool? recoverable = null,
        DiagnosticInfo[]? diagnostics = null,
        StageTiming[]? timings = null,
        GeneratedSource[]? generatedSources = null,
        DiagnosticInfo[]? generatorDiagnostics = null,
        GeneratorFailure[]? generatorFailures = null,
        string? error = null,
        string? application = null,
        int? staticDataEnd = null,
        string[]? runtimeFeatures = null,
        FunctionImportInfo[]? imports = null,
        InteropManifestInfo? interopManifest = null,
        EntryPointInfo? entryPoint = null,
        RuntimeLinkPlanInfo? runtimeLinkPlan = null,
        CoreLinkPlanInfo? coreLinkPlan = null,
        string? trustedRecipe = null,
        int? catalogCaseCount = null,
        string? componentContract = null,
        string? pe = null
#if FRONTEND_CACHE_TRANSPORT
        , FrontendCacheInfo? frontendCache = null,
        FrontendPublicationInfo? frontendPublication = null,
        FrontendCacheMetricsInfo? frontendCacheMetrics = null
#endif
        );

    [JsonSourceGenerationOptions(DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull)]
    [JsonSerializable(typeof(SupportSource[]))]
    [JsonSerializable(typeof(RuntimeSystemLibrary[]))]
    [JsonSerializable(typeof(Dictionary<string, string>))]
    [JsonSerializable(typeof(CompilerHostResponse))]
#if FRONTEND_CACHE_TRANSPORT
    [JsonSerializable(typeof(FrontendBatchInfo))]
#endif
    private sealed partial class CompilerHostJsonContext : JsonSerializerContext;
    private const int MaximumGeneratedSources = 128;
    private const int MaximumGeneratedBytes = 512 * 1024;
    private static bool progressEnabled;
    private static long guestMemoryMaximum = 2147483648;
#if FRONTEND_CACHE_TRANSPORT
    private sealed record PendingFrontendCompilation(
        BrowserCompilerSession Session,
        BrowserCompilationPreparation Preparation,
        List<FrontendArtifactCacheEntry> Entries,
        byte[] Pe,
        StageTiming[] Timings,
        GeneratedSource[] GeneratedSources,
        DiagnosticInfo[] GeneratorDiagnostics,
        string? TrustedRecipe,
        int CatalogCaseCount,
        string ComponentContract,
        string RuntimeManifest,
        string RuntimeSystemLibrariesJson);
    private static PendingFrontendCompilation? pendingFrontendCompilation;
    private static FrontendArtifactCachePublication? pendingFrontendPublication;
    private static FrontendArtifactCacheBatch? pendingFrontendBatch;
    private static BrowserCompilerSession? frontendPublicationSession;
#endif

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

    private static string Serialize(CompilerHostResponse response) =>
        JsonSerializer.Serialize(response, CompilerHostJsonContext.Default.CompilerHostResponse);

    private static FunctionImportInfo Describe(WasmFunctionImport import) => new(import.Module, import.Name,
        new(import.Type.Parameters.Select(value => (int)value).ToArray(), (int)import.Type.Result));

    private static InteropManifestInfo Describe(HostInteropManifest manifest) => new(manifest.Version, manifest.Target,
        new(manifest.StatusAbi.SuccessStatus, manifest.StatusAbi.HostFailureStatus, manifest.StatusAbi.ScalarResultOffset),
        new(manifest.TargetLayout.ManagedReferenceSize, manifest.TargetLayout.StringLengthOffset,
            manifest.TargetLayout.StringDataOffset, manifest.TargetLayout.ArrayLengthOffset,
            manifest.TargetLayout.ArrayDataPointerOffset),
        manifest.Imports.Select(value => new InteropImportInfo(value.Module, value.Name, value.Parameters.ToArray(), value.Result,
            value.AsyncReturn, value.ResolveExport, value.RejectExport, value.CancelExport)).ToArray(),
        manifest.Exports.Select(value => new InteropExportInfo(value.Name, value.Parameters.ToArray(), value.Result,
            value.AsyncReturn, value.StatusExport, value.ResultExport, value.CompleteExport)).ToArray(),
        manifest.Callbacks.Select(value => new InteropCallbackInfo(value.Module, value.ImportName, value.ParameterIndex,
            value.ExportName, value.Parameters.ToArray(), value.Result)).ToArray(),
        manifest.WitImports.Select(value => new WitImportInfo(value.Interface, value.Function)).ToArray());

    private static EntryPointInfo Describe(BrowserCompilationEntryPoint entryPoint) => new(entryPoint.AssemblyPath,
        entryPoint.TypeName, entryPoint.MethodName, entryPoint.Token, (int)entryPoint.Kind,
        entryPoint.Abi is null ? null : new((int)entryPoint.Abi.ParameterShape, (int)entryPoint.Abi.ReturnShape,
            (int)entryPoint.Abi.CompletionShape));

    private static RuntimeLinkPlanInfo Describe(RuntimeLinkPlan plan) => new(plan.Arguments.ToArray(),
        plan.Inputs.Select(value => new RuntimeLinkAssetInfo(value.Path, value.Sha256)).ToArray(), plan.RuntimeAbi,
        plan.ToolchainFingerprint, plan.RuntimeGlobalBase, plan.HeapBase, plan.InitialMemorySizeBytes,
        plan.MaximumMemorySizeBytes);

    private static CoreLinkPlanInfo Describe(BrowserComponentCoreModuleLinkPlan plan) => new(
        plan.TextModules.Select(value => new TextModuleInfo(value.OutputPath, value.Text)).ToArray(),
        new(plan.Merge.ToolId, plan.Merge.Arguments.ToArray()),
        new(plan.ExportPruning.InputPath, plan.ExportPruning.OutputPath, plan.ExportPruning.Prefix),
        plan.Optimization is null ? null : new(plan.Optimization.ToolId, plan.Optimization.Arguments.ToArray()),
        plan.CleanupPaths.ToArray());

    [JSExport]
    public static string Compile(string source, string reference, string supportJson, string implementation, string witJson, string witBytes, string runtimeManifest,
        string runtimeSystemLibrariesJson, string languageVersion, bool updatedMemorySafetyRules)
        => CompileRecipe(source, reference, supportJson, implementation, witJson, witBytes, runtimeManifest,
            runtimeSystemLibrariesJson, "{}", "{}", languageVersion, updatedMemorySafetyRules);

    [JSExport]
    public static string CompileRecipe(string source, string reference, string supportJson, string implementation, string witJson, string witBytes, string runtimeManifest,
        string runtimeSystemLibrariesJson, string additionalReferencesJson, string additionalImplementationsJson,
        string languageVersion, bool updatedMemorySafetyRules)
        => CompileCore(source, reference, supportJson, implementation, witJson, witBytes, runtimeManifest,
            runtimeSystemLibrariesJson, additionalReferencesJson, additionalImplementationsJson, null, false,
            languageVersion, updatedMemorySafetyRules);

    [JSExport]
    public static string CompileHttpRecipe(string source, string reference, string supportJson, string implementation, string witJson, string witBytes, string runtimeManifest,
        string runtimeSystemLibrariesJson, string additionalReferencesJson, string additionalImplementationsJson,
        string languageVersion, bool updatedMemorySafetyRules)
        => CompileCore(source, reference, supportJson, implementation, witJson, witBytes, runtimeManifest,
            runtimeSystemLibrariesJson, additionalReferencesJson, additionalImplementationsJson, null, false,
            languageVersion, updatedMemorySafetyRules, useAsyncPlatform: true);

    [JSExport]
    public static string CompileGeneratedRecipe(string source, string reference, string supportJson, string implementation, string witJson, string witBytes, string runtimeManifest,
        string runtimeSystemLibrariesJson, string additionalReferencesJson, string additionalImplementationsJson, string trustedRecipe, bool includeGeneratedSourceText,
        string languageVersion, bool updatedMemorySafetyRules)
        => CompileCore(source, reference, supportJson, implementation, witJson, witBytes, runtimeManifest,
            runtimeSystemLibrariesJson, additionalReferencesJson, additionalImplementationsJson, trustedRecipe, includeGeneratedSourceText,
            languageVersion, updatedMemorySafetyRules);

#if FRONTEND_CACHE_TRANSPORT
    [JSExport]
    public static string PrepareRecipe(string source, string reference, string supportJson, string implementation, string witJson, string witBytes, string runtimeManifest,
        string runtimeSystemLibrariesJson, string additionalReferencesJson, string additionalImplementationsJson,
        string languageVersion, bool updatedMemorySafetyRules)
        => CompileCore(source, reference, supportJson, implementation, witJson, witBytes, runtimeManifest,
            runtimeSystemLibrariesJson, additionalReferencesJson, additionalImplementationsJson, null, false,
            languageVersion, updatedMemorySafetyRules, prepareFrontendCache: true);

    [JSExport]
    public static string PrepareHttpRecipe(string source, string reference, string supportJson, string implementation, string witJson, string witBytes, string runtimeManifest,
        string runtimeSystemLibrariesJson, string additionalReferencesJson, string additionalImplementationsJson,
        string languageVersion, bool updatedMemorySafetyRules)
        => CompileCore(source, reference, supportJson, implementation, witJson, witBytes, runtimeManifest,
            runtimeSystemLibrariesJson, additionalReferencesJson, additionalImplementationsJson, null, false,
            languageVersion, updatedMemorySafetyRules, useAsyncPlatform: true, prepareFrontendCache: true);

    [JSExport]
    public static string PrepareGeneratedRecipe(string source, string reference, string supportJson, string implementation, string witJson, string witBytes, string runtimeManifest,
        string runtimeSystemLibrariesJson, string additionalReferencesJson, string additionalImplementationsJson, string trustedRecipe,
        string languageVersion, bool updatedMemorySafetyRules)
        => CompileCore(source, reference, supportJson, implementation, witJson, witBytes, runtimeManifest,
            runtimeSystemLibrariesJson, additionalReferencesJson, additionalImplementationsJson, trustedRecipe, false,
            languageVersion, updatedMemorySafetyRules, prepareFrontendCache: true);
#endif

    private static string CompileCore(string source, string reference, string supportJson, string implementation, string witJson, string witBytes, string runtimeManifest,
        string runtimeSystemLibrariesJson, string additionalReferencesJson, string additionalImplementationsJson, string? trustedRecipe, bool includeGeneratedSourceText,
        string languageVersion, bool updatedMemorySafetyRules,
        bool useAsyncPlatform = false
#if FRONTEND_CACHE_TRANSPORT
        , bool prepareFrontendCache = false
#endif
        )
    {
        var generatedSources = Array.Empty<GeneratedSource>();
        var generatorDiagnostics = ImmutableArray<Diagnostic>.Empty;
        var timings = new List<StageTiming>();
        double generatorMilliseconds = 0;
        try
        {
            if (trustedRecipe is not (null or "json" or "tunit" or "di" or "logging") ||
                (trustedRecipe == "di" && !TrustedGeneratorAssets.DependencyInjectionAvailable))
                return Serialize(new(1, false, "request", "unsupported-generator-recipe", true, []));
            if (languageVersion is not ("15" or "preview") ||
                (updatedMemorySafetyRules && languageVersion != "preview"))
                return Serialize(new(1, false, "request", "unsupported-language-settings", true, []));
            var tunit = trustedRecipe == "tunit";
            Stage("roslyn");
            var started = Stopwatch.GetTimestamp();
            var parse = new CSharpParseOptions(languageVersion == "15" ? LanguageVersion.CSharp15 : LanguageVersion.Preview,
                preprocessorSymbols: ["TRACE", "NETWASM", "NETWASM0_1", "RELEASE"]);
            if (updatedMemorySafetyRules)
                parse = parse.WithFeatures([new("updated-memory-safety-rules", "true")]);
            var trees = new[] { CSharpSyntaxTree.ParseText(SourceText.From(source, Encoding.UTF8), parse, tunit ? "Tests.cs" : "Program.cs") }
                .Concat(JsonSerializer.Deserialize(supportJson, CompilerHostJsonContext.Default.SupportSourceArray)!
                    .Select(file => CSharpSyntaxTree.ParseText(SourceText.From(file.text, Encoding.UTF8), parse, file.path)));
            if (tunit) trees = trees.Append(CSharpSyntaxTree.ParseText(SourceText.From(TrustedGeneratorAssets.TUnitProgram, Encoding.UTF8), parse, "NetWasm.TUnit.Program.cs"));
            var compilation = CSharpCompilation.Create(tunit ? "NetWasmTUnitTests" : "NetWasmApp", trees,
                new[] { reference }.Concat(JsonSerializer.Deserialize(additionalReferencesJson, CompilerHostJsonContext.Default.DictionaryStringString)!.Values)
                    .Select(bytes => MetadataReference.CreateFromImage(Convert.FromBase64String(bytes))),
                new CSharpCompilationOptions(OutputKind.ConsoleApplication,
                    optimizationLevel: OptimizationLevel.Release,
                    nullableContextOptions: NullableContextOptions.Enable,
                    allowUnsafe: true,
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
                    "logging" => [TrustedGeneratorAssets.CreateLoggingGenerator()],
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
                    return Serialize(new(1, false, "generator", "generated-output-limit", true, [], timings.ToArray()));
                generatedSources = run.Results.SelectMany((result, index) => result.GeneratedSources.Select(item =>
                {
                    var text = item.SourceText.ToString();
                    var bytes = Encoding.UTF8.GetBytes(text);
                    return new GeneratedSource(generators[index].GetType().FullName!, item.HintName,
                        includeGeneratedSourceText ? text : null, bytes.Length, Convert.ToHexStringLower(SHA256.HashData(bytes)));
                })).OrderBy(item => item.producer, StringComparer.Ordinal).ThenBy(item => item.hintName, StringComparer.Ordinal).ToArray();
                if (generatorDiagnostics.Any(d => d.Severity == DiagnosticSeverity.Error) || run.Results.Any(result => result.Exception is not null))
                    return Serialize(new(1, false, "generator", "generator-diagnostics", true,
                        generatorDiagnostics.Take(128).Select(Describe).ToArray(), timings.ToArray(), generatedSources,
                        generatorFailures: run.Results.Select((result, index) => new GeneratorFailure(generators[index].GetType().FullName,
                            result.Exception?.GetType().Name, result.Exception is null ? null : Bound(result.Exception.Message)))
                            .Where(item => item.errorType is not null).ToArray()));
                Stage("roslyn");
            }
            using var pe = new MemoryStream();
            var emitted = generatedCompilation.Emit(pe);
            timings.Add(new("roslyn", Math.Max(0, Stopwatch.GetElapsedTime(started).TotalMilliseconds - generatorMilliseconds)));
            if (!emitted.Success) return Serialize(new(1, false, "roslyn", "source-diagnostics", true,
                emitted.Diagnostics.Take(128).Select(Describe).ToArray(), timings.ToArray(), generatedSources,
                generatorDiagnostics.Take(128).Select(Describe).ToArray()));
            Stage("netwasm");
            started = Stopwatch.GetTimestamp();
            var entryPoint = generatedCompilation.GetEntryPoint(CancellationToken.None);
            var inferredAsyncPlatform = entryPoint?.ReturnType is INamedTypeSymbol returnType &&
                returnType.Name == "Task" && returnType.ContainingNamespace.ToDisplayString() == "System.Threading.Tasks";
            var asynchronous = tunit || useAsyncPlatform || inferredAsyncPlatform;
            var componentContract = asynchronous ? "async-command" : "command";
            var images = new Dictionary<string,byte[]> { ["NetWasmApp.dll"] = pe.ToArray(), ["NetWasm.CoreLib.dll"] = Convert.FromBase64String(implementation) };
            var additionalImplementations = JsonSerializer.Deserialize(additionalImplementationsJson, CompilerHostJsonContext.Default.DictionaryStringString)!;
            foreach (var image in additionalImplementations) images.Add(image.Key, Convert.FromBase64String(image.Value));
            images["compiler.wit.wasm"] = Convert.FromBase64String(witBytes);
            var options = new CompilerOptions(
                "NetWasmApp.dll", ["NetWasm.CoreLib.dll", .. additionalImplementations.Keys], "Program", "<Main>$", [],
                WitPath: "compiler.wit.wasm", WitWorld: asynchronous ? "netwasm:platform@1.0.0/async-platform" : "netwasm:platform@1.0.0/platform",
                EntryPointKind: CompilerEntryPointKind.ManagedExecutable);
            var request = new BrowserCompilationRequest(options, images,
                new Dictionary<string,string> { ["compiler.wit.wasm"] = witJson }, selectManagedExecutableEntryPoint: true);
#if FRONTEND_CACHE_TRANSPORT
            if (prepareFrontendCache)
            {
                request = request with { CollectCompilerMetrics = true };
                if (pendingFrontendCompilation is not null || pendingFrontendPublication is not null)
                    throw new InvalidOperationException("A frontend cache compilation is already active.");
                var session = new BrowserCompilerSession();
                try
                {
                    var preparation = session.Prepare(request);
                    if (preparation.FrontendCache is null)
                        throw new InvalidOperationException("Frontend cache preparation is unavailable.");
                    pendingFrontendCompilation = new(session, preparation, [], pe.ToArray(), timings.ToArray(),
                        generatedSources, generatorDiagnostics.Take(128).Select(Describe).ToArray(), trustedRecipe,
                        tunit ? CountCatalogCases(generatedCompilation) : 0, componentContract, runtimeManifest,
                        runtimeSystemLibrariesJson);
                    return Serialize(new(1, true, timings: timings.ToArray(), generatedSources: generatedSources,
                        generatorDiagnostics: generatorDiagnostics.Take(128).Select(Describe).ToArray(),
                        trustedRecipe: trustedRecipe, catalogCaseCount: tunit ? CountCatalogCases(generatedCompilation) : 0,
                        componentContract: componentContract,
                        frontendCache: new(preparation.FrontendCache.Schema,
                            preparation.FrontendCache.Namespace, preparation.Handle)));
                }
                catch
                {
                    session.Dispose();
                    throw;
                }
            }
#endif
            var compiled = BrowserCompiler.Compile(request);
            timings.Add(new("netwasm", Stopwatch.GetElapsedTime(started).TotalMilliseconds));
            var systemLibraries = JsonSerializer.Deserialize(runtimeSystemLibrariesJson,
                CompilerHostJsonContext.Default.RuntimeSystemLibraryArray)!
                .Select(asset => new RuntimeLinkPlanAsset(asset.Path, asset.Sha256)).ToImmutableArray();
            var runtimeLinkPlan = RuntimeLinkPlanner.Plan(new(runtimeManifest, "wasm32", compiled.StaticDataEnd,
                AssetRoot: "/netwasm-link/runtime", OutputPath: "/netwasm-link/runtime.wasm",
                MaximumMemorySizeBytes: guestMemoryMaximum, SystemLibraries: systemLibraries));
            var coreLinkPlan = BrowserComponentCoreModules.CreateLinkPlan(
                new("/netwasm-link/application.wasm", "/netwasm-link/runtime.wasm", "/netwasm-link/linked.wasm",
                    ComponentTarget.Wasm32Wasi02, compiled.EntryPoint.Abi),
                new("/netwasm-link/environment.wasm", "/netwasm-link/host.wasm", "/netwasm-link/command.wasm",
                    "/netwasm-link/merged.wasm", "/netwasm-link/sanitized.wasm"));
            return Serialize(new(1, emitted.Success,
                diagnostics: emitted.Diagnostics.Take(128).Select(Describe).ToArray(),
                timings: timings.ToArray(), generatedSources: generatedSources,
                generatorDiagnostics: generatorDiagnostics.Take(128).Select(Describe).ToArray(),
                application: Convert.ToBase64String(compiled.ApplicationModule), staticDataEnd: compiled.StaticDataEnd,
                runtimeFeatures: compiled.RuntimeFeatures.ToArray(), imports: compiled.FunctionImports.Select(Describe).ToArray(),
                interopManifest: Describe(compiled.InteropManifest), entryPoint: Describe(compiled.EntryPoint),
                runtimeLinkPlan: Describe(runtimeLinkPlan), coreLinkPlan: Describe(coreLinkPlan), trustedRecipe: trustedRecipe,
                catalogCaseCount: tunit ? CountCatalogCases(generatedCompilation) : 0, componentContract: componentContract,
                pe: emitted.Success ? Convert.ToBase64String(pe.ToArray()) : null));
        }
        catch (CompilerException error)
        {
            return Serialize(new(1, false, "netwasm", error.Diagnostic.Id, true,
                [new(error.Diagnostic.Id, Bound(error.Diagnostic.Message), "Error", method: error.Diagnostic.Method,
                    ilOffset: error.Diagnostic.IlOffset)], timings.ToArray(), generatedSources,
                generatorDiagnostics.Take(128).Select(Describe).ToArray()));
        }
        catch (Exception error)
        {
            return Serialize(new(1, false, "compiler-host", "host-error", true, error: Bound(error.ToString())));
        }
    }

#if FRONTEND_CACHE_TRANSPORT
    [JSExport]
    public static void ImportFrontendArtifact(string handle, string key, byte[] payload, byte[] checksum)
    {
        var pending = RequirePending(handle);
        if (pending.Entries.Count >= 100_000)
            throw new InvalidOperationException("Frontend cache entry limit exceeded.");
        pending.Entries.Add(new(key, payload, checksum));
    }

    [JSExport]
    public static string CompilePreparedRecipe(string handle)
    {
        var pending = RequirePending(handle);
        pendingFrontendCompilation = null;
        try
        {
            var compileStarted = Stopwatch.GetTimestamp();
            var prepared = pending.Session.CompilePrepared(handle, pending.Entries);
            var compiled = prepared.Compilation;
            var timings = pending.Timings.Append(new StageTiming(
                "netwasm", Stopwatch.GetElapsedTime(compileStarted).TotalMilliseconds)).ToArray();
            var systemLibraries = JsonSerializer.Deserialize(pending.RuntimeSystemLibrariesJson,
                CompilerHostJsonContext.Default.RuntimeSystemLibraryArray)!
                .Select(asset => new RuntimeLinkPlanAsset(asset.Path, asset.Sha256)).ToImmutableArray();
            var runtimeLinkPlan = RuntimeLinkPlanner.Plan(new(pending.RuntimeManifest, "wasm32", compiled.StaticDataEnd,
                AssetRoot: "/netwasm-link/runtime", OutputPath: "/netwasm-link/runtime.wasm",
                MaximumMemorySizeBytes: guestMemoryMaximum, SystemLibraries: systemLibraries));
            var coreLinkPlan = BrowserComponentCoreModules.CreateLinkPlan(
                new("/netwasm-link/application.wasm", "/netwasm-link/runtime.wasm", "/netwasm-link/linked.wasm",
                    ComponentTarget.Wasm32Wasi02, compiled.EntryPoint.Abi),
                new("/netwasm-link/environment.wasm", "/netwasm-link/host.wasm", "/netwasm-link/command.wasm",
                    "/netwasm-link/merged.wasm", "/netwasm-link/sanitized.wasm"));
            pendingFrontendPublication = prepared.FrontendPublication;
            if (prepared.FrontendPublication is not null)
                frontendPublicationSession = pending.Session;
            return Serialize(new(1, true,
                diagnostics: [], timings: timings, generatedSources: pending.GeneratedSources,
                generatorDiagnostics: pending.GeneratorDiagnostics,
                application: Convert.ToBase64String(compiled.ApplicationModule), staticDataEnd: compiled.StaticDataEnd,
                runtimeFeatures: compiled.RuntimeFeatures.ToArray(), imports: compiled.FunctionImports.Select(Describe).ToArray(),
                interopManifest: Describe(compiled.InteropManifest), entryPoint: Describe(compiled.EntryPoint),
                runtimeLinkPlan: Describe(runtimeLinkPlan), coreLinkPlan: Describe(coreLinkPlan),
                trustedRecipe: pending.TrustedRecipe, catalogCaseCount: pending.CatalogCaseCount,
                componentContract: pending.ComponentContract,
                pe: Convert.ToBase64String(pending.Pe),
                frontendPublication: prepared.FrontendPublication is null ? null : new(
                    prepared.FrontendPublication.Token, prepared.FrontendPublication.EntryCount,
                    prepared.FrontendPublication.TotalBytes),
                frontendCacheMetrics: compiled.CompilerMetrics?.FrontendCache is not { } metrics ? null : new(
                    metrics.Lookups, metrics.Hits, metrics.Misses, metrics.MemoryHits, metrics.DiskHits,
                    metrics.StagedArtifacts, metrics.StagedBytes)));
        }
        catch
        {
            pending.Session.Dispose();
            throw;
        }
        finally
        {
            if (pendingFrontendPublication is null) pending.Session.Dispose();
        }
    }

    [JSExport]
    public static string ReadFrontendArtifactBatch(string publicationToken)
    {
        var publication = pendingFrontendPublication;
        var session = frontendPublicationSession;
        if (publication is null || session is null || publication.Token != publicationToken)
            throw new InvalidOperationException("The frontend cache publication is stale or invalid.");
        var batch = session.ReadFrontendArtifactBatch(publication);
        pendingFrontendBatch = batch;
        return JsonSerializer.Serialize(new FrontendBatchInfo(batch.BatchToken, batch.IsFinal,
            batch.Entries.Select(entry => new FrontendBatchEntryInfo(entry.Key,
                Convert.ToHexStringLower(entry.Checksum), entry.Payload.Length)).ToArray()),
            CompilerHostJsonContext.Default.FrontendBatchInfo);
    }

    [JSExport]
    public static byte[] ReadFrontendArtifactPayload(string batchToken, int index)
    {
        var batch = pendingFrontendBatch;
        if (batch is null || batch.BatchToken != batchToken || index < 0 || index >= batch.Entries.Count)
            throw new InvalidOperationException("The frontend cache batch is stale or invalid.");
        return (byte[])batch.Entries[index].Payload.Clone();
    }

    [JSExport]
    public static void AcknowledgeFrontendArtifactBatch(string publicationToken, string batchToken)
    {
        var publication = pendingFrontendPublication;
        var batch = pendingFrontendBatch;
        var session = frontendPublicationSession;
        if (publication is null || batch is null || session is null ||
            publication.Token != publicationToken || batch.BatchToken != batchToken)
            throw new InvalidOperationException("The frontend cache batch is stale or invalid.");
        session.AcknowledgeFrontendArtifactBatch(publication, batch);
        pendingFrontendBatch = null;
        if (!batch.IsFinal) return;
        pendingFrontendPublication = null;
        frontendPublicationSession = null;
        session.Dispose();
    }

    [JSExport]
    public static void AbandonFrontendArtifactPublication(string publicationToken)
    {
        var publication = pendingFrontendPublication;
        var session = frontendPublicationSession;
        if (publication is null || session is null || publication.Token != publicationToken)
            throw new InvalidOperationException("The frontend cache publication is stale or invalid.");
        try { session.AbandonFrontendArtifactPublication(publication); }
        finally
        {
            pendingFrontendBatch = null;
            pendingFrontendPublication = null;
            frontendPublicationSession = null;
            session.Dispose();
        }
    }

    private static PendingFrontendCompilation RequirePending(string handle) =>
        pendingFrontendCompilation is { } pending && pending.Preparation.Handle == handle
            ? pending : throw new InvalidOperationException("The frontend cache preparation is stale or invalid.");
#endif

    private static int CountCatalogCases(Compilation compilation) => compilation.SyntaxTrees.Sum(tree =>
        tree.FilePath.EndsWith("__TestSource.g.cs", StringComparison.Ordinal)
            ? tree.ToString().Split("cases.Add(new global::TUnit.Core.GeneratedTestCase<", StringSplitOptions.None).Length - 1 : 0);

    private static DiagnosticInfo Describe(Diagnostic diagnostic)
    {
        var location = diagnostic.Location.GetLineSpan();
        return new(diagnostic.Id, Bound(diagnostic.GetMessage()), diagnostic.Severity.ToString(),
            location.Path, location.StartLinePosition.Line, location.StartLinePosition.Character);
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
