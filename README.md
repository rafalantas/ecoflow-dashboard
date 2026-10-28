# EcoFlow STREAM Dashboard

Polski dashboard do podglądu produkcji i przepływu energii z urządzeń EcoFlow. Dane na żywo trafiają przez MQTT do backendu Node.js, a następnie przez WebSocket do przeglądarki.

## Wymagania

- Docker i Docker Compose (lub Portainer)
- Konto EcoFlow Developer oraz klucze API: Access Key i Secret Key
- Numer seryjny urządzenia w `DEVICE_SN`

## Uruchomienie

1. Skopiuj `.env.example` do `.env` i uzupełnij `DEVICE_SN`, `EF_ACCESS_KEY` oraz `EF_SECRET_KEY`.
2. Uruchom `docker compose up -d`.
3. Otwórz `http://adres-serwera:8080`.

Logowanie jest opcjonalne. Aby je włączyć, ustaw `DASHBOARD_PASSWORD` oraz, opcjonalnie, `DASHBOARD_USER` (domyślnie `admin`).

W Portainerze użyj repozytorium `https://github.com/rafalantas/ecoflow-dashboard`, pliku `docker-compose.yml` i ustaw zmienne z `.env` w konfiguracji stosu. Nie dodawaj pliku `.env` do repozytorium.

### Opcjonalne integracje

- `DEVICE_SN2` — drugi bank/urządzenie.
- `EF_EMAIL` i `EF_PASSWORD` — prywatne API EcoFlow do danych historycznych, harmonogramu i pogody.
- `EF_SPACE_ID` — identyfikator przestrzeni EcoFlow, jeśli konto używa innego niż domyślny.
- `METER_SN` — numer seryjny licznika EcoFlow.
- `PSTRYK_API_KEY` — ceny energii z Pstryk.
- `CLOUDFLARE_TUNNEL_TOKEN` — token tunelu Cloudflare. Aby uruchomić tunel, ustaw token i uruchom `docker compose --profile tunnel up -d`. Możesz dodatkowo ograniczyć dostęp regułami Cloudflare Access.

## Dane i interfejs

Dashboard pokazuje przepływ energii, wejścia PV, stan baterii, dane licznika, historię produkcji, a po skonfigurowaniu odpowiednich integracji także ceny i statystyki EcoFlow.

W prawym górnym rogu interfejsu widoczny jest skrócony identyfikator commita obrazu. Pełny identyfikator można odczytać po najechaniu na ten skrót. Obraz publikowany przez GitHub Actions otrzymuje SHA commita z procesu budowania.

## Bezpieczeństwo

- Jeśli `DASHBOARD_PASSWORD` jest ustawione, dashboard i WebSocket wymagają HTTP Basic Auth.
- Klucze EcoFlow i Pstryk są używane wyłącznie przez backend; nie są wysyłane do przeglądarki.
- MQTT używa standardowej weryfikacji certyfikatu TLS.
- Dostęp przez Cloudflare Tunnel powinien być dodatkowo ograniczony regułami Cloudflare Access.
