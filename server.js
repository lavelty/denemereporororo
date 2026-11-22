const express = require("express");
const http = require("http");
const https = require("https");
const { Server } = require("socket.io");
const mineflayer = require("mineflayer");
const { SocksClient } = require("socks");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

app.use(express.static("public"));
app.use(express.json());

// Global error safety to prevent any crash
process.on("uncaughtException", (err) => {
  console.error("[UncaughtException]", err);
});
process.on("unhandledRejection", (reason) => {
  console.error("[UnhandledRejection]", reason);
});

let isRunning = false;
let queueAbort = false;
let currentConfig = null;
let activeBots = new Map(); // index -> bot
let pendingBots = new Set(); // set of connecting bots
let botTimers = new Map(); // index -> { chatTimer, moveTimer, stopMoveTimeout, reconnectTimeout }

// API to fetch free public SOCKS5 proxies
app.get("/api/fetch-proxies", (req, res) => {
  const url = "https://api.proxyscrape.com/v2/?request=displayproxies&protocol=socks5&timeout=5000&country=all";
  https
    .get(url, (proxyRes) => {
      let data = "";
      proxyRes.on("data", (chunk) => (data += chunk));
      proxyRes.on("end", () => {
        const list = data
          .split(/\r?\n/)
          .map((s) => s.trim())
          .filter((s) => s && s.includes(":") && !s.includes(" ") && !s.startsWith("#"));
        res.json({ success: true, count: list.length, proxies: list.slice(0, 150) });
      });
    })
    .on("error", (err) => {
      res.status(500).json({ success: false, error: err.message });
    });
});

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

  // Abort any bots currently connecting
  for (const bot of pendingBots) {
    try {
      bot.on("error", () => {});
      bot.removeAllListeners();
      bot.quit();
      if (bot._client) {
        bot._client.on("error", () => {});
        bot._client.end();
      }
    } catch (_) {}
  }
  pendingBots.clear();

  // Quit all active in-game bots
  for (const [index, bot] of activeBots) {
    try {
      bot.on("error", () => {});
      bot.removeAllListeners();
      bot.quit();
      if (bot._client) {
        bot._client.on("error", () => {});
        bot._client.end();
      }
    } catch (_) {}
  }
  activeBots.clear();
}

function setupBotActivity(bot, config, index, username) {
  const timers = botTimers.get(index) || {};

  // Chat timer (optional)
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

  // Micro-movement / look to prevent AFK kick
  const enableMove = config.enableMove !== false && config.enableMove !== "false";
  if (enableMove) {
    const moveInterval = Math.max(Number(config.moveIntervalMs) || 2000, 500);
    timers.moveTimer = setInterval(() => {
      if (!isRunning || queueAbort || !bot.entity) return;
      try {
        const yaw = (Math.random() * 360 - 180) * (Math.PI / 180);
        if (typeof bot.look === "function") {
          Promise.resolve(bot.look(yaw, 0, true)).catch(() => {});
        }
        bot.setControlState("forward", true);
        timers.stopMoveTimeout = setTimeout(() => {
          try {
            bot.setControlState("forward", false);
          } catch (_) {}
        }, 250);
      } catch (_) {}
    }, moveInterval);
  }

  botTimers.set(index, timers);
}

