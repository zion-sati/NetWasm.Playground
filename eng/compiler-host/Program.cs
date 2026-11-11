extern alias jsonsourcegen;

using System;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Text.Json.Serialization;
#if NATIVEAOT_LLVM
using JSExportAttribute = NetWasm.Playground.CompilerProbe.NativeAotExportAttribute;
#else
using System.Runtime.InteropServices.JavaScript;
#endif
using System.Runtime.Versioning;
using System.Text;
using System.Diagnostics;
using Microsoft.CodeAnalysis.Text;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using NetWasm.Compiler;
using NetWasm.Compiler.Browser;
using NetWasm.Compiler.Core;
using NetWasm.Compiler.ExceptionTypes;
using NetWasm.Compiler.Wasm;
using System.Collections.Generic;
using NetWasm.Runtime.Pack.Planning;
using NetWasm.Compiler.ComponentModel;
using NetWasm.Compiler.ComponentModel.Browser;
using NetWasm.Compiler.ComponentModel.Browser.Plans;
using NetWasm.Compiler.ComponentModel.Browser.Optimization;
using NetWasm.Compiler.ComponentModel.Optimization;
using NetWasm.Compiler.ComponentModel.Raw;
using Microsoft.CodeAnalysis.Diagnostics;
using System.Collections.Immutable;
using System.Security.Cryptography;
using System.Threading;
using TUnit.Core.SourceGenerator.Generators;
using Microsoft.Extensions.Logging.Generators;
using JsonSourceGenerator = jsonsourcegen::System.Text.Json.SourceGeneration.JsonSourceGenerator;

[assembly: SupportedOSPlatform("browser")]

namespace NetWasm.Playground.CompilerProbe;

#if NATIVEAOT_LLVM
[AttributeUsage(AttributeTargets.Method)]
internal sealed class NativeAotExportAttribute : Attribute { }
#endif

