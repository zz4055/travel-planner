const path = require("path");
const express = require("express");
const cors = require("cors");
require("dotenv").config({ path: path.join(__dirname, ".env") });

const { pool, pingDb } = require("./db");

const app = express();
const PORT = Number(process.env.PORT) || 3002;

app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(express.static(__dirname));

function normalizeAIModel(model) {
  const raw = String(model || "").trim();
  // DeepSeek 现仅接受 v4 模型名；旧名做兼容映射，避免前端 LocalStorage 仍写 deepseek-chat 时整站变 Mock
  if (!raw || raw === "deepseek-chat") {
    return "deepseek-v4-flash";
  }
  if (raw === "deepseek-reasoner") {
    return "deepseek-v4-pro";
  }
  return raw;
}

function resolveAIConfig(body = {}) {
  const apiKey = (body.apiKey || process.env.AI_API_KEY || "").trim();
  const baseUrl = (body.baseUrl || process.env.AI_BASE_URL || "https://api.deepseek.com/v1")
    .trim()
    .replace(/\/$/, "");
  const model = normalizeAIModel(body.model || process.env.AI_MODEL || "deepseek-v4-flash");
  return { apiKey, baseUrl, model };
}

function tripContextText(trip = {}, extras = {}) {
  const places = Array.isArray(extras.places) ? extras.places : [];
  const todos = Array.isArray(extras.todos) ? extras.todos : [];
  const placeLines = places.length
    ? places.map((p) => `- ${p.date} ${p.name}${p.note ? `（${p.note}）` : ""}`).join("\n")
    : "- （暂无）";
  const todoLines = todos.length
    ? todos.map((t) => `- ${t.date} ${t.title}${t.done ? " [已完成]" : ""}`).join("\n")
    : "- （暂无）";

  return [
    "当前旅行：",
    `- 名称：${trip.name || "未命名"}`,
    `- 目的地：${trip.destination || "未知"}`,
    `- 日期：${trip.startDate || "?"} 至 ${trip.endDate || "?"}`,
    "",
    "已有地点：",
    placeLines,
    "",
    "已有待办：",
    todoLines
  ].join("\n");
}

function buildChatSystemPrompt(trip, extras) {
  return [
    "你是第四节课「旅行规划小系统」里的 AI 行程助手。",
    "用简洁中文回答，给出可执行的旅行建议。",
    "可以建议景点、餐饮、交通、待办事项；不要编造精确票价或营业时间。",
    "每次回复控制在 180 字以内。",
    "不要谈模型或 API。",
    "",
    tripContextText(trip, extras)
  ].join("\n");
}

function buildPlanSystemPrompt(trip, extras) {
  const prefs = Array.isArray(extras.preferences) ? extras.preferences.join("、") : "";
  const pace = extras.pace || "均衡";
  const daysLabel = extras.daysLabel || "";
  return [
    "你是旅行行程规划助手。根据用户旅行信息、偏好与节奏，生成可写入系统的地点与待办，并附带结构化建议。",
    "节奏：躺平=少安排多休息；特种兵=高强度打卡；均衡=劳逸结合；随机=留白与意外发现。",
    "只输出合法 JSON，不要 Markdown，不要代码块，不要额外说明。",
    "JSON 格式：",
    '{"advice":{"summary":"一句话总览","highlights":["亮点1","亮点2"],"itinerary":["第1天：…"],"reminder":"出行提醒"},"places":[{"date":"YYYY-MM-DD","name":"地点名","note":"简短备注","time":"10:00","category":"sightseeing"}],"todos":[{"date":"YYYY-MM-DD","title":"待办标题","category":"during"}]}',
    "要求：",
    "- advice.highlights / advice.itinerary 必须是字符串数组，内容要体现偏好与节奏",
    "- date 必须在旅行起止日期范围内（含首尾）",
    "- places 每天 1～3 个，todos 每天 1～2 个",
    "- category 地点可选：sightseeing / food / shopping / nature / other",
    "- category 待办可选：booking / documents / packing / shopping / during",
    "- time 用 HH:mm（可选）",
    "- name / title / note 用中文，简短",
    "- 不要重复用户已有地点与待办",
    "",
    `用户偏好：${prefs || "未指定"}`,
    `旅行节奏：${pace}`,
    daysLabel ? `天数表述：${daysLabel}` : "",
    "",
    tripContextText(trip, extras)
  ]
    .filter(Boolean)
    .join("\n");
}

async function callChatCompletions({ apiKey, baseUrl, model, messages, temperature, max_tokens }) {
  const upstream = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({ model, messages, temperature, max_tokens })
  });

  const data = await upstream.json().catch(() => ({}));
  if (!upstream.ok) {
    const detail = data?.error?.message || data?.message || `上游接口错误 ${upstream.status}`;
    const error = new Error(detail);
    error.status = upstream.status;
    error.code = "UPSTREAM_ERROR";
    throw error;
  }

  const reply = data?.choices?.[0]?.message?.content?.trim();
  if (!reply) {
    const error = new Error("模型未返回内容");
    error.status = 502;
    error.code = "EMPTY_REPLY";
    throw error;
  }
  return { reply, model };
}

