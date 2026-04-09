const MODEL_ALIASES = {
  openai: "openai-123",
  anthropic: "claude-123",
} as const;

type ProviderType = keyof typeof MODEL_ALIASES;
type OpenAIReasoningLevel = (typeof OPENAI_REASONING_LEVELS)[number];

const DEFAULT_ANTHROPIC_VERSION = "2023-06-01";
const OPENAI_REASONING_LEVELS = ["low", "medium", "high", "xhigh"] as const;
const FORCE_REASONING_PREFIX = "force-";
const OPENAI_REASONING_TOKENS = [
  ...OPENAI_REASONING_LEVELS,
  ...OPENAI_REASONING_LEVELS.map(
    (level) => `${FORCE_REASONING_PREFIX}${level}` as const,
  ),
] as const;
const OPENAI_REASONING_TOKEN_HINT = OPENAI_REASONING_TOKENS.join(", ");

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-allow-headers":
    "authorization,x-api-key,anthropic-version,content-type",
  "access-control-max-age": "86400",
};

class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

interface BaseProxyRoute {
  encodedProvider: string;
  encodedModel: string;
}

interface OpenAIProxyRoute extends BaseProxyRoute {
  type: "openai";
  reasoningToken: string;
}

interface AnthropicProxyRoute extends BaseProxyRoute {
  type: "anthropic";
}

type ProxyRoute = OpenAIProxyRoute | AnthropicProxyRoute;

interface RouteParseResult {
  route: ProxyRoute | null;
  error: string | null;
}

export default {
  async fetch(request: Request): Promise<Response> {
    return handleRequest(request);
  },
};

export async function handleRequest(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const { route, error } = parseProxyRoute(url.pathname);

  if (request.method === "OPTIONS") {
    if (error) {
      return jsonError(400, error);
    }
    if (url.pathname === "/" || route) {
      return withCors(new Response(null, { status: 204 }));
    }
    return withCors(notFound());
  }

  if (request.method === "GET" && url.pathname === "/") {
    return withCors(
      new Response(renderHomePage(), {
        status: 200,
        headers: {
          "content-type": "text/html; charset=utf-8",
        },
      }),
    );
  }

  if (error) {
    return jsonError(400, error);
  }

  if (request.method === "POST" && route) {
    try {
      return await proxyRequest(request, url, route);
    } catch (error) {
      if (error instanceof HttpError) {
        return jsonError(error.status, error.message);
      }
      return jsonError(502, "转发上游请求失败。");
    }
  }

  return withCors(notFound());
}

async function proxyRequest(
  request: Request,
  url: URL,
  route: ProxyRoute,
): Promise<Response> {
  const providerUrl = decodeBase64Url(route.encodedProvider);
  const modelId = decodeBase64Url(route.encodedModel);

  validateProviderUrl(providerUrl);
  assertNonEmpty(modelId, "模型 ID 不能为空。");

  const payload = await parseJsonObject(request);
  const incomingModel = payload.model;

  if (typeof incomingModel !== "string" || incomingModel.trim() === "") {
    throw new HttpError(400, "请求体里的 model 必须是非空字符串。");
  }

  payload.model = modelId;

  if (route.type === "openai") {
    applyOpenAIReasoning(payload, route.reasoningToken);
  }

  const endpoint =
    route.type === "openai" ? "chat/completions" : "messages";
  const upstreamUrl = `${joinUrl(providerUrl, endpoint)}${url.search}`;
  const upstreamHeaders = buildUpstreamHeaders(request.headers, route.type);

  const upstreamResponse = await fetch(upstreamUrl, {
    method: "POST",
    headers: upstreamHeaders,
    body: JSON.stringify(payload),
  });

  return withCors(cloneResponse(upstreamResponse));
}

