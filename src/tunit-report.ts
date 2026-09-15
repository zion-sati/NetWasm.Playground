// Wire format: pinned NetWasm.TUnit.Runner ConsoleTestEventSink, protocol v2.
export interface TestReport { text: string; passed: number; failed: number }
export function formatTestReport(output: string): TestReport {
  const names = new Map<string, string>();
  const lines: string[] = [];
  let version = false, totals: { passed: number; failed: number } | undefined;
  const decode = (value: string) => value.replace(/%(25|7C|0D|0A)/g, (_, escape: string) => ({ '25': '%', '7C': '|', '0D': '\r', '0A': '\n' })[escape]!);
  const integer = (value: string) => { if (!/^\d+$/.test(value) || Number(value) > 200) throw Error('Invalid TUnit test count'); return Number(value); };
  for (const line of output.split(/\r?\n/)) {
    if (!line.startsWith('NWTUNIT|')) { if (line) lines.push(line); continue; }
    const fields = line.slice(8).split('|').map(decode);
    const [kind, ...values] = fields;
    const arity = ({ 'protocol-version': 1, 'run-started': 1, 'test-started': 2, 'test-completed': 4, 'run-completed': 3, catalog: 5, trait: 3, 'host-result': 2 } as Record<string, number>)[kind];
    if (arity === undefined || values.length !== arity) throw Error('Invalid TUnit protocol record');
    if (kind === 'protocol-version') { if (version || values[0] !== '2') throw Error('Unsupported TUnit protocol version'); version = true; continue; }
    if (!version) throw Error('Missing TUnit protocol version');
    if (kind === 'test-started') { if (names.size >= 200 || names.has(values[0])) throw Error('Invalid TUnit test start'); names.set(values[0], values[1]); }
    if (kind === 'test-completed') {
      const name = names.get(values[0]);
      if (!name || !['passed', 'assertion-failed', 'unexpected-failure', 'unsupported', 'cancelled'].includes(values[1])) throw Error('Invalid TUnit test result');
      lines.push(`${values[1] === 'passed' ? 'PASS' : 'FAIL'} ${name}${values[3] ? `\n  ${values[3]}` : ''}`);
    }
    if (kind === 'run-completed') { if (totals) throw Error('Duplicate TUnit totals'); totals = { passed: integer(values[0]), failed: integer(values[1]) }; }
  }
  if (!version || !totals) throw Error('Incomplete TUnit test report');
  lines.push(`${totals.passed} passed · ${totals.failed} failed`);
  return { text: lines.join('\n') + '\n', ...totals };
}
