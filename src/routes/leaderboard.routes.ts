/** @format */
import { Router } from "express";
import { prisma } from "../prisma";
import { requireAuth } from "../middlewares/security";

const router = Router();

/** GET /api/leaderboard?period=daily|weekly|monthly|all&category=HEALTH|ALL */
router.get("/", requireAuth, async (req, res) => {
  try {
    const {
      period = "weekly",
      category = "ALL",
      limit = "10",
    } = req.query as {
      period?: string;
      category?: string;
      limit?: string;
    };

    const now = new Date();
    let dateFilter: Date | null = null;

    // ⭐ กำหนดช่วงเวลา
    switch (period) {
      case "daily":
        dateFilter = new Date(now.getTime() - 1 * 24 * 3600 * 1000);
        break;
      case "weekly":
        dateFilter = new Date(now.getTime() - 7 * 24 * 3600 * 1000);
        break;
      case "monthly":
        dateFilter = new Date(now.getTime() - 30 * 24 * 3600 * 1000);
        break;
      case "all":
      default:
        dateFilter = null;
    }

    // ⭐ สร้าง filter
    const where: any = { isCompleted: true };
    if (dateFilter) {
      where.completedAt = { gte: dateFilter };
    }
    if (category !== "ALL") {
      where.category = category;
    }

    // ⭐ ดึงข้อมูลเกม
    const results = await prisma.gameResult.findMany({
      where,
      select: {
        userId: true,
        score: true,
        correctAnswers: true,
        totalQuestions: true,
        user: {
          select: {
            username: true,
            profile: {
              select: {
                displayName: true,
              },
            },
          },
        },
      },
    });

    // ⭐ รวมคะแนนรายผู้ใช้
    const byUser = new Map<
      string,
      {
        username: string;
        displayName: string;
        score: number;
        games: number;
        totalCorrect: number;
        totalQuestions: number;
      }
    >();

    for (const r of results) {
      const uid = r.userId;
      const e = byUser.get(uid) || {
        username: r.user.username,
        displayName: r.user.profile?.displayName || r.user.username,
        score: 0,
        games: 0,
        totalCorrect: 0,
        totalQuestions: 0,
      };
      e.score += r.score;
      e.games += 1;
      e.totalCorrect += r.correctAnswers;
      e.totalQuestions += r.totalQuestions;
      byUser.set(uid, e);
    }

    // ⭐ จัดเรียงและสร้าง leaderboard
    const rows = Array.from(byUser.entries())
      .map(([uid, data]) => {
        const accuracy =
          data.totalQuestions > 0 ? Math.round((data.totalCorrect / data.totalQuestions) * 100) : 0;

        return {
          userId: uid,
          username: data.username,
          displayName: data.displayName,
          score: data.score,
          gamesPlayed: data.games,
          accuracy,
        };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, parseInt(limit))
      .map((r, i) => ({ rank: i + 1, ...r }));

    res.json(rows);
  } catch (error) {
    console.error("Leaderboard error:", error);
    res.status(500).json({ error: "Failed to load leaderboard" });
  }
});

export default router;
