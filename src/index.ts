import express from "express";
import http from "http";
import { Server } from "socket.io";
import cors from "cors";
import path from "path";
import fs from "fs/promises";

type Message = {
  id: string;
  username: string;
  text: string;
  ts: number;
};

const app = express();
app.use(cors());
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*"
  }
});

// in-memory runtime structures
const users = new Map<string, string>(); // socketId -> username
let messages: Message[] = [];
const knownUsers = new Set<string>();

// data directory (when you run server from server/ this will be server/data)
const DATA_DIR = path.resolve(process.cwd(), "data");
const MESSAGES_FILE = path.join(DATA_DIR, "messages.json");
const USERS_FILE = path.join(DATA_DIR, "knownUsers.json");

async function ensureDataDir() {
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
  } catch (err) {
    console.error("Could not create data dir", err);
  }
}

async function loadPersisted() {
  try {
    const [mBuf, uBuf] = await Promise.all([
      fs.readFile(MESSAGES_FILE, "utf8").catch(() => "[]"),
      fs.readFile(USERS_FILE, "utf8").catch(() => "[]")
    ]);
    messages = JSON.parse(mBuf) as Message[];
    const usersArr = JSON.parse(uBuf) as string[];
    usersArr.forEach((u) => knownUsers.add(u));
    console.log("Loaded persisted data:", messages.length, "messages,", knownUsers.size, "known users");
  } catch (err) {
    console.error("Error loading persisted data:", err);
  }
}

async function persistMessages() {
  try {
    await ensureDataDir();
    await fs.writeFile(MESSAGES_FILE, JSON.stringify(messages, null, 2), "utf8");
  } catch (err) {
    console.error("Failed to persist messages:", err);
  }
}

async function persistKnownUsers() {
  try {
    await ensureDataDir();
    await fs.writeFile(USERS_FILE, JSON.stringify(Array.from(knownUsers), null, 2), "utf8");
  } catch (err) {
    console.error("Failed to persist known users:", err);
  }
}

function broadcastOnline() {
  const online = Array.from(users.values());
  io.emit("online", online);
}

