import sockJs from 'sockjs';
import { Server } from 'http';
import { Container } from 'typedi';
import SockService from '../services/sock';
import { getPlatform } from '../config/util';
import { shareStore } from '../shared/store';
import { isValidToken } from '../shared/auth';
import LockService from '../services/lock';
import url from 'url';

export default async ({ server }: { server: Server }) => {
  const echo = sockJs.createServer({ prefix: '/api/ws', log: () => {} });
  const sockService = Container.get(SockService);
  const lockService = Container.get(LockService);

  echo.on('connection', async (conn) => {
    if (!conn.headers || !conn.url || !conn.pathname) {
      conn.close('404');
    }

    const authInfo = await shareStore.getAuthInfo();
    const platform = getPlatform(conn.headers['user-agent'] || '') || 'desktop';
    
    // 解析 URL 参数获取 token 和 clientId
    const parsedUrl = url.parse(conn.url, true);
    const headerToken = parsedUrl.query.token as string;
    const clientId = parsedUrl.query.clientId as string;

    if (isValidToken(authInfo, headerToken, platform)) {
      sockService.addClient(conn, clientId);

      conn.on('data', (message) => {
        try {
          const data = JSON.parse(message);
          sockService.handleMessage(conn, data, clientId, authInfo?.username || 'unknown');
        } catch (error) {
          conn.write(message);
        }
      });

      conn.on('close', function () {
        // 释放该客户端持有的所有锁
        if (clientId) {
          const releasedFiles = lockService.releaseByClient(clientId);
          if (releasedFiles.length > 0) {
            // 广播锁状态更新
            sockService.broadcastLockStatus();
          }
        }
        sockService.removeClient(conn);
      });

      // 发送当前所有锁的状态
      const locks = lockService.getAllLocks();
      conn.write(JSON.stringify({
        type: 'lockStatus',
        locks: locks,
      }));

      return;
    }

    conn.close('404');
  });

  echo.installHandlers(server);
};
