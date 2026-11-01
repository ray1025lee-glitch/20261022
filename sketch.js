
/*
========================================================
  物理在家玩｜Physics Lab at Home
  使用技術：p5.js、Google Sheets CSV、Gemini API、MathJax
  功能：隨機五題、實驗媒體、答題評分、AI 助教
========================================================
*/

/* ======================================================
   01. 全域設定：題庫網址、AI Worker、遊戲規則
====================================================== */

// Google Sheets 發布成 CSV 後的公開網址
const SHEET_CSV_URL = "https://docs.google.com/spreadsheets/d/e/2PACX-1vRNdE297uPGOHx2bKHN1wiBVC3EXlsVF2eGV1toMXHmPfNqK6zARoQOHJ4t_RzhQyl_tUhKCWmSx3Ga/pub?gid=0&single=true&output=csv";
// 你已經部署成功的 Cloudflare Worker 網址
const AI_WORKER_URL =
  "https://textbook-ai-api.ray1025lee.workers.dev/";

// 每場遊戲抽出的題數
const QUESTIONS_PER_GAME = 5;

const STATS_WEB_APP_URL =
  "https://script.google.com/macros/s/AKfycbw2oHsoh5c-Lnz5tE2N6IK8IqX5dKehXIDlSl7GCWHRY-DwK2UQVAbgsTdo1seVIV-eTA/exec";
let gameSessionId = "";
let gameStartTime = 0;
let currentPlayerName = "匿名玩家";
let statsSentForSession = false;
const AUDIO_SETTINGS_KEY = "physics-game-audio-v1";
const soundSettings = { music: 0.35, effects: 0.7 };
const gameSounds = {};

function initGameSounds() {
  const files = { music: "music1.mp3", correct: "correct.mp3", wrong: "wrong.mp3", click: "click.mp3" };
  try {
    const saved = JSON.parse(localStorage.getItem(AUDIO_SETTINGS_KEY) || "{}");
    for (const key of ["music", "effects"]) {
      if (Number.isFinite(saved[key])) soundSettings[key] = Math.max(0, Math.min(1, saved[key]));
    }
  } catch (_) { /* 瀏覽器可能禁止儲存 */ }
  for (const [key, file] of Object.entries(files)) {
    const audio = new Audio(file);
    audio.preload = "auto";
    audio.volume = key === "music" ? soundSettings.music : soundSettings.effects;
    if (key === "music") audio.loop = true;
    gameSounds[key] = audio;
  }
  syncSoundControls();
}
function startMusic() {
  const audio = gameSounds.music;
  if (audio && audio.paused && soundSettings.music > 0) audio.play().catch(() => {});
}
function playGameSound(name) {
  const audio = gameSounds[name];
  if (!audio || soundSettings.effects <= 0) return;
  audio.pause();
  audio.currentTime = 0;
  audio.volume = soundSettings.effects;
  audio.play().catch(() => {});
}
function syncSoundControls() {
  for (const key of ["music", "effects"]) {
    const slider = document.getElementById(key + "-volume");
    const value = document.getElementById(key + "-volume-value");
    if (slider) slider.value = Math.round(soundSettings[key] * 100);
    if (value) value.textContent = Math.round(soundSettings[key] * 100) + "%";
  }
  if (gameSounds.music) gameSounds.music.volume = soundSettings.music;
}
function bindSoundSettings() {
  const gear = document.getElementById("sound-settings-button");
  const panel = document.getElementById("sound-settings-panel");
  gear.addEventListener("click", () => {
    panel.hidden = !panel.hidden;
    gear.setAttribute("aria-expanded", String(!panel.hidden));
  });
  for (const key of ["music", "effects"]) {
    document.getElementById(key + "-volume").addEventListener("input", event => {
      soundSettings[key] = Number(event.target.value) / 100;
      syncSoundControls();
      try { localStorage.setItem(AUDIO_SETTINGS_KEY, JSON.stringify(soundSettings)); } catch (_) {}
      if (key === "music") {
        if (soundSettings.music === 0) gameSounds.music.pause();
        else startMusic();
      }
    });
  }
  document.addEventListener("click", event => {
    if (event.target.closest("button") && !event.target.closest(".option-button") && !event.target.closest("#sound-settings-panel")) {
      startMusic();
      playGameSound("click");
    }
  });
}
function makeSessionId() {
  return typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : "session-" + Date.now() + "-" + Math.random().toString(36).slice(2);
}
function sendLearningStats(total, correct, accuracy) {
  if (statsSentForSession) return;
  statsSentForSession = true;
  const payload = {
    timestamp: new Date().toISOString(),
    playerName: currentPlayerName,
    gameSessionId,
    totalQuestions: total,
    correctCount: correct,
    accuracy
  };
  const status = document.getElementById("stats-save-status");
  status.textContent = "正在送出學習紀錄……";
  // Google Apps Script 跨網域寫入：text/plain 避免預檢，no-cors 回應不可讀。
  // 因此只能確認瀏覽器已送出請求，無法在此證實試算表寫入成功。
  fetch(STATS_WEB_APP_URL, {
    method: "POST", mode: "no-cors", redirect: "follow",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify(payload), keepalive: true
  }).then(() => {
    if (status) status.textContent = "已送出紀錄；請到 Google Sheets 確認是否新增資料。";
  }).catch(error => {
    console.error("學習紀錄送出失敗", error);
    if (status) status.textContent = "紀錄送出失敗，請檢查網路或 Apps Script 部署權限。";
  });
}


// 遊戲狀態與題庫資料
let allQuestions = [];
let gameQuestions = [];
let currentQuestionIndex = 0;
let score = 0;
let hasAnswered = false;
let gameStarted = false;
let isLoading = false;

// p5.js 的主要畫面容器
let appRoot;


/* ======================================================
   02. p5.js 入口：建立全螢幕遊戲
====================================================== */

function setup() {
  // 不使用傳統 p5 畫布，改用響應式 HTML 介面
  noCanvas();

  // 設定頁面基本樣式
  document.documentElement.lang = "zh-Hant";
  document.body.style.margin = "0";
  document.body.style.padding = "0";
  document.body.style.background = "#070812";
  document.body.style.color = "#e8f7ff";
  document.body.style.fontFamily =
    '"LXGW WenKai Mono TC", monospace';

  // 載入遊戲需要的 CSS、字體與畫面元件
  injectStyles();
  createGameInterface();
  initGameSounds();
  bindSoundSettings();

  // 從 Google Sheets 載入題庫
  loadQuestionBank();
}


/* ======================================================
   03. 載入外部字體
====================================================== */

