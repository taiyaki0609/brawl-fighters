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
    const room = { players: [opponentId, socket.id], mode: "matchmaking" };
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
    rooms.set(code, { players: [socket.id], mode: "private" });
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

  socket.on("room:leave", () => leaveRoom(socket));
  socket.on("disconnect", () => {
    removeFromQueue(socket.id);
    leaveRoom(socket);
  });
});

server.listen(PORT, () => {
  console.log(`BRAWL FIGHTERS server listening on port ${PORT}`);
});
