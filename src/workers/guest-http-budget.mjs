// NetWasm's browser HTTP provider reads a request's whole body before fetch sends it.
// Meter the guest's body stream as the provider reads it, so a runaway body stops at the
// limit instead of filling the worker's memory.
const typesModule = 'wasi:http/types@0.3.2';

export function meterGuestHttpBodies({ modules, readGuestBytes, onDenied = () => {}, maximumBytes = 8 * 1048576 }) {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) throw Error('Invalid guest HTTP byte limit');
  if (typeof readGuestBytes !== 'function') throw Error('Invalid guest HTTP body reader');
  const types = modules?.[typesModule];
  const Request = types?.Request;
  if (typeof Request?.new !== 'function') throw Error('Unsupported browser HTTP provider');
  let used = 0;
  const meter = contents => contents === undefined ? undefined : Object.freeze({
    async *[Symbol.asyncIterator]() {
      const read = readGuestBytes(contents);
      for (let chunk = await read(); chunk !== null; chunk = await read()) {
        if (chunk.byteLength > maximumBytes - used) {
          const message = `Guest HTTP request body limit exceeded (${maximumBytes} bytes per run)`;
          onDenied(message);
          throw Error(message);
        }
        used += chunk.byteLength;
        yield chunk;
      }
    },
  });
  // jco checks a request the provider returns against the class it imported, so the
  // metered class shares the provider's prototype and keeps its other static methods.
  function MeteredRequest() { throw new TypeError('a request is created with Request.new'); }
  for (const name of Object.getOwnPropertyNames(Request))
    if (typeof Request[name] === 'function') MeteredRequest[name] = Request[name];
  MeteredRequest.prototype = Request.prototype;
  MeteredRequest.new = (headers, contents, trailers, options) =>
    Request.new(headers, meter(contents), trailers, options);
  return Object.freeze({ ...modules, [typesModule]: Object.freeze({ ...types, Request: MeteredRequest }) });
}