function loadExternalFonts() {
  // 使用 Google Fonts 載入指定的中文等寬字體
  if (!document.querySelector("#physics-font-link")) {
    const fontLink = document.createElement("link");
    fontLink.id = "physics-font-link";
    fontLink.rel = "stylesheet";
    fontLink.href =
      "https://fonts.googleapis.com/css2?family=LXGW+WenKai+Mono+TC&display=swap";

    document.head.appendChild(fontLink);
  }
}


/* ======================================================
   04. Cyberpunk 暗色霓虹風格
====================================================== */

function injectStyles() {
  // 載入中文字體
  loadExternalFonts();

  // 建立遊戲專用樣式
  const style = document.createElement("style");
  style.id = "physics-game-styles";

  style.textContent = `
    :root {
      --bg: #070812;
      --panel: rgba(17, 23, 43, 0.92);
      --panel-light: rgba(24, 34, 58, 0.92);
      --cyan: #48f6ff;
      --pink: #ff4fd8;
      --purple: #a98bff;
      --green: #70ffb4;
      --text: #e8f7ff;
      --muted: #91a8c9;
      --border: rgba(72, 246, 255, 0.28);
    }

    /* 全域盒模型與背景 */
    * {
      box-sizing: border-box;
    }

    html, body {
      min-height: 100%;
      width: 100%;
      background: var(--bg);
      color: var(--text);
    }

    body {
      overflow-x: hidden;
      font-family: "LXGW WenKai Mono TC", monospace;
      background-image:
        radial-gradient(
          circle at 15% 15%,
          rgba(76, 40, 160, 0.20),
          transparent 35%
        ),
        radial-gradient(
          circle at 85% 30%,
          rgba(0, 225, 255, 0.10),
          transparent 32%
        ),
        linear-gradient(
          135deg,
          #070812 0%,
          #0a1020 55%,
          #090713 100%
        );
    }

    /* 背景網格與霓虹裝飾 */
    #physics-app {
      position: relative;
      min-height: 100vh;
      padding: 22px;
      isolation: isolate;
    }

    #physics-app::before {
      content: "";
      position: fixed;
      inset: 0;
      z-index: -1;
      pointer-events: none;
      opacity: 0.16;
      background-image:
        linear-gradient(
          rgba(72, 246, 255, 0.10) 1px,
          transparent 1px
        ),
        linear-gradient(
          90deg,
          rgba(72, 246, 255, 0.10) 1px,
          transparent 1px
        );
      background-size: 36px 36px;
      mask-image: linear-gradient(
        to bottom,
        black,
        transparent 90%
      );
    }

    /* 頂部導覽列 */
    .topbar {
      max-width: 1400px;
      margin: 0 auto 28px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      flex-wrap: wrap;
    }

    .brand {
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .brand-icon {
      width: 48px;
      height: 48px;
      display: grid;
      place-items: center;
      border: 1px solid var(--cyan);
      color: var(--cyan);
      border-radius: 14px;
      font-size: 24px;
      box-shadow: 0 0 18px rgba(72, 246, 255, 0.20);
    }

    .brand-name {
      font-size: clamp(19px, 3vw, 26px);
      font-weight: bold;
      letter-spacing: 2px;
      text-shadow: 0 0 12px rgba(72, 246, 255, 0.3);
    }

    .brand-subtitle {
      color: var(--muted);
      font-size: 11px;
      letter-spacing: 2px;
      margin-top: 4px;
    }

    /* 霓虹按鈕 */
    .neon-button {
      border: 1px solid var(--cyan);
      background: rgba(72, 246, 255, 0.08);
      color: var(--cyan);
      padding: 12px 18px;
      border-radius: 10px;
      cursor: pointer;
      font: inherit;
      transition: 0.2s ease;
    }

    .neon-button:hover {
      background: rgba(72, 246, 255, 0.18);
      box-shadow: 0 0 18px rgba(72, 246, 255, 0.18);
      transform: translateY(-1px);
    }

    .neon-button:disabled {
      opacity: 0.45;
      cursor: not-allowed;
      transform: none;
    }

    .pink-button {
      color: var(--pink);
      border-color: var(--pink);
      background: rgba(255, 79, 216, 0.08);
    }

    /* 主要內容區 */
    .main-layout {
      max-width: 1400px;
      margin: 0 auto;
      display: grid;
      grid-template-columns: minmax(0, 1fr) 290px;
      gap: 22px;
      align-items: start;
    }

    .main-column {
      min-width: 0;
    }

    /* 面板通用設計 */
    .panel {
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 18px;
      padding: clamp(16px, 3vw, 28px);
      box-shadow:
        0 0 24px rgba(72, 246, 255, 0.04),
        inset 0 0 24px rgba(72, 246, 255, 0.015);
      backdrop-filter: blur(12px);
    }

    .panel + .panel {
      margin-top: 18px;
    }

    .eyebrow {
      color: var(--cyan);
      font-size: 12px;
      letter-spacing: 2px;
      text-transform: uppercase;
    }

    .section-title {
      font-size: clamp(20px, 3vw, 28px);
      margin: 10px 0;
      line-height: 1.5;
    }

    .muted {
      color: var(--muted);
      line-height: 1.8;
    }

    /* 遊戲資訊列 */
    .game-stats {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 10px;
      margin: 20px 0;
    }

    .stat-box {
      border: 1px solid rgba(169, 139, 255, 0.24);
      border-radius: 12px;
      background: rgba(169, 139, 255, 0.06);
      padding: 14px;
    }

    .stat-label {
      color: var(--muted);
      font-size: 12px;
    }

    .stat-value {
      color: var(--cyan);
      font-size: clamp(20px, 3vw, 27px);
      margin-top: 6px;
      font-weight: bold;
      overflow-wrap: anywhere;
    }

    /* 題目進度條 */
    .progress-track {
      height: 7px;
      border-radius: 20px;
      background: #20263a;
      overflow: hidden;
      margin: 16px 0 22px;
    }

    .progress-fill {
      height: 100%;
      width: 0%;
      background: linear-gradient(
        90deg,
        var(--cyan),
        var(--pink)
      );
      box-shadow: 0 0 12px rgba(72, 246, 255, 0.5);
      transition: width 0.35s ease;
    }

    /* 題目媒體：影片、GIF、圖片 */
    .media-stage {
      width: 100%;
      min-height: 180px;
      max-height: 460px;
      margin: 20px 0;
      border: 1px solid rgba(72, 246, 255, 0.2);
      border-radius: 14px;
      overflow: hidden;
      display: grid;
      place-items: center;
      background:
        radial-gradient(
          circle,
          rgba(72, 246, 255, 0.06),
          transparent 70%
        ),
        #080b17;
    }

    .media-stage img,
    .media-stage video,
    .media-stage iframe {
      width: 100%;
      max-height: 460px;
      aspect-ratio: 16 / 9;
      object-fit: contain;
      border: 0;
      display: block;
    }

    .media-placeholder {
      color: var(--muted);
      padding: 32px 14px;
      text-align: center;
      line-height: 1.8;
    }

    /* 題目文字 */
    .question-text {
      font-size: clamp(17px, 2.5vw, 22px);
      line-height: 1.9;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      margin: 16px 0;
    }

    /* 選項按鈕 */
    .options-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 12px;
      margin-top: 20px;
    }

    .option-button {
      min-width: 0;
      text-align: left;
      border: 1px solid rgba(145, 168, 201, 0.25);
      background: rgba(145, 168, 201, 0.06);
      color: var(--text);
      border-radius: 12px;
      padding: 16px;
      min-height: 60px;
      cursor: pointer;
      font: inherit;
      line-height: 1.8;
      overflow-wrap: anywhere;
      transition: 0.2s ease;
    }

    .option-button:hover:not(:disabled) {
      border-color: var(--cyan);
      background: rgba(72, 246, 255, 0.08);
    }

    .option-button.correct {
      border-color: var(--green);
      background: rgba(112, 255, 180, 0.12);
    }

    .option-button.incorrect {
      border-color: var(--pink);
      background: rgba(255, 79, 216, 0.10);
    }

    /* 答題回饋 */
    .feedback-box {
      display: none;
      margin-top: 20px;
      border: 1px solid var(--border);
      background: rgba(72, 246, 255, 0.05);
      padding: 16px;
      border-radius: 12px;
      line-height: 1.9;
      overflow-wrap: anywhere;
    }

    .feedback-box.visible {
      display: block;
    }

    .feedback-title {
      color: var(--green);
      font-weight: bold;
      margin-bottom: 8px;
    }

    /* 側欄 */
    .sidebar {
      position: sticky;
      top: 20px;
    }

    .side-card {
      border: 1px solid rgba(255, 79, 216, 0.25);
      background: rgba(255, 79, 216, 0.04);
      border-radius: 16px;
      padding: 20px;
    }

    .side-card + .side-card {
      margin-top: 16px;
    }

    .side-card h3 {
      margin-top: 0;
    }

    .tag {
      display: inline-block;
      padding: 5px 9px;
      border: 1px solid rgba(72, 246, 255, 0.3);
      color: var(--cyan);
      border-radius: 6px;
      font-size: 11px;
      margin: 4px 4px 0 0;
    }

    /* AI 助教側邊抽屜 */
    .ai-drawer {
      position: fixed;
      z-index: 1000;
      top: 0;
      right: 0;
      width: min(440px, 100%);
      height: 100dvh;
      padding: 20px;
      background: rgba(9, 12, 28, 0.98);
      border-left: 1px solid var(--pink);
      box-shadow: -10px 0 40px rgba(255, 79, 216, 0.12);
      display: flex;
      flex-direction: column;
      gap: 12px;
      transform: translateX(105%);
      transition: transform 0.3s ease;
    }

    .ai-drawer.open {
      transform: translateX(0);
    }

    .drawer-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 12px;
    }

    .ai-messages {
      flex: 1;
      min-height: 0;
      overflow-y: auto;
      padding: 12px;
      border: 1px solid var(--border);
      border-radius: 12px;
      background: rgba(255, 255, 255, 0.02);
      line-height: 1.8;
      overflow-wrap: anywhere;
    }

    .ai-message {
      margin-bottom: 14px;
      padding: 12px;
      border-radius: 10px;
      background: rgba(72, 246, 255, 0.05);
    }

    .ai-message.user {
      border-left: 3px solid var(--pink);
    }

    .ai-message.bot {
      border-left: 3px solid var(--cyan);
    }

    .ai-input {
      width: 100%;
      min-height: 90px;
      resize: vertical;
      color: var(--text);
      background: #0d1224;
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 12px;
      font: inherit;
      line-height: 1.7;
    }

    /* 通用表單 */
    .input-field {
      width: 100%;
      padding: 12px;
      color: var(--text);
      background: #0d1224;
      border: 1px solid var(--border);
      border-radius: 10px;
      font: inherit;
    }

    /* MathJax 長公式的水平捲動 */
    .ai-message mjx-container,
    .feedback-box mjx-container {
      max-width: 100%;
      overflow-x: auto;
      overflow-y: hidden;
    }

    /* 載入提示與底部文字 */
    .status-line {
      min-height: 28px;
      color: var(--muted);
      line-height: 1.8;
      overflow-wrap: anywhere;
    }

    .footer {
      max-width: 1400px;
      margin: 24px auto 0;
      text-align: center;
      color: #627493;
      font-size: 11px;
      line-height: 1.8;
    }

    /* 手機與平板響應式版面 */
    @media (max-width: 900px) {
      #physics-app {
        padding: 14px;
      }

      .main-layout {
        grid-template-columns: minmax(0, 1fr);
      }

      .sidebar {
        position: static;
      }
    }

    @media (max-width: 560px) {
      .topbar {
        align-items: flex-start;
      }

      .brand-name {
        letter-spacing: 1px;
      }

      .game-stats {
        grid-template-columns: repeat(3, minmax(0, 1fr));
      }

      .stat-box {
        padding: 10px;
      }

      .options-grid {
        grid-template-columns: minmax(0, 1fr);
      }

      .media-stage {
        min-height: 150px;
      }

      .neon-button {
        padding: 10px 12px;
      }
    }
  `;

  style.textContent += `
    .sound-tools { position: relative; display: flex; align-items: center; gap: 8px; }
    .sound-gear { border: 1px solid rgba(72,246,255,.55); background: rgba(17,23,43,.95); color: #48f6ff; border-radius: 12px; padding: 10px 13px; font-size: 21px; cursor: pointer; }
    .sound-panel { position: absolute; top: calc(100% + 12px); right: 0; z-index: 1000; width: 245px; padding: 18px; background: #151b32; border: 1px solid #48f6ff; border-radius: 14px; box-shadow: 0 12px 40px #0009; }
    .sound-panel[hidden] { display: none !important; }
    .sound-panel label { display: flex; justify-content: space-between; margin: 12px 0 5px; }
    .sound-panel input[type=range] { width: 100%; accent-color: #48f6ff; }
    .player-name-input { display:block; width: min(100%, 320px); box-sizing:border-box; margin: 12px 0; padding: 12px; border-radius: 9px; background: #10172a; border: 1px solid #48f6ff88; color: white; font: inherit; }
    #stats-save-status { margin-top: 14px; font-size: .9rem; color: #b9d8e9; }
  `;
  document.head.appendChild(style);
}


