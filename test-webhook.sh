#!/bin/bash

# Test script for webhook-driven deploy runner
# Sends a properly signed test push webhook to verify the system works

set -e

# Configuration
WEBHOOK_SECRET="${1:-}"
WEBHOOK_URL="${2:-http://localhost:9000/webhook}"

if [ -z "$WEBHOOK_SECRET" ]; then
  echo "Usage: ./test-webhook.sh <webhook-secret> [webhook-url]"
  echo ""
  echo "Example:"
  echo "  ./test-webhook.sh 'your-webhook-secret-here'"
  echo "  ./test-webhook.sh 'your-webhook-secret-here' 'http://192.168.1.100:9000/webhook'"
  echo ""
  echo "To get your webhook secret, check your .env file:"
  echo "  grep WEBHOOK_SECRET .env"
  exit 1
fi

# Create a GitHub-style push payload
PAYLOAD=$(cat <<'EOF'
{
  "ref": "refs/heads/main",
  "before": "0000000000000000000000000000000000000000",
  "after": "abcdef0123456789abcdef0123456789abcdef01",
  "repository": {
    "id": 123456789,
    "name": "test-repo",
    "full_name": "testuser/test-repo",
    "private": false,
    "owner": {
      "name": "testuser",
      "email": "test@example.com",
      "login": "testuser"
    },
    "html_url": "https://github.com/testuser/test-repo",
    "description": "Test repository",
    "url": "https://api.github.com/repos/testuser/test-repo",
    "forks": 0,
    "open_issues": 0,
    "default_branch": "main"
  },
  "pusher": {
    "name": "testuser",
    "email": "test@example.com"
  },
  "sender": {
    "login": "testuser",
    "id": 123456789,
    "avatar_url": "https://avatars.githubusercontent.com/u/123456789",
    "type": "User"
  },
  "created": false,
  "deleted": false,
  "forced": false,
  "compare": "https://github.com/testuser/test-repo/compare/main...main",
  "commits": [
    {
      "id": "abcdef0123456789abcdef0123456789abcdef01",
      "tree_id": "abcdef0123456789abcdef0123456789abcdef01",
      "distinct": true,
      "message": "Test commit for webhook deployment",
      "timestamp": "2025-10-16T12:00:00Z",
      "url": "https://github.com/testuser/test-repo/commit/abcdef0123456789abcdef0123456789abcdef01",
      "author": {
        "name": "Test User",
        "email": "test@example.com",
        "username": "testuser"
      },
      "committer": {
        "name": "Test User",
        "email": "test@example.com",
        "username": "testuser"
      },
      "added": ["README.md"],
      "removed": [],
      "modified": []
    }
  ],
  "head_commit": {
    "id": "abcdef0123456789abcdef0123456789abcdef01",
    "tree_id": "abcdef0123456789abcdef0123456789abcdef01",
    "distinct": true,
    "message": "Test commit for webhook deployment",
    "timestamp": "2025-10-16T12:00:00Z",
    "url": "https://github.com/testuser/test-repo/commit/abcdef0123456789abcdef0123456789abcdef01",
    "author": {
      "name": "Test User",
      "email": "test@example.com",
      "username": "testuser"
    },
    "committer": {
      "name": "Test User",
      "email": "test@example.com",
      "username": "testuser"
    },
    "added": ["README.md"],
    "removed": [],
    "modified": []
  }
}
EOF
)

# Compute HMAC-SHA256 signature the same way GitHub does
SIGNATURE="sha256=$(echo -n "$PAYLOAD" | openssl dgst -sha256 -hmac "$WEBHOOK_SECRET" | awk '{print $2}')"

echo "=== Webhook Test ==="
echo ""
echo "Webhook URL:    $WEBHOOK_URL"
echo "Signature:      $SIGNATURE"
echo "Payload size:   $(echo -n "$PAYLOAD" | wc -c) bytes"
echo ""
echo "Sending webhook..."
echo ""

# Send the webhook
RESPONSE=$(curl -s -w "\n%{http_code}" -X POST \
  -H "Content-Type: application/json" \
  -H "X-Hub-Signature-256: $SIGNATURE" \
  -H "X-GitHub-Event: push" \
  -d "$PAYLOAD" \
  "$WEBHOOK_URL")

# Parse response
HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
HTTP_BODY=$(echo "$RESPONSE" | head -n -1)

echo "Response Code:  $HTTP_CODE"
echo "Response Body:  $HTTP_BODY"
echo ""

# Check result
if [ "$HTTP_CODE" = "202" ]; then
  echo "✓ SUCCESS: Webhook accepted (202 Accepted)"
  echo ""
  echo "The deploy should now be running. Check the logs with:"
  echo "  docker-compose logs -f"
  echo ""
  echo "Check health with:"
  echo "  curl http://localhost:9000/health"
  exit 0
elif [ "$HTTP_CODE" = "401" ]; then
  echo "✗ SIGNATURE ERROR: Webhook rejected (401 Unauthorized)"
  echo ""
  echo "This means the signature verification failed. Possible causes:"
  echo "  1. The webhook secret is incorrect"
  echo "  2. The webhook secret in GitHub doesn't match .env"
  echo ""
  echo "Check your secret:"
  echo "  grep WEBHOOK_SECRET .env"
  exit 1
elif [ "$HTTP_CODE" = "200" ]; then
  echo "✓ Webhook received but not processed"
  echo ""
  echo "This usually means the event was ignored (e.g., wrong branch)."
  echo "Check the logs: docker-compose logs -f"
  exit 0
else
  echo "✗ UNEXPECTED RESPONSE: $HTTP_CODE"
  exit 1
fi
