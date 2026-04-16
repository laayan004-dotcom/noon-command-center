#!/bin/bash
# noon DineOut — Deploy to Render
# Run after any changes: bash deploy.sh
# Render auto-deploys when you push to GitHub.

set -e

echo ""
echo "🚀 noon DineOut — Deploying to Render..."

# Stage key files
git add command_center.html server.js package.json render.yaml intel_supplement.json gchat_update.html noon_dineout_sales_handbook.html noon_dineout_partner_pitch.html 2>/dev/null

# Check if there's anything to commit
if git diff --cached --quiet 2>/dev/null; then
  echo "ℹ️  No changes — nothing to deploy."
  echo ""
  echo "✅ Already live at https://noon-command-center.onrender.com"
  exit 0
fi

TIMESTAMP=$(date '+%d %b %Y %H:%M')
git commit -m "Deploy: $TIMESTAMP"

echo ""
echo "📦 Pushing to GitHub → Render auto-deploys..."
git push origin main

echo ""
echo "✅ Pushed! Render is building now (~60s)."
echo "   Live at: https://noon-command-center.onrender.com"
echo "   Dashboard: https://dashboard.render.com/web/srv-d7g8fl58nd3s73a8dpqg"
echo ""
