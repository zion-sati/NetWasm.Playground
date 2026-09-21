export interface ExampleRecipe {
  id: string;
  name: string;
  source: string;
  language?: '15' | 'preview';
  updatedMemorySafetyRules?: boolean;
}

export const examples: readonly ExampleRecipe[] = [
  {
    id: 'hello',
    name: 'Hello World',
    source: `using System;

Console.WriteLine(42);
`,
  },
  {
    id: 'csharp15-tour',
    name: 'C# 15 · Feature tour',
    language: 'preview',
    updatedMemorySafetyRules: true,
    source: `using System;
using System.Collections.Generic;

List<int> values = [with(capacity: 8), 20, 22];
Console.WriteLine($"Collection arguments: {values[0] + values[1]}");

var buffer = new FeatureBuffer();
buffer[0] = 42;
Console.WriteLine($"Extension indexer: {buffer[0]}");

var jumpResult = 40;
outer:
for (var x = 0; x < 3; x++)
{
    for (var y = 0; y < 3; y++)
    {
        if (x == 0 && y == 1) continue outer;
        if (x == 2 && y == 1) break outer;
        jumpResult++;
    }
}
Console.WriteLine($"Labeled jumps: {jumpResult}");

Pet pet = new Dog(42);
Console.WriteLine($"Union: {pet switch
{
    Cat cat => cat.Value,
    Dog dog => dog.Value,
}}");

State state = new Ready(42);
Console.WriteLine($"Closed hierarchy: {state switch
{
    Ready ready => ready.Value,
    Waiting => 0,
}}");

var value = 41;
var pointer = unsafe(&value);
Console.WriteLine($"Updated memory safety: {unsafe(Read(pointer)) + 1}");

static unsafe int Read(int* value) => unsafe(*value);

public sealed class FeatureBuffer
{
    public int[] Values { get; } = new int[1];
}

public static class FeatureBufferExtensions
{
    extension(FeatureBuffer buffer)
    {
        public int this[int index]
        {
            get => buffer.Values[index];
            set => buffer.Values[index] = value;
        }
    }
}

public sealed record Cat(int Value);
public sealed record Dog(int Value);
public union Pet(Cat, Dog);

public closed class State;
public sealed class Ready(int value) : State
{
    public int Value { get; } = value;
}
public sealed class Waiting : State;
`,
  },
  {
    id: 'datetime',
    name: 'Date and time',
    source: `using System;

// The Playground supplies no timezone data and sets TZ=UTC.
// DateTime.Now therefore uses UTC in this Playground session.
Console.WriteLine("Playground timezone: UTC (no timezone data supplied)");
Console.WriteLine($"DateTime.Now (UTC): {DateTime.Now:O}");
Console.WriteLine($"UtcNow: {DateTime.UtcNow:O}");
`,
  },
  {
    id: 'http',
    name: 'HTTP request',
    source: `using System;
using System.Net.Http;
using System.Threading.Tasks;

// This sample URL points to a small file on the Playground's own origin.
// Other URLs require their server to allow browser requests through CORS.
public static class Program
{
    public static async Task<int> Main()
    {
        string address = Environment.GetEnvironmentVariable("PLAYGROUND_HTTP_SAMPLE_URL")
            ?? throw new InvalidOperationException("HTTP sample URL is unavailable");
        using var client = new HttpClient();
        using var response = await client.GetAsync(new Uri(address));
        Console.WriteLine($"HTTP {(int)response.StatusCode}");
        Console.WriteLine(await response.Content.ReadAsStringAsync());
        return 0;
    }
}
`,
  },
  {
    id: 'allocation',
    name: 'Allocation and GC',
    source: `using System;

var survivor = new byte[1024];
survivor[0] = 42;

for (int i = 0; i < 2000; i++)
{
    var allocation = new byte[1024];
    allocation[0] = (byte)i;
}

GC.Collect();
Console.WriteLine($"Survivor: {survivor[0]}");
Console.WriteLine($"Guest collections: {GC.CollectionCount(0)}");
`,
  },
  {
    id: 'linq',
    name: 'LINQ',
    source: `using System;
using System.Linq;

int[] numbers = [1, 2, 3, 4, 5, 6];
int evenSum = numbers
    .Where(number => number % 2 == 0)
    .Select(number => number * 10)
    .Sum();

Console.WriteLine($"Even sum: {evenSum}");
`,
  },
  {
    id: 'async-linq',
    name: 'Async LINQ',
    source: `using System;
using System.Linq;
using System.Threading.Tasks;

public static class Program
{
    public static async Task<int> Main()
    {
        var values = await global::System.Linq.AsyncEnumerable.Range(1, 6)
            .Where(value => value % 2 == 0)
            .Select(value => value * 10)
            .ToArrayAsync();

        Console.WriteLine($"Async values: {string.Join(", ", values)}");
        return 0;
    }
}
`,
  },
  {
    id: 'pipelines',
    name: 'Pipelines and memory',
    source: `using System;
using System.IO.Pipelines;
using System.Threading.Tasks;

public static class Program
{
    public static async Task<int> Main()
    {
        var pipe = new Pipe();
        var memory = pipe.Writer.GetMemory(3);
        memory.Span[0] = 13;
        memory.Span[1] = 21;
        memory.Span[2] = 34;
        pipe.Writer.Advance(3);
        await pipe.Writer.FlushAsync();

        var read = await pipe.Reader.ReadAsync();
        Console.WriteLine($"Buffered bytes: {read.Buffer.Length}");
        Console.WriteLine($"First byte: {read.Buffer.FirstSpan[0]}");
        pipe.Reader.AdvanceTo(read.Buffer.End);
        pipe.Writer.Complete();
        pipe.Reader.Complete();
        return 0;
    }
}
`,
  },
  {
    id: 'web-encoding',
    name: 'Web text encoding',
    source: `using System;
using System.Text.Encodings.Web;

string input = "<NetWasm & C#>";
Console.WriteLine(JavaScriptEncoder.Default.Encode(input));
`,
  },
  {
    id: 'xml',
    name: 'XML',
    source: `using System;
using System.IO;
using System.Xml;

using var reader = XmlReader.Create(new StringReader("<runtime name=\\\"NetWasm\\\"><answer>42</answer></runtime>"));
while (reader.Read())
{
    if (reader.NodeType == XmlNodeType.Element && reader.Name == "runtime")
        Console.WriteLine($"Runtime: {reader.GetAttribute("name")}");
    if (reader.NodeType == XmlNodeType.Element && reader.Name == "answer" && reader.Read())
        Console.WriteLine($"Answer: {reader.Value}");
}
`,
  },
  {
    id: 'json-dom',
    name: 'Read-only JSON',
    source: `using System;
using System.Text.Json;

using var document = JsonDocument.Parse("""
    {"name":"Ada","age":29,"tags":["math","code"]}
    """);
var person = document.RootElement;

Console.WriteLine($"Name: {person.GetProperty("name").GetString()}");
Console.WriteLine($"Age: {person.GetProperty("age").GetInt32()}");
Console.WriteLine($"Tags: {person.GetProperty("tags").GetArrayLength()}");
`,
  },
  {
    id: 'json-generated',
    name: 'Source-generated JSON (serialize)',
    source: `using System;
using System.Text.Json;
using System.Text.Json.Serialization;

var message = new Message { Name = "Ada", Score = 42 };
string json = JsonSerializer.Serialize(message, MessageJsonContext.Default.Message);
Console.WriteLine(json);

public sealed class Message
{
    public string Name { get; set; } = "";
    public int Score { get; set; }
}

[JsonSourceGenerationOptions(GenerationMode = JsonSourceGenerationMode.Serialization)]
[JsonSerializable(typeof(Message))]
public partial class MessageJsonContext : JsonSerializerContext { }
`,
  },
  {
    id: 'regex',
    name: 'Regular expressions',
    source: `using System;
using System.Text.RegularExpressions;

var pattern = new Regex(@"(?<name>[A-Za-z]+):(?<score>[0-9]+)");
string input = "Ada:42, Grace:99";

foreach (Match match in pattern.Matches(input))
{
    Console.WriteLine($"{match.Groups["name"].Value}: {match.Groups["score"].Value}");
}

Console.WriteLine(pattern.Replace(input, "\${name} scored \${score}"));
`,
  },
  {
    id: 'di',
    name: 'Dependency injection',
    source: `using System;
using Microsoft.Extensions.DependencyInjection;

var services = new ServiceCollection();
services.AddSingleton<IGreeting, Greeting>();
services.AddTransient<Greeter>();

using var provider = services.BuildServiceProvider();
var greeter = provider.GetRequiredService<Greeter>();
greeter.SayHello("Ada");

public interface IGreeting
{
    string Format(string name);
}

public sealed class Greeting : IGreeting
{
    public string Format(string name) => $"Hello, {name}!";
}

public sealed class Greeter
{
    private readonly IGreeting greeting;
    public Greeter(IGreeting greeting) => this.greeting = greeting;
    public void SayHello(string name) => Console.WriteLine(greeting.Format(name));
}
`,
  },
  {
    id: 'hashing',
    name: 'CRC32 hashing',
    source: `using System;
using System.IO.Hashing;
using System.Text;

byte[] data = Encoding.UTF8.GetBytes("123456789");
uint checksum = Crc32.HashToUInt32(data);
Console.WriteLine($"CRC32: {checksum:X8}");
`,
  },
  {
    id: 'tunit',
    name: 'TUnit tests',
    source: `using System.Threading.Tasks;

using TUnit.Assertions;
using TUnit.Core;

namespace NetWasmTUnitTests;

public sealed class Tests
{
    [Test]
    [Category("smoke")]
    public async Task AnswerIsFortyTwo()
    {
        var answer = 6 * 7;

        await Assert.That(answer).IsEqualTo(42);
    }
}
`,
  },
];
