const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const mineflayer = require("mineflayer");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

app.use(express.static("public"));

let isRunning = false;
let queueAbort = false;
let currentConfig = null;
let activeBots = new Map(); // index -> bot
let botTimers = new Map(); // index -> { chatTimer, moveTimer, stopMoveTimeout, reconnectTimeout }

function clearTimersForIndex(index) {
  const timers = botTimers.get(index);
  if (!timers) return;
  if (timers.chatTimer) clearInterval(timers.chatTimer);
  if (timers.moveTimer) clearInterval(timers.moveTimer);
  if (timers.stopMoveTimeout) clearTimeout(timers.stopMoveTimeout);
  if (timers.reconnectTimeout) clearTimeout(timers.reconnectTimeout);
  botTimers.delete(index);
}

function stopAllBots() {
  isRunning = false;
  queueAbort = true;
  currentConfig = null;

  for (const [index] of botTimers) {
    clearTimersForIndex(index);
  }

  for (const [index, bot] of activeBots) {
    try {
      bot.removeAllListeners();
      bot.quit();
    } catch (_) {}
  }
  activeBots.clear();
}

function setupBotActivity(bot, config, index, username) {
  const timers = botTimers.get(index) || {};

  // Chat timer (optional & controlled)
  const enableChat = config.enableChat === true || config.enableChat === "true";
  if (enableChat && config.message && config.message.trim()) {
    const chatInterval = Math.max(Number(config.chatIntervalMs) || 5000, 1000);
    timers.chatTimer = setInterval(() => {
      if (!isRunning || queueAbort || !bot.player) return;
      try {
        bot.chat(config.message.trim());
        io.emit("log", `[${username}] mesaj gönderdi.`);
      } catch (err) {
        io.emit("log", `[${username}] mesaj hatası: ${err.message}`);
      }
    }, chatInterval);
  }

  // Move timer
  const moveInterval = Math.max(Number(config.moveIntervalMs) || 1500, 400);
  timers.moveTimer = setInterval(() => {
    if (!isRunning || queueAbort || !bot.entity) return;
    try {
      const yaw = Math.random() * Math.PI * 2;
      bot.look(yaw, 0, false);
      bot.setControlState("forward", true);
      timers.stopMoveTimeout = setTimeout(() => {
        try {
          bot.setControlState("forward", false);
        } catch (_) {}
      }, 350);
    } catch (_) {}
  }, moveInterval);

  botTimers.set(index, timers);
}

function spawnSingleBot(config, index) {
  return new Promise((resolve) => {
    if (!isRunning || queueAbort) return resolve(false);

    clearTimersForIndex(index);

    const existing = activeBots.get(index);
    if (existing) {
      try {
        existing.removeAllListeners();
        existing.quit();
      } catch (_) {}
      activeBots.delete(index);
    }

    const prefix = (config.prefix || "Bot").trim();
    const username = `${prefix}_${index + 1}`;
    const rawVersion = (config.version || "").trim();
    const versionOption = !rawVersion || rawVersion.toLowerCase() === "auto" ? false : rawVersion;

    let bot;
    try {
      bot = mineflayer.createBot({
        host: config.host.trim(),
        port: Number(config.port) || 25565,
        username,
        version: versionOption,
        hideErrors: true
      });
    } catch (err) {
      io.emit("log", `[${username}] Başlatma hatası: ${err.message}`);
      return resolve(false);
    }

    let isSpawned = false;
    let resolved = false;

    function finish(success) {
      if (!resolved) {
        resolved = true;
        resolve(success);
      }
    }

    bot.once("spawn", () => {
      isSpawned = true;
      activeBots.set(index, bot);
      io.emit("log", `[${username}] sunucuya başarıyla katıldı.`);
      io.emit("status", { running: isRunning, activeCount: activeBots.size });

      setupBotActivity(bot, config, index, username);
      finish(true);
    });

    bot.on("error", (err) => {
      if (!isSpawned) {
        try {
          bot.removeAllListeners();
          bot.quit();
        } catch (_) {}
        activeBots.delete(index);
        finish(false);
      } else {
        io.emit("log", `[${username}] hata: ${err.message}`);
      }
    });

    bot.on("end", (reason) => {
      activeBots.delete(index);
      io.emit("status", { running: isRunning, activeCount: activeBots.size });
      clearTimersForIndex(index);

      if (!isSpawned) {
        finish(false);
      } else {
        if (isRunning && !queueAbort) {
          io.emit("log", `[${username}] oyundan ayrıldı (${reason || "bağlantı kapandı"}). Yeniden bağlanıyor...`);
          scheduleSingleReconnect(config, index);
        }
      }
    });

    // 15 second safety timeout for handshake
    setTimeout(() => {
      if (!isSpawned && !resolved) {
        try {
          bot.removeAllListeners();
          bot.quit();
        } catch (_) {}
        activeBots.delete(index);
        finish(false);
      }
    }, 15000);
  });
}

