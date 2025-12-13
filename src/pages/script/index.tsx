import IconFont from '@/components/iconfont';
import useFilterTreeData from '@/hooks/useFilterTreeData';
import { SharedContext } from '@/layouts';
import { depthFirstSearch, findNode, getEditorMode } from '@/utils';
import config from '@/utils/config';
import { request } from '@/utils/http';
import { canPreviewInMonaco } from '@/utils/monaco';
import WebSocketManager from '@/utils/websocket';
import { getClientId } from '@/utils/clientId';
import type { LockInfo } from '@/utils/type';
import {
  CloudDownloadOutlined,
  DeleteOutlined,
  EditOutlined,
  EllipsisOutlined,
  PlusOutlined,
} from '@ant-design/icons';
import { PageContainer } from '@ant-design/pro-layout';
import Editor from '@monaco-editor/react';
import { langs } from '@uiw/codemirror-extensions-langs';
import CodeMirror from '@uiw/react-codemirror';
import { history, useOutletContext } from '@umijs/max';
import {
  Button,
  Dropdown,
  Empty,
  Input,
  MenuProps,
  message,
  Modal,
  Tooltip,
  Tree,
  TreeSelect,
  Typography,
  Alert,
} from 'antd';
import { saveAs } from 'file-saver';
import debounce from 'lodash/debounce';
import uniq from 'lodash/uniq';
import prettyBytes from 'pretty-bytes';
import { parse } from 'query-string';
import { Key, useCallback, useEffect, useRef, useState } from 'react';
import { useHotkeys } from 'react-hotkeys-hook';
import intl from 'react-intl-universal';
import SplitPane from 'react-split-pane';
import EditModal from './editModal';
import EditScriptNameModal from './editNameModal';
import styles from './index.module.less';
import RenameModal from './renameModal';
import UnsupportedFilePreview from './components/UnsupportedFilePreview';
const { Text } = Typography;

