import test from "node:test";
import assert from "node:assert/strict";

import { __test, handleRequest } from "../src/index.js";

function encodeBase64Url(value: string): string {
  return Buffer.from(value, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

test("GET / returns the HTML form page", async () => {
  const response = await handleRequest(
    new Request("https://worker.example/", { method: "GET" }),
  );
  const body = await response.text();

  assert.equal(response.status, 200);
  assert.match(
    response.headers.get("content-type") || "",
    /text\/html; charset=utf-8/,
  );
  assert.match(body, /Provider地址/);
  assert.match(body, /生成 Cursor配置/);
  assert.match(body, /思考等级/);
  assert.match(body, /强制思考/);
});

test("openai proxy injects URL reasoning when request body omits it", async () => {
  const encodedProvider = encodeBase64Url("https://api.openai.com/v1");
  const encodedModel = encodeBase64Url("gpt-4o-mini");

  const originalFetch = globalThis.fetch;
  let upstreamInput = "";
  let upstreamInit: RequestInit | undefined;

  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    upstreamInput = typeof input === "string" ? input : input.toString();
    upstreamInit = init;
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: {
        "content-type": "application/json",
      },
    });
  }) as typeof fetch;

  try {
    const response = await handleRequest(
      new Request(
        `https://worker.example/${encodedProvider}/${encodedModel}/medium/v1/chat/completions?trace=1`,
        {
          method: "POST",
          headers: {
            authorization: "Bearer sk-openai",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            model: "openai-123",
            messages: [{ role: "user", content: "HI" }],
            stream: true,
          }),
        },
      ),
    );

    const forwardedBody = JSON.parse(String(upstreamInit?.body));
    const forwardedHeaders = new Headers(upstreamInit?.headers);

    assert.equal(response.status, 200);
    assert.equal(
      response.headers.get("access-control-allow-origin"),
      "*",
    );
    assert.equal(
      upstreamInput,
      "https://api.openai.com/v1/chat/completions?trace=1",
    );
    assert.equal(forwardedBody.model, "gpt-4o-mini");
    assert.equal(forwardedBody.reasoning_effort, "medium");
    assert.equal(
      forwardedHeaders.get("authorization"),
      "Bearer sk-openai",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("openai proxy preserves request reasoning when URL is not forced", async () => {
  const encodedProvider = encodeBase64Url("https://api.openai.com/v1");
  const encodedModel = encodeBase64Url("gpt-4o-mini");

  const originalFetch = globalThis.fetch;
  let upstreamInit: RequestInit | undefined;

  globalThis.fetch = (async (
    _input: string | URL | Request,
    init?: RequestInit,
  ) => {
    upstreamInit = init;
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: {
        "content-type": "application/json",
      },
    });
  }) as typeof fetch;

  try {
    const response = await handleRequest(
      new Request(
        `https://worker.example/${encodedProvider}/${encodedModel}/medium/v1/chat/completions`,
        {
          method: "POST",
          headers: {
            authorization: "Bearer sk-openai",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            model: "openai-123",
            reasoning_effort: "high",
            messages: [{ role: "user", content: "HI" }],
          }),
        },
      ),
    );

    const forwardedBody = JSON.parse(String(upstreamInit?.body));

    assert.equal(response.status, 200);
    assert.equal(forwardedBody.model, "gpt-4o-mini");
    assert.equal(forwardedBody.reasoning_effort, "high");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("openai proxy force route overrides request reasoning", async () => {
  const encodedProvider = encodeBase64Url("https://api.openai.com/v1");
  const encodedModel = encodeBase64Url("gpt-4o-mini");

  const originalFetch = globalThis.fetch;
  let upstreamInit: RequestInit | undefined;

  globalThis.fetch = (async (
    _input: string | URL | Request,
    init?: RequestInit,
  ) => {
    upstreamInit = init;
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: {
        "content-type": "application/json",
      },
    });
  }) as typeof fetch;

  try {
    const response = await handleRequest(
      new Request(
        `https://worker.example/${encodedProvider}/${encodedModel}/force-medium/v1/chat/completions`,
        {
          method: "POST",
          headers: {
            authorization: "Bearer sk-openai",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            model: "openai-123",
            reasoning_effort: "high",
            messages: [{ role: "user", content: "HI" }],
          }),
        },
      ),
    );

    const forwardedBody = JSON.parse(String(upstreamInit?.body));

    assert.equal(response.status, 200);
    assert.equal(forwardedBody.reasoning_effort, "medium");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("anthropic proxy maps bearer Authorization into x-api-key", async () => {
  const encodedProvider = encodeBase64Url("https://api.anthropic.com/v1");
  const encodedModel = encodeBase64Url("claude-sonnet-4-20250514");

  const originalFetch = globalThis.fetch;
  let upstreamInput = "";
  let upstreamInit: RequestInit | undefined;

  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    upstreamInput = typeof input === "string" ? input : input.toString();
    upstreamInit = init;
    return new Response(JSON.stringify({ id: "msg_123" }), {
      status: 200,
      headers: {
        "content-type": "application/json",
      },
    });
  }) as typeof fetch;

  try {
    const response = await handleRequest(
      new Request(
        `https://worker.example/${encodedProvider}/${encodedModel}/v1/messages`,
        {
          method: "POST",
          headers: {
            authorization: "Bearer sk-anthropic",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            model: "claude-123",
            max_tokens: 64,
            messages: [{ role: "user", content: "HI" }],
            stream: true,
          }),
        },
      ),
    );

    const forwardedBody = JSON.parse(String(upstreamInit?.body));
    const forwardedHeaders = new Headers(upstreamInit?.headers);

    assert.equal(response.status, 200);
    assert.equal(upstreamInput, "https://api.anthropic.com/v1/messages");
    assert.equal(forwardedBody.model, "claude-sonnet-4-20250514");
    assert.equal(forwardedHeaders.get("x-api-key"), "sk-anthropic");
    assert.equal(
      forwardedHeaders.get("anthropic-version"),
      __test.DEFAULT_ANTHROPIC_VERSION,
    );
    assert.equal(forwardedHeaders.get("authorization"), null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("streaming responses are returned without rewriting", async () => {
  const encodedProvider = encodeBase64Url("https://api.openai.com/v1");
  const encodedModel = encodeBase64Url("gpt-4o");
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async () => {
    return new Response("data: hello\n\ndata: [DONE]\n\n", {
      status: 200,
      headers: {
        "content-type": "text/event-stream",
      },
    });
  }) as typeof fetch;

  try {
    const response = await handleRequest(
      new Request(
        `https://worker.example/${encodedProvider}/${encodedModel}/high/v1/chat/completions`,
        {
          method: "POST",
          headers: {
            authorization: "Bearer sk-stream",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            model: "openai-123",
            messages: [{ role: "user", content: "HI" }],
            stream: true,
          }),
        },
      ),
    );

    assert.equal(response.headers.get("content-type"), "text/event-stream");
    assert.equal(await response.text(), "data: hello\n\ndata: [DONE]\n\n");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("invalid base64url path returns 400", async () => {
  const response = await handleRequest(
    new Request("https://worker.example/!!!/abcd/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": "sk-test",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-123",
        max_tokens: 64,
        messages: [{ role: "user", content: "HI" }],
      }),
    }),
  );

  assert.equal(response.status, 400);
  assert.match(await response.text(), /base64url/);
});

