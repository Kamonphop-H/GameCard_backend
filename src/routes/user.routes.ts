/** @format */
import { Router } from "express";
import { prisma } from "../prisma";
import { requireAuth } from "../middlewares/security";

const router = Router();

/** GET /api/user/stats - ⭐ ดึงข้อมูลจริงจากฐานข้อมูล */
router.get("/stats", requireAuth, async (req, res) => {
  try {
    const userId = req.auth!.userId;

    // ดึงข้อมูล Profile
    const profile = await prisma.profile.findUnique({
      where: { userId },
      select: {
        totalScore: true,
        gamesPlayed: true,
        healthMastery: true,
        cognitionMastery: true,
        digitalMastery: true,
        financeMastery: true,
      },
    });

    if (!profile) {
      // สร้าง profile ใหม่ถ้ายังไม่มี
      const newProfile = await prisma.profile.create({
        data: {
          userId,
          displayName: req.auth!.username,
          totalScore: 0,
          gamesPlayed: 0,
          healthMastery: 0,
          cognitionMastery: 0,
          digitalMastery: 0,
          financeMastery: 0,
        },
      });

      return res.json({
        totalScore: 0,
        gamesPlayed: 0,
        healthMastery: 0,
        cognitionMastery: 0,
        digitalMastery: 0,
        financeMastery: 0,
        hasPlayedMixed: false,
      });
    }

    // ⭐ เช็คว่าเคยเล่น MIXED หรือยัง (จาก Achievement)
    const mixedAchievement = await prisma.achievement.findFirst({
      where: {
        userId,
        type: "MIXED_UNLOCK",
        isCompleted: true,
      },
    });

    const hasPlayedMixed = !!mixedAchievement;

    res.json({
      totalScore: profile.totalScore,
      gamesPlayed: profile.gamesPlayed,
      healthMastery: profile.healthMastery,
      cognitionMastery: profile.cognitionMastery,
      digitalMastery: profile.digitalMastery,
      financeMastery: profile.financeMastery,
      hasPlayedMixed,
    });
  } catch (error) {
    console.error("Get stats error:", error);
    res.status(500).json({ error: "Failed to load statistics" });
  }
});

/** GET /api/user/profile - ดึงข้อมูล Profile เต็ม */
router.get("/profile", requireAuth, async (req, res) => {
  try {
    const userId = req.auth!.userId;

    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: {
        profile: true,
      },
    });

    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    res.json({
      user: {
        id: user.id,
        username: user.username,
        role: user.role,
        preferredLang: user.preferredLang,
        profile: user.profile,
      },
    });
  } catch (error) {
    console.error("Get profile error:", error);
    res.status(500).json({ error: "Failed to load profile" });
  }
});

/** PATCH /api/user/profile - อัพเดท Profile */
router.patch("/profile", requireAuth, async (req, res) => {
  try {
    const userId = req.auth!.userId;
    const { displayName, avatar } = req.body;

    const updated = await prisma.profile.update({
      where: { userId },
      data: {
        ...(displayName && { displayName }),
        ...(avatar && { avatar }),
      },
    });

    res.json({
      message: "Profile updated successfully",
      profile: updated,
    });
  } catch (error) {
    console.error("Update profile error:", error);
    res.status(500).json({ error: "Failed to update profile" });
  }
});

export default router;