function buildUpstreamHeaders(
  sourceHeaders: Headers,
  type: ProviderType,
): Headers {
  const headers = new Headers();

  for (const [key, value] of sourceHeaders.entries()) {
    const lowerKey = key.toLowerCase();

    if (
      lowerKey === "host" ||
      lowerKey === "content-length" ||
      lowerKey === "authorization" ||
      lowerKey === "x-api-key" ||
      lowerKey === "anthropic-version"
    ) {
      continue;
    }

    headers.set(key, value);
  }

  headers.set("content-type", "application/json");

  if (type === "openai") {
    const authorization = sourceHeaders.get("authorization")?.trim();

    if (!authorization) {
      throw new HttpError(400, "OpenAI 请求需要 Authorization 请求头。");
    }

    headers.set("authorization", authorization);
    return headers;
  }

  const directApiKey = sourceHeaders.get("x-api-key")?.trim();
  const bearerToken = extractBearerToken(sourceHeaders.get("authorization"));
  const apiKey = directApiKey || bearerToken;

  if (!apiKey) {
    throw new HttpError(
      400,
      "Anthropic 请求需要 x-api-key 或 Authorization: Bearer <token>。",
    );
  }

  headers.set("x-api-key", apiKey);
  headers.set(
    "anthropic-version",
    sourceHeaders.get("anthropic-version")?.trim() ||
      DEFAULT_ANTHROPIC_VERSION,
  );

  return headers;
}

function extractBearerToken(value: string | null): string | null {
  if (!value) {
    return null;
  }

  const match = value.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

async function parseJsonObject(
  request: Request,
): Promise<Record<string, unknown>> {
  let body: unknown;

  try {
    body = await request.json();
  } catch {
    throw new HttpError(400, "请求体必须是合法 JSON。");
  }

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new HttpError(400, "请求体必须是 JSON 对象。");
  }

  return { ...(body as Record<string, unknown>) };
}

function parseProxyRoute(pathname: string): RouteParseResult {
  const parts = pathname.split("/").filter(Boolean);

  if (
    parts.length === 6 &&
    parts[3] === "v1" &&
    parts[4] === "chat" &&
    parts[5] === "completions"
  ) {
    if (!isValidOpenAIReasoningToken(parts[2])) {
      return {
        route: null,
        error: `OpenAI 思考等级无效，只支持: ${OPENAI_REASONING_TOKEN_HINT}`,
      };
    }

    return {
      route: {
        type: "openai",
        encodedProvider: parts[0],
        encodedModel: parts[1],
        reasoningToken: parts[2],
      },
      error: null,
    };
  }

  if (
    parts.length === 5 &&
    parts[2] === "v1" &&
    parts[3] === "chat" &&
    parts[4] === "completions"
  ) {
    return {
      route: null,
      error:
        "OpenAI 路径缺少思考等级，请使用 /{encodedProvider}/{encodedModel}/{reasoningToken}/v1/chat/completions。",
    };
  }

  if (parts.length === 4 && parts[2] === "v1" && parts[3] === "messages") {
    return {
      route: {
        type: "anthropic",
        encodedProvider: parts[0],
        encodedModel: parts[1],
      },
      error: null,
    };
  }

  return {
    route: null,
    error: null,
  };
}

function isValidOpenAIReasoningToken(
  value: string,
): value is (typeof OPENAI_REASONING_TOKENS)[number] {
  return OPENAI_REASONING_TOKENS.includes(
    value as (typeof OPENAI_REASONING_TOKENS)[number],
  );
}

function isValidOpenAIReasoningLevel(
  value: string,
): value is OpenAIReasoningLevel {
  return OPENAI_REASONING_LEVELS.includes(value as OpenAIReasoningLevel);
}

function parseOpenAIReasoningToken(token: string): {
  normalizedReasoning: OpenAIReasoningLevel;
  isForced: boolean;
} {
  if (!isValidOpenAIReasoningToken(token)) {
    throw new HttpError(
      400,
      `OpenAI 思考等级无效，只支持: ${OPENAI_REASONING_TOKEN_HINT}`,
    );
  }

  if (token.startsWith(FORCE_REASONING_PREFIX)) {
    const normalized = token.slice(FORCE_REASONING_PREFIX.length);

    if (!isValidOpenAIReasoningLevel(normalized)) {
      throw new HttpError(
        400,
        `OpenAI 思考等级无效，只支持: ${OPENAI_REASONING_TOKEN_HINT}`,
      );
    }

    return {
      normalizedReasoning: normalized,
      isForced: true,
    };
  }

  return {
    normalizedReasoning: token as OpenAIReasoningLevel,
    isForced: false,
  };
}