test("missing auth header returns 400 for openai route", async () => {
  const encodedProvider = encodeBase64Url("https://api.openai.com/v1");
  const encodedModel = encodeBase64Url("gpt-4o");

  const response = await handleRequest(
    new Request(
      `https://worker.example/${encodedProvider}/${encodedModel}/medium/v1/chat/completions`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "openai-123",
          messages: [{ role: "user", content: "HI" }],
        }),
      },
    ),
  );

  assert.equal(response.status, 400);
  assert.match(await response.text(), /Authorization/);
});

test("old openai path without reasoning token returns 400", async () => {
  const encodedProvider = encodeBase64Url("https://api.openai.com/v1");
  const encodedModel = encodeBase64Url("gpt-4o");

  const response = await handleRequest(
    new Request(
      `https://worker.example/${encodedProvider}/${encodedModel}/v1/chat/completions`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer sk-openai",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "openai-123",
          messages: [{ role: "user", content: "HI" }],
        }),
      },
    ),
  );

  assert.equal(response.status, 400);
  assert.match(await response.text(), /缺少思考等级/);
});

test("invalid reasoning token returns 400", async () => {
  const encodedProvider = encodeBase64Url("https://api.openai.com/v1");
  const encodedModel = encodeBase64Url("gpt-4o");

  const response = await handleRequest(
    new Request(
      `https://worker.example/${encodedProvider}/${encodedModel}/force-ultra/v1/chat/completions`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer sk-openai",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "openai-123",
          messages: [{ role: "user", content: "HI" }],
        }),
      },
    ),
  );

  assert.equal(response.status, 400);
  assert.match(await response.text(), /force-medium/);
});

test("route parser distinguishes openai and anthropic paths", () => {
  const encodedProvider = encodeBase64Url("https://api.example.com/v1");
  const encodedModel = encodeBase64Url("demo-model");

  assert.deepEqual(
    __test.parseProxyRoute(
      `/${encodedProvider}/${encodedModel}/high/v1/chat/completions`,
    ),
    {
      route: {
        type: "openai",
        encodedProvider,
        encodedModel,
        reasoningToken: "high",
      },
      error: null,
    },
  );

  assert.deepEqual(
    __test.parseProxyRoute(`/${encodedProvider}/${encodedModel}/v1/messages`),
    {
      route: {
        type: "anthropic",
        encodedProvider,
        encodedModel,
      },
      error: null,
    },
  );
});

test("reasoning token parser normalizes force tokens", () => {
  assert.deepEqual(__test.parseOpenAIReasoningToken("force-high"), {
    normalizedReasoning: "high",
    isForced: true,
  });

  assert.deepEqual(__test.parseOpenAIReasoningToken("medium"), {
    normalizedReasoning: "medium",
    isForced: false,
  });
});