/* ======================================================
   05. 建立遊戲 HTML 元件
====================================================== */

function createGameInterface() {
  // 建立全螢幕根容器
  appRoot = createDiv("");
  appRoot.id("physics-app");

  // 建立主要介面
  appRoot.elt.innerHTML = `
    <!-- 頂部品牌與 AI 助教按鈕 -->
    <header class="topbar">
      <div class="brand">
        <div class="brand-icon">⚛</div>
        <div>
          <div class="brand-name">物理在家玩</div>
          <div class="brand-subtitle">PHYSICS LAB AT HOME</div>
        </div>
      </div>

      <div class="sound-tools">
        <button id="sound-settings-button" class="sound-gear" aria-label="音量設定" aria-expanded="false" aria-controls="sound-settings-panel" title="音量設定">⚙</button>
        <div id="sound-settings-panel" class="sound-panel" hidden>
          <strong>🔊 音量設定</strong>
          <label for="music-volume">背景音樂 <span id="music-volume-value">35%</span></label>
          <input type="range" id="music-volume" min="0" max="100" value="35">
          <label for="effects-volume">操作與答題音效 <span id="effects-volume-value">70%</span></label>
          <input type="range" id="effects-volume" min="0" max="100" value="70">
          <small>將音量調至 0% 即可靜音</small>
        </div>
      <button
        id="open-ai-button"
        class="neon-button pink-button">
        ✦ 呼叫 AI 助教
      </button>
      </div>
    </header>

    <!-- 遊戲主要內容 -->
    <main class="main-layout">
      <section class="main-column">

        <!-- 歡迎與題庫狀態 -->
        <section class="panel" id="welcome-panel">
          <div class="eyebrow">EXPERIMENT · THINK · DISCOVER</div>
          <h1 class="section-title">用實驗，玩懂物理。</h1>
          <p class="muted">
            觀察實驗、分析現象、回答問題。
            每場挑戰將從老師的題庫中隨機抽出五題。
          </p>

          <div class="game-stats">
            <div class="stat-box">
              <div class="stat-label">每場題數</div>
              <div class="stat-value">05</div>
            </div>
            <div class="stat-box">
              <div class="stat-label">題庫題數</div>
              <div class="stat-value" id="bank-count">--</div>
            </div>
            <div class="stat-box">
              <div class="stat-label">本場分數</div>
              <div class="stat-value" id="welcome-score">0</div>
            </div>
          </div>

          <p id="bank-status" class="status-line">
            正在連線讀取 Google Sheets 題庫……
          </p>

          <label for="player-name">玩家名稱（建議使用暱稱）</label>
          <input id="player-name" class="player-name-input" maxlength="30" autocomplete="nickname" placeholder="輸入暱稱（可留空）">
          <button
            id="start-game-button"
            class="neon-button"
            disabled>
            載入題庫中……
          </button>

          <button
            id="reload-bank-button"
            class="neon-button"
            style="margin-left:8px">
            ↻ 重新載入題庫
          </button>
        </section>

        <!-- 答題畫面：開始遊戲後顯示 -->
        <section class="panel" id="quiz-panel" hidden>
          <div class="eyebrow" id="question-category">
            PHYSICS EXPERIMENT
          </div>

          <h2 class="section-title" id="question-title">
            實驗題目
          </h2>

          <div class="game-stats">
            <div class="stat-box">
              <div class="stat-label">目前題目</div>
              <div class="stat-value" id="question-number">1 / 5</div>
            </div>
            <div class="stat-box">
              <div class="stat-label">答對題數</div>
              <div class="stat-value" id="correct-count">0</div>
            </div>
            <div class="stat-box">
              <div class="stat-label">目前分數</div>
              <div class="stat-value" id="current-score">0</div>
            </div>
          </div>

          <!-- 遊戲進度條 -->
          <div class="progress-track">
            <div class="progress-fill" id="progress-fill"></div>
          </div>

          <!-- 顯示老師提供的實驗影片、GIF 或圖片 -->
          <div class="media-stage" id="experiment-media">
            <div class="media-placeholder">
              等待載入實驗媒體……
            </div>
          </div>

          <!-- 題目敘述 -->
          <div class="question-text" id="question-description"></div>

          <!-- 動態建立四個選項 -->
          <div class="options-grid" id="options-container"></div>

          <!-- 答題回饋與解說 -->
          <div class="feedback-box" id="feedback-box">
            <div class="feedback-title" id="feedback-title"></div>
            <div id="feedback-explanation"></div>
          </div>

          <!-- 下一題按鈕 -->
          <div style="margin-top:22px">
            <button
              id="next-question-button"
              class="neon-button"
              hidden>
              下一題 →
            </button>
          </div>
        </section>

        <!-- 遊戲結束畫面 -->
        <section class="panel" id="result-panel" hidden>
          <div class="eyebrow">MISSION COMPLETE</div>
          <h2 class="section-title">實驗挑戰完成！</h2>
          <p class="muted" id="result-message"></p>

          <div class="game-stats">
            <div class="stat-box">
              <div class="stat-label">最終分數</div>
              <div class="stat-value" id="final-score">0</div>
            </div>
            <div class="stat-box">
              <div class="stat-label">答對題數</div>
              <div class="stat-value" id="final-correct">0 / 5</div>
            </div>
            <div class="stat-box">
              <div class="stat-label">正確率</div>
              <div class="stat-value" id="final-rate">0%</div>
            </div>
          </div>

          <p id="stats-save-status" role="status" aria-live="polite"></p>
          <button
            id="play-again-button"
            class="neon-button">
            ↻ 再挑戰一次
          </button>

          <button
            id="ask-review-button"
            class="neon-button pink-button"
            style="margin-left:8px">
            ✦ 請 AI 助教複習
          </button>
        </section>
      </section>

      <!-- 右側說明與操作 -->
      <aside class="sidebar">
        <section class="side-card">
          <div class="eyebrow">HOW TO PLAY</div>
          <h3>挑戰規則</h3>
          <p class="muted">
            01｜仔細觀察實驗影片。<br>
            02｜閱讀題目與選項。<br>
            03｜選出你認為正確的答案。<br>
            04｜閱讀解說，累積物理知識。
          </p>
          <span class="tag">實驗觀察</span>
          <span class="tag">邏輯推理</span>
          <span class="tag">科學思考</span>
        </section>

        <section class="side-card">
          <div class="eyebrow">AI STUDY PARTNER</div>
          <h3>需要一點提示？</h3>
          <p class="muted">
            遇到不懂的物理概念時，可以打開 AI 助教，
            請它用不同方式解釋。
          </p>
          <button
            id="sidebar-ai-button"
            class="neon-button pink-button">
            開啟 AI 助教
          </button>
        </section>

        <section class="side-card">
          <div class="eyebrow">TEACHER CONTROL</div>
          <h3>老師的題庫</h3>
          <p class="muted">
            題目、選項、答案、解說與實驗媒體，
            都由 Google Sheets 題庫管理。
          </p>
          <p class="muted" style="font-size:12px">
            更新試算表後，點擊「重新載入題庫」即可重新讀取。
          </p>
        </section>
      </aside>
    </main>

    <!-- 頁尾 -->
    <footer class="footer">
      PHYSICS LAB AT HOME · 物理在家玩<br>
      透過觀察、提問與實驗，探索物理世界。
    </footer>

    <!-- AI 助教側邊抽屜 -->
    <aside
      class="ai-drawer"
      id="ai-drawer"
      aria-label="AI 助教面板">

      <div class="drawer-header">
        <div>
          <div class="eyebrow">AI LEARNING ASSISTANT</div>
          <h2 style="margin:6px 0">物理 AI 助教</h2>
        </div>

        <button
          id="close-ai-button"
          class="neon-button pink-button"
          aria-label="關閉 AI 助教">
          ✕
        </button>
      </div>

      <p class="muted" style="margin:0">
        可以詢問物理觀念、公式或目前的實驗題目。
      </p>

      <div class="ai-messages" id="ai-messages" aria-live="polite">
        <div class="ai-message bot">
          你好！我是物理 AI 助教。
          你想了解哪個物理概念？
        </div>
      </div>

      <textarea
        id="ai-input"
        class="ai-input"
        maxlength="2000"
        placeholder="例如：為什麼物體下落時速度會改變？">
      </textarea>

      <button id="send-ai-button" class="neon-button pink-button">
        傳送問題 ↑
      </button>
    </aside>
  `;

  // 綁定遊戲操作按鈕
  bindInterfaceEvents();
}


