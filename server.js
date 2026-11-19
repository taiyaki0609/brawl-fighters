const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const rooms = new Map();
const waitingPlayers = [];

app.use(express.static("public"));

app.get("/health", (_req, res) => {
  res.json({ ok: true, game: "BRAWL FIGHTERS" });
});

function makeRoomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code;
  do {
    code = Array.from({ length: 5 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
  } while (rooms.has(code));
  return code;
}

function removeFromQueue(socketId) {
  const index = waitingPlayers.indexOf(socketId);
  if (index !== -1) waitingPlayers.splice(index, 1);
}

function leaveRoom(socket, notify = true) {
  const code = socket.data.roomCode;
  if (!code) return;

  const room = rooms.get(code);
  socket.data.roomCode = null;
  socket.leave(code);

  if (!room) return;
  room.players = room.players.filter((id) => id !== socket.id);
  room.states.delete(socket.id);
  room.lastAttacks.delete(socket.id);
  room.lastAttackSeq.delete(socket.id);
  if (room.selections) room.selections.delete(socket.id);

  if (notify) {
    socket.to(code).emit("room:opponent-left");
  }

  if (room.players.length === 0) {
    rooms.delete(code);
  } else {
    io.to(code).emit("room:waiting", { roomCode: code });
  }
}

function attachPlayerToRoom(socket, code, playerNumber) {
  socket.data.roomCode = code;
  socket.data.playerNumber = playerNumber;
  socket.join(code);
  socket.emit("room:joined", { roomCode: code, playerNumber });
}

io.on("connection", (socket) => {
  socket.emit("server:ready", { message: "Connected to BRAWL FIGHTERS server" });

  socket.on("matchmaking:join", () => {
    if (socket.data.roomCode) leaveRoom(socket);
    removeFromQueue(socket.id);

    let opponentId;
    while (waitingPlayers.length && !opponentId) {
      const candidate = waitingPlayers.shift();
      if (candidate !== socket.id && io.sockets.sockets.has(candidate)) {
        opponentId = candidate;
      }
    }

    if (!opponentId) {
      waitingPlayers.push(socket.id);
      socket.emit("matchmaking:searching");
      return;
    }

    const code = makeRoomCode();
    const room = { players: [opponentId, socket.id], mode: "matchmaking", states: new Map(), lastAttacks: new Map(), lastAttackSeq: new Map(), selections: new Map(), health: new Map([[opponentId,100],[socket.id,100]]), finished: false };
    rooms.set(code, room);

    const first = io.sockets.sockets.get(opponentId);
    const second = socket;
    attachPlayerToRoom(first, code, 1);
    attachPlayerToRoom(second, code, 2);
    io.to(code).emit("matchmaking:found", { roomCode: code });
    io.to(code).emit("game:ready", { roomCode: code, players: 2 });
  });

  socket.on("matchmaking:cancel", () => {
    removeFromQueue(socket.id);
    socket.emit("matchmaking:cancelled");
  });

  socket.on("room:create", () => {
    if (socket.data.roomCode) leaveRoom(socket);
    removeFromQueue(socket.id);

    const code = makeRoomCode();
    rooms.set(code, { players: [socket.id], mode: "private", states: new Map(), lastAttacks: new Map(), lastAttackSeq: new Map(), selections: new Map(), health: new Map([[socket.id,100]]), finished: false });
    attachPlayerToRoom(socket, code, 1);
    socket.emit("room:created", { roomCode: code });
  });

  socket.on("room:join", (rawCode) => {
    const code = String(rawCode || "").trim().toUpperCase();
    const room = rooms.get(code);

    if (!/^[A-Z2-9]{5}$/.test(code) || !room) {
      socket.emit("room:error", { message: "そのルームは見つかりません。" });
      return;
    }
    if (room.players.length >= 2) {
      socket.emit("room:error", { message: "このルームは満員です。" });
      return;
    }
    if (socket.data.roomCode) leaveRoom(socket);
    removeFromQueue(socket.id);

    room.players.push(socket.id);
    attachPlayerToRoom(socket, code, 2);
    io.to(code).emit("game:ready", { roomCode: code, players: 2 });
  });

  socket.on("game:select-character", (data) => {
    const code = socket.data.roomCode;
    const room = code && rooms.get(code);
    if (!room || room.players.length !== 2 || room.finished) return;
    const character = data && ["SURGE", "SHELLY", "SPIKE", "CROW"].includes(data.character) ? data.character : null;
    if (!character) return;
    if (!room.selections) room.selections = new Map();
    if (!room.health) room.health = new Map(room.players.map(id => [id,100]));
    if (room.selections.has(socket.id)) return;
    room.selections.set(socket.id, character);
    const opponentId = room.players.find((id) => id !== socket.id);
    const opponentCharacter = room.selections.get(opponentId) || null;
    socket.emit("game:selection-status", { youReady: true, opponentReady: Boolean(opponentCharacter), opponentCharacter });
    if (opponentCharacter) {
      io.to(code).emit("game:selection-status", { youReady: true, opponentReady: true, bothReady: true });
      io.to(code).emit("game:start-countdown");
    } else {
      io.to(opponentId).emit("game:selection-status", { youReady: false, opponentReady: true, opponentCharacter: character });
    }
  });

  socket.on("game:state", (state) => {
    const code = socket.data.roomCode;
    if (!code || !rooms.has(code) || !state || typeof state !== "object") return;
    const safeState = {
      x: Math.max(0, Math.min(1, Number(state.x) || 0)),
      y: Math.max(0, Math.min(1, Number(state.y) || 0)),
      facing: state.facing === -1 ? -1 : 1,
      action: ["idle", "walk", "jump", "attack"].includes(state.action) ? state.action : "idle",
      character: ["SURGE", "SHELLY", "SPIKE", "CROW"].includes(state.character) ? state.character : "SURGE",
      attackType: ["quick", "strong", "special"].includes(state.attackType) ? state.attackType : "quick",
      attackSeq: Math.max(0, Math.floor(Number(state.attackSeq) || 0))
    };
    const room = rooms.get(code);
    const playerNumber = room.players.indexOf(socket.id) + 1;
    safeState.globalX = playerNumber === 2 ? 1 - safeState.x : safeState.x;
    safeState.globalFacing = playerNumber === 2 ? -safeState.facing : safeState.facing;
    room.states.set(socket.id, safeState);
    socket.to(code).emit("game:opponent-state", safeState);
  });

  socket.on("game:attack", (attack) => {
    const code = socket.data.roomCode;
    const room = code && rooms.get(code);
    if (!room || room.players.length !== 2 || room.finished || !attack || typeof attack !== "object") return;
    const victimId = room.players.find((id) => id !== socket.id);
    const victimState = room.states.get(victimId);
    const attackerState = room.states.get(socket.id);
    if (!victimState || !attackerState) {
      socket.emit("game:attack-miss", { message: "相手の位置を確認中… 少し待ってから攻撃してね。" });
      return;
    }

    const allowedCharacters = ["SURGE", "SHELLY", "SPIKE", "CROW"];
    const character = allowedCharacters.includes(attack.character) ? attack.character : "SURGE";
    const type = ["quick", "strong", "special"].includes(attack.type) ? attack.type : "quick";
    const seq = Math.max(0, Math.floor(Number(attack.seq) || 0));
    if (room.lastAttackSeq.get(socket.id) === seq) return;
    const now = Date.now();
    const cooldown = type === "quick" ? 130 : type === "strong" ? 420 : 700;
    if (now - (room.lastAttacks.get(socket.id) || 0) < cooldown) return;
    room.lastAttacks.set(socket.id, now);
    room.lastAttackSeq.set(socket.id, seq);

    const attackerNumber = room.players.indexOf(socket.id) + 1;
    const ax = attackerState.x;
    const ay = attackerState.y;
    const facing = attackerState.facing;
    const attackerX = attackerNumber === 2 ? 1 - ax : ax;
    const attackerFacing = attackerNumber === 2 ? -facing : facing;
    const victimX = victimState.globalX;
    const victimY = victimState.y;
    const dx = (victimX - attackerX) * 960;
    const dy = Math.abs(victimY - ay) * 360;
    const distance = Math.abs(dx);
    const radial = type === "special" && ["SURGE", "SPIKE", "CROW"].includes(character);
    const ranges = {
      SURGE: { quick: 285, strong: 355, special: 205 },
      SHELLY: { quick: 205, strong: 245, special: 285 },
      SPIKE: { quick: 265, strong: 290, special: 190 },
      CROW: { quick: 255, strong: 305, special: 215 }
    };
    const range = ranges[character][type];
    const inDirection = radial || Math.sign(dx) === attackerFacing;
    if (!inDirection || distance > range + 55 || dy > 190) {
      socket.emit("game:attack-miss", { message: "攻撃が届かなかった！ 相手に近づいてみよう。" });
      return;
    }

    let damage = ({ SURGE: { quick: 13, strong: 24, special: 30 },
      SHELLY: { quick: 21, strong: 30, special: 38 },
      SPIKE: { quick: 14, strong: 22, special: 28 },
      CROW: { quick: 10, strong: 14, special: 18 } })[character][type];
    if (character === "SHELLY") {
      const closeBonus = Math.max(0, 1 - distance / range);
      damage = Math.round(damage * (0.42 + closeBonus * 0.95));
    }
    if (character === "SPIKE" && type === "quick" && distance > 180) damage += 3;
    const knockback = ({ SURGE: { quick: .018, strong: .045, special: .055 },
      SHELLY: { quick: .022, strong: .052, special: .065 },
      SPIKE: { quick: .024, strong: .04, special: .05 },
      CROW: { quick: .014, strong: .03, special: .042 } })[character][type];
    const poison = character === "CROW" ? { duration: type === "special" ? 3600 : 3000, interval: 850 } : null;
    io.to(victimId).emit("game:hit", {
      damage, knockbackDir: dx >= 0 ? 1 : -1, knockback,
      lift: type === "strong" || type === "special" ? .22 : .13,
      poison
    });
    if (!room.health) room.health = new Map(room.players.map(id => [id,100]));
    const victimHealth = Math.max(0, (room.health.get(victimId) ?? 100) - damage);
    room.health.set(victimId, victimHealth);
    io.to(code).emit("game:health", { playerId: victimId, health: victimHealth, message: "攻撃命中！ -" + damage + " HP" });
    if (victimHealth <= 0 && !room.finished) {
      room.finished = true;
      io.to(socket.id).emit("game:result", { won: true });
      io.to(victimId).emit("game:result", { won: false });
    }
    socket.emit("game:hit-confirm", {
      message: character === "CROW" ? "命中！毒を付与！" :
        character === "SHELLY" ? "命中！近距離ほど大ダメージ！" : "命中！ ダメージ " + damage
    });
  });

  socket.on("game:health", (data) => {
    const code = socket.data.roomCode;
    const room = code && rooms.get(code);
    if (!room || !data || room.finished) return;
    if (!room.health) room.health = new Map(room.players.map(id => [id,100]));
    const health = Math.max(0, Math.min(100, Number(data.health) || 0));
    room.health.set(socket.id, Math.min(room.health.get(socket.id) ?? 100, health));
    const currentHealth = room.health.get(socket.id);
    io.to(code).emit("game:health", {
      playerId: socket.id,
      health: currentHealth,
      message: String(data.message || "追加ダメージ！").slice(0, 80)
    });
    if (currentHealth <= 0) {
      room.finished = true;
      const winnerId = room.players.find(id => id !== socket.id);
      if (winnerId) io.to(winnerId).emit("game:result", { won: true });
      io.to(socket.id).emit("game:result", { won: false });
    }
  });

  socket.on("room:leave", () => leaveRoom(socket));
  socket.on("disconnect", () => {
    removeFromQueue(socket.id);
    leaveRoom(socket);
  });
});

server.listen(PORT, () => {
  console.log(`BRAWL FIGHTERS server listening on port ${PORT}`);
});