public static partial class Program
{
    public sealed record SupportSource(string path, string text);
    public sealed record UserSource(string path, string text);
    public sealed record UserSourceSet(int schemaVersion, UserSource[] files);
    private sealed record StageTiming(string stage, double milliseconds);
    private sealed record GeneratedSource(string producer, string hintName, string? text, int bytes, string sha256);
    private sealed record DiagnosticInfo(string code, string message, string severity, string? path = null,
        int? line = null, int? column = null, string? method = null, int? ilOffset = null);
    private sealed record GeneratorFailure(string? producer, string? errorType, string? message);
    private sealed record FunctionTypeInfo(int[] Parameters, int Result);
    private sealed record FunctionImportInfo(string Module, string Name, FunctionTypeInfo Type);
    private sealed record EntryPointAbiInfo(int ParameterShape, int ReturnShape, int CompletionShape);
    private sealed record EntryPointInfo(string AssemblyPath, string TypeName, string MethodName, int? Token,
        int Kind, EntryPointAbiInfo? Abi);
    private sealed record RuntimeLinkAssetInfo(string Path, string Sha256);
    private sealed record RuntimeSystemLibrary(string Path, string Sha256);
    private sealed record RuntimeNativeLibrary(string LibraryName, string Target, string Path, string Sha256);
    private sealed record RuntimeCacheInfo(string schema, string @namespace, string slot, string key);
    private sealed record RuntimeLinkPlanInfo(string[] Arguments, string[] OptimizationArguments,
        RuntimeLinkAssetInfo[] Inputs, string RuntimeAbi,
        string ToolchainFingerprint, long RuntimeGlobalBase, long HeapBase, long InitialMemorySizeBytes,
        long MaximumMemorySizeBytes, RuntimeCacheInfo Cache, RuntimeLinkExportInfo[] InternalRuntimeExports, string GarbageCollector);
    private sealed record RuntimeLinkExportInfo(string Name, byte Kind);
    // Base64 bytes that name the exception types a structured failure report carries.
    private sealed record DiagnosticArtifactsInfo(string wasm, string exceptionTypeMap, string mapMediaType, string manifest);
    private sealed record RawCoreImportInfo(string Module, string Name, int[] Parameters, int[] Results);
    private sealed record RequiredImportInfo(string Interface, string Name, string[] Parameters, string[] Results);
    private sealed record RawBindingResponse(int schemaVersion, bool success, string? error = null,
        string? adapter = null, RequiredImportInfo[]? requiredImports = null);
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
        // The compiler's own manifest, so every field it writes reaches the host's reader.
        HostInteropManifest? interopManifest = null,
        EntryPointInfo? entryPoint = null,
        RuntimeLinkPlanInfo? runtimeLinkPlan = null,
        string? coreLinkPlan = null,
        string? rawCoreLinkPlan = null,
        string? rawBindingHandle = null,
        string? trustedRecipe = null,
        int? catalogCaseCount = null,
        string? componentContract = null,
        string? pe = null,
        DiagnosticArtifactsInfo? diagnosticArtifacts = null,
        // What the compilation reused of the compiled units it kept, when it kept units.
        string? compiledUnits = null,
        // The C# compiled; CompileWebAssembly finishes the compilation.
        bool? prepared = null
        );

    [JsonSourceGenerationOptions(DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull)]
    [JsonSerializable(typeof(SupportSource[]))]
    [JsonSerializable(typeof(UserSourceSet))]
    [JsonSerializable(typeof(RuntimeSystemLibrary[]))]
    [JsonSerializable(typeof(RuntimeNativeLibrary[]))]
    [JsonSerializable(typeof(Dictionary<string, string>))]
    [JsonSerializable(typeof(CompilerHostResponse))]
    [JsonSerializable(typeof(RawCoreImportInfo[]))]
    [JsonSerializable(typeof(RuntimeLinkExportInfo[]))]
    [JsonSerializable(typeof(RawBindingResponse))]
    private sealed partial class CompilerHostJsonContext : JsonSerializerContext;
    private const int MaximumGeneratedSources = 128;
    private const int MaximumGeneratedBytes = 512 * 1024;
    private const int MaximumUserSources = 32;
    private const int MaximumUserSourceBytes = 64 * 1024;
    private const int MaximumUserSourceSetBytes = 256 * 1024;
    private static bool progressEnabled;
    private static long? guestMemoryMaximum;
    private sealed record PendingRawBinding(
        RawCompilerImportSource Source,
        string CompilerWitJson,
        string CompilerWitInventory);
    private static PendingRawBinding? pendingRawBinding;
    private static string? pendingRawBindingHandle;
    // One compiler session for the worker's life keeps each method's compiled code between
    // compilations; the host names the units a compilation keeps and stores them between
    // sessions (IndexedDB).
    private static readonly BrowserCompilerSession compilerSession = new();
    private static string? compiledUnitsName;

    // The units later compilations keep and reuse; empty keeps none.
    [JSExport]
    public static void UseCompiledUnits(string name) => compiledUnitsName = name.Length == 0 ? null : name;

    // Units a host stored, from this compiler version or another (which are not reused).
    [JSExport]
    public static void ImportCompiledUnits(string name, string units) =>
        compilerSession.ImportCompiledUnits(name, Convert.FromBase64String(units));

    [JSExport]
    public static string ExportCompiledUnits(string name) =>
        Convert.ToBase64String(compilerSession.ExportCompiledUnits(name));

    [JSExport]
    public static void ConfigureGuestMemoryMaximum(int bytes)
    {
        if (bytes <= 0 || bytes % 65536 != 0)
            throw new ArgumentOutOfRangeException(nameof(bytes), "Guest memory maximum must be a positive multiple of 64 KiB.");
        guestMemoryMaximum = bytes;
    }

#if NATIVEAOT_LLVM
    private static void ReportStage(string stage) { }
#else
    [JSImport("reportStage", "compiler-progress")]
    private static partial void ReportStage(string stage);
