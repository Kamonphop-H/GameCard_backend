/** @format */
import { prisma } from "../prisma";

export class AchievementService {
  static async checkAndUnlockAchievements(userId: string, gameResult: any) {
    const achievements = [];
    const percentage = (gameResult.correctAnswers / gameResult.totalQuestions) * 100;

    // Perfect Score
    if (percentage === 100) {
      const achievement = await this.unlockAchievement(userId, "PERFECT_SCORE", gameResult.category);
      if (achievement) achievements.push(achievement);
    }

    // Category Master (90%+)
    if (percentage >= 90) {
      const achievement = await this.unlockAchievement(userId, "CATEGORY_MASTER", gameResult.category);
      if (achievement) achievements.push(achievement);
    }

    // Speed Demon (under 2 minutes)
    if (gameResult.timeSpent < 120) {
      const achievement = await this.unlockAchievement(userId, "SPEED_DEMON", gameResult.category);
      if (achievement) achievements.push(achievement);
    }

    // First Game
    const gameCount = await prisma.gameResult.count({ where: { userId } });
    if (gameCount === 1) {
      const achievement = await this.unlockAchievement(userId, "FIRST_GAME");
      if (achievement) achievements.push(achievement);
    }

    // Update mastery score
    await this.updateMasteryScore(userId, gameResult.category, percentage);

    return achievements;
  }

  static async unlockAchievement(userId: string, type: string, category?: string) {
    const existing = await prisma.achievement.findUnique({
      where: {
        userId_type_category: {
          userId,
          type,
          category: category || null,
        },
      },
    });

    if (existing) return null;

    return prisma.achievement.create({
      data: {
        userId,
        type,
        category: category as any,
        isCompleted: true,
      },
    });
  }

  static async updateMasteryScore(userId: string, category: string, score: number) {
    const profile = await prisma.profile.findUnique({ where: { userId } });
    if (!profile) return;

    const masteryField = `${category.toLowerCase()}Mastery` as keyof typeof profile;
    const currentScore = (profile as any)[masteryField] || 0;
    const newScore = Math.max(currentScore, Math.floor(score));

    await prisma.profile.update({
      where: { userId },
      data: { [masteryField]: newScore },
    });
  }

  static async getUserAchievements(userId: string) {
    return prisma.achievement.findMany({
      where: { userId },
      orderBy: { unlockedAt: "desc" },
    });
  }
}
