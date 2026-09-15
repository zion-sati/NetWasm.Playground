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
];