function scheduleSingleReconnect(config, index) {
  if (!isRunning || queueAbort) return;
  const timers = botTimers.get(index) || {};
  if (timers.reconnectTimeout) clearTimeout(timers.reconnectTimeout);

  timers.reconnectTimeout = setTimeout(async () => {
    if (isRunning && !queueAbort && currentConfig) {
      const ok = await spawnSingleBot(currentConfig, index);
      if (!ok && isRunning && !queueAbort) {
        scheduleSingleReconnect(currentConfig, index);
      }
    }
  }, 4200);

  botTimers.set(index, timers);
}

async function startBotQueue(config) {
  queueAbort = false;
  const count = Math.min(Math.max(Number(config.count) || 1, 1), 50);
  const baseInterval = Math.max(Number(config.spawnIntervalMs) || 1000, 200);

  io.emit("status", { running: true, activeCount: 0 });
  io.emit("log", `${count} bot sırayla bağlanmaya başlıyor -> ${config.host.trim()}:${Number(config.port) || 25565}`);

  for (let i = 0; i < count; i++) {
    if (!isRunning || queueAbort) break;

    const prefix = (config.prefix || "Bot").trim();
    const username = `${prefix}_${i + 1}`;
    let joined = false;
    let attempts = 0;

    while (!joined && isRunning && !queueAbort && attempts < 8) {
      attempts++;
      io.emit("log", `[${username}] bağlanıyor... (Deneme: ${attempts})`);
      joined = await spawnSingleBot(config, i);
      if (!joined && isRunning && !queueAbort) {
        io.emit("log", `[${username}] Sunucu giriş koruması (throttle) algılandı, 4.2 sn beklenip tekrar deneniyor...`);
        await new Promise((r) => setTimeout(r, 4200));
      }
    }

    if (isRunning && !queueAbort && i < count - 1) {
      await new Promise((r) => setTimeout(r, baseInterval));
    }
  }

  if (isRunning && !queueAbort) {
    io.emit("log", `Tüm botların bağlantı süreci tamamlandı! Oyundaki toplam bot: ${activeBots.size}/${count}`);
  }
}

io.on("connection", (socket) => {
  socket.emit("log", "Kontrol paneline bağlanıldı.");
  socket.emit("status", { running: isRunning, activeCount: activeBots.size });

  socket.on("start_bots", (config) => {
    stopAllBots();

    if (!config || !config.host || !config.host.trim()) {
      socket.emit("log", "Hata: Geçerli bir sunucu IP/adresi girilmelidir.");
      return;
    }

    isRunning = true;
    queueAbort = false;
    currentConfig = { ...config };

    startBotQueue(currentConfig);
  });

  socket.on("stop_bots", () => {
    stopAllBots();
    io.emit("status", { running: false, activeCount: 0 });
    io.emit("log", "Tüm botlar durduruldu ve sunucudan çıkarıldı.");
  });
});

server.listen(PORT, () => {
  console.log(`Sunucu ${PORT} portunda çalışıyor.`);
});
