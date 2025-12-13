import { useEffect, useState, useCallback, useRef } from 'react';
import { message } from 'antd';
import intl from 'react-intl-universal';
import WebSocketManager from '@/utils/websocket';
import { getClientId } from '@/utils/clientId';
import { LockInfo } from '@/utils/type';

interface UseFileLockOptions {
  filePath?: string;
  onLockAcquired?: () => void;
  onLockFailed?: (lockInfo: LockInfo) => void;
  onLockLost?: (lockInfo: LockInfo) => void;
}

export function useFileLock(options: UseFileLockOptions) {
  const { filePath, onLockAcquired, onLockFailed, onLockLost } = options;
  const [isLocked, setIsLocked] = useState(false);
  const [lockInfo, setLockInfo] = useState<LockInfo | null>(null);
  const [isReadOnly, setIsReadOnly] = useState(false);
  const clientId = getClientId();
  const ws = useRef<WebSocketManager | null>(null);

  // 尝试获取锁
  const acquireLock = useCallback(() => {
    if (!filePath) return;

    ws.current = WebSocketManager.getInstance();
    ws.current.send({
      type: 'acquireLock',
      filePath,
      clientId,
    });
  }, [filePath, clientId]);

  // 释放锁
  const releaseLock = useCallback(() => {
    if (!filePath) return;

    ws.current = WebSocketManager.getInstance();
    ws.current.send({
      type: 'releaseLock',
      filePath,
      clientId,
    });

    setIsLocked(false);
    setIsReadOnly(false);
    setLockInfo(null);
  }, [filePath, clientId]);

  // 处理锁获取成功
  const handleLockAcquired = useCallback(
    (payload: any) => {
      if (payload.filePath === filePath && payload.success) {
        setIsLocked(true);
        setIsReadOnly(false);
        setLockInfo(null);
        message.success(intl.get('已获取文件编辑权限'));
        onLockAcquired?.();
      }
    },
    [filePath, onLockAcquired],
  );

  // 处理锁获取失败
  const handleLockFailed = useCallback(
    (payload: any) => {
      if (payload.filePath === filePath && !payload.success) {
        setIsLocked(false);
        setIsReadOnly(true);
        setLockInfo(payload.lockInfo);
        message.warning(
          intl.get('文件正在被用户 {username} 编辑，已切换为只读模式', {
            username: payload.lockInfo?.username,
          }),
        );
        onLockFailed?.(payload.lockInfo);
      }
    },
    [filePath, onLockFailed],
  );

  // 处理锁释放成功
  const handleLockReleased = useCallback(
    (payload: any) => {
      if (payload.filePath === filePath) {
        setIsLocked(false);
        setIsReadOnly(false);
        setLockInfo(null);
      }
    },
    [filePath],
  );

  // 处理全局锁状态更新
  const handleLockStatus = useCallback(
    (payload: any) => {
      if (!filePath || !payload.locks) return;

      const currentFileLock = payload.locks.find(
        (lock: LockInfo) => lock.filePath === filePath,
      );

      if (currentFileLock) {
        // 文件被锁定
        if (currentFileLock.clientId === clientId) {
          // 被当前客户端锁定
          setIsLocked(true);
          setIsReadOnly(false);
          setLockInfo(null);
        } else {
          // 被其他客户端锁定
          setIsLocked(false);
          setIsReadOnly(true);
          setLockInfo(currentFileLock);
          message.warning(
            intl.get('文件正在被用户 {username} 编辑，已切换为只读模式', {
              username: currentFileLock.username,
            }),
          );
          onLockLost?.(currentFileLock);
        }
      } else {
        // 文件未被锁定
        setIsLocked(false);
        setIsReadOnly(false);
        setLockInfo(null);
      }
    },
    [filePath, clientId, onLockLost],
  );

  useEffect(() => {
    if (!filePath) return;

    ws.current = WebSocketManager.getInstance();

    // 订阅锁相关消息
    ws.current.subscribe('lockAcquired', handleLockAcquired);
    ws.current.subscribe('lockFailed', handleLockFailed);
    ws.current.subscribe('lockReleased', handleLockReleased);
    ws.current.subscribe('lockStatus', handleLockStatus);

    // 尝试获取锁
    acquireLock();

    return () => {
      // 清理订阅
      ws.current?.unsubscribe('lockAcquired', handleLockAcquired);
      ws.current?.unsubscribe('lockFailed', handleLockFailed);
      ws.current?.unsubscribe('lockReleased', handleLockReleased);
      ws.current?.unsubscribe('lockStatus', handleLockStatus);

      // 释放锁
      releaseLock();
    };
  }, [
    filePath,
    acquireLock,
    releaseLock,
    handleLockAcquired,
    handleLockFailed,
    handleLockReleased,
    handleLockStatus,
  ]);

  return {
    isLocked,
    isReadOnly,
    lockInfo,
    acquireLock,
    releaseLock,
  };
}
