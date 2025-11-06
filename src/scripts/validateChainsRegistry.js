const fs = require('fs');
const path = require('path');

const REGISTRY_DIR = path.join(__dirname, '../../../chains-registry');

/**
 * Validation results tracker
 */
const results = {
  total: 0,
  valid: 0,
  errors: [],
  warnings: []
};

/**
 * Validate a single L1 folder
 */
function validateL1(folderName) {
  const folderPath = path.join(REGISTRY_DIR, folderName);
  const chainJsonPath = path.join(folderPath, 'chain.json');
  const readmePath = path.join(folderPath, 'README.md');

  const errors = [];
  const warnings = [];

  // Check if both files exist
  if (!fs.existsSync(chainJsonPath)) {
    errors.push(`Missing chain.json in ${folderName}/`);
  }

  if (!fs.existsSync(readmePath)) {
    errors.push(`Missing README.md in ${folderName}/`);
  }

  if (errors.length > 0) {
    return { errors, warnings };
  }

  try {
    // Validate JSON
    const jsonContent = fs.readFileSync(chainJsonPath, 'utf8');
    const data = JSON.parse(jsonContent);

    // Validate required fields
    const requiredFields = ['subnetId', 'network', 'categories', 'name', 'description', 'logo', 'website', 'socials', 'chains'];

    for (const field of requiredFields) {
      if (!(field in data)) {
        errors.push(`${folderName}: Missing required field '${field}'`);
      }
    }

    // Validate field types
    if (data.subnetId && typeof data.subnetId !== 'string') {
      errors.push(`${folderName}: subnetId must be a string`);
    }

    if (data.network && !['mainnet', 'fuji'].includes(data.network)) {
      warnings.push(`${folderName}: network should be 'mainnet' or 'fuji', got '${data.network}'`);
    }

    if (data.categories && !Array.isArray(data.categories)) {
      errors.push(`${folderName}: categories must be an array`);
    }

    if (data.socials && !Array.isArray(data.socials)) {
      errors.push(`${folderName}: socials must be an array`);
    } else if (data.socials) {
      // Validate socials structure
      data.socials.forEach((social, idx) => {
        if (!social.name || !social.url) {
          errors.push(`${folderName}: socials[${idx}] missing name or url`);
        }
      });
    }

    if (data.chains && !Array.isArray(data.chains)) {
      errors.push(`${folderName}: chains must be an array`);
    } else if (data.chains) {
      // Validate chains structure
      data.chains.forEach((chain, idx) => {
        const requiredChainFields = ['blockchainId', 'name', 'evmChainId', 'vmName', 'vmId', 'rpcUrls', 'assets'];

        for (const field of requiredChainFields) {
          if (!(field in chain)) {
            errors.push(`${folderName}: chains[${idx}] missing required field '${field}'`);
          }
        }

        if (chain.rpcUrls && !Array.isArray(chain.rpcUrls)) {
          errors.push(`${folderName}: chains[${idx}].rpcUrls must be an array`);
        }

        if (chain.assets && !Array.isArray(chain.assets)) {
          errors.push(`${folderName}: chains[${idx}].assets must be an array`);
        }
      });
    }

    // Check for empty required string fields
    if (!data.name || data.name.trim() === '') {
      errors.push(`${folderName}: name is empty`);
    }

    if (!data.subnetId || data.subnetId.trim() === '') {
      errors.push(`${folderName}: subnetId is empty`);
    }

    // Warnings for empty optional fields
    if (!data.description || data.description.trim() === '') {
      warnings.push(`${folderName}: description is empty`);
    }

    if (!data.logo || data.logo.trim() === '') {
      warnings.push(`${folderName}: logo is empty`);
    }

    if (!data.website || data.website.trim() === '') {
      warnings.push(`${folderName}: website is empty`);
    }

    if (data.socials && data.socials.length === 0) {
      warnings.push(`${folderName}: socials array is empty`);
    }

    if (data.chains && data.chains.length === 0) {
      warnings.push(`${folderName}: chains array is empty`);
    }

    // Validate README exists and is not empty
    const readmeContent = fs.readFileSync(readmePath, 'utf8');
    if (!readmeContent || readmeContent.trim() === '') {
      errors.push(`${folderName}: README.md is empty`);
    }

  } catch (error) {
    if (error instanceof SyntaxError) {
      errors.push(`${folderName}: Invalid JSON - ${error.message}`);
    } else {
      errors.push(`${folderName}: ${error.message}`);
    }
  }

  return { errors, warnings };
}

/**
 * Main validation function
 */
function validateRegistry() {
  console.log('Validating Chains Registry...\n');
  console.log('='.repeat(60));

  // Get all folders (excluding _TEMPLATE and README.md)
  const folders = fs.readdirSync(REGISTRY_DIR)
    .filter(item => {
      const itemPath = path.join(REGISTRY_DIR, item);
      return fs.statSync(itemPath).isDirectory() &&
             !item.startsWith('_') &&
             !item.startsWith('.');
    });

  results.total = folders.length;

  for (const folder of folders) {
    const { errors, warnings } = validateL1(folder);

    if (errors.length > 0) {
      results.errors.push(...errors);
    }

    if (warnings.length > 0) {
      results.warnings.push(...warnings);
    }

    if (errors.length === 0) {
      results.valid++;
    }
  }

  // Print results
  console.log('\n' + '='.repeat(60));
  console.log('VALIDATION RESULTS');
  console.log('='.repeat(60));
  console.log(`Total L1s: ${results.total}`);
  console.log(`Valid: ${results.valid}`);
  console.log(`With Errors: ${results.total - results.valid}`);
  console.log(`Total Errors: ${results.errors.length}`);
  console.log(`Total Warnings: ${results.warnings.length}`);

  if (results.errors.length > 0) {
    console.log('\n' + '='.repeat(60));
    console.log('ERRORS:');
    console.log('='.repeat(60));
    results.errors.forEach(error => console.log(`❌ ${error}`));
  }

  if (results.warnings.length > 0) {
    console.log('\n' + '='.repeat(60));
    console.log('WARNINGS:');
    console.log('='.repeat(60));
    results.warnings.forEach(warning => console.log(`⚠️  ${warning}`));
  }

  console.log('\n' + '='.repeat(60));

  if (results.errors.length === 0 && results.warnings.length === 0) {
    console.log('✅ All validations passed!');
  } else if (results.errors.length === 0) {
    console.log('✅ No errors found (warnings can be ignored)');
  } else {
    console.log('❌ Validation failed with errors');
    process.exit(1);
  }

  console.log('='.repeat(60));
}

// Run validation
validateRegistry();
