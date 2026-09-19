import { chromium } from 'playwright';

const source = `using System;
using System.IO;
using System.Net.Http;
using System.Threading.Tasks;

public static class Program
{
    public static async Task<int> Main()
    {
        string address = Environment.GetEnvironmentVariable("PLAYGROUND_HTTP_SAMPLE_URL")
            ?? throw new Exception("missing URL");
        using var client = new HttpClient();
        using var content = new StreamContent(new RepeatingStream(9 * 1048576));
        using var response = await client.PostAsync(new Uri(address), content);
        Console.WriteLine((int)response.StatusCode);
        return 0;
    }
}

public sealed class RepeatingStream : Stream
{
    private long remaining;
    public RepeatingStream(long bytes) { remaining = bytes; }
    public override bool CanRead => true;
    public override bool CanSeek => false;
    public override bool CanWrite => false;
    public override long Length => throw new NotSupportedException();
    public override long Position
    {
        get => throw new NotSupportedException();
        set => throw new NotSupportedException();
    }
    public override int Read(byte[] buffer, int offset, int count)
    {
        int length = (int)Math.Min(remaining, (long)count);
        Array.Clear(buffer, offset, length);
        remaining -= length;
        return length;
    }
    public override void Flush() { }
    public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
    public override void SetLength(long length) => throw new NotSupportedException();
    public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
}
`;

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  const errors = [], uploads = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    if (new URL(request.url()).pathname.endsWith('/example-http.json') && request.method() !== 'GET')
      uploads.push(request.method());
  });
  await page.goto(process.env.PLAYGROUND_URL ?? 'http://127.0.0.1:4173/');
  await page.locator('#optimization').selectOption('none');
  await page.locator('#example').selectOption('http');
  await page.locator('#editor .view-lines').click({ position: { x: 80, y: 12 } });
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.insertText(source);
  await page.locator('#run').click();
  await page.waitForFunction(() => document.querySelector('#stop').disabled, undefined, { timeout: 240_000 });
  const denied = await page.locator('#status').textContent();
  if (!denied.includes('Guest HTTP request body limit exceeded') || uploads.length)
    throw Error(`HTTP byte limit did not deny the request: ${JSON.stringify({ denied, uploads })}`);

  await page.locator('#example').selectOption('hello');
  await page.locator('#run').click();
  await page.waitForFunction(() => document.querySelector('#stop').disabled, undefined, { timeout: 240_000 });
  const status = await page.locator('#status').textContent();
  const output = await page.locator('#output').textContent();
  if (status !== 'Run complete' || output !== '42\n' || errors.length)
    throw Error(`Guest did not recover: ${JSON.stringify({ status, output, errors })}`);
  console.log('PASS browser HTTP body limit, denied upload and successful next run');
} finally { await browser.close(); }
