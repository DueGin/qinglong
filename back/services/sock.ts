import { Service, Inject } from 'typedi';
import winston from 'winston';
import { Connection } from 'sockjs';
import { SockMessage } from '../data/sock';
import { shareStore } from '../shared/store';
import LockService from './lock';

@Service()
export default class SockService {
  private clients: Connection[] = [];
  private clientIdMap = new Map<Connection, string>(); // 连接到clientId的映射

  constructor(
    @Inject('logger') private logger: winston.Logger,
    private lockService: LockService,
  ) {}

  public getClients() {
    return this.clients;
  }

  public addClient(conn: Connection, clientId?: string) {
    if (this.clients.indexOf(conn) === -1) {
      this.clients.push(conn);
      if (clientId) {
        this.clientIdMap.set(conn, clientId);
      }
    }
  }

  public removeClient(conn: Connection) {
    const index = this.clients.indexOf(conn);
    if (index !== -1) {
      this.clients.splice(index, 1);
      this.clientIdMap.delete(conn);
    }
  }

  public handleMessage(
    conn: Connection,
    data: any,
    clientId: string,
    username: string,
  ) {
    const { type, filePath } = data;

    switch (type) {
      case 'acquireLock':
        if (filePath && clientId) {
          const success = this.lockService.acquire(filePath, clientId, username);
          const lockInfo = this.lockService.getLockInfo(filePath);
          
          // 回复当前客户端
          conn.write(
            JSON.stringify({
              type: success ? 'lockAcquired' : 'lockFailed',
              filePath,
              success,
              lockInfo,
            }),
          );

          // 广播锁状态更新
          this.broadcastLockStatus();
        }
        break;

      case 'releaseLock':
        if (filePath && clientId) {
          this.lockService.release(filePath, clientId);
          
          // 回复当前客户端
          conn.write(
            JSON.stringify({
              type: 'lockReleased',
              filePath,
              success: true,
            }),
          );

          // 广播锁状态更新
          this.broadcastLockStatus();
        }
        break;

      default:
        // 默认行为：回显原消息
        conn.write(JSON.stringify(data));
        break;
    }
  }

  public broadcastLockStatus() {
    const locks = this.lockService.getAllLocks();
    this.sendMessage(
      new SockMessage({
        type: 'lockStatus',
        locks,
      }),
    );
  }

  public sendMessage(msg: SockMessage) {
    if (msg.type === 'manuallyRunScript') {
      shareStore.getAuthInfo().then((authInfo) => {
        const needSendClients = this.clients.filter((c) => {
          const headerToken = c.url.replace(`${c.pathname}?token=`, '');
          return headerToken === msg.token;
        });
        needSendClients.forEach((x) => x.write(JSON.stringify(msg)));
      });
      return;
    }

    this.clients.forEach((x) => {
      x.write(JSON.stringify(msg));
    });
  }
}