function createProxyConnect(proxyStr, targetHost, targetPort) {
  if (!proxyStr || !proxyStr.trim()) return undefined;

  let protocol = "socks5";
  let raw = proxyStr.trim().replace(/\/+$/, "");
  if (raw.includes("://")) {
    const parts = raw.split("://");
    protocol = parts[0].toLowerCase();
    raw = parts[1];
  }

  let auth = null;
  let hostPort = raw;
  if (raw.includes("@")) {
    const authParts = raw.split("@");
    const userPass = authParts[0].split(":");
    auth = { userId: userPass[0], password: userPass[1] || "" };
    hostPort = authParts[1];
  } else {
    // support format ip:port:user:pass
    const colonParts = raw.split(":");
    if (colonParts.length === 4) {
      hostPort = `${colonParts[0]}:${colonParts[1]}`;
      auth = { userId: colonParts[2], password: colonParts[3] };
    }
  }

  const [proxyHost, proxyPortStr] = hostPort.split(":");
  const proxyPort = Number(proxyPortStr) || 1080;

  return function connectViaProxy(client) {
    if (protocol.startsWith("socks")) {
      const socksType = protocol === "socks4" ? 4 : 5;
      const socksOptions = {
        proxy: {
          host: proxyHost,
          port: proxyPort,
          type: socksType,
          userId: auth?.userId,
          password: auth?.password,
        },
        command: "connect",
        destination: {
          host: targetHost,
          port: targetPort,
        },
        timeout: 4500,
      };

      SocksClient.createConnection(socksOptions, (err, info) => {
        if (err) {
          client.emit("error", new Error(`Proxy bağlantı hatası (${proxyHost}:${proxyPort}): ${err.message}`));
          return;
        }
        client.setSocket(info.socket);
      });
    } else {
      // HTTP CONNECT
      const req = http.request({
        host: proxyHost,
        port: proxyPort,
        method: "CONNECT",
        path: `${targetHost}:${targetPort}`,
        headers: auth
          ? {
              "Proxy-Authorization": "Basic " + Buffer.from(`${auth.userId}:${auth.password}`).toString("base64"),
            }
          : {},
        timeout: 4500,
      });

      req.on("connect", (res, socket) => {
        if (res.statusCode === 200) {
          client.setSocket(socket);
        } else {
          client.emit("error", new Error(`HTTP Proxy (${proxyHost}:${proxyPort}) durum kodu: ${res.statusCode}`));
          socket.destroy();
        }
      });

      req.on("error", (err) => {
        client.emit("error", new Error(`HTTP Proxy (${proxyHost}:${proxyPort}) hatası: ${err.message}`));
      });

      req.on("timeout", () => {
        req.destroy(new Error(`HTTP Proxy zaman aşımı (${proxyHost}:${proxyPort})`));
      });

      req.end();
    }
  };
}

