/** @format */
import { prisma } from "../config/database";
import { GAME_CONFIG, CATEGORIES, Category } from "../config/constants";
import { Lang } from "@prisma/client";

export class GameService {
  /**
   * Get random questions for a category
   */
  async getCategoryQuestions(category: Category, count: number, lang: Lang) {
    const questions = await prisma.question.findMany({
      where: {
        category,
        isActive: true,
      },
      include: {
        translations: {
          where: { lang },
        },
      },
    });

    // Shuffle and take required count
    const shuffled = this.shuffleArray(questions);
    const selected = shuffled.slice(0, count);

    return selected.map((q) => this.formatQuestion(q, lang));
  }

  /**
   * Get mixed questions (equal from each category)
   */
  async getMixedQuestions(lang: Lang) {
    const questionsPerCategory = GAME_CONFIG.QUESTIONS_PER_CATEGORY_MIXED;
    const allQuestions = [];

    for (const category of CATEGORIES) {
      const questions = await this.getCategoryQuestions(category, questionsPerCategory, lang);
      allQuestions.push(...questions);
    }

    // Shuffle all questions together
    return this.shuffleArray(allQuestions);
  }

  /**
   * Format question for frontend
   */
  private formatQuestion(question: any, lang: Lang) {
    const translation = question.translations[0];

    return {
      id: question.id,
      category: question.category,
      type: question.type,
      inputType: question.inputType,
      difficulty: question.difficulty,
      questionText: translation?.questionText || "",
      options: translation?.options || [],
      imageUrl: translation?.imageUrl ? `/api/admin/images/${translation.imageUrl}` : null,
      targetValue: translation?.targetValue || null,
    };
  }

  /**
   * Calculate base score based on difficulty
   */
  calculateBaseScore(difficulty: number): number {
    if (difficulty >= 3) return GAME_CONFIG.SCORE_MULTIPLIERS.HARD;
    if (difficulty === 2) return GAME_CONFIG.SCORE_MULTIPLIERS.MEDIUM;
    return GAME_CONFIG.SCORE_MULTIPLIERS.EASY;
  }

  /**
   * Calculate time bonus multiplier
   */
  calculateTimeBonus(timeSpent: number): number {
    if (timeSpent <= GAME_CONFIG.TIME_BONUS_THRESHOLD) {
      return GAME_CONFIG.TIME_BONUS_MULTIPLIER;
    }
    return 1;
  }

  /**
   * Update user statistics after game
   */
  async updateUserStats(userId: string, score: number, correctAnswers: number, totalQuestions: number) {
    // Update basic stats
    await prisma.user.update({
      where: { id: userId },
      data: {
        totalScore: { increment: score },
        gamesPlayed: { increment: 1 },
      },
    });

    // Recalculate mastery percentages
    await this.updateMasteryScores(userId);
  }

  /**
   * Update mastery scores based on all game results
   */
  private async updateMasteryScores(userId: string) {
    const gameQuestions = await prisma.gameQuestion.findMany({
      where: {
        gameResult: { userId },
      },
      select: {
        isCorrect: true,
        question: {
          select: { category: true },
        },
      },
    });

    // Calculate accuracy per category
    const categoryStats: Record<Category, { correct: number; total: number }> = {
      HEALTH: { correct: 0, total: 0 },
      COGNITION: { correct: 0, total: 0 },
      DIGITAL: { correct: 0, total: 0 },
      FINANCE: { correct: 0, total: 0 },
    };

    for (const gq of gameQuestions) {
      const category = gq.question.category as Category;
      categoryStats[category].total++;
      if (gq.isCorrect) {
        categoryStats[category].correct++;
      }
    }

    // Calculate percentages
    const calculatePercentage = (stats: { correct: number; total: number }) => {
      return stats.total > 0 ? Math.round((stats.correct / stats.total) * 100) : 0;
    };

    // Update user mastery scores
    await prisma.user.update({
      where: { id: userId },
      data: {
        healthMastery: calculatePercentage(categoryStats.HEALTH),
        cognitionMastery: calculatePercentage(categoryStats.COGNITION),
        digitalMastery: calculatePercentage(categoryStats.DIGITAL),
        financeMastery: calculatePercentage(categoryStats.FINANCE),
      },
    });
  }

  /**
   * Fisher-Yates shuffle algorithm
   */
  private shuffleArray<T>(array: T[]): T[] {
    const shuffled = [...array];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return shuffled;
  }

  /**
   * Get leaderboard data
   */
  async getLeaderboard(
    period: "daily" | "weekly" | "monthly" | "all",
    category: Category | "ALL",
    limit: number = 10
  ) {
    const now = new Date();
    let dateFilter;

    switch (period) {
      case "daily":
        dateFilter = new Date(now.getTime() - 24 * 60 * 60 * 1000);
        break;
      case "weekly":
        dateFilter = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        break;
      case "monthly":
        dateFilter = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
        break;
      default:
        dateFilter = null;
    }

    const where: any = {};
    if (dateFilter) {
      where.completedAt = { gte: dateFilter };
    }
    if (category !== "ALL") {
      where.category = category;
    }

    // Aggregate scores by user
    const results = await prisma.gameResult.groupBy({
      by: ["userId"],
      where,
      _sum: {
        score: true,
        correctAnswers: true,
        totalQuestions: true,
      },
      _count: {
        id: true,
      },
      orderBy: {
        _sum: {
          score: "desc",
        },
      },
      take: limit,
    });

    // Get user details
    const userIds = results.map((r) => r.userId);
    const users = await prisma.user.findMany({
      where: { id: { in: userIds } },
      select: {
        id: true,
        username: true,
      },
    });

    const userMap = new Map(users.map((u) => [u.id, u]));

    // Format leaderboard
    return results.map((result, index) => {
      const user = userMap.get(result.userId);
      const accuracy = result._sum.totalQuestions
        ? Math.round((result._sum.correctAnswers! / result._sum.totalQuestions!) * 100)
        : 0;

      return {
        rank: index + 1,
        userId: result.userId,
        username: user?.username || "Unknown",
        score: result._sum.score || 0,
        gamesPlayed: result._count.id,
        accuracy,
      };
    });
  }
}
