const DEFAULT_PROFILE = {
  projectType: "",
  city: "",
  houseType: "",
  areaM2: "",
  budget: "",
  stylePrefs: [],
  household: "",
  mustHaves: [],
  constraints: [],
  timeline: "",
  contactTime: "",
  notes: "",
  missingFields: [
    "projectType",
    "city",
    "houseType",
    "areaM2",
    "budget",
    "stylePrefs",
    "household",
    "mustHaves",
    "timeline"
  ],
  completeness: 0
};

const SYSTEM_PROMPT = `你是“东咫设计工程（深圳）集团有限公司”的装修需求采集顾问 Agent，服务对象是装修业主。你的目标不是炫技，而是让业主愿意持续沟通并提供真实需求。

沟通风格（必须遵守）：
1) 有人味：温和、耐心、像真实顾问，不要机器人腔。
2) 一次只问1~2个关键问题，避免连环轰炸。
3) 先共情，再提问。少术语，多白话。
4) 不要输出大段清单式盘问，像微信聊天一样自然。
5) 不确定时先确认，不要擅自假设。
6) 体现东咫品牌气质：表达审美感、专业感、秩序感；语气高级但不浮夸。

任务目标：
- 逐步采集并补全：房屋信息、家庭结构、预算、风格、功能优先级、硬约束、时间计划。
- 当信息不足时，优先问“下一条最关键问题”。
- 当关键字段基本齐全时，明确告诉用户“可以进入方案阶段”，并说明下一步会产出什么。

面向业主沟通要求：
- 禁止使用内部管理术语（如：任务分发、线索转化、成交率、投产比等）。
- 尽量用业主听得懂的话，避免行业黑话。
- 回答要让业主有被理解和被陪伴的感觉。

输出要求：
- 仅输出你要发给业主的话术正文（纯文本）。
- 结尾尽量带一个自然的问题，引导业主继续回复。`;

const EXTRACT_PROMPT = `你是“装修需求抽取器”。
你会基于对话，把需求更新到JSON。必须只输出JSON，不要额外解释。

字段定义：
- projectType: 装修类型（新房全案/旧房改造/局改等）
- city: 城市
- houseType: 户型（几室几厅）
- areaM2: 建面/套内面积
- budget: 预算
- stylePrefs: 风格偏好数组
- household: 常住成员与结构
- mustHaves: 强需求数组
- constraints: 限制条件数组（承重墙、不能动区、租期等）
- timeline: 期望开工/入住时间
- contactTime: 偏好沟通时间
- notes: 其他备注
- missingFields: 仍缺失的关键字段数组
- completeness: 0~100 的整数

规则：
1) 只根据上下文，未知字段保留空字符串或空数组。
2) 不能编造。
3) completeness 根据关键字段覆盖率估算。
4) 输出必须是合法JSON对象。`;

const IMAGE_SEARCH_PROMPT = `你是“装修参考图检索助手”。
请根据业主文字描述+参考图，输出可用于图片灵感搜索的关键词。
仅输出JSON：
{
  "queries": ["..."],
  "styleTags": ["..."],
  "materials": ["..."]
}
要求：
1) queries 输出3~5条中文检索词，越具体越好（例如“奶油原木风 客餐厅 一体化 收纳电视墙”）
2) 不编造品牌；
3) 必须合法JSON。`;

function cleanModelText(text = "") {
  return text
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
}

function safeJsonParse(text, fallback) {
  try {
    return JSON.parse(cleanModelText(text));
  } catch {
    try {
      const start = text.indexOf("{");
      const end = text.lastIndexOf("}");
      if (start >= 0 && end > start) {
        return JSON.parse(text.slice(start, end + 1));
      }
      return fallback;
    } catch {
      return fallback;
    }
  }
}

function normalizeMessages(messages = []) {
  return messages
    .map((m) => {
      if (!m || !(m.role === "user" || m.role === "assistant")) return null;
      const content = typeof m.content === "string" ? m.content.trim() : "";
      const images = Array.isArray(m.images)
        ? m.images
            .filter((x) => typeof x === "string" && /^(data:image\/|https?:\/\/)/i.test(x))
            .slice(0, 4)
        : [];
      if (!content && images.length === 0) return null;
      return { role: m.role, content, images };
    })
    .filter(Boolean)
    .slice(-20);
}

