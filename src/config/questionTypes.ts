/** @format */

export const questionTypes = {
  HEALTH: [
    {
      id: "MISSING_NUTRIENT",
      name: "สารอาหารที่หายไป",
      inputType: "TEXT",
      multipleAnswers: true,
      description: "ผู้ใช้กรอกสารอาหารที่หายไป (ตอบ 1 ในหลายคำตอบก็ถูก)",
    },
    {
      id: "NUTRIENT_FROM_IMAGE",
      name: "ภาพนี้ได้สารอาหารอะไร",
      inputType: "TEXT",
      multipleAnswers: true,
      description: "ผู้ใช้กรอกชื่อสารอาหาร (ตอบ 1 ในหลายคำตอบก็ถูก)",
    },
    {
      id: "DISEASE_FROM_IMAGE",
      name: "ภาพนี้คือโรคอะไร",
      inputType: "MULTIPLE_CHOICE_4",
      multipleAnswers: false,
      description: "เลือก 1 จาก 4 ตัวเลือก",
    },
  ],
  COGNITION: [
    {
      id: "ILLEGAL_TEXT",
      name: "ข้อความผิดกฎหมาย",
      inputType: "MULTIPLE_CHOICE_4",
      multipleAnswers: false,
      description: "เลือก 1 จาก 4 ตัวเลือก",
    },
    {
      id: "ODD_ONE_OUT",
      name: "สิ่งของไม่เข้าพวก",
      inputType: "TEXT",
      multipleAnswers: false,
      description: "ผู้ใช้กรอกสิ่งที่ไม่เข้าพวก (คำตอบเดียว)",
    },
  ],
  DIGITAL: [
    {
      id: "APP_IDENTITY",
      name: "แอปพลิเคชันนี้คืออะไร",
      inputType: "MULTIPLE_CHOICE_4",
      multipleAnswers: false,
      description: "เลือก 1 จาก 4 ตัวเลือก",
    },
    {
      id: "SCAM_TEXT",
      name: "ข้อความหลอกลวง",
      inputType: "MULTIPLE_CHOICE_4",
      multipleAnswers: false,
      description: "เลือก 1 จาก 4 ตัวเลือก",
    },
    {
      id: "DONT_SHARE",
      name: "ข้อมูลที่ไม่ควรแชร์",
      inputType: "MULTIPLE_CHOICE_4",
      multipleAnswers: false,
      description: "เลือก 1 จาก 4 ตัวเลือก",
    },
  ],
  FINANCE: [
    {
      id: "ARITHMETIC_TARGET",
      name: "บวกเลขตามเป้าหมาย",
      inputType: "CALCULATION",
      multipleAnswers: false,
      description: "ผู้ใช้กรอกสมการ (เช่น 1+9) ระบบจะคำนวณตรวจคำตอบ",
    },
    {
      id: "MAX_VALUE_STACK",
      name: "ธนบัตรกองไหนมากสุด",
      inputType: "MULTIPLE_CHOICE_3",
      multipleAnswers: false,
      description: "เลือก 1 จาก 3 กอง",
    },
  ],
};
