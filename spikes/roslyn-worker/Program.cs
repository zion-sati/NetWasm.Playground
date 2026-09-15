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

[assembly: SupportedOSPlatform("browser")]

namespace NetWasm.Playground.CompilerProbe;

public static partial class Program
{
    public sealed record SupportSource(string path, string text);

    public static void Main() { }

    [JSExport]
    public static string Compile(string source, string reference, string supportJson)
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
            return JsonSerializer.Serialize(new {
                success = emitted.Success,
                diagnostics = emitted.Diagnostics.Select(d => new { code = d.Id, message = d.GetMessage(),
                    severity = d.Severity.ToString(), path = d.Location.GetLineSpan().Path,
                    line = d.Location.GetLineSpan().StartLinePosition.Line,
                    column = d.Location.GetLineSpan().StartLinePosition.Character }),
                pe = emitted.Success ? Convert.ToBase64String(pe.ToArray()) : null
            });
        }
        catch (Exception error)
        {
            return JsonSerializer.Serialize(new { success = false, stage = "compiler-host", error = error.ToString() });
        }
    }
}