#endif

    [JSExport]
    public static void EnableProgress() => progressEnabled = true;

    private static void Stage(string stage) { if (progressEnabled) ReportStage(stage); }

    public static void Main() { }

    private static string Bound(string text) => text.Length <= 4096 ? text : text[..4096];

    private static string Serialize(CompilerHostResponse response) =>
        JsonSerializer.Serialize(response, CompilerHostJsonContext.Default.CompilerHostResponse);

    private static FunctionImportInfo Describe(WasmFunctionImport import) => new(import.Module, import.Name,
        new(import.Type.Parameters.Select(value => (int)value).ToArray(), (int)import.Type.Result));

    private static DiagnosticArtifactsInfo? Describe(DiagnosticArtifactBundle? artifacts) => artifacts is null ? null : new(
        Convert.ToBase64String(artifacts.Wasm), Convert.ToBase64String(artifacts.ExceptionTypeMap.Bytes),
        artifacts.ExceptionTypeMap.MediaType, Convert.ToBase64String(artifacts.ManifestBytes));

    private static EntryPointInfo Describe(BrowserCompilationEntryPoint entryPoint) => new(entryPoint.AssemblyPath,
        entryPoint.TypeName, entryPoint.MethodName, entryPoint.Token, (int)entryPoint.Kind,
        entryPoint.Abi is null ? null : new((int)entryPoint.Abi.ParameterShape, (int)entryPoint.Abi.ReturnShape,
            (int)entryPoint.Abi.CompletionShape));

    private static RuntimeLinkPlanInfo Describe(RuntimeLinkPlan plan) => new(plan.Arguments.ToArray(),
        plan.OptimizationArguments.ToArray(),
        plan.Inputs.Select(value => new RuntimeLinkAssetInfo(value.Path, value.Sha256)).ToArray(), plan.RuntimeAbi,
        plan.ToolchainFingerprint, plan.RuntimeGlobalBase, plan.HeapBase, plan.InitialMemorySizeBytes,
        plan.MaximumMemorySizeBytes, new(plan.Cache.Schema, plan.Cache.Namespace,
            plan.Cache.Slot, plan.Cache.Key),
        plan.InternalRuntimeExports.Select(value => new RuntimeLinkExportInfo(value.Name, value.Kind)).ToArray(), plan.GarbageCollector);

    private static string SerializeLinkPlan(BrowserLinkPlan plan) =>
        new BrowserLinkPlanSerializer().Serialize(BrowserLinkPlanValidation.CreateExecutionBuilder().Build(plan));

    private static RuntimeWasmOptimization ParseOptimization(string optimization) => optimization switch
    {
        "none" => RuntimeWasmOptimization.None,
        "O0" => RuntimeWasmOptimization.O0,
        "O1" => RuntimeWasmOptimization.O1,
        "O2" => RuntimeWasmOptimization.O2,
        "O3" => RuntimeWasmOptimization.O3,
        "Os" => RuntimeWasmOptimization.Os,
        "Oz" => RuntimeWasmOptimization.Oz,
        _ => throw new ArgumentOutOfRangeException(nameof(optimization), "Unsupported optimization mode."),
    };

    [JSExport]
    public static string Compile(string source, string reference, string supportJson, string implementation, string witJson, string witBytes,
        string witInventory, string runtimeManifest,
        string runtimeSystemLibrariesJson, string languageVersion, bool updatedMemorySafetyRules, string optimization, string garbageCollector, bool structuredDiagnostics, string optimizationOverridesJson)
        => CompileRecipe(source, reference, supportJson, implementation, witJson, witBytes,
            witInventory, runtimeManifest,
            runtimeSystemLibrariesJson, "{}", "{}", languageVersion, updatedMemorySafetyRules, optimization, garbageCollector, structuredDiagnostics, optimizationOverridesJson);

    [JSExport]
    public static string CompileRecipe(string source, string reference, string supportJson, string implementation, string witJson, string witBytes,
        string witInventory, string runtimeManifest,
        string runtimeSystemLibrariesJson, string additionalReferencesJson, string additionalImplementationsJson,
        string languageVersion, bool updatedMemorySafetyRules, string optimization, string garbageCollector, bool structuredDiagnostics, string optimizationOverridesJson)
        => CompileCore(source, reference, supportJson, implementation, witJson, witBytes,
            witInventory, runtimeManifest,
            runtimeSystemLibrariesJson, additionalReferencesJson, additionalImplementationsJson, null, false,
            languageVersion, updatedMemorySafetyRules, optimization, garbageCollector, structuredDiagnostics, optimizationOverridesJson);

    [JSExport]
    public static string CompileGeneratedRecipe(string source, string reference, string supportJson, string implementation, string witJson, string witBytes,
        string witInventory, string runtimeManifest,
        string runtimeSystemLibrariesJson, string additionalReferencesJson, string additionalImplementationsJson, string trustedRecipe, bool includeGeneratedSourceText,
        string languageVersion, bool updatedMemorySafetyRules, string optimization, string garbageCollector, bool structuredDiagnostics, string optimizationOverridesJson)
        => CompileCore(source, reference, supportJson, implementation, witJson, witBytes,
            witInventory, runtimeManifest,
            runtimeSystemLibrariesJson, additionalReferencesJson, additionalImplementationsJson, trustedRecipe, includeGeneratedSourceText,
            languageVersion, updatedMemorySafetyRules, optimization, garbageCollector, structuredDiagnostics, optimizationOverridesJson);

    [JSExport]
    public static string CompileProject(string source, string projectKind, string reference, string supportJson,
        string implementation, string witJson, string witBytes, string witInventory,
        string runtimeManifest, string runtimeSystemLibrariesJson,
        string additionalReferencesJson, string additionalImplementationsJson,
        string nativeLibrariesJson, string languageVersion, bool updatedMemorySafetyRules,
        string optimization, string garbageCollector, bool structuredDiagnostics, string optimizationOverridesJson)
        => CompileCore(source, reference, supportJson, implementation, witJson, witBytes,
            witInventory, runtimeManifest, runtimeSystemLibrariesJson,
            additionalReferencesJson, additionalImplementationsJson, null, false,
            languageVersion, updatedMemorySafetyRules, optimization, garbageCollector, structuredDiagnostics, optimizationOverridesJson,
            projectKind: projectKind, nativeLibrariesJson: nativeLibrariesJson);


    private static string CompileCore(string source, string reference, string supportJson, string implementation, string witJson, string witBytes,
        string witInventory, string runtimeManifest,
        string runtimeSystemLibrariesJson, string additionalReferencesJson, string additionalImplementationsJson, string? trustedRecipe, bool includeGeneratedSourceText,
        string languageVersion, bool updatedMemorySafetyRules, string optimization, string garbageCollector, bool structuredDiagnostics, string optimizationOverridesJson,
        string projectKind = "command",
        string nativeLibrariesJson = "[]"
        )
    {
        preparedCompilation = null;
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
            if (projectKind is not ("command" or "jsexport-worker"))
                return Serialize(new(1, false, "request", "unsupported-project-kind", true, []));
            var javaScriptExportWorker = projectKind == "jsexport-worker";
            var runtimeOptimization = ParseOptimization(optimization);
            var optimizationOverrides = new BrowserOptimizationOverridesDeserializer().Deserialize(optimizationOverridesJson);
            var tunit = trustedRecipe == "tunit";
            Stage("roslyn");
            var started = Stopwatch.GetTimestamp();
            var parse = new CSharpParseOptions(languageVersion == "15" ? LanguageVersion.CSharp15 : LanguageVersion.Preview,
                preprocessorSymbols: ["TRACE", "NETWASM", "NETWASM0_1", "RELEASE"]);
            if (updatedMemorySafetyRules)
                parse = parse.WithFeatures([new("updated-memory-safety-rules", "true")]);
            var userSources = ParseUserSources(source, tunit ? "Tests.cs" : "Program.cs");
            var trees = userSources
                .Select(file => CSharpSyntaxTree.ParseText(SourceText.From(file.text, Encoding.UTF8), parse, file.path))
                .Concat(JsonSerializer.Deserialize(supportJson, CompilerHostJsonContext.Default.SupportSourceArray)!
                    .Select(file => CSharpSyntaxTree.ParseText(SourceText.From(file.text, Encoding.UTF8), parse, file.path)));
            if (tunit) trees = trees.Append(CSharpSyntaxTree.ParseText(SourceText.From(TrustedGeneratorAssets.TUnitProgram, Encoding.UTF8), parse, "NetWasm.TUnit.Program.cs"));
            var compilation = CSharpCompilation.Create(tunit ? "NetWasmTUnitTests" : "NetWasmApp", trees,
                new[] { reference }.Concat(JsonSerializer.Deserialize(additionalReferencesJson, CompilerHostJsonContext.Default.DictionaryStringString)!.Values)
                    .Select(bytes => MetadataReference.CreateFromImage(Convert.FromBase64String(bytes))),
                new CSharpCompilationOptions(javaScriptExportWorker
                        ? OutputKind.DynamicallyLinkedLibrary
                        : OutputKind.ConsoleApplication,
                    optimizationLevel: OptimizationLevel.Release,
                    nullableContextOptions: NullableContextOptions.Enable,
                    allowUnsafe: true,
                    concurrentBuild: false, deterministic: true,
                    mainTypeName: tunit ? "NetWasm.TUnit.Generated.NetWasmTestProgram" : null));
            Compilation generatedCompilation = compilation;
            {
                Stage("generator");
                var generatorStarted = Stopwatch.GetTimestamp();
                var generators = new List<IIncrementalGenerator> { TrustedGeneratorAssets.CreateLibraryImportGenerator() };
                generators.AddRange(trustedRecipe switch
                {
                    "tunit" => [new TestMetadataGenerator(), new HookMetadataGenerator(), new AotConverterGenerator(), new PropertyInjectionSourceGenerator()],
                    "di" => [TrustedGeneratorAssets.CreateDependencyInjectionGenerator()],
                    "logging" => [TrustedGeneratorAssets.CreateLoggingGenerator()],
                    null => [],
                    _ => [new JsonSourceGenerator()],
                });
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
            var image = pe.ToArray();
            string CompileWebAssembly()
            {
                try
                {
                    Stage("netwasm");
                    started = Stopwatch.GetTimestamp();
                    // Every command, synchronous or asynchronous, is a WASI 0.3 command.
                    var componentContract = javaScriptExportWorker ? "jsexport-worker" : "command";
                    var images = new Dictionary<string,byte[]> { ["NetWasmApp.dll"] = image, ["NetWasm.CoreLib.dll"] = Convert.FromBase64String(implementation) };
                    var additionalImplementations = JsonSerializer.Deserialize(additionalImplementationsJson, CompilerHostJsonContext.Default.DictionaryStringString)!;
                    foreach (var image in additionalImplementations) images.Add(image.Key, Convert.FromBase64String(image.Value));
                    images["compiler.wit.wasm"] = Convert.FromBase64String(witBytes);
                    var options = new CompilerOptions(
                        "NetWasmApp.dll", ["NetWasm.CoreLib.dll", .. additionalImplementations.Keys],
                        javaScriptExportWorker ? string.Empty : "Program",
                        javaScriptExportWorker ? string.Empty : "<Main>$", [],
                        WitPath: "compiler.wit.wasm", WitWorld: "netwasm:platform@1.0.0/platform",
                        EntryPointKind: javaScriptExportWorker
                            ? CompilerEntryPointKind.Library
                            : CompilerEntryPointKind.ManagedExecutable,
                        UseJavaScriptExportBoundary: javaScriptExportWorker,
                        // A command reports an unhandled exception's type and message when the profile asks for it.
                        StructuredDiagnostics: structuredDiagnostics && !javaScriptExportWorker,
                        Optimization: Enum.Parse<FinalWasmOptimization>(runtimeOptimization.ToString()),
                        OptimizationOverrides: optimizationOverrides,
                        IntermediateOutputPath: compiledUnitsName)
                    {
                        CompiledUnits = compiledUnitsName is not null,
                    };
                    var request = new BrowserCompilationRequest(options, images,
                        new Dictionary<string,string> { ["compiler.wit.wasm"] = witJson },
                        new Dictionary<string,string>
                        {
                            ["compiler.wit.wasm"] = witInventory,
                        },
                        selectManagedExecutableEntryPoint: !javaScriptExportWorker);
                    var compiled = compilerSession.Compile(request);
                    if (compiled.NativeCallbackSupport is not null)
                        throw new InvalidOperationException("Browser native callbacks are not supported.");
                    timings.Add(new("netwasm", Stopwatch.GetElapsedTime(started).TotalMilliseconds));
                    var systemLibraries = JsonSerializer.Deserialize(runtimeSystemLibrariesJson,
                        CompilerHostJsonContext.Default.RuntimeSystemLibraryArray)!
                        .Select(asset => new RuntimeLinkPlanAsset(asset.Path, asset.Sha256)).ToImmutableArray();
                    var nativeLibraries = JsonSerializer.Deserialize(nativeLibrariesJson,
                        CompilerHostJsonContext.Default.RuntimeNativeLibraryArray)!;
                    var runtimeLinkPlan = RuntimeLinkPlanner.Plan(new(runtimeManifest, "wasm32", compiled.StaticDataEnd,
                        AssetRoot: "/netwasm-link/runtime", OutputPath: "/netwasm-link/runtime.wasm",
                        MaximumMemorySizeBytes: guestMemoryMaximum, SystemLibraries: systemLibraries,
                        Optimization: runtimeOptimization)
                    {
                        GarbageCollector = garbageCollector,
                        RuntimeFeatures = compiled.RuntimeFeatures,
                        NativeImports = [.. compiled.NativeImports.Select(import => new RuntimeLinkPlanNativeImport(
                            import.LibraryName,
                            import.EntryPoint,
                            [.. import.Parameters.Select(MapNativeType)],
                            import.ReturnType is { } result ? MapNativeType(result) : null))],
                        NativeLibraries = [.. nativeLibraries.Select(library => new RuntimeLinkPlanNativeLibrary(
                            library.LibraryName, library.Target, library.Path, library.Sha256))],
                    });
                    string? coreLinkPlan = null;
                    string? rawCoreLinkPlan = null;
                    string? rawBindingHandle = null;
                    if (javaScriptExportWorker)
                    {
                        var finalOptimization = Enum.Parse<FinalWasmOptimization>(optimization == "none" ? "None" : optimization);
                        var rawRequest = new RawModuleLinkRequest(
                            "/netwasm-link/application.wasm", "/netwasm-link/runtime.wasm",
                            "/netwasm-link/output.wasm", ComponentTarget.Wasm32Wasi02, finalOptimization)
                        {
                            OptimizationOverrides = optimizationOverrides,
                            InternalRuntimeExports = [.. runtimeLinkPlan.InternalRuntimeExports
                                .Select(value => new WasmInternalExport(value.Name, value.Kind))],
                            InternalApplicationExports = [],
                        };
                        rawCoreLinkPlan = SerializeLinkPlan(BrowserRawCoreModules.CreateOrderedLinkPlan(rawRequest,
                            new("/netwasm-link/raw", "/netwasm-link/raw/linked.wasm")));
                        rawBindingHandle = Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(16));
                        pendingRawBindingHandle = rawBindingHandle;
                        pendingRawBinding = new(new(compiled.FunctionImports, compiled.InteropManifest),
                            witJson, witInventory);
                    }
                    else
                    {
                        coreLinkPlan = SerializeLinkPlan(BrowserComponentCoreModules.CreateOrderedLinkPlan(
                            new("/netwasm-link/application.wasm", "/netwasm-link/runtime.wasm", "/netwasm-link/linked.wasm",
                                ComponentTarget.Wasm32Wasi02, compiled.EntryPoint.Abi,
                                Optimization: Enum.Parse<FinalWasmOptimization>(runtimeOptimization.ToString()),
                                StructuredDiagnostics: structuredDiagnostics)
                            { OptimizationOverrides = optimizationOverrides },
                            new("/netwasm-link/environment.wasm", "/netwasm-link/host.wasm", "/netwasm-link/command.wasm",
                                "/netwasm-link/merged.wasm", "/netwasm-link/sanitized.wasm", "/netwasm-link/runtime-sanitized.wasm")));
                    }
                    return Serialize(new(1, emitted.Success,
                        diagnostics: emitted.Diagnostics.Take(128).Select(Describe).ToArray(),
                        timings: timings.ToArray(), generatedSources: generatedSources,
                        generatorDiagnostics: generatorDiagnostics.Take(128).Select(Describe).ToArray(),
                        application: Convert.ToBase64String(compiled.ApplicationModule), staticDataEnd: compiled.StaticDataEnd,
                        runtimeFeatures: compiled.RuntimeFeatures.ToArray(), imports: compiled.FunctionImports.Select(Describe).ToArray(),
                        interopManifest: compiled.InteropManifest, entryPoint: Describe(compiled.EntryPoint),
                        runtimeLinkPlan: Describe(runtimeLinkPlan), coreLinkPlan: coreLinkPlan,
                        rawCoreLinkPlan: rawCoreLinkPlan, rawBindingHandle: rawBindingHandle,
                        trustedRecipe: trustedRecipe,
                        catalogCaseCount: tunit ? CountCatalogCases(generatedCompilation) : 0, componentContract: componentContract,
                        pe: emitted.Success ? Convert.ToBase64String(image) : null,
                        // The bundle carries a copy of the module; send it only when it can be used.
                        diagnosticArtifacts: structuredDiagnostics && !javaScriptExportWorker ? Describe(compiled.DiagnosticArtifacts) : null,
                        compiledUnits: compiledUnitsName is null ? null : compilerSession.CompiledUnitSummary(compiledUnitsName)));
                }
                catch (Exception error)
                {
                    return Failure(error, timings, generatedSources, generatorDiagnostics);
                }
            }
            if (!CompileInSteps) return CompileWebAssembly();
            preparedCompilation = CompileWebAssembly;
            return Serialize(new(1, true, timings: timings.ToArray(), prepared: true));
        }
        catch (Exception error)
        {
            return Failure(error, timings, generatedSources, generatorDiagnostics);
        }
    }

    private static string Failure(Exception error, List<StageTiming> timings, GeneratedSource[] generatedSources,
        ImmutableArray<Diagnostic> generatorDiagnostics) => error is CompilerException compiler
        ? Serialize(new(1, false, "netwasm", compiler.Diagnostic.Id, true,
            [new(compiler.Diagnostic.Id, Bound(compiler.Diagnostic.Message), "Error", method: compiler.Diagnostic.Method,
                ilOffset: compiler.Diagnostic.IlOffset)], timings.ToArray(), generatedSources,
            generatorDiagnostics.Take(128).Select(Describe).ToArray()))
        : Serialize(new(1, false, "compiler-host", "host-error", true, error: Bound(error.ToString())));

    // The native host cannot report progress during a call, so it compiles in two: a compile
    // call stops once C# has compiled, and CompileWebAssembly finishes that compilation.