/* ======================================================
   06. 綁定所有按鈕事件
====================================================== */

function bindInterfaceEvents() {
  // 開始遊戲與重新載入題庫
  document.getElementById("start-game-button")
    .addEventListener("click", startGame);

  document.getElementById("reload-bank-button")
    .addEventListener("click", loadQuestionBank);

  // 下一題、再玩一次
  document.getElementById("next-question-button")
    .addEventListener("click", nextQuestion);

  document.getElementById("play-again-button")
    .addEventListener("click", startGame);

  // 開啟與關閉 AI 側邊抽屜
  document.getElementById("open-ai-button")
    .addEventListener("click", openAIDrawer);

  document.getElementById("sidebar-ai-button")
    .addEventListener("click", openAIDrawer);

  document.getElementById("close-ai-button")
    .addEventListener("click", closeAIDrawer);

  // AI 對話操作
  document.getElementById("send-ai-button")
    .addEventListener("click", askGameAI);

  // 支援按下 Ctrl + Enter 傳送問題
  document.getElementById("ai-input")
    .addEventListener("keydown", (event) => {
      if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        askGameAI();
      }
    });

  // 請 AI 針對剛才的遊戲內容協助複習
  document.getElementById("ask-review-button")
    .addEventListener("click", () => {
      openAIDrawer();

      const message =
        "請幫我複習剛才這場物理實驗挑戰的核心概念，" +
        "並用繁體中文整理重要觀念、公式與常見錯誤。";

      document.getElementById("ai-input").value = message;
    });
}


