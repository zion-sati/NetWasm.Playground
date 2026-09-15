// Called only after WebAssembly.compile has validated the core module.
export function checkGuestMemory(bytes, maximumBytes = 256 * 1048576) {
  let cursor = 8;
  const read = end => {
    let value = 0, shift = 0;
    for (let count = 0; count < 5 && cursor < end; count++) {
      const byte = bytes[cursor++]; value += (byte & 127) * 2 ** shift;
      if (!(byte & 128)) return value;
      shift += 7;
    }
    throw Error('Invalid guest memory encoding');
  };
  const memories = [];
  while (cursor < bytes.length) {
    const section = bytes[cursor++]; const length = read(bytes.length); const end = cursor + length;
    if (end > bytes.length) throw Error('Invalid guest core section');
    if (section === 5) {
      const count = read(end);
      for (let index = 0; index < count; index++) {
        const flags = read(end);
        if (flags !== 1) throw Error('Guest memory requires an explicit unshared wasm32 maximum');
        const initialPages = read(end), maximumPages = read(end);
        if (maximumPages * 65536 > maximumBytes) throw Error('Guest memory limit exceeded (256 MiB)');
        memories.push({ initialPages, maximumPages });
      }
      if (cursor !== end) throw Error('Invalid guest memory section');
    }
    cursor = end;
  }
  return memories;
}
