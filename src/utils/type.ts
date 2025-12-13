export type SockMessageType =
  | 'ping'
  | 'installDependence'
  | 'uninstallDependence'
  | 'updateSystemVersion'
  | 'manuallyRunScript'
  | 'runSubscriptionEnd'
  | 'reloadSystem'
  | 'updateNodeMirror'
  | 'updateLinuxMirror'
  | 'acquireLock'
  | 'releaseLock'
  | 'scriptDeleted'
  | 'scriptRenamed'
  | 'scriptUpdated'
  | 'lockStatus'
  | 'lockAcquired'
  | 'lockReleased'
  | 'lockFailed';

export interface LockInfo {
  clientId: string;
  username: string;
  filePath: string;
  timestamp: number;
}
