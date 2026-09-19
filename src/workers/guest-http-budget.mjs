// The Preview 2 browser shim buffers outgoing request bodies until finish().
// Meter its backing stream before it copies guest bytes into host memory.
export function installGuestHttpBudget(httpModule, onDenied = () => {}, maximumBytes = 8 * 1048576) {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) throw Error('Invalid guest HTTP byte limit');
  const body = httpModule?.types?.OutgoingBody?.prototype;
  if (!body || typeof body.write !== 'function') throw Error('Unsupported browser HTTP body provider');
  const originalWrite = body.write;
  let used = 0;
  body.write = function (...args) {
    const stream = originalWrite.apply(this, args);
    const handler = stream?.handler;
    if (!handler || typeof handler.write !== 'function')
      throw Error('Unsupported browser HTTP output stream');
    const write = handler.write;
    handler.write = function (bytes) {
      const length = bytes?.byteLength;
      if (!Number.isSafeInteger(length) || length < 0) throw Error('Invalid guest HTTP body bytes');
      if (length > maximumBytes - used) {
        const message = `Guest HTTP request body limit exceeded (${maximumBytes} bytes per run)`;
        onDenied(message);
        throw Error(message);
      }
      used += length;
      return write.call(this, bytes);
    };
    return stream;
  };
  return () => { body.write = originalWrite; };
}
