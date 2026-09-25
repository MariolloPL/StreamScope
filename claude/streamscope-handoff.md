# StreamScope — handoff do sesji Claude Code

_Stan na 2026-09-25. Repo: `MariolloPL/StreamScope` (publiczne), hosting docelowy: GitHub Pages z gałęzi `main`._

## Pliki startowe (w tym projekcie)

- `claude/streamscope-spec-chatgpt.md` — pełna specyfikacja z ChatGPT (cel, formaty, metryki, UI, roadmapa). Punkt wyjścia funkcjonalny.
- `claude/analizator-sesji.html` — działający analizator diagnostyczny (Claude, 2026-09-25): parser Vibepollo JSON, silnik sygnatur, wykresy SVG, raport do schowka. Zweryfikowany na 8 prawdziwych plikach sesji. Do wchłonięcia jako moduł „Diagnostyka” w StreamScope.

## Decyzja

Jedno narzędzie: StreamScope. Dwa tryby na tych samych danych:
1. **Benchmark** (ze specyfikacji ChatGPT): wybór zakresu gameplayu, avg/P50/P5/P1 FPS, FPS z `frames_sent`, % ≥90/≥100 FPS, bitrate avg/P95, encode avg/P95, historia, porównanie, eksport/import.
2. **Diagnostyka** (z analizatora Claude): automatyczne wykrywanie problemów w całej sesji.

Wszystko deterministycznie w JS, lokalnie w przeglądarce, bez backendu.

## Poprawki i ustalenia względem specyfikacji ChatGPT

1. **Czas w nazwach plików Vibepollo to UTC**, nie czas lokalny (potwierdzone: `sunshine-session-ARC_Raiders-2026-09-10T19-36-28.json` ma `start_time_unix` = 19:36:28 UTC = 21:36:28 w Polsce). Synchronizacja z StreamLight wyłącznie po `timestamp_unix` i epoce z nazwy `StreamLight-<unix>.log`. W UI pokazywać czas lokalny.
2. **Pad do markerów — DO USTALENIA z Mario.** Spec mówi: Steam Controller na K12, GameSir na hoście. Notatki projektu z 2026-09-12: LeadJoy Saber na K12, Steam Controller 2 + GameSir na hoście. Markery „Gamepad N is gone / detected” działają tylko dla pada na K12. Parser markerów powinien być niezależny od modelu pada (dowolne zdarzenie odłączenia/podłączenia).
3. **VRR w StreamLight** — spec podaje „D3D11 VRR backend enabled / VRR pacing: Active”. Wcześniejsze notatki projektu: StreamLight nie miał własnego VRR; log Nonary moonlight-qt z 18.09 pokazał VRR wyłączone przez pulpit K12 ustawiony na 4K@100 Hz. Parser ma raportować stan VRR per sesja wprost z logu, bez założeń.
4. **Brak próbek logu StreamLight** — parser klienta pisać dopiero na prawdziwym pliku (leżą na K12, nie ma ich w Pobranych na hoście).

## Struktura Vibepollo JSON (potwierdzona na realnych plikach)

- Top-level: `app_name, client_name, device_name, codec, width, height, target_fps, requested_bitrate_kbps, encoder_bitrate_kbps, duration_seconds, start_time_unix, end_time_unix, verdict, server_version, host_cpu_model, host_gpu_model, events[], samples[], total_samples, samples_truncated, events_truncated, history_status`.
- `events[]`: `event_type` (`stream_started` / `stream_ended`), `session_uuid`, `timestamp_unix`.
- `samples[]` co ~2 s: `timestamp_unix, session_uuid, actual_fps, actual_bitrate_kbps, encode_latency_ms, frame_interval_jitter_ms, frames_sent, last_frame_index, bytes_sent_total, packets_sent_video, host_cpu_percent, host_gpu_percent, host_gpu_encoder_percent, host_ram_percent, host_vram_percent, host_gpu_temp_c, host_cpu_temp_c, host_net_tx_bps, host_net_rx_bps, idr_requests, ref_invalidations, client_reported_losses, video_dropped, audio_dropped`.
- Liczniki (`idr_requests, ref_invalidations, client_reported_losses, video_dropped, audio_dropped, frames_sent`) są **kumulatywne w obrębie `session_uuid`** i resetują się przy nowym UUID. Liczyć delty per segment.
- Jeden plik = wiele `session_uuid` (reconnecty). `encode_latency_ms = 0` oznacza brak zakodowanej klatki — wykluczać ze statystyk opóźnienia.
- Przy braku zmian na ekranie Vibepollo schodzi do ~16 FPS (keepalive) — to nie awaria.

## Reguły silnika diagnostycznego (zaimplementowane w analizatorze)

- **Okno analizy:** pomiń początek (domyślnie 60 s, max 20% długości) i koniec (20 s, max 10%), 3 próbki po każdym reconnect, próbki z `actual_fps ≤ 5`.
- **Baseline FPS** = mediana `actual_fps` w oknie.
- **Brak klatek do wysłania:** FPS < 0,5×baseline, GPU < 30%, CPU < 60%, enkoder < max(20%, 0,6×mediana enkodera). Epizody grupowane (luka ≤ 2 próbki). Epizod w pierwszych min(300 s, 25% sesji) = „początek, możliwe menu”. Krytyczne, gdy poza początkiem ≥ 6 s. Wzrost `idr/ref` w trakcie = rozsynchronizowanie.
- **Przeciążenie GPU/enkodera:** FPS < 0,6×baseline i (GPU ≥ 88% lub encode ≥ 20 ms). Krytyczne ≥ 6 s.
- **Spadek przy obciążonym GPU** (GPU ≥ 30%, bez przeciążenia enkodera): informacyjnie — zwykle ekran ładowania.
- **Utrata pakietów** (`client_reported_losses` lub `video_dropped` > 0): krytyczne.
- **Przerwy między segmentami:** ≤ 3,5 s = zmiana ustawień; dłuższe = nieregularne (ostrzeżenie). Przerwy między plikami < 30 min pokazywać; > 30 s oznaczać „sprawdź zawieszenie”.
- CPU ≥ 95% w > 5% próbek → ostrzeżenie; encode p99 > 20 ms → ostrzeżenie.
- `verdict` z Vibepollo tylko informacyjnie (myli się w obie strony). Jitter wiarygodny dopiero przy oknie ≥ 180 s. `host_cpu_temp_c` (stałe 16,9 °C) ignorować.

## Wyniki walidacji (8 plików z `Pobrane\05 Gry i diagnostyka\Raporty`)

| Plik | Wynik analizatora | Zgodne z wcześniejszą ręczną analizą |
|---|---|---|
| ARC 2026-09-10 19:36 UTC | Problem: brak klatek 14 s + idr/ref | tak |
| Desktop 2026-09-05 17:45 UTC | Problem: brak klatek ~41 min, przerwa 67,6 s | tak |
| Dave the Diver 2026-09-02 (4K) | Uwagi: przeciążenie GPU/enkodera | tak |
| Steam BP 2026-09-13 11:05 UTC (Nonary) | Czysta | tak |
| Steam BP 2026-09-24 20:06 UTC | Uwagi: brak klatek tylko na początku (menu) | nowy plik |

## Następne kroki

1. Ustalić z Mario pad na K12 (markery).
2. Zdobyć 1–2 logi StreamLight z tej samej sesji co JSON — napisać parser klienta i synchronizację.
3. Zbudować StreamScope jako `index.html` w repo (single file OK dla MVP), zachowując silnik diagnostyczny z analizatora.
4. Włączyć GitHub Pages (main, root).