function toModelMessages(normalizedMessages, profile) {
  let latestUserWithImages = -1;
  normalizedMessages.forEach((m, i) => {
    if (m.role === "user" && m.images.length) latestUserWithImages = i;
  });

  const mapped = normalizedMessages.map((m, i) => {
    if (m.role === "assistant") {
      return { role: "assistant", content: m.content };
    }

    if (m.images.length && i === latestUserWithImages) {
      return {
        role: "user",
        content: [
          { type: "text", text: m.content || "请结合参考图继续沟通装修需求。" },
          ...m.images.map((url) => ({
            type: "image_url",
            image_url: { url }
          }))
        ]
      };
    }

    return {
      role: "user",
      content: `${m.content || ""}${m.images.length ? `\n[业主提到过${m.images.length}张参考图]` : ""}`.trim()
    };
  });

  return [
    { role: "system", content: SYSTEM_PROMPT },
    {
      role: "system",
      content: `当前已收集资料（可能不完整）：\n${JSON.stringify(profile, null, 2)}`
    },
    ...mapped
  ];
}

async function createChatCompletion({ baseUrl, apiKey, model, messages, temperature = 0.7 }) {
  const url = `${baseUrl.replace(/\/$/, "")}/chat/completions`;
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      temperature,
      messages
    })
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`LLM请求失败(${resp.status}): ${errText.slice(0, 500)}`);
  }

  const data = await resp.json();
  return data?.choices?.[0]?.message?.content?.trim() || "";
}

async function streamChatCompletion({ baseUrl, apiKey, model, messages, temperature = 0.7, onDelta }) {
  const url = `${baseUrl.replace(/\/$/, "")}/chat/completions`;
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      temperature,
      stream: true,
      messages
    })
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`LLM流式请求失败(${resp.status}): ${errText.slice(0, 500)}`);
  }

  const reader = resp.body?.getReader();
  if (!reader) {
    throw new Error("流式响应不可读");
  }

  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let full = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line || !line.startsWith("data:")) continue;

      const payload = line.slice(5).trim();
      if (payload === "[DONE]") continue;

      let json;
      try {
        json = JSON.parse(payload);
      } catch {
        continue;
      }

      const delta = json?.choices?.[0]?.delta?.content;
      if (typeof delta === "string" && delta) {
        full += delta;
        onDelta?.(delta);
      }
    }
  }

  return full.trim();
}

async function extractProfile({ baseUrl, apiKey, model, profile, normalizedMessages, reply }) {
  const transcript = normalizedMessages
    .map((m) => {
      const who = m.role === "user" ? "业主" : "顾问";
      const imgTag = m.images.length ? ` [参考图${m.images.length}张]` : "";
      return `${who}: ${m.content || ""}${imgTag}`.trim();
    })
    .join("\n");

  const extractMessages = [
    { role: "system", content: EXTRACT_PROMPT },
    {
      role: "user",
      content: `已知历史档案:\n${JSON.stringify(profile, null, 2)}\n\n对话记录:\n${transcript}\n顾问最新回复:\n${reply}`
    }
  ];

  const extractedText = await createChatCompletion({
    baseUrl,
    apiKey,
    model,
    messages: extractMessages,
    temperature: 0.1
  });

  return {
    ...DEFAULT_PROFILE,
    ...safeJsonParse(extractedText, profile)
  };
}

