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
  currentConfig = null;

  for (const [index] of botTimers) {
    clearTimersForIndex(index);
  }

  for (const [index, bot] of activeBots) {
    try {
      bot.removeAllListeners("end");
      bot.removeAllListeners("error");
      bot.quit();
    } catch (_) {}
    activeBots.delete(index);
  }
}

function spawnBot(config, index) {
  if (!isRunning) return;

  clearTimersForIndex(index);

  const existing = activeBots.get(index);
  if (existing) {
    try {
      existing.removeAllListeners("end");
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
    });
  } catch (err) {
    io.emit("log", `[${username}] oluşturma hatası: ${err.message}`);
    scheduleReconnect(config, index);
    return;
  }

  activeBots.set(index, bot);

  bot.once("spawn", () => {
    if (!isRunning) return;
    io.emit("log", `[${username}] sunucuya bağlandı.`);
    io.emit("status", { running: isRunning, activeCount: activeBots.size });

    const timers = botTimers.get(index) || {};

    // Chat timer - only if explicitly enabled and message is provided
    const enableChat = config.enableChat === true || config.enableChat === "true";
    if (enableChat && config.message && config.message.trim()) {
      const chatInterval = Math.max(Number(config.chatIntervalMs) || 5000, 1000);
      timers.chatTimer = setInterval(() => {
        if (!isRunning || !bot.player) return;
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
      if (!isRunning || !bot.entity) return;
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
  });

  bot.on("end", (reason) => {
    activeBots.delete(index);
    io.emit("status", { running: isRunning, activeCount: activeBots.size });

    const timers = botTimers.get(index);
    if (timers) {
      if (timers.chatTimer) clearInterval(timers.chatTimer);
      if (timers.moveTimer) clearInterval(timers.moveTimer);
      if (timers.stopMoveTimeout) clearTimeout(timers.stopMoveTimeout);
    }

    if (!isRunning) return;
    io.emit("log", `[${username}] bağlantısı koptu (${reason || "disconnected"}). Yeniden bağlanılıyor...`);
    scheduleReconnect(config, index);
  });

  bot.on("error", (err) => {
    if (!isRunning) return;
    io.emit("log", `[${username}] hata: ${err.message}`);
  });
}

function scheduleReconnect(config, index) {
  if (!isRunning) return;
  const timers = botTimers.get(index) || {};
  if (timers.reconnectTimeout) clearTimeout(timers.reconnectTimeout);

  // Stagger reconnects so all bots do not hit the server at the exact same millisecond (avoids ECONNRESET)
  const baseInterval = Math.max(Number(config.spawnIntervalMs) || 2000, 1000);
  const reconnectDelay = 3000 + (index * baseInterval) + Math.floor(Math.random() * 1000);

  timers.reconnectTimeout = setTimeout(() => {
    if (isRunning && currentConfig) {
      spawnBot(currentConfig, index);
    }
  }, reconnectDelay);

  botTimers.set(index, timers);
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
    currentConfig = { ...config };

    const count = Math.min(Math.max(Number(config.count) || 1, 1), 50);
    const spawnInterval = Math.max(Number(config.spawnIntervalMs) || 2000, 500);

    io.emit("status", { running: true, activeCount: 0 });
    io.emit("log", `${count} bot ${spawnInterval}ms aralıklarla başlatılıyor -> ${config.host.trim()}:${Number(config.port) || 25565}`);

    for (let i = 0; i < count; i++) {
      setTimeout(() => {
        if (isRunning) spawnBot(currentConfig, i);
      }, i * spawnInterval);
    }
  });

  socket.on("stop_bots", () => {
    stopAllBots();
    io.emit("status", { running: false, activeCount: 0 });
    io.emit("log", "Tüm botlar durduruldu ve zamanlayıcılar temizlendi.");
  });
});

server.listen(PORT, () => {
  console.log(`Sunucu ${PORT} portunda çalışıyor.`);
});
