#!/usr/bin/env fish

# Manual API Testing Script for L1-Registry Integration

echo "=== L1-Registry API Integration Tests ==="
echo ""

# Test 1: Categories endpoint
echo "1. Testing GET /api/chains/categories"
set categories (curl -s http://localhost:5001/api/chains/categories)
echo "   Categories found:" (echo $categories | python3 -c "import json,sys; print(len(json.load(sys.stdin)))")
echo "   Sample:" (echo $categories | python3 -c "import json,sys; print(json.load(sys.stdin)[:5])")
echo ""

# Test 2: Category filter
echo "2. Testing GET /api/chains?category=FINANCE"
set finance_chains (curl -s "http://localhost:5001/api/chains?category=FINANCE")
echo "   FINANCE chains:" (echo $finance_chains | python3 -c "import json,sys; print(len(json.load(sys.stdin)))")
echo ""

# Test 3: Network filter - mainnet
echo "3. Testing GET /api/chains?network=mainnet"
set mainnet_chains (curl -s "http://localhost:5001/api/chains?network=mainnet")
echo "   Mainnet chains:" (echo $mainnet_chains | python3 -c "import json,sys; print(len(json.load(sys.stdin)))")
echo ""

# Test 4: Network filter - fuji
echo "4. Testing GET /api/chains?network=fuji"
set fuji_chains (curl -s "http://localhost:5001/api/chains?network=fuji")
echo "   Fuji chains:" (echo $fuji_chains | python3 -c "import json,sys; print(len(json.load(sys.stdin)))")
echo ""

# Test 5: Combined filters
echo "5. Testing GET /api/chains?category=GAMING&network=mainnet"
set gaming_mainnet (curl -s "http://localhost:5001/api/chains?category=GAMING&network=mainnet")
echo "   GAMING+mainnet chains:" (echo $gaming_mainnet | python3 -c "import json,sys; print(len(json.load(sys.stdin)))")
echo ""

# Test 6: Registry metadata in response
echo "6. Testing registry metadata in chain response"
curl -s "http://localhost:5001/api/chains?category=FINANCE" | python3 -c "
import json, sys
chains = json.load(sys.stdin)
if chains:
    chain = chains[0]
    print(f'   Chain: {chain.get(\"chainName\")}')
    print(f'   Categories: {chain.get(\"categories\")}')
    print(f'   Website: {chain.get(\"website\")}')
    print(f'   Network: {chain.get(\"network\")}')
    print(f'   Socials: {len(chain.get(\"socials\", []))} links')
    print(f'   RPC URLs: {len(chain.get(\"rpcUrls\", []))} endpoints')
"
echo ""

# Test 7: All chains (no filter)
echo "7. Testing GET /api/chains (no filter)"
set all_chains (curl -s "http://localhost:5001/api/chains")
echo "   Total chains:" (echo $all_chains | python3 -c "import json,sys; data=json.load(sys.stdin); print(len(data))")
echo "   With registry data:" (echo $all_chains | python3 -c "import json,sys; data=json.load(sys.stdin); print(sum(1 for c in data if c.get('categories')))")
echo "   Without registry:" (echo $all_chains | python3 -c "import json,sys; data=json.load(sys.stdin); print(sum(1 for c in data if not c.get('categories')))")
echo ""

echo "=== All Tests Complete ==="