/* ======================================================
   07. 讀取 Google Sheets 公開 CSV 題庫
====================================================== */

async function loadQuestionBank() {
  // 更新載入狀態，避免使用者重複點擊
  isLoading = true;

  const status = document.getElementById("bank-status");
  const startButton = document.getElementById("start-game-button");

  status.textContent = "正在讀取 Google Sheets 題庫……";
  startButton.disabled = true;
  startButton.textContent = "載入題庫中……";

  try {
    // 加入時間參數，減少瀏覽器使用舊快取
    const url = SHEET_CSV_URL +
      (SHEET_CSV_URL.includes("?") ? "&" : "?") +
      "t=" + Date.now();

    // 透過 fetch 下載 CSV 文字
    const response = await fetch(url, {
      method: "GET",
      cache: "no-store"
    });

    // 檢查 HTTP 回應是否成功
    if (!response.ok) {
      throw new Error("題庫下載失敗，HTTP " + response.status);
    }

    // 將 CSV 解析成物件陣列
    const csvText = await response.text();
    const rows = parseCSV(csvText);

    // 第一列視為欄位名稱
    if (rows.length < 2) {
      allQuestions = [];
      updateBankStatus(
        "題庫尚無有效題目。請老師先填入 Google Sheets。",
        0
      );
      return;
    }

    // 將欄位名稱轉成小寫並移除空白
    const headers = rows[0].map((header) =>
      String(header).trim().toLowerCase()
    );

    // 將每一列轉成可讀取的題目物件
    const parsedQuestions = rows.slice(1)
      .map((row) => {
        const item = {};

        headers.forEach((header, index) => {
          item[header] = String(row[index] ?? "").trim();
        });

        return normalizeQuestion(item);
      })
      // 只保留有題目、四個選項與正確答案的列
      .filter(isValidQuestion);

    allQuestions = parsedQuestions;

    // 更新畫面上的題庫數量與狀態
    updateBankStatus(
      allQuestions.length > 0
        ? "題庫載入成功，可以開始挑戰！"
        : "已連線，但目前沒有符合欄位格式的有效題目。",
      allQuestions.length
    );

  } catch (error) {
    console.error("題庫載入失敗：", error);

    allQuestions = [];

    updateBankStatus(
      "題庫載入失敗。請檢查 CSV 發布設定與欄位名稱。",
      0
    );
  } finally {
  isLoading = false;

  const startButton =
    document.getElementById("start-game-button");

  if (startButton) {
    startButton.disabled = allQuestions.length === 0;

    startButton.textContent =
      allQuestions.length > 0
        ? "▶ 開始五題挑戰"
        : "等待題庫資料";
  }
}
}


/* ======================================================
   08. 解析 CSV：支援引號、逗號與多行文字
====================================================== */

function parseCSV(text) {
  // 用逐字解析方式，避免題目中的逗號造成欄位錯位
  const rows = [];
  let row = [];
  let field = "";
  let insideQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const next = text[i + 1];

    // 處理 CSV 中的雙引號跳脫
    if (char === '"' && insideQuotes && next === '"') {
      field += '"';
      i++;
      continue;
    }

    // 切換是否正在引號欄位內
    if (char === '"') {
      insideQuotes = !insideQuotes;
      continue;
    }

    // 只有在引號外，逗號才是欄位分隔符號
    if (char === "," && !insideQuotes) {
      row.push(field);
      field = "";
      continue;
    }

    // 只有在引號外，換行才是資料列分隔符號
    if ((char === "\n" || char === "\r") && !insideQuotes) {
      if (char === "\r" && next === "\n") {
        i++;
      }

      row.push(field);

      // 跳過完全空白的資料列
      if (row.some((value) => value.trim() !== "")) {
        rows.push(row);
      }

      row = [];
      field = "";
      continue;
    }

    // 其他字元加入目前欄位
    field += char;
  }

  // 加入最後一個欄位與資料列
  row.push(field);

  if (row.some((value) => value.trim() !== "")) {
    rows.push(row);
  }

  return rows;
}


