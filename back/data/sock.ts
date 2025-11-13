export class SockMessage {
  message?: string;
  type?: SockMessageType;
  references?: number[];
  token?: string;

  constructor(options: SockMessage) {
    this.type = options.type;
    this.message = options.message;
    this.references = options.references;
    this.token = options.token;
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
  | 'updateLinuxMirror';
