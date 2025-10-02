/** @format */
import { MongoClient, Db, GridFSBucket, ObjectId } from "mongodb";
import sharp from "sharp";
import { Readable } from "stream";

class FileService {
  private static instance: FileService;
  private db: Db | null = null;
  private bucket: GridFSBucket | null = null;
  private client: MongoClient | null = null;

  private constructor() {}

  public static getInstance(): FileService {
    if (!FileService.instance) {
      FileService.instance = new FileService();
    }
    return FileService.instance;
  }

  /**
   * Initialize MongoDB connection and GridFS bucket
   */
  public async initialize(connectionUri: string, dbName: string) {
    try {
      this.client = new MongoClient(connectionUri);
      await this.client.connect();
      this.db = this.client.db(dbName);

      // Create GridFS bucket for storing files
      this.bucket = new GridFSBucket(this.db, {
        bucketName: "questionImages",
      });

      console.log("GridFS initialized successfully");
      return true;
    } catch (error) {
      console.error("Failed to initialize GridFS:", error);
      throw error;
    }
  }

  /**
   * Upload image with automatic optimization
   */
  public async uploadImage(
    file: Express.Multer.File,
    metadata?: {
      category?: string;
      questionId?: string;
      uploadedBy?: string;
    }
  ): Promise<{
    fileId: string;
    filename: string;
    size: number;
    contentType: string;
  }> {
    if (!this.bucket) {
      throw new Error("GridFS not initialized");
    }

    try {
      // Optimize image before upload
      const optimizedBuffer = await this.optimizeImage(file.buffer, file.mimetype);

      // Generate unique filename
      const timestamp = Date.now();
      const randomString = Math.random().toString(36).substring(7);
      const extension = file.originalname.split(".").pop();
      const filename = `question-${timestamp}-${randomString}.${extension}`;

      // Create readable stream from buffer
      const readableStream = Readable.from(optimizedBuffer);

      // Open upload stream
      const uploadStream = this.bucket.openUploadStream(filename, {
        contentType: file.mimetype,
        metadata: {
          ...metadata,
          originalName: file.originalname,
          uploadedAt: new Date(),
        },
      });

      // Handle upload
      return new Promise((resolve, reject) => {
        uploadStream.on("error", reject);
        uploadStream.on("finish", () => {
          resolve({
            fileId: uploadStream.id.toString(),
            filename: filename,
            size: optimizedBuffer.length,
            contentType: file.mimetype,
          });
        });

        readableStream.pipe(uploadStream);
      });
    } catch (error) {
      console.error("Upload error:", error);
      throw new Error("Failed to upload image");
    }
  }

  /**
   * Download image by ID
   */
  public async downloadImage(fileId: string): Promise<{
    buffer: Buffer;
    contentType: string;
    filename: string;
  }> {
    if (!this.bucket) {
      throw new Error("GridFS not initialized");
    }

    try {
      const chunks: Buffer[] = [];

      // Open download stream
      const downloadStream = this.bucket.openDownloadStream(new ObjectId(fileId));

      // Get file metadata
      const files = await this.bucket.find({ _id: new ObjectId(fileId) }).toArray();

      if (files.length === 0) {
        throw new Error("File not found");
      }

      const file = files[0];

      return new Promise((resolve, reject) => {
        downloadStream.on("data", (chunk) => {
          chunks.push(chunk);
        });

        downloadStream.on("error", reject);

        downloadStream.on("end", () => {
          const buffer = Buffer.concat(chunks);
          resolve({
            buffer,
            contentType: file.contentType || "application/octet-stream",
            filename: file.filename,
          });
        });
      });
    } catch (error) {
      console.error("Download error:", error);
      throw new Error("Failed to download image");
    }
  }

  /**
   * Delete image by ID
   */
  public async deleteImage(fileId: string): Promise<boolean> {
    if (!this.bucket) {
      throw new Error("GridFS not initialized");
    }

    try {
      await this.bucket.delete(new ObjectId(fileId));
      return true;
    } catch (error) {
      console.error("Delete error:", error);
      return false;
    }
  }

  /**
   * Get image stream (for efficient streaming to client)
   */
  public getImageStream(fileId: string): NodeJS.ReadableStream {
    if (!this.bucket) {
      throw new Error("GridFS not initialized");
    }

    return this.bucket.openDownloadStream(new ObjectId(fileId));
  }

  /**
   * List all images with pagination
   */
  public async listImages(
    options: {
      skip?: number;
      limit?: number;
      category?: string;
      questionId?: string;
    } = {}
  ) {
    if (!this.bucket) {
      throw new Error("GridFS not initialized");
    }

    const { skip = 0, limit = 20, category, questionId } = options;

    const filter: any = {};
    if (category) filter["metadata.category"] = category;
    if (questionId) filter["metadata.questionId"] = questionId;

    const files = await this.bucket.find(filter).skip(skip).limit(limit).toArray();

    return files.map((file) => ({
      fileId: file._id.toString(),
      filename: file.filename,
      size: file.length,
      contentType: file.contentType,
      uploadDate: file.uploadDate,
      metadata: file.metadata,
    }));
  }

