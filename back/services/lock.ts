import { Service } from 'typedi';
import path from 'path';
import config from '../config';

interface LockInfo {
  clientId: string; // 持有锁的客户端唯一标识
  username: string; // 持有锁的用户名（用于前端提示"xxx正在编辑"）
  filePath: string; // 被锁定的文件路径
  timestamp: number; // 锁定时间
}

@Service()
export default class LockService {
  private locks = new Map<string, LockInfo>();

  private getServerBase(): string {
    return path.posix
      .normalize((config.scriptPath || '').replace(/\\/g, '/'))
      .replace(/\/+$/, '');
  }

  private getClientBase(): string {
    return '/ql/data/scripts';
  }

  private normalizeFilePath(filePath: string): string {
    if (!filePath) return filePath;

    const normalizedInput = path.posix.normalize(filePath.replace(/\\/g, '/'));

    const clientBase = this.getClientBase();
    const serverBase = this.getServerBase();

    if (serverBase && normalizedInput.startsWith(clientBase)) {
      const suffix = normalizedInput.slice(clientBase.length);
      return path.posix.normalize(`${serverBase}${suffix}`);
    }

    return normalizedInput;
  }

  private presentFilePathFromKey(normalizedKey: string): string {
    if (!normalizedKey) return normalizedKey;

    const serverBase = this.getServerBase();
    const clientBase = this.getClientBase();

    if (serverBase && normalizedKey.startsWith(serverBase)) {
      const suffix = normalizedKey.slice(serverBase.length);
      return path.posix.normalize(`${clientBase}${suffix}`);
    }

    return normalizedKey;
  }

  private getLockByAnyKey(filePath: string): { key: string; lock: LockInfo } | null {
    const normalized = this.normalizeFilePath(filePath);

    const direct = this.locks.get(normalized);
    if (direct) {
      return { key: normalized, lock: direct };
    }

    const legacy = this.locks.get(filePath);
    if (legacy) {
      // migrate legacy key to normalized key
      this.locks.delete(filePath);
      this.locks.set(normalized, legacy);
      legacy.filePath = this.presentFilePathFromKey(normalized);
      return { key: normalized, lock: legacy };
    }

    return null;
  }

  /**
   * 尝试获取锁
   * @param filePath 文件路径
   * @param clientId 客户端ID
   * @param username 用户名
   * @returns true=获取成功, false=已被他人锁定
   */
  public acquire(filePath: string, clientId: string, username: string): boolean {
    const key = this.normalizeFilePath(filePath);
    const found = this.getLockByAnyKey(key);
    const lock = found?.lock;
    
    // 1. 无锁 -> 成功
    if (!lock) {
      this.locks.set(key, {
        clientId,
        username,
        filePath: this.presentFilePathFromKey(key),
        timestamp: Date.now(),
      });
      return true;
    }

    // 2. 已被自己锁定 (重入) -> 成功
    if (lock.clientId === clientId) {
      // 更新时间戳
      lock.timestamp = Date.now();
      return true;
    }

    // 3. 被他人锁定 -> 失败
    return false;
  }

  /**
   * 释放锁
   * @param filePath 文件路径
   * @param clientId 客户端ID
   */
  public release(filePath: string, clientId: string): void {
    const found = this.getLockByAnyKey(filePath);
    const lock = found?.lock;
    if (lock && lock.clientId === clientId) {
      this.locks.delete(found!.key);
    }
  }

  /**
   * 客户端断开时，清理其所有锁
   * @param clientId 客户端ID
   * @returns 被释放的文件路径列表
   */
  public releaseByClient(clientId: string): string[] {
    const releasedFiles: string[] = [];
    for (const [path, lock] of this.locks.entries()) {
      if (lock.clientId === clientId) {
        this.locks.delete(path);
        releasedFiles.push(path);
      }
    }
    return releasedFiles;
  }

  /**
   * 检查是否被锁定（用于 API 守卫）
   * @param filePath 文件路径
   * @param clientId 客户端ID
   * @returns true=被他人锁定 (不可写), false=未锁或被自己锁定 (可写)
   */
  public isLocked(filePath: string, clientId: string): boolean {
    const found = this.getLockByAnyKey(filePath);
    const lock = found?.lock;
    if (!lock) return false;
    return lock.clientId !== clientId;
  }
  
  /**
   * 获取某个文件的锁信息
   * @param filePath 文件路径
   * @returns 锁信息或undefined
   */
  public getLockInfo(filePath: string): LockInfo | undefined {
    return this.getLockByAnyKey(filePath)?.lock;
  }

  /**
   * 获取当前所有锁信息（用于前端初始化状态）
   * @returns 所有锁信息数组
   */
  public getAllLocks(): LockInfo[] {
    return Array.from(this.locks.values());
  }

  /**
   * 清理超时锁（可选，用于防止死锁）
   * @param timeoutMs 超时时间（毫秒）
   * @returns 被清理的文件路径列表
   */
  public cleanupStaleLocks(timeoutMs: number = 24 * 60 * 60 * 1000): string[] {
    const now = Date.now();
    const staleFiles: string[] = [];
    
    for (const [path, lock] of this.locks.entries()) {
      if (now - lock.timestamp > timeoutMs) {
        this.locks.delete(path);
        staleFiles.push(path);
      }
    }
    
    return staleFiles;
  }
}