function applyOpenAIReasoning(
  payload: Record<string, unknown>,
  reasoningToken: string,
): void {
  const { normalizedReasoning, isForced } =
    parseOpenAIReasoningToken(reasoningToken);

  if (isForced) {
    payload.reasoning_effort = normalizedReasoning;
    return;
  }

  if (!Object.prototype.hasOwnProperty.call(payload, "reasoning_effort")) {
    payload.reasoning_effort = normalizedReasoning;
  }
}

function decodeBase64Url(input: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(input)) {
    throw new HttpError(400, "路径参数不是合法的 base64url 编码。");
  }

  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const remainder = normalized.length % 4;

  if (remainder === 1) {
    throw new HttpError(400, "路径参数不是合法的 base64url 编码。");
  }

  const padded = normalized.padEnd(
    normalized.length + ((4 - remainder) % 4),
    "=",
  );

  try {
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    const decoded = new TextDecoder().decode(bytes);

    assertNonEmpty(decoded, "解码后的值不能为空。");
    return decoded;
  } catch {
    throw new HttpError(400, "路径参数解码失败。");
  }
}

function validateProviderUrl(value: string): void {
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    throw new HttpError(400, "Provider地址 不是合法 URL。");
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new HttpError(400, "Provider地址 只支持 http 或 https。");
  }
}

function joinUrl(base: string, tail: string): string {
  return `${base.replace(/\/+$/, "")}/${tail.replace(/^\/+/, "")}`;
}

function assertNonEmpty(value: string, message: string): void {
  if (value.trim() === "") {
    throw new HttpError(400, message);
  }
}

function jsonError(status: number, message: string): Response {
  return withCors(
    new Response(JSON.stringify({ error: message }, null, 2), {
      status,
      headers: {
        "content-type": "application/json; charset=utf-8",
      },
    }),
  );
}

function notFound(): Response {
  return jsonError(404, "未找到对应路由。");
}

function withCors(response: Response): Response {
  const headers = new Headers(response.headers);

  for (const [key, value] of Object.entries(CORS_HEADERS)) {
    headers.set(key, value);
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function cloneResponse(response: Response): Response {
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: new Headers(response.headers),
  });
}

