set -e
# Pas aan als je een andere naam of visibility wilt
REPO_NAME="amsterdamnow-artikel-tool"
PRIVATE=true   # of false voor public

# controleer token is gezet
if [ -z "$GHTOKEN" ]; then
  echo "Stel eerst GHTOKEN in, bijv: export GHTOKEN=ghp_xxx"; exit 1
fi

# haal authenticated username
USERNAME=$(curl -s -H "Authorization: token $GHTOKEN" https://api.github.com/user | python -c 'import sys,json;print(json.load(sys.stdin).get("login",""))')
if [ -z "$USERNAME" ]; then
  echo "Authenticatie met GitHub mislukt. Controleer token." ; exit 1
fi
echo "Authenticated als: $USERNAME"

# maak repo aan
CREATE_RESP=$(curl -s -H "Authorization: token $GHTOKEN" -H "Content-Type: application/json" -d "{\"name\":\"$REPO_NAME\",\"private\":$PRIVATE}" https://api.github.com/user/repos)
CLONE_URL=$(printf "%s" "$CREATE_RESP" | python -c 'import sys,json;print(json.load(sys.stdin).get("clone_url",""))')
if [ -z "$CLONE_URL" ]; then
  echo "Repo creatie mislukt, respons:"; printf "%s\n" "$CREATE_RESP"; exit 1
fi
echo "Repo aangemaakt: $CLONE_URL"

# init / commit / push
git init || true
git config user.name "Your Name"
git config user.email "you@example.com"
git add -A
if git diff --cached --quiet; then
  echo "Geen wijzigingen om te committen"
else
  git commit -m "Initial commit" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
fi
git branch -M main || true

# zet remote en push
if git remote get-url origin >/dev/null 2>&1; then
  git remote set-url origin "$CLONE_URL"
else
  git remote add origin "$CLONE_URL"
fi

git push -u origin main
echo "Klaar: https://github.com/$USERNAME/$REPO_NAME"