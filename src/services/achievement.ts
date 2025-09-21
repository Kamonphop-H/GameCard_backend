/** @format */

// backend/src/services/achievement.ts
import { prisma } from "../prisma";

export class AchievementService {
  static async checkAndUnlockAchievements(userId: string, gameResult: any) {
    const achievements = [];

    // Perfect Score Achievement
    if (gameResult.correctAnswers === gameResult.totalQuestions) {
      const perfectScore = await this.unlockAchievement(userId, "PERFECT_SCORE", gameResult.category);
      if (perfectScore) achievements.push(perfectScore);
    }

    // Category Master Achievement (score > 90%)
    const percentage = (gameResult.correctAnswers / gameResult.totalQuestions) * 100;
    if (percentage >= 90) {
      const categoryMaster = await this.unlockAchievement(userId, "CATEGORY_MASTER", gameResult.category);
      if (categoryMaster) achievements.push(categoryMaster);
    }

    // Speed Demon Achievement (complete in under 2 minutes)
    if (gameResult.timeSpent < 120) {
      const speedDemon = await this.unlockAchievement(userId, "SPEED_DEMON", gameResult.category);
      if (speedDemon) achievements.push(speedDemon);
    }

    // Update user mastery scores
    await this.updateMasteryScore(userId, gameResult.category, percentage);

    return achievements;
  }

  static async unlockAchievement(userId: string, type: string, category?: string) {
    // Check if already unlocked
    const existing = await prisma.achievement.findFirst({
      where: {
        userId,
        type,
        category: category as any,
      },
    });

    if (existing) return null;

    // Create new achievement
    return await prisma.achievement.create({
      data: {
        userId,
        type,
        category: category as any,
      },
    });
  }

  static async updateMasteryScore(userId: string, category: string, score: number) {
    const profile = await prisma.profile.findUnique({
      where: { userId },
    });

    if (!profile) return;

    const masteryField = `${category.toLowerCase()}Mastery`;
    const currentScore = (profile as any)[masteryField] || 0;
    const newScore = Math.max(currentScore, Math.floor(score));

    await prisma.profile.update({
      where: { userId },
      data: { [masteryField]: newScore },
    });
  }
}
