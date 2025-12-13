# 多端登录文件编辑互斥技术方案

## 1. 背景与目标
目前系统支持一个账号在多个设备或多个浏览器标签页登录。当多个用户（或同一用户的多个窗口）同时编辑或调试同一个脚本文件时，可能会发生相互覆盖或状态冲突的问题。

**目标**：实现文件级别的互斥锁机制。
- 当有人正在编辑或调试 A 文件时，其他在线用户（包括同一账号的其他端）不允许编辑或调试该文件。
- 其他用户对 A 文件处于“只读”状态。
- 只有当持有锁的用户退出编辑或调试（或断开连接）后，锁释放，其他用户才能操作。

## 2. 核心概念：Client ID
由于 HTTP 是无状态的，且同一用户（User ID 相同）可能开启多个标签页，仅靠 User ID 无法区分具体的“编辑端”。

**引入 Client ID (UUID)**：
- **前端**：在应用初始化（App 加载）时，为当前浏览器 Session 生成一个唯一的 UUID，称为 `clientId`。该 ID 存放在内存或 SessionStorage 中。
- **通信**：所有的 WebSocket 连接和 HTTP 请求都必须携带此 `clientId`，以便后端识别具体是哪个“端”在操作。

## 3. 总体架构

### 3.1 LockService (后端核心服务)
新建 `back/services/lock.ts`，用于维护内存中的文件锁状态。

**数据结构**：
```typescript
interface LockInfo {
  clientId: string; // 持有锁的客户端唯一标识
  username: string; // 持有锁的用户名（用于前端提示“xxx正在编辑”）
  filePath: string; // 被锁定的文件路径
  timestamp: number; // 锁定时间
}

// 使用 Map 存储：Key 为 filePath，Value 为 LockInfo
private locks = new Map<string, LockInfo>();
```

### 3.2 WebSocket (实时状态同步)
利用现有的 `sock` 机制（`back/loaders/sock.ts` 和 `back/services/sock.ts`）。
- **连接建立**：前端连接 WebSocket 时，在 Query 参数中携带 `clientId`。
- **断开连接**：当 Socket 断开（用户关闭标签页、刷新、断网）时，后端自动释放该 `clientId` 持有的所有锁。
- **信令交互**：
    - `acquire_lock`: 客户端申请锁定文件。
    - `release_lock`: 客户端主动释放锁（如关闭编辑窗口）。
    - `lock_status`: 后端向所有客户端广播锁的变化，以便前端实时置灰按钮。

### 3.3 HTTP API (操作拦截)
在涉及文件修改和运行的接口中，增加锁校验逻辑。
- **保存文件** (`POST /api/scripts`, `PUT /api/scripts`)
- **运行脚本** (`PUT /api/scripts/run`)

如果文件被其他 `clientId` 锁定，API 直接返回错误，拒绝操作。

## 4. 详细设计方案

### 4.1 前端改造
1.  **初始化**：在 `src/app.tsx` 或类似入口处，生成 `clientId`。
2.  **Socket 连接**：修改 WebSocket 初始化代码，URL 附加 `&clientId=xxx`。
3.  **HTTP 请求**：配置 Axios 拦截器，在所有请求头中添加 `x-client-id: xxx`。
4.  **编辑器逻辑**：
    - **进入编辑**：打开文件详情时，通过 Socket 发送 `acquire_lock`。
    - **锁定反馈**：
        - 成功：正常编辑。
        - 失败（已被锁）：编辑器设为只读模式（Read Only），并在顶部提示“用户 [Username] 正在编辑此文件”。
    - **退出编辑**：关闭文件 Tab 或切换文件时，发送 `release_lock`。
    - **监听广播**：监听 `lock_status` 事件。如果当前打开的文件被别人锁定了（极少见情况，如并发），立即切换为只读。

### 4.2 后端 LockService 实现 (`back/services/lock.ts`)

```typescript
import { Service } from 'typedi';

@Service()
export default class LockService {
  private locks = new Map<string, LockInfo>();

  /**
   * 尝试获取锁
   * @returns true=获取成功, false=已被他人锁定
   */
  public acquire(filePath: string, clientId: string, username: string): boolean {
    const lock = this.locks.get(filePath);
    
    // 1. 无锁 -> 成功
    if (!lock) {
      this.locks.set(filePath, { clientId, username, filePath, timestamp: Date.now() });
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
   */
  public release(filePath: string, clientId: string): void {
    const lock = this.locks.get(filePath);
    if (lock && lock.clientId === clientId) {
      this.locks.delete(filePath);
    }
  }

  /**
   * 客户端断开时，清理其所有锁
   */
  public releaseByClient(clientId: string): void {
    for (const [path, lock] of this.locks.entries()) {
      if (lock.clientId === clientId) {
        this.locks.delete(path);
      }
    }
  }

  /**
   * 检查是否被锁定（用于 API 守卫）
   * @returns true=被他人锁定 (不可写), false=未锁或被自己锁定 (可写)
   */
  public isLocked(filePath: string, clientId: string): boolean {
    const lock = this.locks.get(filePath);
    if (!lock) return false;
    return lock.clientId !== clientId;
  }
  
  /**
   * 获取当前所有锁信息（用于前端初始化状态）
   */
  public getAllLocks() {
    return Array.from(this.locks.values());
  }
}
```

