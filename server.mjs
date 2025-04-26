// server.js
import express from "express";
import dotenv from "dotenv";
import cors from "cors";
import { v4 as uuidv4 } from "uuid";
import mysql from "mysql2";
import axios from "axios";
import { Server } from "socket.io";

import AuthRoutes from "./AuthRoutes.js";
import MessageRoutes from "./MessageRoutes.js";

dotenv.config();
const app = express();

// ───── Middleware ─────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());

// serve uploaded recordings and images
app.use("/uploads/recordings", express.static("uploads/recordings"));
app.use("/uploads/images",    express.static("uploads/images"));

// ───── API Routes ─────────────────────────────────────────────────────────────
app.use("/api/auth",     AuthRoutes);
app.use("/api/messages", MessageRoutes);

// example utility endpoint: generate a UUID
app.get("/api/uuid", (req, res) => {
  res.json({ id: uuidv4() });
});

// example utility endpoint: ping an external service
app.get("/api/ping-external", async (req, res) => {
  try {
    const { data } = await axios.get("https://api.ipify.org?format=json");
    res.json({ yourIp: data.ip });
  } catch (err) {
    console.error("Axios error:", err);
    res.status(502).send("Bad Gateway");
  }
});

// ───── MySQL Connection ───────────────────────────────────────────────────────
const db = mysql.createConnection({
  host:     process.env.DB_HOST,
  port:     process.env.DB_PORT,
  user:     process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  ssl: {
    ca: `-----BEGIN CERTIFICATE-----
MIIEQTCCAqmgAwIBAgIUERt7YR9jM6EfYwhtPB9fQ8HjkwwwDQYJKoZIhvcNAQEM
... (your cert here) ...
9d6taC69BBedXIF3hRjOqXKbzclLMkltProMfWgJhJUK5/bY2JekqCbF0RFrSNX1
ARqiTWIvp4eyPjvxfMmmRnjB5z1quioeDlS8S/QYg1kdZvu4QGTJt0HTHLjEwAxMz
cNJBgXS9wrHbstOMlGQiXKC8pX29kOfpskNtNg56huPDf0VQ==
-----END CERTIFICATE-----`,
    rejectUnauthorized: true
  }
});

db.connect(err => {
  if (err) {
    console.error("Error connecting to MySQL:", err);
    process.exit(1);
  }
  console.log("✅ Connected to MySQL");
});

// make `db` available in your routes via req.app.locals
app.locals.db = db;

// ───── 404 handler ────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).send("404 Not Found");
});

// ───── Start HTTP & Socket.IO Servers ────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const httpServer = app.listen(PORT, () => {
  console.log(`🚀 Server listening on port ${PORT}`);
});

const io = new Server(httpServer, {
  cors: {
    origin: process.env.FRONTEND_ORIGIN || "http://localhost:3000",
    credentials: true,
  },
});

// track online users
global.onlineUsers = new Map();

io.on("connection", socket => {
  console.log("🔌 socket connected:", socket.id);
  global.chatSocket = socket;

  socket.on("add-user", userId => {
    onlineUsers.set(userId, socket.id);
    socket.broadcast.emit("online-users", {
      onlineUsers: Array.from(onlineUsers.keys())
    });
  });

  socket.on("signout", id => {
    onlineUsers.delete(id);
    socket.broadcast.emit("online-users", {
      onlineUsers: Array.from(onlineUsers.keys())
    });
  });

  const forwardOrOffline = (eventIn, eventOut) => data => {
    const targetSocket = onlineUsers.get(data.to ?? data.from);
    if (targetSocket) {
      socket.to(targetSocket).emit(eventIn, data);
    } else {
      const senderSocket = onlineUsers.get(data.from);
      socket.to(senderSocket).emit(eventOut);
    }
  };

  socket.on("outgoing-voice-call", forwardOrOffline("incoming-voice-call", "voice-call-offline"));
  socket.on("outgoing-video-call", forwardOrOffline("incoming-video-call", "video-call-offline"));

  socket.on("reject-voice-call", data => {
    const s = onlineUsers.get(data.from);
    if (s) socket.to(s).emit("voice-call-rejected");
  });

  socket.on("reject-video-call", data => {
    const s = onlineUsers.get(data.from);
    if (s) socket.to(s).emit("video-call-rejected");
  });

  socket.on("accept-incoming-call", ({ id }) => {
    const s = onlineUsers.get(id);
    if (s) socket.to(s).emit("accept-call");
  });

  socket.on("send-msg", data => {
    const s = onlineUsers.get(data.to);
    if (s) socket.to(s).emit("msg-recieve", { from: data.from, message: data.message });
  });

  socket.on("mark-read", ({ id, recieverId }) => {
    const s = onlineUsers.get(id);
    if (s) socket.to(s).emit("mark-read-recieve", { id, recieverId });
  });
});
