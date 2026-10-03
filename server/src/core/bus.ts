export type BusEvent =
  | { type: 'new-message'; agentId: string }
  | { type: 'receipt'; agentId: string; messageIds: string[] }
  | { type: 'task-update'; agentId: string; taskId: string }
  | { type: 'presence'; agentId: string }
  | { type: 'market'; agentId: string; evt: string; ref: string }

export class Bus {
  private handlers = new Set<(e: BusEvent) => void>()
  private waiters: { agentId: string; types: Set<string>; resolve: (v: boolean) => void; timer: NodeJS.Timeout }[] = []
  emit(e: BusEvent): void {
    for (const h of this.handlers) h(e)
    this.waiters = this.waiters.filter(w => {
      if (w.agentId === e.agentId && w.types.has(e.type)) { clearTimeout(w.timer); w.resolve(true); return false }
      return true
    })
  }
  on(h: (e: BusEvent) => void): () => void { this.handlers.add(h); return () => this.handlers.delete(h) }
  waitFor(agentId: string, types: BusEvent['type'][], timeoutMs: number): Promise<boolean> {
    return new Promise(resolve => {
      const w = { agentId, types: new Set<string>(types), resolve,
        timer: setTimeout(() => { this.waiters = this.waiters.filter(x => x !== w); resolve(false) }, timeoutMs) }
      this.waiters.push(w)
    })
  }
}
