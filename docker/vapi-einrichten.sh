#!/bin/sh
# Richtet den Vapi-Assistenten für diesen Server ein bzw. aktualisiert ihn (auf dem Server ausführen).
# Beim ersten Aufruf wird der Vapi Private API Key unsichtbar abgefragt und in .env gespeichert (Modus 600).
# Aufruf vom PC:  ssh -t -i ~/.ssh/hetzner_praxis root@<server> /opt/praxis/docker/vapi-einrichten.sh
# Neuen Key setzen: VAPI_API_KEY-Zeile aus .env löschen und erneut aufrufen.
set -eu
cd "$(dirname "$0")"
umask 077

setze() { # setze NAME WERT: Zeile in .env ersetzen oder anhängen
  sed -i "/^$1=/d" .env
  printf '%s=%s\n' "$1" "$2" >> .env
}

key_gueltig() { # fragt Vapi mit dem Key an; Key über stdin an curl, damit er nicht in der Prozessliste steht
  code=$(printf 'Authorization: Bearer %s\n' "$1" | curl -s -o /dev/null -w '%{http_code}' -H @- 'https://api.vapi.ai/assistant?limit=1')
  [ "$code" = 200 ]
}

if ! grep -q '^VAPI_API_KEY=.' .env; then
  # Bei Strg-C während der unsichtbaren Eingabe das Terminal-Echo wiederherstellen.
  if [ -t 0 ]; then trap 'stty echo' EXIT; trap 'stty echo; exit 130' INT TERM; fi
  versuch=1
  while :; do
    printf 'Vapi PRIVATE API Key einfügen (Rechtsklick), dann Enter. Die Eingabe bleibt unsichtbar: '
    if [ -t 0 ]; then stty -echo; fi
    read -r key || key=
    if [ -t 0 ]; then stty echo; fi
    echo
    key=$(printf '%s' "$key" | tr -d ' \t\r\n')
    if [ -z "$key" ]; then
      echo "Nichts angekommen."
    else
      rest=$(printf '%s' "$key" | tail -c 4)
      echo "Angekommen: ${#key} Zeichen, endet auf ...$rest. Prüfe bei Vapi ..."
      if key_gueltig "$key"; then
        setze VAPI_API_KEY "$key"
        echo "Key gültig und in $(pwd)/.env gespeichert."
        break
      fi
      echo "Vapi lehnt den Key ab (HTTP $code). Ist es der PRIVATE Key (nicht Public)?"
    fi
    [ "$versuch" -lt 3 ] || { echo "Abbruch nach 3 Versuchen."; exit 1; }
    versuch=$((versuch + 1))
  done
fi
chmod 600 .env

set -a; . ./.env; set +a
: "${VAPI_WEBHOOK_TOKEN:?VAPI_WEBHOOK_TOKEN fehlt in .env}"

ausgabe=$(docker compose run --rm -T -v "$(cd .. && pwd)/vapi:/app/vapi:ro" \
  -e VAPI_API_KEY -e VAPI_WEBHOOK_TOKEN -e VAPI_CREDENTIAL_ID -e VAPI_ASSISTANT_ID -e VAPI_NUMMER_ID \
  -e PRAXIS_TELEFON -e ELEVENLABS_VOICE_ID -e ELEVENLABS_MODELL -e VAPI_MODELL -e VAPI_MODELL_ANBIETER \
  -e N8N_WEBHOOK_URL="https://$N8N_DOMAIN/webhook/vapi-praxis" \
  dashboard node vapi/einrichten.js 2>&1) && ok=1 || ok=0
echo "$ausgabe"

# IDs (keine Geheimnisse) merken, damit spätere Aufrufe nur aktualisieren statt neu anzulegen.
id=$(echo "$ausgabe" | sed -n 's/^Credential angelegt: \(.*\)$/\1/p')
[ -n "$id" ] && setze VAPI_CREDENTIAL_ID "$id"
id=$(echo "$ausgabe" | sed -n 's/.*Assistent "[^"]*" (\([^)]*\)).*/\1/p')
[ -n "$id" ] && setze VAPI_ASSISTANT_ID "$id"
[ "$ok" = 1 ]
