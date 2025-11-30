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
      default: "L1Beat",
    },
    authors: [
      {
        type: String,
        trim: true,
      },
    ],
    authorProfiles: [
      {
        name: { type: String, required: true },
        slug: { type: String, required: true },
        bio: { type: String, default: "" },
        avatar: { type: String, default: "" },
        socialLinks: {
          twitter: { type: String, default: "" },
          linkedin: { type: String, default: "" },
          website: { type: String, default: "" },
          github: { type: String, default: "" },
        },
        role: { type: String, default: "" },
        joinDate: { type: Date, default: null },
        isActive: { type: Boolean, default: true },
      }
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
