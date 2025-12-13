import {fileExist, readDirs, readDir, rmPath, IFile, getToken} from '../config/util';
import { Router, Request, Response, NextFunction } from 'express';
import { Container } from 'typedi';
import { Logger } from 'winston';
import config from '../config';
import * as fs from 'fs/promises';
import { celebrate, Joi } from 'celebrate';
import path, { join, parse } from 'path';
import ScriptService from '../services/script';
import LockService from '../services/lock';
import SockService from '../services/sock';
import multer from 'multer';
import { writeFileWithLock } from '../shared/utils';
import { SockMessage } from '../data/sock';
import { shareStore } from '../shared/store';
const route = Router();

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, config.scriptPath);
  },
  filename: function (req, file, cb) {
    cb(null, file.originalname);
  },
});
const upload = multer({ storage: storage });

export default (app: Router) => {
  app.use('/scripts', route);

  route.get(
    '/',
    celebrate({
      query: Joi.object({
        path: Joi.string().optional().allow(''),
      }).unknown(true),
    }),
    async (req: Request, res: Response, next: NextFunction) => {
      const logger: Logger = Container.get('logger');
      try {
        let result: IFile[] = [];
        const blacklist = [
          'node_modules',
          '.git',
          '.pnpm',
          'pnpm-lock.yaml',
          'yarn.lock',
          'package-lock.json',
        ];
        if (req.query.path) {
          result = await readDir(
            req.query.path as string,
            config.scriptPath,
            blacklist,
          );
        } else {
          result = await readDirs(
            config.scriptPath,
            config.scriptPath,
            blacklist,
            (a, b) => {
              if (a.type === b.type) {
                return a.title.localeCompare(b.title);
              } else {
                return a.type === 'directory' ? -1 : 1;
              }
            },
          );
        }
        res.send({
          code: 200,
          data: result,
        });
      } catch (e) {
        logger.error('🔥 error: %o', e);
        return next(e);
      }
    },
  );

  route.get(
    '/detail',
    celebrate({
      query: Joi.object({
        path: Joi.string().optional().allow(''),
        file: Joi.string().required(),
      }).unknown(true),
    }),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const scriptService = Container.get(ScriptService);
        const content = await scriptService.getFile(
          (req.query?.path as string) || '',
          req.query.file as string,
        );
        
        // 获取锁状态
        const lockService = Container.get(LockService);
        const clientId = req.headers['x-client-id'] as string;
        const filePath = scriptService.checkFilePath(
          (req.query?.path as string) || '',
          req.query.file as string,
        );
        
        const lockInfo = {
          isLocked: false,
          isOwnLock: false,
          lockedBy: null as string | null,
        };

        if (filePath) {
          const lock = lockService.getLockInfo(filePath);
          if (lock) {
            lockInfo.lockedBy = lock.username;
            lockInfo.isOwnLock = !!clientId && lock.clientId === clientId;
            lockInfo.isLocked = !lockInfo.isOwnLock;
          }
        }
        
        res.send({ code: 200, data: { content, lockInfo } });
      } catch (e) {
        return next(e);
      }
    },
  );

  route.get(
    '/:file',
    celebrate({
      params: Joi.object({
        file: Joi.string().required(),
      }).unknown(true),
      query: Joi.object({
        path: Joi.string().optional().allow(''),
      }).unknown(true),
    }),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const scriptService = Container.get(ScriptService);
        const content = await scriptService.getFile(
          (req.query?.path as string) || '',
          req.params.file,
        );
        res.send({ code: 200, data: content });
      } catch (e) {
        return next(e);
      }
    },
  );

  route.post(
    '/',
    upload.single('file'),
    celebrate({
      body: Joi.object({
        filename: Joi.string().required(),
        path: Joi.string().optional().allow(''),
        content: Joi.string().optional().allow(''),
        originFilename: Joi.string().optional().allow(''),
        directory: Joi.string().optional().allow('')
      }).unknown(true),
    }),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        let { filename, path, content, originFilename, directory } =
          req.body as {
            filename: string;
            path: string;
            content: string;
            originFilename: string;
            directory: string;
          };

        const clientRelativePath = path || '';

        if (!path) {
          path = config.scriptPath;
        }
        if (!path.endsWith('/')) {
          path += '/';
        }
        if (!path.startsWith('/')) {
          path = join(config.scriptPath, path);
        }
        if (config.writePathList.every((x) => !path.startsWith(x))) {
          return res.send({
            code: 403,
            message: '暂无权限',
          });
        }

        if (req.file) {
          await fs.rename(req.file.path, join(path, filename));
          return res.send({ code: 200 });
        }

        if (directory) {
          await fs.mkdir(join(path, directory), { recursive: true });
          return res.send({ code: 200 });
        }

        if (!originFilename) {
          originFilename = filename;
        }
        const originFilePath = join(
          path,
          `${originFilename.replace(/\//g, '')}`,
        );
        const filePath = join(path, `${filename.replace(/\//g, '')}`);
        
        // 锁校验
        const clientId = req.headers['x-client-id'] as string;
        if (clientId) {
          const lockService = Container.get(LockService);
          if (lockService.isLocked(filePath, clientId)) {
            const lockInfo = lockService.getLockInfo(filePath);
            return res.send({
              code: 409,
              message: `文件正在被用户 ${lockInfo?.username} 编辑，无法保存`,
            });
          }
        }
        
        const fileExists = await fileExist(filePath);
        if (fileExists) {
          await fs.copyFile(
            originFilePath,
            join(config.bakPath, originFilename.replace(/\//g, '')),
          );
          if (filename !== originFilename) {
            await rmPath(originFilePath);
          }
        }
        await writeFileWithLock(filePath, content);

        const sockService = Container.get(SockService);

        // 新建文件：立即为创建者加锁并广播，避免其他端抢占编辑/调试
        if (!fileExists && clientId) {
          const authInfo = await shareStore.getAuthInfo();
          const username = authInfo?.username || '';
          const lockService = Container.get(LockService);
          lockService.acquire(filePath, clientId, username);
          sockService.broadcastLockStatus();
        }

        // 广播：文件内容已更新（用于其他端提示刷新）
        const clientFilePath = ['/ql/data/scripts', clientRelativePath, filename]
          .filter(Boolean)
          .join('/')
          .replace(/\/+/g, '/');
        sockService.sendMessage(
          new SockMessage({
            type: 'scriptUpdated',
            filePath: clientFilePath,
            clientId,
          }),
        );

        return res.send({ code: 200 });
      } catch (e) {
        return next(e);
      }
    },
  );

  route.put(
    '/',
    celebrate({
      body: Joi.object({
        filename: Joi.string().required(),
        path: Joi.string().optional().allow(''),
        content: Joi.string().required().allow(''),
      }).unknown(true),
    }),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        let { filename, content, path } = req.body as {
          filename: string;
          content: string;
          path: string;
        };
        const scriptService = Container.get(ScriptService);
        const filePath = scriptService.checkFilePath(path, filename);
        if (!filePath) {
          return res.send({
            code: 403,
            message: '暂无权限',
          });
        }
        
        // 锁校验
        const clientId = req.headers['x-client-id'] as string;
        if (clientId) {
          const lockService = Container.get(LockService);
          if (lockService.isLocked(filePath, clientId)) {
            const lockInfo = lockService.getLockInfo(filePath);
            return res.send({
              code: 409,
              message: `文件正在被用户 ${lockInfo?.username} 编辑，无法保存`,
            });
          }
        }
        
        await writeFileWithLock(filePath, content);

        // 广播：文件内容已更新（用于其他端提示刷新）
        const sockService = Container.get(SockService);
        const clientFilePath = ['/ql/data/scripts', path || '', filename]
          .filter(Boolean)
          .join('/')
          .replace(/\/+/g, '/');
        sockService.sendMessage(
          new SockMessage({
            type: 'scriptUpdated',
            filePath: clientFilePath,
            clientId,
          }),
        );

        return res.send({ code: 200 });
      } catch (e) {
        return next(e);
      }
    },
  );

  route.delete(
    '/',
    celebrate({
      body: Joi.object({
        filename: Joi.string().required(),
        path: Joi.string().optional().allow(''),
        type: Joi.string().optional(),
      }).unknown(true),
    }),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        let { filename, path } = req.body as {
          filename: string;
          path: string;
        };
        if (!path) {
          path = '';
        }
        const scriptService = Container.get(ScriptService);
        const filePath = scriptService.checkFilePath(path, filename);
        if (!filePath) {
          return res.send({
            code: 403,
            message: '暂无权限',
          });
        }
        
        const clientId = req.headers['x-client-id'] as string;
        if (clientId) {
          const lockService = Container.get(LockService);
          if (lockService.isLocked(filePath, clientId)) {
            const lockInfo = lockService.getLockInfo(filePath);
            return res.send({
              code: 409,
              message: `文件正在被用户 ${lockInfo?.username} 编辑，无法删除`,
            });
          }
        }
        await rmPath(filePath);

        // 广播：文件已被删除（用于其他端提示）
        const sockService = Container.get(SockService);
        const clientFilePath = ['/ql/data/scripts', path, filename]
          .filter(Boolean)
          .join('/')
          .replace(/\/+/g, '/');

        sockService.sendMessage(
          new SockMessage({
            type: 'scriptDeleted',
            filePath: clientFilePath,
            clientId,
          }),
        );

        res.send({ code: 200 });
      } catch (e) {
        return next(e);
      }
    },
  );

  route.post(
    '/download',
    celebrate({
      body: Joi.object({
        filename: Joi.string().required(),
        path: Joi.string().optional().allow(''),
      }).unknown(true),
    }),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        let { filename, path } = req.body as {
          filename: string;
          path: string;
        };
        if (!path) {
          path = '';
        }
        const scriptService = Container.get(ScriptService);
        const filePath = scriptService.checkFilePath(path, filename);
        if (!filePath) {
          return res.send({
            code: 403,
            message: '暂无权限',
          });
        }
        return res.download(filePath, filename, (err) => {
          if (err) {
            return next(err);
          }
        });
      } catch (e) {
        return next(e);
      }
    },
  );

  route.put(
    '/run',
    celebrate({
      body: Joi.object({
        filename: Joi.string().required(),
        content: Joi.string().optional().allow(''),
        path: Joi.string().optional().allow(''),
      }).unknown(true),
    }),
    async (req: Request, res: Response, next: NextFunction) => {
      const logger: Logger = Container.get('logger');
      try {
        let { filename, content, path } = req.body;
        const loginToken = getToken(req);
        if (!path) {
          path = '';
        }
        const { name, ext } = parse(filename);
        const filePath = join(config.scriptPath, path, `${name}.swap${ext}`);
        
        // 锁校验
        const clientId = req.headers['x-client-id'] as string;
        const originalFilePath = join(config.scriptPath, path, filename);
        if (clientId) {
          const lockService = Container.get(LockService);
          if (lockService.isLocked(originalFilePath, clientId)) {
            const lockInfo = lockService.getLockInfo(originalFilePath);
            return res.send({
              code: 409,
              message: `文件正在被用户 ${lockInfo?.username} 编辑，无法运行`,
            });
          }
        }
        
        await writeFileWithLock(filePath, content || '');

        const scriptService = Container.get(ScriptService);
        const result = await scriptService.runScript(filePath, loginToken);
        res.send(result);
      } catch (e) {
        return next(e);
      }
    },
  );

  route.put(
    '/stop',
    celebrate({
      body: Joi.object({
        filename: Joi.string().required(),
        path: Joi.string().optional().allow(''),
        pid: Joi.number().optional().allow(''),
      }).unknown(true),
    }),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        let { filename, path, pid } = req.body;
        if (!path) {
          path = '';
        }
        const { name, ext } = parse(filename);
        const filePath = join(config.scriptPath, path, `${name}.swap${ext}`);
        const logPath = join(config.logPath, path, `${name}.swap`);

        const scriptService = Container.get(ScriptService);
        const result = await scriptService.stopScript(filePath, pid);
        setTimeout(() => {
          rmPath(logPath);
        }, 3000);
        res.send(result);
      } catch (e) {
        return next(e);
      }
    },
  );

  route.put(
    '/rename',
    celebrate({
      body: Joi.object({
        filename: Joi.string().required(),
        path: Joi.string().allow(''),
        newFilename: Joi.string().required(),
      }).unknown(true),
    }),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        let { filename, path, newFilename } = req.body as {
          filename: string;
          path: string;
          newFilename: string;
        };
        if (!path) {
          path = '';
        }
        const scriptService = Container.get(ScriptService);
        const filePath = scriptService.checkFilePath(path, filename);
        if (!filePath) {
          return res.send({
            code: 403,
            message: '暂无权限',
          });
        }
        const newPath = join(config.scriptPath, path, newFilename);

        const clientId = req.headers['x-client-id'] as string;
        if (clientId) {
          const lockService = Container.get(LockService);
          if (lockService.isLocked(filePath, clientId)) {
            const lockInfo = lockService.getLockInfo(filePath);
            return res.send({
              code: 409,
              message: `文件正在被用户 ${lockInfo?.username} 编辑，无法重命名`,
            });
          }
        }
        
        await fs.rename(filePath, newPath);

        // 广播：文件已被重命名（用于其他端提示）
        const sockService = Container.get(SockService);
        const oldClientFilePath = ['/ql/data/scripts', path, filename]
          .filter(Boolean)
          .join('/')
          .replace(/\/+/g, '/');
        const newClientFilePath = ['/ql/data/scripts', path, newFilename]
          .filter(Boolean)
          .join('/')
          .replace(/\/+/g, '/');

        sockService.sendMessage(
          new SockMessage({
            type: 'scriptRenamed',
            oldFilePath: oldClientFilePath,
            newFilePath: newClientFilePath,
            clientId,
          }),
        );

        res.send({ code: 200 });
      } catch (e) {
        return next(e);
      }
    },
  );
};
