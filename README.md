# 密语空间

只供两个人使用的轻量私密留言空间。普通 Node.js 服务同时提供前端和 API，消息写入数据库前使用 AES-256-GCM 加密。

## 本地启动

需要 Node.js 22 或更高版本。

```bash
npm install
npm run setup
npm run dev
```

打开 `http://localhost:3000`。SQLite 数据默认保存在 `data/secret-space.db`，服务首次启动时会自动建表。

## 数据库

默认使用 SQLite，无需安装数据库服务：

```env
DATABASE_DRIVER=sqlite
SQLITE_PATH=./data/secret-space.db
```

切换 MySQL 只需修改 `.env`：

```env
DATABASE_DRIVER=mysql
MYSQL_URL=mysql://secret_space:password@127.0.0.1:3306/secret_space
```

MySQL 数据库本身需要提前创建，应用会自动创建 `messages` 表。两种数据库使用相同的字段和密文格式。

### 从 D1 导入已有消息

D1 导出的数据库本身也是 SQLite 文件，可直接导入到新的 SQLite 数据库：

```bash
npm run migrate:d1 -- path/to/d1-database.sqlite
```

目标路径默认读取 `.env` 中的 `SQLITE_PATH`。脚本可重复执行，已经存在的消息不会重复插入。迁移后必须继续使用原来的 `CONTENT_ENCRYPTION_KEY`，否则旧密文无法解密。

## Docker 部署

先运行 `npm run setup` 生成 `.env`，将 `COOKIE_SECURE` 改为 `true`，再启动：

```bash
docker compose up -d --build
```

SQLite 数据保存在 Docker volume `secret-space-data`。生产环境应在服务前配置 Caddy、Nginx 或其他 HTTPS 反向代理。

## 常用命令

```bash
npm run typecheck
npm test
npm run build
npm start
```

`.env`、数据库文件和本地密钥均已被 Git 忽略，不会提交到仓库。