function extractJson(text) {
  const trimmed = String(text || "").trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const match = trimmed.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
}

function normalizePlan(raw, trip) {
  const start = trip.startDate;
  const end = trip.endDate;
  const places = Array.isArray(raw?.places) ? raw.places : [];
  const todos = Array.isArray(raw?.todos) ? raw.todos : [];

  const placeCats = new Set(["sightseeing", "food", "shopping", "nature", "other"]);
  const todoCats = new Set(["booking", "documents", "packing", "shopping", "during"]);

  const cleanPlaces = places
    .filter((p) => p && p.name && p.date)
    .map((p) => ({
      date: String(p.date).slice(0, 10),
      name: String(p.name).trim().slice(0, 50),
      note: String(p.note || "").trim().slice(0, 80),
      time: String(p.time || "").trim().slice(0, 5),
      category: placeCats.has(String(p.category || "")) ? String(p.category) : "sightseeing"
    }))
    .filter((p) => p.name && p.date >= start && p.date <= end)
    .slice(0, 24);

  const cleanTodos = todos
    .filter((t) => t && t.title && t.date)
    .map((t) => ({
      date: String(t.date).slice(0, 10),
      title: String(t.title).trim().slice(0, 50),
      category: todoCats.has(String(t.category || "")) ? String(t.category) : "during",
      note: String(t.note || "").trim().slice(0, 80)
    }))
    .filter((t) => t.title && t.date >= start && t.date <= end)
    .slice(0, 24);

  return { places: cleanPlaces, todos: cleanTodos };
}

function normalizeAdvice(raw) {
  const advice = raw?.advice && typeof raw.advice === "object" ? raw.advice : raw || {};
  return {
    summary: String(advice.summary || "").trim(),
    highlights: Array.isArray(advice.highlights)
      ? advice.highlights.map((x) => String(x)).filter(Boolean).slice(0, 8)
      : [],
    itinerary: Array.isArray(advice.itinerary)
      ? advice.itinerary.map((x) => String(x)).filter(Boolean).slice(0, 10)
      : [],
    reminder: String(advice.reminder || "").trim()
  };
}

