#!/usr/bin/env bash
#
# Invite production Entra users into the tenant that owns the app registration.
#
# The app registration lives in a non-production tenant, and that tenant's
# application management policy forbids a multi-tenant audience, so a production
# account cannot authenticate against it directly:
#
#   "Selected user account does not exist in tenant 'Microsoft Non-Production'
#    and cannot access the application ... The account needs to be added as an
#    external user in the tenant first."
#
# B2B guest invitation is therefore the supported way to admit them. An invited
# account keeps its own credentials and MFA in the production tenant; this only
# creates the external record the resource tenant needs to issue a token.
#
# The web app authorises independently of this script: a guest still has to
# present a work address in AUTH_ALLOWED_EMAIL_DOMAINS and originate from a
# tenant in AUTH_ALLOWED_HOME_TENANT_IDS, so inviting an account is necessary
# but not sufficient.
#
# Usage:
#   scripts/invite-production-users.sh alice@microsoft.com bob@microsoft.com
#   scripts/invite-production-users.sh --file users.txt
#   scripts/invite-production-users.sh --no-email alice@microsoft.com
#   scripts/invite-production-users.sh --dry-run --file users.txt
#
set -euo pipefail

REDIRECT_URL="${DIGIBUDDY_INVITE_REDIRECT:-https://digibuddy-webui.gentlemeadow-add1d43f.eastus2.azurecontainerapps.io/}"
SEND_EMAIL=true
DRY_RUN=false
RECIPIENTS=()

command -v az >/dev/null 2>&1 || {
  echo "azure-cli is required" >&2
  exit 1
}
command -v python3 >/dev/null 2>&1 || {
  echo "python3 is required" >&2
  exit 1
}

usage() {
  sed -n '2,28p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --file)
      [[ $# -ge 2 ]] || { echo "--file needs a path" >&2; exit 2; }
      # Blank lines and comments let a list double as documentation.
      while IFS= read -r line; do
        line="${line%%#*}"
        line="$(printf '%s' "$line" | tr -d '[:space:]')"
        [[ -n "$line" ]] && RECIPIENTS+=("$line")
      done <"$2"
      shift 2
      ;;
    --no-email)
      SEND_EMAIL=false
      shift
      ;;
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    -h|--help)
      usage 0
      ;;
    -*)
      echo "unknown option: $1" >&2
      usage 2
      ;;
    *)
      RECIPIENTS+=("$1")
      shift
      ;;
  esac
done

if [[ ${#RECIPIENTS[@]} -eq 0 ]]; then
  echo "no recipients given" >&2
  usage 2
fi

TENANT="$(az account show --query tenantId -o tsv | tr -d "\r")"
echo "resource tenant: $TENANT"
echo "redirect after redemption: $REDIRECT_URL"
$SEND_EMAIL || echo "invitation email: suppressed (--no-email)"
echo

invited=0
existing=0
failed=0

for address in "${RECIPIENTS[@]}"; do
  if [[ "$address" != *@*.* ]]; then
    echo "  $address: skipped, not an email address" >&2
    failed=$((failed + 1))
    continue
  fi

  # Already present covers both a member and a previously redeemed guest, so a
  # rerun neither duplicates an account nor resets anyone's state. The response
  # is parsed as JSON rather than read from `-o tsv`, whose line endings differ
  # between the Linux and Windows builds of the CLI.
  filter="mail eq '$address' or userPrincipalName eq '$address' or otherMails/any(m:m eq '$address')"
  lookup="$(az rest --method GET \
    --url "https://graph.microsoft.com/v1.0/users?\$filter=$(python3 -c 'import sys,urllib.parse; print(urllib.parse.quote(sys.argv[1]))' "$filter")&\$select=id,userType" \
    -o json 2>/dev/null || echo '{}')"
  found="$(printf '%s' "$lookup" | python3 -c '
import json, sys
try:
    print(len(json.load(sys.stdin).get("value", [])))
except Exception:
    # An unreadable lookup must not be read as "already present", which would
    # silently skip somebody who still needs the invitation.
    print(0)
')"

  if [[ "$found" != "0" ]]; then
    echo "  $address: already in the tenant"
    existing=$((existing + 1))
    continue
  fi

  if $DRY_RUN; then
    echo "  $address: would invite"
    invited=$((invited + 1))
    continue
  fi

  body="$(python3 -c '
import json, sys
print(json.dumps({
    "invitedUserEmailAddress": sys.argv[1],
    "inviteRedirectUrl": sys.argv[2],
    "sendInvitationMessage": sys.argv[3] == "true",
}))' "$address" "$REDIRECT_URL" "$SEND_EMAIL")"

  if response="$(az rest --method POST \
    --url "https://graph.microsoft.com/v1.0/invitations" \
    --headers 'Content-Type=application/json' \
    --body "$body" -o json 2>&1)"; then
    state="$(printf '%s' "$response" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("status","unknown"))')"
    echo "  $address: invited ($state)"
    invited=$((invited + 1))
  else
    echo "  $address: failed" >&2
    printf '%s\n' "$response" | sed 's/^/    /' >&2
    failed=$((failed + 1))
  fi
done

echo
echo "invited=$invited already-present=$existing failed=$failed"
[[ $failed -eq 0 ]]
