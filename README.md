# 装修需求采集 Agent（Vercel）

一个可直接部署到 Vercel 的“有温度”装修需求采集 Agent：

- 与业主自然聊天（避免机器人盘问）
- **流式输出**（边生成边显示）
- **多模态输入**（支持上传参考图）
- 自动更新结构化需求卡片（预算/户型/风格/硬约束等）
- 基于参考图自动给出“以图搜灵感”检索词与链接

## 1) 环境变量

在本地或 Vercel 设置：

- `KIMI_API_KEY`
- `KIMI_BASE_URL`（默认 `https://api2.aigcbest.top/v1`）
- `KIMI_MODEL`（默认 `kimi-k2.5`）

> 不要把密钥写进代码仓库。

## 2) 本地调试（可选）

```bash
bunx vercel dev
```

打开 `http://localhost:3000`。

## 3) 部署到 Vercel

```bash
# 首次登录
bunx vercel login

# 在项目目录执行
bunx vercel

# 正式发布
bunx vercel --prod
```

部署后，在 Vercel 控制台补齐环境变量：

- `KIMI_API_KEY`
- `KIMI_BASE_URL`
- `KIMI_MODEL`

## 4) API

### 4.1 标准模式

- `POST /api/chat`

请求体：

```json
{
  "messages": [{"role":"user|assistant","content":"...","images":["data:image/jpeg;base64,..."]}],
  "profile": {}
}
```

返回：

```json
{
  "reply": "...",
  "profile": {"completeness": 68},
  "imageSearch": {"queries": []}
}
```

### 4.2 流式模式

- `POST /api/chat?stream=1`
- 返回 `text/event-stream`
- 事件类型：
  - `delta`：增量文本
  - `done`：最终结果（包含 profile / imageSearch）
  - `error`：错误
