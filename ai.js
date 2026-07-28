/**
 * 旅游规划 AI 客户端：优先调用本地 /api，失败时回退本地规则建议。
 */
window.TravelAI = (function () {
  const STORAGE_KEY = "travel-plan-ai-settings";

  const DEFAULTS = {
    apiKey: "",
    baseUrl: "https://api.deepseek.com/v1",
    model: "deepseek-v4-flash"
  };

  function loadSettings() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return { ...DEFAULTS };
      const next = { ...DEFAULTS, ...JSON.parse(raw) };
      if (!next.model || next.model === "deepseek-chat") {
        next.model = "deepseek-v4-flash";
      } else if (next.model === "deepseek-reasoner") {
        next.model = "deepseek-v4-pro";
      }
      return next;
    } catch {
      return { ...DEFAULTS };
    }
  }

  function saveSettings(partial) {
    const next = { ...loadSettings(), ...partial };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    return next;
  }

  function apiBase() {
    if (location.protocol === "http:" || location.protocol === "https:") {
      return "";
    }
    return "http://localhost:3002";
  }

  async function checkHealth() {
    try {
      const res = await fetch(`${apiBase()}/api/health`);
      if (!res.ok) return { ok: false, configured: false };
      return await res.json();
    } catch {
      return { ok: false, configured: false, offline: true };
    }
  }

  async function fetchHistory(limit = 5) {
    try {
      const res = await fetch(`${apiBase()}/api/history?limit=${encodeURIComponent(limit)}`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        return {
          ok: false,
          records: [],
          error: data.error || data.detail || "读取历史失败"
        };
      }
      return {
        ok: true,
        records: Array.isArray(data.records) ? data.records : []
      };
    } catch {
      return { ok: false, records: [], error: "未连上本地服务" };
    }
  }

  function eachDate(startDate, endDate) {
    const dates = [];
    const start = new Date(startDate + "T00:00:00");
    const end = new Date(endDate + "T00:00:00");
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start > end) {
      return dates;
    }
    const cursor = new Date(start);
    while (cursor <= end) {
      const y = cursor.getFullYear();
      const m = String(cursor.getMonth() + 1).padStart(2, "0");
      const d = String(cursor.getDate()).padStart(2, "0");
      dates.push(`${y}-${m}-${d}`);
      cursor.setDate(cursor.getDate() + 1);
    }
    return dates;
  }

  function mockPlan(trip, focusDate, options = {}) {
    const dates = eachDate(trip.startDate, trip.endDate);
    const targetDates = focusDate && dates.includes(focusDate) ? [focusDate] : dates;
    const dest = trip.destination || "目的地";
    const prefs = Array.isArray(options.preferences) ? options.preferences : [];
    const pace = options.pace || "均衡";
    const focus = prefs.length ? prefs.slice(0, 3).join("、") : "经典散步";

    const places = [];
    const todos = [];

    targetDates.forEach((date, i) => {
      const morning =
        pace === "躺平"
          ? `${dest}${prefs[0] || "咖啡馆"}（轻松）`
          : pace === "特种兵"
            ? `${dest}早场打卡 · ${prefs[0] || "景点"}`
            : `${dest}${prefs[0] || "经典区"}`;
      places.push(
        {
          date,
          name: morning,
          note: i === 0 ? "抵达后主线" : `围绕 ${focus}`,
          time: pace === "特种兵" ? "08:30" : "10:30",
          category: /吃|美食|夜市|咖啡/.test(prefs[0] || "") ? "food" : "sightseeing"
        },
        {
          date,
          name: `${dest}${prefs[1] || "本地味道"}`,
          note: pace === "躺平" ? "晚饭悠闲" : "晚饭",
          time: "18:30",
          category: "food"
        }
      );
      todos.push(
        {
          date,
          title: i === 0 ? "换当地货币 / 交通卡" : `确认明日与「${focus}」相关安排`,
          category: "during"
        },
        { date, title: pace === "特种兵" ? "提前排队预约" : "备份当天照片与票据", category: "during" }
      );
    });

    const itinerary = targetDates.slice(0, 6).map((date, i) => {
      if (pace === "躺平") return `第${i + 1}天（${date}）：晚起 → ${focus} 只挑 1～2 点 → 咖啡馆发呆`;
      if (pace === "特种兵") return `第${i + 1}天（${date}）：早出密集打卡 ${focus}，傍晚夜市收尾`;
      if (pace === "随机") return `第${i + 1}天（${date}）：主线 ${focus}，下午留一段随机散步`;
      return `第${i + 1}天（${date}）：上午 ${focus}，下午轻松，晚上当地味道`;
    });

    return {
      places: places.slice(0, 24),
      todos: todos.slice(0, 24),
      note: "本地规则生成（未接入真实模型）",
      advice: {
        summary: `「${dest}」${options.daysLabel || ""} · ${pace}节奏，围绕 ${focus}`,
        highlights: prefs.length ? prefs.slice(0, 5) : [`${dest}必去`, "当地美食", "轻松路线"],
        itinerary,
        reminder: "当前为 mock。配置 DeepSeek Key 后可生成更贴合的行程。"
      }
    };
  }

  function mockChat(userText, trip) {
    const dest = trip?.destination || "目的地";
    const text = String(userText || "");
    if (/吃|美食|餐厅|小吃/.test(text)) {
      return `在${dest}，可以把「当地小吃街 / 夜市」排进晚饭，再加一条「别吃太撑，留体力」待办。`;
    }
    if (/雨|天气|穿/.test(text)) {
      return `去${dest}前看一下天气预报，待办里加「折叠伞 / 薄外套」。雨天优先室内场馆。`;
    }
    if (/交通|地铁|打车|怎么去/.test(text)) {
      return `${dest}建议先确定机场/车站到市区的方式，第一天待办写「买交通卡 / 下载打车软件」。`;
    }
    return `可以围绕「上午景点 + 下午轻松逛 + 晚上当地味道」来排${dest}。点「AI 生成行程」我也能直接写进列表（当前为本地模拟）。`;
  }

  async function chat({ message, trip, places, todos, history }) {
    const settings = loadSettings();
    const hasClientKey = Boolean(settings.apiKey && settings.apiKey.trim());

    try {
      const res = await fetch(`${apiBase()}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message,
          trip,
          places,
          todos,
          history,
          apiKey: hasClientKey ? settings.apiKey.trim() : undefined,
          baseUrl: settings.baseUrl,
          model: settings.model
        })
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.reply) {
        return { mode: "live", reply: data.reply, model: data.model || settings.model || "deepseek-v4-flash" };
      }
      const mock = mockChat(message, trip);
      if (data.code === "NO_API_KEY") {
        return { mode: "mock", reply: mock, model: "" };
      }
      return {
        mode: "mock",
        reply: `${mock}${data.error ? `（真实 AI 失败：${data.error}）` : ""}`,
        model: ""
      };
    } catch {
      return {
        mode: "offline",
        reply: `${mockChat(message, trip)}（未连上本地服务，请先 npm start）`,
        model: ""
      };
    }
  }

  async function generatePlan({ trip, places, todos, focusDate, preferences, pace, daysLabel }) {
    const settings = loadSettings();
    const hasClientKey = Boolean(settings.apiKey && settings.apiKey.trim());
    const options = {
      preferences: Array.isArray(preferences) ? preferences : [],
      pace: pace || "均衡",
      daysLabel: daysLabel || ""
    };

    try {
      const res = await fetch(`${apiBase()}/api/plan`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          trip,
          places,
          todos,
          focusDate: focusDate || "",
          preferences: options.preferences,
          pace: options.pace,
          daysLabel: options.daysLabel,
          apiKey: hasClientKey ? settings.apiKey.trim() : undefined,
          baseUrl: settings.baseUrl,
          model: settings.model
        })
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.plan) {
        return {
          mode: "live",
          plan: data.plan,
          advice: data.advice || null,
          model: data.model || settings.model || "deepseek-v4-flash",
          historyId: data.historyId || null,
          historySaved: Boolean(data.historySaved)
        };
      }
      const plan = mockPlan(trip, focusDate, options);
      if (data.code === "NO_API_KEY") {
        return { mode: "mock", plan, advice: plan.advice, model: "" };
      }
      return {
        mode: "mock",
        plan,
        advice: plan.advice,
        model: "",
        error: data.error || "生成失败，已用本地规则"
      };
    } catch {
      const plan = mockPlan(trip, focusDate, options);
      return {
        mode: "offline",
        plan,
        advice: plan.advice,
        model: "",
        error: "未连上本地服务，已用本地规则"
      };
    }
  }

  return {
    loadSettings,
    saveSettings,
    checkHealth,
    fetchHistory,
    chat,
    generatePlan,
    mockChat,
    mockPlan
  };
})();
