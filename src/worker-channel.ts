export class WorkerChannel {
  private worker?: Worker;
  private sequence = 0;
  private generation = 0;
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout>; executionTimeout?: number; entered?: boolean }>();
  constructor(private url: URL, private signal: (data: any) => void) {}
  request(payload: object, transfers: Transferable[] = [], timeout = 120_000, executionTimeout?: number): Promise<any> {
    if (!this.worker) {
      const generation = this.generation;
      // Blob workers inherit the page's CSP, including its network policy.
      const bootstrap = URL.createObjectURL(new Blob([`import ${JSON.stringify(this.url.href)};`], { type: 'text/javascript' }));
      try { this.worker = new Worker(bootstrap, { type: 'module' }); }
      finally { URL.revokeObjectURL(bootstrap); }
      this.worker.onmessage = ({ data }) => {
        if (generation !== this.generation) return;
        const call = this.pending.get(data.id);
        if (!call) return;
        if (data.guestEntered && call.executionTimeout && !call.entered) {
          call.entered = true; clearTimeout(call.timer);
          call.timer = setTimeout(() => this.reset(new Error('Guest execution time limit exceeded')), call.executionTimeout);
        }
        if (data.stage || data.console || data.assets || data.guestEntered || data.started || data.toolEntered) { this.signal(data); return; }
        clearTimeout(call.timer); this.pending.delete(data.id);
        data.error ? call.reject(new Error(String(data.error))) : call.resolve(data.result);
      };
      this.worker.onerror = event => this.reset(new Error(event.message || 'Worker failed without an error message'));
      this.worker.onmessageerror = () => this.reset(new Error('Invalid worker response'));
    }
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.reset(new Error('Browser stage timeout')), timeout);
      this.pending.set(id, { resolve, reject, timer, executionTimeout });
      try { this.worker!.postMessage({ ...payload, id }, transfers); }
      catch (error) { this.reset(error instanceof Error ? error : new Error(String(error))); }
    });
  }
  reset(reason = new Error('Stopped')): void {
    this.generation++; this.worker?.terminate(); this.worker = undefined;
    for (const call of this.pending.values()) { clearTimeout(call.timer); call.reject(reason); }
    this.pending.clear();
  }
}
