using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using NetWasm.Playground.CompilerProbe;

namespace NetWasm.Playground.NativeAotCompilerHost;

internal sealed record NativeAotRequest(string operation, string[] arguments);

[JsonSerializable(typeof(NativeAotRequest))]
internal sealed partial class NativeAotBridgeJsonContext : JsonSerializerContext;

public static unsafe class NativeAotBridge
{
    private static byte[] result = [];
    private static byte[] error = [];

    [UnmanagedCallersOnly(EntryPoint = "NetWasmCompiler_Alloc")]
    public static byte* Allocate(int length) => length > 0
        ? (byte*)NativeMemory.Alloc((nuint)length)
        : null;

    [UnmanagedCallersOnly(EntryPoint = "NetWasmCompiler_Free")]
    public static void Free(byte* pointer) => NativeMemory.Free(pointer);

    [UnmanagedCallersOnly(EntryPoint = "NetWasmCompiler_Invoke")]
    public static int Invoke(byte* requestPointer, int requestLength)
    {
        result = [];
        error = [];
        try
        {
            if (requestPointer is null || requestLength <= 0)
                throw new ArgumentOutOfRangeException(nameof(requestLength));
            var request = JsonSerializer.Deserialize(
                new ReadOnlySpan<byte>(requestPointer, requestLength),
                NativeAotBridgeJsonContext.Default.NativeAotRequest)
                ?? throw new InvalidDataException("Native compiler request is empty.");
            var arguments = request.arguments;
            var response = request.operation switch
            {
                "configureGuestMemoryMaximum" => ConfigureGuestMemoryMaximum(arguments),
                "compile" => Compile(arguments),
                "compileRecipe" => CompileRecipe(arguments),
                "compileGeneratedRecipe" => CompileGeneratedRecipe(arguments),
                "compileProject" => CompileProject(arguments),
                "compileWebAssembly" => CompileWebAssembly(arguments),
                "buildRawBindings" => BuildRawBindings(arguments),
                "useCompiledUnits" => UseCompiledUnits(arguments),
                "importCompiledUnits" => ImportCompiledUnits(arguments),
                "exportCompiledUnits" => ExportCompiledUnits(arguments),
                "retainComponentExports" => RetainComponentExports(arguments),
                "filterInlineAnnotations" => FilterInlineAnnotations(arguments),
                "removeRawExports" => RemoveRawExports(arguments),
                _ => throw new InvalidDataException("Native compiler operation is unsupported."),
            };
            result = Encoding.UTF8.GetBytes(response);
            return result.Length;
        }
        catch (Exception exception)
        {
            error = Encoding.UTF8.GetBytes(exception.ToString());
            return -1;
        }
    }

    [UnmanagedCallersOnly(EntryPoint = "NetWasmCompiler_CopyResult")]
    public static int CopyResult(byte* destination, int capacity) => CopyTo(result, destination, capacity);

    [UnmanagedCallersOnly(EntryPoint = "NetWasmCompiler_CopyError")]
    public static int CopyError(byte* destination, int capacity)
    {
        if (destination is null) return error.Length;
        return CopyTo(error, destination, capacity);
    }

    private static string ConfigureGuestMemoryMaximum(string[] arguments)
    {
        RequireCount(arguments, 1);
        Program.ConfigureGuestMemoryMaximum(int.Parse(arguments[0], System.Globalization.CultureInfo.InvariantCulture));
        return "{}";
    }

    private static string Compile(string[] value)
    {
        RequireCount(value, 15);
        return Program.Compile(value[0], value[1], value[2], value[3], value[4], value[5], value[6], value[7],
            value[8], value[9], bool.Parse(value[10]), value[11], value[12], bool.Parse(value[13]), value[14]);
    }

    private static string CompileRecipe(string[] value)
    {
        RequireCount(value, 17);
        return Program.CompileRecipe(value[0], value[1], value[2], value[3], value[4], value[5], value[6], value[7],
            value[8], value[9], value[10], value[11], bool.Parse(value[12]), value[13], value[14],
            bool.Parse(value[15]), value[16]);
    }

    private static string FilterInlineAnnotations(string[] value)
    {
        RequireCount(value, 2);
        return Program.FilterInlineAnnotations(value[0], value[1]);
    }

    private static string CompileGeneratedRecipe(string[] value)
    {
        RequireCount(value, 19);
        return Program.CompileGeneratedRecipe(value[0], value[1], value[2], value[3], value[4], value[5], value[6], value[7],
            value[8], value[9], value[10], value[11], bool.Parse(value[12]), value[13],
            bool.Parse(value[14]), value[15], value[16], bool.Parse(value[17]), value[18]);
    }

    private static string CompileProject(string[] value)
    {
        RequireCount(value, 19);
        return Program.CompileProject(value[0], value[1], value[2], value[3], value[4], value[5], value[6], value[7],
            value[8], value[9], value[10], value[11], value[12], value[13], bool.Parse(value[14]), value[15], value[16],
            bool.Parse(value[17]), value[18]);
    }

    private static string BuildRawBindings(string[] value)
    {
        RequireCount(value, 5);
        return Program.BuildRawBindings(value[0], value[1], value[2], value[3], value[4]);
    }

    private static string CompileWebAssembly(string[] value)
    {
        RequireCount(value, 0);
        return Program.CompileWebAssembly();
    }

    private static string UseCompiledUnits(string[] value)
    {
        RequireCount(value, 1);
        Program.UseCompiledUnits(value[0]);
        return "{}";
    }

    private static string ImportCompiledUnits(string[] value)
    {
        RequireCount(value, 2);
        Program.ImportCompiledUnits(value[0], value[1]);
        return "{}";
    }

    private static string ExportCompiledUnits(string[] value)
    {
        RequireCount(value, 1);
        return Program.ExportCompiledUnits(value[0]);
    }

    private static string RetainComponentExports(string[] value)
    {
        RequireCount(value, 2);
        return Program.RetainComponentExports(value[0], value[1]);
    }

    private static string RemoveRawExports(string[] value)
    {
        RequireCount(value, 2);
        return Program.RemoveRawExports(value[0], value[1]);
    }

    private static int CopyTo(byte[] source, byte* destination, int capacity)
    {
        if (destination is null || capacity < source.Length) return -1;
        source.CopyTo(new Span<byte>(destination, capacity));
        return source.Length;
    }

    private static void RequireCount(string[] arguments, int expected)
    {
        if (arguments.Length != expected)
            throw new InvalidDataException($"Native compiler operation expected {expected} arguments.");
    }
}