function parseJsonField(value, fallback) {
  if (value == null) return fallback;
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

async function savePlanRecord({
  trip,
  preferences,
  pace,
  daysLabel,
  advice,
  plan,
  source,
  model
}) {
  const prefList = Array.isArray(preferences) ? preferences : [];
  const [result] = await pool.query(
    `INSERT INTO plan_records
       (trip_name, destination, start_date, end_date, days_label,
        preferences_json, pace, advice_json, plan_json, answer_source, model)
     VALUES (?, ?, ?, ?, ?, CAST(? AS JSON), ?, CAST(? AS JSON), CAST(? AS JSON), ?, ?)`,
    [
      String(trip.name || "").slice(0, 120),
      String(trip.destination || "").slice(0, 80),
      String(trip.startDate || "").slice(0, 20),
      String(trip.endDate || "").slice(0, 20),
      String(daysLabel || "").slice(0, 40),
      JSON.stringify(prefList),
      String(pace || "均衡").slice(0, 30),
      JSON.stringify(advice || {}),
      JSON.stringify(plan || {}),
      String(source || "deepseek").slice(0, 20),
      String(model || "").slice(0, 80)
    ]
  );
  return result.insertId;
}

app.get("/api/health", async (_req, res) => {
  const { apiKey, baseUrl, model } = resolveAIConfig();
  let db = false;
  try {
    db = await pingDb();
  } catch (err) {
    console.warn("[/api/health] db ping failed:", err.message);
  }
  res.json({
    ok: true,
    configured: Boolean(apiKey),
    baseUrl,
    model,
    source: apiKey ? (process.env.AI_API_KEY ? "env" : "none") : "none",
    db
  });
});

app.get("/api/maps-config", (_req, res) => {
  const googleMapsApiKey = (process.env.GOOGLE_MAPS_API_KEY || "").trim();
  res.json({
    ok: true,
    configured: Boolean(googleMapsApiKey),
    googleMapsApiKey: googleMapsApiKey || "",
    libraries: ["places"]
  });
});

app.post("/api/chat", async (req, res) => {
  try {
    const { message, trip = {}, places = [], todos = [], history = [] } = req.body || {};
    if (!message || typeof message !== "string") {
      return res.status(400).json({ error: "缺少 message" });
    }

    const { apiKey, baseUrl, model } = resolveAIConfig(req.body);
    if (!apiKey) {
      return res.status(503).json({ error: "未配置 API Key", code: "NO_API_KEY" });
    }

    const { reply } = await callChatCompletions({
      apiKey,
      baseUrl,
      model,
      temperature: 0.7,
      max_tokens: 400,
      messages: [
        { role: "system", content: buildChatSystemPrompt(trip, { places, todos }) },
        ...history
          .filter((m) => m && (m.role === "user" || m.role === "assistant") && m.content)
          .slice(-8)
          .map((m) => ({ role: m.role, content: String(m.content).slice(0, 800) })),
        { role: "user", content: String(message).slice(0, 800) }
      ]
    });

    res.json({ reply, model, mode: "live" });
  } catch (err) {
    console.error("[/api/chat]", err);
    res.status(err.status || 500).json({
      error: err.message || "服务器错误",
      code: err.code || "SERVER_ERROR"
    });
  }
});

app.post("/api/plan", async (req, res) => {
  try {
    const {
      trip = {},
      places = [],
      todos = [],
      focusDate = "",
      preferences = [],
      pace = "均衡",
      daysLabel = ""
    } = req.body || {};
    if (!trip.destination || !trip.startDate || !trip.endDate) {
      return res.status(400).json({ error: "缺少旅行目的地或日期" });
    }

    const { apiKey, baseUrl, model } = resolveAIConfig(req.body);
    if (!apiKey) {
      return res.status(503).json({ error: "未配置 API Key", code: "NO_API_KEY" });
    }

    const prefList = Array.isArray(preferences)
      ? preferences.map((x) => String(x).trim()).filter(Boolean)
      : [];
    const paceLabel = String(pace || "均衡").trim() || "均衡";

    const focusLine = focusDate
      ? `请重点规划这一天：${focusDate}（也可附带相邻日期少量建议）。`
      : "请覆盖旅行每一天的安排。";

    const { reply } = await callChatCompletions({
      apiKey,
      baseUrl,
      model,
      temperature: 0.6,
      max_tokens: 1600,
      messages: [
        {
          role: "system",
          content: buildPlanSystemPrompt(trip, {
            places,
            todos,
            preferences: prefList,
            pace: paceLabel,
            daysLabel: String(daysLabel || "")
          })
        },
        {
          role: "user",
          content: [
            `请为「${trip.name || trip.destination}」生成行程 JSON。`,
            focusLine,
            prefList.length ? `请优先围绕这些偏好：${prefList.join("、")}` : "",
            `节奏请按「${paceLabel}」安排疏密。`
          ]
            .filter(Boolean)
            .join(" ")
        }
      ]
    });

    const parsed = extractJson(reply);
    if (!parsed) {
      return res.status(502).json({ error: "模型返回无法解析", code: "BAD_JSON", raw: reply.slice(0, 400) });
    }

    const plan = normalizePlan(parsed, trip);
    const advice = normalizeAdvice(parsed);
    if (!plan.places.length && !plan.todos.length) {
      return res.status(502).json({ error: "生成结果为空", code: "EMPTY_PLAN", raw: reply.slice(0, 400) });
    }

    let historyId = null;
    let historySaved = false;
    try {
      historyId = await savePlanRecord({
        trip,
        preferences: prefList,
        pace: paceLabel,
        daysLabel: String(daysLabel || ""),
        advice,
        plan,
        source: "deepseek",
        model
      });
      historySaved = true;
    } catch (dbErr) {
      console.error("[/api/plan] save history failed:", dbErr.message);
    }

    res.json({ plan, advice, model, mode: "live", historyId, historySaved });
  } catch (err) {
    console.error("[/api/plan]", err);
    res.status(err.status || 500).json({
      error: err.message || "服务器错误",
      code: err.code || "SERVER_ERROR"
    });
  }
});

app.get("/api/history", async (req, res) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit) || 5, 1), 50);
    const [rows] = await pool.query(
      `SELECT
         id,
         trip_name AS tripName,
         destination,
         start_date AS startDate,
         end_date AS endDate,
         days_label AS daysLabel,
         preferences_json AS preferences,
         pace,
         advice_json AS advice,
         answer_source AS source,
         model,
         created_at AS createdAt
       FROM plan_records
       ORDER BY id DESC
       LIMIT ?`,
      [limit]
    );

    const records = rows.map((row) => {
      const advice = parseJsonField(row.advice, {});
      return {
        id: row.id,
        tripName: row.tripName || "",
        destination: row.destination || "",
        startDate: row.startDate || "",
        endDate: row.endDate || "",
        daysLabel: row.daysLabel || "",
        preferences: parseJsonField(row.preferences, []),
        pace: row.pace || "",
        summary: advice && advice.summary ? String(advice.summary) : "",
        source: row.source || "",
        model: row.model || "",
        createdAt:
          row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt
      };
    });

    res.json({ records });
  } catch (err) {
    console.error("[GET /api/history]", err.message);
    res.status(500).json({ error: "读取历史失败", detail: err.message });
  }
});

app.listen(PORT, () => {
  const hasKey = Boolean((process.env.AI_API_KEY || "").trim());
  console.log(`旅行规划小系统已启动: http://localhost:${PORT}`);
  console.log(
    hasKey
      ? `AI：已从 .env 读取密钥（${normalizeAIModel(process.env.AI_MODEL)}）`
      : "AI：未配置 .env 密钥 —— 可复制 .env.example 为 .env 后填写 AI_API_KEY"
  );
  console.log(
    `MySQL：${process.env.DB_HOST || "127.0.0.1"}:${process.env.DB_PORT || 3309}/${process.env.DB_NAME || "travel_planner"}`
  );
});
