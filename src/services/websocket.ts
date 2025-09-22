/** @format */
import { Server as SocketServer } from "socket.io";
import { Server } from "http";
import { verifyAccessToken } from "../middlewares/security";
import { prisma } from "../prisma";

export function initWebSocket(server: Server) {
  const io = new SocketServer(server, {
    cors: {
      origin: process.env.FRONTEND_URL || "http://localhost:3000",
      credentials: true,
    },
  });

  // Authentication middleware
  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth.token;
      const payload = verifyAccessToken(token);

      const user = await prisma.user.findUnique({
        where: { id: payload.uid },
        select: { id: true, username: true, isActive: true },
      });

      if (!user?.isActive) throw new Error("Invalid user");

      socket.data = { userId: user.id, username: user.username };
      next();
    } catch {
      next(new Error("Authentication failed"));
    }
  });

  io.on("connection", (socket) => {
    console.log("User connected:", socket.data.username);

    // Join leaderboard room
    socket.on("join-leaderboard", async (category) => {
      socket.join(`leaderboard-${category}`);
      const leaderboard = await getLeaderboard(category);
      socket.emit("leaderboard-update", leaderboard);
    });

    // Handle score updates
    socket.on("score-update", async (data) => {
      await updateUserScore(socket.data.userId, data);
      const leaderboard = await getLeaderboard(data.category);
      io.to(`leaderboard-${data.category}`).emit("leaderboard-update", leaderboard);
    });

    socket.on("disconnect", () => {
      console.log("User disconnected:", socket.data.username);
    });
  });

  return io;
}

async function getLeaderboard(category: string) {
  const results = await prisma.gameResult.findMany({
    where: { category: category as any },
    orderBy: { score: "desc" },
    take: 10,
    include: {
      user: {
        include: { profile: true },
      },
    },
  });

  return results.map((r, index) => ({
    rank: index + 1,
    username: r.user.username,
    displayName: r.user.profile?.displayName,
    score: r.score,
    avatar: r.user.profile?.avatar,
  }));
}

async function updateUserScore(userId: string, data: any) {
  return prisma.gameResult.create({
    data: {
      userId,
      category: data.category,
      score: data.score,
      totalQuestions: data.totalQuestions,
      correctAnswers: data.correctAnswers,
      timeSpent: data.timeSpent,
    },
  });
}
