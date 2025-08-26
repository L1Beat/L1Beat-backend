const mongoose = require("mongoose");

const blogPostSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: true,
      trim: true,
    },
    slug: {
      type: String,
      required: true,
      unique: true,
      trim: true,
    },
    subtitle: {
      // NEW FIELD
      type: String,
      trim: true,
      default: "",
    },
    excerpt: {
      type: String,
      required: true,
      trim: true,
    },
    content: {
      type: String,
      required: true,
    },
    mainContent: {
      type: String,
      trim: true,
      default: "",
    },
    author: {
      type: String,
      default: "L1Beat Team",
    },
    authors: [
      {
        type: String,
        trim: true,
      },
    ],
    publishedAt: {
      type: Date,
      required: true,
    },
    updatedAt: {
      type: Date,
      default: Date.now,
    },
    tags: [
      {
        type: String,
        trim: true,
      },
    ],
    views: {
      type: Number,
      default: 0,
    },
    imageUrl: {
      type: String,
      trim: true,
    },
    readTime: {
      type: Number, // in minutes
      default: 5,
    },
    sourceUrl: {
      type: String,
      trim: true,
    },
    syncStatus: {
      type: String,
      enum: ["pending", "synced", "error"],
      default: "pending",
    },
    substackId: {
      type: String,
      unique: true,
      sparse: true,
    },
  },
  {
    timestamps: true,
  }
);

// Indexes for better query performance
blogPostSchema.index({ publishedAt: -1 });
blogPostSchema.index({ slug: 1 });
blogPostSchema.index({ tags: 1 });
blogPostSchema.index({ syncStatus: 1 });

module.exports = mongoose.model("BlogPost", blogPostSchema);
