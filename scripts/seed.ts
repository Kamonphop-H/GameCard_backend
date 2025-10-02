/** @format */
import { PrismaClient } from "@prisma/client";
import { hashPassword } from "../src/middlewares/auth";

const prisma = new PrismaClient();

async function main() {
  console.log("🌱 Starting database seed...");

  // Create admin user
  const adminPassword = await hashPassword("Admin@123456");
  const admin = await prisma.user.upsert({
    where: { username: "admin" },
    update: {},
    create: {
      username: "admin",
      passwordHash: adminPassword,
      role: "ADMIN",
      lang: "th",
      isActive: true,
    },
  });
  console.log("Admin user created");

  // Create test player
  const playerPassword = await hashPassword("Player@123");
  const player = await prisma.user.upsert({
    where: { username: "player1" },
    update: {},
    create: {
      username: "player1",
      passwordHash: playerPassword,
      role: "PLAYER",
      lang: "th",
      isActive: true,
    },
  });
  console.log("Test player created");

  // Sample questions for each category
  const sampleQuestions = [
    // HEALTH Questions
    {
      category: "HEALTH" as const,
      type: "MISSING_NUTRIENT" as const,
      inputType: "TEXT" as const,
      difficulty: 1,
      translations: {
        th: {
          questionText: "ร่างกายขาดวิตามินอะไร เมื่อมีอาการเหงือกเลือดออก?",
          correctAnswers: ["วิตามินซี", "วิตามิน C", "Vitamin C"],
          explanation: "วิตามินซีช่วยในการสร้างคอลลาเจนที่สำคัญต่อเหงือกและเนื้อเยื่อ",
        },
        en: {
          questionText: "What vitamin deficiency causes bleeding gums?",
          correctAnswers: ["Vitamin C", "C"],
          explanation: "Vitamin C is essential for collagen production in gums and tissues",
        },
      },
    },
    {
      category: "HEALTH" as const,
      type: "DISEASE_FROM_IMAGE" as const,
      inputType: "MULTIPLE_CHOICE_4" as const,
      difficulty: 2,
      translations: {
        th: {
          questionText: "จากรูปผื่นแดงเป็นวงกลม นี่คืออาการของโรคอะไร?",
          options: ["โรคเรื้อน", "โรคกลาก", "โรคสะเก็ดเงิน", "โรคผิวหนังอักเสบ"],
          correctAnswers: ["โรคกลาก"],
          explanation: "โรคกลากมีลักษณะเป็นผื่นวงกลมขอบแดงตรงกลางจาง",
        },
        en: {
          questionText: "What skin condition shows circular red patches?",
          options: ["Leprosy", "Ringworm", "Psoriasis", "Dermatitis"],
          correctAnswers: ["Ringworm"],
          explanation: "Ringworm appears as circular patches with red edges and clear centers",
        },
      },
    },

    // COGNITION Questions
    {
      category: "COGNITION" as const,
      type: "ODD_ONE_OUT" as const,
      inputType: "TEXT" as const,
      difficulty: 1,
      translations: {
        th: {
          questionText: "ข้อใดไม่เข้าพวก: แมว, สุนัข, นก, รถยนต์",
          correctAnswers: ["รถยนต์"],
          explanation: "รถยนต์เป็นสิ่งของ ส่วนอื่นๆ เป็นสัตว์",
        },
        en: {
          questionText: "Which doesn't belong: cat, dog, bird, car",
          correctAnswers: ["car"],
          explanation: "Car is an object while others are animals",
        },
      },
    },
    {
      category: "COGNITION" as const,
      type: "ILLEGAL_TEXT" as const,
      inputType: "MULTIPLE_CHOICE_4" as const,
      difficulty: 2,
      translations: {
        th: {
          questionText: "ข้อความใดผิดกฎหมาย?",
          options: ["ขายบ้านพร้อมโอน", "รับซื้อไต 500,000 บาท", "รับจ้างทำความสะอาด", "ขายรถมือสอง"],
          correctAnswers: ["รับซื้อไต 500,000 บาท"],
          explanation: "การซื้อขายอวัยวะเป็นสิ่งผิดกฎหมายในประเทศไทย",
        },
        en: {
          questionText: "Which message is illegal?",
          options: [
            "House for sale with transfer",
            "Buying kidney 500,000 THB",
            "Cleaning service available",
            "Used car for sale",
          ],
          correctAnswers: ["Buying kidney 500,000 THB"],
          explanation: "Organ trading is illegal in Thailand",
        },
      },
    },

    // DIGITAL Questions
    {
      category: "DIGITAL" as const,
      type: "APP_IDENTITY" as const,
      inputType: "MULTIPLE_CHOICE_4" as const,
      difficulty: 1,
      translations: {
        th: {
          questionText: "ไอคอนสีเขียวรูปโทรศัพท์ คือแอปอะไร?",
          options: ["Line", "WhatsApp", "Facebook", "WeChat"],
          correctAnswers: ["WhatsApp"],
          explanation: "WhatsApp มีไอคอนสีเขียวรูปหูโทรศัพท์",
        },
        en: {
          questionText: "Green phone icon is which app?",
          options: ["Line", "WhatsApp", "Facebook", "WeChat"],
          correctAnswers: ["WhatsApp"],
          explanation: "WhatsApp has a green phone icon",
        },
      },
    },
    {
      category: "DIGITAL" as const,
      type: "SCAM_TEXT" as const,
      inputType: "MULTIPLE_CHOICE_4" as const,
      difficulty: 2,
      translations: {
        th: {
          questionText: "ข้อความใดน่าจะเป็นการหลอกลวง?",
          options: [
            "คุณถูกรางวัล กด link ด่วน!",
            "นัดประชุมพรุ่งนี้ 10:00",
            "ใบแจ้งหนี้ค่าไฟเดือนนี้",
            "โปรโมชั่นร้านอาหาร 20%",
          ],
          correctAnswers: ["คุณถูกรางวัล กด link ด่วน!"],
          explanation: "ข้อความถูกรางวัลแบบกะทันหันและให้กดลิงก์ด่วนมักเป็นการหลอกลวง",
        },
        en: {
          questionText: "Which message is likely a scam?",
          options: [
            "You won! Click link now!",
            "Meeting tomorrow 10 AM",
            "This month's electricity bill",
            "Restaurant promotion 20% off",
          ],
          correctAnswers: ["You won! Click link now!"],
          explanation: "Sudden prize messages with urgent link clicking are usually scams",
        },
      },
    },

    // FINANCE Questions
    {
      category: "FINANCE" as const,
      type: "ARITHMETIC_TARGET" as const,
      inputType: "CALCULATION" as const,
      difficulty: 1,
      translations: {
        th: {
          questionText: "จงบวกเลขให้ได้ 10",
          correctAnswers: ["10"],
          targetValue: 10,
          explanation: "ตัวอย่าง: 5+5, 7+3, 6+4 ทั้งหมดได้ 10",
        },
        en: {
          questionText: "Add numbers to get 10",
          correctAnswers: ["10"],
          targetValue: 10,
          explanation: "Examples: 5+5, 7+3, 6+4 all equal 10",
        },
      },
    },
    {
      category: "FINANCE" as const,
      type: "MAX_VALUE_STACK" as const,
      inputType: "MULTIPLE_CHOICE_3" as const,
      difficulty: 2,
      translations: {
        th: {
          questionText: "กองไหนมีมูลค่ามากที่สุด: A) 5 ใบ 100 บาท, B) 10 ใบ 50 บาท, C) 20 ใบ 20 บาท",
          options: ["กอง A", "กอง B", "กอง C"],
          correctAnswers: ["กอง A"],
          explanation: "กอง A = 500, กอง B = 500, กอง C = 400 (กอง A และ B เท่ากัน แต่ A ถูกเลือกเป็นคำตอบ)",
        },
        en: {
          questionText: "Which stack has most value: A) 5x100 THB, B) 10x50 THB, C) 20x20 THB",
          options: ["Stack A", "Stack B", "Stack C"],
          correctAnswers: ["Stack A"],
          explanation: "Stack A = 500, Stack B = 500, Stack C = 400",
        },
      },
    },
  ];

  // Insert sample questions
  let questionCount = 0;
  for (const questionData of sampleQuestions) {
    const { translations, ...questionInfo } = questionData;

    const question = await prisma.question.create({
      data: {
        ...questionInfo,
        isActive: true,
        translations: {
          create: [
            {
              lang: "th",
              questionText: translations.th.questionText,
              options: translations.th.options || [],
              correctAnswers: translations.th.correctAnswers,
              targetValue: translations.th.targetValue || null,
              explanation: translations.th.explanation || "",
            },
            {
              lang: "en",
              questionText: translations.en.questionText,
              options: translations.en.options || [],
              correctAnswers: translations.en.correctAnswers,
              targetValue: translations.en.targetValue || null,
              explanation: translations.en.explanation || "",
            },
          ],
        },
      },
    });
    questionCount++;
  }

  console.log(`Created ${questionCount} sample questions`);

  // Create sample game results for leaderboard
  const categories = ["HEALTH", "COGNITION", "DIGITAL", "FINANCE"] as const;

  for (let i = 0; i < 5; i++) {
    const category = categories[Math.floor(Math.random() * categories.length)];
    const correctAnswers = Math.floor(Math.random() * 6) + 5; // 5-10
    const score = correctAnswers * 10 * (Math.random() > 0.5 ? 1.5 : 1); // With or without time bonus

    await prisma.gameResult.create({
      data: {
        userId: player.id,
        category,
        score: Math.round(score),
        totalQuestions: 10,
        correctAnswers,
        timeSpent: Math.floor(Math.random() * 300) + 60, // 60-360 seconds
        completedAt: new Date(Date.now() - Math.random() * 7 * 24 * 60 * 60 * 1000), // Last 7 days
      },
    });
  }

  console.log("Created sample game results");

  console.log("\nDatabase seeded successfully!");
  console.log("\nLogin credentials:");
  console.log("Admin: username=admin, password=Admin@123456");
  console.log("Player: username=player1, password=Player@123");
}

main()
  .catch((e) => {
    console.error("❌ Seed failed:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
