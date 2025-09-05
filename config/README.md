# Author Configuration

This directory contains configuration files for the L1Beat blog author system.

## authors.json

Contains all author-related configuration including:

### defaultAuthors
Array of default author profiles that should be seeded into the database. Each author object contains:
- `name`: Display name
- `slug`: URL-friendly identifier 
- `bio`: Author biography
- `role`: Author role/title
- `avatar`: Profile picture URL (optional)
- `socialLinks`: Object with social media URLs
- `substackNames`: Array of names this author might use in Substack RSS (for matching)
- `isActive`: Whether the author is active

### fallbackAuthor
Default author object returned when no author profiles can be found. Contains the same fields as defaultAuthors including optional `avatar` field.

### autoCreateDefaults
Default values used when automatically creating new author profiles from unknown Substack authors. Includes default `bio`, `role`, and `socialLinks` - but no `avatar` (unknown authors will use the default user icon).

## Usage

### Adding a New Author
1. Add the author object to the `defaultAuthors` array in `authors.json`
2. Run the seeding script: `node src/scripts/seedAuthors.js`

Example author object:
```json
{
  "name": "John Smith",
  "slug": "john-smith",
  "bio": "Blockchain researcher with expertise in L1 development.",
  "role": "Research Analyst",
  "avatar": "https://example.com/avatar.png",
  "socialLinks": {
    "twitter": "https://x.com/johnsmith",
    "website": "https://johnsmith.dev",
    "substack": "https://johnsmith.substack.com"
  },
  "substackNames": ["John Smith", "john smith", "John", "john"],
  "isActive": true
}
```

### Editing Author Information
1. Update the author object in `authors.json` (including avatar URL)
2. Run the seeding script to update the database

### Substack Author Matching
The system matches Substack RSS author names to database profiles using the `substackNames` array. Include all possible variations of how the author name might appear in RSS feeds:
- Full name: "John Smith"  
- Lowercase: "john smith"
- First name only: "John", "john"
- Handles: "@johnsmith"

## Files That Use This Config

- `src/scripts/seedAuthors.js` - Database seeding
- `src/services/authorService.js` - Author matching and fallback logic