function spawnSingleBot(config, index, proxyStr) {
  return new Promise((resolve) => {
    if (!isRunning || queueAbort) return resolve(false);

    clearTimersForIndex(index);

    const existing = activeBots.get(index);
    if (existing) {
      try {
        existing.on("error", () => {});
        existing.removeAllListeners();
        existing.quit();
      } catch (_) {}
      activeBots.delete(index);
    }

    const prefix = (config.prefix || "Bot").trim();
    const username = `${prefix}_${index + 1}`;
    const rawVersion = (config.version || "").trim();
    const versionOption = !rawVersion || rawVersion.toLowerCase() === "auto" ? false : rawVersion;
    const targetHost = config.host.trim();
    const targetPort = Number(config.port) || 25565;

    const connectFn = createProxyConnect(proxyStr, targetHost, targetPort);

    const botOptions = {
      host: targetHost,
      port: targetPort,
      username,
      version: versionOption,
      hideErrors: true,
    };

    if (connectFn) {
      botOptions.connect = connectFn;
    }

    let bot;
    try {
      bot = mineflayer.createBot(botOptions);
      pendingBots.add(bot);
    } catch (err) {
      io.emit("log", `[${username}] Başlatma hatası: ${err.message}`);
      return resolve(false);
    }

    let isSpawned = false;
    let resolved = false;

    function finish(success) {
      if (!resolved) {
        resolved = true;
        pendingBots.delete(bot);
        resolve(success);
      }
    }

    bot.once("login", () => {
      io.emit("log", `[${username}] giriş yaptı, dünya yükleniyor...`);
    });

    bot.once("spawn", () => {
      isSpawned = true;
      pendingBots.delete(bot);
      activeBots.set(index, bot);
      const viaText = proxyStr ? ` (Proxy: ${proxyStr})` : "";
      io.emit("log", `[${username}] sunucuya başarıyla katıldı!${viaText}`);
      io.emit("status", { running: isRunning, activeCount: activeBots.size });

      setupBotActivity(bot, config, index, username);
      finish(true);
    });

    bot.on("kicked", (reason) => {
      let kickMsg = reason;
      try {
        if (typeof reason === "object") kickMsg = JSON.stringify(reason);
      } catch (_) {}
      io.emit("log", `[${username}] sunucudan atıldı: ${kickMsg}`);
    });

    bot.on("error", (err) => {
      io.emit("log", `[${username}] hata: ${err.message}`);
      if (!isSpawned) {
        try {
          bot.on("error", () => {});
          bot.removeAllListeners();
          bot.quit();
        } catch (_) {}
        activeBots.delete(index);
        finish(false);
      }
    });

    bot.on("end", (reason) => {
      activeBots.delete(index);
      pendingBots.delete(bot);
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

    // Safety timeout (9 seconds)
    setTimeout(() => {
      if (!isSpawned && !resolved) {
        try {
          bot.on("error", () => {});
          bot.removeAllListeners();
          bot.quit();
        } catch (_) {}
        activeBots.delete(index);
        finish(false);
      }
    }, 9000);
  });
}

function scheduleSingleReconnect(config, index) {
  if (!isRunning || queueAbort) return;
  const timers = botTimers.get(index) || {};
  if (timers.reconnectTimeout) clearTimeout(timers.reconnectTimeout);

  let proxies = [];
  if (config.proxies && typeof config.proxies === "string") {
    proxies = config.proxies
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0 && !s.startsWith("#"));
  }
  const hasProxies = proxies.length > 0;
  const delay = hasProxies ? 1500 : 4200;

  timers.reconnectTimeout = setTimeout(async () => {
    if (isRunning && !queueAbort && currentConfig) {
      const nextProxy = hasProxies ? proxies[Math.floor(Math.random() * proxies.length)] : null;
      const ok = await spawnSingleBot(currentConfig, index, nextProxy);
      if (!ok && isRunning && !queueAbort) {
        scheduleSingleReconnect(currentConfig, index);
      }
    }
  }, delay);

  botTimers.set(index, timers);
}

async function startBotQueue(config) {
  queueAbort = false;
  const count = Math.min(Math.max(Number(config.count) || 1, 1), 50);

  // Parse proxies
  let proxies = [];
  if (config.proxies && typeof config.proxies === "string") {
    proxies = config.proxies
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0 && !s.startsWith("#"));
  }

  const hasProxies = proxies.length > 0;
  const defaultInterval = hasProxies ? 250 : 500;
  const baseInterval = Math.max(Number(config.spawnIntervalMs) || defaultInterval, 50);

  io.emit("status", { running: true, activeCount: 0 });
  const proxyNotice = hasProxies ? ` (${proxies.length} proxy aktif - Tık Tık Hızlı Giriş ⚡)` : " (Doğrudan bağlantı)";
  io.emit("log", `${count} bot ${baseInterval}ms aralıklarla başlatılıyor${proxyNotice} -> ${config.host.trim()}:${Number(config.port) || 25565}`);

  let proxyIndex = 0;

  for (let i = 0; i < count; i++) {
    if (!isRunning || queueAbort) break;

    const prefix = (config.prefix || "Bot").trim();
    const username = `${prefix}_${i + 1}`;
    let joined = false;
    let attempts = 0;
    const maxAttempts = hasProxies ? 12 : 5;

    while (!joined && isRunning && !queueAbort && attempts < maxAttempts) {
      attempts++;
      const currentProxy = hasProxies ? proxies[proxyIndex % proxies.length] : null;
      if (hasProxies) proxyIndex++;

      const attemptInfo = attempts > 1 ? ` (Deneme ${attempts})` : "";
      const proxyLabel = currentProxy ? ` (Proxy: ${currentProxy})` : "";
      io.emit("log", `[${username}] bağlanıyor...${attemptInfo}${proxyLabel}`);

      joined = await spawnSingleBot(config, i, currentProxy);

      if (!joined && isRunning && !queueAbort) {
        if (hasProxies) {
          io.emit("log", `[${username}] Proxy yanıt vermedi, sonraki proxy deneniyor...`);
          await new Promise((r) => setTimeout(r, 200));
        } else {
          io.emit("log", `[${username}] IP giriş sınırı algılandı, 4.2 sn beklenip tekrar deneniyor...`);
          await new Promise((r) => setTimeout(r, 4200));
        }
      }
    }

    if (joined && isRunning && !queueAbort && i < count - 1) {
      await new Promise((r) => setTimeout(r, baseInterval));
    }
  }

  if (isRunning && !queueAbort) {
    io.emit("log", `Tüm botların bağlantı süreci tamamlandı! Oyundaki aktif bot: ${activeBots.size}/${count}`);
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
    io.emit("log", "Tüm botlar durduruldu ve zamanlayıcılar temizlendi.");
  });
});

server.listen(PORT, () => {
  console.log(`Sunucu ${PORT} portunda çalışıyor.`);
});
