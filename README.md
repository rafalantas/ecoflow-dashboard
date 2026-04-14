# EcoFlow STREAM Easy Dashboard

Web dashboard dla mikroinwertera EcoFlow STREAM Easy 1020W (BK01Z).

## Wymagania

- Konto developerskie EcoFlow: https://developer-eu.ecoflow.com
- Access Key i Secret Key z panelu developera
- Docker + Portainer na Raspberry Pi

## Uruchomienie przez Portainer (GitOps)

1. **Stacks → Add stack → Repository**
2. URL: `https://github.com/TWOJ_LOGIN/ecoflow-stream-dashboard`
3. Compose path: `docker-compose.yml`
4. Dodaj zmienne środowiskowe:
   - `DEVICE_SN` = numer seryjny urządzenia (np. `BK01Z1SACxxxxxxxxxxx`)
   - `EF_ACCESS_KEY` = Access Key z developer.ecoflow.com
   - `EF_SECRET_KEY` = Secret Key z developer.ecoflow.com
5. **Deploy the stack**

## Dane wyświetlane

- Moc PV1 i PV2 (W)
- Łączna moc PV (W)
- Feed-in do sieci (W)
- Napięcie AC (V)
- Napięcia PV1/PV2 (V)
- Temperatury MPPT (°C)
- Wykres historyczny

## Architektura

- Backend: Node.js + Express + WebSocket + MQTT
- Oficjalne EcoFlow Open API (HMAC-SHA256)
- MQTT Open API: `/open/{account}/{SN}/quota`
- Frontend: czysty HTML/CSS/JS