### 4.3 Socket 层改造
**文件**: `back/loaders/sock.ts` & `back/services/sock.ts`

1.  **连接处理**：
    在 `wss.on('connection', ...)` 中，解析 `req.url` 获取 `clientId`。
    将 `clientId` 绑定到对应的 WebSocket 客户端实例上。

2.  **断开处理**：
    在 `ws.on('close')` 中，调用 `LockService.releaseByClient(clientId)`。
    如果有锁被释放，向所有在线客户端广播最新的锁列表。

3.  **消息处理**：
    新增处理 `type: 'acquire'` 和 `type: 'release'` 的消息。
    调用 `LockService` 对应方法，并将结果返回给当前客户端，同时广播给其他客户端。

### 4.4 API 层改造
**文件**: `back/api/script.ts` (以及其他涉及文件写的 API)

在 `saveScript` (保存) 和 `runScript` (调试) 方法中注入 `LockService`。

```typescript
// 伪代码示例
const lockService = Container.get(LockService);
const clientId = req.headers['x-client-id'] as string;
const { filename, path: dirPath } = req.body;
const filePath = path.join(dirPath, filename);

// 锁校验
if (lockService.isLocked(filePath, clientId)) {
  return res.send({ code: 409, message: '文件正在被其他用户编辑，无法保存' });
}

// ... 继续执行保存逻辑
```

## 5. 异常与边界情况处理

1.  **客户端异常退出**：
    如果浏览器崩溃或网络断开，WebSocket 连接会断开，后端 `close` 事件触发，自动释放锁。机制已覆盖。

2.  **锁超时（可选优化）**：
    如果用户打开编辑器后长时间挂机（Socket 未断但人不在），是否需要自动释放？
    *建议*：暂不强制自动释放，因为用户可能正在长时间调试。如果需要，可以增加一个定时任务，清理超过 24 小时的锁。

3.  **管理员强制解锁（可选）**：
    在前端文件列表提供一个“强制解锁”按钮（仅管理员可见），调用后端接口强制删除锁，以防死锁。

## 6. 高并发与一致性设计

在高并发场景下（如多人同时操作、脚本密集运行），单纯依靠内存锁可能不足以保证数据的绝对安全。本方案采用 **“业务层软锁 + 持久层硬锁”** 的双层防护策略。

### 6.1 业务层软锁 (LockService)
**场景**：前端用户交互，防止多人同时进入编辑模式。
**并发处理**：
- **Node.js 单线程特性**：由于 Node.js 是单线程事件循环模型，`LockService` 中的 `acquire` 方法（基于 `Map` 操作）在同一进程内是原子的。
- **决策逻辑**：
    - 当用户 A 和用户 B 几乎同时（毫秒级差异）点击“编辑”按钮。
    - 请求先后进入 Node.js 事件队列。
    - 假设 A 的请求先被处理：`locks.get(file)` 为空 -> A 获取锁成功 -> 返回 `true`。
    - B 的请求随后被处理：`locks.get(file)` 已存在（A 持有） -> B 获取锁失败 -> 返回 `false`。
- **前端展示**：
    - **用户 A**：正常进入编辑页面。
    - **用户 B**：
        - 收到后端返回的 `409 Conflict` 或 `false`。
        - 页面弹出 Toast 提示：“文件正在被用户 [UserA] 编辑，已切换为只读模式”。
        - 编辑器自动设置为 `readOnly: true`。
        - 界面顶部显示黄色警告条：“当前为只读模式（锁定者：UserA）”。

### 6.2 持久层硬锁 (File System Lock)
**场景**：防止底层文件写入冲突（如 API 直接调用、定时任务并发写入）。
**方案**：利用项目现有的 `proper-lockfile` 库。
- **原子性保障**：在执行“读取 -> 备份 -> 写入”这一整套流程时，必须先获取文件系统级别的锁。
- **解决 Check-Then-Act 问题**：
    ```typescript
    // 伪代码：使用 withFileLock 包裹完整事务
    await withFileLock(filePath, async () => {
        // 1. Double-Check: 再次检查文件状态
        if (await fileExist(filePath)) {
            // 2. 备份
            await backupFile(filePath);
        }
        // 3. 写入
        await fs.writeFile(filePath, content);
    });
    ```
- **Cluster 模式兼容**：`proper-lockfile` 基于文件系统原子操作（`mkdir` 或 `O_EXCL`），天然支持同一台机器上的多进程（Cluster）并发控制，无需引入 Redis。

### 6.3 极端并发下的用户通知 (Socket 广播)
如果用户 B 在用户 A 编辑期间强行通过 API 修改了文件（绕过了前端限制，但被后端拦截），或者用户 A 保存了文件：
- **事件广播**：后端触发 `file_changed` 事件。
- **前端响应**：
    - 所有打开该文件的客户端收到通知。
    - 弹出提示：“文件内容已在别处被修改，请刷新查看最新内容”。
    - 强制刷新编辑器内容，确保用户看到的是最新版本。

## 7. 实施步骤
1.  后端：创建 `LockService`。
2.  后端：修改 `Sock` Loader 和 Service，处理连接、断开及锁消息。
3.  后端：修改 `Script` API，添加写操作的锁校验。
4.  前端：实现 `clientId` 生成与传递。
5.  前端：接入 Socket 锁事件，实现编辑器只读状态切换。
