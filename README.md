# StreamScope

Lokalne narzędzie webowe do analizy jakości game streamingu:
**Vibepollo/Sunshine (host) → StreamLight/Moonlight (klient)**.

Wrzucasz plik sesji hosta i log klienta. StreamScope sam je paruje po czasie, znajduje markery pada, liczy benchmark dla wybranego fragmentu rozgrywki, pokazuje diagnostykę całej sesji i przygotowuje krótki raport dla AI.

Pliki są przetwarzane **lokalnie w przeglądarce** i nigdzie nie są wysyłane. Repozytorium zawiera tylko kod aplikacji.

## Obsługiwane pliki

| Źródło | Plik | Co z niego bierzemy |
|---|---|---|
| Vibepollo / Sunshine (host) | `sunshine-session-<App>-<czas UTC>.json` | próbki co ~2 s: FPS, bitrate, enkodowanie, CPU/GPU/enkoder, straty, IDR/RFI; połączenia (`session_uuid`) |
| StreamLight / Moonlight (klient) | `StreamLight-<unix>.log`, `Moonlight-<unix>.log` | konfiguracja streamu, VRR/V-sync, markery pada, zdarzenia RFI/IDR, statystyki końcowe („Global video stats”) |
| Steam Remote Play / PyroWave (host) | `C:\Program Files (x86)\Steam\logs\streaming_log.txt` (+ `.previous.txt`) | bloki `SessionStats` per odcinek (pulpit ↔ gra): enkoder, AvgFPS, ping, capture/convert/encode/network/decode/display, bitrate, łącze, % „Slow…”; zdarzenia „Slow framerate” |

Steam nie zapisuje próbek w czasie, tylko podsumowania odcinków, więc dla Steama benchmark to średnia ważona długością zaznaczonych odcinków (domyślnie: przechwytywanie gry ≥ 20 s). Log Steama z klienta nie zawiera statystyk.

CapFrameX i PresentMon są rozpoznawane, ale jeszcze nieobsługiwane.

## Jak używać

1. Otwórz stronę i przeciągnij pliki (można wiele naraz).
2. Wybierz sesję z listy.
3. Ustaw zakres rozgrywki: przyciskami przy markerach pada, wpisując czas (np. `28:17`–`1:00:04`, przycięcie końca o N minut) albo przeciągając po wykresie.
4. **Zapisz do historii**, **Kopiuj raport dla AI** albo porównaj zapisane sesje w zakładce *Historia i porównanie*.

Markery: wyłącz i włącz pad podłączony do klienta na początku i na końcu fragmentu, który chcesz zmierzyć. W logu pojawi się `Gamepad N is gone` i ponowne wykrycie pada. Parser nie zależy od modelu pada. Obsługuje też przyszłe wpisy `USER_MARKER: <nazwa>`.

## StreamScope Agent (automatyczne zbieranie logów, wspólne dane dla PC i telefonu)

`agent/streamscope_agent.py` działa na gamingowym PC (Python, tylko biblioteka standardowa) i:

- zbiera logi do jednego archiwum (domyślnie `%LOCALAPPDATA%\StreamScope\archive`) przy starcie i po kliknięciu „Pobierz nowe dane”; logi K12 kopiuje od razu po zmianie w udostępnionym folderze (powiadomienia Windows, bez cyklicznego sprawdzania). `check_every_minutes` > 0 włącza dodatkowe sprawdzanie co N minut:
  - sesje Vibepollo z API panelu (`/api/history/sessions`), łącząc reconnecty tak samo jak eksport w panelu; `import_dirs` służy tylko do jednorazowego przejęcia starych, ręcznie pobranych eksportów,
  - `streaming_log*.txt` Steama,
  - logi `StreamLight-*.log` / `Moonlight-*.log` z udostępnionego folderu klienta (np. `\\K12\StreamLightLogs`);
  - historię StreamTweak (`%LOCALAPPDATA%\StreamTweak\sessions.json`): telemetria StreamLight (RTT, jitter, dropy, opóźnienie hosta mierzone przez klienta) i obciążenie hosta w czasie; sesje bez pliku Vibepollo też się pojawiają;
  - sesje diagnostyczne VRR z Moonlighta (`client_logs.vrr_dirs`, udostępniony folder `vrr-diagnostics` klienta): `Moonlight.log` oraz podsumowanie sekundowe z `.vrrtrace` (wyświetlane FPS, opóźnienie odbiór→ekran, odrzucone klatki), dzięki czemu statystyki klienta są dostępne dla wybranego zakresu;
