# 文件锁功能使用指南

## 功能简介

文件锁功能可以防止多个用户或同一用户的多个浏览器标签页同时编辑同一个脚本文件，避免编辑冲突和数据覆盖问题。

## 核心特性

- ✅ **自动锁定**：打开文件编辑器时自动尝试获取锁
- ✅ **自动释放**：关闭编辑器或断开连接时自动释放锁
- ✅ **只读模式**：当文件被他人锁定时，自动切换为只读模式
- ✅ **实时同步**：通过 WebSocket 实时同步锁状态变化
- ✅ **友好提示**：清晰显示谁正在编辑文件

## 用户体验

### 场景 1：正常编辑
当您打开一个未被锁定的文件时：
- ✅ 可以正常编辑和保存
- ✅ 可以运行脚本进行调试
- ✅ 其他用户将无法编辑此文件

### 场景 2：文件被锁定
当您尝试打开一个正在被他人编辑的文件时：
- ⚠️ 编辑器自动切换为只读模式
- ⚠️ 顶部显示黄色警告条，提示锁定者的用户名
- ⚠️ "保存"和"运行"按钮被禁用
- ✅ 仍可查看文件内容和日志

### 场景 3：锁定者退出
当锁定者关闭编辑器或断开连接后：
- ✅ 系统自动释放锁
- ✅ 其他用户收到实时通知
- ✅ 可以开始编辑文件

## 技术说明

### 客户端标识 (Client ID)
- 每个浏览器标签页都有唯一的 UUID
- 存储在 `sessionStorage` 中
- 用于区分同一用户的不同编辑端

### 通信机制
- **HTTP**: 携带 `x-client-id` 请求头进行锁校验
- **WebSocket**: 实时同步锁状态，处理获取/释放锁请求

### 锁的生命周期
```
打开编辑器 → 尝试获取锁 → 成功/失败
                              ↓
                         正常编辑 / 只读模式
                              ↓
关闭编辑器 / 断开连接 → 自动释放锁
```

## 注意事项

1. **刷新页面**
   - 刷新页面会断开 WebSocket 连接
   - 旧的锁会被自动释放
   - 新页面会尝试重新获取锁

2. **浏览器崩溃**
   - WebSocket 连接断开会触发自动清理
   - 锁会被立即释放，不会造成死锁

3. **网络不稳定**
   - 短暂断网会尝试重连
   - 长时间断网会释放锁
   - 重连后需要重新获取锁

4. **多标签页**
   - 同一账号在多个标签页中只有一个可以编辑
   - 其他标签页自动切换为只读模式
   - 先打开的标签页优先获得锁

## API 说明

### 前端 Hook

```typescript
import { useFileLock } from '@/hooks/useFileLock';

const { isLocked, isReadOnly, lockInfo } = useFileLock({
  filePath: '/ql/data/scripts/test.js',
});

// isLocked: 当前客户端是否持有锁
// isReadOnly: 是否处于只读模式
// lockInfo: 锁定者信息（如果被他人锁定）
```

### WebSocket 消息

**客户端 → 服务器**:
```javascript
// 获取锁
ws.send({ type: 'acquireLock', filePath: '/path/to/file.js' });

// 释放锁
ws.send({ type: 'releaseLock', filePath: '/path/to/file.js' });
```

**服务器 → 客户端**:
```javascript
// 锁获取成功
{ type: 'lockAcquired', filePath: '...', success: true }

// 锁获取失败
{ type: 'lockFailed', filePath: '...', success: false, lockInfo: {...} }

// 锁状态更新（广播）
{ type: 'lockStatus', locks: [...] }
```

### HTTP API

所有脚本相关的 API 都会自动检查锁状态：
- `POST /api/scripts` - 创建文件
- `PUT /api/scripts` - 更新文件
- `PUT /api/scripts/run` - 运行脚本

如果文件被锁定，返回：
```json
{
  "code": 409,
  "message": "文件正在被用户 xxx 编辑，无法保存"
}
```

## 开发指南

### 扩展其他页面

如果需要在其他页面使用文件锁功能：

```typescript
import { useFileLock } from '@/hooks/useFileLock';

function MyEditor() {
  const [filePath, setFilePath] = useState('');
  
  const { isReadOnly, lockInfo } = useFileLock({
    filePath,
    onLockAcquired: () => {
      console.log('获取锁成功');
    },
    onLockFailed: (info) => {
      console.log('获取锁失败', info);
    },
  });

  return (
    <>
      {isReadOnly && (
        <Alert
          type="warning"
          message={`文件被 ${lockInfo?.username} 锁定`}
        />
      )}
      <Editor readOnly={isReadOnly} />
    </>
  );
}
```

### 后端 API 保护

```typescript
import LockService from '../services/lock';
import { Container } from 'typedi';

// 在任何文件操作的 API 中
const lockService = Container.get(LockService);
const clientId = req.headers['x-client-id'] as string;

if (lockService.isLocked(filePath, clientId)) {
  return res.send({
    code: 409,
    message: '文件被锁定',
  });
}
```

## 故障排查

### 问题：锁一直不释放
**原因**：WebSocket 连接未正常断开
**解决**：
1. 刷新页面
2. 重启后端服务（会清空内存中的所有锁）

### 问题：无法获取锁
**原因**：文件正在被其他端编辑
**解决**：
1. 检查是否有其他标签页打开了该文件
2. 等待锁定者关闭编辑器
3. 如果是死锁，联系管理员强制解锁（未来功能）

### 问题：WebSocket 连接失败
**原因**：网络问题或后端服务异常
**解决**：
1. 检查网络连接
2. 查看浏览器控制台错误信息
3. 检查后端服务是否正常运行