/* ======================================================
   09. 統一題庫欄位名稱
====================================================== */

function normalizeQuestion(item) {
  // 同時支援常見欄位別名，方便老師使用
  return {
    id: item.id || item.questionid || "",
    category: item.category || item.topic || "物理實驗",
    question: item.question || item.title || "",
    optionA: item.optiona || item.a || "",
    optionB: item.optionb || item.b || "",
    optionC: item.optionc || item.c || "",
    optionD: item.optiond || item.d || "",
    correctAnswer: normalizeAnswer(
      item.correctanswer || item.answer || ""
    ),
    explanation: item.explanation || item.feedback || "",
    mediaType: (item.mediatype || item.type || "").toLowerCase(),
    mediaUrl: item.mediaurl || item.media || item.video || "",
  };
}


/* ======================================================
   10. 統一正確答案格式
====================================================== */

function normalizeAnswer(answer) {
  // 將答案轉為 A、B、C、D 的標準格式
  const value = String(answer).trim().toUpperCase();

  // 支援直接填 A/B/C/D 或選項文字
  if (["A", "B", "C", "D"].includes(value)) {
    return value;
  }

  return value;
}


/* ======================================================
   11. 檢查題目是否完整
====================================================== */

function isValidQuestion(question) {
  // 一題至少需要題幹、四個選項與有效正確答案
  const hasRequiredFields =
    question.question &&
    question.optionA &&
    question.optionB &&
    question.optionC &&
    question.optionD &&
    question.correctAnswer;

  if (!hasRequiredFields) {
    return false;
  }

  // 正確答案只能是 A、B、C 或 D
  if (!["A", "B", "C", "D"].includes(question.correctAnswer)) {
    return false;
  }

  return true;
}


/* ======================================================
   12. 更新題庫狀態
====================================================== */

function updateBankStatus(message, count) {
  // 更新首頁的題庫數量、狀態與開始按鈕
  document.getElementById("bank-count").textContent = count;
  document.getElementById("bank-status").textContent = message;

  const startButton = document.getElementById("start-game-button");

  // 題目至少有一題才能開始
  startButton.disabled = count === 0 || isLoading;
  startButton.textContent =
    count > 0 ? "▶ 開始五題挑戰" : "等待題庫資料";
}


/* ======================================================
   13. 隨機抽題
====================================================== */

function startGame() {
  // 題庫不足五題時，抽出現有的全部有效題目
  if (allQuestions.length === 0) {
    document.getElementById("bank-status").textContent =
      "目前沒有有效題目，請先填寫 Google Sheets 題庫。";
    return;
  }

  // 複製題庫並使用 Fisher-Yates 洗牌
  const shuffled = [...allQuestions];

  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }

  // 抽取最多五題
  gameQuestions = shuffled.slice(
    0,
    Math.min(QUESTIONS_PER_GAME, shuffled.length)
  );

  // 建立本場統計資訊
  currentPlayerName = document.getElementById("player-name").value.trim() || "匿名玩家";
  gameSessionId = makeSessionId();
  gameStartTime = Date.now();
  statsSentForSession = false;
  document.getElementById("stats-save-status").textContent = "";
  startMusic();

  // 重設遊戲狀態
  currentQuestionIndex = 0;
  score = 0;
  hasAnswered = false;
  gameStarted = true;

  // 切換至答題畫面
  document.getElementById("welcome-panel").hidden = true;
  document.getElementById("result-panel").hidden = true;
  document.getElementById("quiz-panel").hidden = false;

  // 顯示第一題
  showQuestion();
}


/* ======================================================
   14. 顯示目前題目
====================================================== */

function showQuestion() {
  // 取得目前題目
  const question = gameQuestions[currentQuestionIndex];

  if (!question) {
    finishGame();
    return;
  }

  // 重設答題狀態與畫面回饋
  hasAnswered = false;

  document.getElementById("question-category").textContent =
    question.category || "PHYSICS EXPERIMENT";

  document.getElementById("question-title").textContent =
    "實驗任務 " + String(currentQuestionIndex + 1).padStart(2, "0");

  document.getElementById("question-number").textContent =
    (currentQuestionIndex + 1) + " / " + gameQuestions.length;

  document.getElementById("correct-count").textContent =
    score / 100;

  document.getElementById("current-score").textContent = score;
  document.getElementById("welcome-score").textContent = score;

  // 更新進度條
  document.getElementById("progress-fill").style.width =
    (currentQuestionIndex / gameQuestions.length * 100) + "%";

  // 題幹以純文字顯示，避免試算表內容被當作 HTML 執行
  document.getElementById("question-description").textContent =
    question.question;

  // 清除上一題的答題回饋
  const feedback = document.getElementById("feedback-box");
  feedback.classList.remove("visible");

  document.getElementById("feedback-title").textContent = "";
  document.getElementById("feedback-explanation").textContent = "";

  // 隱藏下一題按鈕，等待回答
  document.getElementById("next-question-button").hidden = true;

  // 建立四個選項
  renderOptions(question);

  // 顯示這一題的實驗媒體
  renderExperimentMedia(question);

  // 捲動到題目頂部
  document.getElementById("quiz-panel")
    .scrollIntoView({ behavior: "smooth", block: "start" });
}


/* ======================================================
   15. 建立選項
====================================================== */

function renderOptions(question) {
  // 取得選項容器並清除舊選項
  const container = document.getElementById("options-container");
  container.replaceChildren();

  // 定義四個選項資料
  const options = [
    ["A", question.optionA],
    ["B", question.optionB],
    ["C", question.optionC],
    ["D", question.optionD],
  ];

  // 動態建立按鈕
  options.forEach(([letter, label]) => {
    const button = document.createElement("button");

    button.type = "button";
    button.className = "option-button";
    button.dataset.answer = letter;

    // 使用 textContent，避免題庫文字執行 HTML
    button.textContent = letter + "．" + label;

    // 點擊選項後判斷正誤
    button.addEventListener("click", () => {
      submitAnswer(letter, button);
    });

    container.appendChild(button);
  });
}


/* ======================================================
   16. 判斷答案與計分
====================================================== */

