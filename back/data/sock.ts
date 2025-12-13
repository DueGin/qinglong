export interface LockInfo {
  clientId: string;
  username: string;
  filePath: string;
  timestamp: number;
}

export class SockMessage {
  message?: string;
  type?: SockMessageType;
  references?: number[];
  token?: string;
  clientId?: string;
  filePath?: string;
  oldFilePath?: string;
  newFilePath?: string;
  lockInfo?: LockInfo;
  locks?: LockInfo[];
  success?: boolean;

  constructor(options: SockMessage) {
    this.type = options.type;
    this.message = options.message;
    this.references = options.references;
    this.token = options.token;
    this.clientId = options.clientId;
    this.filePath = options.filePath;
    this.oldFilePath = options.oldFilePath;
    this.newFilePath = options.newFilePath;
    this.lockInfo = options.lockInfo;
    this.locks = options.locks;
    this.success = options.success;
  }
}

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