- udostępnia StreamScope w sieci domowej pod `http://<IP-PC>:8765/`. Każde urządzenie widzi te same sesje, zakresy i historię. Pliki wrzucone ręcznie też trafiają do archiwum.

Konfiguracja: zakładka **Ustawienia** w StreamScope (tylko na komputerze z agentem): login i hasło do Vibepollo (hasło nigdy nie wraca do przeglądarki), foldery klienta i diagnostyki VRR, Steam, StreamTweak; przyciski „Testuj połączenie”, „Sprawdź foldery”, „Zapisz i zrestartuj agenta”, „Utwórz skrót na pulpicie”. Ustawienia trafiają do `agent/config.json` (w `.gitignore`; wzór: `agent/config.example.json`).

Uruchomienie: `agent\start-agent.cmd`, a autostart po zalogowaniu: `agent\install-autostart.cmd` (zadanie w Harmonogramie zadań, startuje od razu po zalogowaniu; folder Autostart Windows potrafi opóźnić start o kilka minut). Żeby telefon miał dostęp, Zapora Windows musi przepuszczać port 8765 w sieci prywatnej (PowerShell jako administrator):

```powershell
New-NetFirewallRule -DisplayName "StreamScope Agent" -Direction Inbound -Protocol TCP -LocalPort 8765 -Profile Private -Action Allow
```

Strona na GitHub Pages działa dalej bez agenta. Wtedy pliki wgrywasz ręcznie, a dane zostają w przeglądarce.

## Uruchomienie lokalne

Wystarczy otworzyć `index.html` w przeglądarce, bez budowania. Można też uruchomić dowolny serwer statyczny:

```bash
python -m http.server 8765
```

## Wydanie nowej wersji

Przed commitem uruchom `sh scripts/bump-version.sh`. Skrypt dopisuje świeży `?v=` do adresów skryptów i stylów w `index.html`. GitHub Pages każe przeglądarkom trzymać pliki do 10 minut, a bez nowego `?v=` nowa strona mogłaby działać ze starymi skryptami. Wersja jest widoczna w nagłówku strony.

## Struktura

```
index.html              układ strony
css/app.css             style (jasny i ciemny motyw)
js/core.js              statystyki (percentyle z interpolacją liniową), formatowanie czasu
js/parsers/vibepollo.js parser JSON-a sesji hosta
js/parsers/clientlog.js parser logów StreamLight/Moonlight (wiele streamów w jednym logu)
js/parsers/steamlog.js  parser streaming_log.txt Steama (Remote Play / PyroWave)
js/store.js             pamięć wczytanych plików i zakresów (IndexedDB)
js/engine/session.js    parowanie host ↔ klient, synchronizacja zegarów, benchmark zakresu
js/engine/diagnostics.js silnik diagnostyczny (reguły z analizatora sesji)
js/storage.js           historia (localStorage), eksport/import, raport dla AI
js/chart.js             wykresy SVG na wspólnej osi czasu
js/app.js               interfejs
```

## Werdykt i oceny 1–10

Łączy podejście StreamScope i StreamTweak. Testy: straty klatek, sieć (RTT), opóźnienie hosta (w okresach klatki), spóźnione klatki (>2 okresy), płynność u klienta, opóźnienie całkowite. Każdy test korzysta z najlepszego dostępnego źródła i je podaje. Ocena = średnia testów, ale najwyżej 1,5 pkt powyżej najsłabszego; werdykt mówi, co ogranicza. FPS, obraz i zapas hosta są tylko informacyjne (jak w StreamTweak: limit gry i ekrany ładowania fałszują FPS).

Porównanie dwóch sesji: „Porównaj z…” w nagłówku sesji — werdykty, testy i pomiary obok siebie oraz nałożone wykresy od początku zakresu; testy liczone z różnych źródeł są oznaczone.

## Zasady obliczeń

- Czas w nazwach plików Vibepollo to UTC. W interfejsie wszystko jest w czasie lokalnym.
- Synchronizacja: epoka z nazwy logu klienta plus czas linii daje przybliżony czas uniksowy. Resztkowe przesunięcie zegarów (zwykle kilka sekund) mierzymy względem najbliższego `stream_started` w pliku hosta.
- Liczniki Vibepollo są kumulatywne w obrębie `session_uuid`, więc liczymy przyrosty per połączenie. `encode_latency_ms = 0` jest pomijane.
- Statystyki klienta dotyczą całego streamu. Końcowy „Bitrate / Peak (10s)” to stan z ostatnich sekund, a „Smoothness (2m)” to metryka równości klatek przy VRR, nie FPS.
- StreamScope nie wskazuje „zwycięzcy” porównania. Pokazuje tylko dane.
