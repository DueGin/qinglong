import { Service, Inject } from 'typedi';
import winston from 'winston';
import { Connection } from 'sockjs';
import { SockMessage } from '../data/sock';
import { shareStore } from '../shared/store';

@Service()
export default class SockService {
  private clients: Connection[] = [];

  constructor(@Inject('logger') private logger: winston.Logger) {}

  public getClients() {
    return this.clients;
  }

  public addClient(conn: Connection) {
    if (this.clients.indexOf(conn) === -1) {
      this.clients.push(conn);
    }
  }

  public removeClient(conn: Connection) {
    const index = this.clients.indexOf(conn);
    if (index !== -1) {
      this.clients.splice(index, 1);
    }
  }

  public sendMessage(msg: SockMessage) {
    if (msg.type === 'manuallyRunScript') {
      shareStore.getAuthInfo().then(authInfo => {
        const needSendClients = this.clients.filter(c => {
          const headerToken = c.url.replace(`${c.pathname}?token=`, '');
          return headerToken === msg.token;
        });
        needSendClients.forEach((x) => x.write(JSON.stringify(msg)));
      })
      return;
    }

    this.clients.forEach((x) => {
      x.write(JSON.stringify(msg));
    });
  }
}
