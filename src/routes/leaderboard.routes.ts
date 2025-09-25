/** @format */
import { Router } from "express";
import { prisma } from "../prisma";
import { requireAuth } from "../middlewares/security";

const router = Router();

/** GET /api/leaderboard?period=daily|weekly|monthly */
router.get("/", requireAuth, async (req, res) => {
  const { period = "weekly" } = req.query as { period?: string };
  const now = new Date();
  const from = new Date(
    period === "daily"
      ? now.getTime() - 1 * 24 * 3600 * 1000
      : period === "monthly"
        ? now.getTime() - 30 * 24 * 3600 * 1000
        : now.getTime() - 7 * 24 * 3600 * 1000
  );

  const results = await prisma.gameResult.findMany({
    where: { isCompleted: true, completedAt: { gte: from } },
    select: { userId: true, score: true, id: true },
  });

  // รวมคะแนนรายผู้ใช้
  const byUser = new Map<string, { score: number; games: number }>();
  for (const r of results) {
    const e = byUser.get(r.userId) || { score: 0, games: 0 };
    e.score += r.score;
    e.games += 1;
    byUser.set(r.userId, e);
  }

  // ชื่อผู้ใช้
  const userIds = Array.from(byUser.keys());
  const users = await prisma.user.findMany({
    where: { id: { in: userIds } },
    select: { id: true, username: true },
  });
  const nameMap = new Map(users.map((u) => [u.id, u.username]));

  // คำนวณ mastery เฉลี่ยช่วงเวลา (approx: จาก correct/total ของรอบในช่วงเวลา)
  const gq = await prisma.gameQuestion.findMany({
    where: { gameResult: { completedAt: { gte: from }, isCompleted: true } },
    select: { isCorrect: true, gameResult: { select: { userId: true } } },
  });
  const acc = new Map<string, { c: number; t: number }>();
  for (const a of gq) {
    const uid = a.gameResult.userId;
    const e = acc.get(uid) || { c: 0, t: 0 };
    if (a.isCorrect) e.c += 1;
    e.t += 1;
    acc.set(uid, e);
  }

  const rows = userIds
    .map((uid) => {
      const s = byUser.get(uid)!;
      const m = acc.get(uid);
      const masteryAvg = m && m.t ? (m.c / m.t) * 100 : 0;
      return {
        userId: uid,
        userName: nameMap.get(uid) || uid.slice(-6),
        score: s.score,
        games: s.games,
        masteryAvg,
      };
    })
    .sort((a, b) => b.score - a.score)
    .map((r, i) => ({ rank: i + 1, ...r }));

  res.json(rows);
});

export default router;
