const express = require("express");
const router = express.Router();
const authorController = require("../controllers/authorController");
const { body } = require("express-validator");

// Get all authors
router.get("/", authorController.getAllAuthors);

// Get author by slug
router.get("/:slug", authorController.getAuthorBySlug);

// Get author profiles for given author names (POST for complex data)
router.post(
  "/profiles",
  [
    body("authors")
      .isArray({ min: 1 })
      .withMessage("Authors must be a non-empty array")
      .custom((authors) => {
        const invalidAuthors = authors.filter(author => typeof author !== 'string' || author.trim().length === 0);
        if (invalidAuthors.length > 0) {
          throw new Error("All authors must be non-empty strings");
        }
        return true;
      }),
  ],
  authorController.getAuthorProfiles
);

module.exports = router;