#if NATIVEAOT_LLVM
    private static readonly bool CompileInSteps = true;
#else
    private static readonly bool CompileInSteps = false;
#endif
    private static Func<string>? preparedCompilation;

    [JSExport]
    public static string CompileWebAssembly()
    {
        var compilation = preparedCompilation ??
            throw new InvalidOperationException("No compilation has compiled its C#.");
        preparedCompilation = null;
        return compilation();
    }

    private static RuntimeLinkPlanNativeValueType MapNativeType(WasmValueType value) => value switch
    {
        WasmValueType.I32 => RuntimeLinkPlanNativeValueType.I32,
        WasmValueType.I64 => RuntimeLinkPlanNativeValueType.I64,
        WasmValueType.F32 => RuntimeLinkPlanNativeValueType.F32,
        WasmValueType.F64 => RuntimeLinkPlanNativeValueType.F64,
        _ => throw new InvalidOperationException("Native import contains an unsupported value type."),
    };

    [JSExport]
    public static string BuildRawBindings(string handle, string runtimeWitJson,
        string runtimeWitInventory, string runtimeImportsJson, string finalImportsJson)
    {
        try
        {
            if (pendingRawBinding is null || pendingRawBindingHandle is null ||
                !CryptographicOperations.FixedTimeEquals(
                    Encoding.ASCII.GetBytes(handle),
                    Encoding.ASCII.GetBytes(pendingRawBindingHandle)))
                throw new InvalidOperationException("The raw binding handle is invalid or expired.");
            var pending = pendingRawBinding;
            pendingRawBinding = null;
            pendingRawBindingHandle = null;
            var runtimeImports = ParseRawImports(runtimeImportsJson);
            var finalImports = ParseRawImports(finalImportsJson);
            const string compilerWitPath = "compiler.wit.json";
            const string runtimeWitPath = "command.wit.json";
            var result = BrowserRawBindings.Build(new(
                pending.Source,
                compilerWitPath,
                "netwasm:platform/platform@1.0.0",
                runtimeWitPath,
                "command",
                WasmTarget.Wasm32,
                new Dictionary<string, string>
                {
                    [compilerWitPath] = pending.CompilerWitJson,
                    [runtimeWitPath] = runtimeWitJson,
                },
                new Dictionary<string, string>
                {
                    [compilerWitPath] = pending.CompilerWitInventory,
                    [runtimeWitPath] = runtimeWitInventory,
                },
                runtimeImports,
                finalImports));
            return JsonSerializer.Serialize(new RawBindingResponse(1, true,
                adapter: Convert.ToBase64String(result.Adapter),
                requiredImports: result.RequiredImports.Select(value => new RequiredImportInfo(
                    value.Interface, value.Name, value.Parameters.ToArray(), value.Results.ToArray())).ToArray()),
                CompilerHostJsonContext.Default.RawBindingResponse);
        }
        catch (Exception error)
        {
            pendingRawBinding = null;
            pendingRawBindingHandle = null;
            return JsonSerializer.Serialize(new RawBindingResponse(1, false, Bound(error.ToString())),
                CompilerHostJsonContext.Default.RawBindingResponse);
        }
    }

    private static ImmutableArray<RawCoreFunctionImportSignature> ParseRawImports(string json)
    {
        var values = JsonSerializer.Deserialize(json, CompilerHostJsonContext.Default.RawCoreImportInfoArray)
            ?? throw new InvalidDataException("Raw module imports are missing.");
        if (values.Length > 512)
            throw new InvalidDataException("Raw module import limit exceeded.");
        return [.. values.Select(value => new RawCoreFunctionImportSignature(
            new(value.Module, value.Name),
            [.. value.Parameters.Select(MapRawCoreType)],
            [.. value.Results.Select(MapRawCoreType)]))];
    }

    private static RawCoreValueType MapRawCoreType(int value) => value switch
    {
        0 => RawCoreValueType.I32,
        1 => RawCoreValueType.I64,
        2 => RawCoreValueType.F32,
        3 => RawCoreValueType.F64,
        _ => throw new InvalidDataException("Raw module import contains an unsupported value type."),
    };

    [JSExport]
    public static string RemoveRawExports(string module, string exportsJson)
    {
        var exports = JsonSerializer.Deserialize(
            exportsJson, CompilerHostJsonContext.Default.RuntimeLinkExportInfoArray)
            ?? throw new InvalidDataException("Raw export selection is missing.");
        if (exports.Length is < 1 or > 512)
            throw new InvalidDataException("Raw export selection limit exceeded.");
        return Convert.ToBase64String(BrowserRawCoreModules.RemoveExports(
            Convert.FromBase64String(module),
            [.. exports.Select(value => new WasmInternalExport(value.Name, value.Kind))]));
    }

    private static UserSource[] ParseUserSources(string value, string legacyPath)
    {
        // Keep the exported ABI stable while the browser protocol moves from one
        // source string to an ordered source-set document. Older tool hosts still
        // send raw source and remain valid during the transition.
        if (!value.StartsWith("{\"schemaVersion\":", StringComparison.Ordinal)) return [new(legacyPath, value)];
        var sourceSet = JsonSerializer.Deserialize(value, CompilerHostJsonContext.Default.UserSourceSet)
            ?? throw new InvalidOperationException("The source set is missing.");
        if (sourceSet.schemaVersion != 1 || sourceSet.files is not { Length: > 0 and <= MaximumUserSources })
            throw new InvalidOperationException("The source set schema or file count is invalid.");
        var paths = new HashSet<string>(StringComparer.Ordinal);
        var totalBytes = 0;
        foreach (var file in sourceSet.files)
        {
            if (!IsSafeUserSourcePath(file.path) || !paths.Add(file.path))
                throw new InvalidOperationException("The source set contains an invalid or duplicate path.");
            var bytes = Encoding.UTF8.GetByteCount(file.text);
            if (bytes > MaximumUserSourceBytes)
                throw new InvalidOperationException($"Source file '{file.path}' exceeds 64 KiB.");
            totalBytes += bytes;
        }
        if (totalBytes > MaximumUserSourceSetBytes)
            throw new InvalidOperationException("The source set exceeds 256 KiB.");
        return sourceSet.files;
    }

    private static bool IsSafeUserSourcePath(string path) =>
        !string.IsNullOrWhiteSpace(path) && path.Length <= 240 && path.EndsWith(".cs", StringComparison.Ordinal) &&
        path[0] != '/' && !path.Contains('\\') && !path.Any(character =>
            character < ' ' || character is '<' or '>' or ':' or '"' or '|' or '?' or '*') &&
        path.Split('/').All(segment => segment.Length > 0 && segment is not "." and not "..");


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

    [JSExport]
    public static string FilterInlineAnnotations(string module, string selection) =>
        Convert.ToBase64String(new NetWasm.Compiler.ComponentModel.Inlining.WasmInlineAnnotationFilter().Filter(
            Convert.FromBase64String(module),
            Enum.Parse<NetWasm.Compiler.ComponentModel.Inlining.WasmInlineAnnotationSelection>(selection)));
}