const Script = () => {
  const { headerStyle, isPhone, theme } = useOutletContext<SharedContext>();
  const [value, setValue] = useState(intl.get('请选择脚本文件'));
  const [select, setSelect] = useState<string>(intl.get('请选择脚本文件'));
  const [data, setData] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [mode, setMode] = useState('');
  const [height, setHeight] = useState<number>();
  const treeDom = useRef<any>();
  const [isLogModalVisible, setIsLogModalVisible] = useState(false);
  const [searchValue, setSearchValue] = useState('');
  const [isEditing, setIsEditing] = useState(false);
  const editorRef = useRef<any>(null);
  const [isAddFileModalVisible, setIsAddFileModalVisible] = useState(false);
  const [isRenameFileModalVisible, setIsRenameFileModalVisible] =
    useState(false);
  const [currentNode, setCurrentNode] = useState<any>();
  const [expandedKeys, setExpandedKeys] = useState<string[]>([]);
  const [showMonaco, setShowMonaco] = useState(true);
  const [lockInfo, setLockInfo] = useState<LockInfo | null>(null);
  const [isLocked, setIsLocked] = useState(false); // 当前客户端是否持有锁
  const [isDeletedByOther, setIsDeletedByOther] = useState(false);
  const [isRenamedByOther, setIsRenamedByOther] = useState(false);
  const [isUpdatedByOther, setIsUpdatedByOther] = useState(false);
  const wsRef = useRef<WebSocketManager | null>(null);
  const [pendingAction, setPendingAction] = useState<
    'edit' | 'debug' | 'delete' | 'rename' | null
  >(null);
  const pendingNodeRef = useRef<any>(null);
  const pendingFilePathRef = useRef<string | null>(null);

  const handleIsEditing = (filename: string, value: boolean) => {
    setIsEditing(value && canPreviewInMonaco(filename));
  };

  // 获取文件完整路径
  const getFilePath = (node: any) => {
    if (!node) return null;
    return ['/ql/data/scripts', node.parent, node.title]
      .filter(Boolean)
      .join('/')
      .replace(/\/+/g, '/');
  };

  // 检查文件锁状态
  const checkFileLock = (node: any) => {
    if (!node || node.type === 'directory') {
      setLockInfo(null);
      setIsLocked(false);
      return;
    }

    // 锁状态会通过 lockStatus 事件自动更新
    // 无需单独发送检查请求
  };

  // 尝试获取文件锁
  const acquireFileLock = (node: any) => {
    if (!node) return;

    const filePath = getFilePath(node);
    if (!filePath) return;
    pendingNodeRef.current = node;
    pendingFilePathRef.current = filePath;
    const clientId = getClientId();

    wsRef.current?.send({
      type: 'acquireLock',
      filePath,
      clientId,
    });
  };

  // 释放文件锁
  const releaseFileLock = (node: any) => {
    if (!node) return;

    const filePath = getFilePath(node);
    if (pendingFilePathRef.current === filePath) {
      pendingFilePathRef.current = null;
      pendingNodeRef.current = null;
      setPendingAction(null);
    }
    const clientId = getClientId();

    wsRef.current?.send({
      type: 'releaseLock',
      filePath,
      clientId,
    });
  };

  const getScripts = (needLoading: boolean = true) => {
    needLoading && setLoading(true);
    request
      .get(`${config.apiPrefix}scripts`)
      .then(({ code, data }) => {
        if (code === 200) {
          setData(data);
          initState();
          initGetScript(data);
        }
      })
      .finally(() => needLoading && setLoading(false));
  };

  const getDetail = (node: any, options: any = {}) => {
    request
      .get(
        `${config.apiPrefix}scripts/detail?file=${encodeURIComponent(
          node.title,
        )}&path=${node.parent || ''}`,
      )
      .then(({ code, data }: any) => {
        if (code === 200) {
          const content = data?.content || '';
          const apiLockInfo = data?.lockInfo;

          setValue(content);

          // 更新锁状态
          if (apiLockInfo) {
            setIsLocked(apiLockInfo.isOwnLock || false);
            if (apiLockInfo.isLocked && !apiLockInfo.isOwnLock) {
              setLockInfo({
                username: apiLockInfo.lockedBy,
                clientId: '',
                filePath: getFilePath(node) || '',
                timestamp: Date.now(),
              });
            } else {
              setLockInfo(null);
            }
          } else {
            setIsLocked(false);
            setLockInfo(null);
          }
          
          if (options.callback) {
            options.callback();
          }
        }
      })
      .catch((error) => {
        console.error('Failed to load file:', error);
      });
  };

  const downloadScript = () => {
    if (isDeletedByOther || isRenamedByOther || isUpdatedByOther) {
      return;
    }
    if (typeof value === 'string' && value.trim() === '') {
      return;
    }
    request
      .post<Blob>(
        `${config.apiPrefix}scripts/download`,
        {
          filename: currentNode.title,
          path: currentNode.parent || '',
        },
        { responseType: 'blob' },
      )
      .then((res) => {
        saveAs(res, currentNode.title);
      });
  };

  const initGetScript = (_data: any) => {
    const { p, s } = parse(history.location.search);
    if (s) {
      const vkey = `${p}/${s}`;
      const obj = {
        node: {
          title: s,
          key: p ? vkey : s,
          parent: p,
        },
      };
      const item = findNode(_data, (c) => c.key === obj.node.key);
      if (item) {
        obj.node = item;
        setExpandedKeys([p as string]);
        onTreeSelect([vkey], obj);
      }
    }
  };

  const onSelect = (value: any, node: any) => {
    if (node.key === select || !value) {
      return;
    }

    // 切换节点时清理“已被删除”状态
    setIsDeletedByOther(false);
    setIsRenamedByOther(false);
    setIsUpdatedByOther(false);

    if (pendingFilePathRef.current && pendingNodeRef.current) {
      const incomingPath = node.type === 'directory' ? null : getFilePath(node);
      if (pendingFilePathRef.current !== incomingPath) {
        releaseFileLock(pendingNodeRef.current);
      }
    }
    pendingNodeRef.current = null;
    pendingFilePathRef.current = null;
    setPendingAction(null);

    setSelect(node.key);
    setCurrentNode(node);

    if (node.type === 'directory') {
      setValue(intl.get('请选择脚本文件'));
      setShowMonaco(true);
      setLockInfo(null);
      setIsLocked(false);
      return;
    }

    if (!canPreviewInMonaco(node.title)) {
      setShowMonaco(false);
      // 即使不能在 Monaco 预览，也要加载文件内容
      getDetail(node);
      return;
    }

    setShowMonaco(true);
    const newMode = getEditorMode(node.title);
    setMode(isPhone && newMode === 'typescript' ? 'javascript' : newMode);
    setValue(intl.get('加载中...'));

    // getDetail 会自动获取并更新锁状态
    getDetail(node, {
      callback: () => {
        if (isEditing) {
          setIsEditing(true);
        }
      },
    });
  };

  const onTreeSelect = useCallback(
    (keys: Key[], e: any) => {
      const node = e.node;
      if (node.key === select && isEditing) {
        return;
      }

      const currentContent = editorRef.current
        ? editorRef.current.getValue().replace(/\r\n/g, '\n')
        : value;
      const originalContent = value.replace(/\r\n/g, '\n');

      if (currentContent !== originalContent && isEditing) {
        Modal.confirm({
          title: intl.get('确认离开'),
          content: <>{intl.get('当前文件未保存，确认离开吗')}</>,
          onOk() {
            // 释放当前文件的锁
            if (currentNode && isLocked) {
              releaseFileLock(currentNode);
              setIsLocked(false);
            }
            onSelect(keys[0], e.node);
            handleIsEditing(e.node.title, false);
          },
        });
      } else {
        // 释放当前文件的锁
        if (currentNode && isLocked && !isEditing) {
          releaseFileLock(currentNode);
          setIsLocked(false);
        }
        handleIsEditing(e.node.title, false);
        onSelect(keys[0], e.node);
      }
    },
    [value, select, isEditing, currentNode, isLocked],
  );

  const onSearch = useCallback(
    (e) => {
      const keyword = e.target.value;
      debounceSearch(keyword);
    },
    [data],
  );

  const debounceSearch = useCallback(
    debounce((keyword) => {
      setSearchValue(keyword);
    }, 300),
    [data],
  );

  const { treeData: filterData, keys: searchExpandedKeys } = useFilterTreeData(
    data,
    searchValue,
    { treeNodeFilterProp: 'title' },
  );

  useEffect(() => {
    setExpandedKeys(uniq([...expandedKeys, ...searchExpandedKeys]));
  }, [searchExpandedKeys]);

  const onExpand = (expKeys: any) => {
    setExpandedKeys(expKeys);
  };

  const onDoubleClick = (e: any, node: any) => {
    if (node.type === 'file') {
      if ((isDeletedByOther || isRenamedByOther || isUpdatedByOther) && currentNode?.key === node.key) {
        return;
      }
      setSelect(node.key);
      setCurrentNode(node);
      setPendingAction('edit');
      acquireFileLock(node);
    }
  };

  const editFile = () => {
    if (!currentNode) return;
    if (isDeletedByOther || isRenamedByOther || isUpdatedByOther) return;
    setPendingAction('edit');
    acquireFileLock(currentNode);
  };

  const cancelEdit = () => {
    handleIsEditing(currentNode.title, false);
    setValue(intl.get('加载中...'));
    getDetail(currentNode);
    // 退出编辑时释放锁
    releaseFileLock(currentNode);
    setIsLocked(false);
    setPendingAction(null);
  };

  const saveFile = () => {
    Modal.confirm({
      title: `确认保存`,
      content: (
        <>
          {intl.get('确认保存文件')}
          <Text style={{ wordBreak: 'break-all' }} type="warning">
            {' '}
            {currentNode.title}
          </Text>
          {intl.get('，保存后不可恢复')}
        </>
      ),
      onOk() {
        const content = editorRef.current
          ? editorRef.current.getValue().replace(/\r\n/g, '\n')
          : value;
        return new Promise((resolve, reject) => {
          request
            .put(`${config.apiPrefix}scripts`, {
              filename: currentNode.title,
              path: currentNode.parent || '',
              content,
            })
            .then(({ code, data }) => {
              if (code === 200) {
                message.success(`保存成功`);
                setValue(content);
                handleIsEditing(currentNode.title, false);
                // 非调试模式下保存后释放锁
                releaseFileLock(currentNode);
                setIsLocked(false);
              }
              resolve(null);
            })
            .catch((e) => reject(e));
        });
      },
    });
  };

  const openDeleteConfirm = (node: any) => {
    Modal.confirm({
      title: `确认删除`,
      content: (
        <>
          {intl.get('确认删除')}
          <Text style={{ wordBreak: 'break-all' }} type="warning">
            {' '}
            {node?.key}{' '}
          </Text>
          {intl.get('文件')}
          {node?.type === 'directory' ? intl.get('夹及其子文件') : ''}
          {intl.get('，删除后不可恢复')}
        </>
      ),
      onOk() {
        return request
          .delete(`${config.apiPrefix}scripts`, {
            data: {
              filename: node.title,
              path: node.parent || '',
              type: node.type,
            },
          })
          .then(({ code }) => {
            if (code === 200) {
              message.success(`删除成功`);
              let newData = [...data];
              if (node.parent) {
                newData = depthFirstSearch(newData, (c) => c.key === node.key);
              } else {
                const index = newData.findIndex((x) => x.key === node.key);
                if (index !== -1) {
                  newData.splice(index, 1);
                }
              }
              setData(newData);
              initState();
            }
          })
          .finally(() => {
            // 删除流程结束后释放锁（无论成功与否）
            releaseFileLock(node);
            setIsLocked(false);
          });
      },
      onCancel() {
        // 二次确认取消时释放锁
        releaseFileLock(node);
        setIsLocked(false);
      },
    });
  };

  const deleteFile = () => {
    if (!currentNode) return;
    if (isDeletedByOther || isRenamedByOther || isUpdatedByOther) return;

    // 已经是自己的锁：直接弹二次确认
    if (isLocked) {
      openDeleteConfirm(currentNode);
      return;
    }

    // 首次点击：先获取锁，锁到手再弹二次确认
    setPendingAction('delete');
    acquireFileLock(currentNode);
  };

  const renameFile = () => {
    if (!currentNode) return;
    if (isDeletedByOther || isRenamedByOther || isUpdatedByOther) return;

    // 已经是自己的锁：直接打开重命名弹窗
    if (isLocked) {
      setIsRenameFileModalVisible(true);
      return;
    }

    // 首次点击：先获取锁，锁到手再打开弹窗
    setPendingAction('rename');
    acquireFileLock(currentNode);
  };

  const handleRenameFileCancel = () => {
    setIsRenameFileModalVisible(false);
    // 关闭重命名弹窗（取消/成功都会走这里），释放锁
    if (currentNode && isLocked) {
      releaseFileLock(currentNode);
      setIsLocked(false);
    }
    getScripts(false);
  };

  const addFile = () => {
    setIsAddFileModalVisible(true);
  };

  const addFileModalClose = async (
    {
      filename,
      path,
      key,
      type,
    }: { filename: string; path: string; key: string; type?: string } = {
      filename: '',
      path: '',
      key: '',
    },
  ) => {
    if (filename) {
      const res = await request.get(`${config.apiPrefix}scripts`);
      let newData = res.data;
      if (type === 'directory' && filename.includes('/')) {
        const parts = filename.split('/');
        parts.pop();
        const parentPath = parts.join('/');
        path = path ? `${path}/${parentPath}` : parentPath;
      }
      const item = findNode(newData, (c) => c.key === key);
      if (path) {
        const keys = path.split('/');
        const sKeys: string[] = [];
        keys.reduce((p, c) => {
          sKeys.push(p);
          return `${p}/${c}`;
        });
        setExpandedKeys([...expandedKeys, ...sKeys, path]);
      }
      setData(newData);
      onSelect(item.title, item);
      // 新建后进入编辑：先获取锁，防止其他端抢占编辑/调试
      if (item.type !== 'directory') {
        setPendingAction('edit');
        acquireFileLock(item);
      }
    }
    setIsAddFileModalVisible(false);
  };

  const initState = () => {
    setSelect(intl.get('请选择脚本文件'));
    setCurrentNode(null);
    setValue(intl.get('请选择脚本文件'));
  };

  useEffect(() => {
    getScripts();
  }, []);

  useEffect(() => {
    // 初始化 WebSocket 监听
    wsRef.current = WebSocketManager.getInstance();
    
    // 监听锁获取成功
    const handleLockAcquired = (payload: any) => {
      if (!payload.success) return;

      const currentPath = currentNode ? getFilePath(currentNode) : null;
      const pendingPath = pendingFilePathRef.current;
      const isTargetFile =
        (currentPath && payload.filePath === currentPath) ||
        (!!pendingPath && payload.filePath === pendingPath);

      if (!isTargetFile) {
        return;
      }

      const targetNode = currentNode ?? pendingNodeRef.current;
      if (!targetNode) {
        return;
      }

      if (!currentNode) {
        setCurrentNode(targetNode);
      }

      setIsLocked(true);
      setLockInfo(null);

      if (pendingAction === 'edit') {
        handleIsEditing(targetNode.title, true);
      }

      if (pendingAction === 'debug') {
        setIsLogModalVisible(true);
      }

      if (pendingAction === 'delete') {
        openDeleteConfirm(targetNode);
      }

      if (pendingAction === 'rename') {
        setIsRenameFileModalVisible(true);
      }

      pendingNodeRef.current = null;
      pendingFilePathRef.current = null;
      setPendingAction(null);
    };
    
    // 监听锁获取失败
    const handleLockFailed = (payload: any) => {
      if (payload.success) return;

      const currentPath = currentNode ? getFilePath(currentNode) : null;
      const pendingPath = pendingFilePathRef.current;
      const isTargetFile =
        (currentPath && payload.filePath === currentPath) ||
        (!!pendingPath && payload.filePath === pendingPath);

      if (!isTargetFile) {
        return;
      }

      const targetNode = currentNode ?? pendingNodeRef.current;

      setIsLocked(false);
      setLockInfo(payload.lockInfo);

      if (pendingAction === 'edit' && targetNode) {
        handleIsEditing(targetNode.title, false);
      }

      if (pendingAction === 'debug') {
        setIsLogModalVisible(false);
      }

      if (pendingAction === 'delete') {
        // 不弹二次确认
      }

      if (pendingAction === 'rename') {
        // 不打开重命名弹窗
      }

      pendingNodeRef.current = null;
      pendingFilePathRef.current = null;
      setPendingAction(null);

    };
    
    // 监听锁状态更新
    const handleLockStatus = (payload: any) => {
      if (!payload.locks) return;
      if (!currentNode && !pendingFilePathRef.current) return;
      
      const filePath = currentNode ? getFilePath(currentNode) : null;
      const pendingPath = pendingFilePathRef.current;
      const clientId = getClientId();
      const currentFileLock = payload.locks.find(
        (lock: LockInfo) => lock.filePath === (filePath || pendingPath),
      );
      
      if (currentFileLock) {
        if (currentFileLock.clientId === clientId) {
          setIsLocked(true);
          setLockInfo(null);
          if (pendingAction === 'edit') {
            const targetNode = currentNode ?? pendingNodeRef.current;
            if (targetNode) {
              if (!currentNode) {
                setCurrentNode(targetNode);
              }
              handleIsEditing(targetNode.title, true);
            }
            setPendingAction(null);
          } else if (pendingAction === 'debug') {
            if (!currentNode && pendingNodeRef.current) {
              setCurrentNode(pendingNodeRef.current);
            }
            setIsLogModalVisible(true);
            setPendingAction(null);
          } else if (pendingAction === 'delete') {
            const targetNode = currentNode ?? pendingNodeRef.current;
            if (targetNode) {
              if (!currentNode) {
                setCurrentNode(targetNode);
              }
              openDeleteConfirm(targetNode);
            }
            setPendingAction(null);
          } else if (pendingAction === 'rename') {
            if (!currentNode && pendingNodeRef.current) {
              setCurrentNode(pendingNodeRef.current);
            }
            setIsRenameFileModalVisible(true);
            setPendingAction(null);
          }
          pendingNodeRef.current = null;
          pendingFilePathRef.current = null;
        } else {
          if (isEditing && currentNode) {
            handleIsEditing(currentNode.title, false);
          }
          if (isLogModalVisible) {
            setIsLogModalVisible(false);
          }
          setPendingAction(null);
          pendingNodeRef.current = null;
          pendingFilePathRef.current = null;
          setIsLocked(false);
          setLockInfo(currentFileLock);
        }
      } else {
        setIsLocked(false);
        setLockInfo(null);
      }
    };

    // 监听文件删除（其他端删除当前文件时提示）
    const handleScriptDeleted = (payload: any) => {
      const deletedFilePath = payload?.filePath as string | undefined;
      const deletedByClientId = payload?.clientId as string | undefined;
      if (!deletedFilePath) return;

      // 自己删除的无需提示
      if (deletedByClientId && deletedByClientId === getClientId()) {
        return;
      }

      if (!currentNode || currentNode.type === 'directory') return;
      const currentPath = getFilePath(currentNode);
      if (currentPath && deletedFilePath === currentPath) {
        setIsDeletedByOther(true);
        setIsRenamedByOther(false);
        setIsUpdatedByOther(false);
        // 文件被其他端删除后，退出编辑/调试并释放锁，避免继续操作
        if (isEditing) {
          handleIsEditing(currentNode.title, false);
        }
        if (isLogModalVisible) {
          setIsLogModalVisible(false);
        }
        if (isLocked) {
          releaseFileLock(currentNode);
          setIsLocked(false);
        }
      }
    };

    // 监听文件重命名（其他端重命名当前文件时提示）
    const handleScriptRenamed = (payload: any) => {
      const oldFilePath = payload?.oldFilePath as string | undefined;
      const renamedByClientId = payload?.clientId as string | undefined;
      if (!oldFilePath) return;

      // 自己重命名的不提示
      if (renamedByClientId && renamedByClientId === getClientId()) {
        return;
      }

      if (!currentNode || currentNode.type === 'directory') return;
      const currentPath = getFilePath(currentNode);
      if (currentPath && oldFilePath === currentPath) {
        setIsRenamedByOther(true);
        setIsDeletedByOther(false);
        setIsUpdatedByOther(false);

        // 文件被其他端重命名后，退出编辑/调试并释放锁，避免继续操作
        if (isEditing) {
          handleIsEditing(currentNode.title, false);
        }
        if (isLogModalVisible) {
          setIsLogModalVisible(false);
        }
        if (isLocked) {
          releaseFileLock(currentNode);
          setIsLocked(false);
        }
      }
    };

    // 监听文件内容更新（其他端修改当前文件时提示刷新）
    const handleScriptUpdated = (payload: any) => {
      const updatedFilePath = payload?.filePath as string | undefined;
      const updatedByClientId = payload?.clientId as string | undefined;
      if (!updatedFilePath) return;

      // 自己更新的不提示
      if (updatedByClientId && updatedByClientId === getClientId()) {
        return;
      }

      if (!currentNode || currentNode.type === 'directory') return;
      const currentPath = getFilePath(currentNode);
      if (currentPath && updatedFilePath === currentPath) {
        setIsUpdatedByOther(true);
        setIsDeletedByOther(false);
        setIsRenamedByOther(false);

        // 文件被其他端修改后，退出编辑/调试并释放锁，避免继续操作
        if (isEditing) {
          handleIsEditing(currentNode.title, false);
        }
        if (isLogModalVisible) {
          setIsLogModalVisible(false);
        }
        if (isLocked) {
          releaseFileLock(currentNode);
          setIsLocked(false);
        }
      }
    };
    
    wsRef.current.subscribe('lockAcquired', handleLockAcquired);
    wsRef.current.subscribe('lockFailed', handleLockFailed);
    wsRef.current.subscribe('lockStatus', handleLockStatus);
    wsRef.current.subscribe('scriptDeleted', handleScriptDeleted);
    wsRef.current.subscribe('scriptRenamed', handleScriptRenamed);
    wsRef.current.subscribe('scriptUpdated', handleScriptUpdated);
    
    return () => {
      wsRef.current?.unsubscribe('lockAcquired', handleLockAcquired);
      wsRef.current?.unsubscribe('lockFailed', handleLockFailed);
      wsRef.current?.unsubscribe('lockStatus', handleLockStatus);
      wsRef.current?.unsubscribe('scriptDeleted', handleScriptDeleted);
      wsRef.current?.unsubscribe('scriptRenamed', handleScriptRenamed);
      wsRef.current?.unsubscribe('scriptUpdated', handleScriptUpdated);
    };
  }, [currentNode, pendingAction, isEditing, isLogModalVisible]);

  useEffect(() => {
    if (treeDom.current) {
      setHeight(treeDom.current.clientHeight - 6);
    }
  }, [treeDom.current, data]);

  useHotkeys(
    'mod+s',
    (e) => {
      if (isEditing) {
        saveFile();
      }
    },
    { enableOnFormTags: ['textarea'], preventDefault: true },
  );

  useHotkeys(
    'mod+d',
    (e) => {
      if (currentNode.title) {
        deleteFile();
      }
    },
    { preventDefault: true },
  );

  useHotkeys(
    'mod+o',
    (e) => {
      if (!isEditing) {
        addFile();
      }
    },
    { preventDefault: true },
  );

  useHotkeys(
    'mod+e',
    (e) => {
      if (currentNode.title) {
        cancelEdit();
      }
    },
    { preventDefault: true },
  );

  const action = (key: string | number) => {
    switch (key) {
      case 'save':
        saveFile();
        break;
      case 'exit':
        cancelEdit();
        break;
      default:
        break;
    }
  };

  const menuAction = (key: string | number) => {
    switch (key) {
      case 'add':
        addFile();
        break;
      case 'edit':
        editFile();
        break;
      case 'delete':
        deleteFile();
        break;
      case 'rename':
        renameFile();
        break;
      default:
        break;
    }
  };

  const menu: MenuProps = isEditing
    ? {
        items: [
          { label: intl.get('保存'), key: 'save', icon: <PlusOutlined /> },
          { label: intl.get('退出编辑'), key: 'exit', icon: <EditOutlined /> },
        ],
        onClick: ({ key, domEvent }) => {
          domEvent.stopPropagation();
          action(key);
        },
      }
    : {
        items: [
          { label: intl.get('创建'), key: 'add', icon: <PlusOutlined /> },
          {
            label: intl.get('编辑'),
            key: 'edit',
            icon: <EditOutlined />,
            disabled:
              !currentNode || isDeletedByOther || isRenamedByOther || isUpdatedByOther || (lockInfo !== null && !isLocked),
          },
          {
            label: intl.get('重命名'),
            key: 'rename',
            icon: <IconFont type="ql-icon-rename" />,
            disabled:
              !currentNode || isDeletedByOther || isRenamedByOther || isUpdatedByOther || (lockInfo !== null && !isLocked),
          },
          {
            label: intl.get('删除'),
            key: 'delete',
            icon: <DeleteOutlined />,
            disabled:
              !currentNode || isDeletedByOther || isRenamedByOther || isUpdatedByOther || (lockInfo !== null && !isLocked),
          },
        ],
        onClick: ({ key, domEvent }) => {
          domEvent.stopPropagation();
          menuAction(key);
        },
      };

  const handleForceOpen = () => {
    if (!currentNode) return;

    setMode('plaintext');
    setValue(intl.get('加载中...'));
    setShowMonaco(true);

    getDetail(currentNode, {
      callback: () => {
        setIsEditing(true);
      },
    });
  };

  return (
    <PageContainer
      className="ql-container-wrapper log-wrapper"
      title={
        <>
          {select}
          {currentNode?.type === 'file' && (
            <span
              style={{
                marginLeft: 6,
                fontSize: 12,
                color: '#999',
                display: 'inline-block',
                height: 14,
              }}
            >
              {prettyBytes(currentNode.size)}
            </span>
          )}
        </>
      }
      loading={loading}
      extra={
        isPhone
          ? [
              <TreeSelect
                treeExpandAction="click"
                className="log-select"
                value={select}
                dropdownStyle={{ maxHeight: 400, overflow: 'auto' }}
                treeData={data}
                placeholder={intl.get('请选择脚本')}
                fieldNames={{ value: 'key' }}
                treeNodeFilterProp="title"
                showSearch
                allowClear
                onSelect={onSelect}
              />,
              <Dropdown menu={menu} trigger={['click']}>
                <Button type="primary" icon={<EllipsisOutlined />} />
              </Dropdown>,
            ]
          : isEditing
          ? [
              <Button type="primary" onClick={saveFile}>
                {intl.get('保存')}
              </Button>,
              <Button type="primary" onClick={cancelEdit}>
                {intl.get('退出编辑')}
              </Button>,
            ]
          : [
              <Tooltip title={intl.get('创建')}>
                <Button
                  type="primary"
                  onClick={addFile}
                  icon={<PlusOutlined />}
                />
              </Tooltip>,
              <Tooltip title={intl.get('编辑')}>
                <Button
                  disabled={!currentNode || isDeletedByOther || isRenamedByOther || isUpdatedByOther || (lockInfo !== null && !isLocked)}
                  type="primary"
                  onClick={editFile}
                  icon={<EditOutlined />}
                />
              </Tooltip>,
              <Tooltip title={intl.get('重命名')}>
                <Button
                  disabled={!currentNode || isDeletedByOther || isRenamedByOther || isUpdatedByOther || (lockInfo !== null && !isLocked)}
                  type="primary"
                  onClick={renameFile}
                  icon={<IconFont type="ql-icon-rename" />}
                />
              </Tooltip>,
              <Tooltip title={intl.get('下载')}>
                <Button
                  disabled={
                    !currentNode ||
                    currentNode.type === 'directory' ||
                    isDeletedByOther ||
                    isRenamedByOther ||
                    isUpdatedByOther ||
                    (typeof value === 'string' && value.trim() === '')
                  }
                  type="primary"
                  onClick={downloadScript}
                  icon={<CloudDownloadOutlined />}
                />
              </Tooltip>,
              <Tooltip title={intl.get('删除')}>
                <Button
                  type="primary"
                  disabled={!currentNode || isDeletedByOther || isRenamedByOther || isUpdatedByOther || (lockInfo !== null && !isLocked)}
                  onClick={deleteFile}
                  icon={<DeleteOutlined />}
                />
              </Tooltip>,
              <Button
                type="primary"
                disabled={!currentNode || isDeletedByOther || isRenamedByOther || isUpdatedByOther || currentNode.type === 'directory' || (lockInfo !== null && !isLocked)}
                onClick={() => {
                  if (!currentNode) return;
                  if (isDeletedByOther || isRenamedByOther || isUpdatedByOther) return;
                  setPendingAction('debug');
                  // 调试前也需要获取锁
                  acquireFileLock(currentNode);
                }}
              >
                {intl.get('调试')}
              </Button>,
            ]
      }
      header={{
        style: headerStyle,
      }}
    >
      <div className={`${styles['log-container']} log-container`}>
        {!isPhone && (
          /*// @ts-ignore*/
          <SplitPane split="vertical" size={200} maxSize={-100}>
            <div className={styles['left-tree-container']}>
              {data.length > 0 ? (
                <>
                  <Input.Search
                    className={styles['left-tree-search']}
                    onChange={onSearch}
                    placeholder={intl.get('请输入脚本名')}
                    allowClear
                  ></Input.Search>
                  <div className={styles['left-tree-scroller']} ref={treeDom}>
                    <Tree
                      expandAction="click"
                      className={styles['left-tree']}
                      treeData={filterData}
                      showIcon={true}
                      height={height}
                      selectedKeys={[select]}
                      expandedKeys={expandedKeys}
                      onExpand={onExpand}
                      showLine={{ showLeafIcon: true }}
                      onSelect={onTreeSelect}
                      onDoubleClick={onDoubleClick}
                    ></Tree>
                  </div>
                </>
              ) : (
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'center',
                    alignItems: 'center',
                    height: '100%',
                  }}
                >
                  <Empty
                    description={intl.get('暂无脚本')}
                    image={Empty.PRESENTED_IMAGE_SIMPLE}
                  />
                </div>
              )}
            </div>
            {showMonaco ? (
              <>
                {/* 文件删除提示 */}
                {isDeletedByOther && currentNode && currentNode.type === 'file' && (
                  <Alert
                    message={intl
                      .get('当前文件已被其他用户删除，请刷新页面')
                      .d('当前文件已被其他用户删除，请刷新页面')}
                    type="error"
                    showIcon
                    style={{ margin: '8px' }}
                  />
                )}
                {/* 文件重命名提示 */}
                {isRenamedByOther && currentNode && currentNode.type === 'file' && (
                  <Alert
                    message={intl
                      .get('当前文件已被其他用户重命名，请刷新页面')
                      .d('当前文件已被其他用户重命名，请刷新页面')}
                    type="error"
                    showIcon
                    style={{ margin: '8px' }}
                  />
                )}
                {/* 文件内容更新提示 */}
                {isUpdatedByOther && currentNode && currentNode.type === 'file' && (
                  <Alert
                    message={intl
                      .get('当前文件已被其他用户修改，请刷新页面获取最新文件')
                      .d('当前文件已被其他用户修改，请刷新页面获取最新文件')}
                    type="warning"
                    showIcon
                    style={{ margin: '8px' }}
                  />
                )}
                {/* 锁状态提示 */}
                {lockInfo && !isLocked && currentNode && currentNode.type === 'file' && (
                  <Alert
                    message={intl
                      .get('文件已被锁定')
                      .d('文件已被锁定')}
                    description={intl
                      .get('用户 {username} 正在编辑此文件，您暂时无法编辑或调试', {
                        username:
                          lockInfo.username ||
                          intl.get('未知用户').d('未知用户'),
                      })
                      .d('当前文件正由其他用户编辑，您暂时无法编辑或调试')}
                    type="warning"
                    showIcon
                    closable
                    style={{ margin: '8px' }}
                  />
                )}
                <Editor
                  language={mode}
                  value={value}
                  theme={theme}
                  options={{
                    readOnly: !isEditing,
                    fontSize: 12,
                    lineNumbersMinChars: 3,
                    glyphMargin: false,
                    accessibilitySupport: 'off',
                  }}
                  onMount={(editor) => {
                    editorRef.current = editor;
                  }}
                />
              </>
            ) : (
              <UnsupportedFilePreview onForceOpen={handleForceOpen} />
            )}
          </SplitPane>
        )}
        {isPhone && (
          <CodeMirror
            value={value}
            extensions={
              mode ? [langs[mode as keyof typeof langs]()] : undefined
            }
            theme={theme.includes('dark') ? 'dark' : 'light'}
            readOnly={!isEditing}
            onChange={(value) => {
              setValue(value);
            }}
          />
        )}
        {isLogModalVisible && isLogModalVisible && (
          <EditModal
            treeData={data}
            currentNode={currentNode}
            content={value}
            handleCancel={() => {
              setIsLogModalVisible(false);
              if (currentNode && isLocked) {
                releaseFileLock(currentNode);
                setIsLocked(false);
              }
              pendingNodeRef.current = null;
              pendingFilePathRef.current = null;
              setPendingAction(null);
            }}
          />
        )}
        {isAddFileModalVisible && (
          <EditScriptNameModal
            treeData={data}
            handleCancel={addFileModalClose}
          />
        )}
        {isRenameFileModalVisible && (
          <RenameModal
            handleCancel={handleRenameFileCancel}
            currentNode={currentNode}
          />
        )}
      </div>
    </PageContainer>
  );
};

export default Script;