  /**
   * Optimize image before storage
   */
  private async optimizeImage(buffer: Buffer, mimeType: string): Promise<Buffer> {
    try {
      let pipeline = sharp(buffer);

      // Get image metadata
      const metadata = await pipeline.metadata();

      // Resize if too large (max 1920x1080 for web display)
      if ((metadata.width || 0) > 1920 || (metadata.height || 0) > 1080) {
        pipeline = pipeline.resize(1920, 1080, {
          fit: "inside",
          withoutEnlargement: true,
        });
      }

      // Convert and optimize based on mime type
      if (mimeType === "image/jpeg" || mimeType === "image/jpg") {
        return await pipeline
          .jpeg({
            quality: 85,
            progressive: true,
          })
          .toBuffer();
      } else if (mimeType === "image/png") {
        return await pipeline
          .png({
            compressionLevel: 9,
            progressive: true,
          })
          .toBuffer();
      } else if (mimeType === "image/webp") {
        return await pipeline
          .webp({
            quality: 85,
          })
          .toBuffer();
      } else {
        // Default: convert to JPEG for better compression
        return await pipeline
          .jpeg({
            quality: 85,
            progressive: true,
          })
          .toBuffer();
      }
    } catch (error) {
      console.error("Image optimization error:", error);
      // Return original buffer if optimization fails
      return buffer;
    }
  }

  /**
   * Get image metadata
   */
  public async getImageMetadata(fileId: string) {
    if (!this.bucket) {
      throw new Error("GridFS not initialized");
    }

    const files = await this.bucket.find({ _id: new ObjectId(fileId) }).toArray();

    if (files.length === 0) {
      throw new Error("File not found");
    }

    return files[0];
  }

  /**
   * Update image metadata
   */
  public async updateImageMetadata(fileId: string, metadata: Record<string, any>): Promise<boolean> {
    if (!this.db) {
      throw new Error("Database not initialized");
    }

    try {
      const result = await this.db
        .collection("questionImages.files")
        .updateOne({ _id: new ObjectId(fileId) }, { $set: { metadata } });

      return result.modifiedCount > 0;
    } catch (error) {
      console.error("Update metadata error:", error);
      return false;
    }
  }

  /**
   * Check if file exists
   */
  public async fileExists(fileId: string): Promise<boolean> {
    if (!this.bucket) {
      throw new Error("GridFS not initialized");
    }

    try {
      const files = await this.bucket.find({ _id: new ObjectId(fileId) }).toArray();

      return files.length > 0;
    } catch {
      return false;
    }
  }

  /**
   * Get storage statistics
   */
  public async getStorageStats() {
    if (!this.db) {
      throw new Error("Database not initialized");
    }

    const filesCollection = this.db.collection("questionImages.files");
    const chunksCollection = this.db.collection("questionImages.chunks");

    const [totalFiles, totalSize, stats] = await Promise.all([
      filesCollection.countDocuments(),
      filesCollection.aggregate([{ $group: { _id: null, totalSize: { $sum: "$length" } } }]).toArray(),
      filesCollection
        .aggregate([
          {
            $group: {
              _id: "$metadata.category",
              count: { $sum: 1 },
              size: { $sum: "$length" },
            },
          },
        ])
        .toArray(),
    ]);

    return {
      totalFiles,
      totalSize: totalSize[0]?.totalSize || 0,
      categoryStats: stats.map((s) => ({
        category: s._id,
        count: s.count,
        size: s.size,
      })),
      averageFileSize: totalFiles > 0 ? (totalSize[0]?.totalSize || 0) / totalFiles : 0,
    };
  }

  /**
   * Clean up old or orphaned files
   */
  public async cleanupOrphanedFiles(questionIds: string[]): Promise<number> {
    if (!this.bucket) {
      throw new Error("GridFS not initialized");
    }

    try {
      // Find files not associated with any existing question
      const orphanedFiles = await this.bucket
        .find({
          "metadata.questionId": {
            $exists: true,
            $nin: questionIds,
          },
        })
        .toArray();

      let deletedCount = 0;
      for (const file of orphanedFiles) {
        await this.bucket.delete(file._id);
        deletedCount++;
      }

      return deletedCount;
    } catch (error) {
      console.error("Cleanup error:", error);
      return 0;
    }
  }

  /**
   * Close database connection
   */
  public async close() {
    if (this.client) {
      await this.client.close();
      this.db = null;
      this.bucket = null;
      console.log("GridFS connection closed");
    }
  }
}

export default FileService.getInstance();
