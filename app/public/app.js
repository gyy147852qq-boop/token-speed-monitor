/* Token Speed Monitor dashboard — frontend (no framework, no CDN) */
(() => {
  "use strict";

  /* --------------------------------- i18n -------------------------------- */

  const I18N = {
    zh: {
      title: "令牌速度监控器",
      subtitle: "本地 AI 工具 token 用量与生成速度",
      since_24h: "今天", since_7d: "7 天", since_30d: "30 天", since_all: "全部",
      auto_refresh: "自动刷新", refresh: "刷新",
      composition: "Token 构成", speed_rank: "生成速度排行(tok/s)",
      per_tool: "按工具统计", per_model: "按模型统计",
      bench_title: "本地模型测速", bench_model: "模型名(可选)", bench_run: "开始测速",
      bench_hint: "会真实调用本地模型生成一小段文本;首次运行可能需要加载权重,耗时较长。",
      live_title: "实时生成速度", live_hint: "每次 AI 生成完成会实时显示速度;本面板运行期间持续监听。",
      sources: "数据源状态", privacy: "数据全部来自本机,只读不修改任何文件;测速仅访问 localhost。",
      card_total: "Token 总量", card_input: "输入", card_output: "输出 + 推理",
      card_cache: "缓存复用", card_requests: "请求数", card_sessions: "会话数",
      card_speed: "平均生成速度", card_cost: "累计成本",
      tool: "工具", model: "模型", requests: "请求", sessions: "会话", input: "输入",
      output: "输出", reasoning: "推理", cache_read: "缓存读", cache_write: "缓存写",
      total: "合计", cost: "成本", avg_speed: "平均速度", samples: "样本", p50: "中位",
      p90: "P90", max: "最高", no_data: "该时间范围内没有数据",
      detected: "已检测到", not_detected: "未安装 / 无数据", running: "运行中", not_running: "未运行",
      load_time: "模型加载", prompt_eval: "预填充速度", generation: "生成速度",
      wall_clock: "总耗时", ttft: "首字延迟", bench_running: "测速中,请稍候…",
      bench_failed: "测速失败", live_waiting: "等待新的生成记录…", live_off: "实时连接已断开,正在重连…",
      cache_share: "占总量", of_total: "占总量", sources_kind_file: "日志", sources_kind_server: "本地服务",
      no_speed: "无速度数据",
      updated: "更新于", loading: "加载中…", err_summary: "读取统计失败",
    },
    en: {
      title: "Token Speed Monitor",
      subtitle: "Token usage & generation speed of local AI tools",
      since_24h: "24h", since_7d: "7d", since_30d: "30d", since_all: "All",
      auto_refresh: "Auto refresh", refresh: "Refresh",
      composition: "Token composition", speed_rank: "Generation speed (tok/s)",
      per_tool: "By tool", per_model: "By model",
      bench_title: "Local model benchmark", bench_model: "model (optional)", bench_run: "Run benchmark",
      bench_hint: "Sends a real generation request to your local model. The first run may need to load weights.",
      live_title: "Live generation speed", live_hint: "Every completed generation appears here in real time while the dashboard runs.",
      sources: "Sources", privacy: "Everything is read from this machine only; benchmarks talk to localhost.",
      card_total: "Total tokens", card_input: "Input", card_output: "Output + reasoning",
      card_cache: "Cache reads", card_requests: "Requests", card_sessions: "Sessions",
      card_speed: "Avg generation speed", card_cost: "Total cost",
      tool: "Tool", model: "Model", requests: "Reqs", sessions: "Sessions", input: "Input",
      output: "Output", reasoning: "Reasoning", cache_read: "Cache read", cache_write: "Cache write",
      total: "Total", cost: "Cost", avg_speed: "Avg speed", samples: "Samples", p50: "p50",
      p90: "p90", max: "Max", no_data: "No data in this range",
      detected: "detected", not_detected: "not found", running: "running", not_running: "not running",
      load_time: "Model load", prompt_eval: "Prompt eval", generation: "Generation",
      wall_clock: "Wall clock", ttft: "TTFT", bench_running: "Benchmarking, please wait…",
      bench_failed: "Benchmark failed", live_waiting: "Waiting for a new generation…",
      live_off: "Live feed disconnected, reconnecting…",
      cache_share: "of total", of_total: "of total", sources_kind_file: "logs", sources_kind_server: "local server",
      no_speed: "no timing",
      updated: "updated", loading: "loading…", err_summary: "Failed to load stats",
    },
  };

  let lang = localStorage.getItem("tsm_lang") || "zh";
  const t = (key) => (I18N[lang] && I18N[lang][key]) || I18N.en[key] || key;

  /* ------------------------------ utilities ------------------------------ */

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  function fmt(n) {
    n = Number(n) || 0;
    const a = Math.abs(n);
    if (a >= 1e9) return (n / 1e9).toFixed(2) + "B";
    if (a >= 1e6) return (n / 1e6).toFixed(2) + "M";
    if (a >= 1e4) return (n / 1e3).toFixed(1) + "k";
    return String(Math.round(n));
  }
  const fmtSec = (s) => (s == null ? "—" : s >= 60 ? `${Math.floor(s / 60)}m${Math.round(s % 60)}s` : `${s}s`);
  const pct = (part, whole) => (whole > 0 ? Math.round((part / whole) * 100) : 0);

  function applyI18n() {
    document.documentElement.lang = lang === "zh" ? "zh-CN" : "en";
    document.title = t("title");
    document.querySelectorAll("[data-i18n]").forEach((el) => (el.textContent = t(el.dataset.i18n)));
    document.querySelectorAll("[data-i18n-ph]").forEach((el) => (el.placeholder = t(el.dataset.i18nPh)));
    $("langBtn").textContent = lang === "zh" ? "EN" : "中文";
  }

  function banner(msg) {
    const el = $("banner");
    if (!msg) { el.classList.add("hidden"); return; }
    el.textContent = msg;
    el.classList.remove("hidden");
  }

  /* -------------------------------- state -------------------------------- */

  let since = localStorage.getItem("tsm_since") || "7d";
  let summary = null;
  let speed = null;
  let listData = null;
  let benchBusy = false;

  /* ------------------------------- fetching ------------------------------ */

  async function getJSON(url) {
    const res = await fetch(url, { cache: "no-store" });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  async function loadAll() {
    const q = since ? `?since=${encodeURIComponent(since)}` : "";
    try {
      const [s, sp, li] = await Promise.all([
        getJSON("/api/summary" + q),
        getJSON("/api/speed" + q),
        getJSON("/api/list"),
      ]);
      summary = s; speed = sp; listData = li;
      banner("");
      render();
    } catch (e) {
      banner(t("err_summary") + ": " + e.message);
    }
  }

  /* ------------------------------- rendering ----------------------------- */

  function render() {
    if (!summary) return;
    renderCards();
    renderComposition();
    renderSpeedRank();
    renderTools();
    renderModels();
    renderSources();
    $("ver").textContent = `${t("updated")}: ${new Date().toLocaleTimeString()} · v${summary.version || "?"}`;
  }

  function overallSpeed() {
    const models = (summary.byModel || []).filter((m) => m.speed && m.speed.n);
    const n = models.reduce((a, m) => a + m.speed.n, 0);
    if (!n) return null;
    return models.reduce((a, m) => a + m.speed.avg * m.speed.n, 0) / n;
  }

  function renderCards() {
    const all = summary.totals.all;
    const spd = overallSpeed();
    const cacheShare = pct(all.cacheRead + all.cacheWrite, all.total);
    const cards = [
      { label: t("card_total"), value: fmt(all.total), foot: `${t("requests")} ${fmt(all.requests)}` },
      { label: t("card_input"), value: fmt(all.input) },
      { label: t("card_output"), value: fmt(all.output + all.reasoning) },
      { label: t("card_cache"), value: fmt(all.cacheRead + all.cacheWrite), foot: `${cacheShare}% ${t("of_total")}` },
      { label: t("card_requests"), value: fmt(all.requests), foot: `${t("sessions")} ${fmt(all.sessions)}` },
      { label: t("card_speed"), value: spd == null ? "—" : spd.toFixed(1), unit: "tok/s", foot: spd == null ? "" : t("approx") === "approx" ? "e2e" : "e2e" },
    ];
    if (all.cost != null) cards.push({ label: t("card_cost"), value: "$" + all.cost.toFixed(2) });

    $("cards").innerHTML = cards.map((c) => `
      <div class="card">
        <div class="label">${esc(c.label)}</div>
        <div class="value">${esc(c.value)}${c.unit ? `<small>${esc(c.unit)}</small>` : ""}</div>
        ${c.foot ? `<div class="foot">${esc(c.foot)}</div>` : ""}
      </div>`).join("");
  }

  const COLORS = { input: "#5b8cff", output: "#35d39a", reasoning: "#7c5bff", cache: "#ffb454", cachew: "#ff6b6b" };

  function renderComposition() {
    const all = summary.totals.all;
    const parts = [
      { k: t("input"), v: all.input, c: COLORS.input },
      { k: t("output"), v: all.output, c: COLORS.output },
      { k: t("reasoning"), v: all.reasoning, c: COLORS.reasoning },
      { k: t("cache_read"), v: all.cacheRead, c: COLORS.cache },
      { k: t("cache_write"), v: all.cacheWrite, c: COLORS.cachew },
    ].filter((p) => p.v > 0);
    const total = parts.reduce((a, p) => a + p.v, 0);
    if (!total) { $("composition").innerHTML = `<p class="empty">${esc(t("no_data"))}</p>`; return; }
    $("composition").innerHTML =
      `<div class="stack">` +
      parts.map((p) => `<span style="width:${(p.v / total * 100).toFixed(2)}%;background:${p.c}" title="${esc(p.k)} ${fmt(p.v)}"></span>`).join("") +
      `</div>` +
      `<div class="legend">` +
      parts.map((p) => `<span><i style="background:${p.c}"></i>${esc(p.k)} ${fmt(p.v)} · ${pct(p.v, total)}%</span>`).join("") +
      `</div>`;
  }

  function renderSpeedRank() {
    const models = (summary.byModel || [])
      .filter((m) => m.speed && m.speed.n)
      .sort((a, b) => b.speed.avg - a.speed.avg)
      .slice(0, 10);
    if (!models.length) { $("speedRank").innerHTML = `<p class="empty">${esc(t("no_data"))}</p>`; return; }
    const max = Math.max(...models.map((m) => m.speed.avg));
    $("speedRank").innerHTML = models.map((m) => {
      const cls = m.speed.avg >= 40 ? "good" : m.speed.avg >= 15 ? "warn" : "bad";
      const q = m.speed.quality === "exact" ? "" : "~";
      return `<div class="bar-row">
        <span class="name" title="${esc(m.model)}">${esc(m.model)}</span>
        <span class="bar-track"><span class="bar-fill ${cls}" style="width:${Math.max(3, m.speed.avg / max * 100).toFixed(1)}%"></span></span>
        <span class="num">${m.speed.avg}${q} tok/s</span>
      </div>`;
    }).join("");
  }

  function renderTools() {
    const rows = Object.entries(summary.totals.byTool).map(([tool, v]) => {
      const src = (summary.sources || {})[tool] || {};
      if (!src.detected) {
        return `<tr class="off"><td>${esc(tool)}</td><td colspan="7"><span class="tag off">${esc(t("not_detected"))}</span></td></tr>`;
      }
      const sp = (speed.byTool || {})[tool] || {};
      const spTxt = sp.n ? `${sp.avg}${sp.quality === "exact" ? "" : "~"}` : "—";
      return `<tr>
        <td>${esc(tool)} <span class="tag ok">${esc(t("detected"))}</span></td>
        <td class="num">${fmt(v.requests)}</td>
        <td class="num">${fmt(v.sessions)}</td>
        <td class="num">${fmt(v.input)}</td>
        <td class="num">${fmt(v.output + v.reasoning)}</td>
        <td class="num">${fmt(v.cacheRead + v.cacheWrite)}</td>
        <td class="num">${fmt(v.total)}</td>
        <td class="num">${spTxt}</td>
      </tr>`;
    }).join("");
    $("tools").innerHTML = `<table><thead><tr>
      <th>${esc(t("tool"))}</th><th>${esc(t("requests"))}</th><th>${esc(t("sessions"))}</th>
      <th>${esc(t("input"))}</th><th>${esc(t("output"))}</th><th>${esc(t("cache_read"))}</th>
      <th>${esc(t("total"))}</th><th>${esc(t("avg_speed"))}</th>
    </tr></thead><tbody>${rows || `<tr><td class="empty">${esc(t("no_data"))}</td></tr>`}</tbody></table>`;
  }

  function renderModels() {
    const models = (summary.byModel || []).slice(0, 40);
    if (!models.length) { $("models").innerHTML = `<p class="empty">${esc(t("no_data"))}</p>`; return; }
    const rows = models.map((m) => {
      const sp = m.speed || {};
      const q = sp.quality === "exact" ? "" : "~";
      return `<tr>
        <td title="${esc(m.model)}">${esc(m.model)}</td>
        <td>${esc(m.tool)}</td>
        <td class="num">${fmt(m.requests)}</td>
        <td class="num">${fmt(m.input)}</td>
        <td class="num">${fmt(m.output + m.reasoning)}</td>
        <td class="num">${fmt(m.cacheRead + m.cacheWrite)}</td>
        <td class="num">${fmt(m.total)}</td>
        <td class="num">${sp.n ? `${sp.avg}${q} <span class="tag">${esc(t("samples"))} ${sp.n}</span>` : "—"}</td>
        <td class="num">${sp.p50 != null ? sp.p50 + q : "—"}</td>
        <td class="num">${sp.max != null ? sp.max + q : "—"}</td>
      </tr>`;
    }).join("");
    $("models").innerHTML = `<table><thead><tr>
      <th>${esc(t("model"))}</th><th>${esc(t("tool"))}</th><th>${esc(t("requests"))}</th>
      <th>${esc(t("input"))}</th><th>${esc(t("output"))}</th><th>${esc(t("cache_read"))}</th>
      <th>${esc(t("total"))}</th><th>${esc(t("avg_speed"))}</th><th>${esc(t("p50"))}</th><th>${esc(t("max"))}</th>
    </tr></thead><tbody>${rows}</tbody></table>`;
  }

  function renderSources() {
    if (!listData) return;
    const fileRows = Object.entries(listData.fileSources || {}).map(([tool, s]) => {
      const p = listData.paths[tool];
      const path = Array.isArray(p) ? p.join("  ·  ") : p || "";
      return `<tr class="${s.detected ? "" : "off"}">
        <td>${esc(t("sources_kind_file"))}</td>
        <td>${esc(tool)} ${s.detected ? `<span class="tag ok">${esc(t("detected"))} ${s.records}</span>` : `<span class="tag off">${esc(t("not_detected"))}</span>`}</td>
        <td style="text-align:left;color:var(--muted)">${esc(path)}</td>
      </tr>`;
    }).join("");
    const servers = listData.servers || {};
    const serverRows = Object.entries(servers).map(([name, s]) => {
      const on = !s.running;
      const info = s.version ? `v${s.version}` : (s.models != null ? `${s.models} models` : (s.status || ""));
      return `<tr class="${on ? "" : "off"}">
        <td>${esc(t("sources_kind_server"))}</td>
        <td>${esc(name)} ${on ? `<span class="tag ok">${esc(t("running"))}</span>` : `<span class="tag off">${esc(t("not_running"))}</span>`}</td>
        <td style="text-align:left;color:var(--muted)">${esc(s.url || "")} ${esc(info)}</td>
      </tr>`;
    }).join("");
    $("sources").innerHTML = `<table><thead><tr>
      <th>${esc(t("sources_kind_file"))}</th><th>${esc(t("tool"))}</th><th style="text-align:left">path</th>
    </tr></thead><tbody>${fileRows}${serverRows}</tbody></table>`;
  }

  /* -------------------------------- bench -------------------------------- */

  async function runBench() {
    if (benchBusy) return;
    benchBusy = true;
    const btn = $("benchBtn");
    btn.disabled = true;
    btn.textContent = t("bench_running");
    $("benchResult").innerHTML = `<p class="empty">${esc(t("bench_running"))}</p>`;
    try {
      const target = $("benchTarget").value;
      const model = $("benchModel").value.trim();
      const data = await getJSON(`/api/bench?target=${encodeURIComponent(target)}${model ? `&model=${encodeURIComponent(model)}` : ""}`);
      const r = Array.isArray(data) ? data[0] : null;
      if (!r) throw new Error("no server responded");
      const kv = [
        [t("model"), r.model],
        [t("load_time"), r.loadSec != null ? fmtSec(r.loadSec) : "—"],
        [t("prompt_eval"), r.promptSpeed != null ? `${r.promptSpeed} tok/s` : "—"],
        [t("generation"), `${r.outputTokens} tok · ${fmtSec(r.generationSec)}`],
        [t("ttft"), r.timeToFirstToken != null ? fmtSec(r.timeToFirstToken) : "—"],
        [t("wall_clock"), fmtSec(r.wallSec)],
      ];
      $("benchResult").innerHTML = `
        <div class="bench-out">
          <div class="bench-big"><span class="n">${r.speed}</span><span class="u">tok/s · ${esc(r.tool)}</span></div>
          <div class="kv">${kv.map(([k, v]) => `<div class="item"><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div></div>`).join("")}</div>
        </div>`;
    } catch (e) {
      $("benchResult").innerHTML = `<p class="empty">${esc(t("bench_failed"))}: ${esc(e.message)}</p>`;
    } finally {
      benchBusy = false;
      btn.disabled = false;
      btn.textContent = t("bench_run");
      applyI18n();
    }
  }

  /* ------------------------------- live feed ----------------------------- */

  const liveRows = new Map();

  const buildLiveRow = (item) => {
    const li = document.createElement("li");
    li.dataset.id = item.id;
    const time = new Date(item.ts).toLocaleTimeString();
    if (item.kind === "generation") {
      const approx = item.quality === "exact" ? "" : "~";
      li.innerHTML =
        `<span class="t">${esc(time)} · ${esc(item.model)}<br>${esc(item.tool)} · ${fmt(item.outputTokens)} tok · ${item.durationSec}s</span>` +
        `<span class="s">${item.speed}${approx}<br><small class="t">tok/s</small></span>`;
    } else {
      li.innerHTML =
        `<span class="t">${esc(time)} · ${esc(item.model)}<br>${esc(item.tool)} · ${fmt(item.totalTokens)} tok (${fmt(item.inputTokens)} in / ${fmt(item.outputTokens)} out)</span>` +
        `<span class="s">—<br><small class="t">${esc(t("no_speed"))}</small></span>`;
    }
    return li;
  };

  // Insert or update in place: a message that finishes later replaces its row
  // instead of appearing twice.
  const liveUpsert = (item) => {
    const list = $("liveList");
    const li = buildLiveRow(item);
    const old = liveRows.get(item.id);
    if (old && old.isConnected) old.replaceWith(li);
    else list.prepend(li);
    liveRows.set(item.id, li);
    if (item.kind === "generation") $("liveNow").textContent = item.speed;
    while (list.children.length > 30) {
      const last = list.lastElementChild;
      if (!last) break;
      liveRows.delete(last.dataset.id);
      last.remove();
    }
  };

  const renderLiveHistory = (items) => {
    const list = $("liveList");
    list.innerHTML = "";
    liveRows.clear();
    for (const item of items || []) liveUpsert(item);
    if (!(items || []).length) list.innerHTML = `<li class="t">${esc(t("live_waiting"))}</li>`;
  };

  async function loadRecent() {
    try {
      const data = await getJSON("/api/recent?n=12");
      renderLiveHistory(data.items);
    } catch { /* keep whatever the live stream delivered */ }
  }

  function connectLive() {
    const es = new EventSource("/api/watch");
    const dot = $("liveDot");
    es.onopen = () => { dot.className = "dot on"; };
    es.onerror = () => { dot.className = "dot off"; };
    es.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.event === "closed") { dot.className = "dot off"; return; }
      if (msg.event === "hello") { dot.className = "dot on"; return; }
      if (msg.event === "history") { renderLiveHistory(msg.items); return; }
      if (msg.event === "generation" || msg.event === "usage") {
        dot.className = "dot on";
        liveUpsert({ ...msg, kind: msg.event });
      }
    };
  }

  /* -------------------------------- wiring ------------------------------- */

  $("langBtn").addEventListener("click", () => {
    lang = lang === "zh" ? "en" : "zh";
    localStorage.setItem("tsm_lang", lang);
    applyI18n();
    if (summary) render();
  });

  $("refreshBtn").addEventListener("click", loadAll);

  $("since").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-since]");
    if (!btn) return;
    since = btn.dataset.since;
    localStorage.setItem("tsm_since", since);
    [...$("since").children].forEach((b) => b.classList.toggle("active", b === btn));
    loadAll();
  });

  $("benchBtn").addEventListener("click", runBench);

  [...$("since").children].forEach((b) => b.classList.toggle("active", (b.dataset.since || "") === since));

  applyI18n();
  loadAll();
  loadRecent();
  // Keep-alive so the packaged app knows its window is still open (server watchdog).
  setInterval(() => { fetch("/api/ping").catch(() => {}); }, 8000);
  // ?nolive=1 disables the live feed (useful for headless screenshots / embedding)
  if (!new URLSearchParams(location.search).has("nolive")) connectLive();
  setInterval(() => { if ($("autoRefresh").checked && !benchBusy) loadAll(); }, 15000);
})();
