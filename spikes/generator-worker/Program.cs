using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices.JavaScript;
using System.Runtime.Versioning;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.Diagnostics;
using Microsoft.CodeAnalysis.Text;
using TUnit.Core.SourceGenerator.Generators;

[assembly: SupportedOSPlatform("browser")]

namespace NetWasm.Playground.GeneratorProbe;

public static partial class Program
{
    public sealed record ReferenceInput(string path, string bytes);
    public sealed record GeneratedSource(string producer, string hintName, string text, int bytes, string sha256);

    public static void Main() { }

    [JSExport]
    public static string Generate(string source, string referencesJson)
    {
        var started = Stopwatch.GetTimestamp();
        try
        {
            var parse = new CSharpParseOptions(LanguageVersion.Latest,
                preprocessorSymbols: ["TRACE", "NETWASM", "NETWASM0_1", "RELEASE"]);
            var tree = CSharpSyntaxTree.ParseText(SourceText.From(source, Encoding.UTF8), parse, "Tests.cs");
            var references = JsonSerializer.Deserialize<ReferenceInput[]>(referencesJson)!
                .Select(input => MetadataReference.CreateFromImage(Convert.FromBase64String(input.bytes), filePath: input.path));
            var compilation = CSharpCompilation.Create("NetWasmGeneratorTests", [tree], references,
                new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary,
                    optimizationLevel: OptimizationLevel.Release,
                    nullableContextOptions: NullableContextOptions.Enable,
                    concurrentBuild: false, deterministic: true));
            var sourceDiagnostics = compilation.GetDiagnostics();
            if (sourceDiagnostics.Any(d => d.Severity == DiagnosticSeverity.Error))
            {
                return Serialize(false, "source", [], sourceDiagnostics, [], null, 0, started, TimeSpan.Zero);
            }

            // Only these statically referenced, preapproved packaged generators run.
            // User assemblies remain metadata inputs; no analyzer discovery or loading occurs.
            IIncrementalGenerator[] incrementalGenerators =
            [
                new TestMetadataGenerator(),
                new HookMetadataGenerator(),
                new AotConverterGenerator(),
                new PropertyInjectionSourceGenerator(),
            ];
            GeneratorDriver driver = CSharpGeneratorDriver.Create(
                incrementalGenerators.Select(generator => generator.AsSourceGenerator()),
                parseOptions: parse, optionsProvider: new CatalogOptionsProvider());
            var generatorStarted = Stopwatch.GetTimestamp();
            driver = driver.RunGeneratorsAndUpdateCompilation(compilation, out var generatedCompilation, out var generatorDiagnostics);
            var generatorElapsed = Stopwatch.GetElapsedTime(generatorStarted);
            var run = driver.GetRunResult();
            var generated = run.Results.SelectMany((result, producerIndex) => result.GeneratedSources.Select(item =>
            {
                var text = item.SourceText.ToString();
                var bytes = Encoding.UTF8.GetBytes(text);
                return new GeneratedSource(
                    incrementalGenerators[producerIndex].GetType().FullName!, item.HintName, text,
                    bytes.Length, Convert.ToHexStringLower(SHA256.HashData(bytes)));
            })).OrderBy(item => item.hintName, StringComparer.Ordinal).ToArray();
            if (generatorDiagnostics.Any(d => d.Severity == DiagnosticSeverity.Error) ||
                run.Results.Any(result => result.Exception is not null))
            {
                return Serialize(false, "generator", generatorDiagnostics, sourceDiagnostics, [], null,
                    generated.Length, started, generatorElapsed);
            }

            using var pe = new MemoryStream();
            var emitted = generatedCompilation.Emit(pe);
            return Serialize(emitted.Success, emitted.Success ? "complete" : "emit",
                generatorDiagnostics, emitted.Diagnostics,
                emitted.Success ? generated : [], emitted.Success ? pe.ToArray() : null,
                generated.Length, started, generatorElapsed);
        }
        catch (Exception error)
        {
            return JsonSerializer.Serialize(new { success = false, stage = "generator-host",
                errorType = error.GetType().Name, error = error.Message,
                generatedSources = Array.Empty<GeneratedSource>(), pe = (string?)null,
                milliseconds = Stopwatch.GetElapsedTime(started).TotalMilliseconds });
        }
    }

    private static string Serialize(bool success, string stage,
        IEnumerable<Diagnostic> generatorDiagnostics, IEnumerable<Diagnostic> diagnostics,
        GeneratedSource[] generated, byte[]? pe, int attemptedSourceCount, long started, TimeSpan generatorElapsed) =>
        JsonSerializer.Serialize(new
        {
            success, stage,
            generatorDiagnostics = generatorDiagnostics.Select(Describe),
            diagnostics = diagnostics.Select(Describe),
            generatedSources = generated,
            attemptedGeneratedSourceCount = attemptedSourceCount,
            catalogCaseCount = generated.Sum(item => item.text.Split(
                "cases.Add(new global::TUnit.Core.GeneratedTestCase<", StringSplitOptions.None).Length - 1),
            pe = pe is null ? null : Convert.ToBase64String(pe),
            generatorMilliseconds = generatorElapsed.TotalMilliseconds,
            milliseconds = Stopwatch.GetElapsedTime(started).TotalMilliseconds,
            generatorAssembly = typeof(TestMetadataGenerator).Assembly.GetName().FullName,
            roslynAssembly = typeof(CSharpCompilation).Assembly.GetName().FullName,
            trustedGeneratorTypes = new[] { typeof(TestMetadataGenerator).FullName,
                typeof(HookMetadataGenerator).FullName, typeof(AotConverterGenerator).FullName,
                typeof(PropertyInjectionSourceGenerator).FullName },
        });

    private static object Describe(Diagnostic diagnostic)
    {
        var location = diagnostic.Location.GetLineSpan();
        return new { code = diagnostic.Id, message = diagnostic.GetMessage(), severity = diagnostic.Severity.ToString(),
            path = location.Path, line = location.StartLinePosition.Line, column = location.StartLinePosition.Character };
    }

    private sealed class CatalogOptionsProvider : AnalyzerConfigOptionsProvider
    {
        private static readonly AnalyzerConfigOptions Catalog = new FixedOptions();
        public override AnalyzerConfigOptions GlobalOptions => Catalog;
        public override AnalyzerConfigOptions GetOptions(SyntaxTree tree) => Catalog;
        public override AnalyzerConfigOptions GetOptions(AdditionalText textFile) => Catalog;
    }

    private sealed class FixedOptions : AnalyzerConfigOptions
    {
        public override bool TryGetValue(string key, out string value)
        {
            switch (key)
            {
                case "build_property.EnableTUnitSourceGeneration": value = "true"; return true;
                case "build_property.TUnitSourceGenerationMode": value = "ClosedWorldCatalog"; return true;
                default: value = string.Empty; return false;
            }
        }
    }
}