io.on("connection", (socket) => {
  console.log("socket connected:", socket.id);

  // When a client joins we expect the username string
  socket.on("join", (username: string) => {
    users.set(socket.id, username);
    console.log(`${username} joined (${socket.id})`);
    // add to known users and persist once
    if (!knownUsers.has(username)) {
      knownUsers.add(username);
      persistKnownUsers().catch(() => { });
    }

    // Send the current persisted messages and online list to this socket only
    socket.emit("init", {
      messages,
      online: Array.from(users.values()),
      knownUsers: Array.from(knownUsers)
    });

    // broadcast online and a system message
    broadcastOnline();

    const joinMsg: Message = {
      id: `msg-${Date.now()}-${Math.random()}`,
      username: "System",
      text: `${username} joined the chat`,
      ts: Date.now()
    };
    messages.push(joinMsg);
    persistMessages().catch(() => { });
    io.emit("message", joinMsg);
  });

  // Receive a chat message from a client
  socket.on("message", (msg: { username: string; text: string }) => {
    const message: Message = {
      id: `msg-${Date.now()}-${Math.random()}`,
      username: msg.username,
      text: msg.text,
      ts: Date.now()
    };
    messages.push(message);
    // persist immediately (fine for small apps)
    persistMessages().catch(() => { });
    io.emit("message", message);
  });

  // New: handle only leaving (do not delete messages)
  socket.on("leave", async (username: string, ack?: (res: { ok: boolean; err?: string }) => void) => {
    try {
      console.log(`Received leave from ${username} (${socket.id})`);
      // Remove only this socket from the users map
      users.delete(socket.id);

      // Broadcast updated online list
      broadcastOnline();

      // Add a system message that this socket user left (optional)
      const leaveMsg: Message = {
        id: `msg-${Date.now()}-${Math.random()}`,
        username: "System",
        text: `${username} left the chat`,
        ts: Date.now()
      };
      messages.push(leaveMsg);
      await persistMessages();
      io.emit("message", leaveMsg);

      // Acknowledge to client
      if (ack) ack({ ok: true });
    } catch (err: any) {
      console.error("Error in leave:", err);
      if (ack) ack({ ok: false, err: String(err) });
    }
  });

  // New: handle deletion of all messages authored by username (without leaving)
  socket.on("delete_user_messages", async (username: string, ack?: (res: { ok: boolean; removedCount?: number; err?: string }) => void) => {
    try {
      console.log(`Received delete_user_messages from ${username} (${socket.id})`);

      const before = messages.length;
      messages = messages.filter((m) => m.username !== username);
      const removed = before - messages.length;

      users.delete(socket.id);
      broadcastOnline();

      // persist new messages list
      await persistMessages();

      // Notify all clients with the updated messages array
      io.emit("messages", messages);

      // Optionally create a system message indicating messages removed
      const sysMsg: Message = {
        id: `msg-${Date.now()}-${Math.random()}`,
        username: "System",
        text: `${username} deleted their messages (${removed} removed)`,
        ts: Date.now()
      };
      messages.push(sysMsg);
      await persistMessages();
      io.emit("message", sysMsg);

      if (ack) ack({ ok: true, removedCount: removed });
    } catch (err: any) {
      console.error("Error in delete_user_messages:", err);
      if (ack) ack({ ok: false, err: String(err) });
    }
  });

  // New: handle full account deletion: remove user's messages, remove system messages referencing them,
  // remove from knownUsers and online lists, persist all changes and disconnect any sockets associated
  socket.on("delete_user_account", async (username: string, ack?: (res: { ok: boolean; removedCount?: number; err?: string }) => void) => {
    try {
      console.log(`Received delete_user_account from ${username} (${socket.id})`);

      const before = messages.length;

      // Remove messages authored by the user and System messages that mention the username
      const usernameEscaped = String(username);
      messages = messages.filter((m) => {
        if (m.username === usernameEscaped) return false;
        if (m.username === "System" && typeof m.text === "string" && m.text.includes(usernameEscaped)) return false;
        return true;
      });

      const removed = before - messages.length;

      // Remove from known users and persist both lists
      const hadKnown = knownUsers.delete(usernameEscaped);

      await persistMessages();
      await persistKnownUsers();

      // Disconnect any sockets associated with this username and remove them from users map
      for (const [sid, uname] of Array.from(users.entries())) {
        if (uname === usernameEscaped) {
          users.delete(sid);
          const s = io.sockets.sockets.get(sid as any);
          try {
            s?.disconnect(true);
          } catch (err) {
            // ignore
          }
        }
      }

      // Broadcast updated lists
      broadcastOnline();
      io.emit("messages", messages);

      // Optionally add a system message indicating deletion
      const sysMsg: Message = {
        id: `msg-${Date.now()}-${Math.random()}`,
        username: "System",
        text: `${username} removed their account and messages`,
        ts: Date.now()
      };
      messages.push(sysMsg);
      await persistMessages();
      io.emit("message", sysMsg);

      if (ack) ack({ ok: true, removedCount: removed });
    } catch (err: any) {
      console.error("Error in delete_user_account:", err);
      if (ack) ack({ ok: false, err: String(err) });
    }
  });

  socket.on("disconnect", () => {
    const username = users.get(socket.id);
    users.delete(socket.id);
    console.log("socket disconnected:", socket.id, username);
    broadcastOnline();
    if (username) {
      const leaveMsg: Message = {
        id: `msg-${Date.now()}-${Math.random()}`,
        username: "System",
        text: `${username} left the chat`,
        ts: Date.now()
      };
      messages.push(leaveMsg);
      persistMessages().catch(() => { });
      io.emit("message", leaveMsg);
    }
  });
});

// simple HTTP route for debugging
app.get("/debug/data", (req, res) => {
  res.json({
    messages,
    knownUsers: Array.from(knownUsers),
    online: Array.from(users.values())
  });
});

const PORT = process.env.PORT ? Number(process.env.PORT) : 4000;
(async () => {
  await loadPersisted();
  server.listen(PORT, () => {
    console.log(`Server listening on http://localhost:${PORT}`);
  });
})();