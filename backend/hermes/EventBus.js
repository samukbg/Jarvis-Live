import { EventEmitter } from 'events';

export class EventBus extends EventEmitter {
  emitEvent(event) {
    if (!event.taskId) {
      console.error('[EventBus] Emitted event without taskId:', event);
      return;
    }
    // Emit to specific task subscribers
    super.emit(event.taskId, event);
    // Emit to global subscribers
    super.emit('*', event);
  }

  onTask(taskId, handler) {
    super.on(taskId, handler);
    return () => super.off(taskId, handler); // Unsubscribe function
  }

  onAll(handler) {
    super.on('*', handler);
    return () => super.off('*', handler);
  }
}