function renderHomePage(): string {
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Cursor Provider Relay</title>
    <style>
      :root {
        color-scheme: light;
        --bg: #f4efe4;
        --panel: rgba(255, 251, 244, 0.84);
        --panel-strong: #fff9ef;
        --text: #153035;
        --muted: #5d6d71;
        --line: rgba(21, 48, 53, 0.14);
        --accent: #005f73;
        --accent-strong: #0a9396;
        --accent-soft: rgba(10, 147, 150, 0.12);
        --warning: #bb3e03;
        --shadow: 0 24px 60px rgba(21, 48, 53, 0.14);
        --radius: 24px;
      }

      * {
        box-sizing: border-box;
      }

      body {
        margin: 0;
        min-height: 100vh;
        font-family: "IBM Plex Sans", "Noto Sans SC", "PingFang SC",
          "Microsoft YaHei", sans-serif;
        color: var(--text);
        background:
          radial-gradient(circle at top left, rgba(238, 155, 0, 0.28), transparent 34%),
          radial-gradient(circle at top right, rgba(10, 147, 150, 0.22), transparent 30%),
          linear-gradient(180deg, #f7f1e4 0%, #ede4d3 100%);
      }

      body::before {
        content: "";
        position: fixed;
        inset: 0;
        background-image:
          linear-gradient(rgba(255, 255, 255, 0.12) 1px, transparent 1px),
          linear-gradient(90deg, rgba(255, 255, 255, 0.12) 1px, transparent 1px);
        background-size: 32px 32px;
        opacity: 0.35;
        pointer-events: none;
      }

      main {
        position: relative;
        min-height: 100vh;
        display: grid;
        place-items: center;
        padding: 32px 16px;
      }

      .shell {
        width: min(100%, 960px);
      }

      .panel {
        border: 1px solid var(--line);
        border-radius: var(--radius);
        background: var(--panel);
        backdrop-filter: blur(16px);
        box-shadow: var(--shadow);
      }

      .panel {
        padding: 28px;
      }

      form {
        display: grid;
        gap: 18px;
      }

      .grid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 18px;
      }

      .field {
        display: grid;
        gap: 8px;
      }

      .field[hidden] {
        display: none;
      }

      .field.full {
        grid-column: 1 / -1;
      }

      label {
        font-size: 0.95rem;
        font-weight: 700;
      }

      input,
      select {
        width: 100%;
        padding: 14px 16px;
        border: 1px solid rgba(21, 48, 53, 0.12);
        border-radius: 16px;
        background: rgba(255, 255, 255, 0.72);
        color: var(--text);
        font: inherit;
        transition:
          border-color 160ms ease,
          box-shadow 160ms ease,
          transform 160ms ease;
      }

      select {
        appearance: none;
        padding-right: 52px;
        background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='14' height='14' viewBox='0 0 24 24' fill='none' stroke='%23005f73' stroke-width='2.2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E");
        background-repeat: no-repeat;
        background-position: right 18px center;
        background-size: 14px 14px;
      }

      input:focus,
      select:focus {
        outline: none;
        border-color: rgba(10, 147, 150, 0.55);
        box-shadow: 0 0 0 4px rgba(10, 147, 150, 0.12);
        transform: translateY(-1px);
      }

      .field small {
        color: var(--muted);
        line-height: 1.6;
      }

      .checkbox-row {
        display: flex;
        align-items: center;
        gap: 12px;
        min-height: 52px;
        padding: 14px 16px;
        border: 1px solid rgba(21, 48, 53, 0.12);
        border-radius: 16px;
        background: rgba(255, 255, 255, 0.72);
      }

      .checkbox-row input {
        width: 18px;
        height: 18px;
        margin: 0;
        accent-color: var(--accent-strong);
      }

      .checkbox-row span {
        font-weight: 700;
      }

      .actions {
        display: flex;
        flex-wrap: wrap;
        gap: 12px;
        align-items: center;
      }

      button {
        border: none;
        border-radius: 999px;
        padding: 13px 18px;
        font: inherit;
        font-weight: 700;
        cursor: pointer;
        transition:
          transform 160ms ease,
          box-shadow 160ms ease,
          opacity 160ms ease;
      }

      button:hover {
        transform: translateY(-1px);
      }

      button:active {
        transform: translateY(0);
      }

      .primary {
        color: white;
        background: linear-gradient(135deg, var(--accent) 0%, var(--accent-strong) 100%);
        box-shadow: 0 16px 30px rgba(0, 95, 115, 0.22);
      }

      .secondary {
        color: var(--accent);
        background: var(--accent-soft);
      }

      .ghost {
        color: var(--text);
        background: rgba(21, 48, 53, 0.08);
      }

      .overlay {
        position: fixed;
        inset: 0;
        display: none;
        align-items: center;
        justify-content: center;
        padding: 16px;
        background: rgba(21, 48, 53, 0.42);
        backdrop-filter: blur(8px);
      }

      .overlay[data-open="true"] {
        display: flex;
      }

      .modal {
        width: min(100%, 860px);
        max-height: min(88vh, 900px);
        overflow: hidden;
        padding: 20px;
        border-radius: 28px;
        background: var(--panel-strong);
        border: 1px solid rgba(21, 48, 53, 0.1);
        box-shadow: 0 28px 80px rgba(21, 48, 53, 0.28);
      }

      .modal-header {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 16px;
        margin-bottom: 14px;
      }

      .modal-title {
        margin: 0;
        font-size: 1.2rem;
      }

      .modal-subtitle {
        margin: 6px 0 0;
        color: var(--muted);
        line-height: 1.6;
      }

      .modal-body {
        max-height: min(60vh, 640px);
        overflow: auto;
        padding-right: 6px;
        scrollbar-width: thin;
        scrollbar-color: rgba(10, 147, 150, 0.78) rgba(21, 48, 53, 0.08);
      }

      .modal-body::-webkit-scrollbar {
        width: 12px;
      }

      .modal-body::-webkit-scrollbar-track {
        border-radius: 999px;
        background: rgba(21, 48, 53, 0.08);
      }

      .modal-body::-webkit-scrollbar-thumb {
        border: 2px solid rgba(255, 249, 239, 0.9);
        border-radius: 999px;
        background: linear-gradient(
          180deg,
          rgba(10, 147, 150, 0.95) 0%,
          rgba(0, 95, 115, 0.92) 100%
        );
      }

      .modal-body::-webkit-scrollbar-thumb:hover {
        background: linear-gradient(
          180deg,
          rgba(10, 147, 150, 1) 0%,
          rgba(0, 95, 115, 1) 100%
        );
      }

      pre {
        margin: 0;
        padding: 18px;
        border-radius: 20px;
        background: #13292d;
        color: #f8f6ef;
        white-space: pre-wrap;
        word-break: break-word;
        overflow-wrap: anywhere;
        font-family: "IBM Plex Mono", "SFMono-Regular", "Menlo", monospace;
        font-size: 0.92rem;
        line-height: 1.75;
      }

      .modal-actions {
        display: flex;
        justify-content: flex-end;
        gap: 12px;
        margin-top: 16px;
      }

      @media (max-width: 760px) {
        .panel {
          padding: 20px;
        }

        .grid {
          grid-template-columns: 1fr;
        }

        .actions {
          align-items: stretch;
        }

        button {
          width: 100%;
        }

        .modal-header {
          flex-direction: column;
        }

        .modal-actions {
          flex-direction: column-reverse;
        }
      }
    </style>
  </head>
  <body>
    <main>
      <div class="shell">
        <section class="panel">
          <form id="relay-form">
            <div class="grid">
              <div class="field full">
                <label for="provider-url">Provider地址</label>
                <input
                  id="provider-url"
                  name="provider-url"
                  type="url"
                  inputmode="url"
                  required
                  spellcheck="false"
                  placeholder="https://api.openai.com/v1"
                />
                <small>这里按完整上游前缀填写，Worker 只会继续追加 <code>chat/completions</code> 或 <code>messages</code>。</small>
              </div>

              <div class="field">
                <label for="provider-key">Provider密钥</label>
                <input
                  id="provider-key"
                  name="provider-key"
                  type="password"
                  required
                  spellcheck="false"
                  placeholder="sk-..."
                />
                <small>只用于生成展示内容，页面不会保存或提交这个密钥。</small>
              </div>

              <div class="field">
                <label for="model-id">模型 ID</label>
                <input
                  id="model-id"
                  name="model-id"
                  type="text"
                  required
                  spellcheck="false"
                  placeholder="gpt-4o-mini 或 claude-sonnet-4-20250514"
                />
                <small>这里填真实上游模型名，外部对 Cursor 暴露的是固定别名。</small>
              </div>

              <div class="field">
                <label for="provider-type">类型</label>
                <select id="provider-type" name="provider-type">
                  <option value="openai">openai</option>
                  <option value="anthropic">anthropic</option>
                </select>
                <small id="alias-hint">当前对外模型别名：openai-123</small>
              </div>

              <div class="field" id="reasoning-level-field">
                <label for="reasoning-level">思考等级</label>
                <select id="reasoning-level" name="reasoning-level">
                  <option value="low">low</option>
                  <option value="medium" selected>medium</option>
                  <option value="high">high</option>
                  <option value="xhigh">xhigh</option>
                </select>
                <small>只在 openai 类型下生效，会进入 URL 里的思考等级段。</small>
              </div>

              <div class="field" id="force-reasoning-field">
                <label for="force-reasoning">强制思考</label>
                <label class="checkbox-row">
                  <input
                    id="force-reasoning"
                    name="force-reasoning"
                    type="checkbox"
                  />
                  <span id="force-reasoning-status">开启强制思考｜已关闭</span>
                </label>
                <small>强制模式下，请求体里的 <code>reasoning_effort</code> 会被 URL 覆盖。</small>
              </div>
            </div>

            <div class="actions">
              <button type="button" class="primary" id="generate-config">生成 Cursor配置</button>
              <button type="button" class="secondary" id="show-test">测试</button>
            </div>
          </form>
        </section>
      </div>
    </main>

    <div class="overlay" id="modal-overlay" aria-hidden="true">
      <div class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title">
        <div class="modal-header">
          <div>
            <h2 class="modal-title" id="modal-title">结果</h2>
            <p class="modal-subtitle" id="modal-subtitle">这里会显示生成结果。</p>
          </div>
          <button type="button" class="ghost" id="close-modal">关闭</button>
        </div>
        <div class="modal-body">
          <pre id="modal-content"></pre>
        </div>
        <div class="modal-actions">
          <button type="button" class="ghost" id="copy-modal">复制内容</button>
          <button type="button" class="primary" id="close-modal-footer">完成</button>
        </div>
      </div>
    </div>

    <script>
      const MODEL_ALIASES = {
        openai: "openai-123",
        anthropic: "claude-123",
      };

      const form = document.getElementById("relay-form");
      const providerUrlInput = document.getElementById("provider-url");
      const providerKeyInput = document.getElementById("provider-key");
      const modelIdInput = document.getElementById("model-id");
      const providerTypeSelect = document.getElementById("provider-type");
      const reasoningLevelField = document.getElementById("reasoning-level-field");
      const forceReasoningField = document.getElementById("force-reasoning-field");
      const reasoningLevelSelect = document.getElementById("reasoning-level");
      const forceReasoningInput = document.getElementById("force-reasoning");
      const forceReasoningStatus = document.getElementById("force-reasoning-status");
      const aliasHint = document.getElementById("alias-hint");
      const overlay = document.getElementById("modal-overlay");
      const modalTitle = document.getElementById("modal-title");
      const modalSubtitle = document.getElementById("modal-subtitle");
      const modalContent = document.getElementById("modal-content");
      const generateButton = document.getElementById("generate-config");
      const testButton = document.getElementById("show-test");
      const closeButtons = [
        document.getElementById("close-modal"),
        document.getElementById("close-modal-footer"),
      ];
      const copyButton = document.getElementById("copy-modal");

      function utf8ToBase64Url(value) {
        const bytes = new TextEncoder().encode(value);
        let binary = "";
        for (const byte of bytes) {
          binary += String.fromCharCode(byte);
        }

        return btoa(binary)
          .replace(/\\+/g, "-")
          .replace(/\\//g, "_")
          .replace(/=+$/g, "");
      }

      function getAlias(type) {
        return MODEL_ALIASES[type];
      }

      function buildReasoningToken(values) {
        if (values.providerType !== "openai") {
          return null;
        }

        return values.forceReasoning
          ? \`force-\${values.reasoningLevel}\`
          : values.reasoningLevel;
      }

      function getFormValues() {
        return {
          providerUrl: providerUrlInput.value.trim(),
          providerKey: providerKeyInput.value.trim(),
          modelId: modelIdInput.value.trim(),
          providerType: providerTypeSelect.value,
          reasoningLevel: reasoningLevelSelect.value,
          forceReasoning: forceReasoningInput.checked,
        };
      }

      function validateForm() {
        if (!form.reportValidity()) {
          return null;
        }

        const values = getFormValues();

        if (!values.providerUrl || !values.providerKey || !values.modelId) {
          return null;
        }

        return values;
      }

      function buildBaseUrl(values) {
        const encodedProvider = utf8ToBase64Url(values.providerUrl);
        const encodedModel = utf8ToBase64Url(values.modelId);
        const reasoningToken = buildReasoningToken(values);
        return {
          encodedProvider,
          encodedModel,
          baseUrl:
            values.providerType === "openai"
              ? \`\${window.location.origin}/\${encodedProvider}/\${encodedModel}/\${reasoningToken}/v1\`
              : \`\${window.location.origin}/\${encodedProvider}/\${encodedModel}/v1\`,
        };
      }

      function buildConfig(values) {
        const { baseUrl } = buildBaseUrl(values);
        return [
          \`地址: \${baseUrl}\`,
          \`模型 id: \${getAlias(values.providerType)}\`,
          \`密钥: \${values.providerKey}\`,
        ].join("\\n");
      }

      function buildOpenAICurl(values) {
        const { baseUrl } = buildBaseUrl(values);
        const lines = [
          \`curl --location '\${baseUrl}/chat/completions' \\\\\`,
          \`--header 'Authorization: Bearer \${values.providerKey}' \\\\\`,
          \`--header 'Content-Type: application/json' \\\\\`,
          "--data '{",
          '  \"messages\": [',
          "    {",
          '      \"content\": \"HI\",',
          '      \"role\": \"user\"',
          "    }",
          "  ],",
          \`  \"model\": \"\${MODEL_ALIASES.openai}\",\`,
        ];

        if (!values.forceReasoning) {
          lines.push(\`  \"reasoning_effort\": \"\${values.reasoningLevel}\",\`);
        }

        lines.push(
          '  \"stream\": true,',
          '  \"stream_options\": {',
          '    \"include_usage\": true',
          "  }",
          "}'",
        );

        return lines.join("\\n");
      }

      function buildAnthropicCurl(values) {
        const { baseUrl } = buildBaseUrl(values);
        return [
          \`curl --location '\${baseUrl}/messages' \\\\\`,
          \`--header 'x-api-key: \${values.providerKey}' \\\\\`,
          \`--header 'anthropic-version: 2023-06-01' \\\\\`,
          \`--header 'Content-Type: application/json' \\\\\`,
          "--data '{",
          \`  \"model\": \"\${MODEL_ALIASES.anthropic}\",\`,
          '  \"max_tokens\": 64,',
          '  \"messages\": [',
          "    {",
          '      \"role\": \"user\",',
          '      \"content\": \"HI\"',
          "    }",
          "  ],",
          '  \"stream\": true',
          "}'",
        ].join("\\n");
      }

      function buildTestCurl(values) {
        return values.providerType === "anthropic"
          ? buildAnthropicCurl(values)
          : buildOpenAICurl(values);
      }

      function showModal(title, subtitle, content) {
        modalTitle.textContent = title;
        modalSubtitle.textContent = subtitle;
        modalContent.textContent = content;
        overlay.dataset.open = "true";
        overlay.setAttribute("aria-hidden", "false");
      }

      function hideModal() {
        overlay.dataset.open = "false";
        overlay.setAttribute("aria-hidden", "true");
      }

      function refreshPreview() {
        const values = getFormValues();
        const isOpenAI = values.providerType === "openai";

        aliasHint.textContent = \`当前对外模型别名：\${getAlias(values.providerType)}\`;
        reasoningLevelField.hidden = !isOpenAI;
        forceReasoningField.hidden = !isOpenAI;
        forceReasoningStatus.textContent =
          isOpenAI && values.forceReasoning
            ? "开启强制思考｜已开启"
            : "开启强制思考｜已关闭";
      }

      generateButton.addEventListener("click", () => {
        const values = validateForm();
        if (!values) {
          return;
        }

        showModal(
          "Cursor配置",
          "把下面这组信息填进 Cursor 对应 Provider 配置即可。",
          buildConfig(values),
        );
      });

      testButton.addEventListener("click", () => {
        const values = validateForm();
        if (!values) {
          return;
        }

        const subtitle =
          values.providerType === "anthropic"
            ? "下面是 Anthropic 风格请求的测试 curl。"
            : "下面是 OpenAI 风格请求的测试 curl。";

        showModal("测试 curl", subtitle, buildTestCurl(values));
      });

      copyButton.addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(modalContent.textContent || "");
          copyButton.textContent = "已复制";
          window.setTimeout(() => {
            copyButton.textContent = "复制内容";
          }, 1400);
        } catch {
          copyButton.textContent = "复制失败";
          window.setTimeout(() => {
            copyButton.textContent = "复制内容";
          }, 1400);
        }
      });

      closeButtons.forEach((button) => {
        button.addEventListener("click", hideModal);
      });

      overlay.addEventListener("click", (event) => {
        if (event.target === overlay) {
          hideModal();
        }
      });

      document.addEventListener("keydown", (event) => {
        if (event.key === "Escape") {
          hideModal();
        }
      });

      [
        providerUrlInput,
        providerKeyInput,
        modelIdInput,
        providerTypeSelect,
        reasoningLevelSelect,
        forceReasoningInput,
      ].forEach((input) => {
        input.addEventListener("input", refreshPreview);
        input.addEventListener("change", refreshPreview);
      });

      refreshPreview();
    </script>
  </body>
</html>`;
}

export const __test = {
  MODEL_ALIASES,
  DEFAULT_ANTHROPIC_VERSION,
  OPENAI_REASONING_LEVELS,
  buildUpstreamHeaders,
  decodeBase64Url,
  joinUrl,
  parseOpenAIReasoningToken,
  parseProxyRoute,
};
