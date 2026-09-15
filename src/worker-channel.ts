export class WorkerChannel {
  private worker?: Worker;
  private sequence = 0;
  private generation = 0;
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  constructor(private url: URL, private signal: (data: any) => void) {}
  request(payload: object, transfers: Transferable[] = [], timeout = 120_000): Promise<any> {
    if (!this.worker) {
      const generation = this.generation;
      this.worker = new Worker(this.url, { type: 'module' });
      this.worker.onmessage = ({ data }) => {
        if (generation !== this.generation) return;
        const call = this.pending.get(data.id);
        if (!call) return;
        if (data.stage || data.console || data.assets || data.guestEntered || data.started || data.toolEntered) { this.signal(data); return; }
        clearTimeout(call.timer); this.pending.delete(data.id);
        data.error ? call.reject(new Error(String(data.error))) : call.resolve(data.result);
      };
      this.worker.onerror = event => this.reset(new Error(event.message));
      this.worker.onmessageerror = () => this.reset(new Error('Invalid worker response'));
    }
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.reset(new Error('Browser stage timeout')), timeout);
      this.pending.set(id, { resolve, reject, timer });
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