async function buildImageSearch({ baseUrl, apiKey, model, latestUserMessage }) {
  if (!latestUserMessage || !latestUserMessage.images?.length) return null;

  const messages = [
    { role: "system", content: IMAGE_SEARCH_PROMPT },
    {
      role: "user",
      content: [
        {
          type: "text",
          text: `业主需求描述：${latestUserMessage.content || "（未提供文字）"}\n请提炼可用于检索同风格参考图的关键词。`
        },
        ...latestUserMessage.images.map((url) => ({ type: "image_url", image_url: { url } }))
      ]
    }
  ];

  const raw = await createChatCompletion({
    baseUrl,
    apiKey,
    model,
    messages,
    temperature: 0.2
  });

  const parsed = safeJsonParse(raw, { queries: [], styleTags: [], materials: [] });
  const queries = Array.isArray(parsed.queries) ? parsed.queries.slice(0, 5).map((x) => String(x).trim()).filter(Boolean) : [];
  const styleTags = Array.isArray(parsed.styleTags) ? parsed.styleTags.slice(0, 8).map((x) => String(x).trim()).filter(Boolean) : [];
  const materials = Array.isArray(parsed.materials) ? parsed.materials.slice(0, 8).map((x) => String(x).trim()).filter(Boolean) : [];

  const links = queries.map((q) => {
    const e = encodeURIComponent(q);
    return {
      query: q,
      google: `https://www.google.com/search?tbm=isch&q=${e}`,
      bing: `https://www.bing.com/images/search?q=${e}`,
      xiaohongshu: `https://www.xiaohongshu.com/search_result?keyword=${e}`,
      pinterest: `https://www.pinterest.com/search/pins/?q=${e}`
    };
  });

  return { queries, styleTags, materials, links };
}

function sseSend(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const isStream = req.query?.stream === "1" || req.query?.stream === "true" || req.body?.stream === true;

  try {
    const apiKey = (process.env.KIMI_API_KEY || process.env.OPENAI_API_KEY || "").trim();
    const baseUrl = (process.env.KIMI_BASE_URL || process.env.OPENAI_BASE_URL || "https://api2.aigcbest.top/v1").trim();
    const model = (process.env.KIMI_MODEL || "kimi-k2.5").trim();

    if (!apiKey) {
      if (isStream) {
        res.writeHead(500, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
          "Access-Control-Allow-Origin": "*"
        });
        sseSend(res, "error", { error: "未配置 KIMI_API_KEY（或 OPENAI_API_KEY）" });
        return res.end();
      }
      return res.status(500).json({ error: "未配置 KIMI_API_KEY（或 OPENAI_API_KEY）" });
    }

    const body = req.body || {};
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const profile = {
      ...DEFAULT_PROFILE,
      ...(body.profile || {})
    };

    const normalizedMessages = normalizeMessages(messages);
    if (normalizedMessages.length === 0) {
      return res.status(400).json({ error: "messages 不能为空" });
    }

    const chatMessages = toModelMessages(normalizedMessages, profile);
    const latestUserMessage = [...normalizedMessages].reverse().find((m) => m.role === "user");

    if (!isStream) {
      const reply = await createChatCompletion({
        baseUrl,
        apiKey,
        model,
        messages: chatMessages,
        temperature: 0.65
      });

      const [updatedProfile, imageSearch] = await Promise.all([
        extractProfile({ baseUrl, apiKey, model, profile, normalizedMessages, reply }),
        buildImageSearch({ baseUrl, apiKey, model, latestUserMessage })
      ]);

      return res.status(200).json({
        reply,
        profile: updatedProfile,
        imageSearch,
        model,
        ts: Date.now()
      });
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*"
    });

    let reply = "";
    try {
      reply = await streamChatCompletion({
        baseUrl,
        apiKey,
        model,
        messages: chatMessages,
        temperature: 0.65,
        onDelta: (delta) => sseSend(res, "delta", { text: delta })
      });
    } catch {
      // 某些代理不支持 stream，自动回退到非流式
      reply = await createChatCompletion({
        baseUrl,
        apiKey,
        model,
        messages: chatMessages,
        temperature: 0.65
      });
      sseSend(res, "delta", { text: reply });
    }

    const [updatedProfile, imageSearch] = await Promise.all([
      extractProfile({ baseUrl, apiKey, model, profile, normalizedMessages, reply }),
      buildImageSearch({ baseUrl, apiKey, model, latestUserMessage })
    ]);

    sseSend(res, "done", {
      reply,
      profile: updatedProfile,
      imageSearch,
      model,
      ts: Date.now()
    });

    return res.end();
  } catch (err) {
    if (isStream) {
      sseSend(res, "error", { error: err?.message || "unknown error" });
      return res.end();
    }
    return res.status(500).json({ error: err?.message || "unknown error" });
  }
};
