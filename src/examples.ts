export interface ExampleRecipe {
  id: string;
  name: string;
  source: string;
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
