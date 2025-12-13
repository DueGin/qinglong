/**
 * 客户端ID管理
 * 用于区分不同的浏览器标签页/窗口，实现文件锁功能
 */

const CLIENT_ID_KEY = 'ql_client_id';

/**
 * 生成UUID
 */
function generateUUID(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/**
 * 获取当前客户端ID
 * 每个浏览器标签页都有唯一的clientId，存储在sessionStorage中
 */
export function getClientId(): string {
  let clientId = sessionStorage.getItem(CLIENT_ID_KEY);
  
  if (!clientId) {
    clientId = generateUUID();
    sessionStorage.setItem(CLIENT_ID_KEY, clientId);
  }
  
  return clientId;
}

/**
 * 清除客户端ID（通常在登出时调用）
 */
export function clearClientId(): void {
  sessionStorage.removeItem(CLIENT_ID_KEY);
}
