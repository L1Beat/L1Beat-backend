# L1Beat Backend Efficiency Report

This report identifies several areas in the codebase where performance could be improved.

## 1. Sequential Chain Processing in Initialization (High Impact)

**Location:** `src/app.js:90-96`

**Issue:** During initialization, chains are processed sequentially using a `for...of` loop with `await` on each operation. This means each chain must complete all three operations (updateChain, updateTpsData, updateCumulativeTxCount) before the next chain begins processing.

```javascript
for (const chain of chains) {
    await chainService.updateChain(chain);
    await tpsService.updateTpsData(chain.chainId);
    await tpsService.updateCumulativeTxCount(chain.chainId);
}
```

**Recommendation:** Use `Promise.all` with batching to process multiple chains concurrently while respecting rate limits. This could significantly reduce initialization time.

---

## 2. Redundant Database Query in getNetworkTps (Medium Impact)

**Location:** `src/services/tpsService.js:280-291`

**Issue:** The `getNetworkTps` method fetches ALL TPS records for debugging purposes, then immediately fetches them again with the actual query logic. This doubles the database load unnecessarily.

```javascript
// First query - fetches all records for debugging
const allTpsRecords = await TPS.find({
    timestamp: { $gte: oneDayAgo }
}).lean();

// Then immediately does another set of queries for each chain
const latestTpsPromises = chains.map(chain => 
    TPS.findOne({ chainId: chain.chainId, ... })
);
```

**Recommendation:** Remove the debugging query or make it conditional on development environment only. The logging information can be derived from the actual query results.

---

## 3. Inefficient Array Concatenation in fetchValidators (Medium Impact)

**Location:** `src/services/chainService.js:169, 248`

**Issue:** The code uses spread operator for array concatenation inside loops, which creates new arrays on each iteration:

```javascript
allValidators = [...allValidators, ...data.validators];
```

**Recommendation:** Use `Array.push()` with spread or `Array.concat()` which is more memory efficient:

```javascript
allValidators.push(...data.validators);
```

---

## 4. Duplicate Mongoose Document Conversion Logic (Low Impact)

**Location:** `src/controllers/teleporterController.js:30-36` and `153-159`

**Issue:** The same logic for converting Mongoose documents to plain objects and removing `_id` fields is duplicated:

```javascript
const plainData = messageCount.map(item => {
    const plainItem = item.toObject ? item.toObject() : item;
    const { _id, ...dataWithoutId } = plainItem;
    return dataWithoutId;
});
```

**Recommendation:** Extract this into a utility function to reduce code duplication and improve maintainability.

---

## 5. Duplicate Headers Object in chainDataService (Low Impact)

**Location:** `src/services/chainDataService.js:22-25` and `45-48`

**Issue:** The headers object is created twice - once with API key logic (lines 22-34) and again without it (lines 45-48). The second headers object doesn't use the API key logic that was carefully implemented above it.

```javascript
// First headers object with API key logic
const headers = { 'Accept': 'application/json', 'User-Agent': 'l1beat-backend' };
if (this.GLACIER_API_KEY) {
    headers['x-glacier-api-key'] = this.GLACIER_API_KEY;
}

// Second headers object ignores the above logic
const response = await axios.get(`${this.GLACIER_API_BASE}/chains`, {
    headers: {
        'Accept': 'application/json',
        'User-Agent': 'l1beat-backend',
        'x-glacier-api-key': this.GLACIER_API_KEY  // Doesn't use the fallback logic
    }
});
```

**Recommendation:** Use the first headers object that was constructed with proper fallback logic.

---

## 6. Inefficient Cache Cleanup Loop (Low Impact)

**Location:** `src/utils/cacheManager.js:94-99`

**Issue:** Uses `Object.keys().forEach()` which creates an intermediate array:

```javascript
Object.keys(this.cache).forEach(key => {
    if (this.cache[key].expiry < now) {
        delete this.cache[key];
    }
});
```

**Recommendation:** Use `for...in` loop directly to avoid creating the intermediate array:

```javascript
for (const key in this.cache) {
    if (this.cache[key].expiry < now) {
        delete this.cache[key];
    }
}
```

---

## Summary

| Issue | Impact | Complexity to Fix |
|-------|--------|-------------------|
| Sequential chain processing | High | Medium |
| Redundant database query | Medium | Low |
| Inefficient array concatenation | Medium | Low |
| Duplicate document conversion | Low | Low |
| Duplicate headers object | Low | Low |
| Inefficient cache cleanup | Low | Low |

## Recommended Priority

1. Fix the redundant database query (Issue #2) - Quick win with noticeable impact
2. Fix array concatenation (Issue #3) - Simple change, improves memory efficiency
3. Fix duplicate headers (Issue #5) - Bug fix that ensures API key fallback works correctly
4. Consider parallelizing chain processing (Issue #1) - Requires careful implementation with rate limiting
