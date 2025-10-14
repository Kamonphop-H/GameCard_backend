/** @format */

// src/services/firebaseService.ts
/** @format */

import admin from "firebase-admin";

class FirebaseService {
  private static instance: FirebaseService;
  private app: admin.app.App | null = null;

  private constructor() {}

  public static getInstance(): FirebaseService {
    if (!FirebaseService.instance) {
      FirebaseService.instance = new FirebaseService();
    }
    return FirebaseService.instance;
  }

  /**
   * Initialize Firebase Admin SDK
   */
  public initialize() {
    try {
      // ใช้ Service Account หรือ credentials จาก environment
      const serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT;

      if (serviceAccount) {
        // ถ้ามี service account JSON string
        const credentials = JSON.parse(serviceAccount);
        this.app = admin.initializeApp({
          credential: admin.credential.cert(credentials),
        });
      } else if (process.env.FIREBASE_PROJECT_ID) {
        // ใช้ Application Default Credentials (สำหรับ production)
        this.app = admin.initializeApp({
          credential: admin.credential.applicationDefault(),
          projectId: process.env.FIREBASE_PROJECT_ID,
        });
      } else {
        console.warn("Firebase credentials not found. Google Sign-In will not work.");
        return false;
      }

      console.log("✅ Firebase Admin initialized successfully");
      return true;
    } catch (error) {
      console.error("❌ Failed to initialize Firebase:", error);
      return false;
    }
  }

  /**
   * Verify Firebase ID Token
   */
  public async verifyIdToken(idToken: string): Promise<admin.auth.DecodedIdToken | null> {
    try {
      if (!this.app) {
        throw new Error("Firebase not initialized");
      }

      const decodedToken = await admin.auth().verifyIdToken(idToken);
      return decodedToken;
    } catch (error) {
      console.error("Token verification error:", error);
      return null;
    }
  }

  /**
   * Get user info from Firebase
   */
  public async getUserInfo(uid: string): Promise<admin.auth.UserRecord | null> {
    try {
      if (!this.app) {
        throw new Error("Firebase not initialized");
      }

      const userRecord = await admin.auth().getUser(uid);
      return userRecord;
    } catch (error) {
      console.error("Get user info error:", error);
      return null;
    }
  }

  /**
   * Check if Firebase is initialized
   */
  public isInitialized(): boolean {
    return this.app !== null;
  }

  /**
   * Revoke refresh tokens for a user
   */
  public async revokeRefreshTokens(uid: string): Promise<boolean> {
    try {
      if (!this.app) {
        throw new Error("Firebase not initialized");
      }

      await admin.auth().revokeRefreshTokens(uid);
      return true;
    } catch (error) {
      console.error("Revoke tokens error:", error);
      return false;
    }
  }
}

export default FirebaseService.getInstance();