function submitAnswer(selectedAnswer, selectedButton) {
  // 每一題只能作答一次
  if (hasAnswered) {
    return;
  }

  hasAnswered = true;

  const question = gameQuestions[currentQuestionIndex];
  const isCorrect = selectedAnswer === question.correctAnswer;

  // 每答對一題得 100 分
  if (isCorrect) {
    score += 100;
  }
  playGameSound(isCorrect ? "correct" : "wrong");

  // 鎖定所有選項並標示正確答案
  document.querySelectorAll(".option-button").forEach((button) => {
    button.disabled = true;

    if (button.dataset.answer === question.correctAnswer) {
      button.classList.add("correct");
    }
  });

  // 如果選錯，標示所選選項
  if (!isCorrect) {
    selectedButton.classList.add("incorrect");
  }

  // 更新分數
  document.getElementById("current-score").textContent = score;
  document.getElementById("welcome-score").textContent = score;

  document.getElementById("correct-count").textContent =
    score / 100;

  // 顯示答題結果與老師提供的解說
  const feedback = document.getElementById("feedback-box");
  const title = document.getElementById("feedback-title");
  const explanation = document.getElementById("feedback-explanation");

  feedback.classList.add("visible");

  title.textContent = isCorrect
    ? "✓ 回答正確！"
    : "✕ 再複習一下觀念";

  // 解說以純文字顯示；若含 LaTeX，則交給 MathJax 排版
  explanation.textContent =
    (question.explanation || "老師尚未提供這題的解說。") +
    "\n\n正確答案：" + question.correctAnswer;

  // 嘗試排版解說中的數學公式
  typesetMath(explanation);

  // 更新進度條
  document.getElementById("progress-fill").style.width =
    ((currentQuestionIndex + 1) / gameQuestions.length * 100) + "%";

  // 顯示下一題或結算按鈕
  const nextButton = document.getElementById("next-question-button");

  nextButton.hidden = false;

  nextButton.textContent =
    currentQuestionIndex === gameQuestions.length - 1
      ? "查看最終成績 →"
      : "下一題 →";
}


/* ======================================================
   17. 顯示實驗影片、GIF、圖片
====================================================== */

function renderExperimentMedia(question) {
  // 清除上一題媒體
  const stage = document.getElementById("experiment-media");
  stage.replaceChildren();

  // 沒有提供媒體網址時，顯示提示
  if (!question.mediaUrl) {
    const placeholder = document.createElement("div");
    placeholder.className = "media-placeholder";
    placeholder.textContent =
      "🧪 本題沒有附加實驗媒體，請依題目描述進行思考。";

    stage.appendChild(placeholder);
    return;
  }

  // 判斷媒體類型
  const type = question.mediaType;
  const url = question.mediaUrl.trim();

  // 支援 YouTube 影片網址
  const youtubeId = extractYouTubeId(url);

  if (type === "youtube" || youtubeId) {
    if (!youtubeId) {
      showMediaError(stage, "YouTube 網址無法辨識。");
      return;
    }

    const iframe = document.createElement("iframe");
    iframe.src =
      "https://www.youtube-nocookie.com/embed/" +
      encodeURIComponent(youtubeId);

    iframe.title = "物理實驗影片";
    iframe.loading = "lazy";
    iframe.allow =
      "accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share";
    iframe.allowFullscreen = true;

    stage.appendChild(iframe);
    return;
  }

  // 支援 MP4、WebM 等瀏覽器可播放的影片
  if (
    type === "video" ||
    /\.(mp4|webm|ogg)(\?.*)?$/i.test(url)
  ) {
    const video = document.createElement("video");

    video.src = url;
    video.controls = true;
    video.playsInline = true;
    video.preload = "metadata";

    video.addEventListener("error", () => {
      showMediaError(stage, "影片無法載入，請檢查影片網址與權限。");
    });

    stage.appendChild(video);
    return;
  }

  // 支援 GIF、PNG、JPG、WebP 等圖片格式
  const image = document.createElement("img");

  image.src = url;
  image.alt = "物理實驗示意圖或動態貼圖";
  image.loading = "lazy";

  image.addEventListener("error", () => {
    showMediaError(stage, "圖片或 GIF 無法載入，請檢查媒體網址。");
  });

  stage.appendChild(image);
}


/* ======================================================
   18. 擷取 YouTube 影片 ID
====================================================== */

function extractYouTubeId(url) {
  // 支援 watch?v=、youtu.be/ 與 /embed/ 格式
  try {
    const parsed = new URL(url);

    if (parsed.hostname.includes("youtu.be")) {
      return parsed.pathname.split("/").filter(Boolean)[0] || "";
    }

    if (parsed.hostname.includes("youtube.com")) {
      if (parsed.pathname === "/watch") {
        return parsed.searchParams.get("v") || "";
      }

      const match = parsed.pathname.match(/\/(embed|shorts)\/([^/]+)/);

      return match ? match[2] : "";
    }
  } catch (error) {
    // 不符合網址格式時回傳空字串
  }

  return "";
}


/* ======================================================
   19. 媒體載入失敗提示
====================================================== */

function showMediaError(container, message) {
  // 顯示文字提示，不讓壞掉的媒體影響整個遊戲
  container.replaceChildren();

  const placeholder = document.createElement("div");
  placeholder.className = "media-placeholder";
  placeholder.textContent = "⚠ " + message;

  container.appendChild(placeholder);
}


/* ======================================================
   20. 進入下一題
====================================================== */

function nextQuestion() {
  // 索引加一後顯示下一題
  currentQuestionIndex++;

  if (currentQuestionIndex >= gameQuestions.length) {
    finishGame();
    return;
  }

  showQuestion();
}


/* ======================================================
   21. 結算本場遊戲
====================================================== */

function finishGame() {
  // 隱藏題目並顯示結算頁
  document.getElementById("quiz-panel").hidden = true;
  document.getElementById("welcome-panel").hidden = true;
  document.getElementById("result-panel").hidden = false;

  // 計算答對題數與正確率
  const correctCount = score / 100;
  const total = gameQuestions.length;
  const rate = total > 0 ? Math.round(correctCount / total * 100) : 0;

  // 結算後自動送出六欄學習紀錄
  sendLearningStats(total, correctCount, rate);

  // 更新結算數據
  document.getElementById("final-score").textContent = score;
  document.getElementById("final-correct").textContent =
    correctCount + " / " + total;

  document.getElementById("final-rate").textContent = rate + "%";

  document.getElementById("result-message").textContent =
    rate === 100
      ? "太棒了！你已經掌握本場實驗的核心觀念。"
      : rate >= 60
        ? "做得不錯！建議再閱讀錯題解說，讓觀念更完整。"
        : "別擔心！科學需要觀察與反覆思考，請利用 AI 助教複習。";

  // 捲動至成績畫面
  document.getElementById("result-panel")
    .scrollIntoView({ behavior: "smooth", block: "start" });
}


