export interface LocalTranslateStatus {
  enabled: boolean;
  reachable: boolean;
  shortcut: string;
}

type StatusListener = (status: LocalTranslateStatus) => void;

const listeners = new Set<StatusListener>();
let currentStatus: LocalTranslateStatus = {
  enabled: false,
  reachable: false,
  shortcut: 'cmdEnter',
};

export function getLocalTranslateStatus(): LocalTranslateStatus {
  return currentStatus;
}

export function setLocalTranslateStatus(status: LocalTranslateStatus): void {
  currentStatus = status;
  listeners.forEach((fn) => {
    try {
      fn(status);
    } catch (e) {
      console.warn('[LocalTranslateStatus] listener failed', e);
    }
  });
}

export function subscribeLocalTranslateStatus(fn: StatusListener): () => void {
  listeners.add(fn);
  fn(currentStatus);
  return () => {
    listeners.delete(fn);
  };
}
