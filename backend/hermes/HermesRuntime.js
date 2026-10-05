import { EventBus } from './EventBus.js';
import crypto from 'crypto';

export class HermesRuntime {
  constructor(workerRegistry, capabilityRegistry) {
    this.eventBus = new EventBus();
    this.taskMap = new Map();
    this.workerRegistry = workerRegistry;
    this.capabilityRegistry = capabilityRegistry;
  }

  async submitTask(goal, priority = 'MEDIUM', forceWorker = null) {
    const taskId = crypto.randomUUID();
    const cancelToken = new AbortController();
    
    const task = {
      taskId,
      goal,
      status: 'CREATED',
      priority,
      progress: 0,
      created: Date.now(),
      updated: Date.now(),
      cancelToken
    };
    
    this.taskMap.set(taskId, task);
    this.eventBus.emitEvent({ type: 'TaskCreated', taskId, timestamp: Date.now() });

    // Execution starts asynchronously
    this.executeTask(task, forceWorker).catch(e => {
      task.status = 'FAILED';
      this.eventBus.emitEvent({ type: 'TaskFailed', taskId, timestamp: Date.now(), payload: { error: e.message } });
    });

    return task;
  }

  async executeTask(task, forceWorkerId) {
    task.status = 'WORKING';
    this.eventBus.emitEvent({ type: 'TaskStarted', taskId: task.taskId, timestamp: Date.now() });

    let workerId = forceWorkerId;
    if (!workerId && this.capabilityRegistry) {
      const candidates = this.capabilityRegistry.findWorkers(task.goal);
      if (candidates.length > 0) workerId = candidates[0];
    }
    
    if (!workerId) {
      throw new Error('No capable worker found for goal: ' + task.goal);
    }

    task.worker = workerId;
    const worker = this.workerRegistry.getWorker(workerId);
    
    if (!worker) {
      throw new Error('Worker not registered: ' + workerId);
    }

    this.eventBus.emitEvent({ type: 'WorkerStarted', taskId: task.taskId, timestamp: Date.now(), payload: { worker: workerId } });

    try {
      const iterator = worker.execute(task.goal, task);
      
      for await (const event of iterator) {
        if (task.cancelToken.signal.aborted) {
          await worker.cancel(task);
          return;
        }
        
        task.updated = Date.now();
        if (event.type === 'Progress') task.progress = event.payload.progress;
        if (event.type === 'PartialResult') task.result = event.payload.result;
        
        // Pass through the event via EventBus
        this.eventBus.emitEvent(event);
      }

      if (task.cancelToken.signal.aborted) return;
      
      task.status = 'COMPLETED';
      task.progress = 100;
      this.eventBus.emitEvent({ 
        type: 'TaskCompleted', 
        taskId: task.taskId, 
        timestamp: Date.now(), 
        payload: { result: task.result } 
      });
      
    } catch (err) {
      if (!task.cancelToken.signal.aborted) {
        throw err;
      }
    }
  }

  async cancelTask(taskId) {
    const task = this.taskMap.get(taskId);
    if (!task) return;
    
    task.cancelToken.abort();
    task.status = 'CANCELLED';
    this.eventBus.emitEvent({ type: 'TaskCancelled', taskId, timestamp: Date.now() });
  }

  queryTask(taskId) {
    return this.taskMap.get(taskId);
  }

  subscribe(taskId, handler) {
    return this.eventBus.onTask(taskId, handler);
  }

  subscribeAll(handler) {
    return this.eventBus.onAll(handler);
  }
}
