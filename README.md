# EcoFlow STREAM Ultra X Dashboard

Dashboard dla systemu magazynowania energii EcoFlow STREAM Ultra X (2× 3.84 kWh = 7.68 kWh).

## Funkcje

- Live monitoring: PV, bateria (2 banki), sieć, zużycie
- Smart meter (3 fazy L1/L2/L3) z importem/eksportem kWh
- Prognoza produkcji PV (Solcast API)
- Energia dziś: produkcja, zużycie, niezależność, CO₂, zarobki
- Historia WebSocket (wykresy)
- Protobuf dekodowanie przez prywatne MQTT EcoFlow

## Wymagania

- Konto developerskie EcoFlow: https://developer-eu.ecoflow.com
- Docker + Portainer na Raspberry Pi

## Zmienne środowiskowe

| Zmienna | Opis |
|---------|------|
| `DEVICE_SN` | SN głównego urządzenia |
| `DEVICE_SN2` | SN drugiego banku |
| `METER_SN` | SN smart metera |
| `EF_ACCESS_KEY` | Access Key z developer.ecoflow.com |
| `EF_SECRET_KEY` | Secret Key z developer.ecoflow.com |
| `EF_EMAIL` | Email konta EcoFlow |
| `EF_PASSWORD` | Hasło konta EcoFlow |
| `EF_SPACE_ID` | Space ID z aplikacji |
| `EF_USER_ID` | User ID z konta EcoFlow |
| `SOLCAST_API_KEY` | Klucz API Solcast (opcjonalny) |
| `SOLCAST_RESOURCE_ID` | Resource ID instalacji Solcast |
| `PSTRYK_API_KEY` | Klucz API Pstryk (opcjonalny) |
| `CLOUDFLARE_TUNNEL_TOKEN` | Token tunelu Cloudflare |

## Architektura

- Backend: Node.js + Express + WebSocket
- Prywatne MQTT EcoFlow z dekodowaniem protobuf
- Quota API polling co 2 minuty (keepalive)
- Solcast API dla prognozy PV (cache 3h, limit 10 req/dzień)
- Frontend: HTML/CSS/JS (bez frameworków)
