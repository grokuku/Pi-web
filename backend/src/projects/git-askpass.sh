#!/bin/bash
# Git ASKPASS helper for Pi-Web
# Reads credentials from per-host temp files written by the Node.js CredentialStore.
# Git calls this with a prompt like:
#   "Username for 'https://github.com': "
#   "Password for 'https://user@github.com': "

PROMPT="$1"

# Try to extract hostname from URL in prompt (after @ sign for password prompts)
HOST=$(echo "$PROMPT" | grep -oP 'https?://[^@]+@\K[^/:]+' 2>/dev/null)
# If no @, the URL has no user yet (username prompt)
if [ -z "$HOST" ]; then
  HOST=$(echo "$PROMPT" | grep -oP 'https?://\K[^/:@]+' 2>/dev/null)
fi

if [ -z "$HOST" ]; then
  exit 1
fi

CRED_FILE="/tmp/pi-web-creds/${HOST}"
if [ ! -f "$CRED_FILE" ]; then
  exit 1
fi

if echo "$PROMPT" | grep -qi 'username'; then
  head -1 "$CRED_FILE"
elif echo "$PROMPT" | grep -qi 'password'; then
  tail -1 "$CRED_FILE"
else
  # Default: return password (most common prompt)
  tail -1 "$CRED_FILE"
fi