/* ======================================================
   22. 開啟與關閉 AI 助教
====================================================== */

function openAIDrawer() {
  // 顯示右側 AI 對話面板
  document.getElementById("ai-drawer").classList.add("open");
}

function closeAIDrawer() {
  // 關閉 AI 對話面板
  document.getElementById("ai-drawer").classList.remove("open");
}


/* ======================================================
   23. 顯示 AI 對話訊息
====================================================== */

function appendAIMessage(role, text) {
  // 建立訊息容器
  const message = document.createElement("div");
  message.className = "ai-message " + role;

  // AI 回應可能含 Markdown 與數學公式
  // 先安全地顯示原文，再交給專用排版函式
  if (role === "bot") {
    renderMarkdownSafely(message, text);
  } else {
    message.textContent = text;
  }

  // 加入對話區並自動捲動到底部
  const messages = document.getElementById("ai-messages");
  messages.appendChild(message);
  messages.scrollTop = messages.scrollHeight;

  return message;
}


/* ======================================================
   24. 安全轉換 Markdown
====================================================== */

function renderMarkdownSafely(container, text) {
  // 如果 Markdown 與安全清理工具載入成功，就轉換格式
  if (
    window.marked &&
    typeof window.marked.parse === "function" &&
    window.DOMPurify &&
    typeof window.DOMPurify.sanitize === "function"
  ) {
    const html = window.marked.parse(text);
    container.innerHTML = window.DOMPurify.sanitize(html);
  } else {
    // 外部工具未載入時，退回純文字顯示
    container.textContent = text;
  }

  // 轉換後排版 LaTeX 數學公式
  typesetMath(container);
}


/* ======================================================
   25. MathJax 公式排版
====================================================== */

async function typesetMath(element) {
  // 等待 MathJax 載入後再排版，避免載入順序造成錯誤
  try {
    if (!window.MathJax || !window.MathJax.startup) {
      return;
    }

    await window.MathJax.startup.promise;

    if (window.MathJax.typesetPromise) {
      await window.MathJax.typesetPromise([element]);
    }
  } catch (error) {
    // 公式排版失敗時仍保留原始文字
    console.error("MathJax 排版失敗：", error);
  }
}


/* ======================================================
   26. 向現有 Cloudflare Worker 傳送 AI 問題
====================================================== */

async function askGameAI() {
  // 讀取輸入框並檢查內容
  const input = document.getElementById("ai-input");
  const sendButton = document.getElementById("send-ai-button");

  const question = input.value.trim();

  if (!question) {
    input.focus();
    return;
  }

  if (question.length > 2000) {
    appendAIMessage("bot", "問題不可超過 2000 字元。");
    return;
  }

  // 顯示使用者問題與載入狀態
  appendAIMessage("user", question);

  input.value = "";
  sendButton.disabled = true;
  sendButton.textContent = "AI 思考中……";

  const loadingMessage = appendAIMessage("bot", "正在思考，請稍候……");

  try {
    // 加入目前題目資訊，讓 AI 能針對實驗提供協助
    const currentQuestion = gameQuestions[currentQuestionIndex];

    const context = currentQuestion
      ? "\n\n目前的實驗題目：" +
        currentQuestion.question +
        "\n選項 A：" + currentQuestion.optionA +
        "\n選項 B：" + currentQuestion.optionB +
        "\n選項 C：" + currentQuestion.optionC +
        "\n選項 D：" + currentQuestion.optionD
      : "";

    // 呼叫已部署的 Cloudflare Worker
    const response = await fetch(AI_WORKER_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        question:
          "你是「物理在家玩」的物理 AI 助教，請用繁體中文解釋，" +
          "必要時使用 LaTeX 數學公式。" +
          context +
          "\n\n學生問題：" + question
      })
    });

    // 解析 Worker 回傳資料
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || "AI 服務暫時無法使用。");
    }

    // 移除載入訊息並顯示正式回答
    loadingMessage.remove();
    appendAIMessage("bot", data.answer || "AI 沒有回傳文字答案。");

  } catch (error) {
    // 發生錯誤時提供清楚提示
    loadingMessage.textContent =
      "AI 連線失敗：" + error.message +
      "。請確認 Worker 網址與服務狀態。";

    console.error("AI 助教錯誤：", error);

  } finally {
    // 恢復傳送按鈕
    sendButton.disabled = false;
    sendButton.textContent = "傳送問題 ↑";
  }
}

/* ======================================================
   27. 學生 AI 提問紀錄功能
   將學生向 AI 提出的問題加入 Google Sheets 學習紀錄
====================================================== */

// 儲存本場遊戲的學生提問
let aiQuestionsForSession = [];

// 保存原本的開始遊戲函式
const originalStartGame = startGame;

// 開始新遊戲時清空上一場的提問
startGame = function () {
  aiQuestionsForSession = [];
  return originalStartGame.apply(this, arguments);
};

// 保存原本的 AI 提問函式
const originalAskGameAI = askGameAI;

// 在原本 AI 提問功能外增加紀錄
askGameAI = async function () {
  const input = document.getElementById("ai-input");
  const question = input ? input.value.trim() : "";

  // 僅記錄有效、且在遊戲進行中的提問
  if (
    question &&
    question.length <= 2000 &&
    gameStarted &&
    !statsSentForSession
  ) {
    aiQuestionsForSession.push(question);
  }

  // 保留原本呼叫 AI 的功能
  return originalAskGameAI.apply(this, arguments);
};

// 重新定義學習紀錄送出功能
sendLearningStats = function (total, correct, accuracy) {
  if (statsSentForSession) return;

  statsSentForSession = true;

  // 原本六個欄位，加上第七個 AI 提問欄位
  const payload = {
    timestamp: new Date().toISOString(),
    playerName: currentPlayerName,
    gameSessionId: gameSessionId,
    totalQuestions: total,
    correctCount: correct,
    accuracy: accuracy,
    aiQuestions: aiQuestionsForSession.join("\n")
  };

  const status = document.getElementById("stats-save-status");

  if (status) {
    status.textContent = "正在送出學習紀錄與 AI 提問……";
  }

  fetch(STATS_WEB_APP_URL, {
    method: "POST",
    mode: "no-cors",
    redirect: "follow",
    headers: {
      "Content-Type": "text/plain;charset=utf-8"
    },
    body: JSON.stringify(payload),
    keepalive: true
  })
    .then(() => {
      if (status) {
        status.textContent =
          "紀錄已送出，請至 Google Sheets 確認寫入結果。";
      }
    })
    .catch(error => {
      console.error("學習紀錄送出失敗：", error);

      if (status) {
        status.textContent =
          "紀錄送出失敗，請檢查網路與 Apps Script。";
      }
    });
};
