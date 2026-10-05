export class WorkerRegistry {
  constructor() {
    this.workers = new Map();
  }

  register(worker) {
    if (!worker.id) throw new Error('Worker must have an id');
    this.workers.set(worker.id, worker);
  }

  getWorker(workerId) {
    return this.workers.get(workerId);
  }

  getAll() {
    return Array.from(this.workers.values());
  }
}
