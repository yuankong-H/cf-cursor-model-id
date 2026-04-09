# cf-cursor-model-id

一个 Cloudflare Worker，小界面负责生成 Cursor 配置和测试 curl，同时把请求透明转发到 OpenAI 或 Anthropic 风格的上游接口。

## 一键部署

把这个项目发布到公开的 GitHub 或 GitLab 仓库后，将下面按钮里的 `<YOUR_PUBLIC_REPO_URL>` 替换成你的仓库地址，就可以启用 Cloudflare 的一键部署：

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=<YOUR_PUBLIC_REPO_URL>)

例如，如果仓库地址是 `https://github.com/yourname/cf-cursor-model-id`，那么按钮链接应改成：

```md
[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/yourname/cf-cursor-model-id)
```

使用这个按钮时，Cloudflare 会引导用户复制仓库、配置 Worker 名称并直接部署到自己的账号下。

## 功能

- `GET /` 返回一个中文表单页
- `POST /:encodedProvider/:encodedModel/:reasoningToken/v1/chat/completions` 代理 OpenAI 风格请求
- `POST /:encodedProvider/:encodedModel/v1/messages` 代理 Anthropic 风格请求
- `Provider地址` 和 `模型 ID` 会被 `base64url` 编码到路径里
- OpenAI 的 `reasoningToken` 使用明文路径段，支持 `low | medium | high | xhigh | force-low | force-medium | force-high | force-xhigh`
- Worker 不保存 Provider 密钥，只透传运行时请求头

## 开发

```bash
npm install
npm run dev
```

默认本地地址一般是 `http://127.0.0.1:8787`。

## 部署

```bash
npm install
npm run deploy
```

如果你希望其他人通过 README 直接一键部署，请优先把仓库发布到公开 GitHub/GitLab，然后使用上面的 `Deploy to Cloudflare` 按钮。

首次部署前请先登录 Cloudflare：

```bash
npx wrangler login
```

## 页面使用

1. 打开 Worker 首页。
2. 填写：
   - `Provider地址`：上游完整前缀，例如 `https://api.openai.com/v1`
   - `Provider密钥`
   - `模型 ID`：真实上游模型 ID，例如 `gpt-4o-mini`
   - `类型`：`openai` 或 `anthropic`
   - 如果类型是 `openai`，还可以选择 `思考等级`，并按需勾选 `强制思考`
3. 点击 `生成 Cursor配置` 查看：
   - OpenAI 地址：`当前 host / 编码后的Provider地址 / 编码后的模型ID / 思考等级 / v1`
   - Anthropic 地址：`当前 host / 编码后的Provider地址 / 编码后的模型ID / v1`
   - 模型 id：`openai-123` 或 `claude-123`
   - 密钥：你刚输入的 Provider 密钥
4. 点击 `测试` 查看对应类型的 curl 示例。

## 运行时约定

- 外部暴露模型别名：
  - OpenAI: `openai-123`
  - Anthropic: `claude-123`
- Worker 会把请求体中的 `model` 改写成真实的 Provider 模型 ID。
- OpenAI 请求的 `reasoning_effort` 规则：
  - 普通等级 URL：如果请求体没带 `reasoning_effort`，Worker 会补成 URL 中的等级
  - `force-*` URL：Worker 会无条件改写为 URL 中去掉 `force-` 之后的等级
- OpenAI 代理要求来访请求带 `Authorization: Bearer ...`
- Anthropic 代理优先读取 `x-api-key`，如果没有则尝试从 `Authorization: Bearer ...` 提取 token
- Anthropic 请求会默认补上 `anthropic-version: 2023-06-01`

## 测试

```bash
npm install
npm run check
npm run test
```
